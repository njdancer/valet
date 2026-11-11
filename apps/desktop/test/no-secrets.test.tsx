// The renderer can't show a secret because the API never carries one. These tests hold both halves:
// the fake (and so the contract it implements) has no secret-shaped fields, and a main process that
// leaked extra fields anyway still wouldn't get them on screen, because every screen renders only the
// fields it names, and the audit inspector only the fields core's audit format defines.
//
// What they can't hold: a secret the main process put inside a field a screen does render (an item
// title, a request target, preview text) would be shown. That half is the main process's guarantee.

import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AuditRecord } from '@valet/core'
import { TooltipProvider } from '@valet/ui'
import { describe, expect, it } from 'vitest'
import { ControlPanel } from '../src/renderer/control/App'
import { createFakeApi } from '../src/renderer/dev/fake-api'
import { ApiProvider } from '../src/renderer/lib/api-context'
import { TrayPopover } from '../src/renderer/tray/TrayPopover'
import type { ValetApi } from '../src/shared/api'

const NOW = Date.parse('2026-11-07T21:48:00+11:00')
const CANARY = 'canary-7f3a91-SECRET'
const LEAKY_KEYS = ['itemRef', 'token', 'password', 'value', 'cookieValue', 'plaintext', 'otp']

/** Adds leaked-looking keys to every object a call returns, audit records and their events included. */
function leak(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(leak)
  if (value === null || typeof value !== 'object') return value
  const copy: Record<string, unknown> = {}
  for (const [key, inner] of Object.entries(value)) copy[key] = leak(inner)
  for (const key of LEAKY_KEYS) if (!Object.hasOwn(copy, key)) copy[key] = CANARY
  return copy
}

function leaky(api: ValetApi): ValetApi {
  const wrap = <T extends object>(group: T): T => {
    const out: Record<string, unknown> = {}
    for (const [key, fn] of Object.entries(group)) {
      out[key] =
        typeof fn === 'function'
          ? async (...args: unknown[]) => leak(await (fn as (...a: unknown[]) => Promise<unknown>)(...args))
          : fn
    }
    return out as T
  }
  return {
    ...api,
    adapters: wrap(api.adapters),
    approvals: wrap(api.approvals),
    grants: wrap(api.grants),
    runs: wrap(api.runs),
    audit: wrap(api.audit),
    endpoint: wrap(api.endpoint),
    clients: wrap(api.clients),
    attention: wrap(api.attention),
    settings: wrap(api.settings),
    updates: wrap(api.updates),
    health: wrap(api.health),
    app: wrap(api.app),
  }
}

// The review page and the grant sheet have their own copy of this check: review-grant-no-secrets.
const ROUTES: [string, string][] = [
  ['#/sites', 'Review Woolworths update'],
  ['#/sites/woolworths', 'Called by'],
  ['#/sites/woolworths/permissions', 'woolworths.com.au'],
  ['#/sites/coles', '+61 400 000 111'],
  ['#/activity/calls/c_8f2e1b', '[session cookie]'],
  ['#/activity/audit', 'The audit log checks out up to record 4813.'],
  ['#/connections', 'Add an app…'],
  ['#/secrets', '1Password app “Coles”'],
  ['#/confirm/cf_a40f3c', 'From the site'],
  ['#/needs-user/woolworths', 'Log in to Woolworths (verification check)'],
]

