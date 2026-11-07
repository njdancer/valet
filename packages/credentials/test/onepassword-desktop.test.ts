import { inspect } from 'node:util'
import { CredentialError } from '@valet/core'
import { describe, expect, it, vi } from 'vitest'
import { KeychainCopyProvider } from '../src/keychain-copy'
import { KeychainHelper } from '../src/keychain-helper'
import {
  type DesktopClient,
  desktopClientFactory,
  isOnePasswordAccount,
  KeychainCopySync,
  OnePasswordDesktopProvider,
} from '../src/onepassword-desktop'
import { fakeKeychain } from './fake-keychain'
import { ManualTimers } from './fake-process'

const sdk = vi.hoisted(() => ({
  createClient: vi.fn(async (config: unknown) => ({ config })),
  DesktopAuth: class {
    constructor(readonly accountName: string) {}
  },
}))
vi.mock('@1password/sdk', () => sdk)

const CANARY = 'canary-pw-5f0e22d8'
const ACCOUNT = 'my.1password.com'
const VAULT = 'abcdefghijklmnopqrstuvwxyz'
const ITEM_ID = 'zyxwvutsrqponmlkjihgfedcba'
const ITEM = `op://${VAULT}/${ITEM_ID}`
const NOW = new Date('2026-11-07T03:00:00.000Z')

class DesktopSessionExpiredError extends Error {}

interface FakeOnePassword {
  values: Record<string, string>
  updatedAt: Date
  resolves: string[]
  creates: number
  fail?: unknown
}

function fakeOnePassword(): FakeOnePassword {
  return {
    values: { [`${ITEM}/username`]: 'nick@example.com', [`${ITEM}/password`]: CANARY },
    updatedAt: new Date('2026-11-01T00:00:00.000Z'),
    resolves: [],
    creates: 0,
  }
}

function clientFor(state: FakeOnePassword): DesktopClient {
  return {
    secrets: {
      resolve: async (reference) => {
        state.resolves.push(reference)
        if (state.fail !== undefined) throw state.fail
        const value = state.values[reference]
        if (value === undefined)
          throw new Error('error resolving secret reference: the field cannot be found')
        return value
      },
    },
    vaults: { list: async () => [{ id: VAULT, title: 'Personal' }] },
    items: {
      list: async (vaultId) => {
        if (state.fail !== undefined) throw state.fail
        return vaultId === VAULT ? [{ id: ITEM_ID, title: 'Woolworths', updatedAt: state.updatedAt }] : []
      },
    },
  }
}

