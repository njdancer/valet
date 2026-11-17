// Reading what an IMAP server sends (RFC 9051, RFC 3501). The server is untrusted: its mail is
// written by anyone, and the server itself could be hostile. So everything here is bounded (line
// length, literal size, nesting, the size of one response), nothing is evaluated, and anything
// that doesn't parse is an error, never a guess.
//
// A response is one line, which may be continued by literals: `{n}` at the end of a line means n
// raw bytes follow the CRLF, and the line goes on after them. Framing finds where a response ends;
// parsing turns it into values.

/** A bare word: an atom, a number, a flag such as `\Seen`, or a fetch item such as `BODY[1]<0>`. */
export class Atom {
  constructor(readonly value: string) {}
}

/**
 * A parsed value: an atom, a string (quoted or literal, as bytes), NIL (null), or a parenthesised
 * list of values.
 */
export type Value = Atom | Buffer | null | Value[]

export type Status = 'OK' | 'NO' | 'BAD' | 'BYE' | 'PREAUTH'
const STATUSES: readonly string[] = ['OK', 'NO', 'BAD', 'BYE', 'PREAUTH']

export type Response =
  /** `+ text`: the server waits for the rest of a command (a literal's bytes). */
  | { readonly kind: 'continue'; readonly text: string }
  /** `tag OK|NO|BAD [code] text`: a command ended. */
  | {
      readonly kind: 'tagged'
      readonly tag: string
      readonly status: Status
      readonly code: Value[] | null
      readonly text: string
    }
  /** `* OK|NO|BAD|BYE|PREAUTH [code] text`. */
  | {
      readonly kind: 'status'
      readonly status: Status
      readonly code: Value[] | null
      readonly text: string
    }
  /** `* WORD values...` (CAPABILITY, LIST, SEARCH, STATUS, FLAGS...) or `* n WORD values...` (FETCH, EXISTS...). */
  | {
      readonly kind: 'data'
      readonly name: string
      readonly number: number | null
      readonly values: Value[]
    }

export interface WireLimits {
  /** The longest run of a response between literals, in bytes. */
  readonly maxLineBytes: number
  /** The largest single literal. */
  readonly maxLiteralBytes: number
  /** The largest whole response, literals included. */
  readonly maxResponseBytes: number
  /** How deeply lists may nest (BODYSTRUCTURE nests one level per MIME part). */
  readonly maxDepth: number
  /** Values in one response, all lists counted. */
  readonly maxValues: number
}

export const DEFAULT_WIRE_LIMITS: WireLimits = {
  maxLineBytes: 2 * 1024 * 1024,
  maxLiteralBytes: 8 * 1024 * 1024,
  maxResponseBytes: 16 * 1024 * 1024,
  maxDepth: 40,
  maxValues: 500_000,
}

/** The server sent something that isn't IMAP, or is bigger than allowed. */
export class WireError extends Error {
  constructor(readonly reason: 'malformed' | 'too-large') {
    super(`imap: ${reason}`)
  }
}

const CR = 0x0d
const LF = 0x0a

/**
 * Splits the server's byte stream into whole responses. push() adds bytes; take() returns the next
 * whole response's bytes, or null until one has arrived. Throws WireError when a line or literal
 * passes its limit, so a hostile server can't make it buffer without end.
 */
export class Framer {
  private buffer: Buffer = Buffer.alloc(0)
  /** How far into `buffer` the current response is known to be complete. */
  private scanned = 0
  /** Bytes of the current line, since its start or the last literal. */
  private lineStart = 0

  constructor(private readonly limits: WireLimits = DEFAULT_WIRE_LIMITS) {}

  push(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
  }

  /** The bytes of the next whole response, without its final CRLF, or null. */
  take(): Buffer | null {
    for (;;) {
      if (this.scanned > this.limits.maxResponseBytes) throw new WireError('too-large')
      const lf = this.buffer.indexOf(LF, this.scanned)
      if (lf === -1) {
        if (this.buffer.length - this.lineStart > this.limits.maxLineBytes) throw new WireError('too-large')
        this.scanned = this.buffer.length
        return null
      }
      if (lf - this.lineStart > this.limits.maxLineBytes) throw new WireError('too-large')
      const end = lf > 0 && this.buffer[lf - 1] === CR ? lf - 1 : lf
      const literal = literalAt(this.buffer, this.lineStart, end)
      if (literal === null) {
        const response = this.buffer.subarray(0, end)
        this.buffer = this.buffer.subarray(lf + 1)
        this.scanned = 0
        this.lineStart = 0
        return Buffer.from(response)
      }
      if (literal > this.limits.maxLiteralBytes) throw new WireError('too-large')
      const after = lf + 1 + literal
      if (after > this.limits.maxResponseBytes) throw new WireError('too-large')
      if (this.buffer.length < after) {
        // Wait for the literal's bytes; the scan starts at this line again, so its size is read again.
        this.scanned = this.lineStart
        return null
      }
      this.scanned = after
      this.lineStart = after
    }
  }

