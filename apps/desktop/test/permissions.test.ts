import { describe, expect, it } from 'vitest'
import { additionBadges, addsPermissions, limitsChanged } from '../src/renderer/lib/permissions'
import type { PermissionDiff } from '../src/shared/api'

const LIMITS = { requestsPerRun: 6, minGapMs: 10_000, cooldownSeconds: 1800, maxCooldownSeconds: 21_600 }

/** An update that changes nothing: every list unchanged, limits equal. Each test changes one thing. */
const NOTHING_NEW: PermissionDiff = {
  navigation: { added: [], removed: [], unchanged: ['https://www.woolworths.com.au'] },
  frameOrigins: { added: [], removed: [], unchanged: [] },
  egress: { added: [], removed: [], unchanged: ['www.woolworths.com.au'] },
  cookieDomains: { added: [], removed: [], unchanged: ['woolworths.com.au'] },
  storage: { added: [], removed: [], unchanged: [] },
  requests: {
    added: [],
    removed: [],
    unchanged: [{ method: 'GET', path: '/apis/ui/Trolley', purpose: 'read' }],
  },
  tools: { added: [], removed: [], unchanged: [{ name: 'get_cart', title: 'Get cart', sideEffect: 'read' }] },
  secrets: { added: [], removed: [], unchanged: [] },
  secretFills: { added: [], removed: [], unchanged: [] },
  messagesSources: { added: [], removed: [], unchanged: [] },
  limits: { before: LIMITS, after: LIMITS },
}

describe('addsPermissions', () => {
  it('is false when nothing changes', () => {
    expect(addsPermissions(NOTHING_NEW)).toBe(false)
    expect(additionBadges(NOTHING_NEW)).toEqual([])
    expect(limitsChanged(NOTHING_NEW)).toBe(false)
  })

  it('is false when the update only removes things', () => {
    const diff: PermissionDiff = {
      ...NOTHING_NEW,
      egress: { added: [], removed: ['cdn0.woolworths.media'], unchanged: ['www.woolworths.com.au'] },
      tools: {
        added: [],
        removed: [{ name: 'add_to_cart', title: 'Add', sideEffect: 'write' }],
        unchanged: [],
      },
    }
    expect(addsPermissions(diff)).toBe(false)
  })

  it('is true for an addition to any one list', () => {
    const additions: Partial<PermissionDiff>[] = [
      { navigation: { added: ['https://evil.example'], removed: [], unchanged: [] } },
      { frameOrigins: { added: ['https://captcha.example'], removed: [], unchanged: [] } },
      { egress: { added: ['api.woolworthsrewards.com.au'], removed: [], unchanged: [] } },
      { cookieDomains: { added: ['woolworthsrewards.com.au'], removed: [], unchanged: [] } },
      {
        storage: {
          added: [{ origin: 'https://www.woolworths.com.au', key: 'token' }],
          removed: [],
          unchanged: [],
        },
      },
      { requests: { added: [{ method: 'POST', path: '/x', purpose: 'write' }], removed: [], unchanged: [] } },
      { tools: { added: [{ name: 'x', title: 'X', sideEffect: 'read' }], removed: [], unchanged: [] } },
      {
        secrets: {
          added: [
            { name: 'rewards', description: 'Rewards', fields: ['password'], origins: ['https://a.example'] },
          ],
          removed: [],
          unchanged: [],
        },
      },
      {
        secretFills: {
          added: [{ selector: '#search', secret: 'login', field: 'password' }],
          removed: [],
          unchanged: [],
        },
      },
      { messagesSources: { added: [{ sender: 'Woolworths' }], removed: [], unchanged: [] } },
    ]
    for (const addition of additions) {
      expect(addsPermissions({ ...NOTHING_NEW, ...addition })).toBe(true)
    }
  })

  it('treats a tool whose side effect escalates as an addition, because it is listed as removed plus added', () => {
    const diff: PermissionDiff = {
      ...NOTHING_NEW,
      tools: {
        added: [{ name: 'get_cart', title: 'Get cart', sideEffect: 'irreversible' }],
        removed: [{ name: 'get_cart', title: 'Get cart', sideEffect: 'read' }],
        unchanged: [],
      },
    }
    expect(addsPermissions(diff)).toBe(true)
    expect(additionBadges(diff)).toEqual([{ label: '+1 irreversible tool', tone: 'irreversible' }])
  })

  it('treats looser limits as an addition and tighter ones as not', () => {
    const looser = [
      { ...LIMITS, requestsPerRun: 60 },
      { ...LIMITS, minGapMs: 250 },
      { ...LIMITS, cooldownSeconds: 60 },
      { ...LIMITS, maxCooldownSeconds: 600 },
    ]
    for (const after of looser) {
      const diff = { ...NOTHING_NEW, limits: { before: LIMITS, after } }
      expect(addsPermissions(diff)).toBe(true)
      expect(limitsChanged(diff)).toBe(true)
      expect(additionBadges(diff)).toContainEqual({ label: 'looser limits', tone: 'write' })
    }
    const tighter = {
      ...NOTHING_NEW,
      limits: { before: LIMITS, after: { ...LIMITS, requestsPerRun: 3, minGapMs: 20_000 } },
    }
    expect(addsPermissions(tighter)).toBe(false)
    expect(limitsChanged(tighter)).toBe(true)
  })

  it('has no limits to compare on a first install', () => {
    expect(addsPermissions({ ...NOTHING_NEW, limits: null })).toBe(false)
    expect(limitsChanged({ ...NOTHING_NEW, limits: null })).toBe(false)
  })
})

describe('additionBadges', () => {
  it('counts each kind, riskiest first', () => {
    const diff: PermissionDiff = {
      ...NOTHING_NEW,
      egress: { added: ['a.example', 'b.example'], removed: [], unchanged: [] },
      requests: {
        added: [
          { method: 'POST', path: '/pay', purpose: 'irreversible' },
          { method: 'POST', path: '/w', purpose: 'write' },
          { method: 'GET', path: '/r', purpose: 'read' },
        ],
        removed: [],
        unchanged: [],
      },
      tools: {
        added: [
          { name: 'w', title: 'W', sideEffect: 'write' },
          { name: 'r', title: 'R', sideEffect: 'read' },
        ],
        removed: [],
        unchanged: [],
      },
    }
    expect(additionBadges(diff).map((b) => b.label)).toEqual([
      '+2 hosts',
      '+1 write tool',
      '+1 read tool',
      '+1 irreversible path',
      '+1 write path',
      '+1 read path',
    ])
  })
})
