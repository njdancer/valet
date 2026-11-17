// npm dependencies for raw adapters (docs/node-runtime.md#dependencies), against a fake registry:
// resolving and fetching with integrity, the release-age rule, what is refused (native addons,
// other platforms, tarballs off the registry, tampered bytes, links and paths that climb out), the
// lockfile and the store, and a bundle built from them running in the runtime.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Compiler } from '@valet/adapter-store'
import { checkLock, dependencyLockSchema, dependencySummary, EMPTY_LOCK, PackageError } from '@valet/core'
import { runIsolated } from '@valet/runtime'
import { buildToolLibrary } from '@valet/runtime/tool-script'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadDependencies } from '../src/deps/load'
import { addDependency, DependencyError, removeDependency } from '../src/deps/registry'
import { diskTarballStore, memoryTarballStore } from '../src/deps/store'
import { integrityOf, TarballError, unpackTarball } from '../src/deps/tarball'
import { nodeRuntimeProcess } from '../src/spawn'
import { context, forwardingTunnels, mac, tcpServer } from './helpers'
import { fakeRegistry, tarball, testFetch } from './registry-fake'

const HOUR_AGO = new Date(Date.now() - 3600 * 1000).toISOString()

type Registry = Awaited<ReturnType<typeof fakeRegistry>>
let npm: Registry

beforeAll(async () => {
  npm = await fakeRegistry({
    'tiny-greet': {
      '1.0.0': {
        packageJson: { main: 'lib/index.js', dependencies: { 'tiny-upper': '^2.0.0' }, license: 'MIT' },
        files: [
          {
            path: 'lib/index.js',
            content:
              "const { upper } = require('tiny-upper'); const extra = require('./extra'); exports.greet = (n) => upper('hello ') + n + extra.mark",
          },
          { path: 'lib/extra.js', content: "exports.mark = '!'" },
        ],
      },
      '1.1.0': {
        packageJson: { main: 'lib/index.js', dependencies: { 'tiny-upper': '^2.0.0' } },
        files: [
          {
            path: 'lib/index.js',
            content: "const { upper } = require('tiny-upper'); exports.greet = (n) => upper('hi ') + n",
          },
        ],
      },
    },
    'tiny-upper': {
      '2.1.0': {
        packageJson: {
          exports: {
            '.': { import: './esm/index.mjs', require: './cjs/index.cjs' },
            './package.json': './package.json',
          },
          imports: { '#impl': './shared/impl.js' },
        },
        files: [
          { path: 'esm/index.mjs', content: "import impl from '#impl'; export const upper = (s) => impl(s)" },
          { path: 'cjs/index.cjs', content: "const impl = require('#impl'); exports.upper = (s) => impl(s)" },
          { path: 'shared/impl.js', content: 'module.exports = (s) => s.toUpperCase()' },
        ],
      },
      // Too new: Valet waits three days.
      '2.2.0': { published: HOUR_AGO, files: [{ path: 'index.js', content: 'throw new Error("new")' }] },
    },
    '@scope/net-client': {
      '1.0.0': {
        packageJson: { type: 'module', exports: './index.js' },
        files: [
          {
            path: 'index.js',
            content: `import net from 'node:net'
export function ask(host, port, text) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host, port })
    let out = ''
    s.setEncoding('utf8')
    s.on('connect', () => s.write(text))
    s.on('data', (d) => { out += d })
    s.on('end', () => resolve(out))
    s.on('error', reject)
  })
}`,
          },
        ],
      },
    },
    'brand-new': { '1.0.0': { published: HOUR_AGO, files: [{ path: 'index.js', content: '' }] } },
    'evil-native': {
      '1.0.0': {
        files: [
          { path: 'index.js', content: '' },
          { path: 'build/Release/x.node', content: 'ELF' },
        ],
      },
    },
    'evil-gyp': { '1.0.0': { packageJson: { gypfile: true }, files: [{ path: 'index.js', content: '' }] } },
    'evil-tamper': { '1.0.0': { tamper: true, files: [{ path: 'index.js', content: '' }] } },
    'evil-elsewhere': {
      '1.0.0': {
        files: [{ path: 'index.js', content: '' }],
        doc: {
          dist: { integrity: integrityOf(Buffer.from('x')), tarball: 'https://evil.example.test/x.tgz' },
        },
      },
    },
    'evil-git': {
      '1.0.0': {
        packageJson: { dependencies: { other: 'github:evil/other' } },
        files: [{ path: 'index.js', content: '' }],
      },
    },
    'win-only': { '1.0.0': { packageJson: { os: ['win32'] }, files: [{ path: 'index.js', content: '' }] } },
    'has-optional': {
      '1.0.0': {
        packageJson: { optionalDependencies: { 'win-only': '^1.0.0' } },
        files: [{ path: 'index.js', content: 'module.exports = 1' }],
      },
    },
    'evil-paths': {
      '1.0.0': {
        files: [
          { path: 'index.js', content: "module.exports = require('./lib/x')" },
          { path: 'lib/x.js', content: 'module.exports = 2' },
          { path: '!package/../../../etc/escape.js', content: 'pwned' },
          { path: 'link.js', content: '', type: '2', linkTo: '/etc/passwd' },
          { path: 'hard.js', content: '', type: '1', linkTo: 'package/index.js' },
        ],
      },
    },
    'cycle-a': {
      '1.0.0': {
        packageJson: { dependencies: { 'cycle-b': '1.0.0' } },
        files: [{ path: 'index.js', content: "exports.b = () => require('cycle-b')" }],
      },
    },
    'cycle-b': {
      '1.0.0': {
        packageJson: { dependencies: { 'cycle-a': '1.0.0' } },
        files: [{ path: 'index.js', content: 'exports.ok = true' }],
      },
    },
  })
})
afterAll(() => npm.close())

