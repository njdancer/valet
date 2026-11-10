// @vitest-environment node
// What gets a system notification, what it says, and when it is taken down.

import { describe, expect, it } from 'vitest'
import {
  type AppNotification,
  attentionNotification,
  Notifier,
  plainName,
} from '../../src/main/core/notifications'
import type { ConfirmationItem, NeedsUserItem, ReviewItem } from '../../src/shared/api'

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

function notifier(enabled: () => boolean = () => true) {
  const shown: AppNotification[] = []
  const closed: string[] = []
  const n = new Notifier({
    enabled,
    show: (notification) => shown.push(notification),
    close: (key) => closed.push(key),
    now: () => NOW,
  })
  return { n, shown, closed }
}

describe('what a notification says', () => {
  it('names the adapter and says how long there is, and opens only the confirmation panel', () => {
    expect(attentionNotification(confirmation)).toEqual({
      key: 'confirmation:cf_1',
      title: 'Valet needs your approval',
      body: 'Shop: an agent asked for something that needs your yes. Unanswered, it is declined in 2 minutes.',
      target: { kind: 'confirmation', id: 'cf_1' },
    })
  })

  it('carries nothing an adapter, a client or a page wrote', () => {
    for (const item of [confirmation, signIn]) {
      const text = JSON.stringify(attentionNotification(item))
      for (const untrusted of ['TOOL-TITLE', 'CLIENT-NAME', 'INPUT-TEXT', 'ADAPTER-NOTE', 'MANIFEST-NOTE']) {
        expect(text).not.toContain(untrusted)
      }
    }
  })

  it('tells of a sign-in a call handed over, not of a window the person opened themselves', () => {
    expect(attentionNotification(signIn)).toEqual({
      key: 'needs-user:shop:2026-11-10T00:00:00.000Z',
      title: 'Valet needs you to sign in',
      body: 'Shop: signing in stopped and is waiting for you. The window closes in 15 minutes.',
      target: { kind: 'needs-user', adapterId: 'shop' },
    })
    expect(attentionNotification({ ...signIn, startedBy: 'person' })).toBeNull()
    expect(attentionNotification(review)).toBeNull()
  })

  it('makes a name one bounded line without control or direction characters', () => {
    expect(plainName('  Wool‮worths\n\tOnline\u0000  ')).toBe('Wool worths Online')
    expect(plainName('x'.repeat(200))).toHaveLength(60)
    const hostile = attentionNotification({ ...confirmation, adapterName: 'Shop\nValet: approved ok' })
    expect(hostile?.body.startsWith('Shop Valet: approved ok: an agent asked')).toBe(true)
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

  it('says a site was stopped and for how long, and takes that down when it reopens', () => {
    const { n, shown, closed } = notifier()
    n.breakerOpened('www.shop.test', 'blocked-by-site', '2026-11-10T00:59:30.000Z')
    n.breakerOpened('www.shop.test', 'rate-limited', 'not a time')
    expect(shown).toEqual([
      {
        key: 'breaker:www.shop.test',
        title: 'Valet stopped calling www.shop.test',
        body: 'The site refused Valet. Calls to it wait 60 minutes.',
        target: { kind: 'panel', route: '#/adapters' },
      },
      {
        key: 'breaker:www.shop.test',
        title: 'Valet stopped calling www.shop.test',
        body: 'The site said Valet was asking too often. Calls to it wait.',
        target: { kind: 'panel', route: '#/adapters' },
      },
    ])
    n.breakerClosed('www.shop.test')
    n.breakerClosed('www.shop.test')
    expect(closed).toEqual(['breaker:www.shop.test'])
  })

  it('says a downloaded update is waiting, and how it gets installed', () => {
    const { n, shown } = notifier()
    n.updateDownloaded('0.2.0', true)
    n.updateDownloaded('0.2.0\nrm -rf', false)
    expect(shown.map((s) => [s.title, s.body, s.target])).toEqual([
      ['Valet 0.2.0 is downloaded', 'It installs when Valet quits.', { kind: 'panel', route: '#/settings' }],
      [
        'Valet 0.2.0 rm -rf is downloaded',
        'Turn on automatic installs in Settings to apply it.',
        { kind: 'panel', route: '#/settings' },
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
