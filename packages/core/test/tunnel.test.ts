import { randomBytes } from 'node:crypto'
import { createServer, type Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { describe, expect, it } from 'vitest'
import {
  decodeTunnelFrame,
  encodeTunnelFrame,
  macIdForHost,
  parseClientHello,
  TUNNEL_FRAME,
  TUNNEL_LIMITS,
  TunnelMux,
  type TunnelStream,
  tunnelHost,
} from '../src'

/** The bytes a real Node TLS client sends first. */
async function captureClientHello(servername: string | undefined, alpn?: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket: Socket) => {
      const chunks: Buffer[] = []
      socket.on('data', (chunk: Buffer) => {
        chunks.push(chunk)
        const all = Buffer.concat(chunks)
        if (parseClientHello(all).state !== 'partial') {
          socket.destroy()
          server.close()
          resolve(all)
        }
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      const client = tlsConnect({
        host: '127.0.0.1',
        port,
        ...(servername === undefined ? {} : { servername }),
        ...(alpn === undefined ? {} : { ALPNProtocols: alpn }),
        rejectUnauthorized: false,
      })
      client.on('error', () => undefined)
    })
    server.on('error', reject)
  })
}

describe('parseClientHello', () => {
  it('reads the server name and ALPN from a real hello', async () => {
    const hello = await captureClientHello('ABCDEF0123456789abcdef0123456789.macs.test', [
      'acme-tls/1',
      'http/1.1',
    ])
    expect(parseClientHello(hello)).toEqual({
      state: 'complete',
      serverName: 'abcdef0123456789abcdef0123456789.macs.test',
      alpn: ['acme-tls/1', 'http/1.1'],
    })
  })

  it('says partial for every prefix and complete only at the end', async () => {
    const hello = await captureClientHello('a.macs.test')
    for (let n = 0; n < hello.length; n += 7)
      expect(parseClientHello(hello.subarray(0, n)).state).toBe('partial')
    expect(parseClientHello(hello)).toMatchObject({ state: 'complete', serverName: 'a.macs.test', alpn: [] })
  })

  it('handles a hello with no server name', async () => {
    const hello = await captureClientHello(undefined)
    expect(parseClientHello(hello)).toMatchObject({ state: 'complete', serverName: null })
  })

  it('reads a hello split across two records', async () => {
    const hello = await captureClientHello('split.macs.test', ['http/1.1'])
    const body = hello.subarray(5, 5 + hello.readUInt16BE(3))
    const cut = 40
    const record = (part: Buffer) =>
      Buffer.concat([Buffer.from([22, 3, 1, part.length >> 8, part.length & 255]), part])
    const split = Buffer.concat([record(body.subarray(0, cut)), record(body.subarray(cut))])
    expect(parseClientHello(split.subarray(0, 50)).state).toBe('partial')
    expect(parseClientHello(split)).toMatchObject({ state: 'complete', serverName: 'split.macs.test' })
  })

  it('refuses what is not TLS', () => {
    expect(parseClientHello(Buffer.from('GET / HTTP/1.1\r\nHost: x\r\n\r\n')).state).toBe('invalid')
    expect(parseClientHello(Buffer.from([22, 3, 3, 0, 4, 2, 0, 0, 0])).state).toBe('invalid')
    expect(parseClientHello(randomBytes(3000)).state).not.toBe('complete')
  })

  it('refuses a hello whose server name carries odd bytes', async () => {
    const hello = Buffer.from(await captureClientHello('aaaa.macs.test'))
    const at = hello.indexOf('aaaa.macs.test')
    hello[at] = 0x2f // '/'
    expect(parseClientHello(hello).state).toBe('invalid')
  })
})

