import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type CredentialGrant, ValetError } from '@valet/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FileCredentialGrantStore, isValidCredentialGrant } from '../src/credential-grant-store'
import { FileGrantStore } from '../src/grant-store'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

const grant: CredentialGrant = {
  adapterId: 'icloud-mail',
  adapterHash: HASH_A,
  credential: 'mail',
  kind: 'password',
  custody: 'kept',
  provider: 'onepassword-cli',
  itemRef: 'op://valet/iCloud',
  targets: ['imap.mail.me.com:993'],
  grantedAt: '2026-11-17T00:00:00.000Z',
}

const keyGrant: CredentialGrant = {
  ...grant,
  adapterId: 'nas-files',
  credential: 'nas',
  kind: 'ssh-key',
  provider: 'valet-key',
  itemRef: 'valet-key:2f1c6a2e-5d4b-4c3a-9b1e-0a1b2c3d4e5f',
  targets: ['nas.example.com:22'],
}

let dir: string
let path: string

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'valet-credential-grants-'))
  path = join(dir, 'credential-grants.json')
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

async function errorOf(promise: Promise<unknown>): Promise<ValetError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof ValetError) return error
    throw error
  }
  throw new Error('expected a ValetError')
}

describe('isValidCredentialGrant', () => {
  it('accepts well-formed grants of each provider', () => {
    expect(isValidCredentialGrant(grant)).toBe(true)
    expect(isValidCredentialGrant(keyGrant)).toBe(true)
    expect(isValidCredentialGrant({ ...grant, provider: 'keychain-copy' })).toBe(true)
    expect(isValidCredentialGrant({ ...grant, provider: 'fake', itemRef: 'anything' })).toBe(true)
    expect(
      isValidCredentialGrant({
        ...grant,
        custody: 'entrusted',
        targets: ['192.168.1.20:8123', 'fd00::1:22'],
      }),
    ).toBe(true)
    expect(
      isValidCredentialGrant({ ...grant, kind: 'token', targets: ['api.example.com', '10.0.0.2'] }),
    ).toBe(true)
  })

  const bad: [string, unknown][] = [
    ['a Messages provider', { ...grant, provider: 'messages' }],
    ['an unknown provider', { ...grant, provider: 'gpg' }],
    ['an unknown kind', { ...grant, kind: 'otp' }],
    ['an unknown custody', { ...grant, custody: 'shared' }],
    ['a Valet key that is not an SSH key', { ...keyGrant, kind: 'password' }],
    ['a Valet key reference on a vault provider', { ...grant, itemRef: keyGrant.itemRef }],
    ['a malformed Valet key reference', { ...keyGrant, itemRef: 'valet-key:../../etc' }],
    ['a vault reference with a field in it', { ...grant, itemRef: 'op://valet/iCloud/password' }],
    ['a query in the reference', { ...grant, itemRef: 'op://valet/iCloud?attribute=otp' }],
    ['no targets', { ...grant, targets: [] }],
    ['a repeated target', { ...grant, targets: ['imap.mail.me.com:993', 'imap.mail.me.com:993'] }],
    ['a wildcard target', { ...grant, targets: ['*.mail.me.com'] }],
    ['a URL target', { ...grant, targets: ['https://imap.mail.me.com'] }],
    ['an upper-case target', { ...grant, targets: ['IMAP.mail.me.com:993'] }],
    ['too many targets', { ...grant, targets: Array.from({ length: 21 }, (_, i) => `h${i}.example.com`) }],
    ['a short hash', { ...grant, adapterHash: 'abc' }],
    ['a bad credential name', { ...grant, credential: 'Mail' }],
    ['an extra field', { ...grant, value: 'hunter2' }],
    ['a missing field', (({ grantedAt: _, ...rest }) => rest)(grant)],
    ['a control character in the reference', { ...grant, provider: 'fake', itemRef: 'a\nb' }],
    ['a bad time', { ...grant, grantedAt: 'yesterday' }],
  ]

  it.each(bad)('refuses %s', (_, value) => {
    expect(isValidCredentialGrant(value)).toBe(false)
  })
})

