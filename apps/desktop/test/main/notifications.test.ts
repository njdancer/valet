// @vitest-environment node
// What gets a system notification, what it says, and when it is taken down.

import { describe, expect, it } from 'vitest'
import {
  type AppNotification,
  attentionNotification,
  attentionTarget,
  attentionTitle,
  Notifier,
  plainName,
} from '../../src/main/core/notifications'
import type {
  AttentionItem,
  ConfirmationItem,
  MissedItem,
  NeedsUserItem,
  RepairItem,
  ReviewItem,
} from '../../src/shared/api'

const NOW = Date.parse('2026-11-10T00:00:00.000Z')

const confirmation: ConfirmationItem = {
  kind: 'confirmation',
  id: 'cf_1',
  adapterId: 'shop',
  adapterName: 'Shop',
  adapterVersion: '1.0.0',
  adapterHash: 'a'.repeat(64),
  approvedAt: null,
  tool: 'add',
  toolTitle: 'TOOL-TITLE',
  sideEffect: 'write',
  trigger: 'tool-request',
  client: 'CLIENT-NAME',
  clientTransport: 'http',
  callId: 'call_1',
  requestedAt: '2026-11-10T00:00:00.000Z',
  expiresAt: '2026-11-10T00:02:00.000Z',
  requestCeiling: 5,
  unlocks: [],
  requests: [],
  input: [{ kind: 'text', text: 'INPUT-TEXT' }],
  adapterNote: 'ADAPTER-NOTE',
  ref: 'AB12',
}

const signIn: NeedsUserItem = {
  kind: 'needs-user',
  id: 'nu_shop',
  adapterId: 'shop',
  adapterName: 'Shop',
  reason: 'captcha',
  note: 'MANIFEST-NOTE',
  startedBy: 'call',
  tool: 'add',
  client: 'CLIENT-NAME',
  callId: 'call_1',
  at: '2026-11-10T00:00:00.000Z',
  filled: [],
  filledOrigin: null,
  navigation: [],
  windowOpen: true,
  closesAt: '2026-11-10T00:15:00.000Z',
}

const review: ReviewItem = {
  kind: 'review',
  id: 'rv_shop',
  adapterId: 'shop',
  adapterName: 'Shop',
  version: '1.1.0',
  addsPermissions: true,
}

const repair: RepairItem = {
  kind: 'repair',
  id: 'rp_shop',
  adapterId: 'shop',
  adapterName: 'Shop',
  callId: '6b3e01',
  errorClass: 'site-changed',
  at: '2026-11-10T00:00:00.000Z',
  repairId: null,
}

const missed: MissedItem = {
  kind: 'missed',
  id: 'ms_cf_1_x',
  of: 'confirmation',
  originalId: 'cf_1',
  title: 'Missed: Confirm: TOOL-TITLE (Shop)',
  adapterId: 'shop',
  adapterName: 'Shop',
  callId: 'call_1',
  at: '2026-11-10T00:00:00.000Z',
  missedAt: '2026-11-10T00:02:00.000Z',
}

function notifier(enabled: () => boolean = () => true) {
  const shown: AppNotification[] = []
  const closed: string[] = []
  const n = new Notifier({
    enabled,
    show: (notification) => shown.push(notification),
    close: (key) => closed.push(key),
    now: () => NOW,
    timeZone: 'UTC',
  })
  return { n, shown, closed }
}

