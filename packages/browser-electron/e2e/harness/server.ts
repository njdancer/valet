// A tiny HTTPS site for the e2e suite. One server answers for every *.test host (the harness maps
// them all to 127.0.0.1) and records each request's host and path, each TLS connection's SNI name,
// and each form POST's body, so tests can prove what reached which host. Beside it, a raw TCP
// listener and a UDP socket count anything at all that arrives, for the WebRTC and WebTransport
// tests, which speak neither HTTP nor TLS to us.

import { execFileSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { mkdtempSync, readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:https'
import { type AddressInfo, createServer as createTcpServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TLSSocket } from 'node:tls'

export interface Seen {
  readonly host: string
  readonly method: string
  readonly path: string
  readonly userAgent: string
  readonly acceptLanguage: string
  /** The Sec-CH-UA client hint, or '' when none was sent. */
  readonly clientHintBrands: string
}

export interface TestSite {
  readonly port: number
  readonly certificatePem: string
  readonly fingerprint: string
  readonly requests: Seen[]
  readonly connections: string[]
  readonly posts: { host: string; path: string; body: string }[]
  /** A TCP port that accepts and counts connections, standing in for a TURN server. */
  readonly tcpPort: number
  readonly tcpConnections: () => number
  /** A UDP port that counts datagrams, standing in for STUN, TURN over UDP and QUIC. */
  readonly udpPort: number
  readonly udpDatagrams: () => number
  url(host: string, path?: string): string
  close(): Promise<void>
}

/** A self-signed certificate for the test hosts, made with openssl in a fresh temp directory. */
function makeCertificate(): { key: Buffer; cert: Buffer } {
  const dir = mkdtempSync(join(tmpdir(), 'siteadapter-e2e-cert-'))
  const key = join(dir, 'key.pem')
  const cert = join(dir, 'cert.pem')
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-days',
      '2',
      '-subj',
      '/CN=site.test',
      '-addext',
      'subjectAltName=DNS:site.test,DNS:login.test,DNS:evil.test,DNS:captcha.test,DNS:widget.test',
      '-keyout',
      key,
      '-out',
      cert,
    ],
    { stdio: 'ignore' },
  )
  return { key: readFileSync(key), cert: readFileSync(cert) }
}

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`
}

// Records whether every key event the page saw was trusted, and posts that with the form.
// It also counts keydown events, which char-only typing doesn't produce.
const TRUST_PROBE = `<script>
  window.__untrusted = 0
  window.__keydowns = 0
  for (const type of ['keydown', 'keypress', 'input', 'mousedown', 'click']) {
    document.addEventListener(type, (event) => { if (!event.isTrusted) window.__untrusted++ }, true)
  }
  document.addEventListener('keydown', () => { window.__keydowns++ }, true)
  document.addEventListener('submit', (event) => {
    const field = document.createElement('input')
    field.type = 'hidden'
    field.name = 'untrusted'
    field.value = String(window.__untrusted)
    event.target.appendChild(field)
  }, true)
