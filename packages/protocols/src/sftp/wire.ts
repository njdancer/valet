// SFTP version 3 on the wire (draft-ietf-secsh-filexfer-02), as Valet's own client speaks it: the
// requests it sends, built from structured data, and a reader for the server's replies with hard
// limits. Everything the server sends is untrusted: a reply that doesn't parse exactly ends the
// session (SftpError 'malformed'), and nothing is ever guessed.

import type { SftpPacket } from '@valet/core/sftp-policy'

export const FXP = {
  INIT: 1,
  VERSION: 2,
  OPEN: 3,
  CLOSE: 4,
  READ: 5,
  WRITE: 6,
  LSTAT: 7,
  OPENDIR: 11,
  READDIR: 12,
  REMOVE: 13,
  MKDIR: 14,
  RMDIR: 15,
  REALPATH: 16,
  STAT: 17,
  RENAME: 18,
  STATUS: 101,
  HANDLE: 102,
  DATA: 103,
  NAME: 104,
  ATTRS: 105,
} as const

export const FX = {
  OK: 0,
  EOF: 1,
  NO_SUCH_FILE: 2,
  PERMISSION_DENIED: 3,
  FAILURE: 4,
  BAD_MESSAGE: 5,
  NO_CONNECTION: 6,
  CONNECTION_LOST: 7,
  OP_UNSUPPORTED: 8,
} as const

const ATTR = { SIZE: 0x1, UIDGID: 0x2, PERMISSIONS: 0x4, ACMODTIME: 0x8, EXTENDED: 0x80000000 } as const

/** The largest packet Valet reads: OpenSSH's own limit. */
export const MAX_PACKET = 256 * 1024
/** The most one READ asks for; DATA may not be longer. */
export const MAX_READ_CHUNK = 32 * 1024
/** The most one WRITE carries. */
export const MAX_WRITE_CHUNK = 32 * 1024
/** A handle is at most 256 bytes (the draft's own limit). */
export const MAX_HANDLE = 256
/** Names in one NAME reply. */
export const MAX_NAMES_PER_REPLY = 4096
/** Extended attribute pairs in one ATTRS. */
const MAX_EXTENDED_ATTRS = 64

export type SftpFailure =
  /** The session's purpose or the roots don't allow it: nothing was sent. */
  | 'not-allowed'
  | 'invalid'
  | 'auth'
  /** The server offered a host key other than the pinned one. */
  | 'host-key'
  | 'unsupported'
  | 'timeout'
  /** The server said no; `code` says why. */
  | 'no'
  | 'too-large'
  | 'malformed'
  | 'closed'

/** Why the server said no, in the protocol host's vocabulary (host-session.ts hostError). */
export type SftpNoCode = 'NONEXISTENT' | 'ALREADYEXISTS' | 'DENIED' | 'NOTEMPTY' | 'FAILURE' | 'UNSUPPORTED'

export class SftpError extends Error {
  constructor(
    readonly failure: SftpFailure,
    readonly code: SftpNoCode | null = null,
  ) {
    super(code === null ? `sftp: ${failure}` : `sftp: ${failure} (${code})`)
    this.name = 'SftpError'
  }
}

/** A request, as structured data. Paths are strings Valet checked; handles are the server's own. */
export type SftpRequest =
  | { readonly type: 'OPEN'; readonly path: string; readonly flags: number }
  | { readonly type: 'CLOSE'; readonly handle: Buffer }
  | { readonly type: 'READ'; readonly handle: Buffer; readonly offset: number; readonly length: number }
  | { readonly type: 'WRITE'; readonly handle: Buffer; readonly offset: number; readonly data: Buffer }
  | { readonly type: 'READDIR'; readonly handle: Buffer }
  | {
      readonly type: 'LSTAT' | 'STAT' | 'OPENDIR' | 'REMOVE' | 'RMDIR' | 'REALPATH' | 'MKDIR'
      readonly path: string
    }
  | { readonly type: 'RENAME'; readonly from: string; readonly to: string }

