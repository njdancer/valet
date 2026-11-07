import { describe, expect, it } from 'vitest'
import {
  additionBadges,
  addsPermissions,
  limitsChanged,
  probeText,
  sameProbe,
  secretChanges,
  toolChanges,
} from '../src/renderer/lib/permissions'
import type { PermissionDiff, ProbeInfo } from '../src/shared/api'

const LIMITS = { requestsPerRun: 6, minGapMs: 10_000, cooldownSeconds: 1800, maxCooldownSeconds: 21_600 }

const PROBE: ProbeInfo = {
  kind: 'fetch',
  path: '/api/ui/v2/bootstrap',
  expectStatus: 200,
  loggedOutStatuses: [401],
  jsonPath: 'IsLoggedIn',
  equals: true,
}

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
  tools: {
    added: [],
    removed: [],
    unchanged: [
      { name: 'get_cart', title: 'Get cart', sideEffect: 'read', destructive: false, idempotent: true },
    ],
  },
  secrets: { added: [], removed: [], unchanged: [] },
  secretFills: { added: [], removed: [], unchanged: [] },
  authSteps: {
    added: [],
    removed: [],
    unchanged: [
      { op: 'goto', detail: 'goto https://auth.woolworths.com.au/u/login' },
      { op: 'click', detail: 'click button[type=submit]' },
      { op: 'assertLoggedIn', detail: 'assertLoggedIn' },
    ],
  },
  messagesSources: { added: [], removed: [], unchanged: [] },
  limits: { before: LIMITS, after: LIMITS },
  probe: { before: PROBE, after: PROBE },
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
        removed: [
          { name: 'add_to_cart', title: 'Add', sideEffect: 'write', destructive: true, idempotent: false },
        ],
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
      {
        tools: {
          added: [{ name: 'x', title: 'X', sideEffect: 'read', destructive: false, idempotent: true }],
          removed: [],
          unchanged: [],
        },
      },
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
      {
        authSteps: {
          added: [{ op: 'click', detail: 'click button#accept-terms' }],
          removed: [],
          unchanged: NOTHING_NEW.authSteps.unchanged,
        },
      },
      { probe: { before: PROBE, after: { ...PROBE, equals: null } } },
    ]
    for (const addition of additions) {
      expect(addsPermissions({ ...NOTHING_NEW, ...addition })).toBe(true)
    }
  })

  it('treats a tool whose side effect escalates as an addition, because it is listed as removed plus added', () => {
    const diff: PermissionDiff = {
      ...NOTHING_NEW,
      tools: {
        added: [
          {
            name: 'get_cart',
            title: 'Get cart',
            sideEffect: 'irreversible',
            destructive: true,
            idempotent: false,
          },
        ],
        removed: [
          { name: 'get_cart', title: 'Get cart', sideEffect: 'read', destructive: false, idempotent: true },
        ],
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

  it('has no limits or probe to compare on a first install', () => {
    expect(addsPermissions({ ...NOTHING_NEW, limits: null, probe: null })).toBe(false)
    expect(limitsChanged({ ...NOTHING_NEW, limits: null })).toBe(false)
  })

  it('needs the tick for a login step that only appears in the login flow, such as a terms click', () => {
    const diff: PermissionDiff = {
      ...NOTHING_NEW,
      authSteps: {
        added: [{ op: 'click', detail: 'click button#accept-terms' }],
        removed: [],
        unchanged: NOTHING_NEW.authSteps.unchanged,
      },
    }
    expect(addsPermissions(diff)).toBe(true)
    expect(additionBadges(diff)).toEqual([{ label: '+1 login step', tone: 'write' }])
  })

  it('needs the tick when the update removes a login safeguard, but not another step', () => {
    const withoutCheck: PermissionDiff = {
      ...NOTHING_NEW,
      authSteps: {
        added: [],
        removed: [{ op: 'assertLoggedIn', detail: 'assertLoggedIn' }],
        unchanged: NOTHING_NEW.authSteps.unchanged.slice(0, 2),
      },
    }
    expect(addsPermissions(withoutCheck)).toBe(true)
    expect(additionBadges(withoutCheck)).toEqual([{ label: '−1 login safeguard', tone: 'write' }])
    for (const op of ['needsUser', 'fail'] as const) {
      const diff = {
        ...withoutCheck,
        authSteps: { ...withoutCheck.authSteps, removed: [{ op, detail: op }] },
      }
      expect(addsPermissions(diff)).toBe(true)
    }
    const withoutClick: PermissionDiff = {
      ...NOTHING_NEW,
      authSteps: {
        added: [],
        removed: [{ op: 'click', detail: 'click button[type=submit]' }],
        unchanged: [],
      },
    }
    expect(addsPermissions(withoutClick)).toBe(false)
  })

  it('needs the tick for any change to the login check, in any of its fields', () => {
    const changed: ProbeInfo[] = [
      { ...PROBE, path: '/api/ui/v2/other' },
      { ...PROBE, expectStatus: 204 },
      { ...PROBE, loggedOutStatuses: [401, 403] },
      { ...PROBE, loggedOutStatuses: [403] },
      { ...PROBE, jsonPath: null },
      { ...PROBE, equals: 'true' },
      { kind: 'cookie', name: 'session' },
    ]
    for (const after of changed) {
      const diff = { ...NOTHING_NEW, probe: { before: PROBE, after } }
      expect(addsPermissions(diff)).toBe(true)
      expect(additionBadges(diff)).toEqual([{ label: 'new login check', tone: 'write' }])
    }
    const cookie: ProbeInfo = { kind: 'cookie', name: 'session' }
    expect(sameProbe(cookie, { kind: 'cookie', name: 'session' })).toBe(true)
    expect(sameProbe(cookie, { kind: 'cookie', name: 'other' })).toBe(false)
    expect(sameProbe(cookie, PROBE)).toBe(false)
  })
})

describe('probeText', () => {
  it('words each kind of check from its fields', () => {
    expect(probeText(PROBE)).toBe('GET /api/ui/v2/bootstrap → 200 · IsLoggedIn = true · logged out on 401')
    expect(probeText({ ...PROBE, equals: null })).toBe(
      'GET /api/ui/v2/bootstrap → 200 · IsLoggedIn truthy · logged out on 401',
    )
    expect(probeText({ ...PROBE, jsonPath: null, loggedOutStatuses: [401, 403] })).toBe(
      'GET /api/ui/v2/bootstrap → 200 · logged out on 401, 403',
    )
    expect(probeText({ kind: 'cookie', name: 'session' })).toBe('cookie session present')
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
          { name: 'w', title: 'W', sideEffect: 'write', destructive: true, idempotent: false },
          { name: 'r', title: 'R', sideEffect: 'read', destructive: false, idempotent: true },
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

describe('changed secrets and tools', () => {
  it('reads a secret on both sides as what it gained, and badges that rather than a new secret', () => {
    const login = {
      name: 'login',
      description: 'Woolworths',
      fields: ['username', 'password'] as const,
      origins: ['https://auth.woolworths.com.au'],
    }
    const diff: PermissionDiff = {
      ...NOTHING_NEW,
      secrets: {
        added: [
          {
            ...login,
            fields: ['username', 'password', 'otp'],
            origins: [...login.origins, 'https://www.woolworths.com.au'],
          },
        ],
        removed: [{ ...login, fields: [...login.fields] }],
        unchanged: [],
      },
    }
    expect(secretChanges(diff)).toEqual([
      expect.objectContaining({ newFields: ['otp'], newOrigins: ['https://www.woolworths.com.au'] }),
    ])
    expect(additionBadges(diff).map((b) => b.label)).toEqual(['+1 secret field', '+1 secret origin'])
    expect(addsPermissions(diff)).toBe(true)
  })

  it('marks a tool raised only when its side effect goes up', () => {
    const tool = (sideEffect: 'read' | 'write' | 'irreversible') => ({
      name: 't',
      title: 'T',
      sideEffect,
      destructive: sideEffect !== 'read',
      idempotent: sideEffect === 'read',
    })
    const change = (from: 'read' | 'write' | 'irreversible', to: 'read' | 'write' | 'irreversible') =>
      toolChanges({ ...NOTHING_NEW, tools: { added: [tool(to)], removed: [tool(from)], unchanged: [] } })[0]
    expect(change('read', 'write')).toMatchObject({ was: 'read', raised: true })
    expect(change('read', 'irreversible')).toMatchObject({ raised: true })
    expect(change('write', 'irreversible')).toMatchObject({ raised: true })
    expect(change('write', 'read')).toMatchObject({ was: 'write', raised: false })
    expect(
      toolChanges({ ...NOTHING_NEW, tools: { added: [tool('read')], removed: [], unchanged: [] } }),
    ).toEqual([
      { tool: tool('read'), was: null, raised: false, becameDestructive: false, hintsRelaxed: false },
    ])
  })

  it('marks a write that becomes destructive, and one whose hints relax (C9)', () => {
    const write = (destructive: boolean, idempotent: boolean) => ({
      name: 'w',
      title: 'W',
      sideEffect: 'write' as const,
      destructive,
      idempotent,
    })
    const change = (from: ReturnType<typeof write>, to: ReturnType<typeof write>) =>
      toolChanges({ ...NOTHING_NEW, tools: { added: [to], removed: [from], unchanged: [] } })[0]
    expect(change(write(false, false), write(true, false))).toMatchObject({
      becameDestructive: true,
      hintsRelaxed: false,
    })
    expect(change(write(true, false), write(false, false))).toMatchObject({
      becameDestructive: false,
      hintsRelaxed: true,
    })
    expect(change(write(true, false), write(true, true))).toMatchObject({ hintsRelaxed: true })
    expect(change(write(true, true), write(true, false))).toMatchObject({
      becameDestructive: false,
      hintsRelaxed: false,
    })
  })
})
