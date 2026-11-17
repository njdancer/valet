// The red team's pass over the Node runtime (docs/node-runtime.md#red-team): what hostile adapter
// code, a hostile package or a hand-written lockfile would try, each checked to be refused. Each
// test here was written against a finding; the fix is in the code it names.

import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { npmResolver } from '@valet/adapter-store'
import { checkLock, EMPTY_LOCK, ValetError } from '@valet/core'
import { runIsolated } from '@valet/runtime'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadDependencies } from '../../src/deps/load'
import { addDependency, DependencyError } from '../../src/deps/registry'
import { memoryTarballStore } from '../../src/deps/store'
import { type NodeRuntimeOptions, nodeRuntimeProcess } from '../../src/spawn'
import type { TunnelSet } from '../../src/tunnels'
import { context, forwardingTunnels, mac, scriptFor, tcpServer } from '../helpers'
import { fakeRegistry, testFetch } from '../registry-fake'

let script = ''
let echo: Awaited<ReturnType<typeof tcpServer>>
let other: Awaited<ReturnType<typeof tcpServer>>
let npm: Awaited<ReturnType<typeof fakeRegistry>>

beforeAll(async () => {
  script = await scriptFor('attacks.ts')
  echo = await tcpServer('pong')
  other = await tcpServer('should never be reached')
  npm = await fakeRegistry({
    'nice-pkg': { '1.0.0': { files: [{ path: 'index.js', content: 'exports.nice = 1' }] } },
    'evil-pkg': { '1.0.0': { files: [{ path: 'index.js', content: 'exports.evil = 1' }] } },
    'evil-renamed': {
      '1.0.0': { packageJson: { name: 'nice-pkg' }, files: [{ path: 'index.js', content: '1' }] },
    },
  })
})
afterAll(() => {
  echo.close()
  other.close()
  npm.close()
})

function runtime(overrides: Partial<NodeRuntimeOptions> = {}) {
  const tunnels = forwardingTunnels({ 'echo.example.test:7000': { host: '127.0.0.1', port: echo.port } })
  const start = nodeRuntimeProcess({
    nodeBinary: process.execPath,
    endpoints: ['echo.example.test:7000'],
    openTunnels: tunnels,
    home: homedir(),
    withoutSeatbelt: !mac,
    ...overrides,
  })
  const run = (tool: string, input: unknown = {}) => runIsolated(start, script, context(), tool, input)
  return { start, run, tunnels }
}

const failure = (p: Promise<unknown>) =>
  p.then(
    () => 'succeeded',
    (e: unknown) => (e instanceof ValetError ? `${e.stage}/${e.errorClass}` : String(e)),
  )

const refusal = (p: Promise<unknown>) =>
  p.then(
    () => 'added',
    (e: unknown) => (e instanceof DependencyError ? e.rule : String(e)),
  )

const options = () => ({ registry: npm.registry, fetch: testFetch })

