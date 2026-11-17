// The less travelled paths of the runtime and the dependency code: declared paths that don't exist,
// read-write paths, peers, a graph holding two versions of one package, registries that fail
// midway, and the store and loader when a tarball is missing.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compileNodePackage } from '@valet/adapter-store'
import { dependencySummary, EMPTY_LOCK, ValetError } from '@valet/core'
import { runIsolated } from '@valet/runtime'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadDependencies } from '../src/deps/load'
import { addDependency, DependencyError, removeDependency } from '../src/deps/registry'
import { diskTarballStore, memoryTarballStore } from '../src/deps/store'
import { nodeRuntimeProcess } from '../src/spawn'
import { context, forwardingTunnels, mac, scriptFor } from './helpers'
import { fakeRegistry, testFetch } from './registry-fake'

let npm: Awaited<ReturnType<typeof fakeRegistry>>
let folder = ''

beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), 'edges-'))
  const file = (content: string) => [{ path: 'index.js', content }]
  npm = await fakeRegistry({
    shared: { '1.0.0': { files: file('exports.v = 1') }, '1.1.0': { files: file('exports.v = 2') } },
    'needs-new': { '1.0.0': { packageJson: { dependencies: { shared: '1.1.0' } }, files: file('1') } },
    'needs-any': { '1.0.0': { packageJson: { dependencies: { shared: '^1.0.0' } }, files: file('1') } },
    'with-peers': {
      '1.0.0': {
        packageJson: {
          peerDependencies: { shared: '^1.0.0', 'missing-peer': '^1.0.0' },
          peerDependenciesMeta: { 'missing-peer': { optional: true } },
        },
        files: file('1'),
      },
    },
  })
})
afterAll(async () => {
  npm.close()
  await rm(folder, { recursive: true, force: true })
})

const options = () => ({ registry: npm.registry, fetch: testFetch })
const refusal = (p: Promise<unknown>) =>
  p.then(
    () => 'added',
    (e: unknown) => (e instanceof DependencyError ? e.rule : String(e)),
  )

describe('dependencies, off the main path', () => {
  it('reuses the newest of two versions already in the graph, and follows peers', async () => {
    const store = memoryTarballStore()
    let lock = (await addDependency(EMPTY_LOCK, 'shared', '1.0.0', store, options())).lock
    lock = (await addDependency(lock, 'needs-new', undefined, store, options())).lock
    expect(Object.keys(lock.packages).sort()).toEqual(['needs-new@1.0.0', 'shared@1.0.0', 'shared@1.1.0'])
    lock = (await addDependency(lock, 'needs-any', undefined, store, options())).lock
    expect(lock.packages['needs-any@1.0.0']?.dependencies).toEqual({ shared: 'shared@1.1.0' })
    const peers = await addDependency(lock, 'with-peers', undefined, store, options())
    // The optional peer that doesn't exist is skipped; the required one is reused.
    expect(peers.lock.packages['with-peers@1.0.0']?.dependencies).toEqual({ shared: 'shared@1.1.0' })
    expect(dependencySummary(peers.lock).direct.map((d) => d.name)).toEqual([
      'needs-any',
      'needs-new',
      'shared',
      'with-peers',
    ])
    // Removing one direct dependency keeps what the others still need.
    const removed = removeDependency(peers.lock, 'needs-new')
    expect(Object.keys(removed.packages).sort()).toEqual([
      'needs-any@1.0.0',
      'shared@1.0.0',
      'shared@1.1.0',
      'with-peers@1.0.0',
    ])
  })

  it('refuses when the tarball can’t be fetched, or streams past the cap', async () => {
    const tarballs = (answer: (url: string) => Promise<Response>) =>
      ((input: string | URL, init?: RequestInit) =>
        String(input).endsWith('.tgz') ? answer(String(input)) : testFetch(input, init)) as typeof fetch
    const unreachable = tarballs(() => Promise.reject(new TypeError('network')))
    expect(
      await refusal(
        addDependency(EMPTY_LOCK, 'shared', undefined, memoryTarballStore(), {
          ...options(),
          fetch: unreachable,
        }),
      ),
    ).toBe('registry')
    const endless = tarballs(async () => {
      const chunk = new Uint8Array(1024 * 1024)
      let sent = 0
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          sent += 1
          if (sent > 40) controller.close()
          else controller.enqueue(chunk)
        },
      })
      return new Response(body, { status: 200 })
    })
    expect(
      await refusal(
        addDependency(EMPTY_LOCK, 'shared', undefined, memoryTarballStore(), {
          ...options(),
          fetch: endless,
        }),
      ),
    ).toBe('too-large')
  })

  it('loads nothing it can’t find: a disk store without the tarball, a registry that fails', async () => {
    const lock = (await addDependency(EMPTY_LOCK, 'shared', '1.0.0', memoryTarballStore(), options())).lock
    const disk = diskTarballStore(join(folder, 'store'))
    const entry = lock.packages['shared@1.0.0']
    expect(entry && (await disk.get(entry.integrity))).toBeNull()
    const failing = (() => Promise.reject(new TypeError('network'))) as unknown as typeof fetch
    expect(
      await refusal(
        loadDependencies(lock, disk, { fetchMissing: true, registry: npm.registry, fetch: failing }),
      ),
    ).toBe('registry')
  })

  it('bundles with the shared compiler', async () => {
    const store = memoryTarballStore()
    const lock = (await addDependency(EMPTY_LOCK, 'shared', '1.1.0', store, options())).lock
    const script = await compileNodePackage(
      { 'src/tools.ts': "import { v } from 'shared'\nexport const tools = { v }" },
      lock,
      await loadDependencies(lock, store),
    )
    expect(script).toContain('exports.v = 2')
  })
})

describe('the runtime, off the main path', () => {
  it('refuses a declared path that doesn’t exist, and runs with read-write paths and more forbidden places', async () => {
    const script = await scriptFor('probes.ts')
    const start = (extra: object) =>
      nodeRuntimeProcess({
        nodeBinary: process.execPath,
        endpoints: [],
        openTunnels: forwardingTunnels({}),
        home: join(folder, 'no-such-home'),
        withoutSeatbelt: !mac,
        ...extra,
      })
    const failure = (p: Promise<unknown>) =>
      p.then(
        () => 'succeeded',
        (e: unknown) => (e instanceof ValetError ? `${e.stage}/${e.errorClass}` : String(e)),
      )
    // The call fails as any start failure does; the reason goes to stderr.
    const stderr: string[] = []
    const missing = start({
      readWritePaths: [join(folder, 'missing')],
      onStderr: (t: string) => stderr.push(t),
    })
    expect(await failure(runIsolated(missing, script, context(), 'echo', {}))).toBe('tool-run/internal')
    expect(stderr.join('')).toContain('valet: tool-run/unavailable')
    const ok = start({ readWritePaths: [folder], alsoForbidden: [join(folder, 'never')] })
    expect(await failure(runIsolated(ok, script, context(), 'echo', { text: 'hi' }))).toBe('succeeded')
  })
})
