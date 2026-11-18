// Settings › Devices, account first (Nick, 2026-11-17; UI review R6, R8, R9, R13): where this Mac
// stands with the Valet account, then the iPhones, then the relay's fields under Advanced.

import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { createFakeApi } from '../src/renderer/dev/fake-api'
import { DevicesSection } from '../src/renderer/screens/settings/DevicesSection'
import type { PhonesStatus } from '../src/shared/api'
import { called, NOW, renderPage } from './connections-helpers'

const LINKED = {
  state: 'linked',
  url: 'https://valet.example',
  accountId: 'acc_1',
  account: 'nick',
  slug: 'nicks-mbp',
  name: 'Nick’s MacBook Pro',
} as const

function withStatus(over: Partial<PhonesStatus>) {
  const fake = createFakeApi({ now: NOW })
  const status: PhonesStatus = {
    available: true,
    unavailableReason: null,
    relay: 'online',
    relayOrigin: 'https://relay.example',
    worksLocked: true,
    hub: LINKED,
    roster: { state: 'on', devices: 2 },
    phones: [],
    pairing: { step: 'idle' },
    ...over,
  }
  return { ...fake, phones: { ...fake.phones, status: async () => status } }
}

describe('Settings › Devices', () => {
  it('puts the account first, with a dot and one plain line, then the iPhones, then Advanced', async () => {
    renderPage(withStatus({}), <DevicesSection />)
    const line = await screen.findByTestId('account-line')
    expect(line.textContent).toBe('connected to nick’s account as nicks-mbp')
    expect(screen.getByText('At valet.example, as Nick’s MacBook Pro.')).toBeTruthy()
    expect(screen.getByText(/Connected to the relay \(relay\.example\)/)).toBeTruthy()
    const text = document.body.textContent ?? ''
    expect(text.indexOf('Valet account')).toBeLessThan(text.indexOf('iPhones'))
    expect(text.indexOf('iPhones')).toBeLessThan(text.indexOf('Advanced'))
    // The relay's fields are tucked away until asked for.
    expect(screen.queryByRole('textbox', { name: 'Relay host name' })).toBeNull()
  })

  it('keeps Try again with the account’s other buttons when Touch ID was cancelled', async () => {
    const user = userEvent.setup()
    const api = withStatus({ roster: { state: 'needs-you', devices: 0 } })
    renderPage(api, <DevicesSection />)
    const retry = await screen.findByRole('button', { name: 'Try again' })
    const row = retry.parentElement as HTMLElement
    expect(within(row).getByRole('button', { name: 'Open the hub' })).toBeTruthy()
    expect(within(row).getByRole('button', { name: 'Leave the account' })).toBeTruthy()
    await user.click(retry)
    expect(called(api, 'phones.retryRoster')).toHaveLength(1)
  })

  it('says it is checking while the relay hasn’t reported the account yet', async () => {
    renderPage(withStatus({ hub: null, roster: { state: 'off', devices: 0 } }), <DevicesSection />)
    expect(await screen.findByText('Checking your Valet account…')).toBeTruthy()
  })

  it('says why the relay is down and holds Show a sign-in code until it’s back', async () => {
    renderPage(withStatus({ relay: 'offline' }), <DevicesSection />)
    expect(
      await screen.findByText(
        'Not connected to the relay (relay.example). Valet keeps trying. Check this Mac is online.',
      ),
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Show a sign-in code' }).getAttribute('aria-disabled')).toBe(
      'true',
    )
    expect(screen.getByTestId('account-line').textContent).toMatch(/not connected to the hub now/)
  })

  it('opens Advanced by itself when no relay is set, and says what to do', async () => {
    const api = withStatus({
      available: false,
      unavailableReason: 'no-relay',
      relay: 'stopped',
      relayOrigin: null,
      hub: null,
      roster: { state: 'off', devices: 0 },
    })
    const settings = await api.settings.get()
    renderPage(
      { ...api, settings: { ...api.settings, get: async () => ({ ...settings, relayHost: null }) } },
      <DevicesSection />,
    )
    expect(await screen.findByText(/Valet’s relay isn’t set up/)).toBeTruthy()
    expect(await screen.findByRole('textbox', { name: 'Relay host name' })).toBeTruthy()
  })
})
