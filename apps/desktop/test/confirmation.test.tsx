import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TooltipProvider } from '@valet/ui'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ControlPanel } from '../src/renderer/control/App'
import { createFakeApi, type FakeApi, WOOLWORTHS_HASH } from '../src/renderer/dev/fake-api'
import { ApiProvider } from '../src/renderer/lib/api-context'
import { ConfirmationWindow } from '../src/renderer/screens/windows/ConfirmationWindow'
import { type AttentionItem, CONFIRM_ARM_MS, type ConfirmationItem } from '../src/shared/api'

const NOW = Date.parse('2026-11-07T21:48:00+11:00')

function wrap(api: FakeApi, now: number, children: ReactNode) {
  return (
    <ApiProvider api={api} clock={{ now: () => now }}>
      <TooltipProvider>{children}</TooltipProvider>
    </ApiProvider>
  )
}

/** Through the router, as the window opens it: Allow is armed after the real CONFIRM_ARM_MS. */
function renderAt(hash: string, api: FakeApi, now = NOW) {
  window.location.hash = hash
  render(wrap(api, now, <ControlPanel />))
}

/** The window alone, with a 0 ms arming delay for tests that aren't about the delay. */
function renderWindow(confirmationId: string, api: FakeApi, armDelayMs = 0) {
  render(wrap(api, NOW, <ConfirmationWindow confirmationId={confirmationId} armDelayMs={armDelayMs} />))
}

/** Off: the button explains why, so it is aria-disabled rather than disabled. */
function isOff(button: HTMLElement): boolean {
  return button.getAttribute('aria-disabled') === 'true' || (button as HTMLButtonElement).disabled
}

/** Allow once armed: the routed window uses the real CONFIRM_ARM_MS. Re-queried, since the button
 * loses its reason tooltip (and so its wrapper) when it arms. */
async function armed(name: string | RegExp): Promise<HTMLButtonElement> {
  await screen.findByRole('button', { name })
  await waitFor(() => expect(isOff(screen.getByRole('button', { name }))).toBe(false), { timeout: 3000 })
  return screen.getByRole('button', { name }) as HTMLButtonElement
}

afterEach(() => {
  vi.useRealTimers()
})

function answers(api: FakeApi) {
  return api.fake.calls.filter((c) => c.method === 'answerConfirmation').map((c) => c.args)
}

/** An irreversible checkout, as the runtime would describe it. */
const CHECKOUT: ConfirmationItem = {
  kind: 'confirmation',
  id: 'cf_checkout',
  adapterId: 'woolworths',
  adapterName: 'Woolworths',
  adapterVersion: '0.3.0',
  adapterHash: WOOLWORTHS_HASH,
  approvedAt: '2026-11-02T09:01:58Z',
  tool: 'checkout',
  toolTitle: 'Place order',
  sideEffect: 'irreversible',
  trigger: 'irreversible-tool',
  client: 'claude-code',
  clientTransport: 'http',
  callId: 'c_77aa01',
  requestedAt: '2026-11-07T10:47:50Z',
  expiresAt: new Date(NOW + 120_000).toISOString(),
  requestCeiling: 6,
  unlocks: [{ method: 'POST', path: '/apis/ui/Checkout/PlaceOrder', purpose: 'irreversible' }],
  requests: [],
  input: [
    { kind: 'text', text: '{ "window": "sun-8-10", "card": ' },
    { kind: 'redacted', label: 'secret', ref: 'card' },
    { kind: 'text', text: ' }' },
  ],
  adapterNote: null,
}

/** The fake, with `items` as the attention list instead of its own. */
function withAttention(api: FakeApi, items: AttentionItem[] | (() => AttentionItem[])): FakeApi {
  const list = typeof items === 'function' ? items : () => items
  return { ...api, attention: { ...api.attention, list: async () => list() } }
}

