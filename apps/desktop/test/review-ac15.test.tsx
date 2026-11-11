// AC15 on the review screen: for each kind of permission-expanding change, change one thing in a
// manifest, diff it the way the main process does, and check the screen highlights it and asks for
// the tick. The list and its order are AC15's (docs/plan.md) and security-model.md's.

import { render, screen, within } from '@testing-library/react'
import { type AuthStep, type ManifestInput, parseManifest } from '@valet/core'
import { describe, expect, it } from 'vitest'
import { permissionDiff } from '../src/main/core/permission-diff'
import { ControlPanel } from '../src/renderer/control/App'
import { createFakeApi } from '../src/renderer/dev/fake-api'
import { ApiProvider } from '../src/renderer/lib/api-context'
import type { PendingReview } from '../src/shared/api'
import { SHOP } from './main/fixtures'

const NOW = Date.parse('2026-11-07T21:48:00+11:00')
const before = parseManifest(SHOP)

function reviewOf(change: (m: ManifestInput) => ManifestInput): PendingReview {
  return {
    adapterId: 'woolworths',
    name: 'Shop',
    site: 'shop.test',
    from: { version: '1.0.0', hash: 'aa'.repeat(32) },
    to: { version: '1.0.1', hash: 'bb'.repeat(32) },
    submittedAt: '2026-11-07T10:30:00Z',
    source: 'ide',
    diff: permissionDiff(before, parseManifest(change(structuredClone(SHOP)))),
    manifestDiff: [],
    files: [],
  }
}

async function show(review: PendingReview) {
  const api = createFakeApi({ now: NOW })
  api.fake.setPendingReview(review)
  window.location.hash = '#/adapters/woolworths/review'
  render(
    <ApiProvider api={api} clock={{ now: () => NOW }}>
      <ControlPanel />
    </ApiProvider>,
  )
  await screen.findByText('Permission changes')
  return screen.queryAllByTestId('perm-added')
}

/** The one highlighted row: what it shows, its tag, and the badge in the summary. */
interface Expect {
  readonly row: string
  readonly tag: string
  readonly badge: string
  readonly why?: string
}

const KINDS: [string, (m: ManifestInput) => ManifestInput, Expect][] = [
  [
    'a new navigation origin',
    (m) => ({ ...m, navigation: [...(m.navigation as string[]), 'https://cdn.shop.test'] }),
    { row: 'https://cdn.shop.test', tag: 'new origin', badge: '+1 login origin' },
  ],
  [
    'a new egress host',
    (m) => ({ ...m, egress: ['www.shop.test', 'api.shop.test'] }),
    { row: 'api.shop.test', tag: 'new host', badge: '+1 host' },
  ],
  [
    'a new auth frame origin',
    (m) => ({ ...m, auth: { ...m.auth!, frameOrigins: ['https://captcha.test'] } }),
    { row: 'https://captcha.test', tag: 'new frame origin', badge: '+1 frame origin' },
  ],
  [
    'a new secret',
    (m) => ({
      ...m,
      secrets: {
        ...m.secrets,
        rewards: { description: 'Rewards', fields: ['password'], origins: ['https://login.shop.test'] },
      },
    }),
    { row: 'rewards', tag: 'new secret', badge: '+1 secret' },
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
    { row: 'login', tag: 'new field', badge: '+1 secret field', why: 'Now also asks for' },
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
    {
      row: 'login',
      tag: 'new origin',
      badge: '+1 secret origin',
      why: 'Now also typed on https://www.shop.test.',
    },
  ],
  [
    'a new Messages sender',
    (m) => ({
      ...m,
      auth: {
        steps: (m.auth!.steps as AuthStep[]).map((s) =>
          s.op === 'otp'
            ? { ...s, source: { messages: { sender: 'Other', pattern: '(\\d{6})', maxAgeSeconds: 300 } } }
            : s,
        ),
      },
    }),
    // The otp step's wording changes too, so the login flow also shows a new step.
    { row: 'Other', tag: 'new SMS sender', badge: '+1 SMS code source' },
  ],
  [
    'a new request declaration',
    (m) => ({
      ...m,
      requests: [...(m.requests ?? []), { method: 'POST', path: '/api/checkout', purpose: 'irreversible' }],
    }),
    { row: 'POST /api/checkout', tag: 'irreversible', badge: '+1 irreversible path' },
  ],
  [
    'a new tool',
    (m) => ({
      ...m,
      tools: [...m.tools, { name: 'pay', title: 'Pay', description: 'Pays.', sideEffect: 'irreversible' }],
    }),
    { row: 'pay', tag: 'irreversible', badge: '+1 irreversible tool' },
  ],
  [
    'a tool whose side effect goes from read to write',
    (m) => ({ ...m, tools: m.tools.map((t) => (t.name === 'echo' ? { ...t, sideEffect: 'write' } : t)) }),
    { row: 'echo', tag: 'read → write', badge: '+1 write tool', why: 'Its side effect went up.' },
  ],
  [
    'a tool whose side effect goes to irreversible',
    (m) => ({
      ...m,
      tools: m.tools.map((t) => (t.name === 'add' ? { ...t, sideEffect: 'irreversible' } : t)),
    }),
    {
      row: 'add',
      tag: 'write → irreversible',
      badge: '+1 irreversible tool',
      why: 'Its side effect went up.',
    },
  ],
  [
    'a new cookie domain',
    (m) => ({ ...m, session: { ...m.session!, cookieDomains: ['www.shop.test', 'shop.test'] } }),
    { row: 'cookies on shop.test', tag: 'new domain', badge: '+1 hand-over domain' },
  ],
  [
    'a new storage key',
    (m) => ({
      ...m,
      session: { ...m.session!, storage: [{ origin: 'https://www.shop.test', keys: ['token'] }] },
    }),
    { row: 'https://www.shop.test · token', tag: 'new storage key', badge: '+1 storage key' },
  ],
  [
    'a higher requestsPerRun',
    (m) => ({ ...m, limits: { ...m.limits, requestsPerRun: 6 } }),
    { row: 'Requests per run 5 → 6', tag: 'looser limits', badge: 'looser limits' },
  ],
  [
    'a lower minGapMs',
    (m) => ({ ...m, limits: { ...m.limits, minGapMs: 500 } }),
    { row: 'Gap 1 s → 0.5 s', tag: 'looser limits', badge: 'looser limits' },
  ],
  [
    'a lower cooldownSeconds',
    (m) => ({ ...m, limits: { ...m.limits, cooldownSeconds: 300 } }),
    { row: 'Cool-down', tag: 'looser limits', badge: 'looser limits' },
  ],
  [
    'a lower maxCooldownSeconds',
    (m) => ({ ...m, limits: { ...m.limits, maxCooldownSeconds: 3600 } }),
    { row: 'Longest cool-down', tag: 'looser limits', badge: 'looser limits' },
  ],
]

