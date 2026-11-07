// @vitest-environment node
// The permission diff: each permission-expanding change, one test each (security-model.md, "Approval
// and audit"), and that nothing in it comes from a step's note.

import { createManifest } from '@valet/adapter-woolworths'
import { type AuthStep, type ManifestInput, parseManifest } from '@valet/core'
import { describe, expect, it } from 'vitest'
import {
  addsPermissions,
  authStepEntries,
  conditionText,
  fileChanges,
  lineDiff,
  listDiff,
  manifestText,
  permissionDiff,
} from '../../src/main/core/permission-diff'
import { SHOP } from './fixtures'

const before = parseManifest(SHOP)
function after(change: (m: ManifestInput) => ManifestInput) {
  return parseManifest(change(structuredClone(SHOP)))
}

describe('listDiff', () => {
  it('counts repeated entries as a multiset and a changed entry as a removal plus an addition', () => {
    expect(listDiff(['a', 'a', 'b'], ['a', 'c'])).toEqual({
      added: ['c'],
      removed: ['a', 'b'],
      unchanged: ['a'],
    })
    expect(listDiff([{ x: 1, y: 2 }], [{ y: 2, x: 1 }])).toEqual({
      added: [],
      removed: [],
      unchanged: [{ y: 2, x: 1 }],
    })
  })
})

describe('permissionDiff', () => {
  it('shows a first install as everything added, with no limits or probe comparison', () => {
    const diff = permissionDiff(null, before)
    expect(diff.navigation.added).toEqual(before.navigation)
    expect(diff.tools.added.map((t) => t.name)).toEqual(['echo', 'add'])
    expect(diff.secretFills.added).toEqual([
      { selector: '#user', secret: 'login', field: 'username' },
      { selector: '#pass', secret: 'login', field: 'password' },
    ])
    expect(diff.messagesSources.added).toEqual([{ sender: 'ShopBank' }])
    expect(diff.limits).toBeNull()
    expect(diff.probe).toBeNull()
    expect(addsPermissions(diff)).toBe(true)
  })

  it('an identical manifest adds nothing', () => {
    const diff = permissionDiff(before, before)
    expect(addsPermissions(diff)).toBe(false)
    expect(diff.egress).toEqual({ added: [], removed: [], unchanged: ['www.shop.test'] })
  })

  const expansions: [
    string,
    (m: ManifestInput) => ManifestInput,
    (d: ReturnType<typeof permissionDiff>) => unknown,
  ][] = [
    [
      'a navigation origin',
      (m) => ({ ...m, navigation: [...(m.navigation as string[]), 'https://cdn.shop.test'] }),
      (d) => d.navigation.added,
    ],
    ['an egress host', (m) => ({ ...m, egress: ['www.shop.test', 'api.shop.test'] }), (d) => d.egress.added],
    [
      'an auth frame origin',
      (m) => ({ ...m, auth: { ...m.auth, frameOrigins: ['https://captcha.test'] } }),
      (d) => d.frameOrigins.added,
    ],
    [
      'a cookie domain',
      (m) => ({ ...m, session: { ...m.session, cookieDomains: ['www.shop.test', 'shop.test'] } }),
      (d) => d.cookieDomains.added,
    ],
    [
      'a storage key',
      (m) => ({
        ...m,
        session: { ...m.session, storage: [{ origin: 'https://www.shop.test', keys: ['token'] }] },
      }),
      (d) => d.storage.added,
    ],
    [
      'a request declaration',
      (m) => ({
        ...m,
        requests: [...(m.requests ?? []), { method: 'POST', path: '/api/checkout', purpose: 'irreversible' }],
      }),
      (d) => d.requests.added,
    ],
    [
      'a tool whose side effect went up',
      (m) => ({ ...m, tools: m.tools.map((t) => (t.name === 'echo' ? { ...t, sideEffect: 'write' } : t)) }),
      (d) => d.tools.added,
    ],
    [
      'a new secret',
      (m) => ({
        ...m,
        secrets: {
          ...m.secrets,
          bank: { description: 'Bank', fields: ['password'], origins: ['https://login.shop.test'] },
        },
      }),
      (d) => d.secrets.added,
    ],
    [
      'a new field on a secret',
      (m) => ({
        ...m,
        secrets: {
          login: {
            description: 'Shop account',
            fields: ['username', 'password', 'otp'],
            origins: ['https://login.shop.test'],
          },
        },
      }),
      (d) => d.secrets.added,
    ],
    [
      'a new origin for a secret',
      (m) => ({
        ...m,
        secrets: {
          login: {
            description: 'Shop account',
            fields: ['username', 'password'],
            origins: ['https://login.shop.test', 'https://www.shop.test'],
          },
        },
      }),
      (d) => d.secrets.added,
    ],
    [
      'a secret typed into a different selector',
      (m) => ({
        ...m,
        auth: {
          steps: (m.auth.steps as AuthStep[]).map((s) =>
            s.op === 'fill' && s.selector === '#pass' ? { ...s, selector: '#search' } : s,
          ),
        },
      }),
      (d) => d.secretFills.added,
    ],
    [
      'a new Messages sender',
      (m) => ({
        ...m,
        auth: {
          steps: (m.auth.steps as AuthStep[]).map((s) =>
            s.op === 'otp'
              ? { ...s, source: { messages: { sender: 'Other', pattern: '(\\d{6})', maxAgeSeconds: 300 } } }
              : s,
          ),
        },
      }),
      (d) => d.messagesSources.added,
    ],
    [
      'a new login step',
      (m) => ({
        ...m,
        auth: {
          steps: [
            ...m.auth.steps.slice(0, -1),
            { op: 'click', selector: '#trust' },
            { op: 'assertLoggedIn' },
          ],
        },
      }),
      (d) => d.authSteps.added,
    ],
  ]
  for (const [name, change, list] of expansions) {
    it(`flags ${name}`, () => {
      const diff = permissionDiff(before, after(change))
      expect(list(diff)).not.toEqual([])
      expect(addsPermissions(diff)).toBe(true)
    })
  }

  it('flags a removed assertLoggedIn: a stop taken out of the login', () => {
    const diff = permissionDiff(
      before,
      after((m) => ({ ...m, auth: { steps: m.auth.steps.slice(0, -1) } })),
    )
    expect(diff.authSteps.removed.map((s) => s.op)).toEqual(['assertLoggedIn'])
    expect(addsPermissions(diff)).toBe(true)
  })

  it('flags each loosened limit, and not a tightened one', () => {
    const loosen = [
      { requestsPerRun: 6 },
      { minGapMs: 500 },
      { cooldownSeconds: 300 },
      { cooldownSeconds: 300, maxCooldownSeconds: 3600 },
    ]
    for (const limits of loosen) {
      const diff = permissionDiff(
        before,
        after((m) => ({ ...m, limits: { ...m.limits, ...limits } })),
      )
      expect(addsPermissions(diff)).toBe(true)
    }
    const tighter = permissionDiff(
      before,
      after((m) => ({ ...m, limits: { requestsPerRun: 4, minGapMs: 2000 } })),
    )
    expect(addsPermissions(tighter)).toBe(false)
  })

  it('flags any probe change', () => {
    const diff = permissionDiff(
      before,
      after((m) => ({ ...m, session: { ...m.session, probe: { kind: 'cookie', name: 'auth' } } })),
    )
    expect(diff.probe).toEqual({
      before: { kind: 'cookie', name: 'sid' },
      after: { kind: 'cookie', name: 'auth' },
    })
    expect(addsPermissions(diff)).toBe(true)
  })

  it('removing something alone adds nothing', () => {
    const diff = permissionDiff(
      before,
      after((m) => ({ ...m, requests: [{ method: 'GET', path: '/api/items', purpose: 'read' }] })),
    )
    expect(diff.requests.removed).toEqual([{ method: 'POST', path: '/api/cart', purpose: 'write' }])
    expect(addsPermissions(diff)).toBe(false)
  })
})

