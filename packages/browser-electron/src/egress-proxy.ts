// A local CONNECT proxy for the tool partition. webRequest only sees what Chromium's URL loader
// sends. WebRTC's TCP sockets (TURN over TCP or TLS) go around it, so tool code could open one to
// an undeclared host and carry the session cookie out in the TURN hostname, its DNS lookup and the
// TURN username. Routing the partition through this proxy, with WebRTC's UDP switched off, puts
// every TCP connection the partition makes in front of the egress list. The proxy decides on the
// hostname the page asked for and only resolves it once allowed, so a refused hostname is never
// even looked up.
//
// Plain Node, no Electron: the e2e suite runs it inside Electron, the unit tests in Node.

import dns from 'node:dns'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { connect, isIP, Socket } from 'node:net'
import { networkInterfaces } from 'node:os'
import type { Duplex } from 'node:stream'
import { effectiveAddress, isPublicAddress } from '@valet/core'
import type { ProxyHandle, ProxyPolicy } from './platform'

/** Opens the upstream connection for an allowed CONNECT. Injected so tests choose where it goes. */
export type Dial = (host: string, port: number) => Socket

export interface EgressProxyOptions {
  readonly allow: ProxyPolicy
  readonly dial?: Dial
}

/**
 * The default dial: a host name must resolve to public addresses only, none of them this Mac's own,
 * and the socket goes to the address that was checked (cross-kind red team I, XK-3; the rule the
 * egress broker and ctx.local.fetch follow). An IP literal is dialled as it is: the policy allowed
 * it by address, which only a private host the person approved can name.
 */
const realDial: Dial = (host, port) => {
  if (isIP(host) !== 0) return connect({ host, port })
  const socket = new Socket()
  dns.lookup(host, { all: true, verbatim: true }, (error, answers) => {
    const own = ownAddresses()
    const first = answers?.[0]
    const reachable =
      error === null &&
      first !== undefined &&
      answers.every(
        (a) => isPublicAddress(a.address) && !own.includes(effectiveAddress(a.address) ?? a.address),
      )
    if (!reachable) {
      socket.destroy(new Error('refused'))
      return
    }
    socket.connect({ host: first.address, port })
  })
  return socket
}

/** This Mac's own addresses, as a socket reaches them. */
function ownAddresses(): string[] {
  const out: string[] = []
  for (const list of Object.values(networkInterfaces())) {
    for (const entry of list ?? []) {
      const address = effectiveAddress(entry.address.replace(/%.*$/, ''))
      if (address !== null) out.push(address)
    }
  }
  return out
}

const REFUSED = 'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'
const BAD_GATEWAY = 'HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'
const ESTABLISHED = 'HTTP/1.1 200 Connection Established\r\n\r\n'

/** Host and port from a CONNECT request's authority, or null for anything that isn't exactly that. */
export function parseAuthority(authority: string | undefined): { host: string; port: number } | null {
  if (authority === undefined || !/^[^\s/?#@\\]+:\d{1,5}$/.test(authority)) return null
  let url: URL
  try {
    url = new URL(`https://${authority}`)
  } catch {
    return null
  }
  const port = url.port === '' ? 443 : Number(url.port)
  if (port < 1 || port > 65_535) return null
  // URL brackets IPv6 hosts; nothing on an egress list is one, so leave them bracketed and refused.
  return { host: url.hostname, port }
}

/** Starts the proxy on a free loopback port. */
export function startEgressProxy(options: EgressProxyOptions): Promise<ProxyHandle> {
  const dial = options.dial ?? realDial
  const open = new Set<Duplex>()
  const track = (socket: Duplex) => {
    open.add(socket)
    socket.once('close', () => open.delete(socket))
  }
  // Only CONNECT is proxied: the tool partition speaks https and wss and nothing else.
  const server = createServer((_request: IncomingMessage, response: ServerResponse) => {
    response.writeHead(403, { connection: 'close' }).end()
  })
  server.on('connection', track)
  server.on('connect', (request: IncomingMessage, client: Duplex, head: Buffer) => {
    client.on('error', () => client.destroy())
    const target = parseAuthority(request.url)
    let allowed = false
    try {
      allowed = target !== null && options.allow(target.host, target.port)
    } catch {
      // A failing policy must not turn a refusal into a connection.
    }
    if (target === null || !allowed) {
      client.end(REFUSED)
      return
    }
    tunnel(client, head, dial, target, track)
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('proxy has no port'))
        return
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise<void>((done) => {
            for (const socket of open) socket.destroy()
            server.close(() => done())
          }),
      })
    })
  })
}

function tunnel(
  client: Duplex,
  head: Buffer,
  dial: Dial,
  target: { host: string; port: number },
  track: (socket: Duplex) => void,
): void {
  let upstream: Socket
  try {
    upstream = dial(target.host, target.port)
  } catch {
    client.end(BAD_GATEWAY)
    return
  }
  track(upstream)
  let established = false
  upstream.once('connect', () => {
    established = true
    client.write(ESTABLISHED)
    if (head.length > 0) upstream.write(head)
    upstream.pipe(client)
    client.pipe(upstream)
  })
  upstream.on('error', () => {
    if (established) client.destroy()
    else client.end(BAD_GATEWAY)
    upstream.destroy()
  })
  upstream.once('close', () => client.destroy())
  client.once('close', () => upstream.destroy())
}
