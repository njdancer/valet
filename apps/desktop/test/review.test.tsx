import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TooltipProvider } from '@valet/ui'
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
const REVIEW = '#/sites/woolworths/versions/review'
/** The approval seal shows for a moment before the page moves on. */
const AFTER_SEAL = { timeout: 3000 }

function renderAt(hash: string, api: FakeApi) {
  window.location.hash = hash
  render(
    <ApiProvider api={api} clock={{ now: () => NOW }}>
      <TooltipProvider>
        <ControlPanel />
      </TooltipProvider>
    </ApiProvider>,
  )
}

function disabled(button: HTMLElement): boolean {
  return button.getAttribute('aria-disabled') === 'true' || (button as HTMLButtonElement).disabled
}

function checked(box: HTMLElement): boolean {
  return box.getAttribute('aria-checked') === 'true'
}

const ACK = /I’ve read the highlighted additions/

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
    settings: { added: [], removed: [], unchanged: [] },
    limits: { before: LIMITS, after: { ...LIMITS, requestsPerRun: 4 } },
    probe: { before: PROBE, after: PROBE },
  },
  manifestDiff: [],
  files: [],
}

describe('reviewing an update', () => {
  it('is a page in the shell with a breadcrumb back to the site and its versions', async () => {
    renderAt(REVIEW, createFakeApi({ now: NOW }))
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Review the Woolworths update (0.4.0)' }),
    ).toBeTruthy()
    const crumbs = within(screen.getByRole('navigation', { name: 'Breadcrumb' }))
    expect(crumbs.getByRole('link', { name: 'Sites' }).getAttribute('href')).toBe('#/sites')
    expect(crumbs.getByRole('link', { name: 'Woolworths' }).getAttribute('href')).toBe('#/sites/woolworths')
    expect(crumbs.getByRole('link', { name: 'Versions' }).getAttribute('href')).toBe(
      '#/sites/woolworths/versions',
    )
    expect(screen.getByText('Calls use 0.3.0 until you decide')).toBeTruthy()
    expect(screen.getByRole('link', { name: /^Close/ }).getAttribute('href')).toBe('#/sites/woolworths')
    expect(screen.getByRole('link', { name: 'Decide later' }).getAttribute('href')).toBe('#/sites/woolworths')
  })

  it('shows the permission diff with the added host highlighted', async () => {
    const api = createFakeApi({ now: NOW })
    renderAt(REVIEW, api)
    expect(await screen.findByText('Permission changes')).toBeTruthy()
    const added = screen.getAllByTestId('perm-added')
    expect(added.map((row) => row.textContent)).toEqual([
      expect.stringContaining('api.woolworthsrewards.com.au'),
      expect.stringContaining('get_rewards_balance'),
      expect.stringContaining('GET /api/v1/rewards/balance'),
    ])
    expect(within(added[0] as HTMLElement).getByText('new host')).toBeTruthy()
    expect(added[0]?.textContent).toContain('including your session cookies')
    expect(screen.getByText('+1 host')).toBeTruthy()
    // The manifest and its files are open on an update.
    expect(screen.getByRole('region', { name: 'Manifest changes' }).textContent).toContain(
      'api.woolworthsrewards.com.au',
    )
    expect(screen.getByText('src/manifest.ts')).toBeTruthy()
  })

  it('keeps Approve disabled until the additions are acknowledged, then approves exactly the reviewed hash', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderAt(REVIEW, api)
    const approve = await screen.findByRole('button', { name: 'Approve 0.4.0' })
    expect(disabled(approve)).toBe(true)
    // The disabled button says why.
    expect(approve.getAttribute('aria-description')).toMatch(/Tick “I’ve read the highlighted additions”/)

    await user.click(approve)
    expect(api.fake.calls.some((c) => c.method === 'approvals.approve')).toBe(false)

    await user.click(screen.getByRole('checkbox', { name: ACK }))
    const ready = screen.getByRole('button', { name: 'Approve 0.4.0' })
    expect(disabled(ready)).toBe(false)
    await user.click(ready)

    await waitFor(() =>
      expect(api.fake.calls.filter((c) => c.method === 'approvals.approve')).toEqual([
        { method: 'approvals.approve', args: ['woolworths', WOOLWORTHS_NEXT_HASH] },
      ]),
    )
    // The seal, then the site.
    expect(await screen.findByRole('img', { name: 'Approved Woolworths 0.4.0' })).toBeTruthy()
    await waitFor(() => expect(window.location.hash).toBe('#/sites/woolworths'), AFTER_SEAL)
  })

  it('does not ask for the tick when the update only removes things or tightens limits', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    api.fake.setPendingReview(REMOVALS_ONLY)
    renderAt(REVIEW, api)
    const approve = await screen.findByRole('button', { name: 'Approve 0.3.1' })
    expect(screen.queryByRole('checkbox', { name: ACK })).toBeNull()
    expect(screen.getByText('This update adds no permissions.')).toBeTruthy()
    expect(screen.getByText('Nothing new is asked for')).toBeTruthy()
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
    renderAt(REVIEW, api)
    await user.click(await screen.findByRole('checkbox', { name: ACK }))
    expect(disabled(screen.getByRole('button', { name: 'Approve 0.4.0' }))).toBe(false)

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
    expect(disabled(approve)).toBe(true)
    expect(screen.getByText('fill #headerSearch ← login.password')).toBeTruthy()
    expect(checked(screen.getByRole('checkbox', { name: ACK }))).toBe(false)
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
    renderAt(REVIEW, api)
    expect(await screen.findByRole('checkbox', { name: ACK })).toBeTruthy()
    expect(screen.getByText('+1 irreversible tool')).toBeTruthy()
    expect(screen.getByText('write → irreversible')).toBeTruthy()
    expect(screen.getAllByText('looser limits').length).toBeGreaterThan(0)
  })

  it('rejects, and stays put with an error when the main process refuses', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderAt(REVIEW, api)
    api.fake.failNext('approvals.reject')
    await user.click(await screen.findByRole('button', { name: 'Reject' }))
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Couldn’t save your answer; the bundle may have changed. Try again.',
    )
    expect(document.body.textContent).not.toContain('fake approvals.reject failed')
    expect(window.location.hash).toBe(REVIEW)

    await user.click(screen.getByRole('button', { name: 'Reject' }))
    await waitFor(() => expect(window.location.hash).toBe('#/sites/woolworths'))
    expect(await api.approvals.pending()).toEqual([])
  })

  it('says so when an approval fails, and approves nothing else', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderAt(REVIEW, api)
    await user.click(await screen.findByRole('checkbox', { name: ACK }))
    api.fake.failNext('approvals.approve')
    await user.click(screen.getByRole('button', { name: 'Approve 0.4.0' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.queryByRole('img', { name: /^Approved/ })).toBeNull()
    expect(window.location.hash).toBe(REVIEW)
  })

  it('opens the grant sheet next when asked', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderAt(REVIEW, api)
    const next = await screen.findByRole('checkbox', { name: 'Choose the login for 0.4.0 next' })
    // Unticked on an update: the person chooses.
    expect(checked(next)).toBe(false)
    await user.click(next)
    await user.click(screen.getByRole('checkbox', { name: ACK }))
    await user.click(screen.getByRole('button', { name: 'Approve 0.4.0' }))
    await waitFor(() => expect(window.location.hash).toBe('#/sites/woolworths/login/login'), AFTER_SEAL)
  })

  it('closes on Escape, back to the site', async () => {
    const user = userEvent.setup()
    renderAt(REVIEW, createFakeApi({ now: NOW }))
    await screen.findByRole('button', { name: 'Approve 0.4.0' })
    await user.keyboard('{Escape}')
    await waitFor(() => expect(window.location.hash).toBe('#/sites/woolworths'))
  })

  it('shows every kind of addition and removal, for a first install', async () => {
    const user = userEvent.setup()
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
        settings: {
          added: [
            { name: 'store', title: 'Store', required: false, choicesTool: 'find_stores', applyTool: null },
          ],
          removed: [
            {
              name: 'region',
              title: 'Region',
              required: false,
              choicesTool: 'find_regions',
              applyTool: null,
            },
          ],
          unchanged: [],
        },
        limits: null,
        probe: null,
      },
      manifestDiff: [
        { kind: 'hunk', oldLine: null, newLine: null, text: '@@ "tools" @@' },
        { kind: 'add', oldLine: null, newLine: 1, text: '{ "name": "pay" }' },
      ],
      files: [{ path: 'src/old.ts', status: 'removed', added: 0, removed: 12 }],
    })
    renderAt(REVIEW, api)
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Review Woolworths before first use' }),
    ).toBeTruthy()
    expect(screen.getByText('Not approved yet')).toBeTruthy()
    expect(screen.getByText('Next: choose a login')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: /Every permission, in detail/ }))
    await user.click(screen.getByRole('button', { name: /^Code/ }))
    await user.click(screen.getByRole('button', { name: /Raw manifest.*1 line/ }))
    expect(screen.getByRole('region', { name: 'Manifest changes' }).textContent).toContain(
      'Added: { "name": "pay" }',
    )
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
      'Valet runs find_stores to list the choices',
    ]) {
      expect(added.some((row) => row?.includes(text))).toBe(true)
    }
    // The adapter's own description is quoted and attributed, never the app's statement.
    expect(added.some((row) => row?.includes('The adapter describes it as “Rewards account”'))).toBe(true)
    expect(screen.getAllByTestId('perm-removed')).toHaveLength(11)
    // A first install's badges say what it asks for, not what it adds (D-review).
    expect(screen.getByText('What it asks for')).toBeTruthy()
    expect(screen.getByText('1 irreversible tool')).toBeTruthy()
    expect(screen.getByText('removed')).toBeTruthy()
  })

  it('opens a first install on a plain summary, folds the details, needs no tick, and goes to the login next', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW, firstRun: true })
    renderAt(REVIEW, api)
    const summary = await screen.findByTestId('first-install-summary')
    expect(summary.textContent).toContain('What Woolworths may do')
    expect(summary.textContent).toContain('www.woolworths.com.au')
    expect(summary.textContent).toMatch(/Reads.*Search products/)
    expect(summary.textContent).toMatch(/username, password, typed only on.*auth\.woolworths\.com\.au/)
    // The full detail is one click away, not the first thing on screen.
    expect(
      screen.getByRole('button', { name: /Every permission, in detail/ }).getAttribute('aria-expanded'),
    ).toBe('false')
    expect(screen.queryByTestId('perm-added')).toBeNull()
    expect(screen.queryByRole('checkbox', { name: ACK })).toBeNull()
    expect(checked(screen.getByRole('checkbox', { name: /Choose the login for .* next/ }))).toBe(true)
    const approve = screen.getByRole('button', { name: 'Approve Woolworths' })
    expect(disabled(approve)).toBe(false)
    await user.click(approve)
    expect(api.fake.calls.filter((c) => c.method === 'approvals.approve')).toHaveLength(1)
    await waitFor(() => expect(window.location.hash).toBe('#/sites/woolworths/login/login'), AFTER_SEAL)
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
    renderAt(REVIEW, api)
    const approve = await screen.findByRole('button', { name: 'Approve 0.3.1' })
    const added = screen.getAllByTestId('perm-added')
    expect(added).toHaveLength(1)
    expect(added[0]?.textContent).toContain('click button#accept-terms')
    expect(added[0]?.textContent).toContain('A click can accept terms')
    expect(screen.getByText('+1 login step')).toBeTruthy()
    expect(disabled(approve)).toBe(true)
    await user.click(approve)
    expect(api.fake.calls.some((c) => c.method === 'approvals.approve')).toBe(false)
  })

  it('shows a setting the update adds, with the tools Valet runs for it, as an addition that needs the tick (D69)', async () => {
    const api = createFakeApi({ now: NOW })
    api.fake.setPendingReview({
      ...REMOVALS_ONLY,
      diff: {
        ...REMOVALS_ONLY.diff,
        egress: { added: [], removed: [], unchanged: ['www.woolworths.com.au'] },
        tools: { added: [], removed: [], unchanged: [] },
        limits: { before: LIMITS, after: LIMITS },
        settings: {
          added: [
            {
              name: 'store',
              title: 'Store',
              required: true,
              choicesTool: 'find_stores',
              applyTool: 'apply_store',
            },
          ],
          removed: [],
          unchanged: [],
        },
      },
    })
    renderAt(REVIEW, api)
    const approve = await screen.findByRole('button', { name: 'Approve 0.3.1' })
    const added = screen.getAllByTestId('perm-added')
    expect(added).toHaveLength(1)
    expect(added[0]?.textContent).toContain('store')
    expect(added[0]?.textContent).toContain('required setting')
    expect(added[0]?.textContent).toContain('find_stores')
    expect(added[0]?.textContent).toContain('apply_store before a tool call')
    expect(screen.getByText('+1 setting')).toBeTruthy()
    expect(disabled(approve)).toBe(true)
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
    renderAt(REVIEW, api)
    expect(await screen.findByRole('checkbox', { name: ACK })).toBeTruthy()
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
    renderAt(REVIEW, api)
    expect(
      await screen.findByText(
        'Requests per run 6 → 3 · Gap 10 s → 20 s · Cool-down 30 → 60 min · Longest cool-down 360 → 720 min',
      ),
    ).toBeTruthy()
  })

  it('says so when nothing is waiting, with the way back', async () => {
    renderAt('#/sites/coles/versions/review', createFakeApi({ now: NOW }))
    expect(await screen.findByText('Nothing is waiting for review for this adapter.')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Back to the site' }).getAttribute('href')).toBe('#/sites/coles')
  })

  it('says so when the review can’t be loaded', async () => {
    const api = createFakeApi({ now: NOW })
    // The sidebar's Needs you count reads the pending reviews too (for unfinished setup).
    api.fake.failNext('approvals.pending', Number.POSITIVE_INFINITY)
    renderAt(REVIEW, api)
    expect(await screen.findByText(/Valet couldn’t load the review/)).toBeTruthy()
  })

  it('still opens from the old address', async () => {
    renderAt('#/adapters/woolworths/review', createFakeApi({ now: NOW }))
    expect(await screen.findByRole('button', { name: 'Approve 0.4.0' })).toBeTruthy()
  })
})

describe('the review inside setup', () => {
  it('leads back into setup either way and leaves the login to setup’s next step', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW, firstRun: true })
    renderAt('#/setup/approve/review', api)
    const approve = await screen.findByRole('button', { name: 'Approve Woolworths' })
    const crumbs = within(screen.getByRole('navigation', { name: 'Breadcrumb' }))
    expect(crumbs.getByRole('link', { name: 'Set up Valet' }).getAttribute('href')).toBe('#/setup/approve')
    expect(screen.getByRole('link', { name: /^Close/ }).getAttribute('href')).toBe('#/setup/approve')
    expect(screen.queryByRole('checkbox', { name: /Choose the login/ })).toBeNull()
    await user.click(approve)
    await waitFor(() => expect(window.location.hash).toBe('#/setup/grant'), AFTER_SEAL)
  })
})
