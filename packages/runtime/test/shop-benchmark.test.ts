// How long a weekly shop takes through Valet. The real tool host runs the real Woolworths adapter,
// one call after another as the server's instructions ask, against canned site answers, on a
// virtual clock that the rate budget moves forward. So the times below are what the site's 10 s
// gap and its jitter of up to half as much again (D28) alone cost: no network, no login, no
// thinking time for the agent.
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

function shop(random: () => number = () => 0) {
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
    random,
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
  }
}

const stockcode = (i: number): number => 100_000 + i

describe('a thirty-item shop at Woolworths’ pacing, at the bare 10 s gap', () => {
  it('search then add for each item, then read the cart: 61 calls, 122 requests, 20 minutes', async () => {
    const s = shop()
    for (let i = 0; i < ITEMS; i++) {
      await s.run('search_products', { query: `item ${i}` })
      await s.run('add_to_cart', { stockcode: stockcode(i), quantity: 1 })
    }
    await s.run('get_cart', {})

    expect(s.gapMs).toBe(10_000)
    expect(s.calls()).toBe(61)
    // A search is one request. An add is three: the login probe, the trolley read, the write.
    expect(s.requests).toHaveLength(ITEMS * (1 + 3) + 2)
    expect(s.probes()).toBe(ITEMS + 1)
    // Every request but the first waits the full gap.
    expect(s.seconds()).toBe((s.requests.length - 1) * 10)
    expect(s.seconds() / 60).toBeCloseTo(20.17, 2)
  })

  it('adds only, from stockcodes already known (a saved list): 31 calls, 92 requests, 15 minutes', async () => {
    const s = shop()
    for (let i = 0; i < ITEMS; i++) await s.run('add_to_cart', { stockcode: stockcode(i), quantity: 1 })
    await s.run('get_cart', {})

    expect(s.requests).toHaveLength(ITEMS * 3 + 2)
    expect(s.seconds()).toBe((s.requests.length - 1) * 10)
    expect(s.seconds() / 60).toBeCloseTo(15.17, 2)
  })

  it('sets each quantity outright instead of adding: 31 calls, 62 requests, 10 minutes', async () => {
    const s = shop()
    for (let i = 0; i < ITEMS; i++) await s.run('set_cart_quantity', { stockcode: stockcode(i), quantity: 1 })
    await s.run('get_cart', {})

    // No trolley read before the write, so two requests a call: the probe and the write.
    expect(s.requests).toHaveLength(ITEMS * 2 + 2)
    expect(s.seconds()).toBe((s.requests.length - 1) * 10)
    expect(s.seconds() / 60).toBeCloseTo(10.17, 2)
  })

  it('spends a third of its requests on the login probe, one for every cart call', async () => {
    const s = shop()
    for (let i = 0; i < ITEMS; i++) await s.run('add_to_cart', { stockcode: stockcode(i), quantity: 1 })
    expect(s.probes()).toBe(ITEMS)
    expect(s.probes() / s.requests.length).toBeCloseTo(1 / 3, 5)
  })
})

describe('a thirty-item shop with the gap’s jitter', () => {
  async function searchAndAdd(random: () => number): Promise<number> {
    const s = shop(random)
    for (let i = 0; i < ITEMS; i++) {
      await s.run('search_products', { query: `item ${i}` })
      await s.run('add_to_cart', { stockcode: stockcode(i), quantity: 1 })
    }
    await s.run('get_cart', {})
    return s.seconds() / 60
  }

  it('takes 25 minutes on average for search then add, and 30 at the outside', async () => {
    expect(await searchAndAdd(() => 0.5)).toBeCloseTo(25.21, 2)
    expect(await searchAndAdd(() => 0.999_999)).toBeCloseTo(30.25, 2)
  })

  it('takes 19 minutes on average for adds from a saved list', async () => {
    const s = shop(() => 0.5)
    for (let i = 0; i < ITEMS; i++) await s.run('add_to_cart', { stockcode: stockcode(i), quantity: 1 })
    await s.run('get_cart', {})
    expect(s.seconds() / 60).toBeCloseTo(18.96, 2)
  })

  it('takes 13 minutes on average when each quantity is set outright', async () => {
    const s = shop(() => 0.5)
    for (let i = 0; i < ITEMS; i++) await s.run('set_cart_quantity', { stockcode: stockcode(i), quantity: 1 })
    await s.run('get_cart', {})
    expect(s.seconds() / 60).toBeCloseTo(12.71, 2)
  })
})
