// Output redaction. Before a tool result leaves the process, any string that contains a session
// value (a cookie, or a handed-off storage value) or a secret resolved during the call is replaced
// whole. Matching is exact substring matching: no normalisation, so an encoded copy of a secret is
// not caught.

import { SecretValue, SiteAdapterError } from '@siteadapter/core'

export const REDACTED = '[redacted]'

/**
 * Session values shorter than this are flags like "1" or "en-AU", not credentials, and matching them
 * would redact nearly every string.
 */
export const MIN_SESSION_VALUE_LENGTH = 8

/**
 * The secrets one tool call's login resolved. The auth flow disposes its own copies as soon as it
 * has typed them, so this set keeps independent clones, and disposes them when the call ends.
 */
export class SecretRedactionSet {
  private readonly secrets: SecretValue[] = []
  private ended = false
  /** Set when a secret arrived that could not be kept; every string then counts as sensitive. */
  private incomplete = false

  /** Keeps a clone of `secret` until dispose(). The caller still owns, and disposes, `secret`. */
  register(secret: SecretValue): void {
    // After the call, nothing is left to redact, so there is no reason to keep a copy.
    if (this.ended) return
    if (!(secret instanceof SecretValue) || secret.disposed) {
      // We can't match what we can't hold, so fail closed: the output and audit targets are withheld.
      this.incomplete = true
      return
    }
    this.secrets.push(secret.clone())
  }

  /** True when `text` contains a registered secret. */
  occursIn(text: string): boolean {
    if (this.incomplete) return true
    return this.secrets.some((secret) => secret.occursIn(text))
  }

  /** Zeroes every clone. Later registrations are ignored. */
  dispose(): void {
    this.ended = true
    for (const secret of this.secrets.splice(0)) secret.dispose()
  }

  get size(): number {
    return this.secrets.length
  }
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
 * Throws SiteAdapterError('tool-output', 'invalid') for output that isn't JSON-serialisable (a
 * cycle, a BigInt, a throwing getter), and ('tool-output', 'internal') if anything sensitive
 * survives redaction.
 */
export function redactOutput(value: unknown, sensitive: Sensitive): unknown {
  const plain = toPlainJson(value)
  const redacted = redactDeep(plain, sensitive)
  if (redacted !== undefined && sensitive(JSON.stringify(redacted))) {
    throw new SiteAdapterError('tool-output', 'internal')
  }
  return redacted
}

/** One serialisation, so getters and toJSON run exactly once and we keep what they returned. */
function toPlainJson(value: unknown): unknown {
  let text: string | undefined
  try {
    text = JSON.stringify(value, refuseBinary)
  } catch {
    throw new SiteAdapterError('tool-output', 'invalid')
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