describe('no secret reaches the screen', () => {
  it('the fake returns no secret-shaped field from any read', async () => {
    const api = createFakeApi({ now: NOW })
    const reads = await Promise.all([
      api.adapters.list(),
      api.adapters.get('woolworths'),
      api.adapters.get('coles'),
      api.approvals.pending(),
      api.grants.list(),
      api.grants.providers(),
      api.grants.vaultItems('onepassword-service-account'),
      api.runs.list(),
      api.runs.trace('c_8f2e1b'),
      api.audit.page({}),
      api.endpoint.status(),
      api.clients.snippets('c_c7d2a1b2c3d4e5f6'),
      api.clients.list(),
      api.attention.list(),
      api.settings.get(),
    ])
    const keys = new Set<string>()
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(visit)
      else if (value !== null && typeof value === 'object') {
        for (const [key, inner] of Object.entries(value)) {
          keys.add(key)
          visit(inner)
        }
      }
    }
    visit(reads)
    for (const key of LEAKY_KEYS) expect(keys.has(key)).toBe(false)
    expect(JSON.stringify(reads)).not.toMatch(/op:\/\/|Bearer |sat_/)
  })

  it('the leaky API really does leak, so the tests below are not vacuous', async () => {
    const api = leaky(createFakeApi({ now: NOW }))
    expect(JSON.stringify(await api.adapters.get('woolworths'))).toContain(CANARY)
    expect(JSON.stringify(await api.grants.list())).toContain(`"itemRef":"${CANARY}"`)
  })

  for (const [hash, landmark] of ROUTES) {
    it(`renders ${hash} without fields it doesn't name, even when the main process sends them`, async () => {
      window.location.hash = hash
      render(
        <ApiProvider api={leaky(createFakeApi({ now: NOW }))} clock={{ now: () => NOW }}>
          <TooltipProvider>
            <ControlPanel />
          </TooltipProvider>
        </ApiProvider>,
      )
      expect((await screen.findAllByText(landmark)).length).toBeGreaterThan(0)
      // Let every loader settle before looking.
      await waitFor(() => expect(document.body.textContent).not.toContain('Loading'))
      expect(document.documentElement.innerHTML).not.toContain(CANARY)
    })
  }

  it('shows and copies only the audit fields core defines, even when a record carries more', async () => {
    const user = userEvent.setup()
    const fake = createFakeApi({ now: NOW })
    const api = leaky(fake)
    const page = await api.audit.page({})
    expect(JSON.stringify(page.records)).toContain(CANARY)
    window.location.hash = '#/activity/audit'
    render(
      <ApiProvider api={api} clock={{ now: () => NOW }}>
        <ControlPanel />
      </ApiProvider>,
    )
    // Every record, through the inspector, its JSON and Copy record.
    for (const record of page.records) {
      act(() => {
        window.location.hash = `#/activity/audit/${record.seq}`
      })
      const inspector = await screen.findByRole('region', { name: 'Record' })
      await waitFor(() => expect(within(inspector).getByText('Record as JSON')).toBeTruthy())
      await user.click(within(inspector).getByText('Record as JSON'))
      await waitFor(() => expect(inspector.textContent).toContain(`"type": "${record.event.type}"`))
      await user.click(within(inspector).getByRole('button', { name: 'Copy record' }))
      await user.click(within(inspector).getByText('Record as JSON'))
    }
    expect(document.documentElement.innerHTML).not.toContain(CANARY)
    const copies = fake.fake.calls.filter((c) => c.method === 'app.copyText').map((c) => c.args[0])
    expect(copies).toHaveLength(page.records.length)
    for (const copy of copies) expect(copy).not.toContain(CANARY)
  })

  it('shows a defined audit field only if it holds the kind of value core writes there', async () => {
    const user = userEvent.setup()
    const fake = createFakeApi({ now: NOW })
    const odd = {
      seq: 7001,
      at: new Date(NOW).toISOString(),
      event: {
        type: 'grant-made',
        adapterId: 'woolworths',
        adapterHash: 'aa'.repeat(32),
        secret: 'login',
        provider: 'onepassword-cli',
        origins: [{ password: CANARY }],
      },
      prev: { value: CANARY },
      hash: 'cc'.repeat(32),
    } as unknown as AuditRecord
    const api = {
      ...fake,
      audit: { ...fake.audit, page: async () => ({ records: [odd], total: 1, nextBeforeSeq: null }) },
    }
    window.location.hash = '#/activity/audit/7001'
    render(
      <ApiProvider api={api} clock={{ now: () => NOW }}>
        <ControlPanel />
      </ApiProvider>,
    )
    const inspector = await screen.findByRole('region', { name: 'Record' })
    await user.click(await within(inspector).findByText('Record as JSON'))
    expect(inspector.textContent).toContain('"origins": "[not shown]"')
    expect(inspector.textContent).toContain('"prev": "[not shown]"')
    await user.click(within(inspector).getByRole('button', { name: 'Copy record' }))
    expect(JSON.stringify(fake.fake.calls)).not.toContain(CANARY)
  })

  it('renders the tray popover without fields it doesn’t name', async () => {
    render(
      <ApiProvider api={leaky(createFakeApi({ now: NOW }))} clock={{ now: () => NOW }}>
        <TooltipProvider>
          <TrayPopover />
        </TooltipProvider>
      </ApiProvider>,
    )
    expect(await screen.findByText('Log in to Woolworths (verification check)')).toBeTruthy()
    await waitFor(() => expect(screen.getByRole('link', { name: '37 calls' })).toBeTruthy())
    expect(document.documentElement.innerHTML).not.toContain(CANARY)
  })
})
