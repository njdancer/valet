// The review page and the grant sheet render only the fields they name. A main process that leaked
// secret-shaped fields into every object it returns still gets none of them on screen (the same
// check test/no-secrets.test.tsx makes for the other pages).

import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TooltipProvider } from '@valet/ui'
import { describe, expect, it } from 'vitest'
import { ControlPanel } from '../src/renderer/control/App'
import { createFakeApi } from '../src/renderer/dev/fake-api'
import { ApiProvider } from '../src/renderer/lib/api-context'
import type { ValetApi } from '../src/shared/api'

const NOW = Date.parse('2026-11-07T21:48:00+11:00')
const CANARY = 'canary-7f3a91-SECRET'
const LEAKY_KEYS = ['itemRef', 'token', 'password', 'value', 'cookieValue', 'plaintext', 'otp']

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
    attention: wrap(api.attention),
  }
}

function show(hash: string, api: ValetApi) {
  window.location.hash = hash
  render(
    <ApiProvider api={leaky(api)} clock={{ now: () => NOW }}>
      <TooltipProvider>
        <ControlPanel />
      </TooltipProvider>
    </ApiProvider>,
  )
}

const ROUTES: [string, string][] = [
  ['#/sites/woolworths/versions/review', 'Permission changes'],
  ['#/sites/woolworths/login/login', 'Fill it only on'],
  ['#/sites/coles/login/messages', 'Sender the manifest declared'],
]

describe('no secret reaches the review page or the grant sheet', () => {
  it('the leaky API really does leak, so the tests below are not vacuous', async () => {
    const api = leaky(createFakeApi({ now: NOW, updateWaiting: true }))
    expect(JSON.stringify(await api.approvals.pending())).toContain(CANARY)
    expect(JSON.stringify(await api.grants.vaultItems('onepassword-service-account'))).toContain(CANARY)
  })

  for (const [hash, landmark] of ROUTES) {
    it(`renders ${hash} without fields it doesn't name, even when the main process sends them`, async () => {
      show(hash, createFakeApi({ now: NOW, updateWaiting: true }))
      expect((await screen.findAllByText(landmark)).length).toBeGreaterThan(0)
      await waitFor(() => expect(document.body.querySelector('[aria-busy="true"]')).toBeNull())
      expect(document.documentElement.innerHTML).not.toContain(CANARY)
    })
  }

  it('renders a first install, every fold open, without fields it doesn’t name', async () => {
    const user = userEvent.setup()
    show('#/sites/woolworths/versions/review', createFakeApi({ now: NOW, firstRun: true }))
    await user.click(await screen.findByRole('button', { name: /Every permission, in detail/ }))
    expect(screen.getAllByTestId('perm-added').length).toBeGreaterThan(0)
    expect(document.documentElement.innerHTML).not.toContain(CANARY)
  })
})
