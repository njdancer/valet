import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { ControlPanel } from '../src/renderer/control/App'
import { isLockedDown } from '../src/renderer/control/shell-state'
import { shortcutTarget } from '../src/renderer/control/useShortcuts'
import { createFakeApi, type FakeApi } from '../src/renderer/dev/fake-api'
import { ApiProvider } from '../src/renderer/lib/api-context'
import { callRef, formatClock } from '../src/renderer/lib/format'
import {
  confirmTitle,
  loginTitle,
  needsYouOrder,
  needsYouView,
  reviewTitle,
} from '../src/renderer/lib/needs-you'
import { siteStatus } from '../src/renderer/lib/site-status'
import type { AdapterSummary, AppStatus, AttentionItem, SiteHealth } from '../src/shared/api'

const NOW = Date.parse('2026-11-07T21:48:00+11:00')

function renderAt(hash: string, api: FakeApi = createFakeApi({ now: NOW })) {
  window.location.hash = hash
  render(
    <ApiProvider api={api} clock={{ now: () => NOW }}>
      <ControlPanel />
    </ApiProvider>,
  )
  return api
}

function called(api: FakeApi, method: string): unknown[][] {
  return api.fake.calls.filter((c) => c.method === method).map((c) => [...c.args])
}

afterEach(() => {
  document.documentElement.removeAttribute('data-platform')
})

describe('the control panel shell', () => {
  it('shows the six places, the sites with their health, and one status line', async () => {
    renderAt('#/needs-you')
    const nav = screen.getByRole('navigation', { name: 'Places' })
    for (const name of ['Needs you', 'Sites', 'Activity', 'Connections', 'Secrets', 'Settings']) {
      expect(within(nav).getByRole('link', { name: new RegExp(`^${name}`) })).toBeTruthy()
    }
    expect(
      within(nav)
        .getByRole('link', { name: /^Needs you/ })
        .getAttribute('aria-current'),
    ).toBe('page')
    expect(await within(nav).findByRole('link', { name: /Woolworths/ })).toBeTruthy()
    expect(
      within(nav)
        .getByRole('link', { name: /Woolworths/ })
        .getAttribute('href'),
    ).toBe('#/sites/woolworths')
    expect(await within(nav).findByText(/^Ready · \d+ apps? connected$|^Ready$/)).toBeTruthy()
  })

  it('lists what is waiting, soonest deadline first, each with its own action', async () => {
    const user = userEvent.setup()
    const api = renderAt('#/needs-you')
    const list = await screen.findByRole('list', { name: 'Waiting for you' })
    const titles = within(list)
      .getAllByRole('listitem')
      .map((li) => li.textContent ?? '')
    // Soonest deadline first: the confirmation runs out before the login window closes.
    expect(titles[0]).toContain('Confirm: Remove from cart (Woolworths)')
    expect(titles.findIndex((t) => t.includes('Log in to Woolworths (verification check)'))).toBeGreaterThan(
      0,
    )
    expect(titles.some((t) => t.includes('Review the Woolworths update (0.4.0)'))).toBe(true)
    expect(
      within(list)
        .getByRole('link', { name: callRef('c_a40f3c') })
        .getAttribute('href'),
    ).toBe('#/activity/calls/c_a40f3c')

    await user.click(screen.getByRole('button', { name: 'Answer…' }))
    expect(called(api, 'openConfirmation')).toEqual([['cf_a40f3c']])
    await user.click(screen.getByRole('button', { name: 'Show login window' }))
    expect(called(api, 'openLoginWindow')).toEqual([['woolworths']])
    await user.click(screen.getByRole('button', { name: 'Review update' }))
    expect(window.location.hash).toBe('#/sites/woolworths/versions/review')
  })

  it('lists unfinished setup as one item, and counts it in the sidebar as the menu bar does', async () => {
    const api = createFakeApi({ now: NOW, firstRun: true })
    renderAt('#/needs-you', api)
    const list = await screen.findByRole('list', { name: 'Waiting for you' })
    const setup = await within(list).findByText(/^Finish setup \(\d steps? left\)$/)
    expect(setup).toBeTruthy()
    expect(within(list).getByRole('link', { name: 'Continue setup' }).getAttribute('href')).toBe('#/setup')
    const waiting = (await api.attention.list()).filter((i) => i.kind !== 'missed').length
    const nav = screen.getByRole('navigation', { name: 'Places' })
    await waitFor(() =>
      expect(within(nav).getByRole('link', { name: /^Needs you/ }).textContent).toContain(
        String(waiting + 1),
      ),
    )
  })

  it('opens the item a notification names, and leaves Needs you as the address', async () => {
    const api = renderAt('#/needs-you/cf_a40f3c')
    await waitFor(() => expect(called(api, 'openConfirmation')).toEqual([['cf_a40f3c']]))
    await waitFor(() => expect(window.location.hash).toBe('#/needs-you'))
  })

  it('says nothing needs you, with the system status, when nothing waits', async () => {
    const api = createFakeApi({ now: NOW })
    const empty: FakeApi = { ...api, attention: { ...api.attention, list: async () => [] } }
    renderAt('#/needs-you', empty)
    expect(await screen.findByText('Nothing needs you')).toBeTruthy()
    expect(await screen.findByRole('link', { name: 'Open Woolworths' })).toBeTruthy()
    expect(await screen.findByText(/Endpoint (on|off)/)).toBeTruthy()
  })

  it('moves an old address to its new place', async () => {
    renderAt('#/clients')
    await waitFor(() => expect(window.location.hash).toBe('#/connections'))
    const nav = screen.getByRole('navigation', { name: 'Places' })
    expect(
      within(nav)
        .getByRole('link', { name: /^Connections/ })
        .getAttribute('aria-current'),
    ).toBe('page')
  })

  it('shows a page for an address that leads nowhere', async () => {
    renderAt('#/elsewhere')
    expect(await screen.findByText('There’s nothing at this address')).toBeTruthy()
  })

  it('pauses from the title bar and says so on every page until resumed', async () => {
    const user = userEvent.setup()
    const api = renderAt('#/needs-you')
    await user.click(await screen.findByRole('button', { name: 'Pause Valet' }))
    expect(called(api, 'app.setPaused')).toEqual([[true]])
    expect(await screen.findByText('Paused · calls are refused and nothing is sent')).toBeTruthy()
    const strip = screen.getByRole('status')
    await user.click(within(strip).getByRole('button', { name: 'Resume' }))
    expect(called(api, 'app.setPaused')).toEqual([[true], [false]])
  })

  it('asks before locking down and names what can’t be undone', async () => {
    const user = userEvent.setup()
    renderAt('#/needs-you')
    await user.click(await screen.findByRole('button', { name: 'More ways to stop Valet' }))
    await user.click(await screen.findByRole('menuitem', { name: /Lock down/ }))
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(/every cloud agent is removed/)).toBeTruthy()
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  })

  it('opens the command palette with the shortcut and goes where it says', async () => {
    const user = userEvent.setup()
    renderAt('#/needs-you')
    await screen.findByRole('list', { name: 'Waiting for you' })
    await user.keyboard('{Control>}k{/Control}')
    const palette = await screen.findByRole('dialog', { name: 'Command palette' })
    await user.click(within(palette).getByRole('option', { name: /^Secrets/ }))
    expect(window.location.hash).toBe('#/secrets')
  })

  it('goes to each place on its shortcut', async () => {
    renderAt('#/needs-you')
    await screen.findByRole('navigation', { name: 'Places' })
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '2', code: 'Digit2', ctrlKey: true }))
    })
    expect(window.location.hash).toBe('#/sites')
  })
})

