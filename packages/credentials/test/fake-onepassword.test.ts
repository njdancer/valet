// Valet's real 1Password providers against the fake 1Password (fakes/onepassword): the SDK's
// service account and desktop app through Valet's own factories, the Keychain copy and its re-sync,
// and the op CLI through Valet's spawner, with the codesign check it makes first. Nothing here
// reaches a real 1Password or Keychain.

import { CredentialError, SecretValue } from '@valet/core'
import {
  DEMO_ONEPASSWORD_ACCOUNT,
  DEMO_SERVICE_ACCOUNT_TOKEN,
  DEMO_SHOP_ITEM_ID,
  DEMO_VAULTS,
  demoOnePassword,
  FAKE_OP_PATH,
  FakeOnePassword,
  fakeOpSpawner,
  fakeSdk,
} from '@valet/fake-onepassword'
import { describe, expect, it } from 'vitest'
import { COPY_SERVICE, KeychainCopyProvider } from '../src/keychain-copy'
import { MemoryKeychain } from '../src/memory-keychain'
import { OnePasswordCliProvider } from '../src/onepassword-cli'
import {
  desktopAuthClientFactory,
  KeychainCopySync,
  OnePasswordDesktopProvider,
} from '../src/onepassword-desktop'
import { OnePasswordServiceAccountProvider, serviceAccountClientFactory } from '../src/onepassword-sdk'

const LOGIN = { username: 'shopper@example.test', password: 'shop-test-password' }
const SHOP = `op://${DEMO_VAULTS.personal.id}/${DEMO_SHOP_ITEM_ID}`

function setup(autoApprove = true) {
  let now = Date.parse('2026-11-11T00:00:00Z')
  const fake = new FakeOnePassword(demoOnePassword(LOGIN, { autoApprove, now: () => now }))
  const load = async () => fakeSdk(fake)
  const desktop = new OnePasswordDesktopProvider({
    account: DEMO_ONEPASSWORD_ACCOUNT.name,
    clientFactory: desktopAuthClientFactory(load),
  })
  return { fake, load, desktop, advance: (ms: number) => (now += ms) }
}

const reveal = async (value: Promise<SecretValue>) => (await value).reveal((s) => s)

async function failure(work: Promise<unknown>): Promise<string> {
  try {
    await work
  } catch (error) {
    if (error instanceof CredentialError) return error.failure
    throw error
  }
  throw new Error('expected a CredentialError')
}

describe('the service account, through Valet’s factory and the fake SDK', () => {
  it('reads and lists its vault, and nothing else', async () => {
    const { fake, load } = setup()
    const provider = new OnePasswordServiceAccountProvider({
      tokenSource: { token: async () => SecretValue.fromString(DEMO_SERVICE_ACCOUNT_TOKEN) },
      clientFactory: serviceAccountClientFactory(load),
    })
    const items = await provider.listItems('Valet')
    expect(items.map((i) => i.title)).toEqual(['Woolworths'])
    const ref = `op://${DEMO_VAULTS.valet.id}/${items[0]?.id}`
    expect(await reveal(provider.resolve(ref, 'password'))).toBe(LOGIN.password)
    expect(await failure(provider.resolve(ref, 'otp'))).toBe('field-missing')
    expect(await failure(provider.resolve(SHOP, 'password'))).toBe('not-found')
    expect(await failure(provider.listItems('Personal'))).toBe('not-found')
    expect(fake.calls.some((c) => c.auth === 'desktop')).toBe(false)
    ;(fake.serviceAccounts[0] as { revoked?: boolean }).revoked = true
    expect(await failure(provider.resolve(ref, 'password'))).toBe('unavailable')
  })

  it('a token 1Password doesn’t know is unavailable', async () => {
    const { load } = setup()
    const provider = new OnePasswordServiceAccountProvider({
      tokenSource: { token: async () => SecretValue.fromString('ops_not-a-real-one') },
      clientFactory: serviceAccountClientFactory(load),
    })
    expect(await failure(provider.listItems('Valet'))).toBe('unavailable')
  })
})

