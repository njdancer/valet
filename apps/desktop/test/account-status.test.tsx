import { act, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { createFakeApi } from '../src/renderer/dev/fake-api'
import { accountLine } from '../src/renderer/lib/account-status'
import { needsYouOrder, needsYouView } from '../src/renderer/lib/needs-you'
import { NeedsYouPage } from '../src/renderer/screens/needs-you/NeedsYouPage'
import type { AttentionItem, PhonesStatus } from '../src/shared/api'
import { waitingCount } from '../src/shared/waiting-count'
import { NOW, renderPage } from './connections-helpers'

const LINKED = {
  state: 'linked',
  url: 'https://valet.example',
  accountId: 'acc_1',
  account: 'nick',
  slug: 'nicks-mbp',
  name: 'Nick’s MacBook Pro',
} as const

function status(over: Partial<PhonesStatus>): PhonesStatus {
  return {
    available: true,
    unavailableReason: null,
    relay: 'online',
    relayOrigin: 'https://valet.example',
    worksLocked: true,
    hub: LINKED,
    roster: { state: 'on', devices: 2 },
    phones: [],
    pairing: { step: 'idle' },
    ...over,
  }
}

describe('the Valet account line', () => {
  it('says plainly when this Mac is connected', () => {
    expect(accountLine(status({}))).toEqual({
      tone: 'success',
      text: 'Valet account · connected to nick’s account as nicks-mbp',
    })
  })

  it('warns when the Mac is on the account but the hub can’t reach it', () => {
    for (const relay of ['offline', 'connecting', 'refused', 'stopped'] as const) {
      const line = accountLine(status({ relay }))
      expect(line?.tone).toBe('warning')
      expect(line?.text).toContain('agents can’t reach this Mac')
    }
  })

  it('warns when the device list needs something', () => {
    expect(accountLine(status({ roster: { state: 'needs-you', devices: 0 } }))?.tone).toBe('warning')
    expect(accountLine(status({ roster: { state: 'not-added', devices: 0 } }))?.tone).toBe('warning')
    expect(accountLine(status({ roster: { state: 'refused', devices: 0 } }))?.text).toContain('doesn’t check')
    // Still being put on the list is not a problem.
    expect(accountLine(status({ roster: { state: 'waiting', devices: 0 } }))?.tone).toBe('success')
  })

  it('says nothing without a hub, and is neutral before or while connecting', () => {
    expect(accountLine(status({ hub: null }))).toBeNull()
    expect(accountLine(status({ hub: { state: 'off' } }))).toBeNull()
    expect(accountLine(status({ hub: { state: 'unlinked', url: 'https://valet.example' } }))?.tone).toBe(
      'neutral',
    )
    expect(
      accountLine(
        status({ hub: { state: 'linking', url: 'https://valet.example', code: 'ABCD-EFGH', expiresAt: '' } }),
      )?.text,
    ).toContain('waiting for the code')
  })
})

describe('Needs you status card', () => {
  it('shows where this Mac stands with the account, with a way to Devices, and follows changes', async () => {
    const api = createFakeApi({ now: NOW })
    renderPage(api, <NeedsYouPage item={null} />)
    expect(await screen.findByText('Valet account · this Mac isn’t on it')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Devices' }).getAttribute('href')).toBe('#/settings/devices')
    await act(() => api.phones.joinHub())
    expect(
      await screen.findByText('Valet account · waiting for the code to be typed on the hub’s page'),
    ).toBeTruthy()
  })
})

describe('several agents asking to connect', () => {
  const consent = (id: string, ageS: number, via?: 'hub'): AttentionItem => ({
    kind: 'remote-consent',
    id,
    clientHost: 'claude.ai',
    clientName: 'Claude',
    source: '203.0.113.24',
    requestedAt: new Date(NOW - ageS * 1000).toISOString(),
    expiresAt: new Date(NOW + 600_000 - ageS * 1000).toISOString(),
    ...(via === undefined ? {} : { via }),
  })

  it('show as one item, ending with the soonest, that opens the one sheet', () => {
    const views = needsYouOrder(
      [consent('a', 400, 'hub'), consent('b', 20, 'hub')].map((i) => needsYouView(i, () => false)),
    )
    expect(views).toHaveLength(1)
    expect(views[0]?.title).toBe('Approve 2 connections')
    expect(views[0]?.deadline).toBe(NOW + 200_000)
    expect(views[0]?.action).toEqual({ kind: 'route', to: '#/connections/approve' })
  })

  it('say a hub sign-in comes through the account, not from an address', () => {
    const [hub] = needsYouOrder([needsYouView(consent('a', 5, 'hub'), () => false)])
    expect(hub?.description).toContain('through your Valet account')
    expect(hub?.description).not.toContain('203.0.113.24')
    const [direct] = needsYouOrder([needsYouView(consent('a', 5), () => false)])
    expect(direct?.description).toContain('from 203.0.113.24')
  })

  it('count once on the menu bar and beside Needs you', () => {
    expect(waitingCount([consent('a', 1), consent('b', 2), { kind: 'missed' } as AttentionItem])).toBe(1)
    expect(waitingCount([consent('a', 1), { kind: 'review' } as AttentionItem])).toBe(2)
    expect(waitingCount([])).toBe(0)
  })
})
