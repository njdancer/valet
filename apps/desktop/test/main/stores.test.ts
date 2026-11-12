// @vitest-environment node
// The app's own state files: settings, approved-manifest snapshots, clients, and the JSON helpers.

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ValetError } from '@valet/core'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ClientRegistry, cleanClientName, shownTransport } from '../../src/main/core/clients'
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
    await expect(readJsonFile(path, z.object({}))).rejects.toEqual(new ValetError('config', 'invalid'))
    writeFileSync(path, '{"a": "1"}')
    await expect(readJsonFile(path, z.object({ a: z.number() }))).rejects.toEqual(
      new ValetError('config', 'invalid'),
    )
  })

  it('reports a write it could not make', async () => {
    await expect(writeJsonFile(join(dir(), 'no', 'such', 'dir.json'), {})).rejects.toEqual(
      new ValetError('config', 'unavailable'),
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
    await expect(doc.read()).rejects.toBeInstanceOf(ValetError)
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

  it('notifies by default, and reads a file from before the setting existed as on', async () => {
    const path = join(dir(), 'settings.json')
    const store = new SettingsStore(path)
    expect((await store.get()).notifications).toBe(true)
    const { notifications: _, ...older } = { ...DEFAULT_SETTINGS, launchAtLogin: true }
    writeFileSync(path, JSON.stringify(older))
    expect(await store.get()).toEqual({ ...DEFAULT_SETTINGS, launchAtLogin: true })
    expect((await store.set({ notifications: false })).notifications).toBe(false)
    expect((await store.get()).notifications).toBe(false)
  })

  it('keeps trace retention in days, 1 to 365, and reads a file from before it existed as 14', async () => {
    const path = join(dir(), 'settings.json')
    const store = new SettingsStore(path)
    const { traceRetentionDays: _, ...older } = { ...DEFAULT_SETTINGS, launchAtLogin: true }
    writeFileSync(path, JSON.stringify(older))
    expect(await store.get()).toEqual({ ...DEFAULT_SETTINGS, launchAtLogin: true, traceRetentionDays: 14 })
    expect((await store.set({ traceRetentionDays: 30 })).traceRetentionDays).toBe(30)
    for (const bad of [0, 366, 1.5]) {
      writeFileSync(path, JSON.stringify({ ...DEFAULT_SETTINGS, traceRetentionDays: bad }))
      expect(await store.get()).toEqual(DEFAULT_SETTINGS)
    }
  })

  it('keeps the 1Password account, and reads a file from before it existed', async () => {
    const path = join(dir(), 'settings.json')
    const store = new SettingsStore(path)
    const { onePasswordAccount: _, ...older } = { ...DEFAULT_SETTINGS, messagesOtpEnabled: true }
    writeFileSync(path, JSON.stringify(older))
    expect(await store.get()).toEqual({ ...DEFAULT_SETTINGS, messagesOtpEnabled: true })
    expect((await store.set({ onePasswordAccount: 'my.1password.com' })).onePasswordAccount).toBe(
      'my.1password.com',
    )
    expect((await store.get()).onePasswordAccount).toBe('my.1password.com')
    writeFileSync(path, JSON.stringify({ ...DEFAULT_SETTINGS, onePasswordAccount: ' padded' }))
    expect(await store.get()).toEqual(DEFAULT_SETTINGS)
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
  it('adds clients under the person’s names, each with its own config file', async () => {
    const now = Date.parse('2026-11-07T00:00:00.000Z')
    const path = join(dir(), 'clients.json')
    let n = 0
    const registry = new ClientRegistry(
      path,
      '/configs',
      () => new Date(now),
      () => `c_${String(++n).padStart(16, '0')}`,
    )
    await registry.load()
    const code = await registry.add('  Claude\u0000 Code  ')
    const desktop = await registry.add('Claude Desktop')
    expect(code).toMatchObject({
      id: 'c_0000000000000001',
      name: 'Claude Code',
      reportedName: null,
      lastSeen: null,
    })
    expect(registry.configPath(code.id)).toBe('/configs/c_0000000000000001.json')
    expect(registry.active()).toEqual([
      { id: code.id, configPath: '/configs/c_0000000000000001.json' },
      { id: desktop.id, configPath: '/configs/c_0000000000000002.json' },
    ])
    await expect(registry.add('   ')).rejects.toEqual(new ValetError('config', 'invalid'))
    await expect(registry.add(42)).rejects.toEqual(new ValetError('config', 'invalid'))
  })

  it('keeps what each app may see: Valet, and only its own calls, until the person changes it', async () => {
    const path = join(dir(), 'clients.json')
    const registry = new ClientRegistry(path, '/configs', () => new Date('2026-11-12T00:00:00.000Z'))
    await registry.load()
    const { id } = await registry.add('Claude Code')
    expect(registry.capabilities(id)).toEqual({ seeValet: true, allActivity: false, askForChanges: true })
    expect(await registry.setCapabilities(id, { allActivity: true })).toBe(true)
    const again = new ClientRegistry(path, '/configs', () => new Date())
    await again.load()
    expect(again.capabilities(id)).toEqual({ seeValet: true, allActivity: true, askForChanges: true })
    // The screens' view doesn't carry them yet.
    expect(again.list(() => 0)[0]).not.toHaveProperty('capabilities')
    expect(again.list(() => 0)[0]).not.toHaveProperty('toolsOff')
    expect(await again.setCapabilities('c_ffffffffffffffff', { seeValet: false })).toBe(false)
    expect(again.capabilities('c_ffffffffffffffff')).toBeNull()
    await again.revoke(id)
    expect(again.capabilities(id)).toBeNull()
    expect(await again.setCapabilities(id, { seeValet: true })).toBe(false)
  })

  it('reads a file from before Ask for changes as on, and keeps tools an app turned off for itself', async () => {
    const path = join(dir(), 'clients.json')
    const registry = new ClientRegistry(path, '/configs', () => new Date('2026-11-12T00:00:00.000Z'))
    await registry.load()
    const { id } = await registry.add('Claude Code')
    const file = JSON.parse(readFileSync(path, 'utf8'))
    file.clients[0].capabilities = { seeValet: true, allActivity: false }
    writeFileSync(path, JSON.stringify(file))
    const again = new ClientRegistry(path, '/configs', () => new Date())
    await again.load()
    expect(again.capabilities(id)?.askForChanges).toBe(true)
    file.clients[0].capabilities = { seeValet: false, allActivity: false }
    writeFileSync(path, JSON.stringify(file))
    const hidden = new ClientRegistry(path, '/configs', () => new Date())
    await hidden.load()
    expect(hidden.capabilities(id)?.askForChanges).toBe(false)
    expect(await again.turnOffTool(id, 'shop.echo')).toBe('done')
    expect(await again.turnOffTool(id, 'shop.echo')).toBe('already')
    const third = new ClientRegistry(path, '/configs', () => new Date())
    await third.load()
    expect([...third.toolsOff(id)]).toEqual(['shop.echo'])
    await third.revoke(id)
    expect(third.toolsOff(id).size).toBe(0)
    expect(await third.turnOffTool(id, 'shop.other')).toBe('not-found')
  })

  it('records what a client says it is beside the person’s name, as a claim', async () => {
    let now = Date.parse('2026-11-07T00:00:00.000Z')
    const registry = new ClientRegistry(join(dir(), 'clients.json'), '/configs', () => new Date(now))
    await registry.load()
    const { id } = await registry.add('Claude Code')
    expect(registry.seen(id, 'claude-code', 'stdio')).toBe(true)
    now += 60_000
    expect(registry.seen(id, 'claude-code', 'stdio')).toBe(false)
    expect(registry.seen(id, 'cursor', 'stdio')).toBe(true)
    expect(registry.seen('c_ffffffffffffffff', 'x', 'http')).toBe(false)
    expect(registry.list(() => 3)[0]).toMatchObject({
      name: 'Claude Code',
      reportedName: 'cursor',
      transport: 'stdio',
      lastSeen: new Date(now).toISOString(),
      calls7d: 3,
    })
  })

  it('resets and revokes a client, which stays listed but holds no token', async () => {
    const now = Date.parse('2026-11-07T00:00:00.000Z')
    const path = join(dir(), 'clients.json')
    const registry = new ClientRegistry(path, '/configs', () => new Date(now))
    await registry.load()
    const { id } = await registry.add('Claude Code')
    expect(await registry.reset(id)).toBe(true)
    expect(registry.get(id)?.accessResetAt).toBe(new Date(now).toISOString())
    expect(await registry.revoke(id)).toBe(true)
    expect(await registry.revoke(id)).toBe(false)
    expect(await registry.reset(id)).toBe(false)
    expect(await registry.revoke('c_0000000000000000')).toBe(false)
    expect(registry.active()).toEqual([])
    const reloaded = new ClientRegistry(path, '/configs', () => new Date(now))
    await reloaded.load()
    expect(reloaded.isActive(id)).toBe(false)
    expect(reloaded.list(() => 0)).toHaveLength(1)
  })

  it('reads a file from before per-client tokens as empty: its names were labels', async () => {
    const path = join(dir(), 'clients.json')
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        clients: [
          {
            id: 'c_0123456789abcdef',
            reportedName: 'claude-code',
            transport: 'stdio',
            firstSeen: '2026-11-01T00:00:00.000Z',
            lastSeen: '2026-11-01T00:00:00.000Z',
            revokedAt: null,
          },
        ],
      }),
    )
    const registry = new ClientRegistry(path, '/configs', () => new Date())
    await registry.load()
    expect(registry.active()).toEqual([])
  })

  it('flattens the person’s name for a client', () => {
    expect(cleanClientName('a\nb\tc')).toBe('a b c')
    expect(cleanClientName('x'.repeat(80))).toHaveLength(60)
    expect(cleanClientName('\u200b')).toBeNull()
    expect(cleanClientName(null)).toBeNull()
  })

  it('shows the bridge’s label as stdio and anything else as HTTP', () => {
    expect(shownTransport('stdio-bridge')).toBe('stdio')
    expect(shownTransport('http')).toBe('http')
    expect(shownTransport(undefined)).toBe('http')
  })
})
