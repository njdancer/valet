// @vitest-environment node
// Red team (workstream H): the installed adapter hash, and an approved snapshot's integrity check,
// now cover a raw adapter's valet-lock.json as core's package hash does (lockHashEntry). Approvals
// and grants are keyed by that hash, so: a lockfile that names other code must change it, the
// reserved entries can't be smuggled in as files, a snapshot whose lock was changed on disk isn't
// intact, and a package without a lock (every built-in) hashes exactly as before.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type AdapterDefinition,
  adapterHashOf,
  bundleHash,
  canonicalJson,
  checkPackage,
  DEPENDENCY_LOCK,
  LOCK_HASH_ENTRY,
  MANIFEST_HASH_ENTRY,
  parseManifest,
} from '@valet/core'
import { describe, expect, it } from 'vitest'
import { builtinAdapter, MANIFEST_ENTRY, snapshotIntact } from '../../src/main/core/registry'

const EXAMPLE = join(import.meta.dirname, '..', '..', '..', '..', 'examples', 'cache-reader')
const manifestText = readFileSync(join(EXAMPLE, 'manifest.json'), 'utf8')
const manifest = parseManifest(JSON.parse(manifestText))
const sources = {
  'src/tools.ts': readFileSync(join(EXAMPLE, 'src', 'tools.ts'), 'utf8'),
  'src/resp.ts': readFileSync(join(EXAMPLE, 'src', 'resp.ts'), 'utf8'),
}
const definition = { manifest, tools: {} } as unknown as AdapterDefinition

const integrity = (c: string) => `sha512-${c.repeat(86)}==`
function lock(parserIntegrity = integrity('A'), errorsIntegrity = integrity('B')) {
  return {
    lockfileVersion: 1,
    dependencies: { 'redis-parser': { range: '3.0.0', resolved: 'redis-parser@3.0.0' } },
    packages: {
      'redis-parser@3.0.0': {
        integrity: parserIntegrity,
        tarball: 'https://registry.npmjs.org/redis-parser/-/redis-parser-3.0.0.tgz',
        dependencies: { 'redis-errors': 'redis-errors@1.2.0' },
      },
      'redis-errors@1.2.0': {
        integrity: errorsIntegrity,
        tarball: 'https://registry.npmjs.org/redis-errors/-/redis-errors-1.2.0.tgz',
        dependencies: {},
      },
    },
  }
}
const LOCK = `${JSON.stringify(lock(), null, 2)}\n`

const pkg = (lockText: string | null) => ({
  'manifest.json': manifestText,
  ...sources,
  ...(lockText === null ? {} : { [DEPENDENCY_LOCK]: lockText }),
})
const installedHash = (lockText: string | null) =>
  builtinAdapter(definition, { ...sources, ...(lockText === null ? {} : { [DEPENDENCY_LOCK]: lockText }) })
    .hash

