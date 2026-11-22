// The blind relay's wire format (docs/blind-relay.md). The relay accepts TLS connections on port 443,
// reads only the server name from each connection's first message, and passes the encrypted bytes,
// untouched, down a WebSocket that the named Mac keeps open to it. TLS ends on the Mac, so nobody
// running the relay can read a request, a tool call, a result or an approval.
//
// The WebSocket carries two kinds of message:
//
// - Text: JSON control frames. The relay's challenge and the Mac's hello are the Worker relay's
//   (relayChallengeSchema, relayHelloSchema, signed with the transport key and the Touch ID binding),
//   then `ready`, then nothing but `ping` and `pong`.
// - Binary: stream frames, `kind (u8) | stream (u32, big endian) | payload`. Only the relay opens
//   streams, one per incoming connection. Each side may send at most TUNNEL_WINDOW bytes on a stream
//   before the other grants more with `credit`, so a slow reader holds back only its own stream.
//
// This file is pure: the parser for TLS's first message and the frame codec. The streams themselves
// are in tunnel-mux.ts.

import { createHash } from 'node:crypto'
import { z } from 'zod'
import { keyIdSchema } from './devices'

export const TUNNEL_PROTOCOL_VERSION = 1

/** Where a Mac dials the relay: wss://<control host>/v1/tunnel/<macId>. */
export const TUNNEL_PATH_PREFIX = '/v1/tunnel/'

export const TUNNEL_FRAME = {
  /** Relay to Mac: a new connection. Payload: JSON `{"source": "<ip>"}` (tunnelOpenSchema). */
  open: 1,
  /** Either way: bytes of the connection, at most TUNNEL_LIMITS.maxDataBytes. */
  data: 2,
  /** Either way: no more bytes from this side (a TCP FIN). The other side may still send. */
  end: 3,
  /** Either way: the stream is gone, both directions, now. No payload. */
  reset: 4,
  /** Either way: the sender may now send this many more bytes (u32 big endian). */
  credit: 5,
} as const
export type TunnelFrameKind = (typeof TUNNEL_FRAME)[keyof typeof TUNNEL_FRAME]

export const TUNNEL_LIMITS = {
  /** Bytes in one data frame. A TLS record is at most ~16.6 KB, so a record or two per frame. */
  maxDataBytes: 32 * 1024,
  /** What each side may send on a stream before it hears `credit`. */
  window: 256 * 1024,
  /** The most a ClientHello may take before the relay gives up on the connection. */
  maxClientHelloBytes: 16 * 1024,
  /** How long a new connection has to send its ClientHello. */
  clientHelloTimeoutMs: 10_000,
  /** Connections open at once to one Mac. */
  maxStreamsPerMac: 128,
  /** Stream ids are u32 and never reused on one WebSocket. */
  maxStreamId: 0xffff_ffff,
} as const

const HEADER_BYTES = 5

export type TunnelFrame =
  | { readonly kind: 1; readonly stream: number; readonly open: TunnelOpen }
  | { readonly kind: 2; readonly stream: number; readonly data: Buffer }
  | { readonly kind: 3 | 4; readonly stream: number }
  | { readonly kind: 5; readonly stream: number; readonly credit: number }

export const tunnelOpenSchema = z
  .object({
    /** The caller's address as the relay saw it, or '' when it doesn't say. Metadata only. */
    source: z.string().max(64),
  })
  .strict()
export type TunnelOpen = z.infer<typeof tunnelOpenSchema>

export function encodeTunnelFrame(frame: TunnelFrame): Buffer {
  let payload: Buffer
  switch (frame.kind) {
    case TUNNEL_FRAME.open:
      payload = Buffer.from(JSON.stringify(frame.open), 'utf8')
      break
    case TUNNEL_FRAME.data:
      if (frame.data.length > TUNNEL_LIMITS.maxDataBytes) throw new RangeError('data frame too large')
      payload = frame.data
      break
    case TUNNEL_FRAME.credit:
      payload = Buffer.alloc(4)
      payload.writeUInt32BE(frame.credit)
      break
    default:
      payload = Buffer.alloc(0)
  }
  const out = Buffer.allocUnsafe(HEADER_BYTES + payload.length)
  out.writeUInt8(frame.kind, 0)
  out.writeUInt32BE(frame.stream, 1)
  payload.copy(out, HEADER_BYTES)
  return out
}

