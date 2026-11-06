// Site protection through the tool host: pacing every guarded request, and backing off for a
// cooldown when the site's bot protection blocks us (see the 2026-11-07 Woolworths live probe).

import { defineAdapter, tool } from '@siteadapter/core'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { akamaiDenied, FakeSessionDriver, flush } from './fakes'
import { call, fixture, HASH, HOME, manifest } from './fixtures'

const fetchTrolley = defineAdapter({
  manifest,
  tools: {
    run_test: tool({
      input: z.object({}),
      output: z.unknown(),
      run: async (ctx) => (await ctx.page.fetch('/api/trolley')).status,
    }),
  },
})

describe('circuit breaker', () => {
  it('turns Akamai’s 403 page into a blocked call with a retry time', async () => {
    const { host, page } = fixture(fetchTrolley)
    page.route('GET', `${HOME}/api/trolley`, akamaiDenied)

    expect(await host.call(call)).toEqual({ status: 'blocked', retryAfterMs: 60_000 })
  })

  it('fails HTML where JSON was expected without tripping the breaker', async () => {
    const { host, page } = fixture(fetchTrolley)
    page.route('GET', `${HOME}/api/trolley`, { status: 404, contentType: 'text/html', body: '<html>' })

    expect(await host.call(call)).toEqual({ status: 'failed', stage: 'tool-run', errorClass: 'invalid' })
    page.route('GET', `${HOME}/api/trolley`, { status: 200, contentType: 'application/json', body: {} })
    expect(await host.call({ ...call, callId: 'call-2' })).toEqual({ status: 'ok', output: 200 })
  })

  it('treats a 429 as a block', async () => {
    const { host, page } = fixture(fetchTrolley)
    page.route('GET', `${HOME}/api/trolley`, { status: 429, contentType: 'application/json', body: {} })

    expect(await host.call(call)).toEqual({ status: 'blocked', retryAfterMs: 60_000 })
  })

  it('does not treat HTML as a block when the tool asked for HTML', async () => {
    const { host, page } = fixture(
      defineAdapter({
        manifest,
        tools: {
          run_test: tool({
            input: z.object({}),
            output: z.unknown(),
            run: async (ctx) =>
              (await ctx.page.fetch('/api/trolley', { headers: { Accept: 'text/html' } })).status,
          }),
        },
      }),
    )
    page.route('GET', `${HOME}/api/trolley`, { status: 200, contentType: 'text/html', body: '<html>' })

    expect(await host.call(call)).toEqual({ status: 'ok', output: 200 })
  })

  it('refuses further calls without running them until the cooldown passes', async () => {
    const run = vi.fn(async () => 'ran')
    const { host, page, clock, driver } = fixture(
      defineAdapter({
        manifest: { ...manifest, tools: [manifest.tools[0]!, { ...manifest.tools[0]!, name: 'other_tool' }] },
        tools: {
          run_test: Object.values(fetchTrolley.tools)[0]!,
          other_tool: tool({ input: z.object({}), output: z.string(), run }),
        },
      }),
    )
    page.route('GET', `${HOME}/api/trolley`, akamaiDenied)
    await host.call(call)
    const opened = driver.toolPageCalls

    await clock.advance(20_000)
    expect(await host.call({ ...call, tool: 'other_tool' })).toEqual({
      status: 'blocked',
      retryAfterMs: 40_000,
    })
    expect(run).not.toHaveBeenCalled()
    expect(driver.toolPageCalls).toBe(opened)

    await clock.advance(40_000)
    expect(await host.call({ ...call, tool: 'other_tool' })).toEqual({ status: 'ok', output: 'ran' })
  })

  it('stays blocked even when tool code catches the error and returns', async () => {
    const { host, page } = fixture(
      defineAdapter({
        manifest,
        tools: {
          run_test: tool({
            input: z.object({}),
            output: z.unknown(),
            run: async (ctx) => {
              await ctx.page.fetch('/api/trolley').catch(() => undefined)
              return 'fine'
            },
          }),
        },
      }),
    )
    page.route('GET', `${HOME}/api/trolley`, akamaiDenied)

    expect(await host.call(call)).toMatchObject({ status: 'blocked' })
  })

  it('stops later requests in the same call once one is blocked', async () => {
    const { host, page } = fixture(
      defineAdapter({
        manifest,
        tools: {
          run_test: tool({
            input: z.object({}),
            output: z.unknown(),
            run: async (ctx) => {
              for (let i = 0; i < 4; i++) await ctx.page.fetch('/api/trolley').catch(() => undefined)
              return 'fine'
            },
          }),
        },
      }),
    )
    page.route('GET', `${HOME}/api/trolley`, akamaiDenied)

    await host.call(call)
    expect(page.toolFetches()).toHaveLength(1)
  })

  it('shares the breaker between adapters for the same site', async () => {
    const run = vi.fn(async () => 'ran')
    const { host, page } = fixture(fetchTrolley, { approvals: { isApproved: async () => true } })
    host.register({
      definition: defineAdapter({
        manifest: { ...manifest, id: 'example-shop-2' },
        tools: { run_test: tool({ input: z.object({}), output: z.string(), run }) },
      }),
      bundleHash: HASH,
      driver: new FakeSessionDriver(),
    })
    page.route('GET', `${HOME}/api/trolley`, akamaiDenied)
    await host.call(call)

    expect(await host.call({ ...call, adapterId: 'example-shop-2' })).toMatchObject({ status: 'blocked' })
    expect(run).not.toHaveBeenCalled()
  })

  it('reports a SiteAdapterError blocked-by-site from tool code as blocked', async () => {
    const { SiteAdapterError } = await import('@siteadapter/core')
    const { host } = fixture(
      defineAdapter({
        manifest,
        tools: {
          run_test: tool({
            input: z.object({}),
            output: z.unknown(),
            run: async () => {
              throw new SiteAdapterError('tool-run', 'blocked-by-site')
            },
          }),
        },
      }),
    )
    expect(await host.call(call)).toEqual({ status: 'blocked', retryAfterMs: 0 })
  })
})

