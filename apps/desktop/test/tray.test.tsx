import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TooltipProvider } from '@valet/ui'
import { describe, expect, it } from 'vitest'
import { createFakeApi, type FakeApi } from '../src/renderer/dev/fake-api'
import { ApiProvider } from '../src/renderer/lib/api-context'
import { failedToday, subLine, TrayPopover } from '../src/renderer/tray/TrayPopover'
import type { AttentionItem, ValetApi } from '../src/shared/api'

const NOW = Date.parse('2026-11-07T21:48:00+11:00')

function renderTray(api: ValetApi) {
  render(
    <ApiProvider api={api} clock={{ now: () => NOW }}>
      <TooltipProvider>
        <TrayPopover />
      </TooltipProvider>
    </ApiProvider>,
  )
}

function called(api: FakeApi, method: string): unknown[][] {
  return api.fake.calls.filter((c) => c.method === method).map((c) => [...c.args])
}

async function needsYou(): Promise<HTMLElement> {
  const section = (await screen.findByText('Needs you')).closest('section')
  if (section === null) throw new Error('no Needs you section')
  await waitFor(() => expect(within(section).getAllByRole('link').length).toBeGreaterThan(0))
  return section
}

/**
 * The fake's story before the newer item kinds: a confirmation, a login and a review. The newer
 * kinds have their own tests in Needs you; these pin the tray's order and its three-row cap.
 */
function classicFake() {
  const fake = createFakeApi({ now: NOW })
  return {
    ...fake,
    attention: {
      ...fake.attention,
      list: async () =>
        (await fake.attention.list()).filter((i) => ['confirmation', 'needs-user', 'review'].includes(i.kind)),
    },
  }
}

