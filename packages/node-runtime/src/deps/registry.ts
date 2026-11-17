// Adding an npm dependency to a `raw` adapter (docs/node-runtime.md#dependencies), as
// valet_add_dependency does it: Valet itself asks the npm registry for the package, picks the
// newest version in the range that has been public for at least three days (most malicious
// releases are found and pulled within hours, the same rule this repository's own lockfile follows),
// downloads it, checks it against the registry's sha512 integrity, refuses it if it carries a
// native addon or can't run on a Mac, and does the same for everything it depends on. No install
// script ever runs, because nothing is installed: the tarballs are kept as data, by integrity, and
// the adapter's bundle is built from them when the draft is checked.

import {
  DEPENDENCY_LIMITS,
  type DependencyLock,
  dependencyLockSchema,
  isNpmName,
  type LockedPackage,
  packageKey,
  parsePackageKey,
} from '@valet/core'
import semver from 'semver'
import type { TarballStore } from './store'
import { checkIntegrity, TARBALL_LIMITS, TarballError, unpackTarball } from './tarball'

export const NPM_REGISTRY = 'https://registry.npmjs.org/'
/** A version must have been public this long before Valet picks it. */
export const MINIMUM_RELEASE_AGE_MS = 3 * 24 * 60 * 60 * 1000
/** The registry's document for one package can be large (every version's metadata). */
export const MAX_PACKUMENT_BYTES = 64 * 1024 * 1024
const FETCH_TIMEOUT_MS = 60_000

export class DependencyError extends Error {
  constructor(
    readonly rule:
      | 'name'
      | 'range'
      | 'not-found'
      | 'no-version'
      | 'too-new'
      | 'native-addon'
      | 'platform'
      | 'integrity'
      | 'too-large'
      | 'too-many'
      | 'registry',
    message: string,
  ) {
    super(message)
    this.name = 'DependencyError'
  }
}

export interface RegistryOptions {
  /** The registry's base URL, ending in `/`. Tests point it at a fake. */
  readonly registry?: string
  readonly fetch?: typeof fetch
  readonly now?: () => number
  readonly minimumReleaseAgeMs?: number
  /** The platform the runtime runs on, for packages that name `os` or `cpu`. */
  readonly os?: string
  readonly cpu?: string
}

interface VersionDoc {
  readonly version?: unknown
  readonly dist?: { readonly integrity?: unknown; readonly tarball?: unknown }
  readonly dependencies?: unknown
  readonly optionalDependencies?: unknown
  readonly peerDependencies?: unknown
  readonly peerDependenciesMeta?: unknown
  readonly os?: unknown
  readonly cpu?: unknown
  readonly gypfile?: unknown
  readonly license?: unknown
  readonly deprecated?: unknown
}

interface Packument {
  readonly versions: Readonly<Record<string, VersionDoc>>
  readonly time: Readonly<Record<string, string>>
}

export interface AddResult {
  readonly lock: DependencyLock
  /** The package the name resolved to, `name@version`. */
  readonly resolved: string
  /** Packages newly fetched for this addition. */
  readonly added: readonly string[]
  /** Packages no longer needed (an older version of this dependency, say). */
  readonly removed: readonly string[]
  /** Deprecation notices, for the author to see. */
  readonly warnings: readonly string[]
}

const stringRecord = (value: unknown): Record<string, string> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value)) if (typeof v === 'string') out[k] = v
  return out
}

const platformAllows = (list: unknown, value: string): boolean => {
  if (!Array.isArray(list) || list.length === 0) return true
  const entries = list.filter((x): x is string => typeof x === 'string')
  if (entries.includes(`!${value}`)) return false
  const positive = entries.filter((e) => !e.startsWith('!'))
  return positive.length === 0 || positive.includes(value)
}