describe('auth step details', () => {
  it('render from structured fields and never include a step note', () => {
    const woolworths = createManifest()
    const entries = authStepEntries(woolworths.auth.steps)
    const text = JSON.stringify(entries)
    expect(text).not.toContain('CAPTCHA. Solve it')
    expect(text).not.toContain('1Password item')
    expect(entries.some((e) => e.op === 'needsUser' && e.detail.includes('(captcha)'))).toBe(true)
    // Secret fills are in secretFills; nothing else is dropped.
    expect(entries.some((e) => e.op === 'fill')).toBe(false)
    expect(entries.some((e) => e.op === 'otp' && e.detail.includes('Messages sender "Woolworths"'))).toBe(
      true,
    )
  })

  it('marks depth and the otherwise branch, and words every step and condition', () => {
    const entries = authStepEntries([
      {
        op: 'when',
        condition: { any: [{ visible: '#a' }, { not: { urlContains: '/x' } }] },
        steps: [{ op: 'pause', ms: 10 }],
        otherwise: [{ op: 'retry', times: 2, steps: [{ op: 'click', selector: '#b' }] }],
      },
      { op: 'waitFor', condition: { all: [{ textPresent: 'Hi' }, { urlRegex: '^/u/' }] }, timeoutMs: 500 },
      { op: 'fill', selector: '#q', value: { literal: 'abc' } },
      { op: 'otp', selector: '#c', source: { secret: 'login' } },
      { op: 'fail', errorClass: 'auth-failed', note: 'free text' },
    ])
    expect(entries.map((e) => e.detail)).toEqual([
      'when any of (visible("#a"), not url contains "/x")',
      '› pause 10 ms',
      '› otherwise: retry up to 2 times',
      '› › click "#b"',
      'wait up to 500 ms for all of (text "Hi" present, url matches /^/u//)',
      'type 3 characters of fixed text into "#q"',
      'type the one-time code of secret login from 1Password into "#c"',
      'stop the login (auth-failed)',
    ])
    expect(conditionText({ textPresent: 'x' })).toBe('text "x" present')
  })
})

describe('text diffs', () => {
  it('diffs manifest lines and counts file changes', () => {
    const lines = lineDiff(['a', 'b', 'c'], ['a', 'x', 'c', 'd'])
    expect(lines.map((l) => `${l.kind}:${l.text}`)).toEqual([
      'hunk:@@ -1,3 +1,4 @@',
      'same:a',
      'add:x',
      'del:b',
      'same:c',
      'add:d',
    ])
    expect(lines[2]).toEqual({ kind: 'add', oldLine: null, newLine: 2, text: 'x' })
    expect(manifestText(before)[0]).toBe('{')
    expect(
      fileChanges(
        { 'a.ts': 'one\ntwo', 'gone.ts': 'x', 'same.ts': 's' },
        { 'a.ts': 'one\nthree', 'new.ts': 'n\nm', 'same.ts': 's' },
      ),
    ).toEqual([
      { path: 'a.ts', status: 'modified', added: 1, removed: 1 },
      { path: 'gone.ts', status: 'removed', added: 0, removed: 1 },
      { path: 'new.ts', status: 'added', added: 2, removed: 0 },
    ])
    expect(fileChanges(null, { 'e.ts': '' })).toEqual([
      { path: 'e.ts', status: 'added', added: 0, removed: 0 },
    ])
  })
})
