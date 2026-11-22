// Settings › Devices: the iPhones paired with this Mac, how they reach it (this Mac's own address
// at Valet's relay), and Pair an iPhone. No account and no hub: phones pair with the Mac by QR.

import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { createFakeApi } from '../src/renderer/dev/fake-api'
import { DevicesSection } from '../src/renderer/screens/settings/DevicesSection'
import type { PhonesStatus } from '../src/shared/api'
import { called, NOW, renderPage } from './connections-helpers'

function withStatus(over: Partial<PhonesStatus>) {
  const fake = createFakeApi({ now: NOW })
  const status: PhonesStatus = {
    available: true,
    unavailableReason: null,
    relay: 'online',
    relayOrigin: 'https://0123abcd.valet.example',
    worksLocked: true,
    phones: [
      { deviceId: 'phone-1', name: 'Nick’s iPhone', pairedAt: '2026-11-22T00:00:00.000Z', online: true },
    ],
    pairing: { step: 'idle' },
    ...over,
  }
  return { ...fake, phones: { ...fake.phones, status: async () => status } }
}

describe('Settings › Devices', () => {
  it('lists the paired iPhones and how they reach this Mac, with Pair an iPhone and nothing about an account', async () => {
    const user = userEvent.setup()
    const api = withStatus({})
    renderPage(api, <DevicesSection />)
    expect(await screen.findByText(/Connected to the relay \(0123abcd\.valet\.example\)/)).toBeTruthy()
    expect(screen.getByText('Nick’s iPhone')).toBeTruthy()
    const text = document.body.textContent ?? ''
    expect(text).not.toMatch(/account|passkey|hub|sign-in code/i)
    expect(screen.queryByRole('textbox')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Pair an iPhone' }))
    expect(called(api, 'phones.startPairing')).toHaveLength(1)
  })

  it('says why the relay is down and holds Pair an iPhone until it’s back', async () => {
    renderPage(withStatus({ relay: 'offline' }), <DevicesSection />)
    expect(
      await screen.findByText(
        'Not connected to the relay (0123abcd.valet.example). Valet keeps trying. Check this Mac is online.',
      ),
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Pair an iPhone' }).getAttribute('aria-disabled')).toBe('true')
  })

  it('says pairing needs the relay when this copy of Valet runs without it', async () => {
    renderPage(
      withStatus({ available: false, unavailableReason: 'no-relay', relay: 'stopped', relayOrigin: null }),
      <DevicesSection />,
    )
    expect(await screen.findByText(/Pairing a phone needs Valet’s relay/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Pair an iPhone' }).getAttribute('aria-disabled')).toBe('true')
  })
})
