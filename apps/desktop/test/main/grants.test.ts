// @vitest-environment node
// Grant requests checked against the approved manifest: the exact hash, an available provider, a
// requested secret or declared sender, origins inside the request, an item the provider lists.

import { type ProviderKind, parseManifest, ValetError } from '@valet/core'
import { describe, expect, it } from 'vitest'
import {
  checkGrantRequest,
  type GrantCheck,
  grantInfo,
  itemIdOf,
  itemRefFor,
} from '../../src/main/core/grants'
import type { GrantRequest } from '../../src/shared/api'
import { SHOP } from './fixtures'

const HASH = 'b'.repeat(64)
const NOW = new Date('2026-11-07T01:02:03.000Z')

const check: GrantCheck = {
  manifest: parseManifest(SHOP),
  installedHash: HASH,
  available: new Set<ProviderKind>(['onepassword-cli', 'messages']),
  vaultItems: async () => [{ id: 'item1', title: 'Shop' }],
  now: () => NOW,
}

const request: GrantRequest = {
  adapterId: 'shop',
  adapterHash: HASH,
  secret: 'login',
  provider: 'onepassword-cli',
  itemRef: 'item1',
  origins: ['https://login.shop.test'],
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(ValetError)
  return `${(error as ValetError).stage}/${(error as ValetError).errorClass}`
}

describe('checkGrantRequest', () => {
  it('builds the grant with the stored reference by item id', async () => {
    const checked = await checkGrantRequest(request, check)
    expect(checked).toEqual({
      grant: {
        adapterId: 'shop',
        adapterHash: HASH,
        secret: 'login',
        provider: 'onepassword-cli',
        itemRef: 'op://Valet/item1',
        origins: ['https://login.shop.test'],
        grantedAt: NOW.toISOString(),
      },
      title: 'Shop',
    })
  })

  it('refuses another hash: a grant never carries to another bundle', async () => {
    expect(await refusal(checkGrantRequest({ ...request, adapterHash: 'c'.repeat(64) }, check))).toBe(
      'grant/invalid',
    )
  })

  it('refuses another adapter id', async () => {
    expect(await refusal(checkGrantRequest({ ...request, adapterId: 'other' }, check))).toBe('grant/invalid')
  })

  it('refuses a provider this launch does not have, the fake above all', async () => {
    expect(await refusal(checkGrantRequest({ ...request, provider: 'fake' }, check))).toBe(
      'grant/unavailable',
    )
    expect(
      await refusal(checkGrantRequest({ ...request, provider: 'onepassword-service-account' }, check)),
    ).toBe('grant/unavailable')
  })

  it('refuses a secret the manifest never requested', async () => {
    expect(await refusal(checkGrantRequest({ ...request, secret: 'bank' }, check))).toBe('grant/not-granted')
  })

  it('refuses an inherited key as a secret name', async () => {
    expect(await refusal(checkGrantRequest({ ...request, secret: 'constructor' }, check))).toBe(
      'grant/not-granted',
    )
  })

  it('refuses the reserved Messages name for a vault item', async () => {
    expect(await refusal(checkGrantRequest({ ...request, secret: 'messages' }, check))).toBe(
      'grant/not-granted',
    )
  })

  it('refuses an origin the manifest did not ask for', async () => {
    expect(
      await refusal(
        checkGrantRequest({ ...request, origins: ['https://login.shop.test', 'https://evil.test'] }, check),
      ),
    ).toBe('grant/origin-mismatch')
  })

  it('refuses a navigation origin that is not one of the secret origins', async () => {
    expect(await refusal(checkGrantRequest({ ...request, origins: ['https://www.shop.test'] }, check))).toBe(
      'grant/origin-mismatch',
    )
  })

  it('refuses an origin that only differs by a trailing slash, a path or case', async () => {
    for (const origin of [
      'https://login.shop.test/',
      'https://login.shop.test/login',
      'https://LOGIN.shop.test',
    ]) {
      expect(await refusal(checkGrantRequest({ ...request, origins: [origin] }, check))).toBe(
        'grant/origin-mismatch',
      )
    }
  })

  it('refuses no origins and duplicated origins', async () => {
    expect(await refusal(checkGrantRequest({ ...request, origins: [] }, check))).toBe('grant/origin-mismatch')
    expect(
      await refusal(
        checkGrantRequest(
          { ...request, origins: ['https://login.shop.test', 'https://login.shop.test'] },
          check,
        ),
      ),
    ).toBe('grant/origin-mismatch')
  })

  it('refuses an item the provider does not list, or an op:// reference sent as an item', async () => {
    expect(await refusal(checkGrantRequest({ ...request, itemRef: 'item2' }, check))).toBe('grant/not-found')
    expect(await refusal(checkGrantRequest({ ...request, itemRef: 'op://Private/Bank' }, check))).toBe(
      'grant/invalid',
    )
  })

  describe('Messages', () => {
    const messages: GrantRequest = {
      ...request,
      secret: 'messages',
      provider: 'messages',
      itemRef: 'ShopBank',
      origins: ['https://login.shop.test'],
    }

    it('grants the declared sender, on navigation origins', async () => {
      const checked = await checkGrantRequest(messages, check)
      expect(checked.grant.itemRef).toBe('ShopBank')
      expect(checked.title).toBe('ShopBank')
    })

    it('refuses a sender the manifest does not declare, even one that looks alike', async () => {
      for (const sender of ['shopbank', 'ShopBank ', 'Shop', 'fake.shopbank@icloud.com']) {
        expect(await refusal(checkGrantRequest({ ...messages, itemRef: sender }, check))).toBe(
          'grant/not-granted',
        )
      }
    })

    it('refuses a Messages grant under a real secret name', async () => {
      expect(await refusal(checkGrantRequest({ ...messages, secret: 'login' }, check))).toBe('grant/invalid')
    })

    it('refuses origins outside navigation', async () => {
      expect(await refusal(checkGrantRequest({ ...messages, origins: ['https://evil.test'] }, check))).toBe(
        'grant/origin-mismatch',
      )
    })

    it('refuses when Messages is off', async () => {
      expect(
        await refusal(checkGrantRequest(messages, { ...check, available: new Set(['onepassword-cli']) })),
      ).toBe('grant/unavailable')
    })
  })
})

