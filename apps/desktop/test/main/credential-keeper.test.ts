// @vitest-environment node
// CredentialKeeper (secrets v2) on its own: what a grant may name, Valet-made SSH keys, and when a
// grant's signature counts. The broker is a list of signed subjects; the service-level flow is in
// service.test.ts ("credentials (secrets v2)").

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AdapterManifest,
  type ApprovalSubject,
  type AuditEvent,
  type CredentialDeclaration,
  SecretValue,
} from '@valet/core'
import { FileCredentialGrantStore, MemoryKeychain, ValetKeys } from '@valet/credentials'
import { afterEach, describe, expect, it } from 'vitest'
import { type CarriedCredential, CredentialKeeper } from '../../src/main/core/credential-grants'

const HASH = 'a'.repeat(64)
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const sshKey: CredentialDeclaration = {
  description: 'An SSH key for the NAS',
  kind: 'ssh-key',
  custody: 'kept',
  use: { protocol: 'sftp', endpoint: 'nas.example.com:22' },
}
const token: CredentialDeclaration = {
  description: 'An API token',
  kind: 'token',
  custody: 'kept',
  use: {
    header: { name: 'authorization', format: 'Bearer {value}' },
    hosts: ['api.example.com', 'up.example.com'],
  },
}

const entrustedKey: CredentialDeclaration = { ...sshKey, custody: 'entrusted' }
const HASH2 = 'd'.repeat(64)

/** An adapter-install approval as the broker honours it, enough for a carry to read. */
interface Install {
  readonly adapterId: string
  readonly adapterHash: string
  readonly previousHash: string
  readonly inheritsSession: boolean
  readonly source: 'install' | 'update' | 'rollback'
}

function setup(options: { approve?: boolean; keys?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'valet-keeper-'))
  dirs.push(dir)
  const signed: ApprovalSubject<'credential-grant'>[] = []
  const audit: AuditEvent[] = []
  const keychain = new MemoryKeychain()
  const keys = options.keys === false ? null : new ValetKeys({ keychain, service: 'valet.test.key' })
  const copied: string[] = []
  const manifest = {
    id: 'nas',
    credentials: { key: sshKey, backup: sshKey, ent: entrustedKey, api: token },
  } as unknown as AdapterManifest
  const installs: Install[] = []
  const installed = { hash: HASH }
  const carried: CarriedCredential[] = []
  const keeper = new CredentialKeeper({
    store: new FileCredentialGrantStore({ path: join(dir, 'credential-grants.json') }),
    adapter: (id) => (id === 'nas' ? { hash: installed.hash, manifest } : null),
    approve: async (subject) => {
      if (options.approve === false) return false
      signed.push(subject)
      return true
    },
    honoured: (kind, matches) =>
      kind === 'credential-grant'
        ? (signed.find((s) => (matches as (s: ApprovalSubject<'credential-grant'>) => boolean)(s)) ?? null)
        : kind === 'adapter-install'
          ? ((installs.find((s) => (matches as (s: Install) => boolean)(s)) ?? null) as never)
          : null,
    revokeEvidence: async (matches) => {
      for (let i = signed.length - 1; i >= 0; i--) if (matches(signed[i] as never)) signed.splice(i, 1)
    },
    carried: () => carried,
    recordCarried: async (_id, records) => {
      carried.push(...records)
    },
    dropCarried: async (matches) => {
      for (let i = carried.length - 1; i >= 0; i--)
        if (matches(carried[i] as CarriedCredential)) carried.splice(i, 1)
    },
    providers: () => ({
      'onepassword-service-account': {
        kind: 'onepassword-service-account',
        resolve: async () => SecretValue.fromString('tok_0123456789abcdef'),
      },
    }),
    keys,
    available: async () => new Set(['onepassword-service-account', 'keychain-copy'] as const),
    vaultItems: async (provider) =>
      provider === 'onepassword-service-account' || provider === 'keychain-copy'
        ? [
            { id: 'api-token', title: 'API token' },
            { id: 'odd-title', title: 'Bank‮ moc.live' },
          ]
        : [],
    copyItem: async (itemRef, fields) => {
      copied.push(`${itemRef}:${fields.join(',')}`)
    },
    audit: {
      append: async (event) => {
        audit.push(event)
      },
    },
    now: () => Date.parse('2026-11-17T12:00:00.000Z'),
  })
  return { keeper, signed, audit, keychain, keys, copied, installs, installed, carried, manifest }
}

