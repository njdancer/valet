import { randomBytes } from 'node:crypto'
import { createServer as createHttpServer, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { TLSSocket } from 'node:tls'
import { tunnelHost } from '@valet/core'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CONTROL_HOST,
  certFor,
  dial,
  lookup,
  MAC_DOMAIN,
  macKeys,
  type Rig,
  signerFor,
  startMac,
  startRig,
  type TestMac,
  testWebSocket,
  waitFor,
} from './helpers'

let rig: Rig | null = null
const macs: TestMac[] = []
afterEach(async () => {
  for (const mac of macs.splice(0)) mac.client.stop()
  await rig?.close()
  rig = null
})

/** A plain HTTP server standing in for the remote listener: echoes what it got. */
function echoServer() {
  const server = createHttpServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'x-saw-host': req.headers.host ?? '',
        'x-saw-tls': String((req.socket as TLSSocket).encrypted === true),
        'x-saw-source': String(sources.get(req.socket) ?? ''),
      })
      if (req.url === '/big') res.end(randomBytesSeeded(Number(req.headers['x-size'])))
      else res.end(body)
    })
  })
  const sources = new WeakMap<object, string>()
  return {
    accept: (socket: TLSSocket, meta: { source: string }) => {
      sources.set(socket, meta.source)
      server.emit('connection', socket)
    },
  }
}

function randomBytesSeeded(size: number): Buffer {
  const out = Buffer.alloc(size)
  for (let i = 0; i < size; i++) out[i] = (i * 31 + 7) & 0xff
  return out
}

function get(
  rigNow: Rig,
  mac: TestMac,
  path: string,
  options: { body?: Buffer; headers?: Record<string, string>; servername?: string } = {},
): Promise<{ status: number; headers: IncomingMessage['headers']; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: mac.host,
        port: rigNow.port,
        path,
        method: options.body === undefined ? 'GET' : 'POST',
        ca: mac.cert.pem,
        lookup,
        servername: options.servername ?? mac.host,
        headers: { host: mac.host, ...options.headers },
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
        )
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    req.end(options.body)
  })
}