describe('tunnel hosts', () => {
  const macId = '0123456789abcdef0123456789abcdef'
  it('names a Mac under the domain and reads it back', () => {
    expect(tunnelHost(macId, 'Macs.Test.')).toBe(`${macId}.macs.test`)
    expect(macIdForHost(`${macId.toUpperCase()}.macs.test.`, 'macs.test')).toBe(macId)
  })
  it('refuses anything else', () => {
    expect(macIdForHost(`${macId}.macs.test.evil`, 'macs.test')).toBeNull()
    expect(macIdForHost(`x.${macId}.macs.test`, 'macs.test')).toBeNull()
    expect(macIdForHost('relay.macs.test', 'macs.test')).toBeNull()
    expect(macIdForHost(`${macId}.notmacs.test`, 'macs.test')).toBeNull()
  })
  it('reads a tagged name back to the same Mac', () => {
    expect(tunnelHost(macId, 'macs.test', '2')).toBe(`${macId}-2.macs.test`)
    expect(macIdForHost(`${macId}-2.macs.test`, 'macs.test')).toBe(macId)
    expect(macIdForHost(`${macId}-Ab9.MACS.test.`, 'macs.test')).toBe(macId)
  })
  it('refuses a tag that is empty, too long, or not one plain label', () => {
    expect(macIdForHost(`${macId}-.macs.test`, 'macs.test')).toBeNull()
    expect(macIdForHost(`${macId}-${'a'.repeat(17)}.macs.test`, 'macs.test')).toBeNull()
    expect(macIdForHost(`${macId}-a-b.macs.test`, 'macs.test')).toBeNull()
    expect(macIdForHost(`${macId}-a_b.macs.test`, 'macs.test')).toBeNull()
    expect(macIdForHost(`${macId.slice(1)}-2.macs.test`, 'macs.test')).toBeNull()
  })
})

describe('frames', () => {
  it('round-trips every kind', () => {
    const frames = [
      { kind: TUNNEL_FRAME.open, stream: 1, open: { source: '203.0.113.9' } },
      { kind: TUNNEL_FRAME.data, stream: 2, data: Buffer.from('hi') },
      { kind: TUNNEL_FRAME.end, stream: 3 },
      { kind: TUNNEL_FRAME.reset, stream: 0xffffffff },
      { kind: TUNNEL_FRAME.credit, stream: 5, credit: 1234 },
    ] as const
    for (const frame of frames) expect(decodeTunnelFrame(encodeTunnelFrame(frame))).toEqual(frame)
  })
  it('refuses malformed ones', () => {
    expect(decodeTunnelFrame(Buffer.from([2, 0, 0, 0]))).toBeNull()
    expect(decodeTunnelFrame(Buffer.from([9, 0, 0, 0, 1]))).toBeNull()
    expect(decodeTunnelFrame(Buffer.from([2, 0, 0, 0, 1]))).toBeNull()
    expect(decodeTunnelFrame(Buffer.from([5, 0, 0, 0, 1, 0, 0, 0, 0]))).toBeNull()
    expect(decodeTunnelFrame(Buffer.from([3, 0, 0, 0, 1, 7]))).toBeNull()
    expect(
      decodeTunnelFrame(Buffer.concat([Buffer.from([1, 0, 0, 0, 1]), Buffer.from('{"source":1}')])),
    ).toBeNull()
    expect(decodeTunnelFrame(Buffer.alloc(5 + TUNNEL_LIMITS.maxDataBytes + 1, 2))).toBeNull()
    expect(() =>
      encodeTunnelFrame({ kind: 2, stream: 1, data: Buffer.alloc(TUNNEL_LIMITS.maxDataBytes + 1) }),
    ).toThrow()
  })
})

/** A relay-side mux and a Mac-side mux wired back to back, delivering asynchronously like a socket. */
function pair(window?: number) {
  const opened: { stream: TunnelStream; source: string }[] = []
  const violations: string[] = []
  const sent = { relay: 0, mac: 0 }
  let mac: TunnelMux
  const relay = new TunnelMux({
    send: (frame) => {
      sent.relay += frame.length
      setImmediate(() => mac.receive(frame))
    },
    onViolation: (why) => violations.push(`relay: ${why}`),
    ...(window === undefined ? {} : { window }),
  })
  mac = new TunnelMux({
    acceptsOpen: true,
    send: (frame) => {
      sent.mac += frame.length
      setImmediate(() => relay.receive(frame))
    },
    onOpen: (stream, open) => opened.push({ stream, source: open.source }),
    onViolation: (why) => violations.push(`mac: ${why}`),
    ...(window === undefined ? {} : { window }),
  })
  return { relay, mac, opened, violations, sent }
}

const tick = () => new Promise((r) => setImmediate(r))
async function until(check: () => boolean) {
  for (let i = 0; i < 2000 && !check(); i++) await tick()
  expect(check()).toBe(true)
}

function collect(stream: TunnelStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    stream.on('data', (c: Buffer) => chunks.push(c))
    stream.on('end', () => resolve(Buffer.concat(chunks)))
    stream.on('error', reject)
  })
}

