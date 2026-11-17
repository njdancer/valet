// Output redaction. Before a tool result leaves the process, any string that contains a session
// value (a cookie, or a handed-off storage value) or a secret resolved during the call is replaced
// whole. Session values match as they are. A secret also matches in its common encodings
// (secret-forms.ts: base64, hex, URL encoding, reversed and more), so a copy an adapter or a server
// encoded is caught too; an arbitrary transform is not.

import { SecretValue, ValetError } from '@valet/core'
import { encodedForms, type SecretForm } from './secret-forms'

export const REDACTED = '[redacted]'

/**
 * Session values shorter than this are flags like "1" or "en-AU", not credentials, and matching them
 * would redact nearly every string.
 */
export const MIN_SESSION_VALUE_LENGTH = 8

/**
 * The secrets a login resolved. The auth flow disposes its own copies as soon as it has typed them,
 * so this set keeps independent clones, until the next successful login replaces it.
 */
export class SecretRedactionSet {
  private readonly secrets: SecretValue[] = []
  /** Each registered secret's encoded forms, matched beside it. */
  private readonly forms: SecretForm[] = []
  private ended = false
  /** Set when a secret arrived that could not be kept; every string then counts as sensitive. */
  private incomplete = false

  /** Keeps a clone of `secret` until dispose(). The caller still owns, and disposes, `secret`. */
  register(secret: SecretValue): void {
    // A replaced set redacts nothing any more, so there is no reason to keep a copy.
    if (this.ended) return
    if (!(secret instanceof SecretValue) || secret.disposed) {
      // We can't match what we can't hold, so fail closed: the output and audit targets are withheld.
      this.incomplete = true
      return
    }
    let forms: SecretForm[]
    try {
      forms = encodedForms(secret)
    } catch {
      // Unreachable for a live SecretValue; if it happens, fail closed as for one we couldn't hold.
      this.incomplete = true
      return
    }
    this.secrets.push(secret.clone())
    this.forms.push(...forms)
  }

  /** Something was filled that wasn't registered: every string now counts as sensitive. */
  markIncomplete(): void {
    this.incomplete = true
  }

  /**
   * True when `text` contains a registered secret or one of its forms, as it is or once decoded
   * (normalisedViews: percent, entity and backslash escapes, Unicode compatibility forms, hidden
   * characters and white space).
   */
  occursIn(text: string): boolean {
    if (this.incomplete) return true
    if (this.secrets.length === 0) return false
    return normalisedViews(text).some(
      (view) =>
        this.secrets.some((secret) => secret.occursIn(view)) ||
        this.forms.some((form) => form.value.occursIn(view, { ignoreCase: form.ignoreCase })),
    )
  }

  /** Zeroes every clone and form. Later registrations are ignored. */
  dispose(): void {
    this.ended = true
    for (const secret of this.secrets.splice(0)) secret.dispose()
    for (const form of this.forms.splice(0)) form.value.dispose()
  }

  get size(): number {
    return this.secrets.length
  }
}

/**
 * `text` as it is, and as the ways a server or an adapter commonly re-encodes text would undo:
 * NFKC (full-width letters), without format characters (zero-width spaces), with percent escapes
 * (either case, up to three times over), HTML numeric entities, \\uXXXX and \\/ escapes decoded,
 * and with all white space removed (wrapped base64, a rewrapped key). Red team B4.
 */
export function normalisedViews(text: string): string[] {
  const views = new Set([text])
  let decoded = text.normalize('NFKC').replace(/\p{Cf}/gu, '')
  views.add(decoded)
  for (let round = 0; round < 3; round++) {
    const next = decodeEscapes(decoded)
    if (next === decoded) break
    decoded = next
    views.add(decoded)
  }
  for (const view of [...views]) {
    const compact = view.replace(/\s+/g, '')
    if (compact !== view) views.add(compact)
    if (view.includes('+')) views.add(view.replaceAll('+', ' '))
  }
  return [...views]
}

