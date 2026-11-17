// SFTP version 3 on the wire (sftp/wire.ts) and the client's checks (sftp/client.ts), against a
// scripted server: what Valet sends, what it accepts back, and how it fails closed.

import { Duplex } from 'node:stream'
import { OPEN_FLAGS, type SftpRoot } from '@valet/core/sftp-policy'
import { describe, expect, it } from 'vitest'
import { checkRequest, SftpClient } from '../src/sftp/client'
import {
  decodeReply,
  decodeVersion,
  encodeInit,
  encodeRequest,
  FX,
  FXP,
  MAX_PACKET,
  PacketReader,
  type SftpRequest,
} from '../src/sftp/wire'

const ROOTS: SftpRoot[] = [
  { path: '/docs', access: 'read' },
  { path: '/inbox', access: 'write' },
  { path: '/scratch', access: 'irreversible' },
]

// --- Building packets as a server would ---------------------------------------------------------

const u32 = (n: number) => {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n >>> 0)
  return b
}
const str = (s: string | Buffer) => {
  const b = typeof s === 'string' ? Buffer.from(s) : s
  return Buffer.concat([u32(b.length), b])
}
const packet = (...parts: Buffer[]) => {
  const body = Buffer.concat(parts)
  return Buffer.concat([u32(body.length), body])
}
const version = (v = 3, ...ext: Buffer[]) => packet(Buffer.from([FXP.VERSION]), u32(v), ...ext)
const status = (id: number, code: number, withMessage = true) =>
  packet(Buffer.from([FXP.STATUS]), u32(id), u32(code), ...(withMessage ? [str('msg'), str('en')] : []))
const name = (id: number, ...names: string[]) =>
  packet(
    Buffer.from([FXP.NAME]),
    u32(id),
    u32(names.length),
    ...names.flatMap((n) => [str(n), str(n), u32(0)]),
  )
const handle = (id: number, h = 'h1') => packet(Buffer.from([FXP.HANDLE]), u32(id), str(h))
const data = (id: number, d: Buffer) => packet(Buffer.from([FXP.DATA]), u32(id), str(d))

/** A duplex whose other end is a script: each request gets the next answer from `answers`. */
function scripted(answers: ((id: number, request: Buffer) => Buffer | Buffer[] | null)[]) {
  const sent: Buffer[] = []
  const reader = new PacketReader()
  let stream: Duplex
  stream = new Duplex({
    read() {},
    write(chunk: Buffer, _enc, done) {
      for (const p of reader.push(chunk)) {
        sent.push(p)
        const id = p[0] === FXP.INIT ? 0 : p.readUInt32BE(1)
        const next = answers.shift()
        const out = next?.(id, p) ?? null
        if (out !== null) for (const b of Array.isArray(out) ? out : [out]) setImmediate(() => stream.push(b))
      }
      done()
    },
  })
  return { stream, sent }
}

async function client(
  answers: Parameters<typeof scripted>[0],
  purpose: 'read' | 'write' | 'irreversible' = 'read',
) {
  const s = scripted([() => version(), ...answers])
  const c = await SftpClient.open(s.stream, { purpose, roots: ROOTS, requestTimeoutMs: 500 })
  c.setResolvedRoots(ROOTS)
  return { c, sent: s.sent }
}

describe('encoding', () => {
  it('writes INIT and each request with its id', () => {
    expect(encodeInit()).toEqual(packet(Buffer.from([FXP.INIT]), u32(3)))
    expect(encodeRequest(7, { type: 'REALPATH', path: '/docs' })).toEqual(
      packet(Buffer.from([FXP.REALPATH]), u32(7), str('/docs')),
    )
    expect(encodeRequest(1, { type: 'OPEN', path: '/a', flags: OPEN_FLAGS.READ })).toEqual(
      packet(Buffer.from([FXP.OPEN]), u32(1), str('/a'), u32(1), u32(0)),
    )
    expect(encodeRequest(2, { type: 'RENAME', from: '/a', to: '/b' })).toEqual(
      packet(Buffer.from([FXP.RENAME]), u32(2), str('/a'), str('/b')),
    )
  })
})

