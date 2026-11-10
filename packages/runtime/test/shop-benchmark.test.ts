// How long a weekly shop takes through Valet. The real tool host runs the real Woolworths adapter,
// one call after another as the server's instructions ask, against canned site answers, on a
// virtual clock that the rate budget moves forward. So the times below are what the site's 10 s
// gap (D28) alone costs: no network, no login, no thinking time for the agent. The session read
// cache and the minute a write may rest on the last login check are both in force, as shipped.
//
// The numbers are asserted exactly, so a change to the pacing, to the login probe, or to how many
// requests a tool makes shows up here and in docs/findings/2026-11-10-shop-benchmark.md together.

import { readFileSync } from 'node:fs'
import { createAdapter } from '@valet/adapter-woolworths'
import type { FetchInit, FetchResult } from '@valet/core'
import { describe, expect, it } from 'vitest'
import { ToolHost } from '../src/tool-host'
import type { ToolCallResult } from '../src/types'
import {
  FakeClock,
  FakePrompt,
  FakeSessionDriver,
  json,
  MemoryAudit,
  MemoryJsonStore,
  MemoryMarkers,
} from './fakes'

const HASH = 'a'.repeat(64)
const ITEMS = 30
const fixture = (name: string): any =>
  JSON.parse(
    readFileSync(new URL(`../../../adapters/woolworths/test/fixtures/${name}`, import.meta.url), 'utf8'),
  )

function shop() {
  const definition = createAdapter()
  const home = definition.manifest.home
  const clock = new FakeClock()
  const driver = new FakeSessionDriver()
  driver.page.url = `${home}/`
  const requests: string[] = []
  const answers: Record<string, FetchResult> = {
    'GET /api/ui/v2/bootstrap': json({ ShopperDetails: { IsLoggedIn: true } }),
    'POST /apis/ui/Search/products': json(fixture('search-milk.json')),
    'GET /apis/ui/Trolley': json(fixture('trolley-two-items.json')),
    'POST /api/v3/ui/trolley/update': json(fixture('trolley-two-items.json')),
  }
  driver.page.fetch = async (url: string, init?: FetchInit): Promise<FetchResult> => {
    const key = `${(init?.method ?? 'GET').toUpperCase()} ${new URL(url).pathname}`
    requests.push(key)
    const answer = answers[key]
    if (answer === undefined) throw new Error(`no answer for ${key}`)
    return structuredClone(answer)
  }
  const host = new ToolHost({
    approvals: { isApproved: async () => true },
    audit: new MemoryAudit(),
    prompt: new FakePrompt(),
    authRunner: async () => ({ status: 'ok' }),
    markers: new MemoryMarkers(() => clock.now()),
    breakerStore: new MemoryJsonStore(),
    clock,
    sleep: clock.sleep,
    pacingSleep: clock.pacingSleep,
  })
  host.register({ definition, bundleHash: HASH, driver })
  let calls = 0
  const run = async (tool: string, input: unknown): Promise<ToolCallResult> => {
    const result = await host.call({
      adapterId: definition.manifest.id,
      tool,
      input,
      client: 'benchmark',
      callId: `call-${++calls}`,
    })
    expect(result.status, `${tool}: ${JSON.stringify(result)}`).toBe('ok')
    return result
  }
  const started = clock.now()
  return {
    run,
    requests,
    gapMs: definition.manifest.limits.minGapMs,
    calls: () => calls,
    seconds: () => (clock.now() - started) / 1000,
    probes: () => requests.filter((r) => r.endsWith('/bootstrap')).length,
    count: (request: string) => requests.filter((r) => r === request).length,
  }
}

const stockcode = (i: number): number => 100_000 + i

describe('a thirty-item shop at Woolworths’ pacing', () => {
  it('search then add for each item, then read the cart: 61 calls, 73 requests, 12 minutes', async () => {
    const s = shop()
    for (let i = 0; i < ITEMS; i++) {
      await s.run('search_products', { query: `item ${i}` })
      await s.run('add_to_cart', { stockcode: stockcode(i), quantity: 1 })
    }
    await s.run('get_cart', {})

    expect(s.gapMs).toBe(10_000)
    expect(s.calls()).toBe(61)
    // A search is one request. An add is one too, the write: the trolley it starts from is read
    // from the site once and from the cache (the last write's reply) after that, and the login
    // probe is made once a minute, which here is every third add. get_cart probes and reads.
    expect(s.count('POST /apis/ui/Search/products')).toBe(ITEMS)
    expect(s.count('POST /api/v3/ui/trolley/update')).toBe(ITEMS)
    expect(s.count('GET /apis/ui/Trolley')).toBe(2)
    expect(s.probes()).toBe(ITEMS / 3 + 1)
    expect(s.requests).toHaveLength(73)
    // Every request but the first waits the full gap. It was 122 requests and 20 minutes.
    expect(s.seconds()).toBe((s.requests.length - 1) * 10)
    expect(s.seconds() / 60).toBe(12)
  })

  it('adds only, from stockcodes already known (a saved list): 31 calls, 39 requests, 6 minutes', async () => {
    const s = shop()
    for (let i = 0; i < ITEMS; i++) await s.run('add_to_cart', { stockcode: stockcode(i), quantity: 1 })
    await s.run('get_cart', {})

    // Thirty writes, one trolley read, a probe once a minute (six among the adds), then
    // get_cart's probe and read.
    expect(s.count('POST /api/v3/ui/trolley/update')).toBe(ITEMS)
    expect(s.probes()).toBe(7)
    expect(s.requests).toHaveLength(39)
    // It was 92 requests and 15 minutes.
    expect(s.seconds()).toBe((s.requests.length - 1) * 10)
    expect(s.seconds() / 60).toBeCloseTo(6.33, 2)
  })

  it('sets each quantity outright instead of adding: 31 calls, 37 requests, 6 minutes', async () => {
    const s = shop()
    for (let i = 0; i < ITEMS; i++) await s.run('set_cart_quantity', { stockcode: stockcode(i), quantity: 1 })
    await s.run('get_cart', {})

    // No trolley read before the write. It was 62 requests and 10 minutes.
    expect(s.requests).toHaveLength(37)
    expect(s.seconds()).toBe((s.requests.length - 1) * 10)
    expect(s.seconds() / 60).toBe(6)
  })

  it('searching for the same thing again inside a quarter of an hour asks the site nothing', async () => {
    const s = shop()
    await s.run('search_products', { query: 'milk' })
    await s.run('search_products', { query: 'milk' })
    await s.run('search_products', { query: 'bread' })
    expect(s.count('POST /apis/ui/Search/products')).toBe(2)
    expect(s.seconds()).toBe(10)
  })

  it('get_cart always asks the site, and always checks the login first', async () => {
    const s = shop()
    await s.run('add_to_cart', { stockcode: stockcode(1), quantity: 1 })
    await s.run('get_cart', {})
    await s.run('get_cart', {})
    expect(s.requests).toEqual([
      'GET /api/ui/v2/bootstrap',
      'GET /apis/ui/Trolley',
      'POST /api/v3/ui/trolley/update',
      'GET /api/ui/v2/bootstrap',
      'GET /apis/ui/Trolley',
      'GET /api/ui/v2/bootstrap',
      'GET /apis/ui/Trolley',
    ])
  })
})
