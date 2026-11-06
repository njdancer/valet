// @vitest-environment node
// The app's own state files: settings, approved-manifest snapshots, clients, and the JSON helpers.

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SiteAdapterError } from '@siteadapter/core'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ClientRegistry, clientId } from '../../src/main/core/clients'
import { ensurePrivateDir, JsonDocument, readJsonFile, writeJsonFile } from '../../src/main/core/files'
import { builtinAdapter, MANIFEST_ENTRY, SnapshotStore } from '../../src/main/core/registry'
import { DEFAULT_SETTINGS, SettingsStore } from '../../src/main/core/settings'
import { SHOP, SHOP_FILES, shopDefinition } from './fixtures'

const dirs: string[] = []
function dir(): string {
  const d = mkdtempSync(join(tmpdir(), 'sa-main-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('files', () => {
  it('writes owner-only and reads back through the schema', async () => {
    const path = join(dir(), 'x.json')
    await writeJsonFile(path, { a: 1 })
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(await readJsonFile(path, z.object({ a: z.number() }).strict())).toEqual({ a: 1 })
    expect(await readJsonFile(join(dir(), 'missing.json'), z.object({}))).toBeNull()
  })

  it('refuses a file that is not JSON or not the shape', async () => {
    const path = join(dir(), 'x.json')
    writeFileSync(path, '{')
    await expect(readJsonFile(path, z.object({}))).rejects.toEqual(new SiteAdapterError('config', 'invalid'))
    writeFileSync(path, '{"a": "1"}')
    await expect(readJsonFile(path, z.object({ a: z.number() }))).rejects.toEqual(
      new SiteAdapterError('config', 'invalid'),
    )
  })

  it('reports a write it could not make', async () => {
    await expect(writeJsonFile(join(dir(), 'no', 'such', 'dir.json'), {})).rejects.toEqual(
      new SiteAdapterError('config', 'unavailable'),
    )
  })

  it('tightens the data directory to 0700', async () => {
    const d = join(dir(), 'data')
    await ensurePrivateDir(d)
    expect(statSync(d).mode & 0o777).toBe(0o700)
  })

  it('serialises updates and, unless told to recover, throws on an invalid file', async () => {
    const path = join(dir(), 'doc.json')
    const doc = new JsonDocument(path, z.object({ n: z.number() }).strict(), () => ({ n: 0 }))
    await Promise.all([1, 2, 3].map(() => doc.update((c) => ({ n: c.n + 1 }))))
    expect(await doc.read()).toEqual({ n: 3 })
    writeFileSync(path, 'nope')
    await expect(doc.read()).rejects.toBeInstanceOf(SiteAdapterError)
    const recovering = new JsonDocument(path, z.object({ n: z.number() }), () => ({ n: 0 }), true)
    expect(await recovering.read()).toEqual({ n: 0 })
  })
})

describe('SettingsStore', () => {
  it('starts from the cautious defaults and applies only SettingsPatch keys', async () => {
    const store = new SettingsStore(join(dir(), 'settings.json'))
    expect(await store.get()).toEqual(DEFAULT_SETTINGS)
    const patch = JSON.parse('{"launchAtLogin": true, "opPath": "/tmp/op", "__proto__": {"x": 1}}')
    expect(await store.set(patch)).toEqual({ ...DEFAULT_SETTINGS, launchAtLogin: true })
    expect(await store.setOpPath('/opt/homebrew/bin/op')).toMatchObject({
      opPath: '/opt/homebrew/bin/op',
      launchAtLogin: true,
    })
  })

  it('reads an edited or broken file as the defaults', async () => {
    const path = join(dir(), 'settings.json')
    const store = new SettingsStore(path)
    writeFileSync(path, JSON.stringify({ ...DEFAULT_SETTINGS, opPath: 'relative/op' }))
    expect(await store.get()).toEqual(DEFAULT_SETTINGS)
    writeFileSync(path, JSON.stringify({ ...DEFAULT_SETTINGS, messagesOtpEnabled: true, extra: 1 }))
    expect(await store.get()).toEqual(DEFAULT_SETTINGS)
    writeFileSync(path, '{')
    expect((await store.set({ messagesOtpEnabled: true })).messagesOtpEnabled).toBe(true)
  })
})

describe('built-in adapters and snapshots', () => {
  it('hashes the source and the effective manifest, so the fake site’s manifest is another bundle', () => {
    const real = builtinAdapter(shopDefinition(), SHOP_FILES)
    const fake = builtinAdapter(shopDefinition({ ...SHOP, home: 'https://www.shop.test:8443/' }), SHOP_FILES)
    const edited = builtinAdapter(shopDefinition(), { ...SHOP_FILES, 'src/index.ts': 'export default 1\n' })
    expect(real.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(new Set([real.hash, fake.hash, edited.hash]).size).toBe(3)
    expect(builtinAdapter(shopDefinition(), SHOP_FILES).hash).toBe(real.hash)
    expect(() => builtinAdapter(shopDefinition(), { [MANIFEST_ENTRY]: '{}' })).toThrow()
  })

  it('keeps the last approved bundle per adapter, and fails toward showing everything', async () => {
    const path = join(dir(), 'approved-manifests.json')
    const store = new SnapshotStore(path)
    const adapter = builtinAdapter(shopDefinition(), SHOP_FILES)
    expect(await store.get('shop')).toBeNull()
    await store.put('shop', adapter, '2026-11-07T00:00:00.000Z')
    expect(await store.get('shop')).toMatchObject({ hash: adapter.hash, version: '1.0.0', files: SHOP_FILES })
    expect(await store.get('constructor')).toBeNull()
    const file = JSON.parse(readFileSync(path, 'utf8'))
    file.adapters.shop.manifest.navigation = ['http://plain.test']
    writeFileSync(path, JSON.stringify(file))
    expect(await store.get('shop')).toBeNull()
    writeFileSync(path, 'garbage')
    expect(await store.get('shop')).toBeNull()
  })
})

describe('ClientRegistry', () => {
  it('records clients by reported name and refuses a revoked name, as a label', async () => {
    let now = Date.parse('2026-11-07T00:00:00.000Z')
    const path = join(dir(), 'clients.json')
    const registry = new ClientRegistry(path, () => new Date(now))
    await registry.load()
    expect(registry.seen('Claude Code', 'http')).toBe(true)
    expect(registry.seen('Claude Code', 'http')).toBe(false)
    registry.seen('Other', 'http')
    expect(registry.connected()).toBe(2)
    const id = clientId('Claude Code')
    expect(await registry.revoke(id)).toBe(true)
    expect(await registry.revoke(id)).toBe(false)
    expect(await registry.revoke('c_0000000000000000')).toBe(false)
    expect(registry.isRevoked('Claude Code')).toBe(true)
    expect(registry.isRevoked('Other')).toBe(false)
    expect(registry.connected()).toBe(1)
    now += 11 * 60_000
    expect(registry.connected()).toBe(0)
    expect(registry.list(() => 4).find((c) => c.id === id)).toMatchObject({
      reportedName: 'Claude Code',
      calls7d: 4,
    })
    const reloaded = new ClientRegistry(path, () => new Date(now))
    await reloaded.load()
    expect(reloaded.isRevoked('Claude Code')).toBe(true)
  })
})
