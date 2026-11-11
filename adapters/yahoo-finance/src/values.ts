// Readers for Yahoo's values. With formatted=true (as the quote page asks) a number arrives as
// { raw, fmt }; the API without it sends the bare number. Both read the same here.

/** A finite number from a bare number or a { raw } object, else null. */
export function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (value !== null && typeof value === 'object' && 'raw' in value)
    return num((value as { raw: unknown }).raw)
  return null
}

/** Trimmed text, or null for anything blank or not a string. */
export function str(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** A Unix time in seconds as an ISO string, or null. */
export function isoFromSeconds(value: unknown): string | null {
  const seconds = num(value)
  if (seconds === null || seconds <= 0) return null
  const date = new Date(seconds * 1000)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

/** Property `key` of `value` when it is a plain object, else undefined. Own properties only. */
export function field(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined
}

/** A path of fields, as field() reads each. */
export function path(value: unknown, ...keys: readonly string[]): unknown {
  let current = value
  for (const key of keys) current = field(current, key)
  return current
}

/** Rounds to `places` decimals, so 0.643144970 reads as 0.6431. */
export function round(value: number | null, places: number): number | null {
  if (value === null) return null
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}
