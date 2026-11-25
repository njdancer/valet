// Why a tool's input was refused: a path into the input and a reason from a fixed vocabulary, so an
// agent can correct its call. Nothing in an issue is free text: the reason is a code, the limit a
// number, and the path only plain identifiers and indexes, cut at the first segment that isn't one.
// A schema's own messages (a refinement's text, say) are adapter-authored and never carried.

export const INPUT_REASONS = [
  /** A key the tool's schema doesn't declare: misspelled, or a parameter the tool doesn't take. */
  'unknown-key',
  'missing',
  'wrong-type',
  /** A number below `limit`. */
  'too-small',
  /** A number above `limit`. */
  'too-large',
  /** A string shorter than `limit` characters. */
  'too-short',
  'too-long',
  /** A list with fewer than `limit` entries. */
  'too-few',
  'too-many',
  /** A string with nothing but spaces in it. */
  'blank',
  /** Not one of the values the schema lists, or not a multiple it requires. */
  'not-allowed',
  'bad-format',
  /** None of a union's alternatives. */
  'no-match',
  /** The same value given twice where each may appear once. Set by the tool's own check. */
  'duplicate',
  /** Valid alone, but with what is already there it would pass `limit` (a cart line's cap). */
  'over-total',
  /** The site itself refused the value: it may not be one the site knows. */
  'not-accepted',
  /** An end that isn't after its start. Set by the tool's own check. */
  'before-start',
  /** Names something agents may read but not change (a read-only calendar). Set by the tool. */
  'read-only',
  /** A check of the tool's own, which says nothing more. */
  'refused',
] as const
export type InputReason = (typeof INPUT_REASONS)[number]

export type InputPathSegment = string | number

export interface InputIssue {
  readonly path: readonly InputPathSegment[]
  readonly reason: InputReason
  /** The bound the reason refers to, when it has one. */
  readonly limit?: number
}

/** A key or property name an issue may name: plain enough to be no channel for text. */
const SEGMENT = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const MAX_SEGMENTS = 8
const MAX_INDEX = 100_000
const MAX_LIMIT = 1e12

function isReason(value: unknown): value is InputReason {
  return INPUT_REASONS.some((reason) => reason === value)
}

function safePath(value: unknown): InputPathSegment[] {
  if (!Array.isArray(value)) return []
  const path: InputPathSegment[] = []
  for (const segment of value.slice(0, MAX_SEGMENTS)) {
    if (typeof segment === 'number' && Number.isInteger(segment) && segment >= 0 && segment <= MAX_INDEX) {
      path.push(segment)
    } else if (typeof segment === 'string' && SEGMENT.test(segment)) {
      path.push(segment)
    } else {
      // A symbol, a long or odd key: the path stops at its parent rather than carry it.
      break
    }
  }
  return path
}

function safeLimit(value: unknown): number | undefined {
  const limit = typeof value === 'bigint' ? Number(value) : value
  if (typeof limit !== 'number' || !Number.isFinite(limit) || Math.abs(limit) > MAX_LIMIT) return undefined
  return limit
}

/**
 * An issue checked against the vocabulary, or undefined when `value` isn't one. For anything that
 * crossed from untrusted code (the tool process, a ValetError's argument): only the parts that pass
 * are kept.
 */
export function inputIssue(value: unknown): InputIssue | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const raw = value as { path?: unknown; reason?: unknown; limit?: unknown }
  if (!isReason(raw.reason)) return undefined
  const limit = safeLimit(raw.limit)
  return { path: safePath(raw.path), reason: raw.reason, ...(limit === undefined ? {} : { limit }) }
}

/** The value at `path` in `input`, through own properties only; undefined when there is none. */
function valueAt(input: unknown, path: readonly unknown[]): unknown {
  let at = input
  for (const segment of path) {
    if (at === null || typeof at !== 'object') return undefined
    if (typeof segment !== 'string' && typeof segment !== 'number') return undefined
    if (!Object.hasOwn(at, segment)) return undefined
    at = (at as Record<string | number, unknown>)[segment]
  }
  return at
}

/**
 * Maps one zod issue (v4's shape, read without trusting it) to an InputIssue. `input` is what was
 * parsed, to tell a missing value from a wrong one. A zod message is never read: a refinement's
 * message is adapter text. A custom issue may name a reason from the vocabulary in
 * `params.reason`; any other custom issue is `refused`.
 */