const options = () => ({ registry: npm.registry, fetch: testFetch })

const refusal = (p: Promise<unknown>) =>
  p.then(
    () => 'added',
    (e: unknown) => (e instanceof DependencyError ? e.rule : String(e)),
  )

describe('adding a dependency', () => {
  it('resolves the newest version old enough, with its own dependencies, and keeps the tarballs', async () => {
    const store = memoryTarballStore()
    const result = await addDependency(EMPTY_LOCK, 'tiny-greet', '^1.0.0', store, options())
    expect(result.resolved).toBe('tiny-greet@1.1.0')
    expect(result.lock.dependencies).toEqual({
      'tiny-greet': { range: '^1.0.0', resolved: 'tiny-greet@1.1.0' },
    })
    // 2.2.0 is in range but an hour old: 2.1.0 is picked.
    expect(Object.keys(result.lock.packages).sort()).toEqual(['tiny-greet@1.1.0', 'tiny-upper@2.1.0'])
    expect(result.lock.packages['tiny-greet@1.1.0']?.dependencies).toEqual({
      'tiny-upper': 'tiny-upper@2.1.0',
    })
    expect(result.lock.packages['tiny-upper@2.1.0']?.integrity).toMatch(/^sha512-/)
    expect(store.size).toBe(2)
    expect(dependencySummary(result.lock)).toEqual({
      direct: [{ name: 'tiny-greet', version: '1.1.0' }],
      others: 1,
    })
    // The lockfile is valid as the package will carry it.
    expect(dependencyLockSchema.parse(JSON.parse(JSON.stringify(result.lock)))).toEqual(result.lock)
  })

  it('pins an exact version, and moving it drops what only the old one needed', async () => {
    const store = memoryTarballStore()
    const first = await addDependency(EMPTY_LOCK, 'tiny-greet', '1.0.0', store, options())
    expect(first.resolved).toBe('tiny-greet@1.0.0')
    expect(first.lock.packages['tiny-greet@1.0.0']?.license).toBe('MIT')
    const moved = await addDependency(first.lock, 'tiny-greet', '1.1.0', store, options())
    expect(moved.removed).toEqual(['tiny-greet@1.0.0'])
    expect(Object.keys(moved.lock.packages).sort()).toEqual(['tiny-greet@1.1.0', 'tiny-upper@2.1.0'])
    expect(moved.added).toEqual(['tiny-greet@1.1.0'])
    expect(removeDependency(moved.lock, 'tiny-greet')).toEqual(EMPTY_LOCK)
  })

  it('handles a dependency cycle', async () => {
    const result = await addDependency(EMPTY_LOCK, 'cycle-a', undefined, memoryTarballStore(), options())
    expect(result.lock.packages['cycle-b@1.0.0']?.dependencies).toEqual({ 'cycle-a': 'cycle-a@1.0.0' })
  })

  it('skips an optional dependency that can’t run on a Mac, and refuses a required one', async () => {
    const result = await addDependency(EMPTY_LOCK, 'has-optional', undefined, memoryTarballStore(), options())
    expect(Object.keys(result.lock.packages)).toEqual(['has-optional@1.0.0'])
    expect(
      await refusal(addDependency(EMPTY_LOCK, 'win-only', undefined, memoryTarballStore(), options())),
    ).toBe('platform')
  })

  it('refuses what it can’t vouch for', async () => {
    const store = memoryTarballStore()
    const add = (name: string, range?: string) =>
      refusal(addDependency(EMPTY_LOCK, name, range, store, options()))
    expect(await add('brand-new')).toBe('too-new')
    expect(await add('evil-native')).toBe('native-addon')
    expect(await add('evil-gyp')).toBe('native-addon')
    expect(await add('evil-tamper')).toBe('integrity')
    expect(await add('evil-elsewhere')).toBe('registry')
    expect(await add('evil-git')).toBe('range')
    expect(await add('no-such-package')).toBe('not-found')
    expect(await add('tiny-greet', '^9.0.0')).toBe('no-version')
    expect(await add('Not A Name')).toBe('name')
    expect(await add('../etc/passwd')).toBe('name')
    expect(await add('tiny-greet', 'github:evil/x')).toBe('range')
    // Nothing refused was kept.
    expect(store.size).toBe(0)
    // Never fetched from the host the hostile document named.
    expect(npm.requests.some((r) => r.includes('evil.example.test'))).toBe(false)
  })

  it('refuses when the registry can’t be reached or answers badly', async () => {
    const down = { registry: 'https://127.0.0.1:1/', fetch: testFetch }
    expect(
      await refusal(addDependency(EMPTY_LOCK, 'tiny-greet', undefined, memoryTarballStore(), down)),
    ).toBe('registry')
    const garbage = (async () => new Response('not json', { status: 200 })) as unknown as typeof fetch
    expect(
      await refusal(
        addDependency(EMPTY_LOCK, 'tiny-greet', undefined, memoryTarballStore(), {
          ...options(),
          fetch: garbage,
        }),
      ),
    ).toBe('registry')
    const huge = (async () =>
      new Response('{}', {
        status: 200,
        headers: { 'content-length': String(1e9) },
      })) as unknown as typeof fetch
    expect(
      await refusal(
        addDependency(EMPTY_LOCK, 'tiny-greet', undefined, memoryTarballStore(), {
          ...options(),
          fetch: huge,
        }),
      ),
    ).toBe('too-large')
  })
})

