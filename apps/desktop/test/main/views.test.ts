// @vitest-environment node
// View models copy named fields only: whatever a store holds (an op:// reference, a session value,
// a token) never reaches what the renderer receives.

import { type AuditRecord, type Grant, parseManifest } from '@valet/core'
import { describe, expect, it } from 'vitest'
import { builtinAdapter } from '../../src/main/core/registry'
import {
  type AdapterState,
  adapterDetail,
  adapterSummary,
  approvalState,
  pendingReview,
  reviewItem,
  siteHealth,
  siteOf,
} from '../../src/main/core/views'
import { SHOP, SHOP_FILES, shopDefinition } from './fixtures'

const adapter = builtinAdapter(shopDefinition(), SHOP_FILES)
const CANARIES = ['op://Valet/item1', 'cookie-value-canary-123', 'token-canary-456']

const loginGrant: Grant = {
  adapterId: 'shop',
  adapterHash: adapter.hash,
  secret: 'login',
  provider: 'onepassword-cli',
  itemRef: 'op://Valet/item1',
  origins: ['https://login.shop.test'],
  grantedAt: '2026-11-07T00:00:00.000Z',
}

const state: AdapterState = {
  adapter,
  approved: true,
  approvedAt: '2026-11-07T00:00:00.000Z',
  rejected: false,
  previous: null,
  grants: [loginGrant, { ...loginGrant, secret: 'messages', provider: 'messages', itemRef: 'ShopBank' }],
  titles: { 'op://Valet/item1': 'Shop' },
  session: { state: 'logged-in', checkedAt: null, needsUser: null, since: null },
  calls: new Map([
    ['shop', 3],
    ['shop/echo', 2],
  ]),
  lastUsed: () => null,
  handedOver: null,
}

/** Every key, at any depth, of a JSON value. */
function keys(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) keys(v, into)
  else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      into.add(k)
      keys(v, into)
    }
  }
  return into
}

describe('adapter views', () => {
  it('summarise the adapter, its grants and calls', () => {
    const summary = adapterSummary(state)
    expect(summary).toMatchObject({
      id: 'shop',
      site: 'shop.test',
      approval: 'approved',
      pendingUpdate: null,
      toolCounts: { read: 1, write: 1, irreversible: 0 },
      secrets: [{ name: 'login', granted: true }],
      messagesSources: [{ sender: 'ShopBank', granted: true }],
      calls7d: 3,
    })
  })

  it('never carry an item reference, a cookie value, a token or a secret-shaped key', () => {
    // A store that grew extra fields, as a later version of it might.
    const leaky: AdapterState = {
      ...state,
      grants: state.grants.map((g) => ({ ...g, value: CANARIES[1], token: CANARIES[2] }) as Grant),
    }
    for (const view of [adapterSummary(leaky), adapterDetail(leaky)]) {
      const text = JSON.stringify(view)
      for (const canary of CANARIES) expect(text).not.toContain(canary)
      for (const key of ['itemRef', 'value', 'token', 'password', 'cookie', 'cookies'])
        expect(keys(view).has(key)).toBe(false)
    }
  })

  it('shows a Messages source as granted only for the exact sender the grant names', () => {
    const other: AdapterState = {
      ...state,
      grants: [{ ...loginGrant, secret: 'messages', provider: 'messages', itemRef: 'shopbank' }],
    }
    expect(adapterDetail(other).messages[0]?.grant).toBeNull()
    expect(adapterDetail(state).messages[0]?.grant?.itemId).toBe('ShopBank')
  })

  it('ignores grants for another hash: they are not inherited', () => {
    const stale: AdapterState = { ...state, grants: [{ ...loginGrant, adapterHash: 'f'.repeat(64) }] }
    expect(adapterSummary(stale).secrets).toEqual([{ name: 'login', granted: false }])
    expect(adapterDetail(stale).secretRequests[0]?.grant).toBeNull()
  })

  it('details the manifest and the tools with their call counts', () => {
    const detail = adapterDetail(state)
    expect(detail.partitions).toEqual({ auth: 'persist:auth:shop', tool: 'persist:tool:shop' })
    expect(detail.probe).toEqual({ kind: 'cookie', name: 'sid' })
    expect(detail.tools.map((t) => [t.name, t.calls7d])).toEqual([
      ['echo', 2],
      ['add', 0],
    ])
    expect(detail.approvedAt).toBe('2026-11-07T00:00:00.000Z')
    expect(adapterDetail({ ...state, approved: false }).approvedAt).toBeNull()
  })

  it('words approval states', () => {
    expect(approvalState({ ...state, approved: false })).toBe('unapproved')
    expect(approvalState({ ...state, approved: false, rejected: true })).toBe('rejected')
    expect(siteOf(parseManifest({ ...SHOP, home: 'https://shop.test/' }))).toBe('shop.test')
  })
})