describe('shortcuts', () => {
  const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init)
  it('reads the platform’s command key', () => {
    expect(shortcutTarget(key({ key: 'k', code: 'KeyK', ctrlKey: true }))).toBe('palette')
    expect(shortcutTarget(key({ key: 'k', code: 'KeyK', metaKey: true }))).toBeNull()
    document.documentElement.dataset['platform'] = 'mac'
    expect(shortcutTarget(key({ key: 'k', code: 'KeyK', metaKey: true }))).toBe('palette')
    expect(shortcutTarget(key({ key: 'k', code: 'KeyK', ctrlKey: true }))).toBeNull()
    expect(shortcutTarget(key({ key: '#', code: 'Digit3', metaKey: true, shiftKey: true }))).toBe(
      '#/activity/audit',
    )
    expect(shortcutTarget(key({ key: '6', code: 'Digit6', metaKey: true }))).toBe('#/settings')
    expect(shortcutTarget(key({ key: ',', code: 'Comma', metaKey: true }))).toBe('#/settings')
    expect(shortcutTarget(key({ key: '[', code: 'BracketLeft', metaKey: true }))).toBe('back')
    expect(shortcutTarget(key({ key: ']', code: 'BracketRight', metaKey: true }))).toBe('forward')
    expect(shortcutTarget(key({ key: 'P', code: 'KeyP', metaKey: true, shiftKey: true }))).toBe('pause')
    expect(shortcutTarget(key({ key: '9', code: 'Digit9', metaKey: true }))).toBeNull()
  })
})