export function issueFromZod(issue: unknown, input: unknown): InputIssue {
  const fallback: InputIssue = { path: [], reason: 'refused' }
  if (issue === null || typeof issue !== 'object') return fallback
  const i = issue as {
    code?: unknown
    path?: unknown
    keys?: unknown
    minimum?: unknown
    maximum?: unknown
    inclusive?: unknown
    origin?: unknown
    params?: unknown
  }
  const path = Array.isArray(i.path) ? i.path : []
  const bound = (value: unknown) => (i.inclusive === false ? undefined : value)
  let raw: { path: readonly unknown[]; reason: InputReason; limit?: unknown }
  switch (i.code) {
    case 'unrecognized_keys': {
      const key = Array.isArray(i.keys) ? i.keys[0] : undefined
      raw = { path: [...path, key], reason: 'unknown-key' }
      break
    }
    case 'invalid_type':
      raw = { path, reason: valueAt(input, path) === undefined ? 'missing' : 'wrong-type' }
      break
    case 'too_small': {
      const value = valueAt(input, path)
      if (i.origin === 'string')
        raw =
          typeof value === 'string' && value.trim() === ''
            ? { path, reason: 'blank' }
            : { path, reason: 'too-short', limit: bound(i.minimum) }
      else if (i.origin === 'array' || i.origin === 'set')
        raw = { path, reason: 'too-few', limit: bound(i.minimum) }
      else raw = { path, reason: 'too-small', limit: bound(i.minimum) }
      break
    }
    case 'too_big':
      if (i.origin === 'string') raw = { path, reason: 'too-long', limit: bound(i.maximum) }
      else if (i.origin === 'array' || i.origin === 'set')
        raw = { path, reason: 'too-many', limit: bound(i.maximum) }
      else raw = { path, reason: 'too-large', limit: bound(i.maximum) }
      break
    case 'invalid_value':
    case 'not_multiple_of':
      raw = { path, reason: 'not-allowed' }
      break
    case 'invalid_format':
      raw = { path, reason: 'bad-format' }
      break
    case 'invalid_union':
      raw = { path, reason: 'no-match' }
      break
    case 'invalid_key':
    case 'invalid_element':
      raw = { path, reason: 'wrong-type' }
      break
    case 'custom': {
      const params = i.params
      const named =
        params !== null && typeof params === 'object' && Object.hasOwn(params, 'reason')
          ? (params as { reason?: unknown }).reason
          : undefined
      const limit =
        params !== null && typeof params === 'object' && Object.hasOwn(params, 'limit')
          ? (params as { limit?: unknown }).limit
          : undefined
      raw = { path, reason: isReason(named) ? named : 'refused', limit }
      break
    }
    default:
      raw = { path, reason: 'refused' }
  }
  return inputIssue(raw) ?? fallback
}

/** "items[1].stockcode", or "the input" for the whole of it. Segments are re-checked. */
export function inputIssuePath(path: readonly InputPathSegment[]): string {
  let text = ''
  for (const segment of safePath(path)) {
    text += typeof segment === 'number' ? `[${segment}]` : text === '' ? segment : `.${segment}`
  }
  return text === '' ? 'the input' : text
}

/** One fixed sentence per reason, without a final full stop. */
export function inputIssueSentence(issue: InputIssue): string {
  const safe = inputIssue(issue) ?? { path: [], reason: 'refused' }
  const at = inputIssuePath(safe.path)
  const limit = safe.limit
  const has = limit !== undefined
  switch (safe.reason) {
    case 'unknown-key':
      return `${at} is not a parameter this tool takes. Check the names in its input schema`
    case 'missing':
      return `${at} is required`
    case 'wrong-type':
      return `${at} has the wrong type`
    case 'too-small':
      return has ? `${at} must be at least ${limit}` : `${at} is too small`
    case 'too-large':
      return has ? `${at} must be at most ${limit}` : `${at} is too large`
    case 'too-short':
      return has ? `${at} must be at least ${limit} characters long` : `${at} is too short`
    case 'too-long':
      return has ? `${at} must be at most ${limit} characters long` : `${at} is too long`
    case 'too-few':
      return has ? `${at} must have at least ${limit} entries` : `${at} has too few entries`
    case 'too-many':
      return has ? `${at} may have at most ${limit} entries` : `${at} has too many entries`
    case 'blank':
      return `${at} must not be blank`
    case 'not-allowed':
      return `${at} is not one of the values this tool allows`
    case 'bad-format':
      return `${at} is not in the format this tool expects`
    case 'no-match':
      return `${at} matches none of the forms this tool accepts`
    case 'duplicate':
      return `${at} repeats a value given earlier in the same call. Give each one once`
    case 'over-total':
      return has
        ? `${at} would take the total over the limit of ${limit}`
        : `${at} would take the total over its limit`
    case 'not-accepted':
      return `the site did not accept ${at}: it may not be a value the site knows. Check it against what the site's own search returns`
    case 'before-start':
      return `${at} must be after the start`
    case 'read-only':
      return `${at} names one that can be read but not changed. Pick one the list shows as writable`
    case 'refused':
      return `${at} was refused by the tool's own checks`
  }
}