describe('the desktop app and the Keychain copy (D6), against the fake', () => {
  it('lists every vault, copies the item with one approval, and reads the copy without 1Password', async () => {
    const { fake, desktop } = setup(false)
    fake.on('prompt', (prompt) => {
      fake.unlock(DEMO_ONEPASSWORD_ACCOUNT.unlockPassword)
      fake.allow(prompt.id)
    })
    const keychain = new MemoryKeychain()
    const copies = new KeychainCopyProvider({ keychain })
    const sync = new KeychainCopySync({ desktop, copies, now: () => new Date('2026-11-11T00:00:00Z') })
    expect((await desktop.listVaults()).map((v) => v.title)).toEqual(['Personal', 'Shared', 'Valet'])
    expect((await desktop.listItems(DEMO_VAULTS.personal.id)).map((i) => i.title)).toContain('Library card')
    await sync.copy(SHOP, ['username', 'password'])
    expect(fake.prompts).toHaveLength(1)
    const reads = fake.calls.length
    expect(await reveal(copies.resolve(SHOP, 'password'))).toBe(LOGIN.password)
    expect(fake.calls.length).toBe(reads)
    expect(await copies.source(SHOP, 'password')).toMatchObject({
      account: 'Tess Tester',
      vaultId: DEMO_VAULTS.personal.id,
      sourceUpdatedAt: '2026-11-01T09:30:00.000Z',
    })
    expect(keychain.items().every((i) => i.service === COPY_SERVICE)).toBe(true)
  })

  it('re-syncs a changed item only while the approval is up, and never asks', async () => {
    const { fake, desktop, advance } = setup()
    const copies = new KeychainCopyProvider({ keychain: new MemoryKeychain() })
    const sync = new KeychainCopySync({ desktop, copies })
    await sync.copy(SHOP, ['username', 'password'])
    expect(await sync.refreshIfLive(SHOP, ['username', 'password'])).toBe('current')
    fake.updateItem(DEMO_SHOP_ITEM_ID, { password: 'changed-test-password' })
    expect(await sync.refreshIfLive(SHOP, ['username', 'password'])).toBe('copied')
    expect(await reveal(copies.resolve(SHOP, 'password'))).toBe('changed-test-password')

    fake.lock()
    const prompts = fake.prompts.length
    expect(await failure(desktop.updatedAt(SHOP))).toBe('locked')
    expect(desktop.live).toBe(false)
    expect(await sync.refreshIfLive(SHOP, ['password'])).toBe('not-live')
    expect(fake.prompts.length).toBe(prompts)
    advance(1)
  })

  it('copying after the approval lapsed asks the person again at once, but a denial is final', async () => {
    const { fake, desktop } = setup(false)
    let answer: 'allow' | 'deny' = 'allow'
    fake.on('prompt', (prompt) => {
      fake.unlock(DEMO_ONEPASSWORD_ACCOUNT.unlockPassword)
      if (answer === 'allow') fake.allow(prompt.id)
      else fake.deny(prompt.id)
    })
    const copies = new KeychainCopyProvider({ keychain: new MemoryKeychain() })
    const sync = new KeychainCopySync({ desktop, copies })
    await sync.copy(SHOP, ['password'])
    fake.lock()
    fake.updateItem(DEMO_SHOP_ITEM_ID, { password: 'changed-test-password' })
    await sync.copy(SHOP, ['password'])
    expect(await reveal(copies.resolve(SHOP, 'password'))).toBe('changed-test-password')
    expect(fake.prompts.map((p) => p.state)).toEqual(['allowed', 'allowed'])
    fake.lock()
    answer = 'deny'
    expect(await failure(sync.copy(SHOP, ['password']))).toBe('locked')
    expect(fake.prompts.map((p) => p.state)).toEqual(['allowed', 'allowed', 'denied'])
  })

  it('a lapsed approval asks again on the next attended call', async () => {
    const { fake, desktop, advance } = setup()
    await desktop.listVaults()
    advance(11 * 60_000)
    expect(await failure(desktop.listVaults())).toBe('locked')
    expect(await desktop.listVaults()).toHaveLength(3)
    expect(fake.prompts).toHaveLength(2)
  })

  it('a denied prompt, the integration turned off, or another account are reported, not thrown raw', async () => {
    const { fake, desktop } = setup(false)
    fake.on('prompt', (prompt) => fake.deny(prompt.id))
    expect(await failure(desktop.listVaults())).toBe('locked')
    fake.setIntegration(false)
    expect(await failure(desktop.readField(SHOP, 'password'))).toBe('locked')
    const other = new OnePasswordDesktopProvider({
      account: 'Someone Else',
      clientFactory: desktopAuthClientFactory(async () => fakeSdk(fake)),
    })
    fake.setIntegration(true)
    expect(await failure(other.listVaults())).toBe('unavailable')
  })
})

