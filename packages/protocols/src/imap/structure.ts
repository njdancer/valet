// Reading ENVELOPE and BODYSTRUCTURE (RFC 9051 7.5.2) into plain data. The server builds both from
// the sender's headers, so every field is optional and bounded, and a shape that isn't what the
// RFC says is skipped rather than guessed at.

import { decodeHeader, oneLine, truncate, visibleOnly } from './decode'
import { Atom, text, type Value } from './wire'

export interface Address {
  readonly name: string | null
  readonly address: string | null
}

export interface Envelope {
  readonly date: string | null
  readonly subject: string | null
  readonly from: readonly Address[]
  readonly sender: readonly Address[]
  readonly replyTo: readonly Address[]
  readonly to: readonly Address[]
  readonly cc: readonly Address[]
  readonly inReplyTo: string | null
  readonly messageId: string | null
}

const MAX_HEADER_TEXT = 500
const MAX_ADDRESSES = 50

/** One header's text: encoded words decoded, one line, no invisible characters, bounded. */
export function headerText(value: Value | undefined): string | null {
  const raw = text(value)
  if (raw === null) return null
  return truncate(visibleOnly(decodeHeader(raw)), MAX_HEADER_TEXT).text
}

/**
 * Lower case for ASCII letters only. String#toLowerCase folds some non-ASCII letters to ASCII (the
 * Kelvin sign to `k`), which would let a look-alike address compare equal to an approved one.
 */
export function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (c) => c.toLowerCase())
}

function addresses(value: Value | undefined): Address[] {
  if (!Array.isArray(value)) return []
  const out: Address[] = []
  for (const entry of value) {
    if (out.length >= MAX_ADDRESSES) break
    if (!Array.isArray(entry) || entry.length < 4) continue
    const [name, , mailbox, host] = entry
    // A group's start (host NIL) and end (mailbox NIL) are markers, not addresses.
    if (host === null || mailbox === null) continue
    const local = text(mailbox)
    const domain = text(host)
    const address =
      local === null || domain === null ? null : asciiLower(oneLine(`${local}@${domain}`)).slice(0, 320)
    out.push({ name: headerText(name), address })
  }
  return out
}

export function parseEnvelope(value: Value | undefined): Envelope | null {
  if (!Array.isArray(value) || value.length < 10) return null
  const [date, subject, from, sender, replyTo, to, cc, , inReplyTo, messageId] = value
  return {
    date: headerText(date),
    subject: headerText(subject),
    from: addresses(from),
    sender: addresses(sender),
    replyTo: addresses(replyTo),
    to: addresses(to),
    cc: addresses(cc),
    inReplyTo: headerText(inReplyTo),
    messageId: headerText(messageId),
  }
}

export interface Part {
  /** The part's number for BODY.PEEK[...]: `1`, `2.1`. */
  readonly part: string
  /** `type/subtype`, lower case. */
  readonly type: string
  readonly charset: string | null
  readonly encoding: string | null
  /** Encoded size in bytes, as the server reports it. */
  readonly size: number
  readonly filename: string | null
  readonly disposition: 'inline' | 'attachment' | null
}

const MAX_PARTS = 200

function lower(value: Value | undefined): string | null {
  const t = text(value)
  return t === null ? null : t.toLowerCase()
}

/** `(name value name value ...)` as a map, keys lower case. */
function params(value: Value | undefined): Map<string, string> {
  const out = new Map<string, string>()
  if (!Array.isArray(value)) return out
  for (let i = 0; i + 1 < value.length; i += 2) {
    const key = lower(value[i])
    const val = text(value[i + 1])
    if (key !== null && val !== null && !out.has(key)) out.set(key, val)
  }
  return out
}

function disposition(value: Value | undefined): {
  kind: 'inline' | 'attachment' | null
  params: Map<string, string>
} {
  if (!Array.isArray(value)) return { kind: null, params: new Map() }
  const kind = lower(value[0])
  return {
    kind: kind === 'inline' || kind === 'attachment' ? kind : null,
    params: params(value[1]),
  }
}

function number(value: Value | undefined): number {
  return value instanceof Atom && /^\d{1,12}$/.test(value.value) ? Number(value.value) : 0
}

/** RFC 2231 continuations are left to the server; the plain or encoded-word filename is kept. */
function filenameOf(...maps: Map<string, string>[]): string | null {
  for (const map of maps) {
    const name = map.get('filename') ?? map.get('name') ?? map.get('filename*') ?? map.get('name*')
    if (name !== undefined) {
      // RFC 2231's extended form: `utf-8''%E2%82%AC.pdf`.
      const extended = /^([a-z0-9_-]{1,40})'[a-z-]{0,20}'(.*)$/i.exec(name)
      let plain = decodeHeader(name)
      if (extended !== null) {
        try {
          plain = decodeURIComponent(extended[2] as string)
        } catch {
          plain = extended[2] as string
        }
      }
      return truncate(visibleOnly(oneLine(plain)).replace(/[/\\]/g, '_'), 200).text
    }
  }
  return null
}

/**
 * The leaf parts of a BODYSTRUCTURE, depth first. A message/rfc822 part is one leaf (an attached
 * message), not descended into.
 */
export function parseStructure(value: Value | undefined): Part[] {
  const out: Part[] = []
  const walk = (node: Value | undefined, path: string, depth: number): void => {
    if (!Array.isArray(node) || out.length >= MAX_PARTS || depth > 20) return
    if (Array.isArray(node[0])) {
      // Multipart: child parts first, then the subtype and extension data.
      let n = 0
      for (const child of node) {
        if (!Array.isArray(child)) break
        n++
        walk(child, path === '' ? String(n) : `${path}.${n}`, depth + 1)
      }
      return
    }
    const type = lower(node[0]) ?? 'application'
    const subtype = lower(node[1]) ?? 'octet-stream'
    const typeParams = params(node[2])
    const encoding = lower(node[5])
    const size = number(node[6])
    // Extension data starts after the fixed fields: text has a line count, message/rfc822 has an
    // envelope, a body and a line count.
    const isText = type === 'text'
    const isMessage = type === 'message' && subtype === 'rfc822'
    const extensionAt = isText ? 8 : isMessage ? 10 : 7
    const disp = disposition(node[extensionAt + 1])
    out.push({
      part: path === '' ? '1' : path,
      type: `${type}/${subtype}`.slice(0, 100),
      charset: typeParams.get('charset')?.slice(0, 40) ?? null,
      encoding: encoding?.slice(0, 40) ?? null,
      size,
      filename: filenameOf(disp.params, typeParams),
      disposition: disp.kind,
    })
  }
  walk(value, '', 0)
  return out
}

/** The parts read as the message's text: the first plain and the first HTML part that aren't attachments. */
export function bodyParts(parts: readonly Part[]): { plain: Part | null; html: Part | null } {
  const isBody = (p: Part) => p.disposition !== 'attachment' && p.filename === null
  return {
    plain: parts.find((p) => p.type === 'text/plain' && isBody(p)) ?? null,
    html: parts.find((p) => p.type === 'text/html' && isBody(p)) ?? null,
  }
}