/** The frame, or null for anything malformed: the receiver then drops the WebSocket. */
export function decodeTunnelFrame(bytes: Uint8Array): TunnelFrame | null {
  if (bytes.length < HEADER_BYTES) return null
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const kind = buf.readUInt8(0)
  const stream = buf.readUInt32BE(1)
  const payload = buf.subarray(HEADER_BYTES)
  switch (kind) {
    case TUNNEL_FRAME.open: {
      if (payload.length > 256) return null
      try {
        const parsed = tunnelOpenSchema.safeParse(JSON.parse(payload.toString('utf8')))
        return parsed.success ? { kind, stream, open: parsed.data } : null
      } catch {
        return null
      }
    }
    case TUNNEL_FRAME.data:
      if (payload.length === 0 || payload.length > TUNNEL_LIMITS.maxDataBytes) return null
      return { kind, stream, data: Buffer.from(payload) }
    case TUNNEL_FRAME.end:
    case TUNNEL_FRAME.reset:
      return payload.length === 0 ? { kind, stream } : null
    case TUNNEL_FRAME.credit: {
      if (payload.length !== 4) return null
      const credit = payload.readUInt32BE(0)
      return credit === 0 ? null : { kind, stream, credit }
    }
    default:
      return null
  }
}

/** After the hello is checked: the Mac's public name, which the relay now routes to it. */
export const tunnelReadySchema = z
  .object({
    type: z.literal('ready'),
    v: z.literal(TUNNEL_PROTOCOL_VERSION),
    host: z.string().max(253),
  })
  .strict()
export type TunnelReady = z.infer<typeof tunnelReadySchema>

/**
 * A Mac's public name: its macId (the approval key's id, so the relay can check it without a
 * registry) as one label under the relay's Mac domain. With a tag, one of its other names:
 * tunnelAlias(macId, tag) as the label, a name that doesn't contain the macId at all. claude.ai's
 * backend stopped dialling every name containing one Mac's id on 2026-11-22 (other names on the
 * same relay and address got through), so agents can be given a name free of it.
 */
export function tunnelHost(macId: string, macDomain: string, tag?: string): string {
  const label = tag === undefined ? macId : tunnelAlias(macId, tag)
  return `${label}.${macDomain.toLowerCase().replace(/\.$/, '')}`
}

/** The tags a Mac's other names can have. The relay maps each back for every Mac it has seen. */
export const TUNNEL_TAGS = ['2', '3', '4', '5', '6', '7', '8', '9'] as const
export const TUNNEL_TAG = /^[2-9]$/

/** A Mac's other name's label: 24 hex digits from the macId and tag, never the macId itself. */
export function tunnelAlias(macId: string, tag: string): string {
  return createHash('sha256').update(`valet-tunnel-alias\0${macId}\0${tag}`).digest('hex').slice(0, 24)
}

/** The one label a server name has under the Mac domain, lowercased, or null. */
export function tunnelLabel(serverName: string, macDomain: string): string | null {
  const name = serverName.toLowerCase().replace(/\.$/, '')
  const suffix = `.${macDomain.toLowerCase().replace(/\.$/, '')}`
  if (!name.endsWith(suffix)) return null
  const label = name.slice(0, -suffix.length)
  return /^[a-z0-9-]{1,63}$/.test(label) ? label : null
}

/** The macId a server name routes to, or null when it is not exactly `<macId>.<macDomain>`. */
export function macIdForHost(serverName: string, macDomain: string): string | null {
  const label = tunnelLabel(serverName, macDomain)
  return label !== null && keyIdSchema.safeParse(label).success ? label : null
}

// ---------------------------------------------------------------------------------------------
// TLS's first message. RFC 8446 section 4.1.2, RFC 6066 section 3 (server_name), RFC 7301 (ALPN).

export type ClientHelloResult =
  /** Not all of it yet: read more and try again with everything so far. */
  | { readonly state: 'partial' }
  /** Not a TLS ClientHello, or broken. */
  | { readonly state: 'invalid' }
  | {
      readonly state: 'complete'
      /** The host_name the client asked for, lower case, or null when it sent none. */
      readonly serverName: string | null
      /** The ALPN protocols it offered, in its order; empty when it offered none. */
      readonly alpn: readonly string[]
    }

const RECORD_HANDSHAKE = 22
const HANDSHAKE_CLIENT_HELLO = 1
const EXT_SERVER_NAME = 0
const EXT_ALPN = 16

