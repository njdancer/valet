import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TooltipProvider } from '@valet/ui'
import { describe, expect, it, vi } from 'vitest'
import { ControlPanel } from '../src/renderer/control/App'
import { createFakeApi, type FakeApi } from '../src/renderer/dev/fake-api'
import { ApiProvider } from '../src/renderer/lib/api-context'
import { LoginBannerWindow } from '../src/renderer/screens/windows/LoginBannerWindow'
import type { AppEvent, AttentionItem, NeedsUserItem } from '../src/shared/api'

const NOW = Date.parse('2026-11-07T21:48:00+11:00')

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

function renderBanner(api: FakeApi) {
  render(
    <ApiProvider api={api} clock={{ now: () => NOW }}>
      <TooltipProvider>
        <LoginBannerWindow adapterId="woolworths" />
      </TooltipProvider>
    </ApiProvider>,
  )
}

function called(api: FakeApi, method: string): unknown[][] {
  return api.fake.calls.filter((c) => c.method === method).map((c) => [...c.args])
}

/** The fake, with its needs-user item changed by `change`. */
function withHandoff(api: FakeApi, change: (item: NeedsUserItem) => NeedsUserItem): FakeApi {
  const list = api.attention.list
  return {
    ...api,
    attention: {
      ...api.attention,
      list: async () =>
        (await list()).map((item: AttentionItem) => (item.kind === 'needs-user' ? change(item) : item)),
    },
  }
}

describe('the login hand-off banner', () => {
  it('says why, lists what was filled by name only, and who asked', async () => {
    renderAt('#/needs-user/woolworths', createFakeApi({ now: NOW }))
    expect(await screen.findByText('Log in to Woolworths (verification check)')).toBeTruthy()
    expect(screen.getByText(/verification check that Valet won't solve/)).toBeTruthy()
    expect(screen.getByText('login.username')).toBeTruthy()
    expect(screen.getByText('login.password')).toBeTruthy()
    // By name only: the fake's values never reach the page.
    const facts = screen.getByRole('region', { name: 'About this login' })
    expect(facts.textContent).toContain('Valet filled in')
    expect(facts.textContent).toContain('auth.woolworths.com.au')
    expect(facts.textContent).toContain('nothing is marked inside the page')
    expect(facts.textContent).toContain('Can only visit')
    expect(screen.getByTestId('manifest-note').textContent).toBe(
      '“Auth0 showed a challenge after the password page.”',
    )
    // Plain words (D-words): who asked, for what, and that Valet carries on; no needsUser.
    const line = screen.getByText(/get_cart/).parentElement?.textContent ?? ''
    expect(line).toContain('A client calling itself “Claude Code” asked for get_cart')
    expect(line).toContain('Valet carries on')
    expect(line).not.toContain('needsUser')
    const links = Array.from(facts.querySelectorAll('a')).map((a) => a.getAttribute('href'))
    expect(links).toEqual(['#/activity/calls/c_9a71d0'])
  })

  it('counts down to when the login window closes', async () => {
    renderBanner(createFakeApi({ now: NOW }))
    const banner = await screen.findByRole('region', { name: 'Sign in to Woolworths' })
    expect(banner.textContent).toMatch(/until \d/)
    expect(banner.getAttribute('aria-keyshortcuts')).toBeTruthy()
  })

  it('cancels the sign-in, then offers to show the login window again', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderBanner(api)
    await user.click(await screen.findByRole('button', { name: 'Cancel sign-in' }))
    expect(called(api, 'closeLoginWindow')).toEqual([['woolworths']])
    expect(await screen.findByText('The Woolworths login window is closed.')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Show login window' }))
    expect(called(api, 'openLoginWindow')).toEqual([['woolworths']])
  })

  it('hands over when the person is done, and says Valet checked', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderBanner(api)
    await user.click(await screen.findByRole('button', { name: 'I’m done' }))
    expect(called(api, 'finishLogin')).toEqual([['woolworths']])
    expect(await screen.findByText('Logged in to Woolworths.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy()
  })

  it('says the site still shows its login page when the check finds it signed out', async () => {
    const user = userEvent.setup()
    const fake = createFakeApi({ now: NOW })
    renderBanner({ ...fake, finishLogin: async () => undefined })
    await user.click(await screen.findByRole('button', { name: 'I’m done' }))
    expect(await screen.findByText('Woolworths still shows its login page.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Check again' })).toBeTruthy()
  })

  it('says so when the login window can’t be reached', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderBanner(api)
    api.fake.failNext('finishLogin')
    await user.click(await screen.findByRole('button', { name: 'I’m done' }))
    expect(await screen.findByText('Woolworths still shows its login page.')).toBeTruthy()
    api.fake.failNext('closeLoginWindow')
    await user.click(screen.getByRole('button', { name: 'Cancel sign-in' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Couldn’t reach the login window. Try again.')
  })

  it('says the person opened it, and blames no secret, for a window they opened themselves', async () => {
    const api = withHandoff(createFakeApi({ now: NOW }), (item) => ({
      ...item,
      reason: 'login-required',
      startedBy: 'person',
      note: null,
      tool: null,
      client: null,
      callId: null,
      filled: [],
      filledOrigin: null,
    }))
    renderBanner(api)
    expect(await screen.findByText('Sign in to Woolworths in this window.')).toBeTruthy()
    expect(screen.getByText(/nothing was filled in for you/)).toBeTruthy()
    expect(screen.queryByText(/couldn't do it with the secrets you granted/)).toBeNull()
    expect(screen.queryByText('Valet filled in')).toBeNull()
    expect(screen.queryByTestId('manifest-note')).toBeNull()
  })

  it('says when the login window ran out, and Close closes it', async () => {
    const user = userEvent.setup()
    const api = withHandoff(createFakeApi({ now: NOW }), (item) => ({
      ...item,
      closesAt: new Date(NOW - 60_000).toISOString(),
    }))
    renderBanner(api)
    expect(await screen.findByText(/^The login window ran out at/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'I’m done' })).toBeNull()
    const close = vi.spyOn(window, 'close').mockImplementation(() => undefined)
    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(called(api, 'closeLoginWindow')).toEqual([['woolworths']])
    expect(close).toHaveBeenCalled()
    close.mockRestore()
  })

  it('takes the focus back when the login window’s shortcut asks for it', async () => {
    const api = createFakeApi({ now: NOW })
    renderBanner(api)
    const banner = await screen.findByRole('region', { name: 'Sign in to Woolworths' })
    ;(document.activeElement as HTMLElement | null)?.blur()
    act(() => api.fake.emit({ type: 'focus-banner' } as unknown as AppEvent))
    await waitFor(() => expect(document.activeElement).toBe(banner))
  })

  it('says nothing is waiting when there is no hand-off for the site', async () => {
    const fake = createFakeApi({ now: NOW })
    renderBanner({ ...fake, attention: { ...fake.attention, list: async () => [] } })
    expect(await screen.findByText('Nothing is waiting for you here.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy()
  })

  it('says so when the hand-off can’t be loaded', async () => {
    const fake = createFakeApi({ now: NOW })
    renderBanner({
      ...fake,
      attention: { ...fake.attention, list: () => Promise.reject(new Error('/Users/x')) },
    })
    expect(await screen.findByText('Valet couldn’t load the login hand-off.')).toBeTruthy()
    expect(screen.queryByText(/Users/)).toBeNull()
  })
})
