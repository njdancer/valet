// The rate budget across a restart: the time of each site's last request is kept in a file beside
// the breaker's, so a restart can't put two requests closer together than the site's gap.

import { defineAdapter, tool, ValetError } from '@valet/core'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { BUDGET_MEMORY_MS, parseBudgetFile, serialiseBudgetFile } from '../src/budget-state'
import { RateBudget, SiteProtection } from '../src/site-protection'
import type { RuntimeDiagnostic } from '../src/types'
import { MemoryJsonStore } from './fakes'
import { call, fixture, HOME, manifest } from './fixtures'

const START = Date.UTC(2026, 10, 7, 9, 0, 0)
const LIMITS = { minGapMs: 10_000, cooldownSeconds: 60, maxCooldownSeconds: 200 }
const HOST = 'www.woolworths.com.au'

describe('RateBudget: restoring and handing back', () => {
  it('waits out the rest of the gap after a restored last request', async () => {
    const slept: number[] = []
    const budget = new RateBudget(10_000, { now: () => START }, async (ms) => {
      slept.push(ms)
    })
    budget.restore(START - 4_000)
    expect(budget.waitMs()).toBe(6_000)
    await budget.acquire()
    expect(slept).toEqual([6_000])
  })

  it('does not wait when the restored request is older than the gap', () => {
    const budget = new RateBudget(10_000, { now: () => START }, async () => {})
    budget.restore(START - 10_000)
    expect(budget.waitMs()).toBe(0)
  })

  it('never waits longer than one gap for a restored time in the future', () => {
    const budget = new RateBudget(10_000, { now: () => START }, async () => {})
    budget.restore(START + 86_400_000)
    expect(budget.waitMs()).toBe(10_000)
    expect(budget.lastUsedAt()).toBe(START)
  })

  it('never brings the next slot forward', async () => {
    let now = START
    const budget = new RateBudget(10_000, { now: () => now }, async (ms) => {
      now += ms
    })
    await budget.acquire()
    budget.restore(START - 60_000)
    expect(budget.waitMs()).toBe(10_000)
    expect(budget.lastUsedAt()).toBe(START)
  })

  it('counts a widened gap from the last request', async () => {
    const budget = new RateBudget(2_000, { now: () => START }, async () => {})
    budget.restore(START - 1_000)
    budget.widen(10_000)
    expect(budget.waitMs()).toBe(9_000)
  })

  it('reports each request let through, with the time it went', async () => {
    let now = START
    const used: (number | null)[] = []
    const budget: RateBudget = new RateBudget(
      10_000,
      { now: () => now },
      async (ms) => {
        now += ms
      },
      () => used.push(budget.lastUsedAt()),
    )
    expect(budget.lastUsedAt()).toBeNull()
    await budget.acquire()
    await budget.acquire()
    expect(used).toEqual([START, START + 10_000])
  })

  it('hands back the slot of an aborted wait when nobody queued behind it', async () => {
    const used: number[] = []
    const budget = new RateBudget(
      10_000,
      { now: () => START },
      async (_ms, signal) => {
        if (signal?.aborted) throw new ValetError('tool-run', 'aborted')
      },
      () => used.push(1),
    )
    await budget.acquire()
    await expect(budget.acquire(AbortSignal.abort())).rejects.toThrow('aborted')
    // The aborted request sent nothing: the next waits one gap, not two, and nothing was recorded.
    expect(budget.waitMs()).toBe(10_000)
    expect(used).toEqual([1])
  })

  it('keeps an aborted wait’s slot spent when another request queued behind it', async () => {
    const sleeps: { reject: (error: unknown) => void }[] = []
    const budget = new RateBudget(
      10_000,
      { now: () => START },
      () =>
        new Promise<void>((_resolve, reject) => {
          sleeps.push({ reject })
        }),
    )
    await budget.acquire()
    const second = budget.acquire()
    void budget.acquire().catch(() => {})
    sleeps[0]?.reject(new ValetError('tool-run', 'aborted'))
    await expect(second).rejects.toThrow('aborted')
    expect(budget.waitMs()).toBe(30_000)
  })
})

