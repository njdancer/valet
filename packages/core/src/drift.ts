// Drift detection: checks a site's JSON against the zod schema an adapter reads it with, and
// describes what came back, without ever copying a value. Used by fixture tests, by the fake
// site's tests and by the gated live smoke test (M4). Reports carry paths and type names only:
// response values can be personal data, and a report is printed and kept.

import { z } from 'zod'

/** One way a response failed its schema. Never carries the value it found. */
export interface DriftIssue {
  /** Where, with array indices collapsed to `[]`, e.g. `Products[].Products[].Stockcode`. */
  readonly path: string
  /** Zod's issue code, e.g. `invalid_type`. */
  readonly code: string
  /** The type the schema wanted, for type mismatches. */
  readonly expected: string | null
  /** The JSON type found there: string, number, boolean, null, array, object or missing. */
  readonly received: JsonType
}

export interface DriftReport {
  /** True when the body parsed and carried every field the schema declares. */
  readonly ok: boolean
  /** Why the body failed to parse. Non-empty means the adapter fails with `site-changed`. */
  readonly issues: readonly DriftIssue[]
  /**
   * Declared fields the body didn't carry at all, sorted. Most of an adapter's fields are nullish
   * (the site sends null for many of them), so a renamed field still parses, as undefined. This is
   * where a rename shows up. A field sent as null is not absent.
   */
  readonly absent: readonly string[]
}

export type JsonType = 'string' | 'number' | 'boolean' | 'null' | 'array' | 'object' | 'missing'

/**
 * The shape of a JSON value: a type name for a primitive, the merged shape of the elements for an
 * array (`[]` when empty), an object of shapes by key. Types that vary are joined, e.g.
 * `string|null`. Keys are kept; values never are.
 */
export type Shape = string | readonly Shape[] | { readonly [key: string]: Shape }

/** Key segments printed as they are; anything else is `?`, so a path can't smuggle text out. */
const SAFE_KEY = /^[A-Za-z0-9_$-]{1,64}$/
/** Bounds on describeShape, so a hostile or enormous body can't make an enormous report. */
const MAX_DEPTH = 12
const MAX_KEYS = 200
const MAX_ISSUES = 50

export function checkShape(schema: z.ZodType, body: unknown): DriftReport {
  const parsed = schema.safeParse(body)
  const issues: DriftIssue[] = []
  const seen = new Set<string>()
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = formatPath(issue.path)
      const key = `${path} ${issue.code}`
      if (seen.has(key) || issues.length >= MAX_ISSUES) continue
      seen.add(key)
      issues.push({
        path,
        code: issue.code,
        expected: issue.code === 'invalid_type' ? String(issue.expected) : null,
        received: jsonType(valueAt(body, issue.path)),
      })
    }
  }
  const absent = new Set<string>()
  collectAbsent(schema, body, [], absent, 0)
  return { ok: issues.length === 0 && absent.size === 0, issues, absent: [...absent].sort() }
}

/** Joins several reports, e.g. one per product, prefixing each report's paths. */
export function mergeReports(
  parts: readonly { readonly at: string; readonly report: DriftReport }[],
): DriftReport {
  const issues: DriftIssue[] = []
  const seen = new Set<string>()
  const absent = new Set<string>()
  for (const { at, report } of parts) {
    for (const issue of report.issues) {
      const path = joinPath(at, issue.path)
      const key = `${path} ${issue.code}`
      if (seen.has(key) || issues.length >= MAX_ISSUES) continue
      seen.add(key)
      issues.push({ ...issue, path })
    }
    for (const path of report.absent) absent.add(joinPath(at, path))
  }
  return { ok: issues.length === 0 && absent.size === 0, issues, absent: [...absent].sort() }
}

