// @vitest-environment node
// Subjects for grants, tools and settings come from the Mac's own state, one builder per kind, so
// the person's paths and the agents' admin tools ask for exactly the same thing.

import { parseManifest } from '@valet/core'
import { describe, expect, it } from 'vitest'
import {
  adapterSettingSubject,
  grantSubject,
  itemFingerprint,
  settingSubject,
  settingWidens,
  toolEnableSubject,
} from '../../src/main/core/approvals'
import { SHOP, SHOP_WITH_STORE } from './fixtures'

const manifest = parseManifest(SHOP)
const hash = 'a'.repeat(64)

describe('subject builders', () => {
  it('signs a grant’s fields, item and origins, never its reference', () => {
    const subject = grantSubject(
      manifest,
      {
        adapterId: 'shop',
        adapterHash: hash,
        secret: 'login',
        provider: 'fake',
        itemRef: 'op://vault/item',
        origins: ['https://login.shop.test'],
        grantedAt: '2026-11-12T00:00:00.000Z',
      },
      'Shop​ login',
    )
    expect(subject).toMatchObject({
      fields: ['username', 'password'],
      provider: 'keychain-copy',
      itemTitle: 'Untitled item',
      itemFingerprint: itemFingerprint('op://vault/item'),
      origins: ['https://login.shop.test'],
    })
    expect(JSON.stringify(subject)).not.toContain('op://')
  })

  it('names a tool’s side effect from the manifest, and nothing for a tool it lacks', () => {
    const tool = manifest.tools[0]
    expect(toolEnableSubject(manifest, hash, tool?.name ?? '', 'remote')).toMatchObject({
      scope: 'remote',
      clientId: null,
      sideEffect: tool?.sideEffect,
    })
    expect(toolEnableSubject(manifest, hash, 'nope', 'local')).toBeNull()
  })

  it('classifies which way a setting widens', () => {
    expect(settingWidens('messages_otp', false, true)).toBe(true)
    expect(settingWidens('messages_otp', true, false)).toBe(false)
    expect(settingWidens('messages_otp', true, true)).toBe(false)
    expect(settingWidens('notifications', true, false)).toBe(true)
    expect(settingWidens('trace_retention', 14, 3)).toBe(true)
    expect(settingWidens('trace_retention', 14, 30)).toBe(false)
    expect(settingWidens('remote_hosts', ['a.example'], ['a.example', 'b.example'])).toBe(true)
    expect(settingWidens('remote_hosts', ['a.example', 'b.example'], ['a.example'])).toBe(false)
    expect(settingSubject('remote_enabled', false, true)).toMatchObject({
      from: 'Off',
      to: 'On',
      scope: 'valet',
    })
  })

  it('lets the person pick an adapter setting on the card, from the adapter’s own list', () => {
    const withStore = parseManifest(SHOP_WITH_STORE)
    const subject = adapterSettingSubject(withStore, 'store', null, [
      { id: '1', label: 'Bondi' },
      { id: '2', label: 'Newtown' },
    ])
    expect(subject).toMatchObject({ scope: 'adapter', adapterId: 'shop', from: 'Not set' })
    expect(subject?.choices).toHaveLength(2)
    expect(adapterSettingSubject(withStore, 'store', null, [{ id: '1', label: 'Bondi' }])).toBeNull()
    expect(adapterSettingSubject(withStore, 'nope', null, [])).toBeNull()
  })
})