describe('hostile adapter code', () => {
  // Finding 1: --max-old-space-size caps V8's heap only, and Buffers live outside it, so an adapter
  // could take all of the Mac's memory. Fix: Valet samples the process's resident memory from
  // outside (spawn.ts, maxRssMb) and ends it over the cap.
  it('is ended when its memory outside the heap passes the cap', async () => {
    const r = runtime({ maxRssMb: 300 })
    const started = Date.now()
    expect(await failure(r.run('bufferHog'))).toBe('tool-run/internal')
    expect(Date.now() - started).toBeLessThan(20_000)
  })

  it('can’t reach an undeclared host or port around the shim', async () => {
    const r = runtime()
    const result = (await r.run('aroundTheShim', { port: other.port })) as Record<
      string,
      { ok: boolean; code?: string }
    >
    for (const [attempt, outcome] of Object.entries(result))
      expect({ attempt, ok: outcome.ok }).toEqual({ attempt, ok: false })
    expect(result['binding']?.code).toBe('ERR_ACCESS_DENIED')
    expect(other.received).toEqual([])
    expect(r.tunnels.stats.connections).toEqual([])
  })

  it('can’t reach other processes, native code or files outside its own folder', async () => {
    const result = (await runtime().run('outOfProcess', { home: homedir() })) as Record<
      string,
      { ok: boolean; code?: string }
    >
    for (const [attempt, outcome] of Object.entries(result)) {
      // Signal 0 to the parent only asks whether it exists; Seatbelt refuses it on macOS, and off
      // macOS (no Seatbelt) nothing else does, which the profile tests cover.
      if (attempt === 'killParent' && !mac) continue
      expect({ attempt, ok: outcome.ok }).toEqual({ attempt, ok: false })
    }
  })

  // Finding 2: a call ended while its process was still starting (the person cancels while the
  // broker opens the tunnels) left the tunnels and the temporary folder behind. Fix: start() cleans
  // up whatever it made after the call ended (spawn.ts).
  it('leaves no tunnels or folders behind when the call ends while it starts', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => {
      release = r
    })
    let closed = 0
    const slow = async (): Promise<TunnelSet> => {
      await gate
      return { ports: new Map([['echo.example.test:7000', echo.port]]), close: () => void closed++ }
    }
    // A temporary folder of this test's own, so other tests' processes don't show up in it.
    const saved = process.env['TMPDIR']
    const own = await mkdtemp(join(tmpdir(), 'redteam-'))
    process.env['TMPDIR'] = own
    try {
      const channel = runtime({ openTunnels: slow }).start()
      await new Promise((r) => setTimeout(r, 200))
      expect(await readdir(own)).toHaveLength(1)
      channel.kill()
      release()
      await new Promise((r) => setTimeout(r, 300))
      expect(closed).toBe(1)
      expect(await readdir(own)).toEqual([])
    } finally {
      if (saved === undefined) delete process.env['TMPDIR']
      else process.env['TMPDIR'] = saved
      await rm(own, { recursive: true, force: true })
    }
  })
})

describe('hostile packages and lockfiles', () => {
  // Finding 3: the approval card names packages from the lockfile, and a hand-written lockfile could
  // put one package's tarball under another's name (the store is keyed by integrity alone), so the
  // card would show "nice-pkg" while the bundle ran evil-pkg. Fix: the tarball's package.json must
  // match the key when it is loaded (deps/load.ts) and when it is added (deps/registry.ts).
  it('refuses a lockfile that puts one package’s code under another’s name', async () => {
    const store = memoryTarballStore()
    const nice = await addDependency(EMPTY_LOCK, 'nice-pkg', undefined, store, options())
    const evil = await addDependency(EMPTY_LOCK, 'evil-pkg', undefined, store, options())
    const forged = structuredClone(nice.lock)
    const niceEntry = forged.packages['nice-pkg@1.0.0']
    const evilEntry = evil.lock.packages['evil-pkg@1.0.0']
    if (niceEntry === undefined || evilEntry === undefined) throw new Error('setup')
    forged.packages['nice-pkg@1.0.0'] = { ...niceEntry, integrity: evilEntry.integrity }
    // It is a valid lockfile by its shape...
    expect(() => checkLock(JSON.stringify(forged), { runtime: 'raw' } as never)).not.toThrow()
    // ...but its code isn't what it says.
    expect(await refusal(loadDependencies(forged, store))).toBe('integrity')
    expect(Object.keys(await loadDependencies(nice.lock, store))).toEqual(['nice-pkg@1.0.0'])
  })

  it('refuses a registry tarball that holds a package of another name', async () => {
    const store = memoryTarballStore()
    expect(await refusal(addDependency(EMPTY_LOCK, 'evil-renamed', undefined, store, options()))).toBe(
      'integrity',
    )
    expect(store.size).toBe(0)
  })

  // Finding 4: an `imports` map entry naming another `#` entry was followed again, so two entries
  // naming each other overflowed the compile worker's stack. Node refuses such a target; so does
  // the resolver now (npm-resolve.ts).
  it('refuses an imports map that loops', () => {
    const lock = {
      lockfileVersion: 1,
      dependencies: { loop: { range: '1.0.0', resolved: 'loop@1.0.0' } },
      packages: { 'loop@1.0.0': { integrity: 'x', tarball: 'https://x', dependencies: {} } },
    }
    const packages = {
      'loop@1.0.0': {
        'package.json': JSON.stringify({ name: 'loop', imports: { '#a': '#b', '#b': '#a' } }),
        'index.js': "require('#a')",
      },
    }
    const resolver = npmResolver(lock, packages, [])
    expect(resolver.resolve('#a', { key: 'loop@1.0.0', path: 'index.js' }, 'require-call').error).toMatch(
      /has no #a/,
    )
  })
})