describe('TunnelMux', () => {
  it('carries bytes both ways with half-close, then forgets the stream', async () => {
    const { relay, mac, opened, violations } = pair()
    const a = relay.open({ source: '198.51.100.1' })
    await until(() => opened.length === 1)
    const b = opened[0]?.stream as TunnelStream
    expect(opened[0]?.source).toBe('198.51.100.1')
    const toMac = randomBytes(1_000_000)
    const toRelay = randomBytes(700_000)
    const gotMac = collect(b)
    const gotRelay = collect(a)
    a.end(toMac)
    b.end(toRelay)
    expect((await gotMac).equals(toMac)).toBe(true)
    expect((await gotRelay).equals(toRelay)).toBe(true)
    await until(() => relay.size === 0 && mac.size === 0)
    expect(violations).toEqual([])
  })

  it('holds a sender at the window while the reader is paused', async () => {
    const window = 64 * 1024
    const { relay, opened, sent } = pair(window)
    const a = relay.open({ source: '' })
    await until(() => opened.length === 1)
    const b = opened[0]?.stream as TunnelStream
    b.pause()
    a.write(randomBytes(1_000_000))
    for (let i = 0; i < 200; i++) await tick()
    // A reader that doesn't read holds at most one window plus its own buffer (64 KiB).
    expect(sent.relay).toBeLessThan(window + 64 * 1024 + 2_000)
    expect(sent.relay).toBeGreaterThanOrEqual(window)
    const got = collect(b)
    b.resume()
    a.end()
    expect((await got).length).toBe(1_000_000)
  })

  it('a reset reaches the other side as an error, and late frames are dropped', async () => {
    const { relay, mac, opened, violations } = pair()
    const a = relay.open({ source: '' })
    await until(() => opened.length === 1)
    const b = opened[0]?.stream as TunnelStream
    const errored = new Promise<Error>((resolve) => b.on('error', resolve))
    a.destroy()
    expect((await errored).message).toBe('reset by peer')
    await until(() => mac.size === 0 && relay.size === 0)
    mac.receive(encodeTunnelFrame({ kind: TUNNEL_FRAME.data, stream: b.id, data: Buffer.from('late') }))
    expect(violations).toEqual([])
  })

  it('treats sending past the credit as a violation', async () => {
    const violations: string[] = []
    const mac = new TunnelMux({
      acceptsOpen: true,
      window: 10,
      send: () => undefined,
      onOpen: (s) => s.on('error', () => undefined),
      onViolation: (why) => violations.push(why),
    })
    mac.receive(encodeTunnelFrame({ kind: 1, stream: 1, open: { source: '' } }))
    mac.receive(encodeTunnelFrame({ kind: 2, stream: 1, data: Buffer.alloc(11) }))
    expect(violations).toEqual(['sent past its credit'])
  })

  it('refuses opens it does not accept, reused ids, and streams past the cap', () => {
    const violations: string[] = []
    const sent: Buffer[] = []
    const relay = new TunnelMux({ send: () => undefined, onViolation: (w) => violations.push(w) })
    relay.receive(encodeTunnelFrame({ kind: 1, stream: 1, open: { source: '' } }))
    expect(violations).toEqual(['unexpected open'])
    const mac = new TunnelMux({
      acceptsOpen: true,
      maxStreams: 1,
      send: (f) => sent.push(f),
      onViolation: (w) => violations.push(w),
    })
    mac.receive(encodeTunnelFrame({ kind: 1, stream: 5, open: { source: '' } }))
    mac.receive(encodeTunnelFrame({ kind: 1, stream: 6, open: { source: '' } }))
    expect(decodeTunnelFrame(sent[0] as Buffer)).toEqual({ kind: TUNNEL_FRAME.reset, stream: 6 })
    mac.receive(encodeTunnelFrame({ kind: 1, stream: 3, open: { source: '' } }))
    expect(violations).toEqual(['unexpected open', 'stream id reused'])
    mac.receive(Buffer.from([0]))
    expect(violations.at(-1)).toBe('malformed frame')
  })

  it('closing the mux errors every stream', async () => {
    const { relay, opened } = pair()
    const a = relay.open({ source: '' })
    await until(() => opened.length === 1)
    const failed = new Promise<Error>((resolve) => a.on('error', resolve))
    relay.close()
    expect((await failed).message).toBe('tunnel closed')
    expect(() => relay.open({ source: '' })).toThrow('tunnel closed')
  })
})