describe('SiteProtection: last request times', () => {
  function protection(budgetStore: MemoryJsonStore | undefined, now: () => number = () => START) {
    const diagnostics: RuntimeDiagnostic[] = []
    const store = new MemoryJsonStore()
    const site = new SiteProtection({ now }, async () => {}, {
      store,
      ...(budgetStore === undefined ? {} : { budgetStore }),
      audit: async () => {},
      diagnostics: (diagnostic) => diagnostics.push(diagnostic),
    })
    return { site, store, diagnostics }
  }

  it('persists each request, so a restart straight after it waits out the gap', async () => {
    const budgets = new MemoryJsonStore()
    const first = protection(budgets)
    await first.site.ready()
    await first.site.forSite(HOST, LIMITS).budget.acquire()
    await first.site.flushed()
    expect(parseBudgetFile(budgets.text ?? '')).toEqual(new Map([[HOST, START]]))

    const restarted = protection(budgets, () => START + 3_000)
    const guards = restarted.site.forSite(HOST, LIMITS)
    await restarted.site.ready()
    expect(guards.budget.waitMs()).toBe(7_000)
    expect(restarted.diagnostics).toEqual([])
  })

  it('applies a stored time to a host registered after loading', async () => {
    const budgets = new MemoryJsonStore()
    budgets.text = serialiseBudgetFile(new Map([[HOST, START - 1_000]]))
    const { site } = protection(budgets)
    await site.ready()
    expect(site.forSite(HOST, LIMITS).budget.waitMs()).toBe(9_000)
  })

  it('holds nothing at startup when nothing was stored', async () => {
    const budgets = new MemoryJsonStore()
    const { site, diagnostics } = protection(budgets)
    const guards = site.forSite(HOST, LIMITS)
    await site.ready()
    await site.flushed()
    expect(guards.budget.waitMs()).toBe(0)
    expect(budgets.writes).toEqual([])
    expect(diagnostics).toEqual([])
  })

  it('keeps the pace in memory only without a store', async () => {
    const { site, store } = protection(undefined)
    await site.ready()
    await site.forSite(HOST, LIMITS).budget.acquire()
    await site.flushed()
    expect(store.writes).toEqual([])
  })

  it('keeps hosts no adapter registered this run, and drops those a day old', async () => {
    const budgets = new MemoryJsonStore()
    budgets.text = serialiseBudgetFile(
      new Map([
        ['www.coles.com.au', START - 5_000],
        ['www.old.example', START - BUDGET_MEMORY_MS],
      ]),
    )
    const { site } = protection(budgets)
    await site.ready()
    await site.forSite(HOST, LIMITS).budget.acquire()
    await site.flushed()
    expect(parseBudgetFile(budgets.text ?? '')).toEqual(
      new Map([
        ['www.coles.com.au', START - 5_000],
        [HOST, START],
      ]),
    )
  })

  for (const [name, text] of [
    ['text that is not JSON', 'garbage'],
    ['the wrong version', '{"version":2,"hosts":{}}'],
    ['an extra field', '{"version":1,"hosts":{"www.example.com":{"lastRequestAt":1,"note":"x"}}}'],
    ['a negative time', '{"version":1,"hosts":{"www.example.com":{"lastRequestAt":-1}}}'],
    ['a host that is not a hostname', '{"version":1,"hosts":{"WWW Example":{"lastRequestAt":1}}}'],
  ] as const) {
    it(`makes every site wait one gap on a file with ${name}, and repairs it`, async () => {
      const budgets = new MemoryJsonStore()
      budgets.text = text
      const { site, diagnostics } = protection(budgets)
      const early = site.forSite(HOST, LIMITS)
      await site.ready()
      const late = site.forSite('www.coles.com.au', { ...LIMITS, minGapMs: 2_000 })

      expect(early.budget.waitMs()).toBe(10_000)
      expect(late.budget.waitMs()).toBe(2_000)
      // The breaker's own file was readable: an unreadable pace is no reason to open it.
      expect(early.breaker.isOpen()).toBe(false)
      expect(diagnostics).toEqual([{ type: 'budget-state-unreadable' }])
      await site.flushed()
      expect(parseBudgetFile(budgets.text ?? '')).toEqual(
        new Map([
          ['www.coles.com.au', START],
          [HOST, START],
        ]),
      )
    })
  }

  it('waits one gap when the store cannot be read, and reports a write that fails', async () => {
    const budgets = new MemoryJsonStore()
    budgets.failRead = true
    budgets.failWrite = true
    const { site, diagnostics } = protection(budgets)
    const guards = site.forSite(HOST, LIMITS)
    await site.ready()
    await site.flushed()
    expect(guards.budget.waitMs()).toBe(10_000)
    expect(diagnostics).toEqual([{ type: 'budget-state-unreadable' }, { type: 'budget-state-write-failed' }])
  })

  it('never writes before the stored times have been read', async () => {
    const budgets = new MemoryJsonStore()
    budgets.text = serialiseBudgetFile(new Map([['www.coles.com.au', START - 1_000]]))
    const { site } = protection(budgets)
    await site.forSite(HOST, LIMITS).budget.acquire()
    await site.flushed()
    expect(parseBudgetFile(budgets.text ?? '')?.get('www.coles.com.au')).toBe(START - 1_000)
  })
})

