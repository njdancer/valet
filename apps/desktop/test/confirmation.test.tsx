import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ControlPanel } from '../src/renderer/control/App'
import { createFakeApi, type FakeApi, WOOLWORTHS_HASH } from '../src/renderer/dev/fake-api'
import { ApiProvider } from '../src/renderer/lib/api-context'
import { ConfirmationPanel } from '../src/renderer/screens/Confirmation'
import { type AttentionItem, CONFIRM_ARM_MS, type ConfirmationItem } from '../src/shared/api'

const NOW = Date.parse('2026-11-07T21:48:00+11:00')

/** Through the router, as the window opens it: Approve is armed after the real CONFIRM_ARM_MS. */
function renderAt(hash: string, api: FakeApi, now = NOW) {
  window.location.hash = hash
  render(
    <ApiProvider api={api} clock={{ now: () => now }}>
      <ControlPanel />
    </ApiProvider>,
  )
}

/** The panel alone, with a 0 ms arming delay for tests that aren't about the delay. */
function renderPanel(confirmationId: string, api: FakeApi, armDelayMs = 0) {
  render(
    <ApiProvider api={api} clock={{ now: () => NOW }}>
      <ConfirmationPanel confirmationId={confirmationId} armDelayMs={armDelayMs} />
    </ApiProvider>,
  )
}

async function enabled(name: string | RegExp): Promise<HTMLButtonElement> {
  const button = (await screen.findByRole('button', { name })) as HTMLButtonElement
  await waitFor(() => expect(button.disabled).toBe(false))
  return button
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
  input: [{ kind: 'text', text: '{ "window": "sun-8-10" }' }],
  adapterNote: null,
}

/** The fake, with `items` as the attention list instead of its own. */
function withAttention(api: FakeApi, items: AttentionItem[]): FakeApi {
  return { ...api, attention: { list: async () => items } }
}