describe('decoding', () => {
  it('reads each reply type', () => {
    const body = (p: Buffer) => p.subarray(4)
    expect(decodeReply(body(status(3, FX.EOF)))).toEqual({ id: 3, reply: { type: 'STATUS', code: FX.EOF } })
    expect(decodeReply(body(status(3, FX.OK, false)))).toEqual({
      id: 3,
      reply: { type: 'STATUS', code: FX.OK },
    })
    expect(decodeReply(body(handle(4))).reply).toEqual({ type: 'HANDLE', handle: Buffer.from('h1') })
    expect(decodeReply(body(name(5, '/docs'))).reply).toMatchObject({
      type: 'NAME',
      names: [{ filename: Buffer.from('/docs') }],
    })
    const attrs = packet(
      Buffer.from([FXP.ATTRS]),
      u32(6),
      u32(0x1 | 0x4 | 0x8),
      Buffer.alloc(8, 0),
      u32(0o100644),
      u32(1),
      u32(1_700_000_000),
    )
    expect(decodeReply(body(attrs)).reply).toEqual({
      type: 'ATTRS',
      attrs: { size: 0, permissions: 0o100644, mtime: 1_700_000_000 },
    })
    expect(decodeVersion(body(version(3, str('posix-rename@openssh.com'), str('1'))))).toBe(3)
  })

  it('fails closed on anything else', () => {
    const body = (p: Buffer) => p.subarray(4)
    const bad = [
      packet(Buffer.from([FXP.STATUS]), u32(1)), // no code
      packet(Buffer.from([99]), u32(1)), // unknown type
      packet(Buffer.from([FXP.HANDLE]), u32(1), str('')), // empty handle
      packet(Buffer.from([FXP.HANDLE]), u32(1), str(Buffer.alloc(257))), // handle too long
      packet(Buffer.from([FXP.DATA]), u32(1), str(Buffer.alloc(32 * 1024 + 1))), // more than a READ asks
      packet(Buffer.from([FXP.NAME]), u32(1), u32(5000)), // too many names
      packet(Buffer.from([FXP.NAME]), u32(1), u32(1), u32(0xffffffff)), // string past the end
      packet(Buffer.from([FXP.ATTRS]), u32(1), u32(0x10)), // attribute flags version 3 doesn't have
      packet(Buffer.from([FXP.ATTRS]), u32(1), u32(0x80000000), u32(1000)), // too many extended pairs
      Buffer.concat([status(1, 0), Buffer.from([1])]).subarray(0), // trailing byte (length counts it below)
    ]
    for (const p of bad.slice(0, -1)) expect(() => decodeReply(body(p))).toThrow()
    expect(() => decodeReply(Buffer.concat([body(status(1, 0)), Buffer.from([1])]))).toThrow()
  })

  it('splits a stream into packets, refusing one past the limit before buffering it', () => {
    const r = new PacketReader()
    const two = Buffer.concat([status(1, 0), status(2, 0)])
    expect(r.push(two.subarray(0, 5))).toEqual([])
    expect(r.push(two.subarray(5))).toHaveLength(2)
    expect(() => new PacketReader().push(u32(MAX_PACKET + 1))).toThrow(/too-large/)
    expect(() => new PacketReader().push(u32(0))).toThrow(/malformed/)
  })
})

