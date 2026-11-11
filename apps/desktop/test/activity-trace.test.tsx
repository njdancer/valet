import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AuditRecord } from '@valet/core'
import { TooltipProvider } from '@valet/ui'
import { describe, expect, it } from 'vitest'
import { ControlPanel } from '../src/renderer/control/App'
import { createFakeApi, type FakeApi } from '../src/renderer/dev/fake-api'
import { ApiProvider } from '../src/renderer/lib/api-context'
import type { RunSummary, RunTrace, ValetApi } from '../src/shared/api'

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

const steps = () => screen.getByRole('list', { name: 'Steps' })
const details = () => screen.getByRole('region', { name: 'Step details' })

/** The fake, with one call's trace changed. */
function withTrace(fake: FakeApi, change: (trace: RunTrace) => RunTrace): FakeApi {
  return {
    ...fake,
    runs: {
      ...fake.runs,
      trace: async (callId) => {
        const trace = await fake.runs.trace(callId)
        return trace === null ? null : change(trace)
      },
    },
  }
}

function withSummary(fake: FakeApi, change: Partial<RunSummary>): FakeApi {
  return withTrace(fake, (t) => ({ ...t, summary: { ...t.summary, ...change } }))
}

/** The fake, with the call's tool-called record naming the credential's client. */
function withClientId(fake: FakeApi, clientId: string): FakeApi {
  return {
    ...fake,
    audit: {
      ...fake.audit,
      page: async (query) => {
        const page = await fake.audit.page(query)
        return {
          ...page,
          records: page.records.map(
            (r): AuditRecord =>
              r.event.type === 'tool-called' ? { ...r, event: { ...r.event, clientId } } : r,
          ),
        }
      },
    },
  }
}