</script>`

/** A dedicated or service worker that answers any message with what its navigator says. */
const UA_WORKER = `
const read = () => ({
  ua: navigator.userAgent,
  language: navigator.language,
  languages: [...navigator.languages],
  brands: navigator.userAgentData ? navigator.userAgentData.brands.map((b) => b.brand) : null,
})
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))
self.addEventListener('message', (event) => {
  if (event.ports && event.ports[0]) event.ports[0].postMessage(read())
  else self.postMessage(read())
})
self.addEventListener('connect', (event) => {
  const port = event.ports[0]
  port.onmessage = () => port.postMessage(read())
})
`

function routes(
  site: { url(host: string, path?: string): string },
  host: string,
  path: string,
  query: URLSearchParams,
) {
  const login = site.url('login.test')
  const evil = site.url('evil.test')
  if (host === 'site.test' && path === '/') {
    return { body: page('Home', '<h1>Home</h1><p class="greeting">Welcome to the test site</p>') }
  }
  if (host === 'site.test' && path === '/login') {
    return {
      body: page(
        'Log in',
        `${TRUST_PROBE}
        <form id="main-form" method="post" action="/session">
          <input id="user" name="user" type="email" autocomplete="username">
          <input id="hidden" name="hidden" type="text" style="display:none">
          <button id="login-submit" type="submit" style="width:120px;height:40px">Continue</button>
        </form>
        <form id="search" action="https://analytics.test/search"><input id="q" name="q" type="search"></form>
        <a id="escape" href="${evil}/landing" style="display:inline-block;width:100px;height:30px">Escape</a>
        <iframe id="same" src="/same-frame" style="width:300px;height:120px;border:0"></iframe>
        <iframe id="cross" src="${login}/frame" style="width:420px;height:200px;border:4px solid #888;padding:6px"></iframe>`,
      ),
    }
  }
  if (host === 'site.test' && path === '/same-frame') {
    return {
      body: page(
        'Same',
        `${TRUST_PROBE}
        <form method="post" action="/session-code">
          <input id="code" name="code" inputmode="numeric" autocomplete="one-time-code">
          <button id="code-submit" type="submit" style="width:80px;height:30px">Verify</button>
        </form>`,
      ),
    }
  }
  if (host === 'login.test' && path === '/frame') {
    return {
      body: page(
        'Password',
        `${TRUST_PROBE}
        <form method="post" action="/session">
          <input id="password" name="password" type="password" autocomplete="current-password">
          <button id="password-submit" type="submit" style="width:120px;height:40px">Log in</button>
        </form>`,
      ),
    }
  }
  if (path === '/session' || path === '/session-code') return { body: page('Done', '<p>Signed in</p>') }
  if (host === 'site.test' && path === '/pay-form') {
    return {
      body: page(
        'Pay',
        `<form id="pay-form" method="post" action="/payment">
          <input name="amount" value="100">
          <button id="pay" type="submit" style="width:120px;height:40px">Pay</button>
        </form>`,
      ),
    }
  }
  if (host === 'site.test' && path === '/redirect') {
    return { status: 302, headers: { location: query.get('to') ?? '/' }, body: '' }
  }
  if (host === 'site.test' && path === '/set-session') {
    return {
      headers: {
        'set-cookie': [
          'sid=host-only-sid; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=3600',
          'shared=domain-shared; Domain=site.test; Path=/; Secure; SameSite=None',
          'narrow=narrow-path; Path=/account; Secure',
        ],
      },
      body: page('Session', `<script>localStorage.setItem('token', 'storage-token-123')</script><p>ok</p>`),
    }
  }
  if (host === 'site.test' && path === '/hints') {
    return {
      body: page(
        'Hints',
        `<link rel="dns-prefetch" href="${site.url('prefetch.evil.test')}">
         <link rel="preconnect" href="${site.url('preconnect.evil.test')}">
         <a href="${site.url('anchor.evil.test')}/x">a link</a><p>hints</p>`,
      ),
    }
  }
  if (host === 'site.test' && path === '/app') {
    // The site's own script calls an API on load, as Woolworths' pages call /api/ui/v2/bootstrap.
    return {
      body: page(
        'App',
        `<p>app</p><script>
          window.__bootstrap = fetch('/api/bootstrap').then(() => 'sent', () => 'failed')
        </script>`,
      ),
    }
  }
  if (host === 'site.test' && path === '/framed') {
    // A login page that embeds a declared CAPTCHA frame and an undeclared widget.
    return {
      body: page(
        'Framed',
        `<iframe id="captcha" src="${site.url('captcha.test')}/frame"></iframe>
         <iframe id="widget" src="${site.url('widget.test')}/frame"></iframe>`,
      ),
    }
  }
  if ((host === 'captcha.test' || host === 'widget.test') && path === '/frame') {
    return { body: page('Frame', `<p id="inner">${host}</p>`) }
  }
  // What a page's workers and cross-site frames present as (navigator UA, languages, brands).
  if ((host === 'site.test' || host === 'login.test') && (path === '/ua-worker.js' || path === '/ua-sw.js')) {
    return { headers: { 'content-type': 'text/javascript' }, body: UA_WORKER }
  }
  if (host === 'site.test' && path === '/ua-probe') {
    return { body: page('UA', `<iframe id="cross" src="${login}/ua-frame"></iframe>`) }
  }
  if (host === 'login.test' && path === '/ua-frame') return { body: page('UA frame', '<p>frame</p>') }
  if (path === '/robots.txt') return { headers: { 'content-type': 'text/plain' }, body: 'User-agent: *\n' }
  return { status: 404, body: page('Not found', '<p>Not found</p>') }
}

export async function startTestSite(): Promise<TestSite> {
  const { key, cert } = makeCertificate()
  const certificatePem = cert.toString('utf8')
  const requests: Seen[] = []
  const connections: string[] = []
  const posts: { host: string; path: string; body: string }[] = []
  let port = 0
  const site = {
    url: (host: string, path = '') => `https://${host}:${port}${path}`,
  }
  const server: Server = createServer({ key, cert }, (request, response) => {
    const host = (request.headers.host ?? '').replace(/:\d+$/, '')
    const url = new URL(request.url ?? '/', `https://${host}`)
    requests.push({
      host,
      method: request.method ?? 'GET',
      path: url.pathname,
      userAgent: request.headers['user-agent'] ?? '',
      acceptLanguage: request.headers['accept-language'] ?? '',
      clientHintBrands: String(request.headers['sec-ch-ua'] ?? ''),
    })
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      if (request.method === 'POST')
        posts.push({ host, path: url.pathname, body: Buffer.concat(chunks).toString('utf8') })
      // Stands in for the site's own API: a bootstrap call its pages make on load, and an order.
      if (
        url.pathname === '/echo' ||
        url.pathname === '/api/bootstrap' ||
        url.pathname === '/checkout/place'
      ) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ host, cookie: request.headers.cookie ?? '' }))
        return
      }
      // Stands in for a login probe: what arrived, headers and all, and a cookie it sets in return.
      if (url.pathname === '/probe') {
        response.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'set-cookie': 'probed=yes; Path=/; Secure; SameSite=Lax',
        })
        response.end(JSON.stringify({ host, headers: request.headers }))
        return
      }
      // More than the probe reads: 2 MiB of text.
      if (url.pathname === '/big') {
        response.writeHead(200, { 'content-type': 'text/plain' })
        response.end('x'.repeat(2 * 1024 * 1024))
        return
      }
      // Doesn't answer for 15 s, for timeouts.
      if (url.pathname === '/hang') {
        setTimeout(() => response.destroy(), 15_000).unref()
        return
      }
      const route = routes(site, host, url.pathname, url.searchParams)
      response.writeHead(route.status ?? 200, {
        'content-type': 'text/html; charset=utf-8',
        ...route.headers,
      })
      response.end(route.body)
    })
  })
  server.on('secureConnection', (socket: TLSSocket) => {
    const name = (socket as TLSSocket & { servername?: string | false }).servername
    connections.push(typeof name === 'string' ? name : '')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
  let tcpConnections = 0
  const tcp = createTcpServer((socket) => {
    tcpConnections++
    socket.on('error', () => {})
    socket.destroy()
  })
  await new Promise<void>((resolve) => tcp.listen(0, '127.0.0.1', resolve))
  let udpDatagrams = 0
  const udp = createSocket('udp4')
  udp.on('message', () => udpDatagrams++)
  await new Promise<void>((resolve) => udp.bind(0, '127.0.0.1', resolve))
  return {
    port,
    tcpPort: (tcp.address() as AddressInfo).port,
    tcpConnections: () => tcpConnections,
    udpPort: udp.address().port,
    udpDatagrams: () => udpDatagrams,
    certificatePem,
    fingerprint: new X509Certificate(cert).fingerprint256,
    requests,
    connections,
    posts,
    url: site.url,
    close: () =>
      new Promise((resolve) => {
        udp.close()
        tcp.close()
        server.close(() => resolve())
      }),
  }
}
