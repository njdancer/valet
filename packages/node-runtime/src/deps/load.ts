// The dependency files a `raw` adapter's bundle is built from (docs/node-runtime.md#dependencies):
// each package in its lockfile, read from the tarball store, checked against its integrity again,
// and unpacked into memory. A tarball the store doesn't have is fetched again from where the lockfile
// says, only when the caller allows it, and only from the registry.

import { type DependencyLock, parsePackageKey } from '@valet/core'
import { DependencyError, NPM_REGISTRY } from './registry'
import type { TarballStore } from './store'
import { bundleableFiles, checkIntegrity, TARBALL_LIMITS, TarballError, unpackTarball } from './tarball'

/** Package key (`name@version`) to its JavaScript and JSON files, by path inside the package. */
export type DependencyFiles = Readonly<Record<string, Readonly<Record<string, string>>>>

export interface LoadOptions {
  /** Fetch a tarball the store lacks from the registry. Off unless the caller says. */
  readonly fetchMissing?: boolean
  readonly registry?: string
  readonly fetch?: typeof fetch
}

export async function loadDependencies(
  lock: DependencyLock | null,
  store: TarballStore,
  options: LoadOptions = {},
): Promise<DependencyFiles> {
  const out: Record<string, Record<string, string>> = {}
  if (lock === null) return out
  const registry = new URL(options.registry ?? NPM_REGISTRY)
  for (const [key, entry] of Object.entries(lock.packages)) {
    let bytes = await store.get(entry.integrity)
    if (bytes === null) {
      const url = new URL(entry.tarball)
      if (!options.fetchMissing || url.origin !== registry.origin)
        throw new DependencyError(
          'not-found',
          `${key} isn’t in Valet’s store; add it again with valet_add_dependency`,
        )
      const response = await (options.fetch ?? fetch)(url, { redirect: 'error' }).catch(() => null)
      if (response === null || !response.ok)
        throw new DependencyError('registry', `${key} couldn’t be fetched from the npm registry`)
      const fetched = new Uint8Array(await response.arrayBuffer())
      if (fetched.byteLength > TARBALL_LIMITS.compressedBytes) throw new DependencyError('too-large', key)
      try {
        checkIntegrity(fetched, entry.integrity)
      } catch {
        throw new DependencyError('integrity', `${key} doesn’t match its integrity`)
      }
      await store.put(entry.integrity, fetched)
      bytes = fetched
    }
    let files: ReturnType<typeof bundleableFiles>
    try {
      files = bundleableFiles(unpackTarball(bytes))
    } catch (error) {
      if (error instanceof TarballError && error.rule === 'native-addon')
        throw new DependencyError('native-addon', `${key} carries a native addon (${error.detail})`)
      throw error
    }
    // The approval card names packages from the lockfile, so the code must be what the key says: a
    // hand-written lockfile can't put one package's tarball under another's name.
    const named = parsePackageKey(key)
    const manifest = parseManifest(files['package.json'])
    if (named === null || manifest?.name !== named.name || manifest?.version !== named.version)
      throw new DependencyError('integrity', `${key} isn’t the package its tarball holds`)
    out[key] = files
  }
  return out
}

function parseManifest(text: string | undefined): { name?: unknown; version?: unknown } | null {
  try {
    const parsed: unknown = JSON.parse(text ?? 'null')
    return typeof parsed === 'object' ? (parsed as { name?: unknown; version?: unknown } | null) : null
  } catch {
    return null
  }
}