describe('tarballs', () => {
  it('keeps plain files only, inside the package', () => {
    const files = unpackTarball(
      tarball([
        { path: 'package.json', content: '{}' },
        { path: 'index.js', content: 'ok' },
        { path: '!package/../../escape.js', content: 'x' },
        { path: '!/etc/abs.js', content: 'x' },
        { path: 'link.js', content: '', type: '2', linkTo: '/etc/passwd' },
        { path: 'dir', content: '', type: '5' },
        { path: `deep/${'a'.repeat(120)}.js`, content: 'long name' },
      ]),
    )
    expect([...files.keys()].sort()).toEqual(['deep/' + 'a'.repeat(120) + '.js', 'index.js', 'package.json'])
  })

  it('refuses a native addon, a bomb, garbage and a tarball with no package.json', () => {
    const rule = (f: () => unknown) => {
      try {
        f()
        return 'ok'
      } catch (e) {
        return (e as TarballError).rule
      }
    }
    expect(
      rule(() =>
        unpackTarball(
          tarball([
            { path: 'package.json', content: '{}' },
            { path: 'a.node', content: '' },
          ]),
        ),
      ),
    ).toBe('native-addon')
    expect(
      rule(() =>
        unpackTarball(
          tarball([
            { path: 'package.json', content: '{}' },
            { path: 'binding.gyp', content: '' },
          ]),
        ),
      ),
    ).toBe('native-addon')
    const bomb = tarball([
      { path: 'package.json', content: '{}' },
      { path: 'big.js', content: 'x'.repeat(70 * 1024 * 1024) },
    ])
    expect(rule(() => unpackTarball(bomb))).toBe('too-large')
    expect(rule(() => unpackTarball(Buffer.from('not gzip')))).toBe('malformed')
    expect(rule(() => unpackTarball(tarball([{ path: 'index.js', content: '' }])))).toBe('malformed')
  })

  it('a store on disk refuses a tarball changed after it was kept', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'valet-store-'))
    try {
      const store = diskTarballStore(dir)
      const bytes = tarball([{ path: 'package.json', content: '{}' }])
      const integrity = integrityOf(bytes)
      await store.put(integrity, bytes)
      expect(Buffer.from((await store.get(integrity)) ?? [])).toEqual(bytes)
      const file = join(dir, `${Buffer.from(integrity.slice(7), 'base64').toString('hex')}.tgz`)
      await writeFile(file, Buffer.from('changed'))
      expect(await store.get(integrity)).toBeNull()
      await expect(store.put(integrity, Buffer.from('other'))).rejects.toBeInstanceOf(TarballError)
      await expect(store.get('sha512-nope')).rejects.toBeInstanceOf(TarballError)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('the lockfile in the package', () => {
  const manifest = {
    id: 'raw-example',
    name: 'Raw example',
    version: '1.0.0',
    origins: ['https://example.test'],
    tools: [],
  }

  it('is refused for an adapter that isn’t raw', () => {
    expect(() => checkLock(JSON.stringify(EMPTY_LOCK), manifest as never)).toThrow(PackageError)
  })

  it('is checked: dangling references, wrong names, unreachable packages and bad integrities are refused', () => {
    const raw = { ...manifest, runtime: 'raw' } as never
    const integrity = `sha512-${'A'.repeat(86)}==`
    const good = {
      lockfileVersion: 1,
      dependencies: { a: { range: '^1.0.0', resolved: 'a@1.0.0' } },
      packages: {
        'a@1.0.0': { integrity, tarball: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz', dependencies: {} },
      },
    }
    expect(checkLock(JSON.stringify(good), raw).dependencies['a']?.resolved).toBe('a@1.0.0')
    const bad = (lock: unknown) => {
      try {
        checkLock(JSON.stringify(lock), raw)
        return 'ok'
      } catch (e) {
        return (e as PackageError).rule
      }
    }
    expect(bad({ ...good, dependencies: { a: { range: '1', resolved: 'a@2.0.0' } } })).toBe('lock-invalid')
    expect(bad({ ...good, dependencies: { b: { range: '1', resolved: 'a@1.0.0' } } })).toBe('lock-invalid')
    expect(
      bad({
        ...good,
        packages: { ...good.packages, 'stowaway@1.0.0': { integrity, tarball: 'https://x.test/s.tgz' } },
      }),
    ).toBe('lock-invalid')
    expect(
      bad({ ...good, packages: { 'a@1.0.0': { integrity: 'sha1-abc', tarball: 'https://x.test/a.tgz' } } }),
    ).toBe('lock-invalid')
    expect(bad({ ...good, packages: { 'a@1.0.0': { integrity, tarball: 'http://x.test/a.tgz' } } })).toBe(
      'lock-invalid',
    )
    expect(bad('not an object')).toBe('lock-invalid')
    expect(() => checkLock('{', raw)).toThrow(PackageError)
  })
})

describe('a bundle built from them, running in the runtime', () => {
  let echo: Awaited<ReturnType<typeof tcpServer>>
  const compiler = new Compiler()
  beforeAll(async () => {
    echo = await tcpServer('answer')
  })
  afterAll(async () => {
    echo.close()
    await compiler.close()
  })

  it('imports CommonJS and ESM packages, exports and imports maps, and Node’s built-ins', async () => {
    const store = memoryTarballStore()
    let lock = (await addDependency(EMPTY_LOCK, 'tiny-greet', '1.0.0', store, options())).lock
    lock = (await addDependency(lock, '@scope/net-client', undefined, store, options())).lock
    const packages = await loadDependencies(lock, store)
    const files = {
      'src/tools.ts': `import { z } from 'zod'
import { greet } from 'tiny-greet'
import { upper } from 'tiny-upper/package.json' with { type: 'json' }
import { ask } from '@scope/net-client'
import { createHash } from 'node:crypto'
export const tools = {
  greet: {
    input: z.object({ name: z.string() }),
    output: z.object({ text: z.string(), hash: z.string(), viaNet: z.string() }),
    run: async (_ctx: unknown, input: { name: string }) => ({
      text: greet(input.name),
      hash: createHash('sha256').update(input.name).digest('hex').slice(0, 8),
      viaNet: await ask('echo.example.test', 7000, 'q'),
    }),
  },
}
void upper
`,
    }
    // The direct import of tiny-upper fails: it's only tiny-greet's dependency, not the adapter's.
    await expect(compiler.compileNode(files, lock, packages)).rejects.toThrow(/tiny-upper/)
    const allowed = {
      'src/tools.ts': (files['src/tools.ts'] as string)
        .replace(/^import \{ upper \}.*\n/m, '')
        .replace('void upper\n', ''),
    }
    const script = `${await buildToolLibrary()}\n${await compiler.compileNode(allowed, lock, packages)}`
    const start = nodeRuntimeProcess({
      nodeBinary: process.execPath,
      endpoints: ['echo.example.test:7000'],
      openTunnels: forwardingTunnels({ 'echo.example.test:7000': { host: '127.0.0.1', port: echo.port } }),
      home: homedir(),
      withoutSeatbelt: !mac,
    })
    expect(await runIsolated(start, script, context(), 'greet', { name: 'Tess' })).toEqual({
      text: 'HELLO Tess!',
      hash: '9aeaed03',
      viaNet: 'answer',
    })
  })

  it('refuses a dependency the lockfile doesn’t list, a relative path out of src, and a missing tarball', async () => {
    const lock = (await addDependency(EMPTY_LOCK, 'evil-paths', undefined, memoryTarballStore(), options()))
      .lock
    await expect(
      compiler.compileNode({ 'src/tools.ts': "import 'left-pad'\nexport const tools = {}" }, lock, {}),
    ).rejects.toThrow(/left-pad/)
    await expect(
      compiler.compileNode({ 'src/tools.ts': "import '../../etc/x'\nexport const tools = {}" }, null, {}),
    ).rejects.toThrow(/may not import/)
    await expect(loadDependencies(lock, memoryTarballStore())).rejects.toBeInstanceOf(DependencyError)
    // Fetched again only when allowed, and only from the registry.
    const store = memoryTarballStore()
    const loaded = await loadDependencies(lock, store, {
      fetchMissing: true,
      registry: npm.registry,
      fetch: testFetch,
    })
    expect(Object.keys(loaded['evil-paths@1.0.0'] ?? {}).sort()).toEqual([
      'index.js',
      'lib/x.js',
      'package.json',
    ])
    await expect(loadDependencies(lock, memoryTarballStore(), { fetchMissing: true })).rejects.toBeInstanceOf(
      DependencyError,
    )
  })
})
