import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { createFakeApi, type FakeApi } from '../src/renderer/dev/fake-api'
import { ApiProvider } from '../src/renderer/lib/api-context'
import { TrayPopover } from '../src/renderer/tray/TrayPopover'

const NOW = Date.parse('2026-11-07T21:48:00+11:00')

function renderTray(api: FakeApi) {
  render(
    <ApiProvider api={api} clock={{ now: () => NOW }}>
      <TrayPopover />
    </ApiProvider>,
  )
}

function called(api: FakeApi, method: string): unknown[][] {
  return api.fake.calls.filter((c) => c.method === method).map((c) => [...c.args])
}

describe('the tray popover', () => {
  it('shows status, today’s numbers, what needs you and each adapter', async () => {
    renderTray(createFakeApi({ now: NOW }))
    expect(await screen.findByText('Running · 2 clients connected')).toBeTruthy()
    expect(screen.getByText('http://127.0.0.1:47821/mcp')).toBeTruthy()
    expect(await screen.findByText('Tool calls today')).toBeTruthy()
    expect(screen.getByText('Log in to Woolworths')).toBeTruthy()
    expect(screen.getByText('Verification check · get_cart · Claude Code')).toBeTruthy()
    expect(screen.getByText('Confirm Remove from cart · Woolworths')).toBeTruthy()
    expect(screen.getByText('Review Woolworths 0.4.0')).toBeTruthy()
    expect(screen.getByText('Login window open')).toBeTruthy()
    expect(screen.getByText('Blocked by site · retry in 4 min')).toBeTruthy()
  })

  it('routes each attention item to the right place', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderTray(api)
    await user.click(await screen.findByRole('button', { name: 'Open' }))
    await user.click(screen.getByRole('button', { name: 'Answer' }))
    await user.click(screen.getByRole('button', { name: 'Review' }))
    expect(called(api, 'openLoginWindow')).toEqual([['woolworths']])
    expect(called(api, 'app.openControlPanel')).toEqual([
      ['#/confirm/cf_a40f3c'],
      ['#/adapters/woolworths/review'],
    ])
  })

  it('runs the menu: control panel, activity, pause, quit, copy', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderTray(api)
    await user.click(await screen.findByRole('button', { name: /Open Control Panel/ }))
    await user.click(screen.getByRole('button', { name: /Activity…/ }))
    await user.click(screen.getByRole('button', { name: /Pause all adapters/ }))
    expect(await screen.findByText('Paused · calls are refused')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: /Resume adapters/ }))
    await user.click(screen.getByRole('button', { name: /Quit siteadapter/ }))
    await user.click(screen.getByRole('button', { name: 'Copy endpoint address' }))
    expect(called(api, 'app.openControlPanel')).toEqual([[undefined], ['#/activity']])
    expect(called(api, 'app.setPaused')).toEqual([[true], [false]])
    expect(called(api, 'app.quit')).toEqual([[]])
    expect(called(api, 'endpoint.copyUrl')).toEqual([[]])
  })

  it('switches the endpoint off', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderTray(api)
    await user.click(await screen.findByRole('switch', { name: 'MCP endpoint on' }))
    expect(await screen.findByText('MCP endpoint off')).toBeTruthy()
    expect(screen.queryByText('http://127.0.0.1:47821/mcp')).toBeNull()
  })

  it('describes adapters that are healthy, expired or not approved', async () => {
    const fake = createFakeApi({ now: NOW })
    const [woolworths, coles] = await fake.adapters.list()
    if (woolworths === undefined || coles === undefined) throw new Error('fixture')
    renderTray({
      ...fake,
      health: { sites: async () => [] },
      attention: { list: async () => [] },
      adapters: {
        ...fake.adapters,
        list: async () => [
          { ...coles, id: 'a', name: 'Alpha', session: { ...coles.session, state: 'logged-in' } },
          { ...coles, id: 'b', name: 'Beta', session: { ...coles.session, state: 'expired' } },
          { ...coles, id: 'c', name: 'Gamma', approval: 'unapproved' },
          {
            ...woolworths,
            id: 'd',
            name: 'Delta',
            session: { ...woolworths.session, state: 'unknown' },
            pendingUpdate: null,
          },
        ],
      },
    })
    expect(await screen.findByText('Healthy · 7:40 pm')).toBeTruthy()
    expect(screen.getByText('Logs in on next call')).toBeTruthy()
    expect(screen.getByText('Not approved')).toBeTruthy()
    expect(screen.getByText('Not checked yet')).toBeTruthy()
    await waitFor(() => expect(screen.queryByText('Needs you')).toBeNull())
  })

  it('shows a failed action without its message', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderTray(api)
    api.fake.failNext('app.quit')
    await user.click(await screen.findByRole('button', { name: /Quit siteadapter/ }))
    expect((await screen.findByRole('alert')).textContent).toBe('Couldn’t do that. Try again.')
  })
})