// Every request type is one of the policy table's packets: a type the table doesn't list can't be
// written down here, and checkRequest (client.ts) holds each to the session's purpose.
type _Covered = SftpRequest['type'] extends SftpPacket ? true : never
const _covered: _Covered = true
void _covered

export interface SftpAttrs {
  readonly size: number | null
  readonly permissions: number | null
  readonly mtime: number | null
}

export interface SftpName {
  /** The raw bytes of the name: the client decides whether Valet can address it. */
  readonly filename: Buffer
  readonly attrs: SftpAttrs
}

export type SftpReply =
  | { readonly type: 'STATUS'; readonly code: number }
  | { readonly type: 'HANDLE'; readonly handle: Buffer }
  | { readonly type: 'DATA'; readonly data: Buffer }
  | { readonly type: 'NAME'; readonly names: readonly SftpName[] }
  | { readonly type: 'ATTRS'; readonly attrs: SftpAttrs }

// --- Writing ---------------------------------------------------------------------------------------

class Writer {
  private readonly parts: Buffer[] = []
  byte(n: number): this {
    this.parts.push(Buffer.from([n]))
    return this
  }
  u32(n: number): this {
    const b = Buffer.alloc(4)
    b.writeUInt32BE(n >>> 0)
    this.parts.push(b)
    return this
  }
  u64(n: number): this {
    const b = Buffer.alloc(8)
    b.writeBigUInt64BE(BigInt(n))
    this.parts.push(b)
    return this
  }
  string(value: Buffer | string): this {
    const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value
    this.u32(bytes.length)
    this.parts.push(bytes)
    return this
  }
  packet(): Buffer {
    const body = Buffer.concat(this.parts)
    const length = Buffer.alloc(4)
    length.writeUInt32BE(body.length)
    return Buffer.concat([length, body])
  }
}

/** INIT, asking for version 3. */
export function encodeInit(): Buffer {
  return new Writer().byte(FXP.INIT).u32(3).packet()
}

/** One request with its id. The caller has checked it (client.ts checkRequest). */
export function encodeRequest(id: number, request: SftpRequest): Buffer {
  const w = new Writer().byte(FXP[request.type]).u32(id)
  switch (request.type) {
    case 'OPEN':
      // No attributes: the server's own defaults (its umask) for a new file.
      return w.string(request.path).u32(request.flags).u32(0).packet()
    case 'CLOSE':
    case 'READDIR':
      return w.string(request.handle).packet()
    case 'READ':
      return w.string(request.handle).u64(request.offset).u32(request.length).packet()
    case 'WRITE':
      return w.string(request.handle).u64(request.offset).string(request.data).packet()
    case 'MKDIR':
      return w.string(request.path).u32(0).packet()
    case 'RENAME':
      return w.string(request.from).string(request.to).packet()
    default:
      return w.string(request.path).packet()
  }
}

// --- Reading ---------------------------------------------------------------------------------------

class Reader {
  private at = 0
  constructor(private readonly b: Buffer) {}
  byte(): number {
    if (this.at + 1 > this.b.length) throw new SftpError('malformed')
    return this.b[this.at++] as number
  }
  u32(): number {
    if (this.at + 4 > this.b.length) throw new SftpError('malformed')
    const v = this.b.readUInt32BE(this.at)
    this.at += 4
    return v
  }
  u64(): number {
    if (this.at + 8 > this.b.length) throw new SftpError('malformed')
    const v = this.b.readBigUInt64BE(this.at)
    this.at += 8
    // A size past 2^53 can't be a real file Valet would read; it is reported as unknown.
    return v > BigInt(Number.MAX_SAFE_INTEGER) ? -1 : Number(v)
  }
  string(max = MAX_PACKET): Buffer {
    const n = this.u32()
    if (n > max || this.at + n > this.b.length) throw new SftpError('malformed')
    const v = this.b.subarray(this.at, this.at + n)
    this.at += n
    return v
  }
  get left(): number {
    return this.b.length - this.at
  }
  done(): void {
    if (this.left !== 0) throw new SftpError('malformed')
  }
}