describe('the blind relay', () => {
  it('signs a Mac in and routes its name to it, with TLS ending on the Mac', async () => {
    rig = await startRig()
    const echo = echoServer()
    const mac = startMac(rig, echo.accept)
    macs.push(mac)
    await mac.online()
    expect(mac.client.status).toEqual({ state: 'online', host: mac.host })
    expect(rig.relay.macs()).toEqual([mac.keys.macId])
    const marker = `secret-tool-call-${randomBytes(8).toString('hex')}`
    const res = await get(rig, mac, '/mcp', { body: Buffer.from(marker) })
    expect(res.status).toBe(200)
    expect(res.body.toString()).toBe(marker)
    expect(res.headers['x-saw-host']).toBe(mac.host)
    expect(res.headers['x-saw-tls']).toBe('true')
    expect(res.headers['x-saw-source']).toBe('127.0.0.1')
    // Everything the relay passed to the Mac was ciphertext: the marker never appears in it.
    const all = Buffer.concat(mac.received)
    expect(all.length).toBeGreaterThan(marker.length)
    expect(all.includes(marker)).toBe(false)
    // The relay logs counts, never content.
    expect(rig.lines.join('\n')).not.toContain(marker)
  })

  it('carries large bodies both ways intact, several at once', async () => {
    rig = await startRig()
    const mac = startMac(rig, echoServer().accept)
    macs.push(mac)
    await mac.online()
    const upload = randomBytes(3_000_000)
    const results = await Promise.all([
      get(rig, mac, '/echo', { body: upload }),
      get(rig, mac, '/big', { headers: { 'x-size': String(4_000_000) } }),
      get(rig, mac, '/echo', { body: Buffer.from('small') }),
    ])
    expect(results[0]?.body.equals(upload)).toBe(true)
    expect(results[1]?.body.equals(randomBytesSeeded(4_000_000))).toBe(true)
    expect(results[2]?.body.toString()).toBe('small')
  })

  it('closes connections for names it does not route', async () => {
    rig = await startRig()
    const mac = startMac(rig, echoServer().accept)
    macs.push(mac)
    await mac.online()
    const offline = macKeys()
    for (const name of [`${offline.macId}.${MAC_DOMAIN}`, `www.${MAC_DOMAIN}`, 'example.com']) {
      const socket = dial(rig, name, mac.cert.pem)
      await expect(new Promise((_, reject) => socket.on('error', reject))).rejects.toThrow()
    }
  })

  it("serves the Mac's other name with that name's certificate, and no tag it doesn't have", async () => {
    rig = await startRig()
    const keys = macKeys()
    const tagged = tunnelHost(keys.macId, MAC_DOMAIN, '2')
    const taggedCert = certFor([tagged])
    const first = certFor([tunnelHost(keys.macId, MAC_DOMAIN)])
    const mac = startMac(rig, echoServer().accept, {
      keys,
      tag: '2',
      certificate: (name) => (name === tagged ? taggedCert.context : first.context),
    })
    macs.push(mac)
    await mac.online()
    expect(mac.client.taggedHost).toBe(tagged)
    const res = await new Promise<{ status: number; host: unknown }>((resolve, reject) => {
      const req = httpsRequest(
        {
          host: tagged,
          port: rig?.port,
          path: '/mcp',
          ca: taggedCert.pem,
          lookup,
          servername: tagged,
          headers: { host: tagged },
          agent: false,
        },
        (r) => {
          r.resume()
          r.on('end', () => resolve({ status: r.statusCode ?? 0, host: r.headers['x-saw-host'] }))
        },
      )
      req.on('error', reject)
      req.end()
    })
    expect(res).toEqual({ status: 200, host: tagged })
    // Another tag routes to this Mac at the relay, but the Mac has no such name and drops it.
    const socket = dial(rig, tunnelHost(keys.macId, MAC_DOMAIN, '3'), taggedCert.pem)
    await expect(new Promise((_, reject) => socket.on('error', reject))).rejects.toThrow()
  })

  it('answers its own control host with its own certificate', async () => {
    rig = await startRig({ version: 'test-1' })
    const text = await new Promise<string>((resolve, reject) => {
      const req = httpsRequest(
        {
          host: CONTROL_HOST,
          port: rig?.port,
          path: '/healthz',
          ca: rig?.controlCert.pem,
          lookup,
          agent: false,
        },
        (res) => {
          let body = ''
          res.on('data', (c) => {
            body += c
          })
          res.on('end', () => resolve(body))
        },
      )
      req.on('error', reject)
      req.end()
    })
    expect(text).toBe('ok test-1 0\n')
  })

  it('answers a connection with no server name as its control host', async () => {
    // A Mac dialling the relay by address (a local relay in development) sends no name.
    rig = await startRig({ version: 'test-2' })
    const text = await new Promise<string>((resolve, reject) => {
      const req = httpsRequest(
        {
          host: '127.0.0.1',
          port: rig?.port,
          path: '/healthz',
          ca: rig?.controlCert.pem,
          checkServerIdentity: (_host, cert) =>
            cert.subjectaltname?.includes(`DNS:${CONTROL_HOST}`) ? undefined : new Error('not control'),
          agent: false,
        },
        (res) => {
          let body = ''
          res.on('data', (c) => {
            body += c
          })
          res.on('end', () => resolve(body))
        },
      )
      req.on('error', reject)
      req.end()
    })
    expect(text).toBe('ok test-2 0\n')
  })

  it('refuses a Mac whose signature or binding is wrong', async () => {
    rig = await startRig()
    const keys = macKeys()
    const other = macKeys()
    // Signed with another key than the one it presents.
    const badSig = startMac(rig, null, { keys, signer: signerFor(keys, other.transportPrivate) })
    macs.push(badSig)
    await waitFor(() => badSig.statuses.some((s) => s.state === 'refused'))
    // A binding from another Mac's approval key: its id is not this macId.
    const badBinding = startMac(rig, null, { keys: { ...keys, binding: other.binding } })
    macs.push(badBinding)
    await waitFor(() => badBinding.statuses.some((s) => s.state === 'refused'))
    expect(rig.relay.macs()).toEqual([])
  })

  it('refuses a denied Mac', async () => {
    const keys = macKeys()
    rig = await startRig({ denied: () => new Set([keys.macId]) })
    const mac = startMac(rig, null, { keys })
    macs.push(mac)
    await waitFor(() => mac.statuses.some((s) => s.state === 'offline' || s.state === 'refused'))
    expect(rig.relay.macs()).toEqual([])
  })

  it('a second connection as the same Mac replaces the first, which stops', async () => {
    rig = await startRig()
    const first = startMac(rig, echoServer().accept)
    macs.push(first)
    await first.online()
    const second = startMac(rig, echoServer().accept, { keys: first.keys })
    macs.push(second)
    await second.online()
    await waitFor(() => first.client.status.state === 'replaced')
    expect(rig.relay.macs()).toEqual([first.keys.macId])
  })

  it('refuses a Mac that answers a challenge for another relay', async () => {
    rig = await startRig()
    const mac = startMac(rig, null, { relay: 'https://other.test' })
    macs.push(mac)
    await waitFor(() => mac.statuses.filter((s) => s.state === 'offline').length >= 1)
    expect(rig.relay.macs()).toEqual([])
  })

  it('closes connections while remote access is paused, and when the Mac goes', async () => {
    rig = await startRig()
    const paused = startMac(rig, null)
    macs.push(paused)
    await paused.online()
    await expect(get(rig, paused, '/')).rejects.toThrow()
    paused.client.stop()
    await waitFor(() => rig?.relay.macs().length === 0)
    await expect(get(rig, paused, '/')).rejects.toThrow()
  })

  it('a connection the Mac closes closes for the caller too, promptly', async () => {
    rig = await startRig()
    // The Mac drops each connection a moment after it opens, like an idle timer firing.
    const mac = startMac(rig, (socket) => {
      setTimeout(() => socket.destroy(), 100)
    })
    macs.push(mac)
    await mac.online()
    for (const sendFirst of [false, true]) {
      const socket = dial(rig, mac.host, mac.cert.pem)
      socket.on('error', () => {})
      if (sendFirst) socket.once('secureConnect', () => socket.write('GET / HTTP/1.1\r\n'))
      const closed = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 3000)
        socket.once('close', () => {
          clearTimeout(timer)
          resolve(true)
        })
      })
      socket.destroy()
      expect(closed, `closed (sent first: ${sendFirst})`).toBe(true)
    }
  })

  it('tells the Mac why it dropped a connection before serving it', async () => {
    rig = await startRig()
    const dropped: string[] = []
    let paused = false
    const accept = echoServer().accept
    const mac = startMac(rig, null, {
      listener: () => (paused ? null : accept),
      onDropped: (why) => dropped.push(why),
    })
    macs.push(mac)
    await mac.online()
    // A client that speaks only h2: the handshake fails on the Mac, and says so.
    const h2 = dial(rig, mac.host, mac.cert.pem, ['h2'])
    h2.on('error', () => undefined)
    await waitFor(() => dropped.length === 1)
    expect(dropped[0]).toMatch(/^tls handshake failed: /)
    h2.destroy()
    paused = true
    const late = dial(rig, mac.host, mac.cert.pem)
    late.on('error', () => undefined)
    await waitFor(() => dropped.length === 2)
    expect(dropped[1]).toBe('remote access paused')
    late.destroy()
    // A served connection is never reported.
    paused = false
    expect((await get(rig, mac, '/ok', { body: Buffer.from('x') })).status).toBe(200)
    expect(dropped).toHaveLength(2)
  })

  it('holds a caller for a Mac that is between links, and serves it once the Mac is back', async () => {
    rig = await startRig({ limits: { macGraceMs: 5000 } })
    const keys = macKeys()
    const first = startMac(rig, echoServer().accept, { keys })
    macs.push(first)
    await first.online()
    first.client.stop()
    await waitFor(() => rig?.relay.macs().length === 0)
    const pendingAnswer = get(rig, first, '/echo', { body: Buffer.from('held') })
    await new Promise((resolve) => setTimeout(resolve, 300))
    const again = startMac(rig, echoServer().accept, { keys, certificate: () => first.cert.context })
    macs.push(again)
    const res = await pendingAnswer
    expect(res.status).toBe(200)
    expect(res.body.toString()).toBe('held')
  })

  it('drops a link that went silent on both ends, and the Mac comes straight back', async () => {
    rig = await startRig({ limits: { macGraceMs: 5000 } })
    let holes = 0
    const ca = rig.controlCert.pem
    const Base = testWebSocket(ca)
    // The first link loses every frame both ways after a moment, as a network that died silently.
    class Flaky extends (Base as unknown as new (
      url: string,
    ) => {
      emit(event: string, ...args: unknown[]): boolean
      send(data: unknown): void
    }) {
      private hole = false
      constructor(url: string) {
        super(url)
        if (holes++ === 0) setTimeout(() => (this.hole = true), 400)
      }
      override emit(event: string, ...args: unknown[]): boolean {
        if (this.hole && event === 'message') return false
        return super.emit(event, ...args)
      }
      override send(data: unknown): void {
        if (!this.hole) super.send(data)
      }
    }
    const mac = startMac(rig, echoServer().accept, {
      WebSocket: Flaky as unknown as typeof WebSocket,
      pingMs: 150,
    })
    macs.push(mac)
    await mac.online()
    // The Mac hears no answer to its ping, drops the link and dials again without a backoff.
    await waitFor(() => holes === 2 && mac.client.status.state === 'online')
    expect(mac.statuses.map((s) => s.state)).toEqual([
      'connecting',
      'online',
      'offline',
      'connecting',
      'online',
    ])
    const res = await get(rig, mac, '/echo', { body: Buffer.from('after') })
    expect(res.body.toString()).toBe('after')
  })

  it('drops a Mac link it hears nothing on, so callers are not piped into it', async () => {
    rig = await startRig({ limits: { silentMs: 300 } })
    // A Mac that never pings: to the relay, a link whose network died without a close.
    const mac = startMac(rig, echoServer().accept, { pingMs: 60_000 })
    macs.push(mac)
    await mac.online()
    await waitFor(() => rig?.lines.some((l) => l.startsWith(`mac silent ${mac.keys.macId}`)) === true)
    await waitFor(() => mac.statuses.filter((s) => s.state === 'online').length >= 2)
  })

  it('a Mac comes back after the relay restarts, with nothing stored', async () => {
    rig = await startRig()
    const port = rig.port
    const mac = startMac(rig, echoServer().accept)
    macs.push(mac)
    await mac.online()
    const cert = rig.controlCert
    await rig.close()
    await waitFor(() => mac.client.status.state !== 'online')
    rig = await startRig({ port, controlCertificate: () => cert.context })
    // The Mac trusts the first relay's certificate, so the restarted one serves the same one.
    Object.assign(rig, { controlCert: cert })
    await mac.online()
    expect((await get(rig, mac, '/echo', { body: Buffer.from('back') })).body.toString()).toBe('back')
  })

  it('serves the TLS-ALPN-01 certificate only to acme-tls/1 and nothing else on it', async () => {
    rig = await startRig()
    const keys = macKeys()
    const host = `${keys.macId}.${MAC_DOMAIN}`
    const challenge = certFor([host], 'token.thumbprint')
    let served = 0
    const mac = startMac(rig, () => served++, {
      keys,
      acmeChallenge: (name) => (name === host ? challenge.context : null),
    })
    macs.push(mac)
    await mac.online()
    const socket = dial(rig, host, null, ['acme-tls/1'])
    await new Promise<void>((resolve, reject) => {
      socket.on('secureConnect', () => {
        expect(socket.alpnProtocol).toBe('acme-tls/1')
        expect(
          socket
            .getPeerX509Certificate()
            ?.raw.equals(Buffer.from(challenge.pem.split('\n').slice(1, -2).join(''), 'base64')),
        ).toBe(true)
        resolve()
      })
      socket.on('error', reject)
    })
    await new Promise((r) => socket.on('close', r))
    expect(served).toBe(0)
  })

  it('holds a slow reader back without stalling other connections', async () => {
    rig = await startRig({ window: 64 * 1024 })
    const mac = startMac(rig, echoServer().accept, { window: 64 * 1024 })
    macs.push(mac)
    await mac.online()
    // A caller that sends a lot and never reads the reply.
    const stalled = dial(rig, mac.host, mac.cert.pem)
    await new Promise((r) => stalled.on('secureConnect', r))
    stalled.pause()
    stalled.write(`POST /echo HTTP/1.1\r\nhost: ${mac.host}\r\ncontent-length: 5000000\r\n\r\n`)
    stalled.write(randomBytes(5_000_000))
    await new Promise((r) => setTimeout(r, 300))
    const res = await get(rig, mac, '/echo', { body: Buffer.from('still here') })
    expect(res.body.toString()).toBe('still here')
    stalled.destroy()
  })
})
