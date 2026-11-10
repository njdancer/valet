import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { ControlPanel } from '../src/renderer/control/App'
import {
  createFakeApi,
  type FakeApi,
  WOOLWORTHS_HASH,
  WOOLWORTHS_NEXT_HASH,
} from '../src/renderer/dev/fake-api'
import { ApiProvider } from '../src/renderer/lib/api-context'
import type { PendingReview, ProbeInfo } from '../src/shared/api'

const NOW = Date.parse('2026-11-07T21:48:00+11:00')

function renderAt(hash: string, api: FakeApi) {
  window.location.hash = hash
  render(
    <ApiProvider api={api} clock={{ now: () => NOW }}>
      <ControlPanel />
    </ApiProvider>,
  )
}

const LIMITS = { requestsPerRun: 6, minGapMs: 10_000, cooldownSeconds: 1800, maxCooldownSeconds: 21_600 }

const PROBE: ProbeInfo = {
  kind: 'fetch',
  path: '/api/ui/v2/bootstrap',
  expectStatus: 200,
  loggedOutStatuses: [401],
  jsonPath: 'IsLoggedIn',
  equals: true,
}

/** A review that only removes a host and a tool: nothing for the person to acknowledge. */
const REMOVALS_ONLY: PendingReview = {
  adapterId: 'woolworths',
  name: 'Woolworths',
  site: 'woolworths.com.au',
  from: { version: '0.3.0', hash: WOOLWORTHS_HASH },
  to: { version: '0.3.1', hash: 'aa11bb22cc33dd44ee55ff66aa77bb88cc99dd00ee11ff22aa33bb44cc55dd66' },
  submittedAt: '2026-11-07T10:30:00Z',
  source: 'ide',
  diff: {
    navigation: { added: [], removed: [], unchanged: ['https://www.woolworths.com.au'] },
    frameOrigins: { added: [], removed: [], unchanged: [] },
    egress: { added: [], removed: ['acs.woolworths.com.au'], unchanged: ['www.woolworths.com.au'] },
    cookieDomains: { added: [], removed: [], unchanged: ['woolworths.com.au'] },
    storage: { added: [], removed: [], unchanged: [] },
    requests: { added: [], removed: [], unchanged: [] },
    tools: {
      added: [],
      removed: [
        {
          name: 'add_to_cart',
          title: 'Add to cart',
          sideEffect: 'write',
          destructive: true,
          idempotent: false,
        },
      ],
      unchanged: [],
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
    limits: { before: LIMITS, after: { ...LIMITS, requestsPerRun: 4 } },
    probe: { before: PROBE, after: PROBE },
  },
  manifestDiff: [],
  files: [],
}

describe('reviewing an update', () => {
  it('shows the permission diff with the added host highlighted', async () => {
    const api = createFakeApi({ now: NOW })
    renderAt('#/adapters/woolworths/review', api)
    expect(await screen.findByText('Permission changes')).toBeTruthy()
    const added = screen.getAllByTestId('perm-added')
    expect(added.map((row) => row.textContent)).toEqual([
      expect.stringContaining('api.woolworthsrewards.com.au'),
      expect.stringContaining('get_rewards_balance'),
      expect.stringContaining('GET /api/v1/rewards/balance'),
    ])
    expect(within(added[0] as HTMLElement).getByText('new host')).toBeTruthy()
    expect(screen.getByText('+1 host')).toBeTruthy()
  })

  it('keeps Approve disabled until the additions are acknowledged, then approves exactly the reviewed hash', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderAt('#/adapters/woolworths/review', api)
    const approve = await screen.findByRole('button', { name: 'Approve 0.4.0' })
    expect((approve as HTMLButtonElement).disabled).toBe(true)

    await user.click(approve)
    expect(api.fake.calls.some((c) => c.method === 'approvals.approve')).toBe(false)

    await user.click(screen.getByRole('checkbox', { name: /read the highlighted additions/ }))
    expect((approve as HTMLButtonElement).disabled).toBe(false)
    await user.click(approve)

    await waitFor(() =>
      expect(api.fake.calls.filter((c) => c.method === 'approvals.approve')).toEqual([
        { method: 'approvals.approve', args: ['woolworths', WOOLWORTHS_NEXT_HASH] },
      ]),
    )
    await waitFor(() => expect(window.location.hash).toBe('#/adapters/woolworths'))
  })

  it('does not ask for the tick when the update only removes things or tightens limits', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    api.fake.setPendingReview(REMOVALS_ONLY)
    renderAt('#/adapters/woolworths/review', api)
    const approve = await screen.findByRole('button', { name: 'Approve 0.3.1' })
    expect(screen.queryByRole('checkbox', { name: /read the highlighted additions/ })).toBeNull()
    expect(screen.getByText('This update adds no permissions.')).toBeTruthy()
    expect(screen.getAllByTestId('perm-removed')).toHaveLength(2)
    expect(screen.getByText('tightened')).toBeTruthy()
    await user.click(approve)
    await waitFor(() =>
      expect(api.fake.calls.filter((c) => c.method === 'approvals.approve')[0]?.args).toEqual([
        'woolworths',
        REMOVALS_ONLY.to.hash,
      ]),
    )
  })

  it('clears the tick when a different bundle replaces the one being reviewed', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderAt('#/adapters/woolworths/review', api)
    await user.click(await screen.findByRole('checkbox', { name: /read the highlighted additions/ }))
    expect((screen.getByRole('button', { name: 'Approve 0.4.0' }) as HTMLButtonElement).disabled).toBe(false)

    // The authoring agent swaps in a bundle that also wants a new secret fill on the search box.
    const swapped = (await api.approvals.pending())[0] as PendingReview
    act(() =>
      api.fake.setPendingReview({
        ...swapped,
        to: { version: '0.4.1', hash: 'ff'.repeat(32) },
        diff: {
          ...swapped.diff,
          secretFills: {
            added: [{ selector: '#headerSearch', secret: 'login', field: 'password' }],
            removed: [],
            unchanged: swapped.diff.secretFills.unchanged,
          },
        },
      }),
    )
    const approve = await screen.findByRole('button', { name: 'Approve 0.4.1' })
    expect((approve as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('fill #headerSearch ← login.password')).toBeTruthy()
    expect(
      (screen.getByRole('checkbox', { name: /read the highlighted additions/ }) as HTMLInputElement).checked,
    ).toBe(false)
  })

  it('highlights an escalated tool and looser limits as additions', async () => {
    const api = createFakeApi({ now: NOW })
    api.fake.setPendingReview({
      ...REMOVALS_ONLY,
      diff: {
        ...REMOVALS_ONLY.diff,
        tools: {
          added: [
            {
              name: 'update_cart_line',
              title: 'Update cart line',
              sideEffect: 'irreversible',
              destructive: true,
              idempotent: false,
            },
          ],
          removed: [
            {
              name: 'update_cart_line',
              title: 'Update cart line',
              sideEffect: 'write',
              destructive: true,
              idempotent: false,
            },
          ],
          unchanged: [],
        },
        limits: { before: LIMITS, after: { ...LIMITS, minGapMs: 250 } },
      },
    })
    renderAt('#/adapters/woolworths/review', api)
    expect(await screen.findByRole('checkbox', { name: /read the highlighted additions/ })).toBeTruthy()
    expect(screen.getByText('+1 irreversible tool')).toBeTruthy()
    expect(screen.getAllByText('looser limits').length).toBeGreaterThan(0)
  })

  it('rejects, and stays put with an error when the main process refuses', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderAt('#/adapters/woolworths/review', api)
    api.fake.failNext('approvals.reject')
    await user.click(await screen.findByRole('button', { name: 'Reject' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(window.location.hash).toBe('#/adapters/woolworths/review')

    await user.click(screen.getByRole('button', { name: 'Reject' }))
    await waitFor(() => expect(window.location.hash).toBe('#/adapters/woolworths'))
    expect(await api.approvals.pending()).toEqual([])
  })

  it('opens the grant sheet next when asked', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderAt('#/adapters/woolworths/review', api)
    await user.click(await screen.findByRole('checkbox', { name: /Grant “login” next/ }))
    await user.click(screen.getByRole('checkbox', { name: /read the highlighted additions/ }))
    await user.click(screen.getByRole('button', { name: 'Approve 0.4.0' }))
    await waitFor(() => expect(window.location.hash).toBe('#/adapters/woolworths/grant/login'))
  })

  it('shows every kind of addition and removal, for a first install', async () => {
    const api = createFakeApi({ now: NOW })
    api.fake.setPendingReview({
      ...REMOVALS_ONLY,
      from: null,
      to: { version: '1.0.0', hash: 'bb'.repeat(32) },
      source: 'import',
      diff: {
        navigation: { added: ['https://new.example'], removed: ['https://old.example'], unchanged: [] },
        frameOrigins: {
          added: ['https://captcha.example'],
          removed: ['https://oldframe.example'],
          unchanged: [],
        },
        egress: { added: [], removed: [], unchanged: [] },
        cookieDomains: { added: ['new.example'], removed: ['old.example'], unchanged: [] },
        storage: {
          added: [{ origin: 'https://new.example', key: 'auth' }],
          removed: [{ origin: 'https://old.example', key: 'auth' }],
          unchanged: [{ origin: 'https://new.example', key: 'prefs' }],
        },
        requests: {
          added: [{ method: 'POST', path: '/pay', purpose: 'irreversible' }],
          removed: [{ method: 'GET', path: '/old', purpose: 'read' }],
          unchanged: [],
        },
        tools: {
          added: [
            { name: 'pay', title: 'Pay', sideEffect: 'irreversible', destructive: true, idempotent: false },
            { name: 'note', title: 'Note', sideEffect: 'write', destructive: true, idempotent: false },
          ],
          removed: [
            { name: 'old_tool', title: 'Old', sideEffect: 'read', destructive: false, idempotent: true },
          ],
          unchanged: [],
        },
        secrets: {
          added: [
            {
              name: 'rewards',
              description: 'Rewards account',
              fields: ['username', 'otp'],
              origins: ['https://new.example'],
            },
          ],
          removed: [
            { name: 'legacy', description: 'Old', fields: ['password'], origins: ['https://old.example'] },
          ],
          unchanged: [],
        },
        secretFills: {
          added: [{ selector: '#rw-email', secret: 'rewards', field: 'username' }],
          removed: [{ selector: '#old', secret: 'legacy', field: 'password' }],
          unchanged: [],
        },
        authSteps: {
          added: [{ op: 'goto', detail: 'goto https://new.example/login' }],
          removed: [{ op: 'goto', detail: 'goto https://old.example/login' }],
          unchanged: [],
        },
        messagesSources: {
          added: [{ sender: 'Rewards' }],
          removed: [{ sender: 'OldSender' }],
          unchanged: [],
        },
        limits: null,
        probe: null,
      },
      files: [{ path: 'src/old.ts', status: 'removed', added: 0, removed: 12 }],
    })
    renderAt('#/adapters/woolworths/review', api)
    expect(await screen.findByText('Review new adapter')).toBeTruthy()
    expect(screen.getByText('Until you approve, its tools stay off MCP.')).toBeTruthy()
    const added = screen.getAllByTestId('perm-added').map((row) => row.textContent)
    for (const text of [
      'https://new.example',
      'https://captcha.example',
      'fill #rw-email ← rewards.username',
      'cookies on new.example',
      'https://new.example · auth',
      'rewards',
      'Rewards',
      'pay',
      'note',
      'POST /pay',
      'goto https://new.example/login',
    ]) {
      expect(added.some((row) => row?.includes(text))).toBe(true)
    }
    expect(screen.getAllByTestId('perm-removed')).toHaveLength(10)
    expect(screen.getByText('+1 irreversible tool')).toBeTruthy()
    expect(screen.getByText('removed')).toBeTruthy()
  })

  it('shows a login step the update adds, such as a terms click, as an addition that needs the tick', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    api.fake.setPendingReview({
      ...REMOVALS_ONLY,
      diff: {
        ...REMOVALS_ONLY.diff,
        egress: { added: [], removed: [], unchanged: ['www.woolworths.com.au'] },
        tools: { added: [], removed: [], unchanged: [] },
        limits: { before: LIMITS, after: LIMITS },
        authSteps: {
          added: [{ op: 'click', detail: 'click button#accept-terms' }],
          removed: [],
          unchanged: REMOVALS_ONLY.diff.authSteps.unchanged,
        },
      },
    })
    renderAt('#/adapters/woolworths/review', api)
    const approve = await screen.findByRole('button', { name: 'Approve 0.3.1' })
    const added = screen.getAllByTestId('perm-added')
    expect(added).toHaveLength(1)
    expect(added[0]?.textContent).toContain('click button#accept-terms')
    expect(added[0]?.textContent).toContain('A click can accept terms')
    expect(screen.getByText('+1 login step')).toBeTruthy()
    expect((approve as HTMLButtonElement).disabled).toBe(true)
    await user.click(approve)
    expect(api.fake.calls.some((c) => c.method === 'approvals.approve')).toBe(false)
  })

  it('shows a changed login check, before and after, as an addition that needs the tick', async () => {
    const api = createFakeApi({ now: NOW })
    api.fake.setPendingReview({
      ...REMOVALS_ONLY,
      diff: {
        ...REMOVALS_ONLY.diff,
        egress: { added: [], removed: [], unchanged: ['www.woolworths.com.au'] },
        tools: { added: [], removed: [], unchanged: [] },
        probe: { before: PROBE, after: { ...PROBE, loggedOutStatuses: [401, 403], equals: null } },
      },
    })
    renderAt('#/adapters/woolworths/review', api)
    expect(await screen.findByRole('checkbox', { name: /read the highlighted additions/ })).toBeTruthy()
    const added = screen.getAllByTestId('perm-added')
    expect(added).toHaveLength(1)
    expect(added[0]?.textContent).toContain(
      'GET /api/ui/v2/bootstrap → 200 · IsLoggedIn truthy · logged out on 401, 403',
    )
    expect(added[0]?.textContent).toContain(
      'Was: GET /api/ui/v2/bootstrap → 200 · IsLoggedIn = true · logged out on 401.',
    )
    expect(screen.getAllByText('new login check').length).toBeGreaterThan(0)
  })

  it('names each changed limit', async () => {
    const api = createFakeApi({ now: NOW })
    api.fake.setPendingReview({
      ...REMOVALS_ONLY,
      diff: {
        ...REMOVALS_ONLY.diff,
        limits: {
          before: LIMITS,
          after: { requestsPerRun: 3, minGapMs: 20_000, cooldownSeconds: 3600, maxCooldownSeconds: 43_200 },
        },
      },
    })
    renderAt('#/adapters/woolworths/review', api)
    expect(
      await screen.findByText(
        'Requests per run 6 → 3 · Gap 10 s → 20 s · Cool-down 30 → 60 min · Longest cool-down 360 → 720 min',
      ),
    ).toBeTruthy()
  })

  it('says so when nothing is waiting', async () => {
    const api = createFakeApi({ now: NOW })
    renderAt('#/adapters/coles/review', api)
    expect(await screen.findByText('Nothing is waiting for review for this adapter.')).toBeTruthy()
  })
})