  /** Bytes held and not yet returned. */
  get pending(): number {
    return this.buffer.length
  }
}

/** The size of the literal a line (from `start` to `end`, CRLF excluded) ends with, or null. */
function literalAt(buffer: Buffer, start: number, end: number): number | null {
  if (end - start < 3 || buffer[end - 1] !== 0x7d /* } */) return null
  let i = end - 2
  if (buffer[i] === 0x2b /* + */ || buffer[i] === 0x2d /* - */) i--
  let digits = 0
  while (i > start && buffer[i] !== undefined && (buffer[i] as number) >= 0x30 && (buffer[i] as number) <= 0x39) {
    i--
    digits++
  }
  if (digits === 0 || digits > 10 || buffer[i] !== 0x7b /* { */) return null
  const text = buffer.toString('latin1', i + 1, i + 1 + digits)
  return Number(text)
}

const SP = 0x20

/** Parses one response's bytes, as the Framer returned them. Throws WireError. */
export function parseResponse(bytes: Buffer, limits: WireLimits = DEFAULT_WIRE_LIMITS): Response {
  const p = new Parser(bytes, limits)
  if (bytes[0] === 0x2b /* + */) {
    return { kind: 'continue', text: p.textFrom(bytes[1] === SP ? 2 : 1) }
  }
  const tag = p.word()
  p.space()
  if (tag !== '*') {
    if (!/^[A-Za-z0-9.]{1,32}$/.test(tag)) throw new WireError('malformed')
    const status = p.word().toUpperCase()
    if (!STATUSES.includes(status)) throw new WireError('malformed')
    const { code, text } = p.statusTail()
    return { kind: 'tagged', tag, status: status as Status, code, text }
  }
  const first = p.word()
  if (/^\d+$/.test(first)) {
    const number = toNumber(first)
    p.space()
    const name = p.word().toUpperCase()
    const values = p.rest()
    return { kind: 'data', name, number, values }
  }
  const upper = first.toUpperCase()
  if (STATUSES.includes(upper)) {
    const { code, text } = p.statusTail()
    return { kind: 'status', status: upper as Status, code, text }
  }
  if (!/^[A-Z][A-Z0-9.-]{0,31}$/.test(upper)) throw new WireError('malformed')
  return { kind: 'data', name: upper, number: null, values: p.rest() }
}

/** A non-negative integer from an atom's text, within 2^53. Throws WireError otherwise. */
export function toNumber(text: string): number {
  if (!/^\d{1,16}$/.test(text)) throw new WireError('malformed')
  const n = Number(text)
  if (!Number.isSafeInteger(n)) throw new WireError('malformed')
  return n
}

/** The longest status text kept. It is the server's words, for diagnostics only. */
const MAX_TEXT = 300

class Parser {
  private i = 0
  private count = 0

  constructor(
    private readonly bytes: Buffer,
    private readonly limits: WireLimits,
  ) {}

  /** Characters up to the next space (or the end). */
  word(): string {
    const start = this.i
    while (this.i < this.bytes.length && this.bytes[this.i] !== SP) this.i++
    if (this.i === start) throw new WireError('malformed')
    return this.bytes.toString('latin1', start, this.i)
  }

  space(): void {
    if (this.bytes[this.i] !== SP) throw new WireError('malformed')
    this.i++
  }

  textFrom(at: number): string {
    return this.bytes
      .toString('utf8', at, Math.min(this.bytes.length, at + MAX_TEXT * 4))
      .replace(/[^\x20-\x7e]/g, '?')
      .slice(0, MAX_TEXT)
  }

  /** After a status word: an optional `[code ...]`, then free text. */
  statusTail(): { code: Value[] | null; text: string } {
    if (this.i >= this.bytes.length) return { code: null, text: '' }
    this.space()
    let code: Value[] | null = null
    if (this.bytes[this.i] === 0x5b /* [ */) {
      this.i++
      code = this.values(0x5d /* ] */, 1)
      this.i++
      if (this.bytes[this.i] === SP) this.i++
    }
    return { code, text: this.textFrom(this.i) }
  }

