import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkPackage, packageOf, parseManifest } from '@valet/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AdapterStore, MAX_VERSIONS, StoreError } from '../src/store'

const BUILD = { appVersion: '1.0.0', preludeHash: 'a'.repeat(64), compiler: 'esbuild-wasm 0.28.2' }
const NOW = new Date('2026-11-12T02:00:00Z')

function pkg(n: number, id = 'example-site') {
  const manifest = parseManifest({
    schemaVersion: 1,
    id,
    name: 'Example',
    version: `0.1.${n}`,
    description: 'An example.',
    home: 'https://www.example.com/',
    navigation: ['https://www.example.com'],
    egress: ['www.example.com'],
    tools: [{ name: 'get_page', title: 'Get page', description: 'Gets a page.', sideEffect: 'read' }],
  })
  return checkPackage(packageOf(manifest, { 'src/tools.ts': `export const tools = { n: ${n} }\n` }))
}

let dir: string
let store: AdapterStore
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'valet-store-'))
  store = new AdapterStore(dir)
})
afterEach(() => rm(dir, { recursive: true, force: true }))

const put = (n: number, extra: Partial<Parameters<AdapterStore['put']>[1]> = {}) =>
  store.put(pkg(n), { source: 'folder', build: BUILD, now: NOW, ...extra })

describe('AdapterStore', () => {
  it('stores a version under its hash and reads it back checked', async () => {
    const one = pkg(1)
    const state = await put(1)
    expect(state).toMatchObject({ active: one.adapterHash, pinned: true })
    expect(state.versions[0]).toMatchObject({ version: '0.1.1', source: 'folder', build: BUILD })
    expect(await readdir(join(dir, 'example-site'))).toEqual(
      expect.arrayContaining([`${one.adapterHash}.json`]),
    )
    const read = await store.read('example-site', one.adapterHash)
    expect(read.adapterHash).toBe(one.adapterHash)
    expect(await store.ids()).toEqual(['example-site'])
  })

  it('pins anything but a built-in, and a built-in does not take over a pinned adapter', async () => {
    expect((await put(1, { source: 'builtin' })).pinned).toBe(false)
    expect((await put(2)).pinned).toBe(true)
    const state = await put(3, { source: 'builtin', activate: false })
    expect(state.active).toBe(pkg(2).adapterHash)
    expect(state.versions.map((v) => v.version)).toEqual(['0.1.1', '0.1.2', '0.1.3'])
  })

  it('stores a draft like any other source, now the sandbox runs its code', async () => {
    const state = await put(1, { source: 'draft' })
    expect(state.versions.map((v) => v.source)).toEqual(['draft'])
  })

  it('installs the same package once', async () => {
    await put(1)
    await put(2)
    const state = await put(1)
    expect(state.active).toBe(pkg(1).adapterHash)
    expect(state.versions).toHaveLength(2)
  })

  it('refuses a version changed on disk', async () => {
    const hash = pkg(1).adapterHash
    await put(1)
    const path = join(dir, 'example-site', `${hash}.json`)
    const stored = JSON.parse(await readFile(path, 'utf8'))
    stored.files['src/tools.ts'] = 'export const tools = { evil: true }\n'
    await writeFile(path, JSON.stringify(stored))
    await expect(store.read('example-site', hash)).rejects.toMatchObject({ problem: 'hash-mismatch' })
    await writeFile(path, '{')
    await expect(store.read('example-site', hash)).rejects.toMatchObject({ problem: 'invalid' })
    stored.files['src/a.js'] = 'x'
    await writeFile(path, JSON.stringify(stored))
    await expect(store.read('example-site', hash)).rejects.toMatchObject({ problem: 'invalid' })
  })

  it('refuses a version filed under another adapter', async () => {
    const other = pkg(1, 'other-site')
    await store.put(other, { source: 'folder', build: BUILD, now: NOW })
    await store.put(pkg(1), { source: 'folder', build: BUILD, now: NOW })
    const from = join(dir, 'other-site', `${other.adapterHash}.json`)
    await writeFile(join(dir, 'example-site', `${other.adapterHash}.json`), await readFile(from, 'utf8'))
    await expect(store.read('example-site', other.adapterHash)).rejects.toMatchObject({
      problem: 'id-mismatch',
    })
  })

  it('refuses bad ids and hashes before touching the disk', async () => {
    await expect(store.read('../x', 'a'.repeat(64))).rejects.toBeInstanceOf(StoreError)
    await expect(store.read('example-site', '../state')).rejects.toMatchObject({ problem: 'invalid' })
    await expect(store.read('example-site', 'b'.repeat(64))).rejects.toMatchObject({ problem: 'missing' })
    await expect(store.state('Bad')).rejects.toBeInstanceOf(StoreError)
  })

  it('treats an unreadable state file as unreadable, never as empty', async () => {
    await put(1)
    await writeFile(join(dir, 'example-site', 'state.json'), '{"version":1}')
    await expect(store.state('example-site')).rejects.toMatchObject({ problem: 'unreadable' })
  })

  it('activates a stored version and refuses one that is not stored', async () => {
    await put(1)
    await put(2)
    const state = await store.activate('example-site', pkg(1).adapterHash, true)
    expect(state.active).toBe(pkg(1).adapterHash)
    await expect(store.activate('example-site', 'c'.repeat(64), true)).rejects.toMatchObject({
      problem: 'missing',
    })
  })

  it('keeps at most MAX_VERSIONS, never dropping the active or kept ones', async () => {
    const approved = pkg(0).adapterHash
    await put(0)
    for (let n = 1; n <= MAX_VERSIONS + 3; n++) await put(n, { keep: new Set([approved]) })
    const state = await store.state('example-site')
    expect(state?.versions).toHaveLength(MAX_VERSIONS)
    expect(state?.versions.some((v) => v.hash === approved)).toBe(true)
    expect(state?.active).toBe(pkg(MAX_VERSIONS + 3).adapterHash)
    expect(state?.versions.some((v) => v.hash === pkg(1).adapterHash)).toBe(false)
    const files = await readdir(join(dir, 'example-site'))
    expect(files).toHaveLength(MAX_VERSIONS + 1)
  })
})