describe('the op CLI, through Valet’s spawner', () => {
  it('reads fields and codes and lists a vault; failures classify as op’s wording says', async () => {
    const { fake } = setup()
    const cli = new OnePasswordCliProvider({
      opPaths: [FAKE_OP_PATH],
      searchPath: null,
      isExecutable: async (path) => path === FAKE_OP_PATH,
      spawner: fakeOpSpawner(fake),
    })
    expect(await reveal(cli.resolve(SHOP, 'username'))).toBe(LOGIN.username)
    const streaming = `op://${DEMO_VAULTS.personal.id}/demostreaming0000000000000`
    expect(await reveal(cli.resolve(streaming, 'otp'))).toMatch(/^\d{6}$/)
    expect((await cli.listItems('Personal')).map((i) => i.title)).toEqual([
      'Woolworths (demo account)',
      'Library card',
      'Streaming service',
    ])
    expect(await failure(cli.resolve(SHOP, 'otp'))).toBe('field-missing')
    expect(await failure(cli.resolve(`op://${DEMO_VAULTS.personal.id}/nothing`, 'password'))).toBe(
      'not-found',
    )
    expect(await failure(cli.listItems('Nowhere'))).toBe('not-found')
    fake.autoApprove = false
    fake.lock()
    fake.on('prompt', (prompt) => fake.deny(prompt.id))
    expect(await failure(cli.resolve(SHOP, 'password'))).toBe('locked')
    fake.setIntegration(false)
    expect(await failure(cli.resolve(SHOP, 'password'))).toBe('locked')
  })
})

describe('MemoryKeychain', () => {
  it('keeps the helper’s rules, zeroes what it is handed, and reports each change', async () => {
    const saved: number[] = []
    const keychain = new MemoryKeychain({
      items: [
        { service: 'valet.copy', account: 'a', secret: 'one', comment: 'c' },
        { service: 'not-valet', account: 'b', secret: 'two', comment: '' },
        { service: 'valet.copy', account: 'c', secret: '', comment: '' },
      ],
      persist: (items) => saved.push(items.length),
    })
    expect(keychain.items().map((i) => i.account)).toEqual(['a'])
    expect(await reveal(keychain.read('valet.copy', 'a'))).toBe('one')
    expect(await keychain.info('valet.copy', 'a')).toBe('c')
    expect(await keychain.info('valet.copy', 'z')).toBeNull()
    expect(await failure(keychain.read('valet.copy', 'z'))).toBe('not-found')
    expect(await failure(keychain.read('other', 'a'))).toBe('not-found')
    const secret = Buffer.from('two')
    await keychain.write('valet.token', 'b', secret, 'comment')
    expect(secret.every((b) => b === 0)).toBe(true)
    expect(await failure(keychain.write('valet.token', 'b', Buffer.alloc(0), ''))).toBe('unavailable')
    await keychain.delete('valet.token', 'b')
    await keychain.delete('valet.token', 'b')
    await keychain.purge('valet.copy')
    await keychain.purge('valet.copy')
    expect(await failure(keychain.purge('nope'))).toBe('not-found')
    expect(keychain.items()).toEqual([])
    expect(saved).toEqual([2, 1, 0])
  })
})