describe('CredentialKeeper', () => {
  it('makes a Valet SSH key, grants it with a signature, and forgets it when the grant goes', async () => {
    const { keeper, signed, audit, keys } = setup()
    const key = await keeper.generateKey('nas', 'key')
    expect(key.publicKey).toMatch(/^ssh-ed25519 [A-Za-z0-9+/]{68} valet\.nas\.key$/)
    expect(audit).toContainEqual({
      type: 'key-generated',
      adapterId: 'nas',
      credential: 'key',
      fingerprint: key.fingerprint,
    })
    const info = await keeper.make({
      adapterId: 'nas',
      adapterHash: HASH,
      credential: 'key',
      provider: 'valet-key',
      itemId: key.itemRef,
    })
    expect(info).toMatchObject({ provider: 'valet-key', publicKey: key.publicKey, signed: true })
    expect(signed).toEqual([
      expect.objectContaining({
        provider: 'valet-key',
        kind: 'ssh-key',
        targets: ['nas.example.com:22'],
        itemTitle: `Valet-made key ${key.fingerprint}`,
      }),
    ])
    // The gate finds it, and the key resolves as an OpenSSH private key.
    const source = keeper.sourceFor('nas', HASH)
    const grant = await source.findGrant('key')
    expect(grant).not.toBeNull()
    const value = await source.resolve(grant!, 'ssh-key')
    expect(value.reveal((v) => v.startsWith('-----BEGIN OPENSSH PRIVATE KEY-----'))).toBe(true)
    value.dispose()
    // Nothing the window sees holds the private half.
    expect(JSON.stringify(await keeper.list())).not.toContain('PRIVATE KEY')
    await keeper.revoke('nas', 'key')
    expect(await keys?.info(key.itemRef)).toBeNull()
    expect(signed).toEqual([])
    expect(await source.findGrant('key')).toBeNull()
  })

  it('refuses a Valet key for a token, a vault item for a Valet key, and a key it did not make', async () => {
    const { keeper } = setup()
    const key = await keeper.generateKey('nas', 'key')
    const base = { adapterId: 'nas', adapterHash: HASH } as const
    await expect(
      keeper.make({ ...base, credential: 'api', provider: 'valet-key', itemId: key.itemRef }),
    ).rejects.toMatchObject({ errorClass: 'invalid' })
    await expect(
      keeper.make({ ...base, credential: 'key', provider: 'valet-key', itemId: 'api-token' }),
    ).rejects.toMatchObject({ errorClass: 'invalid' })
    await expect(
      keeper.make({
        ...base,
        credential: 'key',
        provider: 'valet-key',
        itemId: 'valet-key:0b5e2f1c-3d4a-4b6c-8d7e-9f0a1b2c3d4e',
      }),
    ).rejects.toMatchObject({ errorClass: 'not-found' })
    await expect(keeper.generateKey('nas', 'api')).rejects.toMatchObject({ errorClass: 'invalid' })
    await expect(keeper.generateKey('nas', 'nope')).rejects.toMatchObject({ errorClass: 'invalid' })
    await expect(keeper.generateKey('other', 'key')).rejects.toMatchObject({ errorClass: 'not-found' })
  })

  it('refuses names, versions and targets the manifest does not declare', async () => {
    const { keeper, signed } = setup()
    const ok = {
      adapterId: 'nas',
      adapterHash: HASH,
      credential: 'api',
      provider: 'onepassword-service-account',
      itemId: 'api-token',
    } as const
    for (const bad of [
      { ...ok, credential: 'constructor' },
      { ...ok, credential: '__proto__' },
      { ...ok, adapterHash: 'b'.repeat(64) },
      { ...ok, targets: ['evil.example.com'] },
      { ...ok, targets: [] },
      { ...ok, itemId: '../../etc' },
      { ...ok, provider: 'messages' as never },
    ])
      await expect(keeper.make(bad)).rejects.toBeInstanceOf(Error)
    expect(signed).toEqual([])
    // A narrower grant is fine, and is what the card shows.
    await keeper.make({ ...ok, targets: ['api.example.com'] })
    expect(signed).toEqual([expect.objectContaining({ targets: ['api.example.com'] })])
    expect(signed[0]?.description).toContain('api.example.com')
    expect(signed[0]?.description).not.toContain('up.example.com')
  })

  it('makes nothing when the person cancels, and copies a Keychain item only once signed', async () => {
    const declined = setup({ approve: false })
    const request = {
      adapterId: 'nas',
      adapterHash: HASH,
      credential: 'api',
      provider: 'keychain-copy',
      itemId: 'api-token',
    } as const
    await expect(declined.keeper.make(request)).rejects.toMatchObject({ errorClass: 'not-granted' })
    expect(declined.copied).toEqual([])
    expect(await declined.keeper.list()).toEqual([])
    const approved = setup()
    await approved.keeper.make(request)
    // A Keychain copy's id is <vault>-<item>, as the person's 1Password lists it.
    expect(approved.copied).toEqual(['op://api/token:token'])
  })

  it('shows a title that could reorder the card as "Untitled item"', async () => {
    const { keeper, signed } = setup()
    await keeper.make({
      adapterId: 'nas',
      adapterHash: HASH,
      credential: 'api',
      provider: 'onepassword-service-account',
      itemId: 'odd-title',
    })
    expect(signed[0]?.itemTitle).toBe('Untitled item')
  })

  it('stops handing out a grant once its evidence is gone', async () => {
    const { keeper, signed } = setup()
    await keeper.make({
      adapterId: 'nas',
      adapterHash: HASH,
      credential: 'api',
      provider: 'onepassword-service-account',
      itemId: 'api-token',
    })
    const source = keeper.sourceFor('nas', HASH)
    expect(await source.findGrant('api')).not.toBeNull()
    signed.splice(0)
    expect(await source.findGrant('api')).toBeNull()
    expect(await keeper.list()).toEqual([expect.objectContaining({ signed: false })])
    // Another version's source never finds this one's grant.
    expect(await keeper.sourceFor('nas', 'c'.repeat(64)).findGrant('api')).toBeNull()
  })

  it('never hands a Valet key to adapter code, and keeps a key to the credential it was made for', async () => {
    const { keeper, signed } = setup()
    const base = { adapterId: 'nas', adapterHash: HASH, provider: 'valet-key' } as const
    const forEnt = await keeper.generateKey('nas', 'ent').catch(() => null)
    const key = await keeper.generateKey('nas', 'key')
    await expect(
      keeper.make({ ...base, credential: 'ent', itemId: forEnt?.itemRef ?? key.itemRef }),
    ).rejects.toMatchObject({
      errorClass: 'invalid',
    })
    // A key made for `key` isn't granted as `backup`: the server trusts it by its label.
    await expect(keeper.make({ ...base, credential: 'backup', itemId: key.itemRef })).rejects.toMatchObject({
      errorClass: 'invalid',
    })
    expect(signed).toEqual([])
  })

  it('carries a grant over an update the person approved, never over a rollback, and revoke ends a carry', async () => {
    const request = {
      adapterId: 'nas',
      adapterHash: HASH,
      credential: 'api',
      provider: 'onepassword-service-account',
      itemId: 'api-token',
    } as const
    // A rollback's approval never carries a grant.
    const back = setup()
    await back.keeper.make(request)
    back.installed.hash = HASH2
    back.installs.push({
      adapterId: 'nas',
      adapterHash: HASH2,
      previousHash: HASH,
      inheritsSession: true,
      source: 'rollback',
    })
    await back.keeper.carry('nas', HASH2, { hash: HASH, manifest: back.manifest })
    expect(back.carried).toEqual([])
    expect(await back.keeper.sourceFor('nas', HASH2).findGrant('api')).toBeNull()
    // Even with a real carry record in the ledger, rollback evidence doesn't make it count.
    const rollback = back.installs[0] as Install
    back.installs[0] = { ...rollback, source: 'update' }
    await back.keeper.carry('nas', HASH2, { hash: HASH, manifest: back.manifest })
    expect(back.carried).toHaveLength(1)
    expect(await back.keeper.sourceFor('nas', HASH2).findGrant('api')).not.toBeNull()
    back.installs[0] = rollback
    expect(await back.keeper.sourceFor('nas', HASH2).findGrant('api')).toBeNull()

    // An update carries, and revoking the carried grant drops its record.
    const up = setup()
    await up.keeper.make(request)
    up.installed.hash = HASH2
    up.installs.push({
      adapterId: 'nas',
      adapterHash: HASH2,
      previousHash: HASH,
      inheritsSession: true,
      source: 'update',
    })
    await up.keeper.carry('nas', HASH2, { hash: HASH, manifest: up.manifest })
    expect(up.carried).toHaveLength(1)
    expect(await up.keeper.sourceFor('nas', HASH2).findGrant('api')).not.toBeNull()
    await up.keeper.revoke('nas', 'api')
    expect(up.carried).toEqual([])
    expect(await up.keeper.sourceFor('nas', HASH2).findGrant('api')).toBeNull()
  })

  it('refuses to make keys in a build without a Keychain', async () => {
    const { keeper } = setup({ keys: false })
    await expect(keeper.generateKey('nas', 'key')).rejects.toMatchObject({ errorClass: 'unavailable' })
  })
})
