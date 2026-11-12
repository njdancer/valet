// @vitest-environment node
// The app's package manager: what the service tests don't reach directly.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AdapterStore, buildRecord, LoadError, StoreError } from '@valet/adapter-store'
import { type AuditRecord, type AuditSink, PackageError, packageOf, parseManifest } from '@valet/core'
import { inMemoryToolProcess } from '@valet/runtime/in-context'
import { buildToolLibrary } from '@valet/runtime/tool-script'
import { afterEach, describe, expect, it } from 'vitest'
import { InstallError, installReason, PackageManager, rollbackEligible } from '../../src/main/core/packages'

const MANIFEST = parseManifest({
  schemaVersion: 1,
  id: 'shop',
  name: 'Shop',
  version: '1.0.0',
  description: 'A test shop.',
  home: 'https://shop.example/',
  navigation: ['https://shop.example'],
  egress: ['shop.example'],
  requests: [{ method: 'GET', path: '/api', purpose: 'read' }],
  tools: [{ name: 'echo', title: 'Echo', description: 'Echoes.', sideEffect: 'read' }],
})
const TOOLS = [
  "import { z } from 'zod'",
  'export const tools = { echo: { input: z.object({ text: z.string() }), output: z.object({ text: z.string() }), run: async (_c, a) => a } }',
].join('\n')

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function manager() {
  const dir = mkdtempSync(join(tmpdir(), 'valet-packages-'))
  dirs.push(dir)
  const prelude = await buildToolLibrary()
  const events: unknown[] = []
  const audit: AuditSink = {
    append: async (event: unknown) => void events.push(event),
  } as unknown as AuditSink
  const packages = new PackageManager({
    store: new AdapterStore(dir),
    runtime: { prelude, start: inMemoryToolProcess() },
    build: buildRecord('0.1.0', prelude),
    audit,
    now: () => new Date('2026-11-12T00:00:00Z'),
    keep: async () => new Set(),
  })
  return { packages, events }
}

describe('PackageManager', () => {
  it('refuses a draft until the sandbox exists, and stores nothing', async () => {
    const { packages } = await manager()
    await expect(packages.prepare(packageOf(MANIFEST, { 'src/tools.ts': TOOLS }), 'draft')).rejects.toThrow(
      InstallError,
    )
    expect(await packages.versions('shop')).toBeNull()
  })

  it('stores a prepared version only when it is committed', async () => {
    const { packages, events } = await manager()
    const prepared = await packages.prepare(packageOf(MANIFEST, { 'src/tools.ts': TOOLS }), 'folder')
    expect(await packages.versions('shop')).toBeNull()
    await packages.commit(prepared)
    expect((await packages.versions('shop'))?.active).toBe(prepared.adapter.hash)
    expect(events).toEqual([expect.objectContaining({ type: 'adapter-installed', source: 'folder' })])
    // The same version again changes nothing in the audit.
    await packages.commit(prepared)
    expect(events).toHaveLength(1)
  })

  it('refuses to load a version that is not stored', async () => {
    const { packages } = await manager()
    await expect(packages.load('shop', 'a'.repeat(64))).rejects.toThrow('That version is not stored.')
  })
})

describe('installReason', () => {
  it('says why in words for each kind of failure', () => {
    expect(installReason(new PackageError('path', 'x'))).toContain('breaks a rule (path)')
    expect(installReason(new LoadError('compile', 'y'))).toContain('did not load (compile)')
    expect(installReason(new StoreError('hash-mismatch', 'z'))).toContain('hash-mismatch')
    expect(installReason(new InstallError('busy'))).toBe('busy')
    expect(installReason(new Error('secret contents'))).toBe('The package could not be installed.')
  })
})

describe('rollbackEligible', () => {
  const record = (type: string, adapterId: string, adapterHash: string) =>
    ({ event: { type, adapterId, adapterHash, version: '1' } }) as unknown as AuditRecord

  it('offers only hashes whose latest decision for this adapter is an approval', () => {
    const eligible = rollbackEligible(
      [
        record('adapter-approved', 'shop', 'a'),
        record('adapter-approved', 'shop', 'b'),
        record('adapter-rejected', 'shop', 'b'),
        record('adapter-rejected', 'shop', 'c'),
        record('adapter-approved', 'shop', 'c'),
        record('adapter-approved', 'other', 'd'),
        record('tool-call', 'shop', 'e'),
      ],
      'shop',
    )
    expect([...eligible].sort()).toEqual(['a', 'c'])
  })
})