describe('the installed hash covers a raw adapter’s lockfile', () => {
  it('agrees with the package’s own adapter hash, with and without a lock', () => {
    expect(checkPackage(pkg(LOCK)).adapterHash).toBe(installedHash(LOCK))
    expect(adapterHashOf(pkg(LOCK), manifest)).toBe(installedHash(LOCK))
    expect(checkPackage(pkg(null)).adapterHash).toBe(installedHash(null))
  })

  it('changes when the lock names other code: a swapped integrity, an added or removed lock', () => {
    const base = installedHash(LOCK)
    // The transitive dependency's tarball swapped: different code, so a different approval.
    expect(installedHash(JSON.stringify(lock(integrity('A'), integrity('C'))))).not.toBe(base)
    expect(installedHash(JSON.stringify(lock(integrity('D'))))).not.toBe(base)
    expect(installedHash(null)).not.toBe(base)
    expect(installedHash(`${LOCK} `)).toBe(base) // only formatting: the same lock
    const empty = JSON.stringify({ lockfileVersion: 1, dependencies: {}, packages: {} })
    expect(installedHash(empty)).not.toBe(installedHash(null))
  })

  it('a lock whose parsed content is the same as another’s is the same code (duplicate keys parse once)', () => {
    // JSON.parse keeps the last of a repeated key, and so does every reader of the lock (checkLock,
    // loadDependencies get the parsed lock), so a text that hashes the same can't load other code.
    const text = LOCK.replace(
      '"integrity": "sha512-',
      `"integrity": "${integrity('Z')}", "integrity": "sha512-`,
    )
    expect(text).not.toBe(LOCK)
    expect(installedHash(text)).toBe(installedHash(LOCK))
    expect(checkPackage(pkg(text)).dependencies).toEqual(checkPackage(pkg(LOCK)).dependencies)
  })

  it('hashes a package without a lock exactly as the old formula did, so built-in approvals stand', () => {
    expect(installedHash(null)).toBe(bundleHash({ ...sources, [MANIFEST_ENTRY]: canonicalJson(manifest) }))
    expect(MANIFEST_ENTRY).toBe(MANIFEST_HASH_ENTRY)
  })

  it('refuses the reserved entries as files, so a source can’t stand in for the lock or the manifest', () => {
    const lockEntry = canonicalJson(lock())
    expect(() => builtinAdapter(definition, { ...sources, [LOCK_HASH_ENTRY]: lockEntry })).toThrow(
      'reserved bundle entry',
    )
    expect(() =>
      builtinAdapter(definition, { ...sources, [MANIFEST_ENTRY]: canonicalJson(manifest) }),
    ).toThrow('reserved bundle entry')
    // And a package can't carry them as paths at all.
    expect(() => checkPackage({ ...pkg(LOCK), [LOCK_HASH_ENTRY]: lockEntry })).toThrow()
  })
})

describe('an approved snapshot with a lock', () => {
  const adapter = builtinAdapter(definition, { ...sources, [DEPENDENCY_LOCK]: LOCK })
  const snapshot = {
    hash: adapter.hash,
    version: manifest.version,
    approvedAt: new Date(0).toISOString(),
    manifest,
    files: adapter.files,
  }

  it('is intact as stored', () => {
    expect(adapter.files[DEPENDENCY_LOCK]).toBe(LOCK)
    expect(snapshotIntact(snapshot)).toBe(true)
  })

  it('is not intact once its lock names other code, loses its lock, or gains one', () => {
    const swapped = JSON.stringify(lock(integrity('E')))
    expect(snapshotIntact({ ...snapshot, files: { ...snapshot.files, [DEPENDENCY_LOCK]: swapped } })).toBe(
      false,
    )
    const { [DEPENDENCY_LOCK]: _gone, ...without } = snapshot.files
    expect(snapshotIntact({ ...snapshot, files: without })).toBe(false)
    const plain = builtinAdapter(definition, sources)
    expect(
      snapshotIntact({
        ...snapshot,
        hash: plain.hash,
        files: { ...plain.files, [DEPENDENCY_LOCK]: LOCK },
      }),
    ).toBe(false)
  })

  it('is not intact with the lock smuggled under its hash entry instead of its file', () => {
    // The same bytes bundleHash sees, laid out as files: it must not pass as the approved version.
    const { [DEPENDENCY_LOCK]: _lock, ...rest } = snapshot.files
    expect(
      snapshotIntact({ ...snapshot, files: { ...rest, [LOCK_HASH_ENTRY]: canonicalJson(lock()) } }),
    ).toBe(false)
  })

  it('is not intact when the manifest says something else (a different manifest, same files)', () => {
    const wider = parseManifest({
      ...JSON.parse(manifestText),
      endpoints: ['cache.example.com:6380', 'evil.example.com:6380'],
    })
    expect(snapshotIntact({ ...snapshot, manifest: wider })).toBe(false)
  })
})
