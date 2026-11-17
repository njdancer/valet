// Red team (cross-kind network boundaries, 2026-11-17). Each `it` states what SHOULD hold; a failing
// test is a demonstrated hole.
//
// XK-3: the tool partition's CONNECT proxy decides on the host name and port only, then dials the
// name with the system resolver (realDial = net.connect({ host, port })). Nothing checks the address
// the name resolves to. docs/adapter-kinds.md F1 says "a host name is never resolved to a private
// address", and dial.ts (the broker), net.ts (ctx.local.fetch) and the raw tunnels all refuse a
// non-public answer; the browser path, the oldest, never got the same check. A browser adapter whose
// declared egress host is a name the agent controls (A record 127.0.0.1, 192.168.1.1 or
// 169.254.169.254) has the partition's sockets (fetch, WebSocket, WebRTC TURN over TCP) carried to
// this Mac's loopback or the person's network on every allowed port. Chromium's TLS inside the
// tunnel limits what comes back, but the connection is made and its first bytes are delivered.
// Nothing leaves the machine here: the name's answer is faked by replacing dns.lookup, which is what
// net.connect asks.

import dns from 'node:dns'
import { connect, createServer, type Server } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { startEgressProxy } from '../src/egress-proxy'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

describe('XK-3 a declared egress host that resolves to loopback', () => {
  it('is refused by the tool partition’s proxy, as the broker refuses it', async () => {
    // Something listening on this Mac's loopback (stands in for a local service on an allowed port).
    let reached = 0
    let bytes = ''
    const local: Server = createServer((s) => {
      reached++
      s.on('data', (d) => {
        bytes += d.toString('latin1')
      })
      s.on('error', () => {})
    })
    await new Promise<void>((r) => local.listen(0, '127.0.0.1', r))
    const port = (local.address() as { port: number }).port
    cleanups.push(() => new Promise<void>((r) => local.close(() => r())))

    // The agent's own domain, declared in egress; its A record points home.
    const original = dns.lookup
    ;(dns as { lookup: unknown }).lookup = ((host: string, options: unknown, cb: unknown) => {
      const callback = (typeof options === 'function' ? options : cb) as (...a: unknown[]) => void
      if (host !== 'api.agent-owned.test') return (original as (...a: unknown[]) => void)(host, options, cb)
      const all = typeof options === 'object' && options !== null && (options as { all?: boolean }).all
      process.nextTick(() =>
        all ? callback(null, [{ address: '127.0.0.1', family: 4 }]) : callback(null, '127.0.0.1', 4),
      )
    }) as typeof dns.lookup
    cleanups.push(() => {
      ;(dns as { lookup: unknown }).lookup = original
    })

    // The driver's policy: the host is on the egress list and the port is an allowed one (443 in the
    // app; the test listens where it can).
    const handle = await startEgressProxy({
      allow: (host, p) => host === 'api.agent-owned.test' && p === port,
    })
    cleanups.push(() => handle.close())
    const answer = await new Promise<string>((resolve) => {
      const socket = connect({ host: '127.0.0.1', port: Number(new URL(handle.url).port) })
      let received = ''
      socket.on('data', (d) => {
        received += d.toString('utf8')
        if (received.includes('\r\n\r\n')) {
          socket.write('page bytes to a local service')
          setTimeout(() => socket.end(), 100)
        }
      })
      socket.on('close', () => resolve(received))
      socket.on('error', () => resolve(received))
      socket.write(
        `CONNECT api.agent-owned.test:${port} HTTP/1.1\r\nHost: api.agent-owned.test:${port}\r\n\r\n`,
      )
    })
    expect(answer.startsWith('HTTP/1.1 200')).toBe(false)
    expect(reached).toBe(0)
    expect(bytes).toBe('')
  })
})
