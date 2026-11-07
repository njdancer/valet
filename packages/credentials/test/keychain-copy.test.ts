import { CredentialError } from '@valet/core'
import { describe, expect, it } from 'vitest'
import {
  COPY_SERVICE,
  type CopySource,
  copyAccount,
  encodeCopySource,
  KeychainCopyProvider,
  parseCopySource,
} from '../src/keychain-copy'
import { KeychainHelper } from '../src/keychain-helper'
import { fakeKeychain } from './fake-keychain'
import { ManualTimers } from './fake-process'

const CANARY = 'canary-pw-91be0c44'
const ITEM = 'op://abcdefghijklmnopqrstuvwxyz/zyxwvutsrqponmlkjihgfedcba'
const SOURCE: CopySource = {
  account: 'my.1password.com',
  vaultId: 'abcdefghijklmnopqrstuvwxyz',
  itemId: 'zyxwvutsrqponmlkjihgfedcba',
  field: 'password',
  sourceUpdatedAt: '2026-11-01T00:00:00.000Z',
  copiedAt: '2026-11-07T00:00:00.000Z',
}

async function failureOf(promise: Promise<unknown>): Promise<CredentialError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof CredentialError) return error
    throw error
  }
  throw new Error('expected a CredentialError')
}

function provider() {
  const keychain = fakeKeychain()
  const copies = new KeychainCopyProvider({
    keychain: new KeychainHelper({ helperPath: '/h', spawner: keychain.spawner, timers: new ManualTimers() }),
  })
  return { keychain, copies }
}

describe('KeychainCopyProvider', () => {
  it('stores a field under its own account, with its source as the comment, and resolves it', async () => {
    const { keychain, copies } = provider()
    await copies.store(ITEM, Buffer.from(CANARY), SOURCE)
    const stored = keychain.get(COPY_SERVICE, `${ITEM}#password`)
    expect(stored?.secret.toString()).toBe(CANARY)
    expect(parseCopySource(stored?.comment ?? '')).toEqual(SOURCE)
    expect(stored?.comment).not.toContain(CANARY)
    expect((await copies.resolve(ITEM, 'password')).reveal((plaintext) => plaintext)).toBe(CANARY)
    expect(await copies.source(ITEM, 'password')).toEqual(SOURCE)
    expect(copies.kind).toBe('keychain-copy')
  })

  it('reports a field that was never copied as not-found, and its source as null', async () => {
    const { copies } = provider()
    expect((await failureOf(copies.resolve(ITEM, 'username'))).failure).toBe('not-found')
    expect(await copies.source(ITEM, 'username')).toBeNull()
  })

  it('has no copy of a one-time password', async () => {
    const { copies, keychain } = provider()
    expect((await failureOf(copies.resolve(ITEM, 'otp'))).failure).toBe('field-missing')
    const value = Buffer.from('JBSWY3DPEHPK3PXP')
    await failureOf(copies.store(ITEM, value, { ...SOURCE, field: 'otp' }))
    expect(value.every((byte) => byte === 0)).toBe(true)
    expect(keychain.calls).toHaveLength(0)
  })

  it('refuses an item reference that is not exactly op://<vault>/<item>', async () => {
    const { copies, keychain } = provider()
    for (const ref of ['op://v/i/password', 'v/i', 'op://v/i?x=1', `${ITEM}#username`]) {
      expect((await failureOf(copies.resolve(ref, 'password'))).failure).toBe('not-found')
      expect(await copies.source(ref, 'password')).toBeNull()
    }
    expect(keychain.calls).toHaveLength(0)
    expect(copyAccount('op://v/i', 'username')).toBe('op://v/i#username')
  })

  it('treats a copy whose comment is not a source as having none', async () => {
    const { copies, keychain } = provider()
    keychain.items.set(`${COPY_SERVICE}\u0000${ITEM}#password`, {
      secret: Buffer.from(CANARY),
      comment: 'hand-made',
    })
    expect(await copies.source(ITEM, 'password')).toBeNull()
  })

  it('forgets every field of an item', async () => {
    const { copies, keychain } = provider()
    await copies.store(ITEM, Buffer.from('nick@example.com'), { ...SOURCE, field: 'username' })
    await copies.store(ITEM, Buffer.from(CANARY), SOURCE)
    await copies.forget(ITEM)
    expect(keychain.items.size).toBe(0)
  })

  it('uses the service it is given', async () => {
    const keychain = fakeKeychain()
    const copies = new KeychainCopyProvider({
      keychain: new KeychainHelper({
        helperPath: '/h',
        spawner: keychain.spawner,
        timers: new ManualTimers(),
      }),
      service: 'valet.dev.copy',
    })
    await copies.store(ITEM, Buffer.from(CANARY), SOURCE)
    expect(keychain.get('valet.dev.copy', `${ITEM}#password`)).toBeDefined()
  })
})

describe('parseCopySource', () => {
  it('reads back what encodeCopySource wrote', () => {
    expect(parseCopySource(encodeCopySource(SOURCE))).toEqual(SOURCE)
  })

  it('refuses anything but exactly a source', () => {
    const base = JSON.parse(encodeCopySource(SOURCE)) as Record<string, unknown>
    const variants: unknown[] = [
      { ...base, v: 2 },
      { ...base, extra: 1 },
      { ...base, field: 'otp' },
      { ...base, vaultId: 'a/b' },
      { ...base, account: '' },
      { ...base, account: 'a\nb' },
      { ...base, sourceUpdatedAt: 'yesterday' },
      { ...base, copiedAt: 7 },
      [base],
      null,
    ]
    for (const variant of variants) expect(parseCopySource(JSON.stringify(variant))).toBeNull()
    expect(parseCopySource('{')).toBeNull()
    const { copiedAt: _, ...missing } = base
    expect(parseCopySource(JSON.stringify(missing))).toBeNull()
  })
})
