// Activity's half of no-secrets.test.tsx: a main process that leaked extra fields into what Calls, a
// trace and the Audit log load still wouldn't get them on screen, because each page renders only
// the fields it names.

import { render, screen, waitFor } from '@testing-library/react'
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
    for (const [key, fn] of Object.entries(group))
      out[key] =
        typeof fn === 'function'
          ? async (...args: unknown[]) => leak(await (fn as (...a: unknown[]) => Promise<unknown>)(...args))
          : fn
    return out as T
  }
  return {
    ...api,
    adapters: wrap(api.adapters),
    runs: wrap(api.runs),
    audit: wrap(api.audit),
    clients: wrap(api.clients),
    attention: wrap(api.attention),
    settings: wrap(api.settings),
  }
}

const ROUTES: [string, string][] = [
  ['#/activity/calls', 'Changed a trolley line: Dairy Farmers Milk 2L × 2'],
  ['#/activity/calls/c_8f2e1b', '[session cookie]'],
  ['#/activity/calls?login=woolworths%2Flogin', 'Back to the login'],
  ['#/activity/audit', 'The audit log checks out up to record 4813.'],
  ['#/activity/audit/4433', 'In the verified chain'],
]

describe('Activity shows no field it doesn’t name', () => {
  for (const [hash, landmark] of ROUTES) {
    it(`renders ${hash} without fields it doesn't name, even when the main process sends them`, async () => {
      window.location.hash = hash
      render(
        <TooltipProvider>
          <ApiProvider api={leaky(createFakeApi({ now: NOW }))} clock={{ now: () => NOW }}>
            <ControlPanel />
          </ApiProvider>
        </TooltipProvider>,
      )
      expect((await screen.findAllByText(landmark)).length).toBeGreaterThan(0)
      await waitFor(() => expect(document.body.textContent).not.toContain('Loading'))
      expect(document.documentElement.innerHTML).not.toContain(CANARY)
    })
  }
})
