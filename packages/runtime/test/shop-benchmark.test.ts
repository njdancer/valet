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
    'GET /api/ui/v2/bootstrap': json({ ShopperRequest: { IsGuest: false } }),
    'POST /apis/ui/Search/products': json(fixture('search-milk.json')),
    'GET /apis/ui/Trolley': json(fixture('trolley-two-items.json')),
    // As the live site answers (2026-11-27): the changed lines, not the trolley, so a write's reply
    // can't stand in for the next add's trolley read.
    'POST /api/v3/ui/trolley/update': json({ Message: null, UpdatedItems: [] }),
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
  // Since 2026-11-27 the update's reply is what the live site sends: the changed lines, not the
  // trolley. So the runtime's cache can't hold the trolley across writes, and every add reads it
  // from the site before its write. Before that, these numbers assumed the reply was the trolley
  // (78 requests and 19 minutes for search-then-add, 41 and 10 for adds only).
  const list = Array.from({ length: ITEMS }, (_, i) => ({ stockcode: stockcode(i), quantity: 1 }))

  it('search then add for each item runs into the hourly cap at item thirty', async () => {
    const s = shop()
    let refused: { item: number; result: ToolCallResult } | undefined
    for (let i = 0; i < ITEMS && refused === undefined; i++) {
      const searched = await s.call('search_products', { query: `item ${i}` })
      if (searched.status !== 'ok') refused = { item: i, result: searched }
      else await s.run('add_to_cart', { stockcode: stockcode(i), quantity: 1 })
    }

    expect(s.gapMs).toBe(10_000)
    // Each add is two requests, the trolley read and the write; a search is one; and the login
    // probe comes once a minute. Twenty-nine items in, the hour's hundred are spent.
    expect(refused?.item).toBe(29)
    expect(refused?.result).toMatchObject({ status: 'blocked', cause: 'hourly-cap' })
    expect(s.count('POST /api/v3/ui/trolley/update')).toBe(29)
    expect(s.count('GET /apis/ui/Trolley')).toBe(29)
    expect(s.requests).toHaveLength(102)
    expect(s.seconds()).toBe(1512.5)
  })

  it('adds only, from stockcodes already known (a saved list): 31 calls, 77 requests, 19 minutes', async () => {
    const s = shop()
    for (let i = 0; i < ITEMS; i++) await s.run('add_to_cart', { stockcode: stockcode(i), quantity: 1 })
    await s.run('get_cart', {})

    // Thirty trolley reads and thirty writes, a probe once a minute, then get_cart's probe and read.
    expect(s.count('POST /api/v3/ui/trolley/update')).toBe(ITEMS)
    expect(s.count('GET /apis/ui/Trolley')).toBe(ITEMS + 1)
    expect(s.probes()).toBe(16)
    expect(s.requests).toHaveLength(77)
    expect(s.seconds()).toBe(1140)
  })

  it('sets each quantity outright instead of adding: 31 calls, 40 requests, 10 minutes', async () => {
    const s = shop()
    for (let i = 0; i < ITEMS; i++) await s.run('set_cart_quantity', { stockcode: stockcode(i), quantity: 1 })
    await s.run('get_cart', {})

    // No trolley read before the write. It was 62 requests and 10 minutes.
    expect(s.requests).toHaveLength(40)
    expect(s.seconds()).toBe(577.5)
  })

  it('searches, then one update_cart for the whole list: 32 calls, 35 requests, 8.5 minutes', async () => {
    const s = shop()
    for (let i = 0; i < ITEMS; i++) await s.run('search_products', { query: `item ${i}` })
    await s.run('update_cart', { items: list })
    await s.run('get_cart', {})

    expect(s.calls()).toBe(32)
    // Thirty searches, one trolley read and one write for the list, get_cart's read, and probes.
    expect(s.count('POST /apis/ui/Search/products')).toBe(ITEMS)
    expect(s.count('POST /api/v3/ui/trolley/update')).toBe(1)
    expect(s.count('GET /apis/ui/Trolley')).toBe(2)
    expect(s.requests).toHaveLength(35)
    expect(s.seconds()).toBe(505)
    for (const draw of [0, 0.999999]) {
      const other = shop(() => draw)
      for (let i = 0; i < ITEMS; i++) await other.run('search_products', { query: `item ${i}` })
      await other.run('update_cart', { items: list })
      await other.run('get_cart', {})
      expect(other.requests).toHaveLength(35)
      expect(Math.abs(other.seconds() - 505)).toBeLessThanOrEqual(5)
    }
  })

  it('the hourly cap of 100 holds one whole shop, and refuses the calls of a second in the same hour', async () => {
    const s = shop()
    for (let i = 0; i < ITEMS; i++) await s.run('search_products', { query: `item ${i}` })
    await s.run('update_cart', { items: list })
    await s.run('get_cart', {})
    expect(s.requests).toHaveLength(35)

    // The second shop gets as far as the cap and no further.
    let refused: ToolCallResult | undefined
    for (let i = 0; i < 3 * ITEMS && refused === undefined; i++) {
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
