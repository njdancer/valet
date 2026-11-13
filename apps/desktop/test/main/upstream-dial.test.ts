// The evals' upstream dial (src/main/electron/upstream-dial.ts): names go through the proxy's
// CONNECT, the eval's own sites straight to loopback, and addresses only when the person allowed one.

import { createServer, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { evalSites, upstreamProxyDial } from '../../src/main/electron/upstream-dial'

const servers: Server[] = []
afterEach(() => {
  for (const s of servers.splice(0)) s.close()
})

function listen(onSocket: (socket: Socket) => void): Promise<number> {
  const server = createServer(onSocket)
  servers.push(server)
  return new Promise((done) =>
    server.listen(0, '127.0.0.1', () => done((server.address() as { port: number }).port)),
  )
}

/** Connects with the dial and returns everything read until the far end closes, or the error. */
function exchange(socket: Socket, send: string): Promise<string> {
  return new Promise((done) => {
    let text = ''
    // As the egress proxy's tunnel does: read only once connected.
    socket.once('connect', () => {
      socket.on('data', (chunk: Buffer) => {
        text += chunk.toString()
      })
      socket.write(send)
    })
    socket.on('error', (error) => done(`error: ${error.message}`))
    socket.on('close', () => done(text))
  })
}

describe('the evals’ upstream dial', () => {
  it('reads only .test names on loopback from VALET_E2E_SITES', () => {
    const sites = evalSites(
      'library.example.test=127.0.0.1:4430, evil.com=127.0.0.1:1, a.test=10.0.0.1:2, junk',
    )
    expect([...sites]).toEqual([['library.example.test', { host: '127.0.0.1', port: 4430 }]])
  })

  it('tunnels a name through the proxy and holds connect until the proxy says yes', async () => {
    const asked: string[] = []
    const proxy = await listen((socket) => {
      socket.once('data', (chunk: Buffer) => {
        asked.push(chunk.toString().split('\r\n')[0] ?? '')
        // The reply and the first tunnelled bytes in one packet: the extra bytes reach the caller.
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\nhello')
        socket.once('data', (sent: Buffer) => socket.end(` ${sent.toString()}`))
      })
    })
    const dial = upstreamProxyDial(`http://127.0.0.1:${proxy}`)
    expect(await exchange(dial('www.example.com', 443), 'ping')).toBe('hello ping')
    expect(asked).toEqual(['CONNECT www.example.com:443 HTTP/1.1'])
  })

  it('fails the connection when the proxy refuses', async () => {
    const proxy = await listen((socket) =>
      socket.once('data', () => socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n')),
    )
    const dial = upstreamProxyDial(`http://127.0.0.1:${proxy}`)
    expect(await exchange(dial('blocked.example', 443), 'ping')).toBe('error: refused by the proxy')
  })

  it('sends an eval site to loopback, and an address only when allowed, never through the proxy', async () => {
    const site = await listen((socket) =>
      socket.once('data', (d: Buffer) => socket.end(`site ${d.toString()}`)),
    )
    const proxied: string[] = []
    const proxy = await listen((socket) => {
      proxied.push('asked')
      socket.destroy()
    })
    const sites = evalSites(`library.example.test=127.0.0.1:${site}`)
    let allow = false
    const dial = upstreamProxyDial(`http://127.0.0.1:${proxy}`, () => allow, sites)
    expect(await exchange(dial('library.example.test', 443), 'hi')).toBe('site hi')
    expect(await exchange(dial('127.0.0.1', site), 'hi')).toBe('error: refused')
    expect(await exchange(dial('93.184.216.34', 443), 'hi')).toBe('error: refused')
    allow = true
    expect(await exchange(dial('127.0.0.1', site), 'hi')).toBe('site hi')
    expect(proxied).toEqual([])
  })
})