function setup(state = fakeOnePassword(), timers = new ManualTimers()) {
  const desktop = new OnePasswordDesktopProvider({
    account: ACCOUNT,
    clientFactory: async (account) => {
      expect(account).toBe(ACCOUNT)
      state.creates += 1
      return clientFor(state)
    },
    timers,
  })
  const keychain = fakeKeychain()
  const copies = new KeychainCopyProvider({
    keychain: new KeychainHelper({ helperPath: '/h', spawner: keychain.spawner, timers }),
  })
  const sync = new KeychainCopySync({ desktop, copies, now: () => NOW })
  return { state, desktop, keychain, copies, sync }
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

describe('OnePasswordDesktopProvider', () => {
  it('resolves through the desktop app, asking once while the approval lasts', async () => {
    const { desktop, state } = setup()
    expect(desktop.live).toBe(false)
    expect((await desktop.resolve(ITEM, 'password')).reveal((plaintext) => plaintext)).toBe(CANARY)
    expect(desktop.live).toBe(true)
    await desktop.resolve(ITEM, 'username')
    expect(state.creates).toBe(1)
    expect(state.resolves).toEqual([`${ITEM}/password`, `${ITEM}/username`])
    expect(desktop.kind).toBe('onepassword-desktop')
  })

  it('drops the approval when 1Password says it lapsed, so the next call asks again', async () => {
    const { desktop, state } = setup()
    await desktop.resolve(ITEM, 'password')
    state.fail = new DesktopSessionExpiredError('desktop session expired')
    expect((await failureOf(desktop.resolve(ITEM, 'password'))).failure).toBe('locked')
    expect(desktop.live).toBe(false)
    state.fail = undefined
    await desktop.resolve(ITEM, 'password')
    expect(state.creates).toBe(2)
  })

  it('reports a refused or disabled approval as locked', async () => {
    for (const message of ['authorization denied by user', 'the desktop app integration is not enabled']) {
      const desktop = new OnePasswordDesktopProvider({
        account: ACCOUNT,
        clientFactory: async () => {
          throw new Error(message)
        },
        timers: new ManualTimers(),
      })
      expect((await failureOf(desktop.resolve(ITEM, 'password'))).failure).toBe('locked')
      expect(desktop.live).toBe(false)
    }
  })

  it('gives up on an approval nobody answers', async () => {
    const timers = new ManualTimers()
    const desktop = new OnePasswordDesktopProvider({
      account: ACCOUNT,
      clientFactory: () => new Promise(() => {}),
      timers,
      approvalTimeoutMs: 1000,
    })
    const pending = failureOf(desktop.resolve(ITEM, 'password'))
    await Promise.resolve()
    expect([...timers.pending.values()].map((timer) => timer.ms)).toContain(1000)
    timers.fireAll()
    expect((await pending).failure).toBe('unavailable')
  })

  it('refuses references that are not op://<vault>/<item> without asking 1Password', async () => {
    const { desktop, state } = setup()
    expect((await failureOf(desktop.resolve('op://v/i/password', 'password'))).failure).toBe('not-found')
    expect((await failureOf(desktop.updatedAt('nope'))).failure).toBe('not-found')
    expect(state.creates).toBe(0)
  })

  it('reports an empty field as missing', async () => {
    const state = fakeOnePassword()
    state.values[`${ITEM}/password`] = ''
    const { desktop } = setup(state)
    expect((await failureOf(desktop.resolve(ITEM, 'password'))).failure).toBe('field-missing')
  })

  it('reads when the item last changed from its overview, not its fields', async () => {
    const { desktop, state } = setup()
    expect(await desktop.updatedAt(ITEM)).toBe('2026-11-01T00:00:00.000Z')
    expect(state.resolves).toEqual([])
    expect((await failureOf(desktop.updatedAt(`op://${VAULT}/aaaaaaaaaaaaaaaaaaaaaaaaaa`))).failure).toBe(
      'not-found',
    )
    state.updatedAt = new Date('nonsense')
    expect((await failureOf(desktop.updatedAt(ITEM))).failure).toBe('unavailable')
  })

  it('lists vaults and items: ids and titles only', async () => {
    const { desktop } = setup()
    expect(await desktop.listVaults()).toEqual([{ id: VAULT, title: 'Personal' }])
    expect(await desktop.listItems('Personal')).toEqual([{ id: ITEM_ID, title: 'Woolworths' }])
  })

  it('forgets the approval on reset', async () => {
    const { desktop, state } = setup()
    await desktop.resolve(ITEM, 'password')
    desktop.reset()
    expect(desktop.live).toBe(false)
    await desktop.resolve(ITEM, 'password')
    expect(state.creates).toBe(2)
  })

  it('takes only a plausible account name', () => {
    expect(isOnePasswordAccount(ACCOUNT)).toBe(true)
    expect(isOnePasswordAccount('')).toBe(false)
    expect(isOnePasswordAccount(' padded')).toBe(false)
    expect(isOnePasswordAccount('a\nb')).toBe(false)
    expect(() => new OnePasswordDesktopProvider({ account: '' })).toThrow()
  })

  it('hands the SDK a DesktopAuth for the account, and no token', async () => {
    await desktopClientFactory(ACCOUNT)
    const config = sdk.createClient.mock.calls[0]?.[0] as { auth: { accountName: string } }
    expect(config.auth).toBeInstanceOf(sdk.DesktopAuth)
    expect(config.auth.accountName).toBe(ACCOUNT)
  })
})

describe('KeychainCopySync', () => {
  it('copies the granted fields with their source, without revealing anything', async () => {
    const { sync, keychain, copies } = setup()
    await sync.copy(ITEM, ['username', 'password'])
    expect(keychain.get('valet.copy', `${ITEM}#password`)?.secret.toString()).toBe(CANARY)
    expect(keychain.get('valet.copy', `${ITEM}#username`)?.secret.toString()).toBe('nick@example.com')
    expect(await copies.source(ITEM, 'password')).toEqual({
      account: ACCOUNT,
      vaultId: VAULT,
      itemId: ITEM_ID,
      field: 'password',
      sourceUpdatedAt: '2026-11-01T00:00:00.000Z',
      copiedAt: NOW.toISOString(),
    })
    for (const call of keychain.calls) expect(call.args.join(' ')).not.toContain(CANARY)
  })

  it('zeroes what it read once the helper has it', async () => {
    const { sync, keychain } = setup()
    await sync.copy(ITEM, ['password'])
    const write = keychain.calls.find((call) => call.args[0] === 'write')
    expect(write?.child.inputSources[0]?.every((byte) => byte === 0)).toBe(true)
  })

  it('refuses to copy a grant that needs a field a copy cannot hold', async () => {
    const { sync, state } = setup()
    expect((await failureOf(sync.copy(ITEM, ['password', 'otp']))).failure).toBe('field-missing')
    expect(state.creates).toBe(0)
  })

  it('never asks the person when no approval is up', async () => {
    const { sync, state } = setup()
    expect(await sync.refreshIfLive(ITEM, ['username', 'password'])).toBe('not-live')
    expect(state.creates).toBe(0)
  })

  it('leaves a current copy alone, and refreshes one whose source changed', async () => {
    const { sync, state, keychain } = setup()
    await sync.copy(ITEM, ['username', 'password'])
    expect(await sync.refreshIfLive(ITEM, ['username', 'password'])).toBe('current')
    const writes = () => keychain.calls.filter((call) => call.args[0] === 'write').length
    expect(writes()).toBe(2)

    state.values[`${ITEM}/password`] = 'canary-pw-new-7c1d'
    state.updatedAt = new Date('2026-11-06T00:00:00.000Z')
    expect(await sync.refreshIfLive(ITEM, ['username', 'password'])).toBe('copied')
    expect(keychain.get('valet.copy', `${ITEM}#password`)?.secret.toString()).toBe('canary-pw-new-7c1d')
    expect(writes()).toBe(4)
  })

  it('fills in a field that has no copy yet', async () => {
    const { sync, desktop, keychain } = setup()
    await sync.copy(ITEM, ['password'])
    expect(desktop.live).toBe(true)
    expect(await sync.refreshIfLive(ITEM, ['username', 'password'])).toBe('copied')
    expect(keychain.get('valet.copy', `${ITEM}#username`)).toBeDefined()
  })

  it('keeps 1Password errors free of the secret', async () => {
    const state = fakeOnePassword()
    state.fail = new Error(`boom ${CANARY}`)
    const { sync } = setup(state)
    const error = await failureOf(sync.copy(ITEM, ['password']))
    expect(inspect(error)).not.toContain(CANARY)
  })
})
