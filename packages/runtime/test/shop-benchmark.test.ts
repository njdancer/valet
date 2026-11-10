// How long a weekly shop takes through Valet. The real tool host runs the real Woolworths adapter,
// one call after another as the server's instructions ask, against canned site answers, on a
// virtual clock that the rate budget moves forward. So the times below are what D28's pacing (a
// gap of 10 to 15 s, at most four requests a minute) alone costs: no network, no login, no thinking time for the agent. The session read
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

/** `random` draws the jitter on each gap. The default, 0.5, is the average: gaps of 12.5 s. */
function shop(random: () => number = () => 0.5) {
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
  const call = (tool: string, input: unknown): Promise<ToolCallResult> =>
    host.call({
      adapterId: definition.manifest.id,
      tool,
      input,
      client: 'benchmark',
      callId: `call-${++calls}`,
    })
  const run = async (tool: string, input: unknown): Promise<ToolCallResult> => {
    const result = await call(tool, input)
    expect(result.status, `${tool}: ${JSON.stringify(result)}`).toBe('ok')
    return result
  }
  const started = clock.now()
  return {
    run,
    call,
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
  it('search then add for each item, then read the cart: 61 calls, 78 requests, 19 minutes', async () => {
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
    // probe is made once a minute, which at four requests a minute is every other add. get_cart
    // probes and reads.
    expect(s.count('POST /apis/ui/Search/products')).toBe(ITEMS)
    expect(s.count('POST /api/v3/ui/trolley/update')).toBe(ITEMS)
    expect(s.count('GET /apis/ui/Trolley')).toBe(2)
    expect(s.probes()).toBe(ITEMS / 2 + 1)
    expect(s.requests).toHaveLength(78)
    // Four requests a minute is what sets the time: 78 requests take a little over 19 minutes
    // whatever the jitter draws. Before the per-minute cap it was 73 requests and 12 minutes;
    // before the cache, 122 and 20.
    expect(s.seconds()).toBe(1152.5)
    for (const draw of [0, 0.999999]) {
      const other = shop(() => draw)
      for (let i = 0; i < ITEMS; i++) {
        await other.run('search_products', { query: `item ${i}` })
        await other.run('add_to_cart', { stockcode: stockcode(i), quantity: 1 })
      }
      await other.run('get_cart', {})
      expect(other.requests).toHaveLength(78)
      expect(Math.abs(other.seconds() - 1152.5)).toBeLessThanOrEqual(2.5)
    }
  })

  it('adds only, from stockcodes already known (a saved list): 31 calls, 41 requests, 10 minutes', async () => {
    const s = shop()
    for (let i = 0; i < ITEMS; i++) await s.run('add_to_cart', { stockcode: stockcode(i), quantity: 1 })
    await s.run('get_cart', {})

    // Thirty writes, one trolley read, a probe once a minute (eight among the adds), then
    // get_cart's probe and read.
    expect(s.count('POST /api/v3/ui/trolley/update')).toBe(ITEMS)
    expect(s.probes()).toBe(9)
    expect(s.requests).toHaveLength(41)
    // Ten minutes at four a minute. It was 92 requests and 15 minutes before the cache.
    expect(s.seconds()).toBe(600)
  })

  it('sets each quantity outright instead of adding: 31 calls, 40 requests, 10 minutes', async () => {
    const s = shop()
    for (let i = 0; i < ITEMS; i++) await s.run('set_cart_quantity', { stockcode: stockcode(i), quantity: 1 })
    await s.run('get_cart', {})

    // No trolley read before the write. It was 62 requests and 10 minutes.
    expect(s.requests).toHaveLength(40)
    expect(s.seconds()).toBe(577.5)
  })

  it('the hourly cap of 100 holds one whole shop, and refuses the calls of a second in the same hour', async () => {
    const s = shop()
    for (let i = 0; i < ITEMS; i++) {
      await s.run('search_products', { query: `item ${i}` })
      await s.run('add_to_cart', { stockcode: stockcode(i), quantity: 1 })
    }
    await s.run('get_cart', {})
    expect(s.requests).toHaveLength(78)

    // Nineteen minutes in, the second shop gets as far as the cap and no further.
    let refused: ToolCallResult | undefined
    for (let i = 0; i < ITEMS && refused === undefined; i++) {
      const result = await s.call('search_products', { query: `more ${i}` })
      if (result.status !== 'ok') refused = result
    }
    expect(s.requests).toHaveLength(100)
    // Room again when the first request of the hour is an hour old.
    expect(refused).toEqual({
      status: 'blocked',
      cause: 'hourly-cap',
      retryAfterMs: 3_600_000 - s.seconds() * 1000,
    })
  })

  it('searching for the same thing again inside a quarter of an hour asks the site nothing', async () => {
    const s = shop()
    await s.run('search_products', { query: 'milk' })
    await s.run('search_products', { query: 'milk' })
    await s.run('search_products', { query: 'bread' })
    expect(s.count('POST /apis/ui/Search/products')).toBe(2)
    expect(s.seconds()).toBe(12.5)
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