  /** The rest of the response as values. */
  rest(): Value[] {
    if (this.i >= this.bytes.length) return []
    this.space()
    const values = this.values(null, 0)
    if (this.i !== this.bytes.length) throw new WireError('malformed')
    return values
  }

  /** Values until `close` (a byte) or, with null, the end. Leaves `i` on the close byte. */
  private values(close: number | null, depth: number): Value[] {
    if (depth > this.limits.maxDepth) throw new WireError('too-large')
    const out: Value[] = []
    for (;;) {
      while (this.bytes[this.i] === SP) this.i++
      if (this.i >= this.bytes.length) {
        if (close === null) return out
        throw new WireError('malformed')
      }
      const b = this.bytes[this.i] as number
      if (b === close) return out
      if (++this.count > this.limits.maxValues) throw new WireError('too-large')
      out.push(this.value(b, depth))
    }
  }

  private value(b: number, depth: number): Value {
    if (b === 0x28 /* ( */) {
      this.i++
      const list = this.values(0x29 /* ) */, depth + 1)
      this.i++
      return list
    }
    if (b === 0x22 /* " */) return this.quoted()
    if (b === 0x7b /* { */ || (b === 0x7e /* ~ */ && this.bytes[this.i + 1] === 0x7b)) return this.literal()
    if (b === 0x29 || b === 0x5d) throw new WireError('malformed')
    const atom = this.atom()
    return atom.toUpperCase() === 'NIL' ? null : new Atom(atom)
  }

  private quoted(): Buffer {
    this.i++
    const parts: number[] = []
    for (;;) {
      const b = this.bytes[this.i]
      if (b === undefined || b === CR || b === LF) throw new WireError('malformed')
      this.i++
      if (b === 0x22) return Buffer.from(parts)
      if (b === 0x5c /* \ */) {
        const next = this.bytes[this.i]
        if (next !== 0x22 && next !== 0x5c) throw new WireError('malformed')
        parts.push(next)
        this.i++
      } else parts.push(b)
    }
  }

  private literal(): Buffer {
    if (this.bytes[this.i] === 0x7e) this.i++
    const close = this.bytes.indexOf(0x7d, this.i)
    if (close === -1 || close - this.i > 12) throw new WireError('malformed')
    const size = toNumber(this.bytes.toString('latin1', this.i + 1, close).replace(/[+-]$/, ''))
    let at = close + 1
    if (this.bytes[at] === CR) at++
    if (this.bytes[at] !== LF) throw new WireError('malformed')
    at++
    if (size > this.limits.maxLiteralBytes || at + size > this.bytes.length) throw new WireError('malformed')
    this.i = at + size
    return Buffer.from(this.bytes.subarray(at, at + size))
  }

  /**
   * An atom. A `[` inside one (a fetch item such as `BODY[HEADER.FIELDS (FROM)]`) runs to its `]`,
   * spaces and all, and may be followed by `<origin>`.
   */
  private atom(): string {
    const start = this.i
    for (;;) {
      const b = this.bytes[this.i]
      if (b === undefined || b === SP || b === 0x28 || b === 0x29 || b === 0x5d || b === 0x22 || b < 0x20 || b === 0x7f)
        break
      if (b === 0x7b) break
      if (b === 0x5b /* [ */) {
        const close = this.bytes.indexOf(0x5d, this.i)
        if (close === -1) throw new WireError('malformed')
        this.i = close + 1
        if (this.bytes[this.i] === 0x3c /* < */) {
          const gt = this.bytes.indexOf(0x3e, this.i)
          if (gt === -1 || gt - this.i > 24) throw new WireError('malformed')
          this.i = gt + 1
        }
        continue
      }
      this.i++
    }
    if (this.i === start) throw new WireError('malformed')
    return this.bytes.toString('latin1', start, this.i)
  }
}

/** A value as text: an atom's word or a string's bytes as UTF-8. Null for NIL or a list. */
export function text(value: Value | undefined): string | null {
  if (value instanceof Atom) return value.value
  if (Buffer.isBuffer(value)) return value.toString('utf8')
  return null
}

/** A value as a number, or WireError. */
export function number(value: Value | undefined): number {
  if (!(value instanceof Atom)) throw new WireError('malformed')
  return toNumber(value.value)
}

export function list(value: Value | undefined): Value[] {
  if (!Array.isArray(value)) throw new WireError('malformed')
  return value
}
