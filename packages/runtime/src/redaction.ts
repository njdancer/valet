// Output redaction. Before a tool result leaves the process, any string that contains a current
// session cookie value or a secret this process has handled is replaced whole. Matching is exact
// substring matching: no normalisation, so an encoded copy of a secret is not caught.

import type { SecretValue } from '@siteadapter/core'

export const REDACTED = '[redacted]'

/**
 * Cookie values shorter than this are flags like "1" or "en-AU", not credentials, and matching them
 * would redact nearly every string.
 */
export const MIN_COOKIE_LENGTH = 8

/** Secrets seen in this process. The auth flow adds each one it resolves. */
export class SecretRedactionSet {
  private readonly secrets = new Set<SecretValue>()

  remember(secret: SecretValue): void {
    this.secrets.add(secret)
  }

  /** True when `text` contains a remembered secret that has not yet been disposed. */
  occursIn(text: string): boolean {
    for (const secret of this.secrets) {
      // A disposed secret's bytes are zeroed, so it can no longer be matched. See knownGaps.
      if (secret.disposed) this.secrets.delete(secret)
      else if (secret.occursIn(text)) return true
    }
    return false
  }

  get size(): number {
    return this.secrets.size
  }
}

export type Sensitive = (text: string) => boolean

export function sensitiveMatcher(cookieValues: Iterable<string>, secrets: SecretRedactionSet): Sensitive {
  const needles = [...new Set(cookieValues)].filter((value) => value.length >= MIN_COOKIE_LENGTH)
  return (text) => needles.some((needle) => text.includes(needle)) || secrets.occursIn(text)
}

export function redactString(text: string, sensitive: Sensitive): string {
  return sensitive(text) ? REDACTED : text
}

/**
 * Returns a copy of `value` with every sensitive string replaced, walking arrays, plain objects,
 * Maps and Sets, including object keys. Other values are returned as they are.
 */
export function redactDeep(value: unknown, sensitive: Sensitive): unknown {
  const walk = (node: unknown, seen: WeakSet<object>): unknown => {
    if (typeof node === 'string') return redactString(node, sensitive)
    if (node === null || typeof node !== 'object') return node
    if (seen.has(node)) return REDACTED
    seen.add(node)
    try {
      if (Array.isArray(node)) return node.map((item) => walk(item, seen))
      if (node instanceof Map) {
        return new Map([...node].map(([key, item]) => [walk(key, seen), walk(item, seen)]))
      }
      if (node instanceof Set) return new Set([...node].map((item) => walk(item, seen)))
      if (!isPlainObject(node)) return node
      const copy: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(node)) {
        Object.defineProperty(copy, uniqueKey(copy, redactString(key, sensitive)), {
          value: walk(item, seen),
          enumerable: true,
          writable: true,
          configurable: true,
        })
      }
      return copy
    } finally {
      // Shared (non-cyclic) references are fine; only an ancestor is a cycle.
      seen.delete(node)
    }
  }
  return walk(value, new WeakSet())
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function uniqueKey(target: Record<string, unknown>, key: string): string {
  if (!Object.hasOwn(target, key)) return key
  let n = 2
  while (Object.hasOwn(target, `${key}-${n}`)) n++
  return `${key}-${n}`
}