function readAttrs(r: Reader): SftpAttrs {
  const flags = r.u32()
  // Only the flags version 3 defines; anything else means the server speaks something else.
  if ((flags & ~(ATTR.SIZE | ATTR.UIDGID | ATTR.PERMISSIONS | ATTR.ACMODTIME | ATTR.EXTENDED)) !== 0)
    throw new SftpError('malformed')
  let size: number | null = null
  let permissions: number | null = null
  let mtime: number | null = null
  if (flags & ATTR.SIZE) {
    const s = r.u64()
    size = s < 0 ? null : s
  }
  if (flags & ATTR.UIDGID) {
    r.u32()
    r.u32()
  }
  if (flags & ATTR.PERMISSIONS) permissions = r.u32()
  if (flags & ATTR.ACMODTIME) {
    r.u32()
    mtime = r.u32()
  }
  if (flags & ATTR.EXTENDED) {
    const count = r.u32()
    if (count > MAX_EXTENDED_ATTRS) throw new SftpError('malformed')
    for (let i = 0; i < count; i++) {
      r.string(4096)
      r.string(4096)
    }
  }
  return { size, permissions, mtime }
}

/** VERSION's version number. Extensions the server lists are read and ignored: Valet uses none. */
export function decodeVersion(packet: Buffer): number {
  const r = new Reader(packet)
  if (r.byte() !== FXP.VERSION) throw new SftpError('malformed')
  const version = r.u32()
  for (let pairs = 0; r.left > 0; pairs++) {
    if (pairs >= 64) throw new SftpError('malformed')
    r.string(4096)
    r.string(4096)
  }
  return version
}

/** One reply: its id and what it says. */
export function decodeReply(packet: Buffer): { readonly id: number; readonly reply: SftpReply } {
  const r = new Reader(packet)
  const type = r.byte()
  const id = r.u32()
  let reply: SftpReply
  switch (type) {
    case FXP.STATUS: {
      const code = r.u32()
      // The message and language tag are optional in practice (some servers send neither); they are
      // the server's words, so Valet never shows them.
      if (r.left > 0) {
        r.string(4096)
        r.string(256)
      }
      reply = { type: 'STATUS', code }
      break
    }
    case FXP.HANDLE: {
      const handle = Buffer.from(r.string(MAX_HANDLE))
      if (handle.length === 0) throw new SftpError('malformed')
      reply = { type: 'HANDLE', handle }
      break
    }
    case FXP.DATA:
      reply = { type: 'DATA', data: Buffer.from(r.string(MAX_READ_CHUNK)) }
      break
    case FXP.NAME: {
      const count = r.u32()
      if (count > MAX_NAMES_PER_REPLY) throw new SftpError('malformed')
      const names: SftpName[] = []
      for (let i = 0; i < count; i++) {
        const filename = Buffer.from(r.string(4096))
        r.string(8192) // longname: ls -l text, the server's own words; never used
        names.push({ filename, attrs: readAttrs(r) })
      }
      reply = { type: 'NAME', names }
      break
    }
    case FXP.ATTRS:
      reply = { type: 'ATTRS', attrs: readAttrs(r) }
      break
    default:
      throw new SftpError('malformed')
  }
  r.done()
  return { id, reply }
}

/**
 * Splits a byte stream into packets. Throws 'too-large' for a packet past MAX_PACKET, before
 * buffering it, and 'malformed' for an empty one.
 */
export class PacketReader {
  private buffered: Buffer[] = []
  private size = 0

  push(chunk: Buffer): Buffer[] {
    this.buffered.push(chunk)
    this.size += chunk.length
    const out: Buffer[] = []
    while (this.size >= 4) {
      const all = this.buffered.length === 1 ? (this.buffered[0] as Buffer) : Buffer.concat(this.buffered)
      this.buffered = [all]
      const length = all.readUInt32BE(0)
      if (length === 0) throw new SftpError('malformed')
      if (length > MAX_PACKET) throw new SftpError('too-large')
      if (all.length < 4 + length) break
      out.push(Buffer.from(all.subarray(4, 4 + length)))
      const rest = all.subarray(4 + length)
      this.buffered = rest.length === 0 ? [] : [rest]
      this.size = rest.length
    }
    return out
  }
}