describe('the review screen highlights each AC15 expansion', () => {
  for (const [name, change, want] of KINDS) {
    it(`${name}`, async () => {
      const added = await show(reviewOf(change))
      const row = added.find(
        (r) => r.textContent?.includes(want.row) && within(r).queryByText(want.tag) !== null,
      )
      expect(row, `a highlighted "${want.tag}" row with ${want.row}`).toBeDefined()
      if (want.why !== undefined) expect(row?.textContent).toContain(want.why)
      expect(screen.getAllByText(want.badge).length).toBeGreaterThan(0)
      expect(screen.getByText('This update asks for more')).toBeTruthy()
      expect(screen.getByRole('checkbox', { name: /read the highlighted additions/ })).toBeTruthy()
    })
  }

  it('shows a changed secret or tool once, as its new form, not also as a removal', async () => {
    await show(
      reviewOf((m) => ({
        ...m,
        secrets: {
          login: {
            description: 'Shop account',
            fields: ['username', 'password', 'otp'],
            origins: ['https://login.shop.test'],
          },
        },
        tools: m.tools.map((t) => (t.name === 'echo' ? { ...t, sideEffect: 'write' } : t)),
      })),
    )
    expect(screen.queryAllByTestId('perm-removed')).toEqual([])
    expect(screen.queryByText('+1 secret')).toBeNull()
  })

  it('groups new request declarations by purpose, riskiest first', async () => {
    await show(
      reviewOf((m) => ({
        ...m,
        requests: [
          ...(m.requests ?? []),
          { method: 'GET', path: '/api/points', purpose: 'read' },
          { method: 'POST', path: '/api/checkout', purpose: 'irreversible' },
          { method: 'PUT', path: '/api/list', purpose: 'write' },
          { method: 'DELETE', path: '/api/list', purpose: 'write' },
        ],
      })),
    )
    const groups = screen.getAllByTestId(/^requests-/)
    expect(groups.map((g) => g.getAttribute('data-testid'))).toEqual([
      'requests-irreversible',
      'requests-write',
      'requests-read',
    ])
    expect(
      within(groups[1] as HTMLElement)
        .getAllByTestId('perm-added')
        .map((r) => r.textContent),
    ).toEqual([expect.stringContaining('PUT /api/list'), expect.stringContaining('DELETE /api/list')])
  })

  it('asks for nothing when limits only tighten', async () => {
    await show(reviewOf((m) => ({ ...m, limits: { requestsPerRun: 4, minGapMs: 2000 } })))
    expect(screen.getByText('This update adds no permissions.')).toBeTruthy()
    expect(screen.getByText('tightened')).toBeTruthy()
  })
})
