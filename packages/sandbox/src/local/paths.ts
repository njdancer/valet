// Matching a path tool code names against the manifest's `files` exceptions
// (docs/sandbox.md#files-in-detail). Pure: no file system here. Paths are compared by segments in
// NFC, case folded: APFS is normalisation-insensitive and (by default) case-insensitive, so this
// is as close as JavaScript gets to what the disk treats as one name. Compatibility forms (NFKC)
// would match names the disk keeps apart; the forbidden check in core uses NFKC, which only ever
// refuses more.

import { isPathPattern, patternRoot } from '@valet/core'

export interface FilePattern {
  readonly access: 'read' | 'read-write'
  /** The pattern's fixed folder, `~` expanded. */
  readonly root: string
  /** `exact`: the root only; `children`: `root/*`; `descendants`: `root/**`. */
  readonly reach: 'exact' | 'children' | 'descendants'
}

export function expandHome(path: string, home: string): string {
  if (path.startsWith('~/')) return `${home.replace(/\/+$/, '')}/${path.slice(2)}`
  return path
}

export function toPattern(pattern: string, access: FilePattern['access'], home: string): FilePattern {
  const reach = pattern.endsWith('/**') ? 'descendants' : pattern.endsWith('/*') ? 'children' : 'exact'
  return { access, root: expandHome(patternRoot(pattern), home), reach }
}

/**
 * A path tool code may name: what a pattern may be, without wildcards. Returns the absolute path
 * with `~` expanded, or null.
 */
export function checkRequestedPath(value: unknown, home: string): string | null {
  if (typeof value !== 'string' || value.includes('*') || !isPathPattern(value)) return null
  return expandHome(value, home)
}

const fold = (s: string): string => s.normalize('NFC').toLowerCase()
const segments = (path: string): string[] =>
  path
    .split('/')
    .filter((s) => s !== '')
    .map(fold)

/** True if `path` (absolute) is within `pattern`, with its root taken as `root` (a resolved form). */
export function withinPattern(path: string, pattern: FilePattern, root: string = pattern.root): boolean {
  const p = segments(path)
  const r = segments(root)
  if (p.length < r.length || r.some((segment, i) => p[i] !== segment)) return false
  const depth = p.length - r.length
  if (pattern.reach === 'exact') return depth === 0
  if (pattern.reach === 'children') return depth <= 1
  return true
}

/** `<home>/x` back to `~/x`, for the core checks that speak in `~/`. */
export function homeRelative(path: string, home: string): string {
  const h = home.replace(/\/+$/, '')
  const f = fold(path)
  const fh = fold(h)
  if (f === fh) return '~'
  if (f.startsWith(`${fh}/`)) return `~${path.slice(h.length)}`
  return path
}