describe('the menu bar popover', () => {
  it('says what Valet is doing, with Pause beside it', async () => {
    renderTray(classicFake())
    expect(await screen.findByRole('dialog', { name: 'Valet' })).toBeTruthy()
    expect(await screen.findByText(/^3 waiting · next ends /)).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /Pause Valet/ }).length).toBeGreaterThan(0)
  })

  it('lists what needs you in the window’s order, with the same titles, confirmations first', async () => {
    renderTray(classicFake())
    const section = await needsYou()
    const rows = within(section).getAllByRole('link')
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('Confirm: Remove from cart (Woolworths)'),
      expect.stringContaining('Log in to Woolworths (verification check)'),
      expect.stringContaining('Review the Woolworths update (0.4.0)'),
    ])
    // The client's name is only a claim, and the row says so.
    expect(rows[0]?.textContent).toContain('a client calling itself “Claude Code”')
    expect(rows[0]?.textContent).toContain('Answer')
    expect(rows[1]?.textContent).toContain('Show login window')
    expect(rows[2]?.textContent).toContain('Review update')
  })

  it('opens each item where it is answered: the confirmation’s own window, the login, the review', async () => {
    const user = userEvent.setup()
    const api = classicFake()
    renderTray(api)
    const rows = within(await needsYou()).getAllByRole('link')
    for (const row of rows) await user.click(row)
    // Answer brings the confirmation's own panel forward: only it can approve.
    expect(called(api, 'openConfirmation')).toEqual([['cf_a40f3c']])
    expect(called(api, 'openLoginWindow')).toEqual([['woolworths']])
    expect(called(api, 'app.openControlPanel')).toEqual([['#/sites/woolworths/versions/review']])
    // The popover's own address never changes: links open in Valet, not here.
    expect(window.location.hash).toBe('')
  })

  it('starts with the focus on the first waiting item, and arrow keys move between rows', async () => {
    const user = userEvent.setup()
    renderTray(classicFake())
    const rows = within(await needsYou()).getAllByRole('link')
    await waitFor(() => expect(document.activeElement).toBe(rows[0]))
    await user.keyboard('{ArrowDown}')
    expect(document.activeElement).toBe(rows[1])
    await user.keyboard('{ArrowUp}{ArrowUp}')
    expect(document.activeElement).toBe(rows[0])
  })

  it('shows three rows and names the rest as one link to Needs you', async () => {
    const fake = classicFake()
    const items = await fake.attention.list()
    const extra: AttentionItem[] = [
      {
        kind: 'review',
        id: 'rv_b',
        adapterId: 'coles',
        adapterName: 'Coles',
        version: '0.2.0',
        addsPermissions: false,
      },
    ]
    const api = { ...fake, attention: { ...fake.attention, list: async () => [...items, ...extra] } }
    renderTray(api)
    const more = await screen.findByRole('link', { name: /\+1 more:/ })
    expect(more.textContent).toContain('Review the Coles update (0.2.0)')
    const user = userEvent.setup()
    await user.click(more)
    expect(called(fake, 'app.openControlPanel')).toEqual([['#/needs-you']])
  })

  it('has one row per site with its health line, each opening the site', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderTray(api)
    const site = await screen.findByRole('link', { name: /^Woolworths.*Waiting for you to log in/ })
    expect(
      screen.getByRole('link', { name: /^Coles.*Coles is limiting requests · calls resume at/ }),
    ).toBeTruthy()
    await user.click(site)
    expect(called(api, 'app.openControlPanel')).toEqual([['#/sites/woolworths']])
  })

  it('makes today’s numbers links to the calls behind them', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderTray(api)
    await user.click(await screen.findByRole('link', { name: '37 calls' }))
    await user.click(screen.getByRole('link', { name: /failed$/ }))
    await user.click(screen.getByRole('link', { name: '12 requests blocked' }))
    expect(called(api, 'app.openControlPanel')).toEqual([
      ['#/activity/calls'],
      ['#/activity/calls?outcome=failed'],
      ['#/activity/audit?category=blocked'],
    ])
  })

  it('runs the menu: trolley, Open Valet, Pause and Resume, Quit', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderTray(api)
    // D-checkout: Valet never places the order; the person checks out on the site.
    await user.click(await screen.findByRole('button', { name: 'Open my trolley on woolworths.com.au…' }))
    expect(screen.queryByRole('button', { name: /trolley on coles/ })).toBeNull()
    await user.click(screen.getByRole('button', { name: /^Open Valet/ }))
    await user.click(screen.getAllByRole('button', { name: /^Pause Valet/ })[0] as HTMLElement)
    expect(await screen.findByText('Paused · calls are refused')).toBeTruthy()
    expect(screen.getByText('Valet is paused.')).toBeTruthy()
    expect(screen.getAllByText('Paused with Valet').length).toBe(2)
    // Resume is the primary button while paused, and takes the focus.
    const resume = screen.getAllByRole('button', { name: /^Resume Valet/ })[0] as HTMLElement
    await waitFor(() => expect(document.activeElement).toBe(resume))
    await user.click(resume)
    await user.click(screen.getByRole('button', { name: /^Quit Valet/ }))
    expect(called(api, 'adapters.openCart')).toEqual([['woolworths']])
    expect(called(api, 'app.openControlPanel')).toEqual([[undefined]])
    expect(called(api, 'app.setPaused')).toEqual([[true], [false]])
    expect(called(api, 'app.quit')).toEqual([[]])
  })

  it('answers its shortcuts: mod+O opens Valet, mod+shift+P pauses', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderTray(api)
    await needsYou()
    await user.keyboard('{Control>}o{/Control}')
    await user.keyboard('{Control>}{Shift>}p{/Shift}{/Control}')
    expect(called(api, 'app.openControlPanel')).toEqual([[undefined]])
    expect(called(api, 'app.setPaused')).toEqual([[true]])
  })

  it('says nothing needs you, and offers the notification settings', async () => {
    const user = userEvent.setup()
    const fake = createFakeApi({ now: NOW })
    renderTray({ ...fake, attention: { ...fake.attention, list: async () => [] } })
    expect(await screen.findByText('Nothing needs you')).toBeTruthy()
    expect(await screen.findByText(/^Ready · 2 apps connected/)).toBeTruthy()
    await user.click(screen.getByRole('link', { name: 'Notifications…' }))
    expect(called(fake, 'app.openControlPanel')).toEqual([['#/settings/notifications']])
  })

  it('on a first run, offers to finish setup and keeps Pause away until a site is approved', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW, firstRun: true })
    renderTray(api)
    const row = await screen.findByRole('link', { name: /^Finish setup \(5 steps left\)/ })
    expect(screen.getByText(/Not set up yet/)).toBeTruthy()
    expect(screen.getByText('Valet never pays.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Pause Valet/ })).toBeNull()
    expect(screen.getByRole('link', { name: /^Review Woolworths before first use/ }).textContent).toContain(
      'Its tools are off until you review it',
    )
    await user.click(row)
    expect(called(api, 'app.openControlPanel')).toEqual([['#/setup']])
  })

  it('offers Lock down when the main process has it, and Unlock once locked', async () => {
    const user = userEvent.setup()
    const fake = createFakeApi({ now: NOW })
    let locked = false
    const set: boolean[] = []
    const api: ValetApi = {
      ...fake,
      app: {
        ...fake.app,
        status: async () => ({ ...(await fake.app.status()), lockedDown: locked }),
        setLockedDown: async (on: boolean) => {
          set.push(on)
          locked = on
          fake.fake.emit({ type: 'app-changed' })
        },
      } as ValetApi['app'],
    }
    renderTray(api)
    await user.click(await screen.findByRole('button', { name: /^Lock down…/ }))
    await user.click(await screen.findByRole('button', { name: 'Lock down' }))
    expect(set).toEqual([true])
    expect(await screen.findByText('Locked down · every call is refused')).toBeTruthy()
    expect(screen.getAllByText('Stopped by Lock down').length).toBe(2)
    await user.click(screen.getAllByRole('button', { name: /^Unlock/ })[0] as HTMLElement)
    expect(set).toEqual([true, false])
  })

  it('shows a failed action without its message', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderTray(api)
    api.fake.failNext('app.quit')
    await user.click(await screen.findByRole('button', { name: /^Quit Valet/ }))
    expect((await screen.findByRole('alert')).textContent).toBe('Couldn’t do that. Try again.')
  })

  it('says so when a link couldn’t be opened', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderTray(api)
    api.fake.failNext('openConfirmation')
    const rows = within(await needsYou()).getAllByRole('link')
    await user.click(rows[0] as HTMLElement)
    expect((await screen.findByRole('alert')).textContent).toBe('Couldn’t do that. Try again.')
  })

  it('says when what’s waiting can’t be loaded, and when the endpoint is off', async () => {
    const fake = createFakeApi({ now: NOW })
    await fake.endpoint.setListening(false)
    renderTray({ ...fake, attention: { ...fake.attention, list: () => Promise.reject(new Error('x')) } })
    expect(await screen.findByText(/Valet couldn’t load what’s waiting/)).toBeTruthy()
    expect(await screen.findByText('Endpoint off · apps can’t reach Valet')).toBeTruthy()
  })
})

