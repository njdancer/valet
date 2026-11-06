// The fixture adapter and host most tests start from. Tests copy the manifest and change one thing
// rather than parameterising a builder.

import { type AdapterDefinition, type AdapterManifest, parseManifest } from '@siteadapter/core'
import { vi } from 'vitest'
import { ToolHost, type ToolHostOptions } from '../src/tool-host'
import type { AuthRunner } from '../src/types'
import { FakeClock, FakePrompt, FakeSessionDriver, json, MemoryAudit, MemoryMarkers } from './fakes'

export const HASH = 'a'.repeat(64)
export const OTHER_HASH = 'b'.repeat(64)
export const HOME = 'https://www.example.com'
export const SESSION_URL = `${HOME}/api/session`
export const COOKIE = 'sess-7d1f0c9a4b2e'

export const manifest: AdapterManifest = parseManifest({
  schemaVersion: 1,
  id: 'example-shop',
  name: 'Example Shop',
  version: '1.0.0',
  description: 'A fake shop for runtime tests',
  home: `${HOME}/`,
  navigation: [HOME],
  egress: ['www.example.com', 'cdn.example.com'],
  secrets: {
    login: { description: 'Shop login', fields: ['username', 'password'], origins: [HOME] },
  },
  session: {
    cookieDomains: ['www.example.com'],
    storage: [{ origin: HOME, keys: ['token'] }],
    probe: {
      kind: 'fetch',
      path: '/api/session',
      expectStatus: 200,
      jsonPath: 'shopper.loggedIn',
      equals: true,
    },
  },
  auth: {
    steps: [
      { op: 'goto', url: `${HOME}/login` },
      { op: 'fill', selector: '#password', value: { secret: 'login', field: 'password' } },
      { op: 'assertLoggedIn' },
    ],
  },
  requests: [
    { method: 'GET', path: '/api/trolley', purpose: 'read' },
    { method: 'POST', path: '/api/trolley/update', purpose: 'write' },
    { method: 'POST', path: '/api/checkout/payment', purpose: 'write' },
    { method: 'POST', path: '/api/checkout/place', purpose: 'irreversible' },
    { method: 'GET', path: '/api/:section/items', purpose: 'read' },
  ],
  tools: [{ name: 'run_test', title: 'Run test', description: 'The tool under test', sideEffect: 'read' }],
  limits: { requestsPerRun: 5 },
})

export const loggedIn = json({ shopper: { loggedIn: true } })
export const loggedOut = json({ shopper: { loggedIn: false } })

export function fixture(definition: AdapterDefinition, overrides: Partial<ToolHostOptions> = {}) {
  const driver = new FakeSessionDriver()
  driver.cookieValues = [COOKIE]
  driver.page.route('GET', SESSION_URL, loggedIn)
  driver.page.route('GET', `${HOME}/api/trolley`, json({ items: [{ name: 'Milk', quantity: 2 }] }))
  const audit = new MemoryAudit()
  const prompt = new FakePrompt()
  const markers = new MemoryMarkers()
  const clock = new FakeClock()
  const diagnostics = vi.fn()
  const authRunner = vi.fn<AuthRunner>(async () => ({ status: 'ok' }))
  const approvals = { isApproved: async (id: string, hash: string) => id === 'example-shop' && hash === HASH }
  const host = new ToolHost({
    approvals,
    audit,
    prompt,
    authRunner,
    markers,
    clock,
    sleep: clock.sleep,
    siteProtection: { minRequestGapMs: 0, cooldownMs: 60_000, maxCooldownMs: 600_000 },
    diagnostics,
    ...overrides,
  })
  host.register({ definition, bundleHash: HASH, driver })
  return { host, driver, page: driver.page, audit, prompt, markers, clock, authRunner, diagnostics }
}

export const call = {
  adapterId: 'example-shop',
  tool: 'run_test',
  input: {},
  client: 'claude-code',
  callId: 'call-1',
}