describe('FileCredentialGrantStore', () => {
  it('starts empty, and keeps one grant per adapter, hash and credential', async () => {
    const store = new FileCredentialGrantStore({ path })
    expect(await store.list()).toEqual([])
    await store.put(grant)
    await store.put({ ...grant, targets: ['imap.mail.me.com:993'], provider: 'keychain-copy' })
    await store.put({ ...grant, adapterHash: HASH_B })
    await store.put(keyGrant)
    const all = await store.list()
    expect(all).toHaveLength(3)
    expect(await store.find('icloud-mail', HASH_A, 'mail')).toMatchObject({ provider: 'keychain-copy' })
    expect(await store.find('icloud-mail', HASH_B, 'mail')).toMatchObject({ provider: 'onepassword-cli' })
    expect(await store.find('icloud-mail', HASH_A, 'other')).toBeNull()
    expect((await fs.stat(path)).mode & 0o777).toBe(0o600)
  })

  it('revokes a credential for every hash, and leaves the rest', async () => {
    const store = new FileCredentialGrantStore({ path })
    await store.put(grant)
    await store.put({ ...grant, adapterHash: HASH_B })
    await store.put(keyGrant)
    await store.revoke('icloud-mail', 'mail')
    expect(await store.list()).toEqual([keyGrant])
  })

  it('refuses to store a malformed grant', async () => {
    const error = await errorOf(new FileCredentialGrantStore({ path }).put({ ...grant, targets: [] }))
    expect([error.stage, error.errorClass]).toEqual(['grant', 'invalid'])
    await expect(fs.access(path)).rejects.toThrow()
  })

  it('hands out frozen copies, so a caller can’t widen a stored grant in memory', async () => {
    const store = new FileCredentialGrantStore({ path })
    await store.put(grant)
    const found = (await store.find('icloud-mail', HASH_A, 'mail')) as CredentialGrant
    expect(Object.isFrozen(found)).toBe(true)
    expect(Object.isFrozen(found.targets)).toBe(true)
  })

  it('refuses the whole file if one grant in it is bad, or two share a slot', async () => {
    for (const grants of [
      [grant, { ...grant, kind: 'nope' }],
      [grant, { ...grant, provider: 'keychain-copy' }],
    ]) {
      await fs.writeFile(path, JSON.stringify({ version: 1, grants }), { mode: 0o600 })
      const error = await errorOf(new FileCredentialGrantStore({ path }).list())
      expect([error.stage, error.errorClass]).toEqual(['config', 'invalid'])
    }
  })

  it('refuses a file of another version or shape', async () => {
    for (const value of [
      { version: 2, grants: [] },
      { grants: [] },
      [],
      'x',
      { version: 1, grants: [], more: 1 },
    ]) {
      await fs.writeFile(path, JSON.stringify(value), { mode: 0o600 })
      const error = await errorOf(new FileCredentialGrantStore({ path }).list())
      expect(error.errorClass).toBe('invalid')
    }
  })

  it('refuses a symlink, and a file others can write', async () => {
    const elsewhere = join(dir, 'planted.json')
    await fs.writeFile(elsewhere, JSON.stringify({ version: 1, grants: [grant] }), { mode: 0o600 })
    await fs.symlink(elsewhere, path)
    expect((await errorOf(new FileCredentialGrantStore({ path }).list())).errorClass).toBe('insecure-file')
    await fs.rm(path)
    await fs.writeFile(path, JSON.stringify({ version: 1, grants: [grant] }))
    await fs.chmod(path, 0o666)
    expect((await errorOf(new FileCredentialGrantStore({ path }).list())).errorClass).toBe('insecure-file')
  })

  it('never reads a secret grant file as credential grants, nor the other way', async () => {
    const secrets = join(dir, 'grants.json')
    await new FileGrantStore({ path: secrets }).put({
      adapterId: 'woolworths',
      adapterHash: HASH_A,
      secret: 'login',
      provider: 'onepassword-cli',
      itemRef: 'op://valet/Woolworths',
      origins: ['https://www.woolworths.com.au'],
      grantedAt: '2026-11-07T00:00:00.000Z',
    })
    expect((await errorOf(new FileCredentialGrantStore({ path: secrets }).list())).errorClass).toBe('invalid')
    await new FileCredentialGrantStore({ path }).put(grant)
    expect((await errorOf(new FileGrantStore({ path }).list())).errorClass).toBe('invalid')
  })

  it('loses no grant when puts race', async () => {
    const store = new FileCredentialGrantStore({ path })
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        store.put({ ...grant, credential: `c${i}`, grantedAt: grant.grantedAt }),
      ),
    )
    expect(await store.list()).toHaveLength(10)
  })
})