/** The keys and types of a JSON value, never its values. */
export function describeShape(value: unknown, depth = 0): Shape {
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) return 'array'
    return value.length === 0
      ? []
      : [value.map((element) => describeShape(element, depth + 1)).reduce(mergeShapes)]
  }
  if (value !== null && typeof value === 'object') {
    if (depth >= MAX_DEPTH) return 'object'
    const out: Record<string, Shape> = {}
    for (const key of Object.keys(value).slice(0, MAX_KEYS)) {
      out[SAFE_KEY.test(key) ? key : '?'] = describeShape((value as Record<string, unknown>)[key], depth + 1)
    }
    return out
  }
  return jsonType(value)
}

function mergeShapes(a: Shape, b: Shape): Shape {
  if (typeof a === 'string' && typeof b === 'string') return joinTypes(a, b)
  if (Array.isArray(a) && Array.isArray(b)) {
    const [left] = a
    const [right] = b
    if (left === undefined) return b
    if (right === undefined) return a
    return [mergeShapes(left, right)]
  }
  if (isShapeObject(a) && isShapeObject(b)) {
    const out: Record<string, Shape> = {}
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const left = a[key]
      const right = b[key]
      out[key] =
        left === undefined
          ? joinTypes(right as Shape, 'missing')
          : right === undefined
            ? joinTypes(left, 'missing')
            : mergeShapes(left, right)
    }
    return out
  }
  return joinTypes(kindOf(a), kindOf(b))
}

/** Joins two shapes' type names. Only strings are joined; a structured shape becomes its kind. */
function joinTypes(a: Shape, b: Shape): string {
  const names = new Set([...kindOf(a).split('|'), ...kindOf(b).split('|')])
  return [...names].sort().join('|')
}

function kindOf(shape: Shape): string {
  if (typeof shape === 'string') return shape
  return Array.isArray(shape) ? 'array' : 'object'
}

function isShapeObject(shape: Shape): shape is { readonly [key: string]: Shape } {
  return typeof shape === 'object' && !Array.isArray(shape)
}

function collectAbsent(
  schema: z.ZodType,
  value: unknown,
  path: PropertyKey[],
  out: Set<string>,
  depth: number,
): void {
  if (depth > MAX_DEPTH) return
  const inner = unwrap(schema)
  if (inner instanceof z.ZodObject) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return
    for (const [key, field] of Object.entries(inner.shape as Record<string, z.ZodType>)) {
      if (!Object.hasOwn(value, key)) out.add(formatPath([...path, key]))
      else collectAbsent(field, (value as Record<string, unknown>)[key], [...path, key], out, depth + 1)
    }
  } else if (inner instanceof z.ZodArray) {
    if (!Array.isArray(value)) return
    for (const element of value)
      collectAbsent(inner.element as z.ZodType, element, [...path, 0], out, depth + 1)
  }
}

/** Looks through optional, nullable, default and readonly wrappers to the schema they hold. */
function unwrap(schema: z.ZodType): z.ZodType {
  let current: z.ZodType = schema
  for (let i = 0; i < 10; i++) {
    if (
      current instanceof z.ZodOptional ||
      current instanceof z.ZodNullable ||
      current instanceof z.ZodDefault ||
      current instanceof z.ZodReadonly
    ) {
      current = current.unwrap() as z.ZodType
    } else {
      return current
    }
  }
  return current
}

function formatPath(path: readonly PropertyKey[]): string {
  let out = ''
  for (const segment of path) {
    if (typeof segment === 'number') out += '[]'
    else {
      const key = typeof segment === 'string' && SAFE_KEY.test(segment) ? segment : '?'
      out += out === '' ? key : `.${key}`
    }
  }
  return out === '' ? '(root)' : out
}

function joinPath(at: string, path: string): string {
  if (at === '') return path
  if (path === '(root)') return at
  return path.startsWith('[') ? `${at}${path}` : `${at}.${path}`
}

function valueAt(value: unknown, path: readonly PropertyKey[]): unknown {
  let current: unknown = value
  for (const segment of path) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<PropertyKey, unknown>)[segment]
  }
  return current
}

function jsonType(value: unknown): JsonType {
  if (value === undefined) return 'missing'
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  const type = typeof value
  if (type === 'string' || type === 'number' || type === 'boolean') return type
  return 'object'
}