function decodeEscapes(text: string): string {
  return decodePercent(
    text
      .replace(/&#x([0-9a-f]{1,6});?/gi, (m, hex: string) => fromCode(Number.parseInt(hex, 16), m))
      .replace(/&#([0-9]{1,7});?/g, (m, dec: string) => fromCode(Number.parseInt(dec, 10), m))
      .replace(/\\u([0-9a-f]{4})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
      .replace(/\\\//g, '/'),
  )
}

function fromCode(code: number, fallback: string): string {
  return code <= 0x10ffff ? String.fromCodePoint(code) : fallback
}

/** Percent escapes decoded as UTF-8, run by run; a run that isn't UTF-8 is decoded as Latin-1. */
function decodePercent(text: string): string {
  return text.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
    const bytes = Buffer.from(run.replaceAll('%', ''), 'hex')
    const utf8 = bytes.toString('utf8')
    return utf8.includes('\ufffd') ? bytes.toString('latin1') : utf8
  })
}

export type Sensitive = (text: string) => boolean

/**
 * Matches `values` (session values) and `secrets`. With `ignoreCase`, session values match
 * case-insensitively, for text such as hostnames that URL parsing has lower-cased. Secrets always
 * match exactly: a SecretValue can't be compared any other way without revealing it.
 */
export function sensitiveMatcher(
  values: Iterable<string>,
  secrets: SecretRedactionSet,
  options: { readonly ignoreCase?: boolean } = {},
): Sensitive {
  const fold = options.ignoreCase === true ? (text: string) => text.toLowerCase() : (text: string) => text
  const needles = [...new Set(values)].filter((value) => value.length >= MIN_SESSION_VALUE_LENGTH).map(fold)
  return (text) => {
    const haystack = fold(text)
    return needles.some((needle) => haystack.includes(needle)) || secrets.occursIn(text)
  }
}

export function redactString(text: string, sensitive: Sensitive): string {
  return sensitive(text) ? REDACTED : text
}

/**
 * Prepares a tool's output to leave the process: converts it to plain JSON data, replaces every
 * sensitive string (object keys included), then checks the serialised whole once more.
 *
 * Converting first matters. Tool code chooses what it returns, and an output schema such as
 * z.unknown() lets class instances, getters, toJSON functions and Buffers through. The transport
 * serialises whatever we hand it, so redacting anything other than the exact data that will be
 * serialised would redact the wrong thing.
 *
 * Throws ValetError('tool-output', 'invalid') for output that isn't JSON-serialisable (a
 * cycle, a BigInt, a throwing getter), and ('tool-output', 'internal') if anything sensitive
 * survives redaction.
 */
export function redactOutput(value: unknown, sensitive: Sensitive): unknown {
  const plain = toPlainJson(value)
  const redacted = redactDeep(plain, sensitive)
  if (redacted === undefined) return redacted
  // The whole once more, and every string run together: a secret split across two values or
  // items is in neither alone (red team B4). The marker itself is taken out first, so a short
  // secret that happens to be part of "[redacted]" doesn't fail every call (red team B5).
  const unmarked = (text: string) => text.replaceAll(REDACTED, '\u0001')
  if (sensitive(unmarked(JSON.stringify(redacted))) || sensitive(unmarked(stringsOf(redacted).join('')))) {
    throw new ValetError('tool-output', 'internal')
  }
  return redacted
}

/** One serialisation, so getters and toJSON run exactly once and we keep what they returned. */
function toPlainJson(value: unknown): unknown {
  let text: string | undefined
  try {
    text = JSON.stringify(value, refuseBinary)
  } catch {
    throw new ValetError('tool-output', 'invalid')
  }
  // undefined, a function or a symbol at the top level: there is nothing to send.
  if (text === undefined) return undefined
  return JSON.parse(text) as unknown
}

/**
 * Bytes serialise as arrays of numbers, which no string match can see, and no tool has a reason to
 * return raw bytes over MCP. Looks at the holder's data property rather than `value`, which toJSON
 * has already replaced, and never at a getter, so nothing tool-defined runs twice.
 */
function refuseBinary(this: unknown, key: string, value: unknown): unknown {
  const raw = Object.getOwnPropertyDescriptor(this, key)?.value
  if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) throw new Error('binary output')
  return value
}

/** Every string in JSON data, keys included, in order. */
function stringsOf(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const item of value) stringsOf(item, out)
  else if (value !== null && typeof value === 'object')
    for (const [key, item] of Object.entries(value)) {
      out.push(key)
      stringsOf(item, out)
    }
  return out
}

/**
 * Returns a copy of JSON data (strings, numbers, booleans, null, arrays and plain objects) with
 * every sensitive string replaced, including object keys. Use redactOutput for anything else.
 */
export function redactDeep(value: unknown, sensitive: Sensitive): unknown {
  if (typeof value === 'string') return redactString(value, sensitive)
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, sensitive))
  const copy: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    // defineProperty, so a "__proto__" key from JSON.parse stays data rather than a prototype.
    Object.defineProperty(copy, uniqueKey(copy, redactString(key, sensitive)), {
      value: redactDeep(item, sensitive),
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  return copy
}

function uniqueKey(target: Record<string, unknown>, key: string): string {
  if (!Object.hasOwn(target, key)) return key
  let n = 2
  while (Object.hasOwn(target, `${key}-${n}`)) n++
  return `${key}-${n}`
}