describe('budget state file', () => {
  it('round-trips times, sorted by host', () => {
    const text = serialiseBudgetFile(
      new Map([
        ['www.woolworths.com.au', 2],
        ['auth.woolworths.com.au', 1],
      ]),
    )
    expect(Object.keys(JSON.parse(text).hosts)).toEqual(['auth.woolworths.com.au', 'www.woolworths.com.au'])
    expect(parseBudgetFile(text)).toEqual(
      new Map([
        ['auth.woolworths.com.au', 1],
        ['www.woolworths.com.au', 2],
      ]),
    )
  })

  it('never takes a __proto__ host as a host, or as a prototype', () => {
    const parsed = parseBudgetFile('{"version":1,"hosts":{"__proto__":{"lastRequestAt":1}}}')
    expect(parsed?.size ?? 0).toBe(0)
    expect('lastRequestAt' in {}).toBe(false)
  })
})

describe('ToolHost: the rate budget across a restart', () => {
  const definition = defineAdapter({
    manifest,
    tools: {
      run_test: tool({
        input: z.object({}),
        output: z.number(),
        run: async (ctx) => (await ctx.page.fetch(`${HOME}/api/trolley`)).status,
      }),
    },
  })

  it('makes the first request after a restart wait out the gap since the last one before it', async () => {
    const budgetStore = new MemoryJsonStore()
    const before = fixture(definition, { budgetStore })
    expect(await before.host.call(call)).toEqual({ status: 'ok', output: 200 })
    expect(before.clock.paced).toEqual([])
    // Let the write land, as it would long before a restart.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(parseBudgetFile(budgetStore.text ?? '')).toEqual(
      new Map([['www.example.com', before.clock.now()]]),
    )

    // Same instant, a new process: the fixture's clock starts where the first one stood.
    const after = fixture(definition, { budgetStore })
    expect(await after.host.call({ ...call, callId: 'call-2' })).toEqual({ status: 'ok', output: 200 })
    expect(after.clock.paced).toEqual([manifest.limits.minGapMs])
    expect(after.page.toolFetches()).toHaveLength(1)
  })

  it('does not hold the first request when the app has never run', async () => {
    const { host, clock } = fixture(definition, { budgetStore: new MemoryJsonStore() })
    expect(await host.call(call)).toEqual({ status: 'ok', output: 200 })
    expect(clock.paced).toEqual([])
  })
})