describe('reviews', () => {
  it('has none for an approved or rejected bundle', () => {
    expect(pendingReview(state, 'now')).toBeNull()
    expect(pendingReview({ ...state, approved: false, rejected: true }, 'now')).toBeNull()
  })

  it('reviews a first install as all added', () => {
    const review = pendingReview({ ...state, approved: false }, '2026-11-07T00:00:00.000Z')
    expect(review?.from).toBeNull()
    expect(review?.to).toEqual({ version: '1.0.0', hash: adapter.hash })
    expect(review?.files.map((f) => f.status)).toEqual(['added', 'added'])
    expect(reviewItem(review as NonNullable<typeof review>)).toEqual({
      kind: 'review',
      id: 'rv_shop',
      adapterId: 'shop',
      adapterName: 'Shop',
      version: '1.0.0',
      addsPermissions: true,
    })
  })

  it('reviews an update against the last approved bundle, and shows it as pending', () => {
    const next = builtinAdapter(
      shopDefinition({ ...SHOP, version: '1.1.0', egress: ['www.shop.test', 'api.shop.test'] }),
      {
        ...SHOP_FILES,
        'src/index.ts': 'export default { v: 2 }\n',
      },
    )
    const updated: AdapterState = {
      ...state,
      adapter: next,
      approved: false,
      previous: {
        hash: adapter.hash,
        version: '1.0.0',
        approvedAt: '2026-11-06T00:00:00.000Z',
        manifest: adapter.definition.manifest,
        files: adapter.files,
      },
    }
    const review = pendingReview(updated, 'now')
    expect(review?.from).toEqual({ version: '1.0.0', hash: adapter.hash })
    expect(review?.diff.egress.added).toEqual(['api.shop.test'])
    expect(review?.files).toEqual([{ path: 'src/index.ts', status: 'modified', added: 1, removed: 1 }])
    expect(review?.manifestDiff.some((l) => l.kind === 'add' && l.text.includes('api.shop.test'))).toBe(true)
    expect(adapterSummary(updated).pendingUpdate).toEqual({ version: '1.1.0', hash: next.hash })
  })
})

describe('site health', () => {
  const now = Date.parse('2026-11-07T10:00:00.000Z')
  const opened: AuditRecord = {
    seq: 1,
    at: '2026-11-07T09:55:00.000Z',
    event: {
      type: 'breaker-opened',
      host: 'www.shop.test',
      cause: 'rate-limited',
      retryAt: '2026-11-07T10:05:00.000Z',
      callId: null,
    },
    prev: '0'.repeat(64),
    hash: '1'.repeat(64),
  }
  const closed = {
    host: 'www.shop.test',
    adapterIds: ['shop'],
    breaker: 'closed' as const,
    retryAt: null,
    retryAfterMs: 0,
    cooldownMs: 0,
    nextCooldownMs: 600_000,
    budget: { minGapMs: 1000, waitMs: 0 },
  }

  it('shows the runtime’s breaker, with the cause and time of its last opening from the log', () => {
    const open = {
      ...closed,
      breaker: 'open' as const,
      retryAt: now + 300_000,
      retryAfterMs: 300_000,
      cooldownMs: 600_000,
      nextCooldownMs: 1_200_000,
    }
    expect(siteHealth([open], [opened])).toEqual([
      {
        host: 'www.shop.test',
        adapterIds: ['shop'],
        breaker: 'open',
        retryAt: '2026-11-07T10:05:00.000Z',
        cause: 'rate-limited',
        lastOpenedAt: '2026-11-07T09:55:00.000Z',
        nextCooldownSeconds: 1200,
      },
    ])
    // Open with nothing in the log (a block the audit couldn't record): the site's own block.
    expect(siteHealth([open], [])[0]?.cause).toBe('blocked-by-site')
  })

  it('is closed with no cause while the runtime says closed, whatever the log says', () => {
    expect(siteHealth([closed], [opened])).toEqual([
      {
        host: 'www.shop.test',
        adapterIds: ['shop'],
        breaker: 'closed',
        retryAt: null,
        cause: null,
        lastOpenedAt: '2026-11-07T09:55:00.000Z',
        nextCooldownSeconds: 600,
      },
    ])
    expect(siteHealth([], [opened])).toEqual([])
  })
})
