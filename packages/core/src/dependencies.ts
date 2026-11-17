// A `raw` adapter's npm dependencies (docs/node-runtime.md#dependencies): the lockfile that sits at
// the top of its package, `valet-lock.json`. It names every package the adapter's bundle is built
// from by exact version and sha512 integrity, so the adapter hash covers the exact code of every
// dependency without carrying it: the tarballs live in Valet's own store, keyed by integrity, and
// are checked against this file every time they are read.
//
// Only Valet writes it (valet_add_dependency), but an author may write it by hand too, so it is
// checked here like the rest of the package: names, versions, integrities, a graph with no
// dangling references, and size limits.

import { z } from 'zod'

export const DEPENDENCY_LOCK = 'valet-lock.json'

export const DEPENDENCY_LIMITS = {
  /** Direct dependencies. */
  direct: 20,
  /** Every package in the graph. */
  packages: 300,
} as const

/** npm's rules for a package name, as npm itself applies them to new packages. */
export const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/
/** A version as npm publishes it: strict semver, with an optional prerelease and build. */
export const NPM_VERSION =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
export const SHA512_INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/

export function isNpmName(name: string): boolean {
  return name.length <= 214 && NPM_NAME.test(name) && !name.endsWith('.') && !/(^|\/)\.\.?$/.test(name)
}

/** `name@version`, the key each package has in the lockfile. */
export function packageKey(name: string, version: string): string {
  return `${name}@${version}`
}

/** Splits a key into its name and version, or null if it isn't one. */
export function parsePackageKey(key: string): { readonly name: string; readonly version: string } | null {
  const at = key.lastIndexOf('@')
  if (at <= 0) return null
  const name = key.slice(0, at)
  const version = key.slice(at + 1)
  if (!isNpmName(name) || !NPM_VERSION.test(version) || version.length > 100) return null
  return { name, version }
}

const name = z.string().refine(isNpmName, 'not an npm package name')
const key = z.string().refine((k) => parsePackageKey(k) !== null, 'not name@version')

export const lockedPackageSchema = z
  .object({
    integrity: z.string().regex(SHA512_INTEGRITY, 'must be a sha512 integrity'),
    /** Where Valet fetched it from: the registry's tarball URL. */
    tarball: z
      .string()
      .max(500)
      .refine((u) => {
        try {
          const url = new URL(u)
          return url.protocol === 'https:' && url.username === '' && url.password === ''
        } catch {
          return false
        }
      }, 'must be an https URL'),
    /** Each dependency of this package, by name, to the key it resolved to. */
    dependencies: z.record(name, key).default({}),
    license: z.string().max(100).optional(),
  })
  .strict()

export const dependencyLockSchema = z
  .object({
    lockfileVersion: z.literal(1),
    /** The adapter's own dependencies: the range asked for, and the package it resolved to. */
    dependencies: z.record(name, z.object({ range: z.string().min(1).max(100), resolved: key }).strict()),
    packages: z.record(key, lockedPackageSchema),
  })
  .strict()
  .superRefine((lock, ctx) => {
    const direct = Object.keys(lock.dependencies)
    const all = Object.keys(lock.packages)
    if (direct.length > DEPENDENCY_LIMITS.direct)
      ctx.addIssue({ code: 'custom', message: `at most ${DEPENDENCY_LIMITS.direct} direct dependencies` })
    if (all.length > DEPENDENCY_LIMITS.packages)
      ctx.addIssue({ code: 'custom', message: `at most ${DEPENDENCY_LIMITS.packages} packages in all` })
    const refer = (from: string, depName: string, target: string): void => {
      if (!Object.hasOwn(lock.packages, target))
        ctx.addIssue({ code: 'custom', message: `${from} needs ${target}, which isn't in packages` })
      else if (parsePackageKey(target)?.name !== depName)
        ctx.addIssue({ code: 'custom', message: `${from} names ${depName} but resolves it to ${target}` })
    }
    for (const [depName, entry] of Object.entries(lock.dependencies))
      refer('the adapter', depName, entry.resolved)
    for (const [pkg, entry] of Object.entries(lock.packages))
      for (const [depName, target] of Object.entries(entry.dependencies)) refer(pkg, depName, target)
    // Every package is reachable from the adapter's own: nothing rides along unlisted on the card.
    const seen = new Set<string>()
    const walk = (k: string): void => {
      if (seen.has(k) || !Object.hasOwn(lock.packages, k)) return
      seen.add(k)
      for (const next of Object.values(lock.packages[k]?.dependencies ?? {})) walk(next)
    }
    for (const entry of Object.values(lock.dependencies)) walk(entry.resolved)
    for (const k of all)
      if (!seen.has(k)) ctx.addIssue({ code: 'custom', message: `${k} isn't needed by anything` })
  })

export type DependencyLock = z.output<typeof dependencyLockSchema>
export type LockedPackage = z.output<typeof lockedPackageSchema>

/** What the approval card says about dependencies: the direct ones by name, and a count of the rest. */
export interface DependencySummary {
  readonly direct: readonly { readonly name: string; readonly version: string }[]
  readonly others: number
}

export function dependencySummary(lock: DependencyLock | null): DependencySummary {
  if (lock === null) return { direct: [], others: 0 }
  const direct = Object.entries(lock.dependencies)
    .map(([n, entry]) => ({ name: n, version: parsePackageKey(entry.resolved)?.version ?? '' }))
    .sort((a, b) => a.name.localeCompare(b.name))
  const directKeys = new Set(Object.values(lock.dependencies).map((e) => e.resolved))
  return { direct, others: Object.keys(lock.packages).filter((k) => !directKeys.has(k)).length }
}

/** An empty lockfile, before the first dependency is added. */
export const EMPTY_LOCK: DependencyLock = { lockfileVersion: 1, dependencies: {}, packages: {} }
