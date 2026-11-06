// siteHealth(): what the app shows about each site, read from the runtime's own breakers and budgets
// rather than from breakers.json.

import { defineAdapter, tool } from '@siteadapter/core'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { serialiseBreakerFile } from '../src/breaker-state'
import { RateBudget, SiteCircuitBreaker } from '../src/site-protection'
import { akamaiDenied, FakeClock, FakeSessionDriver, MemoryJsonStore } from './fakes'
import { call, fixture, HASH, HOME, manifest } from './fixtures'

const fetchTrolley = defineAdapter({
  manifest,
  tools: {
    run_test: tool({
      input: z.object({}),
      output: z.unknown(),
      run: async (ctx) => (await ctx.page.fetch('/api/trolley')).body,
    }),
  },
})

describe('ToolHost.siteHealth', () => {
  it('reports a quiet site as closed, with its limits', async () => {
    const { host } = fixture(fetchTrolley)
    expect(await host.siteHealth()).toEqual([
      {
        host: 'www.example.com',
        adapterIds: ['example-shop'],
        breaker: 'closed',
        retryAt: null,
        retryAfterMs: 0,
        cooldownMs: 0,
        nextCooldownMs: 60_000,
        budget: { minGapMs: 1_000, waitMs: 0 },
      },
    ])
  })

  it('reports an open breaker after a block, and the doubled cooldown the next block would start', async () => {
    const { host, page, clock } = fixture(fetchTrolley)
    page.route('GET', `${HOME}/api/trolley`, akamaiDenied)
    await host.call(call)
    const [site] = await host.siteHealth()
    expect(site).toMatchObject({
      breaker: 'open',
      retryAt: clock.now() + 60_000,
      retryAfterMs: 60_000,
      cooldownMs: 60_000,
      nextCooldownMs: 120_000,
    })
    await clock.advance(60_000)
    expect((await host.siteHealth())[0]).toMatchObject({
      breaker: 'closed',
      retryAt: null,
      retryAfterMs: 0,
      // Still a run of blocks: no normal answer has reset it yet.
      cooldownMs: 60_000,
      nextCooldownMs: 120_000,
    })
  })

  it('shows the state an earlier run of the app persisted, before any call', async () => {
    const breakerStore = new MemoryJsonStore()
    const clock = new FakeClock()
    breakerStore.text = serialiseBreakerFile(
      new Map([
        ['www.example.com', { retryAt: clock.now() + 30_000, cooldownMs: 480_000 }],
        ['unregistered.example', { retryAt: clock.now() + 30_000, cooldownMs: 60_000 }],
      ]),
    )
    const { host } = fixture(fetchTrolley, { breakerStore, clock, sleep: clock.sleep })
    const health = await host.siteHealth()
    // Hosts no adapter registered are not shown.
    expect(health.map((s) => s.host)).toEqual(['www.example.com'])
    expect(health[0]).toMatchObject({
      breaker: 'open',
      retryAfterMs: 30_000,
      cooldownMs: 480_000,
      // Doubling stops at maxCooldownSeconds.
      nextCooldownMs: 600_000,
    })
  })

  it('reports every host held closed when the breaker file cannot be read', async () => {
    const breakerStore = new MemoryJsonStore()
    breakerStore.failRead = true
    const { host } = fixture(fetchTrolley, { breakerStore })
    expect((await host.siteHealth())[0]).toMatchObject({
      breaker: 'open',
      retryAfterMs: 60_000,
      cooldownMs: 0,
    })
  })

  it('groups adapters by host, with the most cautious limits any of them declares', async () => {
    const { host } = fixture(fetchTrolley, { approvals: { isApproved: async () => true } })
    host.register({
      definition: defineAdapter({
        manifest: {
          ...manifest,
          id: 'same-host',
          home: 'https://WWW.EXAMPLE.COM/shop',
          limits: { ...manifest.limits, minGapMs: 3_000, cooldownSeconds: 120 },
        },
        tools: fetchTrolley.tools,
      }),
      bundleHash: HASH,
      driver: new FakeSessionDriver(),
    })
    host.register({
      definition: defineAdapter({
        manifest: { ...manifest, id: 'other-shop', home: 'https://www.other.example/' },
        tools: fetchTrolley.tools,
      }),
      bundleHash: HASH,
      driver: new FakeSessionDriver(),
    })
    const health = await host.siteHealth()
    expect(health.map((s) => [s.host, s.adapterIds])).toEqual([
      ['www.example.com', ['example-shop', 'same-host']],
      ['www.other.example', ['other-shop']],
    ])
    expect(health[0]).toMatchObject({ nextCooldownMs: 120_000, budget: { minGapMs: 3_000, waitMs: 0 } })
    expect(health[1]).toMatchObject({ nextCooldownMs: 60_000, budget: { minGapMs: 1_000, waitMs: 0 } })
  })

  it('shows how long a request would wait for the budget, without taking a slot', async () => {
    const { host, clock } = fixture(fetchTrolley)
    await host.call(call)
    expect((await host.siteHealth())[0]?.budget).toEqual({ minGapMs: 1_000, waitMs: 1_000 })
    expect((await host.siteHealth())[0]?.budget).toEqual({ minGapMs: 1_000, waitMs: 1_000 })
    await clock.advance(400)
    expect((await host.siteHealth())[0]?.budget.waitMs).toBe(600)
    // Reading it took nothing: the next call still waits only what is left of the gap.
    await host.call({ ...call, callId: 'call-2' })
    expect(clock.paced).toEqual([600])
  })

  it('lists unapproved adapters too: health is about the site, not the grant', async () => {
    const { host } = fixture(fetchTrolley, { approvals: { isApproved: async () => false } })
    expect((await host.siteHealth()).map((s) => s.adapterIds)).toEqual([['example-shop']])
  })
})

describe('read-only views', () => {
  it('RateBudget.waitMs is 0 before any request and never negative', async () => {
    const clock = new FakeClock()
    const budget = new RateBudget(2_000, clock, clock.pacingSleep)
    expect(budget.waitMs()).toBe(0)
    await budget.acquire()
    expect(budget.waitMs()).toBe(2_000)
    await clock.advance(5_000)
    expect(budget.waitMs()).toBe(0)
  })

  it('SiteCircuitBreaker.status follows trips and a normal answer', async () => {
    const clock = new FakeClock()
    const breaker = new SiteCircuitBreaker(clock, { cooldownMs: 1_000, maxCooldownMs: 3_000 })
    expect(breaker.status()).toEqual({
      open: false,
      retryAt: null,
      retryAfterMs: 0,
      cooldownMs: 0,
      nextCooldownMs: 1_000,
    })
    breaker.trip('rate-limited', null)
    expect(breaker.status()).toEqual({
      open: true,
      retryAt: clock.now() + 1_000,
      retryAfterMs: 1_000,
      cooldownMs: 1_000,
      nextCooldownMs: 2_000,
    })
    await clock.advance(1_000)
    breaker.trip('rate-limited', null)
    expect(breaker.status().nextCooldownMs).toBe(3_000)
    await clock.advance(2_000)
    breaker.trip('rate-limited', null)
    expect(breaker.status()).toMatchObject({ cooldownMs: 3_000, nextCooldownMs: 3_000 })
    await clock.advance(3_000)
    breaker.recordSuccess()
    expect(breaker.status()).toMatchObject({ open: false, cooldownMs: 0, nextCooldownMs: 1_000 })
  })
})