async function readCapped(response: Response, cap: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? '0')
  if (declared > cap) throw new DependencyError('too-large', 'the registry’s answer is too large')
  const reader = response.body?.getReader()
  if (reader === undefined) return new Uint8Array(await response.arrayBuffer())
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > cap) {
      await reader.cancel().catch(() => undefined)
      throw new DependencyError('too-large', 'the registry’s answer is too large')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

/**
 * Adds `name` at `range` (an npm range, `latest` by default) to `lock`, or moves it to a newer
 * version in that range. Fetches and keeps every tarball it needs in `store`. The returned lock is
 * checked against dependencyLockSchema before it is returned.
 */
export async function addDependency(
  lock: DependencyLock,
  name: string,
  range: string | undefined,
  store: TarballStore,
  options: RegistryOptions = {},
): Promise<AddResult> {
  if (!isNpmName(name)) throw new DependencyError('name', `“${name.slice(0, 80)}” isn’t an npm package name`)
  const wanted = range === undefined || range === '' || range === 'latest' ? '*' : range
  if (wanted.length > 100 || semver.validRange(wanted) === null)
    throw new DependencyError('range', `“${wanted.slice(0, 80)}” isn’t a version range npm understands`)
  const registry = options.registry ?? NPM_REGISTRY
  const registryUrl = new URL(registry)
  const doFetch = options.fetch ?? fetch
  const now = options.now ?? Date.now
  const minimumAge = options.minimumReleaseAgeMs ?? MINIMUM_RELEASE_AGE_MS
  const os = options.os ?? 'darwin'
  const cpu = options.cpu ?? (process.arch === 'x64' ? 'x64' : 'arm64')

  const packuments = new Map<string, Promise<Packument>>()
  const packument = (pkg: string): Promise<Packument> => {
    let pending = packuments.get(pkg)
    if (pending === undefined) {
      pending = (async () => {
        const url = new URL(pkg.startsWith('@') ? `@${encodeURIComponent(pkg.slice(1))}` : pkg, registryUrl)
        const response = await doFetch(url, {
          headers: { accept: 'application/json' },
          redirect: 'error',
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        }).catch(() => {
          throw new DependencyError('registry', 'the npm registry couldn’t be reached')
        })
        if (response.status === 404)
          throw new DependencyError('not-found', `npm has no package called ${pkg}`)
        if (!response.ok)
          throw new DependencyError('registry', `the npm registry answered ${response.status}`)
        let doc: unknown
        try {
          doc = JSON.parse(Buffer.from(await readCapped(response, MAX_PACKUMENT_BYTES)).toString('utf8'))
        } catch (error) {
          if (error instanceof DependencyError) throw error
          throw new DependencyError('registry', 'the npm registry’s answer wasn’t JSON')
        }
        const d = doc as { versions?: unknown; time?: unknown }
        if (d.versions === null || typeof d.versions !== 'object')
          throw new DependencyError('registry', `the registry’s document for ${pkg} has no versions`)
        return {
          versions: d.versions as Record<string, VersionDoc>,
          time: stringRecord(d.time),
        }
      })()
      packuments.set(pkg, pending)
    }
    return pending
  }

  const pick = async (pkg: string, wantedRange: string): Promise<{ version: string; doc: VersionDoc }> => {
    const doc = await packument(pkg)
    const candidates = Object.keys(doc.versions)
      .filter((v) => semver.valid(v) !== null && semver.satisfies(v, wantedRange))
      .sort(semver.rcompare)
    if (candidates.length === 0)
      throw new DependencyError('no-version', `${pkg} has no version in ${wantedRange}`)
    for (const version of candidates) {
      const published = Date.parse(doc.time[version] ?? '')
      if (!Number.isFinite(published) || now() - published < minimumAge) continue
      const versionDoc = doc.versions[version]
      if (versionDoc !== undefined) return { version, doc: versionDoc }
    }
    throw new DependencyError(
      'too-new',
      `every version of ${pkg} in ${wantedRange} was published less than three days ago; Valet waits three days before it uses a release`,
    )
  }

  const packages: Record<string, LockedPackage> = { ...lock.packages }
  const fetched = new Map<string, Uint8Array>()
  const added: string[] = []
  const warnings: string[] = []

  const fetchPackage = async (pkg: string, version: string, doc: VersionDoc): Promise<LockedPackage> => {
    const integrity = typeof doc.dist?.integrity === 'string' ? doc.dist.integrity : ''
    const tarball = typeof doc.dist?.tarball === 'string' ? doc.dist.tarball : ''
    if (!integrity.startsWith('sha512-'))
      throw new DependencyError('integrity', `${pkg}@${version} has no sha512 integrity in the registry`)
    let tarballUrl: URL
    try {
      tarballUrl = new URL(tarball)
    } catch {
      throw new DependencyError('registry', `${pkg}@${version} has no tarball URL`)
    }
    // Only from the registry itself, never wherever a document points.
    if (tarballUrl.origin !== registryUrl.origin || tarballUrl.username !== '' || tarballUrl.password !== '')
      throw new DependencyError('registry', `${pkg}@${version}’s tarball isn’t on the registry`)
    if (doc.gypfile === true)
      throw new DependencyError('native-addon', `${pkg}@${version} builds a native addon`)
    let bytes = fetched.get(integrity) ?? (await store.get(integrity))
    if (bytes === null) {
      const response = await doFetch(tarballUrl, {
        redirect: 'error',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      }).catch(() => {
        throw new DependencyError('registry', 'the npm registry couldn’t be reached')
      })
      if (!response.ok)
        throw new DependencyError('registry', `the registry answered ${response.status} for ${pkg}`)
      bytes = await readCapped(response, TARBALL_LIMITS.compressedBytes)
      try {
        checkIntegrity(bytes, integrity)
        // Unpacked once here so a native addon or a malformed tarball is refused now, not at check.
        const files = unpackTarball(bytes)
        let manifest: { name?: unknown; version?: unknown } | null = null
        try {
          manifest = JSON.parse(Buffer.from(files.get('package.json') ?? []).toString('utf8'))
        } catch {}
        if (manifest?.name !== pkg || manifest?.version !== version)
          throw new DependencyError('integrity', `${pkg}@${version}’s tarball holds another package`)
      } catch (error) {
        if (error instanceof TarballError) {
          if (error.rule === 'native-addon')
            throw new DependencyError(
              'native-addon',
              `${pkg}@${version} carries a native addon (${error.detail})`,
            )
          if (error.rule === 'integrity')
            throw new DependencyError('integrity', `${pkg}@${version} doesn’t match its integrity`)
          throw new DependencyError(
            error.rule === 'too-large' ? 'too-large' : 'registry',
            `${pkg}@${version}: ${error.message}`,
          )
        }
        throw error
      }
      // Kept only once the whole addition has succeeded.
      fetched.set(integrity, bytes)
    }
    return {
      integrity,
      tarball: tarballUrl.href,
      dependencies: {},
      ...(typeof doc.license === 'string' ? { license: doc.license.slice(0, 100) } : {}),
    }
  }

  /** Resolves `pkg` at `wantedRange` for one importer, reusing a version already in the graph. */
  const resolve = async (pkg: string, wantedRange: string, optional: boolean): Promise<string | null> => {
    if (!isNpmName(pkg)) {
      if (optional) return null
      throw new DependencyError('name', `a dependency is called “${pkg.slice(0, 80)}”`)
    }
    const existing = Object.keys(packages)
      .map((k) => parsePackageKey(k))
      .filter((p): p is { name: string; version: string } => p !== null && p.name === pkg)
      .filter((p) => semver.satisfies(p.version, wantedRange))
      .sort((a, b) => semver.rcompare(a.version, b.version))[0]
    if (existing !== undefined) return packageKey(existing.name, existing.version)
    try {
      const { version, doc } = await pick(pkg, wantedRange)
      if (!platformAllows(doc.os, os) || !platformAllows(doc.cpu, cpu))
        throw new DependencyError('platform', `${pkg}@${version} doesn’t run on a Mac`)
      const key = packageKey(pkg, version)
      if (Object.keys(packages).length >= DEPENDENCY_LIMITS.packages)
        throw new DependencyError(
          'too-many',
          `an adapter may have at most ${DEPENDENCY_LIMITS.packages} packages`,
        )
      // Claimed before its own dependencies are walked, so a cycle ends here.
      packages[key] = { integrity: '', tarball: '', dependencies: {} }
      try {
        packages[key] = await fetchPackage(pkg, version, doc)
      } catch (error) {
        delete packages[key]
        throw error
      }
      added.push(key)
      if (typeof doc.deprecated === 'string')
        warnings.push(`${key} is deprecated: ${doc.deprecated.slice(0, 200)}`)
      const deps: Record<string, string> = {}
      const peerMeta = stringMetaOptional(doc.peerDependenciesMeta)
      const wants: [string, string, boolean][] = [
        ...Object.entries(stringRecord(doc.dependencies)).map(([n, r]): [string, string, boolean] => [
          n,
          r,
          false,
        ]),
        ...Object.entries(stringRecord(doc.peerDependencies))
          .filter(([n]) => !Object.hasOwn(stringRecord(doc.dependencies), n))
          .map(([n, r]): [string, string, boolean] => [n, r, peerMeta.has(n)]),
        ...Object.entries(stringRecord(doc.optionalDependencies)).map(([n, r]): [string, string, boolean] => [
          n,
          r,
          true,
        ]),
      ]
      for (const [depName, depRange, depOptional] of wants) {
        if (depRange.length > 100 || semver.validRange(depRange) === null) {
          // A git, file or URL dependency: Valet takes packages from the registry only.
          if (depOptional) continue
          throw new DependencyError('range', `${key} depends on ${depName} from outside the npm registry`)
        }
        const target = await resolve(depName, depRange, depOptional)
        if (target !== null) deps[depName] = target
      }
      packages[key] = { ...(packages[key] as LockedPackage), dependencies: deps }
      return key
    } catch (error) {
      if (optional && error instanceof DependencyError && error.rule !== 'too-many') return null
      throw error
    }
  }

  const resolved = await resolve(name, wanted, false)
  if (resolved === null) throw new DependencyError('no-version', `${name} couldn’t be added`)
  const dependencies = { ...lock.dependencies, [name]: { range: wanted, resolved } }
  if (Object.keys(dependencies).length > DEPENDENCY_LIMITS.direct)
    throw new DependencyError(
      'too-many',
      `an adapter may have at most ${DEPENDENCY_LIMITS.direct} direct dependencies`,
    )
  // Drop what nothing reaches any more (the version this one replaced, and its own dependencies).
  const reachable = new Set<string>()
  const walk = (key: string): void => {
    if (reachable.has(key)) return
    reachable.add(key)
    for (const next of Object.values(packages[key]?.dependencies ?? {})) walk(next)
  }
  for (const entry of Object.values(dependencies)) walk(entry.resolved)
  const removed = Object.keys(packages).filter((k) => !reachable.has(k))
  for (const key of removed) delete packages[key]
  const next = dependencyLockSchema.parse({ lockfileVersion: 1, dependencies, packages })
  for (const [key, entry] of Object.entries(next.packages)) {
    const bytes = fetched.get(entry.integrity)
    if (bytes !== undefined && added.includes(key)) await store.put(entry.integrity, bytes)
  }
  return { lock: next, resolved, added: added.filter((k) => reachable.has(k)), removed, warnings }
}

/** Removes a direct dependency and whatever only it needed. */
export function removeDependency(lock: DependencyLock, name: string): DependencyLock {
  const dependencies = { ...lock.dependencies }
  delete dependencies[name]
  const reachable = new Set<string>()
  const walk = (key: string): void => {
    if (reachable.has(key)) return
    reachable.add(key)
    for (const next of Object.values(lock.packages[key]?.dependencies ?? {})) walk(next)
  }
  for (const entry of Object.values(dependencies)) walk(entry.resolved)
  const packages = Object.fromEntries(Object.entries(lock.packages).filter(([k]) => reachable.has(k)))
  return dependencyLockSchema.parse({ lockfileVersion: 1, dependencies, packages })
}

function stringMetaOptional(meta: unknown): Set<string> {
  const out = new Set<string>()
  if (meta === null || typeof meta !== 'object') return out
  for (const [k, v] of Object.entries(meta)) {
    if (v !== null && typeof v === 'object' && (v as { optional?: unknown }).optional === true) out.add(k)
  }
  return out
}