describe('item references', () => {
  it('round-trips vault ids and keeps fake and Messages references as they are', () => {
    expect(itemRefFor('onepassword-service-account', 'abc')).toBe('op://Valet/abc')
    expect(itemRefFor('fake', 'demo-woolworths')).toBe('demo-woolworths')
    // A Keychain copy's item is in any of the person's vaults: <vault id>-<item id>.
    expect(itemRefFor('keychain-copy', 'vault1-item1')).toBe('op://vault1/item1')
    for (const bad of ['vault1', 'vault1-item1-x', 'vault_1-item1', '-item1']) {
      expect(() => itemRefFor('keychain-copy', bad)).toThrow()
    }
    expect(
      itemIdOf({
        adapterId: 'shop',
        adapterHash: HASH,
        secret: 'login',
        provider: 'keychain-copy',
        itemRef: 'op://vault1/item1',
        origins: ['https://login.shop.test'],
        grantedAt: NOW.toISOString(),
      }),
    ).toBe('vault1-item1')
    const grant = {
      adapterId: 'shop',
      adapterHash: HASH,
      secret: 'login',
      provider: 'onepassword-cli' as const,
      itemRef: 'op://Valet/abc',
      origins: ['https://login.shop.test'],
      grantedAt: NOW.toISOString(),
    }
    expect(itemIdOf(grant)).toBe('abc')
    expect(itemIdOf({ ...grant, itemRef: 'op://Other/abc' })).toBe('op://Other/abc')
    expect(itemIdOf({ ...grant, provider: 'messages', secret: 'messages', itemRef: 'ShopBank' })).toBe(
      'ShopBank',
    )
  })

  it('shows a grant by title, never by its reference', () => {
    const grant = {
      adapterId: 'shop',
      adapterHash: HASH,
      secret: 'login',
      provider: 'onepassword-cli' as const,
      itemRef: 'op://Valet/abc',
      origins: ['https://login.shop.test'],
      grantedAt: NOW.toISOString(),
    }
    const info = grantInfo(grant, { 'op://Valet/abc': 'Shop' }, null)
    expect(info.itemTitle).toBe('Shop')
    expect(JSON.stringify(info)).not.toContain('op://')
    expect(grantInfo(grant, {}, null).itemTitle).toBe('(item)')
    expect(grantInfo(grant, JSON.parse('{"__proto__": "x"}'), null).itemTitle).toBe('(item)')
  })
})