describe('a breaker opened by another call mid-run', () => {
  // Two adapters for one site share its breaker. The second adapter's tool is held at a gate
  // until the first call has tripped the breaker, then tries to act.
  for (const action of ['fetch', 'ensure'] as const) {
    it(`refuses a ${action} without sending anything`, async () => {
      let release: () => void = () => {}
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      let seen: unknown
      const { host, page } = fixture(fetchTrolley, { approvals: { isApproved: async () => true } })
      const other = new FakeSessionDriver()
      host.register({
        definition: defineAdapter({
          manifest: { ...manifest, id: 'example-shop-2' },
          tools: {
            run_test: tool({
              input: z.object({}),
              output: z.unknown(),
              run: async (ctx) => {
                await gate
                const attempt = action === 'fetch' ? ctx.page.fetch('/api/trolley') : ctx.session.ensure()
                seen = await attempt.catch((error: { errorClass: string }) => error.errorClass)
                return seen
              },
            }),
          },
        }),
        bundleHash: HASH,
        driver: other,
      })
      page.route('GET', `${HOME}/api/trolley`, akamaiDenied)

      const second = host.call({ ...call, adapterId: 'example-shop-2', callId: 'call-2' })
      await flush()
      expect(await host.call(call)).toMatchObject({ status: 'blocked' })
      release()

      expect(await second).toMatchObject({ status: 'blocked' })
      expect(seen).toBe('blocked-by-site')
      expect(other.page.fetches).toEqual([])
    })
  }
})

describe('rate budget', () => {
  it('spaces a tool’s requests by the minimum gap', async () => {
    const slept: number[] = []
    let now = 0
    const clock = { now: () => now }
    // Advances time for budget waits, but leaves the long call timeout pending.
    const sleep = (ms: number) =>
      ms >= 120_000
        ? new Promise<void>(() => {})
        : Promise.resolve().then(() => {
            slept.push(ms)
            now += ms
          })
    const { host, page } = fixture(
      defineAdapter({
        manifest,
        tools: {
          run_test: tool({
            input: z.object({}),
            output: z.unknown(),
            run: async (ctx) => {
              await ctx.session.ensure()
              await ctx.page.goto('/')
              await ctx.page.fetch('/api/trolley')
              return 'ok'
            },
          }),
        },
      }),
      {
        clock,
        sleep,
        siteProtection: { minRequestGapMs: 2_500, cooldownMs: 60_000, maxCooldownMs: 600_000 },
      },
    )

    expect(await host.call(call)).toEqual({ status: 'ok', output: 'ok' })
    expect(slept).toEqual([2_500, 2_500])
    expect(page.fetches).toHaveLength(2)
  })

  it('notices a breaker that another call opened while this request waited for its slot', async () => {
    const waiting = vi.fn(async () => 'unreachable')
    const { host, page, clock } = fixture(fetchTrolley, {
      approvals: { isApproved: async () => true },
      siteProtection: { minRequestGapMs: 1_000, cooldownMs: 60_000, maxCooldownMs: 600_000 },
    })
    const other = new FakeSessionDriver()
    host.register({
      definition: defineAdapter({
        manifest: { ...manifest, id: 'example-shop-2' },
        tools: {
          run_test: tool({
            input: z.object({}),
            output: z.unknown(),
            run: async (ctx) => {
              await ctx.page.fetch('/api/trolley')
              return waiting()
            },
          }),
        },
      }),
      bundleHash: HASH,
      driver: other,
    })
    page.route(
      'GET',
      `${HOME}/api/trolley`,
      () => new Promise((resolve) => setTimeout(() => resolve(akamaiDenied), 0)),
    )

    // The first call takes the site's first slot; the second queues for the next one.
    const first = host.call(call)
    await flush()
    const second = host.call({ ...call, adapterId: 'example-shop-2', callId: 'call-2' })
    await flush()
    expect(await first).toMatchObject({ status: 'blocked' })
    await clock.advance(1_000)

    expect(await second).toMatchObject({ status: 'blocked' })
    expect(other.page.fetches).toEqual([])
    expect(waiting).not.toHaveBeenCalled()
  })
})
