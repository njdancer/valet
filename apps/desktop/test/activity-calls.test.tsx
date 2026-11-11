import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TooltipProvider } from '@valet/ui'
import { describe, expect, it } from 'vitest'
import { ControlPanel } from '../src/renderer/control/App'
import { createFakeApi, type FakeApi } from '../src/renderer/dev/fake-api'
import { ApiProvider } from '../src/renderer/lib/api-context'
import type { RunSummary, ValetApi } from '../src/shared/api'

const NOW = Date.parse('2026-11-07T21:48:00+11:00')

function renderAt(hash: string, api: ValetApi) {
  window.location.hash = hash
  render(
    <TooltipProvider>
      <ApiProvider api={api} clock={{ now: () => NOW }}>
        <ControlPanel />
      </ApiProvider>
    </TooltipProvider>,
  )
}

const table = () => screen.findByRole('table', { name: 'Tool calls' })
const rows = (t: HTMLElement) => [...t.querySelectorAll('tbody tr')]

function called(api: FakeApi, method: string): unknown[][] {
  return api.fake.calls.filter((c) => c.method === method).map((c) => [...c.args])
}

describe('Activity › Calls', () => {
  it('is the first Activity tab, with its own heading, and lists every call with its ref and links', async () => {
    const api = createFakeApi({ now: NOW })
    const runs = await api.runs.list()
    renderAt('#/activity/calls', api)
    expect(await screen.findByRole('heading', { level: 1, name: 'Calls' })).toBeTruthy()
    const tabs = screen.getByRole('navigation', { name: 'Activity' })
    expect(
      within(tabs)
        .getByRole('link', { name: /^Calls/ })
        .getAttribute('aria-current'),
    ).toBe('page')
    const t = await table()
    expect(rows(t)).toHaveLength(runs.length)
    const row = rows(t).find((r) => r.textContent?.includes('update_cart_line')) as HTMLElement
    expect(within(row).getByRole('link', { name: 'Call C8F2' }).getAttribute('href')).toBe(
      '#/activity/calls/c_8f2e1b',
    )
    expect(within(row).getByRole('link', { name: 'Woolworths' }).getAttribute('href')).toBe(
      '#/sites/woolworths',
    )
    expect(within(row).getByRole('link', { name: 'update_cart_line' }).getAttribute('href')).toBe(
      '#/activity/calls?site=woolworths&tool=update_cart_line',
    )
    expect(within(row).getByRole('link', { name: 'Claude Code' }).getAttribute('href')).toBe(
      '#/activity/calls?client=claude-code',
    )
    expect(row.textContent).toContain('Changed a trolley line: Dairy Farmers Milk 2L × 2')
    expect(row.textContent).toContain('Ok, 2 blocked')
    expect(screen.getByText(/Traces kept 14 days/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Change' }).getAttribute('href')).toBe('#/settings/data')
  })

  it('puts the waiting action beside a call that needs you', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderAt('#/activity/calls', api)
    const t = await table()
    const row = rows(t).find((r) => r.textContent?.includes('Needs you · Verification check')) as HTMLElement
    await user.click(await within(row).findByRole('button', { name: 'Show login window' }))
    expect(called(api, 'openLoginWindow')).toEqual([['woolworths']])
  })

  it('filters through the address, and says so in words when nothing matches', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderAt('#/activity/calls', api)
    await table()
    await user.click(screen.getByRole('button', { name: /^Outcome:/ }))
    await user.click(await screen.findByRole('menuitemradio', { name: 'Blocked by the site' }))
    await waitFor(() => expect(window.location.hash).toBe('#/activity/calls?outcome=blocked'))
    await waitFor(async () => expect(rows(await table())).toHaveLength(2))
    await user.click(screen.getByRole('button', { name: /^Site:/ }))
    await user.click(await screen.findByRole('menuitemradio', { name: 'Coles' }))
    await waitFor(() => expect(window.location.hash).toBe('#/activity/calls?site=coles&outcome=blocked'))
    await waitFor(async () => expect(rows(await table())).toHaveLength(1))
    await user.click(screen.getByRole('button', { name: /^Outcome:/ }))
    await user.click(await screen.findByRole('menuitemradio', { name: 'Worked' }))
    expect(await screen.findByText('No worked Coles calls')).toBeTruthy()
    const clear = screen.getAllByRole('link', { name: 'Clear filters' })
    expect(clear.every((a) => a.getAttribute('href') === '#/activity/calls')).toBe(true)
    // "Any" clears one filter.
    await user.click(screen.getByRole('button', { name: /^Site:/ }))
    await user.click(await screen.findByRole('menuitemradio', { name: 'Any' }))
    await waitFor(() => expect(window.location.hash).toBe('#/activity/calls?outcome=ok'))
  })

  it('filters by tool and app', async () => {
    const user = userEvent.setup()
    renderAt('#/activity/calls?client=claude-ai', createFakeApi({ now: NOW }))
    await waitFor(async () => expect(rows(await table())).toHaveLength(2))
    await user.click(screen.getByRole('button', { name: /^Tool:/ }))
    await user.click(await screen.findByRole('menuitemradio', { name: 'get_trolley' }))
    await waitFor(() =>
      expect(window.location.hash).toBe('#/activity/calls?tool=get_trolley&client=claude-ai'),
    )
    await waitFor(async () => expect(rows(await table())).toHaveLength(1))
    await user.click(screen.getByRole('button', { name: /^App:/ }))
    await user.click(await screen.findByRole('menuitemradio', { name: 'Claude Code' }))
    await waitFor(() =>
      expect(window.location.hash).toBe('#/activity/calls?tool=get_trolley&client=claude-code'),
    )
    expect(await screen.findByText('No get_trolley calls')).toBeTruthy()
  })

  it('shows the calls that used a login, from the audit log’s login-use records, with the way back', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    const audit = await api.audit.page({ category: 'secret-use', limit: 500 })
    const used = new Set(
      audit.records.flatMap((r) =>
        r.event.type === 'secret-used' && r.event.callId !== null ? [r.event.callId] : [],
      ),
    )
    renderAt('#/activity/calls?login=woolworths%2Flogin', api)
    expect(await screen.findByText('Calls that used your Woolworths login “login”')).toBeTruthy()
    await waitFor(async () => expect(rows(await table())).toHaveLength(used.size))
    expect(screen.getByRole('link', { name: 'Back to the login' }).getAttribute('href')).toBe(
      '#/secrets/woolworths/login',
    )
    await user.click(screen.getByRole('button', { name: 'Remove filter Login used' }))
    await waitFor(() => expect(window.location.hash).toBe('#/activity/calls'))
  })

  it('folds a retry answer into the call that followed it', async () => {
    const fake = createFakeApi({ now: NOW })
    const base = (await fake.runs.list())[2] as RunSummary
    const later = { ...base, callId: 'c_bbbb01', startedAt: new Date(NOW - 60_000).toISOString() }
    const retried = {
      ...base,
      callId: 'c_aaaa01',
      startedAt: new Date(NOW - 120_000).toISOString(),
      outcome: 'failed' as const,
      errorClass: 'login-in-progress' as const,
      stage: 'login' as const,
    }
    renderAt('#/activity/calls', { ...fake, runs: { ...fake.runs, list: async () => [later, retried] } })
    const t = await table()
    expect(rows(t)).toHaveLength(1)
    expect(t.textContent).toContain('after a retry')
  })

  it('says where older calls are when the list is full', async () => {
    const fake = createFakeApi({ now: NOW })
    const base = (await fake.runs.list())[3] as RunSummary
    const many = Array.from({ length: 200 }, (_, i) => ({
      ...base,
      callId: `c_${i.toString(16).padStart(6, '0')}`,
    }))
    renderAt('#/activity/calls', { ...fake, runs: { ...fake.runs, list: async () => many } })
    expect(await screen.findByText(/Showing the newest 200/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Audit log' }).getAttribute('href')).toBe(
      '#/activity/audit?category=tool-calls',
    )
  })

  it('says so when there are no calls yet, and how to connect an app', async () => {
    const fake = createFakeApi({ now: NOW })
    renderAt('#/activity/calls', { ...fake, runs: { ...fake.runs, list: async () => [] } })
    expect(await screen.findByText('No calls yet')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Connect an app' }).getAttribute('href')).toBe('#/connections')
  })

  it('says so when the calls can’t be loaded', async () => {
    const fake = createFakeApi({ now: NOW })
    fake.fake.failNext('runs.list')
    renderAt('#/activity/calls', fake)
    expect(await screen.findByText('Valet couldn’t load the calls.')).toBeTruthy()
  })
})
