// The proxy over real loopback sockets. Nothing leaves the machine: `dial` is injected, and the only
// upstream is an echo server on 127.0.0.1.

import { connect, createServer, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { parseAuthority, startEgressProxy } from '../src/egress-proxy'
import type { ProxyHandle } from '../src/platform'

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

/** An upstream that echoes what it receives, prefixed, and counts its connections. */
async function echoServer(): Promise<{ port: number; connections: () => number }> {
  let connections = 0
  const server: Server = createServer((socket) => {
    connections++
    socket.on('data', (data) => socket.write(`echo:${data.toString('utf8')}`))
    socket.on('error', () => {})
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  cleanups.push(() => new Promise((resolve) => server.close(() => resolve())))
  return { port: address.port, connections: () => connections }
}

async function proxy(options: Parameters<typeof startEgressProxy>[0]): Promise<ProxyHandle> {
  const handle = await startEgressProxy(options)
  cleanups.push(() => handle.close())
  return handle
}

function portOf(handle: ProxyHandle): number {
  return Number(new URL(handle.url).port)
}

/** Sends `request` to the proxy and collects everything until the socket ends or `until` matches. */
function exchange(port: number, request: string, until?: RegExp, then?: string): Promise<string> {
  return new Promise((resolve) => {
    const socket: Socket = connect({ host: '127.0.0.1', port })
    let received = ''
    let sentThen = false
    socket.on('data', (data) => {
      received += data.toString('utf8')
      if (then !== undefined && !sentThen && received.includes('\r\n\r\n')) {
        sentThen = true
        socket.write(then)
      }
      if (until?.test(received)) socket.end()
    })
    socket.on('error', () => resolve(received))
    socket.on('close', () => resolve(received))
    socket.write(request)
  })
}

describe('parseAuthority', () => {
  it('reads a host and port', () => {
    expect(parseAuthority('www.example.com:443')).toEqual({ host: 'www.example.com', port: 443 })
    expect(parseAuthority('WWW.Example.com:8443')).toEqual({ host: 'www.example.com', port: 8443 })
  })

  it('refuses anything that is not exactly host:port', () => {
    for (const authority of [
      undefined,
      'www.example.com',
      'www.example.com:',
      'user@www.example.com:443',
      'www.example.com:443/path',
      'www.example.com:443?x',
      'www.example.com:99999',
      'www.example.com:0',
      'a b:443',
      'www.example.com\\@evil.test:443',
    ]) {
      expect(parseAuthority(authority), String(authority)).toBeNull()
    }
  })

  it('keeps an IPv6 host bracketed, which no host pattern matches', () => {
    expect(parseAuthority('[::1]:443')).toEqual({ host: '[::1]', port: 443 })
  })
})

describe('startEgressProxy', () => {
  it('listens on loopback only', async () => {
    const handle = await proxy({ allow: () => false })
    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  })

  it('tunnels an allowed CONNECT to where dial says, both ways', async () => {
    const upstream = await echoServer()
    const dialled: [string, number][] = []
    const handle = await proxy({
      allow: (host, port) => host === 'site.test' && port === 443,
      dial: (host, port) => {
        dialled.push([host, port])
        return connect({ host: '127.0.0.1', port: upstream.port })
      },
    })
    const reply = await exchange(
      portOf(handle),
      'CONNECT site.test:443 HTTP/1.1\r\nHost: site.test:443\r\n\r\n',
      /echo:hello/,
      'hello',
    )
    expect(reply).toContain('HTTP/1.1 200 Connection Established')
    expect(reply).toContain('echo:hello')
    expect(dialled).toEqual([['site.test', 443]])
  })

  it('passes on bytes the client sent along with the CONNECT', async () => {
    const upstream = await echoServer()
    const handle = await proxy({
      allow: () => true,
      dial: () => connect({ host: '127.0.0.1', port: upstream.port }),
    })
    const reply = await exchange(portOf(handle), 'CONNECT site.test:443 HTTP/1.1\r\n\r\nearly', /echo:early/)
    expect(reply).toContain('echo:early')
  })

  it('refuses a CONNECT the policy refuses, without dialling or resolving anything', async () => {
    const asked: [string, number][] = []
    let dialled = 0
    const handle = await proxy({
      allow: (host, port) => {
        asked.push([host, port])
        return false
      },
      dial: () => {
        dialled++
        return connect({ host: '127.0.0.1', port: 1 })
      },
    })
    const reply = await exchange(portOf(handle), 'CONNECT session-token-value.evil.test:443 HTTP/1.1\r\n\r\n')
    expect(reply).toMatch(/^HTTP\/1\.1 403 Forbidden/)
    expect(asked).toEqual([['session-token-value.evil.test', 443]])
    expect(dialled).toBe(0)
  })

  it('refuses when the policy throws', async () => {
    let dialled = 0
    const handle = await proxy({
      allow: () => {
        throw new Error('broken policy')
      },
      dial: () => {
        dialled++
        return connect({ host: '127.0.0.1', port: 1 })
      },
    })
    expect(await exchange(portOf(handle), 'CONNECT site.test:443 HTTP/1.1\r\n\r\n')).toMatch(/403/)
    expect(dialled).toBe(0)
  })

  it('refuses a malformed authority without asking the policy', async () => {
    const asked: string[] = []
    const handle = await proxy({ allow: (host) => asked.push(host) > 0 })
    expect(await exchange(portOf(handle), 'CONNECT user@site.test:443 HTTP/1.1\r\n\r\n')).toMatch(/403/)
    expect(asked).toEqual([])
  })

  it('refuses plain proxied HTTP, which the tool partition never needs', async () => {
    const upstream = await echoServer()
    const handle = await proxy({
      allow: () => true,
      dial: () => connect({ host: '127.0.0.1', port: upstream.port }),
    })
    const reply = await exchange(
      portOf(handle),
      'GET http://site.test/ HTTP/1.1\r\nHost: site.test\r\n\r\n',
      /\r\n\r\n/,
    )
    expect(reply).toMatch(/^HTTP\/1\.1 403/)
    expect(upstream.connections()).toBe(0)
  })

  it('answers 502 when the upstream cannot be reached', async () => {
    const closed = await echoServer()
    const port = closed.port
    for (const cleanup of cleanups.splice(0)) await cleanup()
    const handle = await proxy({ allow: () => true, dial: () => connect({ host: '127.0.0.1', port }) })
    expect(await exchange(portOf(handle), 'CONNECT site.test:443 HTTP/1.1\r\n\r\n')).toMatch(
      /^HTTP\/1\.1 502/,
    )
  })

  it('answers 502 when dialling throws', async () => {
    const handle = await proxy({
      allow: () => true,
      dial: () => {
        throw new Error('no route')
      },
    })
    expect(await exchange(portOf(handle), 'CONNECT site.test:443 HTTP/1.1\r\n\r\n')).toMatch(/502/)
  })

  it('cuts the client off when the upstream drops mid-tunnel', async () => {
    // The proxy can answer 200 before the server's connection callback runs, so wait for the socket.
    let upstreamArrived: (socket: Socket) => void = () => {}
    const upstreamSocket = new Promise<Socket>((resolve) => {
      upstreamArrived = resolve
    })
    const server = createServer((socket) => {
      socket.on('error', () => {})
      upstreamArrived(socket)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('no port')
    cleanups.push(() => new Promise((resolve) => server.close(() => resolve())))
    const handle = await proxy({
      allow: () => true,
      dial: () => connect({ host: '127.0.0.1', port: address.port }),
    })
    const client = connect({ host: '127.0.0.1', port: portOf(handle) })
    const closed = new Promise<void>((resolve) => client.on('close', () => resolve()))
    client.on('error', () => {})
    client.once('data', () => {
      void upstreamSocket.then((socket) => socket.destroy(new Error('reset')))
    })
    client.write('CONNECT site.test:443 HTTP/1.1\r\n\r\n')
    await closed
    expect(client.destroyed).toBe(true)
  })

  it('closes open tunnels when it is closed', async () => {
    const upstream = await echoServer()
    const handle = await startEgressProxy({
      allow: () => true,
      dial: () => connect({ host: '127.0.0.1', port: upstream.port }),
    })
    const client = connect({ host: '127.0.0.1', port: portOf(handle) })
    client.on('error', () => {})
    const established = new Promise<void>((resolve) => client.once('data', () => resolve()))
    const closed = new Promise<void>((resolve) => client.on('close', () => resolve()))
    client.write('CONNECT site.test:443 HTTP/1.1\r\n\r\n')
    await established
    await handle.close()
    await closed
    expect(client.destroyed).toBe(true)
  })
})
