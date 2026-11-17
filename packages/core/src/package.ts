// Adapter packages (docs/adapter-packages.md): an adapter as a map from relative path to UTF-8
// text, a manifest plus TypeScript sources, which Valet checks, hashes, compiles and stores itself.
// Every way in (the built-ins, a development folder, an agent's draft) goes through checkPackage
// before anything is hashed, compiled or stored.

import { DEPENDENCY_LOCK, type DependencyLock, dependencyLockSchema } from './dependencies'
import { bundleHash, canonicalJson } from './hash'
import { type AdapterManifest, manifestSchema } from './manifest'

/** A package's files: relative path to UTF-8 text. */
export type PackageFiles = Readonly<Record<string, string>>

export const PACKAGE_MANIFEST = 'manifest.json'
/** The module the compiler starts from. It exports `tools`. */
export const PACKAGE_ENTRY = 'src/tools.ts'
/** The hash entry that carries the parsed manifest. No path can start with ':'. */
export const MANIFEST_HASH_ENTRY = ':manifest.json'
/** The hash entry that carries the parsed dependency lockfile, when there is one. */
export const LOCK_HASH_ENTRY = ':valet-lock.json'

export const PACKAGE_LIMITS = {
  files: 200,
  fileBytes: 1024 * 1024,
  totalBytes: 8 * 1024 * 1024,
  pathLength: 200,
  segments: 8,
} as const

/**
 * Why a package was refused. `detail` names the path, or the manifest's problems (up to
 * MAX_MANIFEST_ISSUES of them); never other files' contents.
 */
export type PackageRule =
  | 'path'
  | 'placement'
  | 'too-many-files'
  | 'file-too-large'
  | 'too-large'
  | 'not-text'
  | 'manifest-missing'
  | 'manifest-invalid'
  | 'entry-missing'
  | 'lock-invalid'

export class PackageError extends Error {
  constructor(
    readonly rule: PackageRule,
    readonly detail: string,
  ) {
    super(`package refused (${rule}): ${detail}`)
    this.name = 'PackageError'
  }
}

export interface CheckedPackage {
  readonly manifest: AdapterManifest
  /** Every file, as given (a fresh copy). */
  readonly files: PackageFiles
  /** What the adapter hash covers. */
  readonly adapterHash: string
  /** Every file, for telling versions apart. Nothing is keyed by it. */
  readonly packageHash: string
  /** The npm dependencies a `raw` adapter is bundled with, or null without valet-lock.json. */
  readonly dependencies: DependencyLock | null
}

const SEGMENT = /^[a-z0-9][a-z0-9._-]*$/

/** Where each kind of file may live, by top-level folder. */
const PLACEMENT: Readonly<Record<string, readonly string[]>> = {
  src: ['.ts'],
  test: ['.ts', '.json'],
  fixtures: ['.json', '.html', '.txt', '.xml'],
}
const TOP_LEVEL = new Set([PACKAGE_MANIFEST, 'README.md', DEPENDENCY_LOCK])

/** Throws PackageError('path') unless `path` is a relative path the package rules allow. */
export function checkPackagePath(path: string): void {
  if (TOP_LEVEL.has(path)) return
  if (path.length === 0 || path.length > PACKAGE_LIMITS.pathLength) throw new PackageError('path', clip(path))
  const segments = path.split('/')
  if (segments.length < 2 || segments.length > PACKAGE_LIMITS.segments)
    throw new PackageError('path', clip(path))
  for (const segment of segments) {
    // The segment rule already refuses '', '.', '..', backslashes, uppercase and anything not ASCII.
    if (!SEGMENT.test(segment) || segment === '.' || segment === '..')
      throw new PackageError('path', clip(path))
  }
  const [top] = segments
  const allowed = top === undefined || !Object.hasOwn(PLACEMENT, top) ? undefined : PLACEMENT[top]
  const name = segments.at(-1) ?? ''
  if (allowed === undefined || !allowed.some((ext) => name.endsWith(ext) && name.length > ext.length))
    throw new PackageError('placement', clip(path))
}

/**
 * Checks every rule, parses the manifest and hashes the package. Throws PackageError. The files
 * returned are a copy, so later changes to the caller's object can't reach what was checked.
 */
