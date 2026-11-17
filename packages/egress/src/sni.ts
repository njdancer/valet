// Reading the server name out of a TLS ClientHello, for a tunnelled connection whose bytes the broker
// never decrypts (docs/adapter-kinds.md#f1-the-egress-broker). One CDN address can serve many
// sites, so an allowed host:port alone doesn't say whose service a connection reaches; the name the
// client asks for does. The broker refuses unless that name is exactly the endpoint's host.
//
// It fails closed on anything it can't read plainly: a record that isn't a handshake, a hello split
// oddly or too big, more or fewer than one host name, and any Encrypted Client Hello, whose outer
// name could be the allowed host while the inner one, which the CDN obeys, names another.

import { isHostname } from '@valet/core'

/** The longest ClientHello the broker waits for, across records. Real ones are a few kilobytes. */
export const MAX_CLIENT_HELLO_BYTES = 64 * 1024

const RECORD_HANDSHAKE = 0x16
const HANDSHAKE_CLIENT_HELLO = 0x01
const EXT_SERVER_NAME = 0x0000
/** Encrypted Client Hello (RFC draft, deployed) and its predecessor, encrypted SNI. */
const EXT_ECH = 0xfe0d
const EXT_ESNI = 0xffce
const EXT_ECH_OUTER = 0xfd00

export type ClientHelloRead =
  /** More bytes are needed. */
  | { readonly kind: 'incomplete' }
  /** A plain ClientHello naming exactly one host, lower-cased. */
  | { readonly kind: 'hello'; readonly serverName: string }
  /** Not something the broker lets through, and why (for tests; never shown to an adapter). */
  | { readonly kind: 'refused'; readonly why: string }

const refused = (why: string): ClientHelloRead => ({ kind: 'refused', why })

/**
 * Reads the ClientHello at the start of `bytes`, everything the client has sent so far. Handshake
 * messages may span several records; the records are joined before the hello is read.
 */
export function readClientHello(bytes: Buffer): ClientHelloRead {
  const handshake: Buffer[] = []
  let handshakeLength = 0
  let offset = 0
  let needed: number | null = null
  while (true) {
    if (bytes.length - offset < 5)
      return bytes.length > MAX_CLIENT_HELLO_BYTES ? refused('too big') : incomplete()
    if (bytes[offset] !== RECORD_HANDSHAKE) return refused('not a handshake record')
    if (bytes[offset + 1] !== 0x03) return refused('not TLS')
    const length = bytes.readUInt16BE(offset + 3)
    if (length === 0 || length > 16_384 + 256) return refused('bad record length')
    if (bytes.length - offset - 5 < length) {
      return offset + 5 + length > MAX_CLIENT_HELLO_BYTES ? refused('too big') : incomplete()
    }
    handshake.push(bytes.subarray(offset + 5, offset + 5 + length))
    handshakeLength += length
    offset += 5 + length
    const joined = Buffer.concat(handshake, handshakeLength)
    if (needed === null && joined.length >= 4) {
      if (joined[0] !== HANDSHAKE_CLIENT_HELLO) return refused('not a ClientHello')
      needed = 4 + joined.readUIntBE(1, 3)
      if (needed > MAX_CLIENT_HELLO_BYTES) return refused('too big')
    }
    if (needed !== null && joined.length >= needed) {
      // Bytes past the hello in the same records would be another handshake message: not ours.
      if (joined.length !== needed) return refused('trailing handshake bytes')
      return parseHello(joined.subarray(4, needed))
    }
  }
}

function incomplete(): ClientHelloRead {
  return { kind: 'incomplete' }
}

/** A bounds-checked reader: each method throws RangeError past the end, which parseHello turns into a refusal. */
class Reader {
  private at = 0
  constructor(private readonly buffer: Buffer) {}
  get left(): number {
    return this.buffer.length - this.at
  }
  skip(n: number): void {
    if (n > this.left) throw new RangeError('short')
    this.at += n
  }
  u8(): number {
    if (this.left < 1) throw new RangeError('short')
    return this.buffer[this.at++] as number
  }
  u16(): number {
    if (this.left < 2) throw new RangeError('short')
    const v = this.buffer.readUInt16BE(this.at)
    this.at += 2
    return v
  }
  take(n: number): Buffer {
    if (n > this.left) throw new RangeError('short')
    const out = this.buffer.subarray(this.at, this.at + n)
    this.at += n
    return out
  }
}

function parseHello(body: Buffer): ClientHelloRead {
  try {
    const r = new Reader(body)
    r.skip(2 + 32) // legacy_version, random
    r.skip(r.u8()) // legacy_session_id
    r.skip(r.u16()) // cipher_suites
    r.skip(r.u8()) // legacy_compression_methods
    if (r.left === 0) return refused('no extensions')
    const extensions = new Reader(r.take(r.u16()))
    if (r.left !== 0) return refused('bytes after the extensions')
    const seen = new Set<number>()
    let serverName: string | null = null
    while (extensions.left > 0) {
      const type = extensions.u16()
      const data = extensions.take(extensions.u16())
      if (seen.has(type)) return refused('a repeated extension')
      seen.add(type)
      if (type === EXT_ECH || type === EXT_ESNI || type === EXT_ECH_OUTER)
        return refused('encrypted client hello')
      if (type !== EXT_SERVER_NAME) continue
      const list = new Reader(data)
      const names = new Reader(list.take(list.u16()))
      if (list.left !== 0) return refused('bytes after the server name list')
      const found: string[] = []
      while (names.left > 0) {
        const nameType = names.u8()
        const name = names.take(names.u16())
        if (nameType !== 0) return refused('a server name that is not a host name')
        found.push(name.toString('latin1'))
      }
      if (found.length !== 1) return refused('not exactly one server name')
      serverName = found[0] as string
    }
    if (serverName === null) return refused('no server name')
    // A DNS name in ASCII; no trailing dot, NUL or anything a comparison could be fooled by.
    if (!isHostname(serverName)) return refused('a server name that is not a plain DNS name')
    return { kind: 'hello', serverName: serverName.toLowerCase() }
  } catch {
    return refused('malformed')
  }
}