describe('the client', () => {
  it('needs version 3', async () => {
    const s = scripted([() => version(6)])
    await expect(SftpClient.open(s.stream, { purpose: 'read', roots: ROOTS })).rejects.toMatchObject({
      failure: 'unsupported',
    })
  })

  it('fails closed on a reply for another request, an unasked one, or the wrong kind', async () => {
    const wrongId = await client([(id) => name(id + 1, '/docs')])
    await expect(wrongId.c.request({ type: 'REALPATH', path: '/docs' })).rejects.toMatchObject({
      failure: 'malformed',
    })
    // The session is over: nothing more is sent.
    await expect(wrongId.c.request({ type: 'REALPATH', path: '/docs' })).rejects.toBeTruthy()
    expect(wrongId.sent).toHaveLength(2)

    const extra = await client([(id) => [name(id, '/docs'), name(id, '/docs')]])
    await extra.c.request({ type: 'REALPATH', path: '/docs' })
    await new Promise((r) => setTimeout(r, 20))
    await expect(extra.c.request({ type: 'REALPATH', path: '/docs' })).rejects.toMatchObject({
      failure: 'malformed',
    })

    const kind = await client([(id) => handle(id)])
    await expect(kind.c.request({ type: 'STAT', path: '/docs' })).rejects.toMatchObject({
      failure: 'malformed',
    })

    const twoNames = await client([(id) => name(id, '/docs', '/inbox')])
    await expect(twoNames.c.request({ type: 'REALPATH', path: '/docs' })).rejects.toMatchObject({
      failure: 'malformed',
    })
  })

  it('times out a server that never answers, and ends the session', async () => {
    const silent = await client([() => null])
    await expect(silent.c.request({ type: 'STAT', path: '/docs' })).rejects.toMatchObject({
      failure: 'timeout',
    })
  })

  it('refuses DATA longer than the READ asked for', async () => {
    const r = await client([(id) => handle(id), (id) => data(id, Buffer.alloc(100))])
    const h = await r.c.request({ type: 'OPEN', path: '/docs/a', flags: OPEN_FLAGS.READ })
    expect(h.type).toBe('HANDLE')
    await expect(
      r.c.request({ type: 'READ', handle: Buffer.from('h1'), offset: 0, length: 10 }),
    ).rejects.toMatchObject({ failure: 'malformed' })
  })

  it('sends a handle only where the server gave it, and for what it was opened for', async () => {
    const r = await client([(id) => handle(id, 'dirh')], 'write')
    await r.c.request({ type: 'OPENDIR', path: '/inbox' })
    await expect(
      r.c.request({ type: 'READ', handle: Buffer.from('dirh'), offset: 0, length: 1 }),
    ).rejects.toMatchObject({
      failure: 'invalid',
    })
    await expect(
      r.c.request({ type: 'WRITE', handle: Buffer.from('dirh'), offset: 0, data: Buffer.from('x') }),
    ).rejects.toMatchObject({
      failure: 'invalid',
    })
    await expect(r.c.request({ type: 'CLOSE', handle: Buffer.from('nope') })).rejects.toMatchObject({
      failure: 'invalid',
    })
    expect(r.sent).toHaveLength(2)
  })
})

describe('checkRequest', () => {
  const none = new Map()
  const check = (request: SftpRequest, purpose: 'read' | 'write' | 'irreversible') =>
    checkRequest(request, purpose, ROOTS, [], none)

  it('holds each request to the session’s purpose', () => {
    expect(check({ type: 'STAT', path: '/docs/a' }, 'read')).toBeNull()
    expect(check({ type: 'MKDIR', path: '/inbox/a' }, 'read')).toBe('not-allowed')
    expect(check({ type: 'MKDIR', path: '/inbox/a' }, 'write')).toBeNull()
    expect(check({ type: 'REMOVE', path: '/scratch/a' }, 'write')).toBe('not-allowed')
    expect(check({ type: 'REMOVE', path: '/scratch/a' }, 'irreversible')).toBeNull()
    expect(
      check(
        { type: 'OPEN', path: '/inbox/a', flags: OPEN_FLAGS.WRITE | OPEN_FLAGS.CREAT | OPEN_FLAGS.TRUNC },
        'write',
      ),
    ).toBe('not-allowed')
    expect(
      check({ type: 'OPEN', path: '/inbox/a', flags: OPEN_FLAGS.WRITE | OPEN_FLAGS.CREAT }, 'irreversible'),
    ).toBe('not-allowed')
  })

  it('holds each path to the roots', () => {
    expect(check({ type: 'STAT', path: '/etc/passwd' }, 'irreversible')).toBe('not-allowed')
    expect(check({ type: 'REALPATH', path: '/docs/../etc' }, 'read')).toBe('not-allowed')
    expect(check({ type: 'MKDIR', path: '/docs/a' }, 'irreversible')).toBe('not-allowed')
    expect(check({ type: 'REMOVE', path: '/inbox/a' }, 'irreversible')).toBe('not-allowed')
    expect(check({ type: 'RMDIR', path: '/scratch' }, 'irreversible')).toBe('not-allowed')
    expect(check({ type: 'RENAME', from: '/inbox/a', to: '/docs/a' }, 'irreversible')).toBe('not-allowed')
    expect(check({ type: 'RENAME', from: '/docs/a', to: '/inbox/a' }, 'irreversible')).toBe('not-allowed')
    expect(check({ type: 'RENAME', from: '/inbox', to: '/scratch/x' }, 'irreversible')).toBe('not-allowed')
    expect(check({ type: 'RENAME', from: '/inbox/a', to: '/scratch/a' }, 'write')).toBeNull()
    expect(
      check({ type: 'OPEN', path: '/inbox', flags: OPEN_FLAGS.WRITE | OPEN_FLAGS.APPEND }, 'write'),
    ).toBe('not-allowed')
  })
})