describe('needs-you items', () => {
  const base = {
    adapterId: 'woolworths',
    adapterName: 'Woolworths',
  }
  it('uses the shared titles', () => {
    expect(confirmTitle('Remove from cart', 'Woolworths')).toBe('Confirm: Remove from cart (Woolworths)')
    expect(loginTitle('Woolworths', 'captcha')).toBe('Log in to Woolworths (verification check)')
    expect(reviewTitle('Woolworths', '0.4.0', false)).toBe('Review the Woolworths update (0.4.0)')
    expect(reviewTitle('Woolworths', '0.4.0', true)).toBe('Review Woolworths before first use')
  })

  it('shows an item kind this build doesn’t know rather than dropping it', () => {
    const view = needsYouView({ kind: 'from-the-future', id: 'x' } as unknown as AttentionItem, () => false)
    expect(view.title).toBe('Something needs you')
    expect(view.action).toEqual({ kind: 'route', to: '#/needs-you' })
  })

  it('sorts by deadline, then by age, missed last', () => {
    const v = (id: string, deadline: number | null, at: number, missed = false) => ({
      ...needsYouView({ kind: 'review', id, version: '1', addsPermissions: false, ...base }, () => true),
      deadline,
      at,
      missed,
    })
    const order = needsYouOrder([
      v('a', null, 2),
      v('b', 50, 0),
      v('c', null, 1),
      v('d', 10, 0),
      v('m', 1, 0, true),
    ])
    expect(order.map((x) => x.id)).toEqual(['d', 'b', 'c', 'a', 'm'])
    expect(order[2]?.title).toBe('Review Woolworths before first use')
  })
})

describe('site status', () => {
  const adapter: AdapterSummary = {
    id: 'woolworths',
    name: 'Woolworths',
    site: 'woolworths.com.au',
    version: '0.3.0',
    hash: 'h',
    approval: 'approved',
    pendingUpdate: null,
    toolCounts: { read: 1, write: 1, irreversible: 0 },
    secrets: [{ name: 'login', granted: true }],
    messagesSources: [],
    session: { state: 'logged-in', checkedAt: null, needsUser: null, since: null },
    calls7d: 0,
    settingsNeeded: [],
    cartUrl: null,
    paused: false,
  }
  const health: SiteHealth = {
    host: 'woolworths.com.au',
    adapterIds: ['woolworths'],
    breaker: 'closed',
    retryAt: null,
    cause: null,
    lastOpenedAt: null,
    nextCooldownSeconds: 60,
    calls: 0,
  }
  it('says one thing, with what fixes it', () => {
    expect(siteStatus(adapter, health)).toEqual({ tone: 'success', text: 'Ready', fix: null })
    expect(siteStatus({ ...adapter, approval: 'unapproved' }, health).fix).toBe('review')
    expect(siteStatus({ ...adapter, approval: 'rejected' }, health).tone).toBe('danger')
    expect(siteStatus({ ...adapter, paused: true }, health).fix).toBe('resume')
    expect(
      siteStatus(
        { ...adapter, session: { ...adapter.session, state: 'needs-user', needsUser: 'captcha' } },
        health,
      ).text,
    ).toBe('Waiting for you to log in (verification check)')
    expect(siteStatus({ ...adapter, settingsNeeded: ['Store'] }, health).text).toBe(
      'Choose your Woolworths store · calls wait until you do',
    )
    expect(siteStatus({ ...adapter, secrets: [{ name: 'login', granted: false }] }, health).fix).toBe('login')
    const retryAt = new Date(NOW).toISOString()
    expect(siteStatus(adapter, { ...health, breaker: 'open', retryAt, cause: 'blocked-by-site' }).text).toBe(
      `Woolworths is limiting requests · calls resume at ${formatClock(retryAt)}`,
    )
    expect(
      siteStatus(adapter, { ...health, breaker: 'open', retryAt: null, cause: 'rate-limited' }).text,
    ).toBe('Valet is limiting its requests to Woolworths')
    expect(siteStatus({ ...adapter, pendingUpdate: { version: '0.4.0', hash: 'x' } }, health).fix).toBe(
      'review-update',
    )
    expect(
      siteStatus({ ...adapter, session: { ...adapter.session, state: 'logging-in' } }, health).text,
    ).toBe('Logging in…')
    expect(
      siteStatus({ ...adapter, session: { ...adapter.session, state: 'expired' } }, health).text,
    ).toMatch(/logs in again/)
    expect(siteStatus(adapter, { ...health, calls: 2 }).text).toBe('Working on 2 calls')
    expect(siteStatus(adapter, { ...health, calls: 1 }).text).toBe('Working on 1 call')
  })
})

describe('call refs and lock-down state', () => {
  it('shortens a call id to four hex digits', () => {
    expect(callRef('7f2a91c0-0000-4000-8000-000000000000')).toBe('7F2A')
    expect(callRef('c_8f2e1b')).toBe('8F2E')
    expect(callRef('zz')).toBe('ZZ')
  })
  it('reads lock down only when the main process reports it', () => {
    const status: AppStatus = { paused: false, version: '1', demo: false, lockedDown: false }
    expect(isLockedDown(status)).toBe(false)
    expect(isLockedDown({ ...status, lockedDown: true })).toBe(true)
  })
})
