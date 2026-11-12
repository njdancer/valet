// Adapter packages (docs/adapter-packages.md): an adapter as a map from relative path to UTF-8
// text, a manifest plus TypeScript sources, which Valet checks, hashes, compiles and stores itself.
// Every way in (the built-ins, a development folder, an agent's draft) goes through checkPackage
// before anything is hashed, compiled or stored.

import { bundleHash, canonicalJson } from './hash'
import { type AdapterManifest, manifestSchema } from './manifest'

/** A package's files: relative path to UTF-8 text. */
export type PackageFiles = Readonly<Record<string, string>>

export const PACKAGE_MANIFEST = 'manifest.json'
/** The module the compiler starts from. It exports `tools`. */
export const PACKAGE_ENTRY = 'src/tools.ts'
/** The hash entry that carries the parsed manifest. No path can start with ':'. */
export const MANIFEST_HASH_ENTRY = ':manifest.json'

export const PACKAGE_LIMITS = {
  files: 200,
  fileBytes: 1024 * 1024,
  totalBytes: 8 * 1024 * 1024,
  pathLength: 200,
  segments: 8,
} as const

/** Why a package was refused. `detail` names the path or the first problem; never file contents. */
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
}

const SEGMENT = /^[a-z0-9][a-z0-9._-]*$/

/** Where each kind of file may live, by top-level folder. */
const PLACEMENT: Readonly<Record<string, readonly string[]>> = {
  src: ['.ts'],
  test: ['.ts', '.json'],
  fixtures: ['.json', '.html', '.txt'],
}
const TOP_LEVEL = new Set([PACKAGE_MANIFEST, 'README.md'])

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
  } catch {
    throw new PackageError('manifest-invalid', 'not JSON')
  }
  const parsed = manifestSchema.safeParse(json)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const where = issue === undefined ? '' : issue.path.join('.')
    throw new PackageError('manifest-invalid', clip(`${where}: ${issue?.message ?? 'invalid'}`))
  }
  const manifest = parsed.data
  return {
    manifest,
    files: Object.freeze(files),
    adapterHash: adapterHashOf(files, manifest),
    packageHash: bundleHash(files),
  }
}

/**
 * The hash approvals and grants are keyed by: every file under src/ plus the parsed manifest,
 * canonicalised. The same formula the built-ins were hashed with before packages, so moving them
 * onto packages keeps their hashes.
 */
export function adapterHashOf(files: PackageFiles, manifest: AdapterManifest): string {
  const covered: Record<string, string> = {}
  for (const path of Object.keys(files)) {
    if (path.startsWith('src/')) covered[path] = files[path] as string
  }
  covered[MANIFEST_HASH_ENTRY] = canonicalJson(manifest)
  return bundleHash(covered)
}

/** A package from a manifest and sources, as the built-ins and tests make one. */
export function packageOf(manifest: AdapterManifest, files: PackageFiles): Record<string, string> {
  return { ...files, [PACKAGE_MANIFEST]: `${JSON.stringify(manifest, null, 2)}\n` }
}

function clip(text: string): string {
  return text.length > 120 ? `${text.slice(0, 117)}...` : text
}