describe('the confirmation panel', () => {
  it('approves through the API once Approve is armed, from the route the window opens', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderAt('#/confirm/cf_a40f3c', api)
    await user.click(await enabled('Allow'))
    await waitFor(() => expect(answers(api)).toEqual([['cf_a40f3c', true]]))
    expect(await screen.findByText('Approved')).toBeTruthy()
  })

  it('declines through the API', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderPanel('cf_a40f3c', api)
    await user.click(await screen.findByRole('button', { name: 'Decline' }))
    await waitFor(() => expect(answers(api)).toEqual([['cf_a40f3c', false]]))
    expect(await screen.findByText('Declined')).toBeTruthy()
  })

  it('keeps Approve disabled for the arming delay, so a click already on its way can’t land on it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const api = createFakeApi({ now: NOW })
    renderPanel('cf_a40f3c', api, CONFIRM_ARM_MS)
    // findBy* polls on timers, which are fake here; flush the attention load instead.
    await act(() => vi.advanceTimersByTimeAsync(0))
    const allow = screen.getByRole('button', { name: 'Allow' }) as HTMLButtonElement
    expect(allow.disabled).toBe(true)
    // A click in the window's first moments does nothing, even dispatched straight at the button.
    fireEvent.click(allow)
    act(() => vi.advanceTimersByTime(CONFIRM_ARM_MS - 1))
    expect(allow.disabled).toBe(true)
    fireEvent.click(allow)
    expect(answers(api)).toEqual([])

    act(() => vi.advanceTimersByTime(1))
    expect(allow.disabled).toBe(false)
  })

  it('disarms Approve while the window is in the background, and re-arms only after the delay', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const api = createFakeApi({ now: NOW })
    renderPanel('cf_a40f3c', api, CONFIRM_ARM_MS)
    // findBy* polls on timers, which are fake here; flush the attention load instead.
    await act(() => vi.advanceTimersByTimeAsync(0))
    const allow = screen.getByRole('button', { name: 'Allow' }) as HTMLButtonElement
    act(() => vi.advanceTimersByTime(CONFIRM_ARM_MS))
    expect(allow.disabled).toBe(false)

    // The person switches to another app: Approve goes off at once.
    act(() => {
      window.dispatchEvent(new Event('blur'))
    })
    expect(allow.disabled).toBe(true)
    // The window comes back to the front under their cursor: still off for the delay.
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    act(() => vi.advanceTimersByTime(CONFIRM_ARM_MS - 1))
    expect(allow.disabled).toBe(true)
    act(() => vi.advanceTimersByTime(1))
    expect(allow.disabled).toBe(false)

    // Hidden and shown again (another Space, a minimised window) is the same.
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(allow.disabled).toBe(true)
    visibility.mockReturnValue('visible')
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(allow.disabled).toBe(true)
    act(() => vi.advanceTimersByTime(CONFIRM_ARM_MS))
    expect(allow.disabled).toBe(false)
    visibility.mockRestore()
  })

  it('makes Decline the default: it has the focus, so Return declines, and Escape declines too', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderPanel('cf_a40f3c', api)
    const decline = await screen.findByRole('button', { name: 'Decline' })
    expect(document.activeElement).toBe(decline)
    await user.keyboard('{Enter}')
    await waitFor(() => expect(answers(api)).toEqual([['cf_a40f3c', false]]))
  })

  it('declines on Escape, wherever the focus is', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderPanel('cf_a40f3c', api)
    await enabled('Allow')
    ;(document.activeElement as HTMLElement).blur()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(answers(api)).toEqual([['cf_a40f3c', false]]))
    expect(await screen.findByText('Declined')).toBeTruthy()
  })

  it('words the client’s name as a claim, with the transport the runtime saw', async () => {
    const fake = createFakeApi({ now: NOW })
    renderPanel('cf_checkout', withAttention(fake, [CHECKOUT]))
    expect(await screen.findByText('A client calling itself “Claude Code”')).toBeTruthy()
    expect(screen.getByText(/connected over HTTP/)).toBeTruthy()
    expect(screen.queryByText('Claude Code')).toBeNull()
    expect(screen.getByText('Input from the client')).toBeTruthy()
  })

  it('cuts a long or disguised client name, and strips characters that reorder text', async () => {
    const fake = createFakeApi({ now: NOW })
    const name = `\u202Eedoc-edualc\u202C ${'x'.repeat(200)}`
    renderPanel('cf_checkout', withAttention(fake, [{ ...CHECKOUT, client: name }]))
    const claim = await screen.findByText(/^A client calling itself “/)
    expect(claim.textContent).not.toMatch(/[\u202A-\u202E\u2066-\u2069]/)
    expect(claim.textContent).toContain('…')
    expect(claim.textContent?.length).toBeLessThan(80)
  })

  it('shows the adapter’s note as attributed, unverified plain text, never as markup', async () => {
    const fake = createFakeApi({ now: NOW })
    const note = '<img src=x onerror="window.pwned=1"><b>Confirm to refresh your session</b>'
    renderPanel('cf_checkout', withAttention(fake, [{ ...CHECKOUT, adapterNote: note }]))
    const shown = await screen.findByTestId('adapter-note')
    expect(shown.textContent).toBe(note)
    expect(shown.querySelector('img')).toBeNull()
    expect(shown.querySelector('b')).toBeNull()
    expect(screen.getByText('Not verified by Valet')).toBeTruthy()
    // The heading is the app's own wording from structured fields, not the note.
    expect(screen.getByText('Run Place order on Woolworths?')).toBeTruthy()
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
    renderPanel('cf_checkout', withAttention(createFakeApi({ now: NOW }), [CHECKOUT]))
    await screen.findByText('POST /apis/ui/Checkout/PlaceOrder')
    expect(screen.queryByTestId('confirm-requests')).toBeNull()
  })

  it('shows what an irreversible approval unlocks, and uses a destructive button', async () => {
    const user = userEvent.setup()
    const fake = createFakeApi({ now: NOW })
    const api = withAttention(fake, [CHECKOUT])
    renderPanel('cf_checkout', api)
    expect(await screen.findByText('POST /apis/ui/Checkout/PlaceOrder')).toBeTruthy()
    const approve = await enabled('Approve Place order')
    expect(approve.className).toContain('destructive')
    // No biometric glyph: nothing gates approval on Touch ID yet.
    expect(approve.querySelector('.i-touchid')).toBeNull()
    expect(approve.textContent).toBe('Approve Place order')
    expect(screen.getByText(/so only you can approve it/)).toBeTruthy()
    fake.fake.failNext('answerConfirmation')
    await user.click(approve)
    expect((await screen.findByRole('alert')).textContent).toBe('Couldn’t send your answer. Try again.')
  })

  it('can’t be answered once it has timed out', async () => {
    const fake = createFakeApi({ now: NOW })
    renderAt(
      '#/confirm/cf_checkout',
      withAttention(fake, [{ ...CHECKOUT, expiresAt: new Date(NOW - 1000).toISOString() }]),
    )
    expect(await screen.findByText('Timed out')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Decline' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Approve Place order' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
  })

  it('counts down to the timeout', async () => {
    renderAt('#/confirm/cf_a40f3c', createFakeApi({ now: NOW }))
    expect(await screen.findByText('Times out in 1:52')).toBeTruthy()
  })

  it('says so when the confirmation is gone', async () => {
    renderAt('#/confirm/cf_nope', createFakeApi({ now: NOW }))
    expect(await screen.findByText('This confirmation was answered or has timed out.')).toBeTruthy()
  })
})