describe('the confirmation window', () => {
  it('allows through the API once Allow is armed, from the route the window opens', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderAt('#/confirm/cf_a40f3c', api)
    expect(
      await screen.findByRole('heading', { name: 'Confirm: Remove from cart (Woolworths)' }),
    ).toBeTruthy()
    await user.click(await armed('Remove from cart'))
    await waitFor(() => expect(answers(api)).toEqual([['cf_a40f3c', true]]))
    expect(await screen.findByText(/^You chose Remove from cart at/)).toBeTruthy()
  })

  it('declines through the API, and says nothing was done', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderWindow('cf_a40f3c', api)
    await user.click(await screen.findByRole('button', { name: 'Decline' }))
    await waitFor(() => expect(answers(api)).toEqual([['cf_a40f3c', false]]))
    expect(await screen.findByText('Nothing was done.')).toBeTruthy()
    expect(screen.getByText(/^You chose Decline at/)).toBeTruthy()
    // Answered: no more buttons that answer, only Close.
    expect(screen.queryByRole('button', { name: 'Decline' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy()
  })

  it('keeps Allow off for the arming delay, so a click already on its way can’t land on it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const api = createFakeApi({ now: NOW })
    renderWindow('cf_a40f3c', api, CONFIRM_ARM_MS)
    // findBy* polls on timers, which are fake here; flush the attention load instead.
    await act(() => vi.advanceTimersByTimeAsync(0))
    const allow = screen.getByRole('button', { name: 'Remove from cart' })
    expect(isOff(allow)).toBe(true)
    expect(screen.getByText(/Ready in a moment, so a key press meant for another app/)).toBeTruthy()
    // A click in the window's first moments does nothing, even dispatched straight at the button.
    fireEvent.click(allow)
    act(() => vi.advanceTimersByTime(CONFIRM_ARM_MS - 1))
    expect(isOff(allow)).toBe(true)
    fireEvent.click(allow)
    expect(answers(api)).toEqual([])

    act(() => vi.advanceTimersByTime(1))
    expect(isOff(screen.getByRole('button', { name: 'Remove from cart' }))).toBe(false)
  })

  it('disarms Allow while the window is in the background, and re-arms only after the delay', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const api = createFakeApi({ now: NOW })
    renderWindow('cf_a40f3c', api, CONFIRM_ARM_MS)
    await act(() => vi.advanceTimersByTimeAsync(0))
    const allow = () => screen.getByRole('button', { name: 'Remove from cart' })
    act(() => vi.advanceTimersByTime(CONFIRM_ARM_MS))
    expect(isOff(allow())).toBe(false)

    // The person switches to another app: Allow goes off at once.
    act(() => {
      window.dispatchEvent(new Event('blur'))
    })
    expect(isOff(allow())).toBe(true)
    // The window comes back to the front under their cursor: still off for the delay.
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    act(() => vi.advanceTimersByTime(CONFIRM_ARM_MS - 1))
    expect(isOff(allow())).toBe(true)
    act(() => vi.advanceTimersByTime(1))
    expect(isOff(allow())).toBe(false)

    // Hidden and shown again (another Space, a minimised window) is the same.
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(isOff(allow())).toBe(true)
    visibility.mockReturnValue('visible')
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(isOff(allow())).toBe(true)
    act(() => vi.advanceTimersByTime(CONFIRM_ARM_MS))
    expect(isOff(allow())).toBe(false)
    visibility.mockRestore()
  })

  it('makes Decline the default: it has the focus, so Return declines', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderWindow('cf_a40f3c', api)
    const decline = await screen.findByRole('button', { name: 'Decline' })
    await waitFor(() => expect(document.activeElement).toBe(decline))
    await user.keyboard('{Enter}')
    await waitFor(() => expect(answers(api)).toEqual([['cf_a40f3c', false]]))
  })

  it('declines on Escape, wherever the focus is', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderWindow('cf_a40f3c', api)
    await armed('Remove from cart')
    ;(document.activeElement as HTMLElement).blur()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(answers(api)).toEqual([['cf_a40f3c', false]]))
    expect(await screen.findByText('Nothing was done.')).toBeTruthy()
  })

  it('declines on Escape inside the panel only once', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderWindow('cf_a40f3c', api)
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Decline' })))
    await user.keyboard('{Escape}')
    await screen.findByText('Nothing was done.')
    expect(answers(api)).toEqual([['cf_a40f3c', false]])
  })

  it('words the client’s name as a claim, with the transport the runtime saw', async () => {
    const fake = createFakeApi({ now: NOW })
    renderWindow('cf_checkout', withAttention(fake, [CHECKOUT]))
    expect((await screen.findAllByText('A client calling itself “Claude Code”')).length).toBeGreaterThan(0)
    expect(screen.getByText(/connected over HTTP/)).toBeTruthy()
    expect(screen.queryByText('Claude Code')).toBeNull()
    expect(screen.getByText('Input from the client')).toBeTruthy()
  })

  it('cuts a long or disguised client name, and strips characters that reorder text', async () => {
    const fake = createFakeApi({ now: NOW })
    const name = `‮edoc-edualc‬ ${'x'.repeat(200)}`
    renderWindow('cf_checkout', withAttention(fake, [{ ...CHECKOUT, client: name }]))
    const [claim] = await screen.findAllByText(/^A client calling itself “/)
    expect(claim?.textContent).not.toMatch(/[‪-‮⁦-⁩]/)
    expect(claim?.textContent).toContain('…')
    expect(claim?.textContent?.length).toBeLessThan(80)
  })

  it('shows the input with its secrets redacted, never their values', async () => {
    const fake = createFakeApi({ now: NOW })
    renderWindow('cf_checkout', withAttention(fake, [CHECKOUT]))
    const preview = await screen.findByTitle('Input from the client')
    expect(preview.textContent).toContain('"window": "sun-8-10"')
    expect(preview.textContent).toContain('secret: card')
  })

  it('shows the adapter’s note under “From the site” as unverified plain text, never as markup', async () => {
    const fake = createFakeApi({ now: NOW })
    const note = '<img src=x onerror="window.pwned=1"><b>Confirm to refresh your session</b>'
    renderWindow('cf_checkout', withAttention(fake, [{ ...CHECKOUT, adapterNote: note }]))
    const shown = await screen.findByTestId('adapter-note')
    expect(shown.textContent).toBe(note)
    expect(shown.querySelector('img')).toBeNull()
    expect(shown.querySelector('b')).toBeNull()
    expect(screen.getByText('From the site')).toBeTruthy()
    expect(screen.getByText('Not verified by Valet')).toBeTruthy()
    // The heading is the app's own wording from structured fields, not the note.
    expect(screen.getByRole('heading', { name: 'Confirm: Place order (Woolworths)' })).toBeTruthy()
  })

  it('cuts a very long adapter note', async () => {
    const fake = createFakeApi({ now: NOW })
    renderWindow('cf_checkout', withAttention(fake, [{ ...CHECKOUT, adapterNote: 'y'.repeat(2000) }]))
    const shown = await screen.findByTestId('adapter-note')
    expect(shown.textContent?.length).toBeLessThanOrEqual(601)
  })

  it('lists the declared requests a tool request names, as Valet checked them, and unlocks nothing', async () => {
    renderAt('#/confirm/cf_a40f3c', createFakeApi({ now: NOW }))
    const listed = await screen.findByTestId('confirm-requests')
    expect(listed.textContent).toContain('POST /api/v3/ui/trolley/update')
    expect(listed.textContent).toContain('declared in the manifest')
    expect(screen.getByText('Approving unlocks no irreversible request')).toBeTruthy()
    expect(screen.getByTestId('adapter-note').textContent).toContain('Cavendish Bananas')
  })

  it('shows no request list for an irreversible tool', async () => {
    renderWindow('cf_checkout', withAttention(createFakeApi({ now: NOW }), [CHECKOUT]))
    await screen.findByText('POST /apis/ui/Checkout/PlaceOrder')
    expect(screen.queryByTestId('confirm-requests')).toBeNull()
  })

  it('shows what an irreversible approval unlocks, uses a danger button, and reports a failed answer', async () => {
    const user = userEvent.setup()
    const fake = createFakeApi({ now: NOW })
    renderWindow('cf_checkout', withAttention(fake, [CHECKOUT]))
    expect(await screen.findByText('POST /apis/ui/Checkout/PlaceOrder')).toBeTruthy()
    const approve = await armed('Approve Place order')
    expect(approve.className).toContain('bg-danger-solid')
    expect(approve.textContent).toBe('Approve Place order')
    expect(screen.getByText('This can’t be undone.', { exact: false })).toBeTruthy()
    expect(screen.getByText(/so only you can approve it/)).toBeTruthy()
    fake.fake.failNext('answerConfirmation')
    await user.click(approve)
    expect((await screen.findByRole('alert')).textContent).toBe('Couldn’t send your answer. Try again.')
    // Still unanswered, so it can be tried again.
    expect(screen.getByRole('button', { name: 'Approve Place order' })).toBeTruthy()
  })

  it('can’t be answered once it has timed out, and says it was missed', async () => {
    const user = userEvent.setup()
    const fake = createFakeApi({ now: NOW })
    const copy = vi.spyOn(fake.app, 'copyText')
    renderAt(
      '#/confirm/cf_checkout',
      withAttention(fake, [{ ...CHECKOUT, expiresAt: new Date(NOW - 1000).toISOString() }]),
    )
    expect(
      await screen.findByRole('heading', { name: 'Missed: Confirm: Place order (Woolworths)' }),
    ).toBeTruthy()
    expect(screen.getByText(/^Nobody answered by/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Decline' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Approve Place order' })).toBeNull()
    // Escape now closes the window, and answers nothing.
    const close = vi.spyOn(window, 'close').mockImplementation(() => undefined)
    await user.keyboard('{Escape}')
    expect(answers(fake)).toEqual([])
    expect(close).toHaveBeenCalled()
    close.mockRestore()
    expect(screen.getByRole('link', { name: /^Open call/ }).getAttribute('href')).toBe(
      '#/activity/calls/c_77aa01',
    )
    await user.click(screen.getByRole('button', { name: 'Copy “try again” for Claude' }))
    expect(copy).toHaveBeenCalledWith(expect.stringContaining('Please try again'))
  })

  it('counts down to the timeout', async () => {
    renderAt('#/confirm/cf_a40f3c', createFakeApi({ now: NOW }))
    expect(await screen.findByText(/^1 min 52 s · until /)).toBeTruthy()
    expect(screen.getByText(/If nobody answers by/)).toBeTruthy()
  })

  it('says where it sits in the queue', async () => {
    const fake = createFakeApi({ now: NOW })
    const second = { ...CHECKOUT, id: 'cf_two', requestedAt: new Date(NOW).toISOString() }
    renderWindow('cf_checkout', withAttention(fake, [CHECKOUT, second]))
    expect(await screen.findByText(/of 2 waiting/)).toBeTruthy()
  })

  it('says so when the confirmation is gone', async () => {
    renderAt('#/confirm/cf_nope', createFakeApi({ now: NOW }))
    expect(await screen.findByText('This confirmation was answered or has timed out.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy()
  })

  it('says it was answered somewhere else when it leaves the list without an answer from here', async () => {
    const fake = createFakeApi({ now: NOW })
    let items: AttentionItem[] = [CHECKOUT]
    renderWindow(
      'cf_checkout',
      withAttention(fake, () => items),
    )
    await screen.findByRole('heading', { name: 'Confirm: Place order (Woolworths)' })
    items = []
    act(() => fake.fake.emit({ type: 'attention-changed' }))
    expect(await screen.findByText(/^Answered somewhere else at/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Approve Place order' })).toBeNull()
    expect(answers(fake)).toEqual([])
  })

  it('says so when an allowed call then fails on the site', async () => {
    const user = userEvent.setup()
    const fake = createFakeApi({ now: NOW })
    const api: FakeApi = {
      ...withAttention(fake, [CHECKOUT]),
      answerConfirmation: async () => undefined,
      runs: {
        ...fake.runs,
        trace: async () =>
          ({ summary: { outcome: 'failed' } }) as unknown as Awaited<ReturnType<FakeApi['runs']['trace']>>,
      },
    }
    renderWindow('cf_checkout', api)
    await user.click(await armed('Approve Place order'))
    expect(await screen.findByText('It didn’t work.')).toBeTruthy()
    expect(screen.getByText(/Failed · see call/)).toBeTruthy()
    expect(screen.getByText('Nothing else is waiting for you.')).toBeTruthy()
  })

  it('says it is done when an allowed call succeeds', async () => {
    const user = userEvent.setup()
    const fake = createFakeApi({ now: NOW })
    const api: FakeApi = {
      ...withAttention(fake, [CHECKOUT]),
      answerConfirmation: async () => undefined,
      runs: {
        ...fake.runs,
        trace: async () =>
          ({ summary: { outcome: 'ok' } }) as unknown as Awaited<ReturnType<FakeApi['runs']['trace']>>,
      },
    }
    renderWindow('cf_checkout', api)
    await user.click(await armed('Approve Place order'))
    expect(await screen.findByText('Done.')).toBeTruthy()
  })
})
