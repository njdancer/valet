import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { ControlPanel } from '../src/renderer/control/App'
import { createFakeApi, type FakeApi, WOOLWORTHS_HASH } from '../src/renderer/dev/fake-api'
import { ApiProvider } from '../src/renderer/lib/api-context'
import type { AttentionItem, ConfirmationItem } from '../src/shared/api'

const NOW = Date.parse('2026-11-07T21:48:00+11:00')

function renderAt(hash: string, api: FakeApi, now = NOW) {
  window.location.hash = hash
  render(
    <ApiProvider api={api} clock={{ now: () => now }}>
      <ControlPanel />
    </ApiProvider>,
  )
}

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
  callId: 'c_77aa01',
  requestedAt: '2026-11-07T10:47:50Z',
  expiresAt: new Date(NOW + 120_000).toISOString(),
  requestCeiling: 6,
  unlocks: [{ method: 'POST', path: '/apis/ui/Checkout/PlaceOrder', purpose: 'irreversible' }],
  input: [{ kind: 'text', text: '{ "window": "sun-8-10" }' }],
  adapterNote: null,
}

/** The fake, with `items` as the attention list instead of its own. */
function withAttention(api: FakeApi, items: AttentionItem[]): FakeApi {
  return { ...api, attention: { list: async () => items } }
}

describe('the confirmation panel', () => {
  it('approves through the API', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderAt('#/confirm/cf_a40f3c', api)
    await user.click(await screen.findByRole('button', { name: 'Allow' }))
    await waitFor(() => expect(answers(api)).toEqual([['cf_a40f3c', true]]))
    expect(await screen.findByText('Approved')).toBeTruthy()
  })

  it('declines through the API', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderAt('#/confirm/cf_a40f3c', api)
    await user.click(await screen.findByRole('button', { name: 'Decline' }))
    await waitFor(() => expect(answers(api)).toEqual([['cf_a40f3c', false]]))
    expect(await screen.findByText('Declined')).toBeTruthy()
  })

  it('shows the adapter’s note as attributed, unverified plain text, never as markup', async () => {
    const fake = createFakeApi({ now: NOW })
    const note = '<img src=x onerror="window.pwned=1"><b>Confirm to refresh your session</b>'
    renderAt('#/confirm/cf_checkout', withAttention(fake, [{ ...CHECKOUT, adapterNote: note }]))
    const shown = await screen.findByTestId('adapter-note')
    expect(shown.textContent).toBe(note)
    expect(shown.querySelector('img')).toBeNull()
    expect(shown.querySelector('b')).toBeNull()
    expect(screen.getByText('Not verified by siteadapter')).toBeTruthy()
    // The heading is the app's own wording from structured fields, not the note.
    expect(screen.getByText('Run Place order on Woolworths?')).toBeTruthy()
  })

  it('shows what an irreversible approval unlocks, and uses a destructive button', async () => {
    const user = userEvent.setup()
    const fake = createFakeApi({ now: NOW })
    const api = withAttention(fake, [CHECKOUT])
    renderAt('#/confirm/cf_checkout', api)
    expect(await screen.findByText('POST /apis/ui/Checkout/PlaceOrder')).toBeTruthy()
    const approve = screen.getByRole('button', { name: 'Approve Place order' })
    expect(approve.className).toContain('destructive')
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
