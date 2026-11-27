// An agent's browser network card (src/renderer/screens/connections/BrowserNetwork.tsx): it shows
// the agent's two settings, turns the home network on and off, picks the interface sessions leave
// from, and says plainly when the saved interface isn't connected.

import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { createFakeApi } from '../src/renderer/dev/fake-api'
import { BrowserNetwork } from '../src/renderer/screens/connections/BrowserNetwork'
import { called, NOW, renderPage } from './connections-helpers'

const AGENT = 'remote:abc_123'

describe('an agent’s browser network card', () => {
  it('turns the home network on and off, and picks the interface its sessions leave from', async () => {
    const user = userEvent.setup()
    const api = createFakeApi({ now: NOW })
    renderPage(api, <BrowserNetwork agent={AGENT} name="Claude" />)
    const home = await screen.findByRole('switch', { name: 'Home network' })
    expect(home.getAttribute('aria-checked')).toBe('false')
    await user.click(home)
    expect(called(api, 'clients.setNetwork')).toEqual([[AGENT, { homeNetwork: true }]])
    await waitFor(() =>
      expect(screen.getByRole('switch', { name: 'Home network' }).getAttribute('aria-checked')).toBe('true'),
    )
    expect(await screen.findByText('Home network on')).toBeTruthy()

    const nic = screen.getByRole('combobox')
    expect(nic.textContent).toBe('Automatic')
    await user.click(nic)
    await user.click(await screen.findByRole('option', { name: 'vlan20 (10.20.0.5)' }))
    expect(called(api, 'clients.setNetwork').at(-1)).toEqual([AGENT, { interface: 'vlan20' }])
    await waitFor(() => expect(screen.getByRole('combobox').textContent).toBe('vlan20 (10.20.0.5)'))

    await user.click(screen.getByRole('combobox'))
    await user.click(await screen.findByRole('option', { name: 'Automatic' }))
    expect(called(api, 'clients.setNetwork').at(-1)).toEqual([AGENT, { interface: null }])
    await user.click(screen.getByRole('switch', { name: 'Home network' }))
    expect(called(api, 'clients.setNetwork').at(-1)).toEqual([AGENT, { homeNetwork: false }])
  })

  it('says when the saved interface isn’t connected, and shows it as the choice', async () => {
    const api = createFakeApi({ now: NOW })
    await api.clients.setNetwork(AGENT, { interface: 'en7' })
    renderPage(api, <BrowserNetwork agent={AGENT} name="Claude" />)
    expect(
      await screen.findByText(
        'en7 isn’t connected now, so its browser sessions can’t reach anything until it is.',
      ),
    ).toBeTruthy()
    expect(screen.getByRole('combobox').textContent).toBe('en7 (not connected)')
  })

  it('says when it can’t load the agent’s network', async () => {
    const api = createFakeApi({ now: NOW })
    api.fake.failNext('clients.network')
    renderPage(api, <BrowserNetwork agent={AGENT} name="Claude" />)
    expect((await screen.findByRole('alert')).textContent).toContain('Claude’s browser network')
  })
})