describe('what a notification says', () => {
  it('uses the Needs you title, says until when, and opens only the confirmation panel', () => {
    expect(attentionNotification(confirmation, 'UTC')).toEqual({
      key: 'confirmation:cf_1',
      title: 'Confirm: TOOL-TITLE (Shop)',
      body: 'Shop · answer by 12:02 am',
      target: { kind: 'confirmation', id: 'cf_1' },
    })
  })

  it('carries nothing a client, a page or an adapter’s notes wrote', () => {
    for (const item of [confirmation, signIn]) {
      const text = JSON.stringify(attentionNotification(item))
      for (const untrusted of ['CLIENT-NAME', 'INPUT-TEXT', 'ADAPTER-NOTE', 'MANIFEST-NOTE']) {
        expect(text).not.toContain(untrusted)
      }
    }
  })

  it('tells of a sign-in a call handed over, not of a window the person opened themselves', () => {
    expect(attentionNotification(signIn, 'UTC')).toEqual({
      key: 'needs-user:shop:2026-11-10T00:00:00.000Z',
      title: 'Log in to Shop (verification check)',
      body: 'Shop · login window open until 12:15 am',
      target: { kind: 'needs-user', adapterId: 'shop' },
    })
    expect(attentionNotification({ ...signIn, closesAt: null })?.body).toBe('Shop · login window open')
    expect(attentionNotification({ ...signIn, startedBy: 'person' })).toBeNull()
    expect(attentionNotification(review)).toBeNull()
  })

  it('makes a name one bounded line without control or direction characters', () => {
    expect(plainName('  Wool‮worths\n\tOnline\u0000  ')).toBe('Wool worths Online')
    expect(plainName('x'.repeat(200))).toHaveLength(60)
    const hostile = attentionNotification({ ...confirmation, adapterName: 'Shop\nValet: approved ok' })
    expect(hostile?.body.startsWith('Shop Valet: approved ok · answer by')).toBe(true)
  })

  it('names and targets every kind of item', () => {
    const items: AttentionItem[] = [
      confirmation,
      signIn,
      { ...review, firstInstall: true },
      {
        kind: 'remote-consent',
        id: 'cs_1',
        clientHost: 'claude.ai',
        clientName: 'Claude (claude.ai)',
        source: '203.0.113.24',
        requestedAt: '2026-11-10T00:00:00.000Z',
        expiresAt: '2026-11-10T00:05:00.000Z',
      },
      {
        kind: 'setting-missing',
        id: 'sm_shop_store',
        adapterId: 'shop',
        adapterName: 'Shop',
        setting: 'store',
        settingTitle: 'Store',
      },
      {
        kind: 'login-missing',
        id: 'lm_shop_account',
        adapterId: 'shop',
        adapterName: 'Shop',
        secret: 'account',
      },
      repair,
      missed,
    ]
    expect(items.map(attentionTitle)).toEqual([
      'Confirm: TOOL-TITLE (Shop)',
      'Log in to Shop (verification check)',
      'Review Shop before first use',
      'Approve a connection',
      'Choose your Shop store',
      'Give Valet your Shop login',
      'Shop changed: the adapter needs an update',
      'Missed: Confirm: TOOL-TITLE (Shop)',
    ])
    expect(items.map(attentionTarget)).toEqual([
      { kind: 'confirmation', id: 'cf_1' },
      { kind: 'needs-user', adapterId: 'shop' },
      { kind: 'panel', route: '#/sites/shop/versions/review' },
      { kind: 'panel', route: '#/connections/approve' },
      { kind: 'panel', route: '#/sites/shop/store/store' },
      { kind: 'panel', route: '#/sites/shop/login/account' },
      { kind: 'panel', route: '#/activity/calls/6b3e01' },
      { kind: 'panel', route: '#/needs-you/ms_cf_1_x' },
    ])
    expect(attentionNotification(repair)).toMatchObject({
      key: 'repair:shop:6b3e01',
      body: 'Shop · see what broke',
    })
    expect(attentionNotification(missed, 'UTC')).toEqual({
      key: 'confirmation:cf_1',
      title: 'Missed: Confirm: TOOL-TITLE (Shop)',
      body: 'Shop · nobody answered by 12:02 am',
      target: { kind: 'panel', route: '#/needs-you/ms_cf_1_x' },
    })
    expect(
      attentionNotification({ ...missed, of: 'needs-user', adapterId: null, adapterName: null })?.key,
    ).toBe('needs-user::2026-11-10T00:00:00.000Z')
    expect(attentionNotification({ ...missed, of: 'needs-user', adapterName: null })?.body).toMatch(
      /^Valet · /,
    )
    expect(attentionNotification({ ...missed, of: 'remote-consent' })).toBeNull()
  })
})