/**
 * Reads the ClientHello at the start of `bytes`, which may span several TLS records. Only reads:
 * the caller passes the same bytes on untouched.
 */
export function parseClientHello(bytes: Buffer): ClientHelloResult {
  // Gather the handshake bytes from consecutive handshake records.
  const parts: Buffer[] = []
  let offset = 0
  let gathered = 0
  let needed: number | null = null
  while (needed === null || gathered < needed) {
    if (bytes.length < offset + 5) return { state: 'partial' }
    if (bytes[offset] !== RECORD_HANDSHAKE) return { state: 'invalid' }
    // Record versions are 0x0301..0x0303; anything else isn't TLS.
    if (bytes[offset + 1] !== 3 || (bytes[offset + 2] as number) > 4) return { state: 'invalid' }
    const length = bytes.readUInt16BE(offset + 3)
    if (length === 0 || length > 16_384 + 256) return { state: 'invalid' }
    if (bytes.length < offset + 5 + length) {
      // Not a hello at all shows in its first byte: no need to wait for the rest.
      if (gathered === 0 && bytes.length > offset + 5 && bytes[offset + 5] !== HANDSHAKE_CLIENT_HELLO)
        return { state: 'invalid' }
      return { state: 'partial' }
    }
    parts.push(bytes.subarray(offset + 5, offset + 5 + length))
    gathered += length
    offset += 5 + length
    if (needed === null) {
      const first = Buffer.concat(parts)
      if (first.length < 4) continue
      if (first[0] !== HANDSHAKE_CLIENT_HELLO) return { state: 'invalid' }
      needed = 4 + first.readUIntBE(1, 3)
      if (needed > 64 * 1024) return { state: 'invalid' }
    }
    if (offset > 64 * 1024) return { state: 'invalid' }
  }
  const hello = Buffer.concat(parts).subarray(4, needed)
  try {
    return readHello(hello)
  } catch {
    return { state: 'invalid' }
  }
}

function readHello(hello: Buffer): ClientHelloResult {
  let at = 0
  const need = (n: number) => {
    if (at + n > hello.length) throw new RangeError('short')
  }
  const u8 = () => {
    need(1)
    return hello.readUInt8(at++)
  }
  const u16 = () => {
    need(2)
    const v = hello.readUInt16BE(at)
    at += 2
    return v
  }
  const skip = (n: number) => {
    need(n)
    at += n
  }
  skip(2) // legacy_version
  skip(32) // random
  skip(u8()) // legacy_session_id
  const suites = u16()
  if (suites === 0 || suites % 2 !== 0) return { state: 'invalid' }
  skip(suites)
  const compression = u8()
  if (compression === 0) return { state: 'invalid' }
  skip(compression)
  let serverName: string | null = null
  let alpn: string[] = []
  if (at === hello.length) return { state: 'complete', serverName, alpn }
  const extensionsLength = u16()
  const extensionsEnd = at + extensionsLength
  if (extensionsEnd !== hello.length) return { state: 'invalid' }
  const seen = new Set<number>()
  while (at < extensionsEnd) {
    const type = u16()
    const length = u16()
    need(length)
    const end = at + length
    // A repeated extension is a malformed hello (RFC 8446 section 4.2).
    if (seen.has(type)) return { state: 'invalid' }
    seen.add(type)
    if (type === EXT_SERVER_NAME) {
      const listLength = u16()
      const listEnd = at + listLength
      if (listEnd !== end) return { state: 'invalid' }
      while (at < listEnd) {
        const nameType = u8()
        const nameLength = u16()
        need(nameLength)
        const name = hello.subarray(at, at + nameLength)
        at += nameLength
        if (nameType !== 0) continue
        if (serverName !== null) return { state: 'invalid' }
        const text = name.toString('latin1')
        if (!/^[A-Za-z0-9.-]{1,253}$/.test(text)) return { state: 'invalid' }
        serverName = text.toLowerCase()
      }
    } else if (type === EXT_ALPN) {
      const listLength = u16()
      const listEnd = at + listLength
      if (listEnd !== end) return { state: 'invalid' }
      const offered: string[] = []
      while (at < listEnd) {
        const n = u8()
        if (n === 0) return { state: 'invalid' }
        need(n)
        offered.push(hello.subarray(at, at + n).toString('latin1'))
        at += n
      }
      alpn = offered
    }
    at = end
  }
  return { state: 'complete', serverName, alpn }
}