export function checkPackage(input: PackageFiles): CheckedPackage {
  if (input === null || typeof input !== 'object' || Array.isArray(input))
    throw new PackageError('manifest-missing', 'not a file map')
  const files: Record<string, string> = {}
  const paths = Object.keys(input)
  if (paths.length > PACKAGE_LIMITS.files) throw new PackageError('too-many-files', String(paths.length))
  let total = 0
  for (const path of paths) {
    checkPackagePath(path)
    const text = (input as Record<string, unknown>)[path]
    if (typeof text !== 'string' || text.includes('\0') || !text.isWellFormed())
      throw new PackageError('not-text', clip(path))
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > PACKAGE_LIMITS.fileBytes) throw new PackageError('file-too-large', clip(path))
    total += bytes
    if (total > PACKAGE_LIMITS.totalBytes) throw new PackageError('too-large', String(total))
    Object.defineProperty(files, path, {
      value: text,
      enumerable: true,
      writable: false,
      configurable: false,
    })
  }
  if (!Object.hasOwn(files, PACKAGE_MANIFEST)) throw new PackageError('manifest-missing', PACKAGE_MANIFEST)
  if (!Object.hasOwn(files, PACKAGE_ENTRY)) throw new PackageError('entry-missing', PACKAGE_ENTRY)
  let json: unknown
  try {
    json = JSON.parse(files[PACKAGE_MANIFEST] as string)
  } catch (error) {
    // JSON.parse's own words carry the position: "... in JSON at position 8 (line 1 column 9)".
    const why = error instanceof Error && error.message !== '' ? `: ${error.message}` : ''
    throw new PackageError('manifest-invalid', clip(`not JSON${why}`, 300))
  }
  const parsed = manifestSchema.safeParse(json)
  if (!parsed.success) throw new PackageError('manifest-invalid', manifestProblems(parsed.error.issues))
  const manifest = parsed.data
  const dependencies = Object.hasOwn(files, DEPENDENCY_LOCK)
    ? checkLock(files[DEPENDENCY_LOCK] as string, manifest)
    : null
  return {
    manifest,
    files: Object.freeze(files),
    adapterHash: adapterHashOf(files, manifest),
    packageHash: bundleHash(files),
    dependencies,
  }
}

/** The runtime kind a manifest names (`browser` when it names none). */
function runtimeKind(manifest: AdapterManifest): string {
  const runtime = (manifest as { readonly runtime?: unknown }).runtime
  return typeof runtime === 'string' ? runtime : 'browser'
}

/** Parses valet-lock.json. Only a `raw` adapter runs npm code, so only one may have it. */
export function checkLock(text: string, manifest: AdapterManifest): DependencyLock {
  if (runtimeKind(manifest) !== 'raw')
    throw new PackageError('lock-invalid', `only a raw adapter may have ${DEPENDENCY_LOCK}`)
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new PackageError('lock-invalid', 'not JSON')
  }
  const parsed = dependencyLockSchema.safeParse(json)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const where = issue === undefined ? '' : issue.path.join('.')
    throw new PackageError(
      'lock-invalid',
      clip(`${where}${where === '' ? '' : ': '}${issue?.message ?? 'invalid'}`),
    )
  }
  return parsed.data
}

/**
 * The hash approvals and grants are keyed by: every file under src/ plus the parsed manifest,
 * canonicalised. The same formula the built-ins were hashed with before packages, so moving them
 * onto packages keeps their hashes. A `raw` adapter's lockfile is covered too, canonicalised, and
 * through its integrities the exact code of every dependency; a package without one hashes as it
 * always did.
 */
export function adapterHashOf(files: PackageFiles, manifest: AdapterManifest): string {
  const covered: Record<string, string> = {}
  for (const path of Object.keys(files)) {
    if (path.startsWith('src/')) covered[path] = files[path] as string
  }
  covered[MANIFEST_HASH_ENTRY] = canonicalJson(manifest)
  const lock = lockHashEntry(files)
  if (lock !== null) covered[LOCK_HASH_ENTRY] = lock
  return bundleHash(covered)
}

/**
 * What a package's lockfile adds to its hash, canonicalised; null without one. Every formula that
 * hashes an adapter (the app's registry and approved snapshots too) must add it the same way.
 */
export function lockHashEntry(files: Readonly<Record<string, string>>): string | null {
  if (!Object.hasOwn(files, DEPENDENCY_LOCK)) return null
  const text = files[DEPENDENCY_LOCK] as string
  let lock: unknown
  try {
    lock = JSON.parse(text)
  } catch {
    lock = text
  }
  return canonicalJson(lock)
}

/** A package from a manifest and sources, as the built-ins and tests make one. */
export function packageOf(manifest: AdapterManifest, files: PackageFiles): Record<string, string> {
  return { ...files, [PACKAGE_MANIFEST]: `${JSON.stringify(manifest, null, 2)}\n` }
}

function clip(text: string, max = 120): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text
}

/** How many of the manifest's problems a refusal lists. */
export const MAX_MANIFEST_ISSUES = 5