describe('a call’s trace', () => {
  it('names every fact as a link: site, version, tool, login used and its audit records', async () => {
    renderAt('#/activity/calls/c_8f2e1b', createFakeApi({ now: NOW }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Changed a trolley line' })).toBeTruthy()
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' })
    expect(within(crumbs).getByRole('link', { name: 'Calls' }).getAttribute('href')).toBe('#/activity/calls')
    const link = (name: string) => screen.getByRole('link', { name }).getAttribute('href')
    expect(link('Woolworths')).toBe('#/sites/woolworths')
    expect(link('0.3.0')).toBe('#/sites/woolworths/versions')
    expect(link('update_cart_line')).toBe('#/activity/calls?site=woolworths&tool=update_cart_line')
    expect(link('login (username, password)')).toBe('#/secrets/woolworths/login')
    await waitFor(() => expect(link('Audit records (4)')).toBe('#/activity/audit?call=c_8f2e1b'))
    expect(screen.getByText('4 sent (2 checks) · 2 blocked')).toBeTruthy()
  })

  it('traces the login, the hand-off and every request decision, with secrets as markers only', async () => {
    renderAt('#/activity/calls/c_8f2e1b', createFakeApi({ now: NOW }))
    await screen.findByRole('heading', { level: 1, name: 'Changed a trolley line' })
    const list = steps()
    expect(within(list).getByText('Declarative steps, no adapter code')).toBeTruthy()
    expect(within(list).getByText('fill(input[name=username], secret:login.username)')).toBeTruthy()
    expect(within(list).getByText('Handed the session to the tool')).toBeTruthy()
    expect(screen.getByText('[secret:login.username]')).toBeTruthy()
    expect(screen.getByText('[session cookie]')).toBeTruthy()
    expect(screen.getByText('2 exact matches replaced')).toBeTruthy()
    // Blocked requests are explained, and the first one is open in the inspector.
    const blocked = screen.getByRole('region', { name: 'Blocked requests' })
    expect(blocked.textContent).toContain('/apis/ui/Trolley/Recommendations')
    expect(blocked.textContent).toContain('The site’s own page scripts asked for this.')
    expect(within(details()).getByText(/manifest declares no matching request/)).toBeTruthy()
    expect(within(details()).getByText('Blocked before it left Valet')).toBeTruthy()
  })

  it('narrows to requests or to the blocked ones, and opens a step in the inspector', async () => {
    const user = userEvent.setup()
    renderAt('#/activity/calls/c_8f2e1b', createFakeApi({ now: NOW }))
    await screen.findByRole('heading', { level: 1, name: 'Changed a trolley line' })
    await user.click(screen.getByRole('radio', { name: 'Requests' }))
    expect(within(steps()).getAllByRole('listitem')).toHaveLength(6)
    await user.click(screen.getByRole('button', { name: 'Show blocked only' }))
    expect(within(steps()).getAllByRole('listitem')).toHaveLength(2)
    await user.click(screen.getByRole('radio', { name: 'Timeline' }))
    await user.click(within(steps()).getByRole('button', { name: /Typed the password/ }))
    expect(within(details()).getByRole('heading', { name: 'Typed a login' })).toBeTruthy()
    expect(within(details()).getByRole('list', { name: 'Checked before typing' }).textContent).toContain(
      'form submits to an allowed origin',
    )
    expect(within(details()).getByRole('link', { name: 'login · password' }).getAttribute('href')).toBe(
      '#/secrets/woolworths/login',
    )
    // Every kind of step opens.
    for (const name of [
      /Tool called by/,
      /Checked whether you’re signed in/,
      /Logged in/,
      /goto\(/,
      /Handed the session/,
      /Ran the adapter’s tool code/,
      /GET \/apis\/ui\/Trolley\d/,
      /Output redacted/,
    ]) {
      await user.click(within(steps()).getByRole('button', { name }))
      expect(details().textContent?.length).toBeGreaterThan(0)
    }
    await user.click(within(steps()).getByRole('button', { name: /GET \/apis\/ui\/Trolley\d/ }))
    expect(within(details()).getByText('Allowed, declared as a read')).toBeTruthy()
    const blocked = screen.getByRole('region', { name: 'Blocked requests' })
    await user.click(within(blocked).getAllByRole('button', { name: /Show step at/ })[1] as HTMLElement)
    expect(within(details()).getByText('The site’s own page scripts')).toBeTruthy()
  })

  it('shows only the blocked count when the main process can’t count what was sent', async () => {
    renderAt(
      '#/activity/calls/c_8f2e1b',
      withTrace(createFakeApi({ now: NOW }), (t) => ({
        ...t,
        requests: { sent: null, probes: null, blocked: 2 },
      })),
    )
    expect(await screen.findByText('2 blocked')).toBeTruthy()
    expect(screen.queryByText(/sent \(/)).toBeNull()
  })

  it('says what stopped a blocked call, with the site one click away', async () => {
    renderAt('#/activity/calls/c_1c55e2', createFakeApi({ now: NOW }))
    expect(await screen.findByText('Stopped at Tool code: Blocked by site.')).toBeTruthy()
    expect(within(steps()).getByText('Stopped at Tool code: Blocked by site')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Open Coles' }).getAttribute('href')).toBe('#/sites/coles')
    expect(within(details()).getByText('tool-run / blocked-by-site')).toBeTruthy()
  })

  it('traces a declined call and an ordinary one', async () => {
    renderAt('#/activity/calls/c_3d19e7', createFakeApi({ now: NOW }))
    expect(await screen.findByText('You declined the confirmation')).toBeTruthy()
    expect(screen.getByText('You said no, so nothing was changed.')).toBeTruthy()
    document.body.innerHTML = ''
    renderAt('#/activity/calls/c_7b0c44', createFakeApi({ now: NOW }))
    expect(await screen.findByText('nothing to replace')).toBeTruthy()
  })

  it('offers the waiting action on a call that stopped for you', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderAt('#/activity/calls/c_9a71d0', api)
    expect(await screen.findByText('It stopped to wait for you: Verification check.')).toBeTruthy()
    expect(
      screen.getByText(/No output: the call stopped to wait for you \(Verification check\)/),
    ).toBeTruthy()
    await user.click(await screen.findByRole('button', { name: 'Show login window' }))
    expect(api.fake.calls.some((c) => c.method === 'openLoginWindow')).toBe(true)
  })

  it('words a retry answer, a running call and a failure without a stage', async () => {
    const fake = createFakeApi({ now: NOW })
    renderAt(
      '#/activity/calls/c_7b0c44',
      withSummary(fake, { outcome: 'failed', stage: 'login', errorClass: 'login-in-progress' }),
    )
    expect(await screen.findByText('Valet asked the app to call again.')).toBeTruthy()
    document.body.innerHTML = ''
    renderAt('#/activity/calls/c_7b0c44', withSummary(fake, { outcome: 'running' }))
    expect(await screen.findByText('This call is still running.')).toBeTruthy()
    document.body.innerHTML = ''
    renderAt(
      '#/activity/calls/c_7b0c44',
      withSummary(fake, { outcome: 'failed', stage: null, errorClass: null }),
    )
    expect(await screen.findByText('The call failed.')).toBeTruthy()
    document.body.innerHTML = ''
    renderAt(
      '#/activity/calls/c_7b0c44',
      withSummary(fake, { outcome: 'blocked', stage: null, errorClass: null }),
    )
    expect(await screen.findByText('Woolworths refused the call.')).toBeTruthy()
  })

  it('links the app by its credential, and shows the reported name only as a claim', async () => {
    renderAt(
      '#/activity/calls/c_8f2e1b',
      withClientId(createFakeApi({ now: NOW }), 'local:c_c7d2a1b2c3d4e5f6'),
    )
    const app = await screen.findByRole('link', { name: 'Claude Code' })
    await waitFor(() =>
      expect(screen.getByRole('link', { name: 'Claude Code' }).getAttribute('href')).toBe(
        '#/connections/c_c7d2a1b2c3d4e5f6',
      ),
    )
    expect(app).toBeTruthy()
    document.body.innerHTML = ''
    renderAt('#/activity/calls/c_8f2e1b', withClientId(createFakeApi({ now: NOW }), 'remote:rc1'))
    expect((await screen.findByRole('link', { name: 'A cloud agent' })).getAttribute('href')).toBe(
      '#/connections/rc1',
    )
    expect(screen.getByText('calls itself “Claude Code”')).toBeTruthy()
    document.body.innerHTML = ''
    // No credential on record: the name links to the calls that reported it.
    renderAt('#/activity/calls/c_8f2e1b', createFakeApi({ now: NOW }))
    expect((await screen.findByRole('link', { name: '“Claude Code”' })).getAttribute('href')).toBe(
      '#/activity/calls?client=claude-code',
    )
  })

  it('says so for an unknown call, with the ways on', async () => {
    renderAt('#/activity/calls/c_nope?site=woolworths', createFakeApi({ now: NOW }))
    expect(await screen.findByText(/Valet has no trace for this call/)).toBeTruthy()
    await waitFor(() => expect(screen.getByText(/Traces are deleted after 14 days/)).toBeTruthy())
    expect(screen.getByRole('link', { name: 'All calls' }).getAttribute('href')).toBe(
      '#/activity/calls?site=woolworths',
    )
    expect(screen.getByRole('link', { name: 'Look in the audit log' }).getAttribute('href')).toBe(
      '#/activity/audit?call=c_nope',
    )
  })

  it('says so when the trace can’t be loaded', async () => {
    const fake = createFakeApi({ now: NOW })
    fake.fake.failNext('runs.trace')
    renderAt('#/activity/calls/c_8f2e1b', fake)
    expect(await screen.findByText('Valet couldn’t load this call.')).toBeTruthy()
  })

  it('opens from the list, and the old #/activity/<id> address still lands on it', async () => {
    const user = userEvent.setup()
    renderAt('#/activity/calls', createFakeApi({ now: NOW }))
    await user.click(await screen.findByRole('link', { name: 'Call 8F2E' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Changed a trolley line' })).toBeTruthy()
    document.body.innerHTML = ''
    renderAt('#/activity/c_8f2e1b', createFakeApi({ now: NOW }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Changed a trolley line' })).toBeTruthy()
  })
})