describe('Notifier', () => {
  it('notifies each waiting item once, and takes it down when it is over', () => {
    const { n, shown, closed } = notifier()
    n.attention([confirmation])
    n.attention([confirmation, signIn])
    n.attention([confirmation, signIn])
    expect(shown.map((s) => s.key)).toEqual(['confirmation:cf_1', 'needs-user:shop:2026-11-10T00:00:00.000Z'])
    n.attention([signIn])
    expect(closed).toEqual(['confirmation:cf_1'])
    n.attention([])
    expect(closed).toEqual(['confirmation:cf_1', 'needs-user:shop:2026-11-10T00:00:00.000Z'])
    // A later hand-off for the same adapter is a new one.
    n.attention([{ ...signIn, at: '2026-11-10T01:00:00.000Z' }])
    expect(shown).toHaveLength(3)
  })

  it('shows nothing while the setting is off, and not belatedly when it is turned on', () => {
    let enabled = false
    const { n, shown, closed } = notifier(() => enabled)
    n.attention([confirmation])
    n.breakerOpened('www.shop.test', 'blocked-by-site', '2026-11-10T01:00:00.000Z')
    n.updateDownloaded('0.2.0', true)
    enabled = true
    n.attention([confirmation])
    expect(shown).toEqual([])
    n.attention([])
    n.breakerClosed('www.shop.test')
    expect(closed).toEqual([])
  })

  it('says a site is limiting requests and until when, and takes that down when it reopens', () => {
    const { n, shown, closed } = notifier()
    n.breakerOpened('www.shop.test', 'blocked-by-site', '2026-11-10T00:59:30.000Z', 'Shop')
    n.breakerOpened('www.shop.test', 'rate-limited', 'not a time')
    expect(shown).toEqual([
      {
        key: 'breaker:www.shop.test',
        title: 'Shop is limiting requests · calls resume at 12:59 am',
        body: 'The site refused Valet.',
        target: { kind: 'panel', route: '#/sites' },
      },
      {
        key: 'breaker:www.shop.test',
        title: 'www.shop.test is limiting requests',
        body: 'The site said Valet was asking too often.',
        target: { kind: 'panel', route: '#/sites' },
      },
    ])
    n.breakerClosed('www.shop.test')
    n.breakerClosed('www.shop.test')
    expect(closed).toEqual(['breaker:www.shop.test'])
  })

  it('replaces a confirmation’s notification with “Missed: …” under the same key', () => {
    const { n, shown, closed } = notifier()
    n.attention([confirmation])
    n.attention([missed])
    expect(shown.map((s) => [s.key, s.title])).toEqual([
      ['confirmation:cf_1', 'Confirm: TOOL-TITLE (Shop)'],
      ['confirmation:cf_1', 'Missed: Confirm: TOOL-TITLE (Shop)'],
    ])
    expect(closed).toEqual([])
    n.attention([missed])
    expect(shown).toHaveLength(2)
    n.attention([])
    expect(closed).toEqual(['confirmation:cf_1'])
  })

  it('doesn’t surface a missed item for one that never showed', () => {
    let enabled = false
    const { n, shown } = notifier(() => enabled)
    n.attention([confirmation])
    enabled = true
    n.attention([missed])
    expect(shown).toEqual([])
  })

  it('asks for connections in one notification, with the soonest end', () => {
    const { n, shown, closed } = notifier()
    n.remoteConsent(1, '2026-11-10T00:05:00.000Z')
    n.remoteConsent(2)
    n.remoteConsent(0)
    expect(shown.map((s) => [s.title, s.body, s.target])).toEqual([
      [
        'Approve a connection',
        'Type the code your browser shows · ends 12:05 am. If you didn’t just add a connector, decline it.',
        { kind: 'panel', route: '#/connections/approve' },
      ],
      [
        'Approve 2 connections',
        'Type the code your browser shows. If you didn’t just add a connector, decline it.',
        { kind: 'panel', route: '#/connections/approve' },
      ],
    ])
    expect(closed).toEqual(['remote-consent'])
  })

  it('says a downloaded update is waiting, and how it gets installed', () => {
    const { n, shown } = notifier()
    n.updateDownloaded('0.2.0', true)
    n.updateDownloaded('0.2.0\nrm -rf', false)
    expect(shown.map((s) => [s.title, s.body, s.target])).toEqual([
      [
        'Valet 0.2.0 is downloaded',
        'It installs when Valet quits.',
        { kind: 'panel', route: '#/settings/updates' },
      ],
      [
        'Valet 0.2.0 rm -rf is downloaded',
        'Turn on automatic installs in Settings to apply it.',
        { kind: 'panel', route: '#/settings/updates' },
      ],
    ])
  })

  it('takes everything down when the app stops, and survives a port that throws', () => {
    const { n, closed } = notifier()
    n.attention([confirmation])
    n.breakerOpened('www.shop.test', 'blocked-by-site', '2026-11-10T01:00:00.000Z')
    n.clear()
    expect(closed.sort()).toEqual(['breaker:www.shop.test', 'confirmation:cf_1'])
    const throwing = new Notifier({
      enabled: () => true,
      show: () => {
        throw new Error('no notification centre')
      },
      close: () => {
        throw new Error('no notification centre')
      },
      now: () => NOW,
    })
    throwing.attention([confirmation])
    throwing.attention([])
    throwing.clear()
  })
})