/** Keys people reach for that the manifest calls something else. */
const KEY_SYNONYMS: Readonly<Record<string, string>> = {
  apis: 'requests',
  api: 'requests',
  routes: 'requests',
  paths: 'requests',
  urls: 'requests',
  hosts: 'egress',
  domains: 'egress',
  allowedHosts: 'egress',
  allowlist: 'egress',
  origins: 'navigation',
  url: 'home',
  homepage: 'home',
  homeUrl: 'home',
  baseUrl: 'home',
  login: 'auth',
  title: 'name',
  side_effect: 'sideEffect',
  sideEffects: 'sideEffect',
}

interface ManifestIssue {
  readonly code: string
  readonly path: readonly PropertyKey[]
  readonly message: string
  readonly keys?: readonly string[]
}

/**
 * The manifest's first few problems, each with where it is ("(top level)" for the manifest itself)
 * and, for a key the manifest doesn't have, the nearest one it does.
 */
function manifestProblems(issues: readonly ManifestIssue[]): string {
  const shown = issues.slice(0, MAX_MANIFEST_ISSUES).map((issue) => {
    const where = issue.path.length === 0 ? '(top level)' : pathText(issue.path)
    let text = `${where}: ${issue.message}`
    if (issue.code === 'unrecognized_keys') {
      const known = keysAt(manifestSchema, issue.path)
      const hints = (issue.keys ?? []).flatMap((key) => {
        const near = nearestKey(key, known)
        return near === null ? [] : [`"${near}" for "${key}"`]
      })
      if (hints.length > 0) text += ` (did you mean ${hints.join(', ')}?)`
    }
    return clip(text, 200)
  })
  const more = issues.length - shown.length
  return `${shown.join('; ')}${more > 0 ? `; and ${more} more` : ''}`
}

function pathText(path: readonly PropertyKey[]): string {
  let out = ''
  for (const part of path) {
    if (typeof part === 'number') out += `[${part}]`
    else out += out === '' ? String(part) : `.${String(part)}`
  }
  return out
}

interface SchemaDef {
  readonly type?: string
  readonly shape?: Readonly<Record<string, unknown>>
  readonly innerType?: unknown
  readonly element?: unknown
  readonly valueType?: unknown
  readonly in?: unknown
  readonly options?: readonly unknown[]
}

function defOf(schema: unknown): SchemaDef {
  return ((schema as { _zod?: { def?: SchemaDef } } | null)?._zod?.def ?? {}) as SchemaDef
}

/** The schemas `schema` stands for once wrappers are taken off: a union's options, each. */
function unwrapped(schema: unknown, depth = 0): unknown[] {
  if (depth > 20) return []
  const def = defOf(schema)
  switch (def.type) {
    case 'default':
    case 'prefault':
    case 'optional':
    case 'nullable':
    case 'readonly':
    case 'catch':
      return unwrapped(def.innerType, depth + 1)
    case 'pipe':
      return unwrapped(def.in, depth + 1)
    case 'union':
      return (def.options ?? []).flatMap((option) => unwrapped(option, depth + 1))
    default:
      return [schema]
  }
}

/** The keys the object schemas at `path` know, for suggesting one. */
function keysAt(schema: unknown, path: readonly PropertyKey[]): readonly string[] {
  let here = unwrapped(schema)
  for (const part of path) {
    here = here.flatMap((s) => {
      const def = defOf(s)
      if (def.type === 'object' && typeof part === 'string' && def.shape !== undefined)
        return Object.hasOwn(def.shape, part) ? unwrapped(def.shape[part]) : []
      if (def.type === 'array' && typeof part === 'number') return unwrapped(def.element)
      if (def.type === 'record' && typeof part === 'string') return unwrapped(def.valueType)
      return []
    })
  }
  const keys = new Set<string>()
  for (const s of here) {
    const def = defOf(s)
    if (def.type === 'object' && def.shape !== undefined)
      for (const key of Object.keys(def.shape)) keys.add(key)
  }
  return [...keys]
}

/** A known key `key` is likely a slip for: a usual other name, or one a couple of edits away. */
function nearestKey(key: string, known: readonly string[]): string | null {
  const synonym = Object.hasOwn(KEY_SYNONYMS, key) ? KEY_SYNONYMS[key] : undefined
  if (synonym !== undefined && known.includes(synonym)) return synonym
  const lower = key.toLowerCase()
  const caseOnly = known.find((k) => k.toLowerCase() === lower)
  if (caseOnly !== undefined) return caseOnly
  let best: string | null = null
  let bestDistance = Math.max(1, Math.min(3, Math.floor(key.length / 3)))
  for (const candidate of known) {
    const distance = editDistance(lower, candidate.toLowerCase())
    if (distance <= bestDistance) {
      best = candidate
      bestDistance = distance - 1
    }
  }
  return best
}

function editDistance(a: string, b: string): number {
  if (a.length > 64 || b.length > 64) return Number.POSITIVE_INFINITY
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      current[j] = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost)
    }
    previous = current
  }
  return previous[b.length] ?? Number.POSITIVE_INFINITY
}
