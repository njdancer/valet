// The renderer can't show a secret because the API never carries one. These tests hold both halves:
// the fake (and so the contract it implements) has no secret-shaped fields, and a main process that
// leaked extra fields anyway still wouldn't get them on screen, because every screen renders only the
// fields it names.

import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ControlPanel } from '../src/renderer/control/App'
import { createFakeApi } from '../src/renderer/dev/fake-api'
import { ApiProvider } from '../src/renderer/lib/api-context'
import { TrayPopover } from '../src/renderer/tray/TrayPopover'
import type { SiteAdapterApi } from '../src/shared/api'

const NOW = Date.parse('2026-11-07T21:48:00+11:00')
const CANARY = 'canary-7f3a91-SECRET'
const LEAKY_KEYS = ['itemRef', 'token', 'password', 'value', 'cookieValue', 'plaintext', 'otp']

function isAuditRecord(value: object): boolean {
  return 'seq' in value && 'prev' in value && 'hash' in value
}

/**
 * Adds leaked-looking keys to every object a call returns. Audit records are left alone: the
 * inspector shows a record verbatim, by design, since its hash covers exactly what was written, and
 * the runtime writes them from structured fields only.
 */
function leak(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(leak)
  if (value === null || typeof value !== 'object') return value
  if (isAuditRecord(value)) return value
  const copy: Record<string, unknown> = {}
  for (const [key, inner] of Object.entries(value)) copy[key] = leak(inner)
  for (const key of LEAKY_KEYS) if (!Object.hasOwn(copy, key)) copy[key] = CANARY
  return copy
}

function leaky(api: SiteAdapterApi): SiteAdapterApi {
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

const ROUTES: [string, string][] = [
  ['#/adapters', 'Woolworths 0.4.0 is ready for review.'],
  ['#/adapters/woolworths', 'Content hash'],
  ['#/adapters/coles', '+61 400 000 111'],
  ['#/adapters/woolworths/review', 'Permission changes'],
  ['#/adapters/woolworths/grant/login', 'Fill it only on'],
  ['#/adapters/coles/grant/messages', 'Sender the manifest declared'],
  ['#/activity/c_8f2e1b', '[session cookie]'],
  ['#/audit', 'Chain intact.'],
  ['#/clients', 'Add to Claude Code'],
  ['#/credentials', '1Password app “Coles”'],
  ['#/confirm/cf_a40f3c', 'Shown by the Woolworths adapter'],
  ['#/needs-user/woolworths', 'Woolworths needs you to finish logging in.'],
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
      api.endpoint.snippets(),
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
          <ControlPanel />
        </ApiProvider>,
      )
      expect((await screen.findAllByText(landmark)).length).toBeGreaterThan(0)
      // Let every loader settle before looking.
      await waitFor(() => expect(document.body.textContent).not.toContain('Loading'))
      expect(document.documentElement.innerHTML).not.toContain(CANARY)
    })
  }

  it('renders the tray popover without fields it doesn’t name', async () => {
    render(
      <ApiProvider api={leaky(createFakeApi({ now: NOW }))} clock={{ now: () => NOW }}>
        <TrayPopover />
      </ApiProvider>,
    )
    expect(await screen.findByText('Log in to Woolworths')).toBeTruthy()
    await waitFor(() => expect(screen.getByText('37')).toBeTruthy())
    expect(document.documentElement.innerHTML).not.toContain(CANARY)
  })
})