describe('the popover’s wording', () => {
  it('counts only today’s failed calls', () => {
    const today = new Date(NOW).toISOString()
    const yesterday = new Date(NOW - 26 * 3600_000).toISOString()
    expect(
      failedToday(
        [
          { outcome: 'failed', startedAt: today },
          { outcome: 'ok', startedAt: today },
          { outcome: 'failed', startedAt: yesterday },
        ],
        NOW,
      ),
    ).toBe(1)
  })

  it('words a login item whose window is closed, and falls back to the description', () => {
    const view = {
      id: 'x',
      kind: 'needs-user' as const,
      title: 't',
      description: 'd',
      adapterId: null,
      adapterName: null,
      callId: null,
      deadline: null,
      at: 0,
      actionLabel: 'a',
      action: { kind: 'route' as const, to: '#/needs-you' as const },
      tone: 'accent' as const,
      missed: false,
    }
    expect(subLine(view, [])).toBe('d')
    const item: AttentionItem = {
      kind: 'needs-user',
      id: 'x',
      adapterId: 'w',
      adapterName: 'W',
      reason: 'captcha',
      note: null,
      startedBy: 'person',
      tool: null,
      client: null,
      callId: null,
      at: new Date(NOW).toISOString(),
      filled: [],
      filledOrigin: null,
      navigation: [],
      windowOpen: false,
      closesAt: null,
    }
    expect(subLine(view, [item])).toBe('Login window is closed')
    act(() => undefined)
  })
})
