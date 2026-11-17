// The ClientHello reader: real hellos from Node's TLS client, and hand-built hostile ones.

import { type AddressInfo, createServer } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { describe, expect, it } from 'vitest'
import { readClientHello } from '../src/sni'

/** The first bytes Node's TLS client sends when asked for `servername`. */
async function realHello(servername?: string): Promise<Buffer> {
  return new Promise((resolve) => {
    const server = createServer((socket) => {
      socket.once('data', (chunk: Buffer) => {
        resolve(chunk)
        socket.destroy()
        server.close()
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      const client = tlsConnect({
        host: '127.0.0.1',
        port,
        ...(servername === undefined ? {} : { servername }),
      })
      client.on('error', () => {})
    })
  })
}

const u16 = (n: number) => Buffer.from([n >> 8, n & 255])
const u24 = (n: number) => Buffer.from([n >> 16, (n >> 8) & 255, n & 255])

function extension(type: number, data: Buffer): Buffer {
  return Buffer.concat([u16(type), u16(data.length), data])
}

function serverNames(names: readonly (readonly [type: number, name: string])[]): Buffer {
  const entries = Buffer.concat(
    names.map(([t, n]) => Buffer.concat([Buffer.from([t]), u16(n.length), Buffer.from(n, 'latin1')])),
  )
  return extension(0, Buffer.concat([u16(entries.length), entries]))
}

function hello(extensions: readonly Buffer[]): Buffer {
  const exts = Buffer.concat(extensions)
  const body = Buffer.concat([
    Buffer.from([3, 3]),
    Buffer.alloc(32, 7),
    Buffer.from([0]),
    u16(2),
    Buffer.from([0x13, 0x01]),
    Buffer.from([1, 0]),
    u16(exts.length),
    exts,
  ])
  return Buffer.concat([Buffer.from([1]), u24(body.length), body])
}

function records(handshake: Buffer, sizes?: readonly number[]): Buffer {
  const out: Buffer[] = []
  let at = 0
  for (const size of sizes ?? [handshake.length]) {
    const part = handshake.subarray(at, at + size)
    at += size
    out.push(Buffer.concat([Buffer.from([0x16, 3, 1]), u16(part.length), part]))
  }
  return Buffer.concat(out)
}

describe('real ClientHellos', () => {
  it('reads the server name Node sends', async () => {
    expect(readClientHello(await realHello('api.example.com'))).toEqual({
      kind: 'hello',
      serverName: 'api.example.com',
    })
  })

  it('lower-cases it', async () => {
    expect(readClientHello(await realHello('API.Example.COM'))).toEqual({
      kind: 'hello',
      serverName: 'api.example.com',
    })
  })

  it('refuses a hello with no server name', async () => {
    expect(readClientHello(await realHello())).toMatchObject({ kind: 'refused' })
  })

  it('waits for more bytes while the hello is cut short, at every length', async () => {
    const whole = await realHello('api.example.com')
    for (let n = 0; n < whole.length; n++) {
      expect(readClientHello(whole.subarray(0, n)).kind, `at ${n}`).toBe('incomplete')
    }
  })
})

describe('hand-built ClientHellos', () => {
  const ok = hello([serverNames([[0, 'api.example.com']])])

  it('reads one built by hand, and one split over records', () => {
    expect(readClientHello(records(ok))).toEqual({ kind: 'hello', serverName: 'api.example.com' })
    expect(readClientHello(records(ok, [10, 20, ok.length - 30]))).toEqual({
      kind: 'hello',
      serverName: 'api.example.com',
    })
  })

  it.each([
    [
      'two names',
      hello([
        serverNames([
          [0, 'api.example.com'],
          [0, 'evil.example.com'],
        ]),
      ]),
    ],
    ['a non-host name type', hello([serverNames([[1, 'api.example.com']])])],
    [
      'two server_name extensions',
      hello([serverNames([[0, 'api.example.com']]), serverNames([[0, 'evil.example.com']])]),
    ],
    [
      'an Encrypted Client Hello',
      hello([serverNames([[0, 'api.example.com']]), extension(0xfe0d, Buffer.alloc(40))]),
    ],
    [
      'an ECH outer extensions list',
      hello([serverNames([[0, 'api.example.com']]), extension(0xfd00, Buffer.alloc(4))]),
    ],
    ['encrypted SNI', hello([serverNames([[0, 'api.example.com']]), extension(0xffce, Buffer.alloc(40))])],
    ['a trailing dot', hello([serverNames([[0, 'api.example.com.']])])],
    ['a NUL inside', hello([serverNames([[0, 'api.example.com\0.evil.test']])])],
    ['an IP literal', hello([serverNames([[0, '93.184.216.34']])])],
    ['an empty name', hello([serverNames([[0, '']])])],
  ])('refuses %s', (_why, handshake) => {
    expect(readClientHello(records(handshake))).toMatchObject({ kind: 'refused' })
  })

  it('refuses what is not a handshake, or not a ClientHello', () => {
    expect(readClientHello(Buffer.from('GET / HTTP/1.1\r\nHost: evil.test\r\n\r\n'))).toMatchObject({
      kind: 'refused',
    })
    const notHello = Buffer.from(ok)
    notHello[0] = 2
    expect(readClientHello(records(notHello))).toMatchObject({ kind: 'refused' })
    expect(readClientHello(Buffer.from([0x17, 3, 3, 0, 5, 1, 2, 3, 4, 5]))).toMatchObject({ kind: 'refused' })
  })

  it('refuses a handshake message after the hello in the same records', () => {
    expect(readClientHello(records(Buffer.concat([ok, Buffer.from([0x14, 0, 0, 0])])))).toMatchObject({
      kind: 'refused',
    })
  })

  it('refuses a declared length past the cap, without waiting for it', () => {
    const huge = Buffer.concat([Buffer.from([1]), u24(1 << 20)])
    expect(readClientHello(records(huge))).toMatchObject({ kind: 'refused', why: 'too big' })
  })

  it('refuses lengths that lie about what follows', () => {
    const lying = Buffer.from(ok)
    // The extensions length, made longer than the body.
    lying.writeUInt16BE(0xffff, ok.length - (ok.length - 4 - 2 - 32 - 1 - 2 - 2 - 2) - 2)
    expect(readClientHello(records(lying))).toMatchObject({ kind: 'refused' })
  })

  it('never throws on random bytes', () => {
    let seed = 1
    const next = () => {
      seed = (seed * 1103515245 + 12345) >>> 0
      return seed >>> 24
    }
    for (let i = 0; i < 5000; i++) {
      const bytes = Buffer.from(ok)
      for (let j = 0; j < 4; j++) bytes[next() % bytes.length] = next()
      expect(() => readClientHello(records(bytes))).not.toThrow()
    }
  })
})
