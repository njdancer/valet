// ctx.local.fetch and ctx.local.service (docs/sandbox.md#exceptions-capabilities-enforced-in-main):
// https to declared hosts at public addresses only, redirects returned, no cookies; http to a
// declared loopback port that isn't Valet's own.

import http from 'node:http'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import { generateTestCertificate } from '@valet/fake-woolworths-site'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isPublicAddress, localFetch, localService } from '../src/local/net'

const refusal = (p: Promise<unknown>) =>
  p.then(
    () => 'allowed',
    (e: { stage?: string; errorClass?: string }) => `${e.stage}/${e.errorClass}`,
  )

let tls: https.Server
let tlsPort: number
let ca: string
const seen: http.IncomingHttpHeaders[] = []
let plain: http.Server
let plainPort: number

beforeAll(async () => {
  const cert = await generateTestCertificate(['api.example.test', 'other.example.test'])
  ca = cert.cert
  tls = https.createServer({ key: cert.key, cert: cert.cert }, (req, res) => {
    seen.push(req.headers)
    if (req.url === '/redirect') {
      res.writeHead(302, { location: 'https://evil.test/' })
      res.end()
      return
    }
    if (req.url === '/big') {
      res.end(Buffer.alloc(5 * 1024 * 1024))
      return
    }
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'track=1' })
      res.end(JSON.stringify({ method: req.method, url: req.url, body }))
    })
  })
  await new Promise<void>((r) => tls.listen(0, '127.0.0.1', r))
  tlsPort = (tls.address() as AddressInfo).port
  plain = http.createServer((req, res) => res.end(`local ${req.method} ${req.url} ${req.headers.host}`))
  await new Promise<void>((r) => plain.listen(0, '127.0.0.1', r))
  plainPort = (plain.address() as AddressInfo).port
})
afterAll(() => {
  tls.close()
  plain.close()
})

/** Resolves every name to the test server, as a DNS answer would. */
const toServer = (_name: string, cb: (e: Error | null, a: { address: string; family: number }[]) => void) =>
  cb(null, [{ address: '127.0.0.1', family: 4 }])

const fetcher = (hosts: string[] | 'open', lookup = toServer) =>
  localFetch({ hosts, lookup, httpsPort: tlsPort, ca, testAddress: '127.0.0.1' })

describe('fetch to declared hosts', () => {
  it('makes the request and returns status, headers and body, without the cookie', async () => {
    const f = fetcher(['api.example.test'])
    const response = await f('https://api.example.test/v1/thing?x=1', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'x-api': 'one' },
      body: 'hello',
    })
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toEqual({ method: 'POST', url: '/v1/thing?x=1', body: 'hello' })
    expect(response.headers['set-cookie']).toBeUndefined()
    expect(seen.at(-1)?.['x-api']).toBe('one')
  })

  it('refuses a host it doesn’t name, a wildcard’s apex, and every kind when none is declared', async () => {
    expect(await refusal(fetcher(['api.example.test'])('https://other.example.test/'))).toBe(
      'tool-run/not-granted',
    )
    expect(await refusal(fetcher(['*.example.test'])('https://example.test/'))).toBe('tool-run/not-granted')
    expect(await refusal(fetcher([])('https://api.example.test/'))).toBe('tool-run/not-granted')
  })

  it('refuses anything but https on its default port, IP literals and credentials in the URL', async () => {
    const f = fetcher(['api.example.test'])
    for (const url of [
      'http://api.example.test/',
      'https://api.example.test:8443/',
      'https://user:pass@api.example.test/',
      'file:///etc/passwd',
      'not a url',
    ])
      expect([url, await refusal(f(url))]).toEqual([url, 'tool-run/invalid'])
    const open = fetcher('open')
    for (const url of ['https://127.0.0.1/', 'https://[::1]/', 'https://2130706433/', 'https://0x7f.1/'])
      expect([url, await refusal(open(url))]).toEqual([url, 'tool-run/host-not-allowed'])
  })

  it('refuses a name whose DNS answer is not public, even one of several', async () => {
    const real = localFetch({ hosts: ['api.example.test'], httpsPort: tlsPort, ca })
    const rebinding = localFetch({
      hosts: ['api.example.test'],
      httpsPort: tlsPort,
      ca,
      lookup: (_n, cb) =>
        cb(null, [
          { address: '93.184.216.34', family: 4 },
          { address: '10.0.0.1', family: 4 },
        ]),
    })
    expect(await refusal(rebinding('https://api.example.test/'))).toBe('tool-run/host-not-allowed')
    // No testAddress: the server's own loopback address is refused like any other.
    expect(await refusal(real('https://api.example.test/'))).toMatch(/host-not-allowed|unavailable/)
  })

  it('returns a redirect instead of following it', async () => {
    const response = await fetcher(['api.example.test'])('https://api.example.test/redirect')
    expect(response.status).toBe(302)
    expect(response.headers['location']).toBe('https://evil.test/')
  })

  it('refuses headers that would name a host, a cookie or proxy credentials', async () => {
    const f = fetcher(['api.example.test'])
    for (const name of ['Host', 'Cookie', 'Proxy-Authorization', 'Transfer-Encoding', 'Sec-Fetch-Site'])
      expect([name, await refusal(f('https://api.example.test/', { headers: { [name]: 'x' } }))]).toEqual([
        name,
        'tool-run/invalid',
      ])
    expect(await refusal(f('https://api.example.test/', { headers: { 'x-a': 'one\r\nhost: evil' } }))).toBe(
      'tool-run/invalid',
    )
    expect(await refusal(f('https://api.example.test/', { method: 'GET', body: 'x' }))).toBe(
      'tool-run/invalid',
    )
    expect(await refusal(f('https://api.example.test/', { method: 'CONNECT' as never }))).toBe(
      'tool-run/invalid',
    )
  })

  it('caps the answer’s size', async () => {
    expect(await refusal(fetcher(['api.example.test'])('https://api.example.test/big'))).toBe(
      'tool-run/unexpected-shape',
    )
  })
})

describe('the public address check', () => {
  it('knows the ranges that are home, not the internet', () => {
    for (const a of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      '::',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '64:ff9b::7f00:1',
      'fd00::1',
      'fe80::1',
      'not-an-ip',
    ])
      expect([a, isPublicAddress(a)]).toEqual([a, false])
    for (const a of ['93.184.216.34', '1.1.1.1', '2606:4700:4700::1111'])
      expect([a, isPublicAddress(a)]).toEqual([a, true])
  })
})

describe('a local service', () => {
  it('reaches 127.0.0.1 on the declared port only', async () => {
    const s = localService({ ports: [plainPort] })
    const response = await s(plainPort, '/api/tags')
    expect(response.body).toBe(`local GET /api/tags 127.0.0.1:${plainPort}`)
    expect(await refusal(s(plainPort + 1, '/'))).toBe('tool-run/not-granted')
    expect(await refusal(localService({ ports: [] })(plainPort, '/'))).toBe('tool-run/not-granted')
  })

  it('never reaches one of Valet’s own ports, or a path that isn’t one', async () => {
    const s = localService({ ports: [plainPort], refusedPorts: () => [plainPort] })
    expect(await refusal(s(plainPort, '/'))).toBe('tool-run/host-not-allowed')
    const t = localService({ ports: 'open' })
    for (const path of ['api', '//evil.test/', '/a b', 'http://x/'])
      expect([path, await refusal(t(plainPort, path))]).toEqual([path, 'tool-run/invalid'])
    expect(await refusal(t(80, '/'))).toBe('tool-run/invalid')
  })
})
