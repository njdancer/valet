import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type AuditEvent, SiteAdapterError } from '@siteadapter/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JsonFileStore, parseBreakerFile, serialiseBreakerFile } from '../src/breaker-state'
import {
  blockCause,
  breakerRefusal,
  isSiteRefusal,
  RateBudget,
  SiteCircuitBreaker,
  SiteProtection,
  siteRefusal,
} from '../src/site-protection'
import type { RuntimeDiagnostic } from '../src/types'
import { MemoryJsonStore } from './fakes'

const START = Date.UTC(2026, 10, 7, 9, 0, 0)
const LIMITS = { minGapMs: 2_000, cooldownSeconds: 60, maxCooldownSeconds: 200 }

describe('RateBudget', () => {
  it('lets the first request through at once and spaces the rest', async () => {
    let now = 1_000
    const slept: number[] = []
    const clock = { now: () => now }
    const sleep = async (ms: number) => {
      slept.push(ms)
      now += ms
    }
    const budget = new RateBudget(2_000, clock, sleep)

    await budget.acquire()
    await budget.acquire()
    await budget.acquire()
    expect(slept).toEqual([2_000, 2_000])
  })

  it('does not wait when the gap has already passed', async () => {
    let now = 1_000
    const slept: number[] = []
    const budget = new RateBudget(2_000, { now: () => now }, async (ms) => {
      slept.push(ms)
    })

    await budget.acquire()
    now += 5_000
    await budget.acquire()
    expect(slept).toEqual([])
  })

  it('gives concurrent requests successive slots', async () => {
    const slept: number[] = []
    const budget = new RateBudget(500, { now: () => 0 }, async (ms) => {
      slept.push(ms)
    })

    await Promise.all([budget.acquire(), budget.acquire(), budget.acquire()])
    expect(slept).toEqual([500, 1_000])
  })

  it('passes the abort signal to the sleep', async () => {
    const signals: (AbortSignal | undefined)[] = []
    const budget = new RateBudget(500, { now: () => 0 }, async (_ms, signal) => {
      signals.push(signal)
    })
    const controller = new AbortController()

    await budget.acquire(controller.signal)
    await budget.acquire(controller.signal)
    expect(signals).toEqual([controller.signal])
  })

  it('widens its gap but never narrows it', () => {
    const budget = new RateBudget(2_000, { now: () => 0 }, async () => {})
    budget.widen(10_000)
    budget.widen(250)
    expect(budget.gapMs).toBe(10_000)
  })
})

describe('SiteCircuitBreaker', () => {
  const options = { cooldownMs: 60_000, maxCooldownMs: 200_000 }

  it('starts closed', () => {
    const breaker = new SiteCircuitBreaker({ now: () => 0 }, options)
    expect(breaker.isOpen()).toBe(false)
    expect(breaker.retryAfterMs()).toBe(0)
    expect(breaker.snapshot()).toBeNull()
  })

  it('opens for the cooldown when tripped, then closes', () => {
    let now = 0
    const breaker = new SiteCircuitBreaker({ now: () => now }, options)
    breaker.trip('blocked-by-site', 'call-1')

    expect(breaker.isOpen()).toBe(true)
    expect(breaker.retryAfterMs()).toBe(60_000)
    now = 59_999
    expect(breaker.retryAfterMs()).toBe(1)
    now = 60_000
    expect(breaker.isOpen()).toBe(false)
  })

  it('doubles the cooldown for blocks in a row, up to the maximum', () => {
    let now = 0
    const breaker = new SiteCircuitBreaker({ now: () => now }, options)
    const cooldowns: number[] = []
    for (let i = 0; i < 4; i++) {
      breaker.trip('blocked-by-site', null)
      cooldowns.push(breaker.retryAfterMs())
      now += breaker.retryAfterMs()
    }
    expect(cooldowns).toEqual([60_000, 120_000, 200_000, 200_000])
  })

  it('counts trips while already open as the same block', () => {
    let now = 0
    const opened = vi.fn()
    const breaker = new SiteCircuitBreaker({ now: () => now }, options, {
      opened,
      closed: () => {},
      changed: () => {},
    })
    breaker.trip('blocked-by-site', null)
    breaker.trip('rate-limited', null)
    breaker.trip('blocked-by-site', null)
    expect(breaker.retryAfterMs()).toBe(60_000)
    expect(opened).toHaveBeenCalledTimes(1)

    now = 60_000
    breaker.trip('blocked-by-site', null)
    expect(breaker.retryAfterMs()).toBe(120_000)
  })

  it('reports opening with its cause, retry time and call, and closing on the next normal answer', () => {
    let now = 1_000
    const events: unknown[] = []
    const breaker = new SiteCircuitBreaker({ now: () => now }, options, {
      opened: (cause, retryAt, callId) => events.push(['opened', cause, retryAt, callId]),
      closed: () => events.push(['closed']),
      changed: () => events.push(['changed']),
    })
    breaker.trip('rate-limited', 'call-7')
    now = 61_000
    breaker.recordSuccess()
    breaker.recordSuccess()

    expect(events).toEqual([
      ['changed'],
      ['opened', 'rate-limited', 61_000, 'call-7'],
      ['changed'],
      ['closed'],
    ])
  })

  it('starts again from the base cooldown after a success', () => {
    let now = 0
    const breaker = new SiteCircuitBreaker({ now: () => now }, options)
    breaker.trip('blocked-by-site', null)
    now = 60_000
    breaker.recordSuccess()
    breaker.trip('blocked-by-site', null)
    expect(breaker.retryAfterMs()).toBe(60_000)
  })

  it('remembers a run of blocks after the cooldown passes, until a normal answer', () => {
    let now = 0
    const breaker = new SiteCircuitBreaker({ now: () => now }, options)
    breaker.trip('blocked-by-site', null)
    now = 60_000
    expect(breaker.snapshot()).toEqual({ retryAt: 60_000, cooldownMs: 60_000 })
    breaker.recordSuccess()
    expect(breaker.snapshot()).toBeNull()
  })

  it('restores persisted state, carrying the run of blocks forward', () => {
    let now = 0
    const breaker = new SiteCircuitBreaker({ now: () => now }, options)
    breaker.restore({ retryAt: 30_000, cooldownMs: 60_000 })

    expect(breaker.retryAfterMs()).toBe(30_000)
    now = 30_000
    breaker.trip('blocked-by-site', null)
    expect(breaker.retryAfterMs()).toBe(120_000)
  })

  it('never trusts a persisted retry time or cooldown beyond its maximum', () => {
    const breaker = new SiteCircuitBreaker({ now: () => 0 }, options)
    breaker.restore({ retryAt: 10 * 365 * 24 * 60 * 60_000, cooldownMs: 999_999_999 })

    expect(breaker.retryAfterMs()).toBe(200_000)
    expect(breaker.snapshot()).toEqual({ retryAt: 200_000, cooldownMs: 200_000 })
  })

  it('fails closed for the base cooldown without counting it as a block', () => {
    let now = 5_000
    const opened = vi.fn()
    const breaker = new SiteCircuitBreaker({ now: () => now }, options, {
      opened,
      closed: () => {},
      changed: () => {},
    })
    breaker.failClosed(1_000)

    expect(breaker.retryAfterMs()).toBe(56_000)
    expect(opened).not.toHaveBeenCalled()
    now = 61_000
    breaker.trip('blocked-by-site', null)
    expect(breaker.retryAfterMs()).toBe(60_000)
  })

  it('widens its cooldowns but never narrows them', () => {
    const breaker = new SiteCircuitBreaker({ now: () => 0 }, options)
    breaker.widen({ cooldownMs: 600_000, maxCooldownMs: 7_200_000 })
    breaker.widen({ cooldownMs: 1, maxCooldownMs: 1 })
    breaker.trip('blocked-by-site', null)
    expect(breaker.retryAfterMs()).toBe(600_000)
  })
})

describe('SiteProtection', () => {
  function protection(store = new MemoryJsonStore(), now = () => START) {
    const audit: AuditEvent[] = []
    const diagnostics: RuntimeDiagnostic[] = []
    const site = new SiteProtection({ now }, async () => {}, {
      store,
      audit: async (event) => {
        audit.push(event)
      },
      diagnostics: (diagnostic) => diagnostics.push(diagnostic),
    })
    return { site, store, audit, diagnostics }
  }

  it('shares guards per host, case-insensitively', () => {
    const { site } = protection()
    const a = site.forSite('www.woolworths.com.au', LIMITS)
    expect(site.forSite('WWW.Woolworths.com.au', LIMITS)).toBe(a)
    expect(site.forSite('www.coles.com.au', LIMITS)).not.toBe(a)
  })

  it('takes the most cautious limits of every adapter on a host', () => {
    const { site } = protection()
    const guards = site.forSite('www.woolworths.com.au', LIMITS)
    site.forSite('www.woolworths.com.au', {
      minGapMs: 10_000,
      cooldownSeconds: 1_800,
      maxCooldownSeconds: 21_600,
    })
    site.forSite('www.woolworths.com.au', { minGapMs: 250, cooldownSeconds: 60, maxCooldownSeconds: 60 })

    expect(guards.budget.gapMs).toBe(10_000)
    guards.breaker.trip('blocked-by-site', null)
    expect(guards.breaker.retryAfterMs()).toBe(1_800_000)
  })

  it('audits breaker-opened with the host, cause, retry time and call, and breaker-closed', async () => {
    let now = START
    const { site, audit } = protection(new MemoryJsonStore(), () => now)
    await site.ready()
    const guards = site.forSite('www.woolworths.com.au', LIMITS)
    guards.breaker.trip('blocked-by-site', 'call-1')
    now += 60_000
    guards.breaker.recordSuccess()

    expect(audit).toEqual([
      {
        type: 'breaker-opened',
        host: 'www.woolworths.com.au',
        cause: 'blocked-by-site',
        retryAt: new Date(START + 60_000).toISOString(),
        callId: 'call-1',
      },
      { type: 'breaker-closed', host: 'www.woolworths.com.au' },
    ])
  })

  it('persists a trip, so a restart straight after it stays open', async () => {
    const store = new MemoryJsonStore()
    const first = protection(store)
    await first.site.ready()
    first.site.forSite('www.woolworths.com.au', LIMITS).breaker.trip('blocked-by-site', 'call-1')
    await first.site.flushed()

    const restarted = protection(store, () => START + 20_000)
    const guards = restarted.site.forSite('www.woolworths.com.au', LIMITS)
    await restarted.site.ready()
    expect(guards.breaker.retryAfterMs()).toBe(40_000)
  })

  it('applies persisted state to a host registered after loading', async () => {
    const store = new MemoryJsonStore()
    store.text = serialiseBreakerFile(
      new Map([['www.woolworths.com.au', { retryAt: START + 5_000, cooldownMs: 60_000 }]]),
    )
    const { site } = protection(store)
    await site.ready()

    expect(site.forSite('www.woolworths.com.au', LIMITS).breaker.retryAfterMs()).toBe(5_000)
  })

  it('carries the run of blocks across a restart, so the next block doubles', async () => {
    const store = new MemoryJsonStore()
    store.text = serialiseBreakerFile(
      new Map([['www.woolworths.com.au', { retryAt: START - 1, cooldownMs: 60_000 }]]),
    )
    const { site } = protection(store)
    await site.ready()
    const guards = site.forSite('www.woolworths.com.au', LIMITS)

    expect(guards.breaker.isOpen()).toBe(false)
    guards.breaker.trip('blocked-by-site', null)
    expect(guards.breaker.retryAfterMs()).toBe(120_000)
  })

  it('forgets a host once it answers normally, and keeps hosts no adapter registered this run', async () => {
    let now = START
    const store = new MemoryJsonStore()
    store.text = serialiseBreakerFile(
      new Map([['www.coles.com.au', { retryAt: START + 1_000, cooldownMs: 60_000 }]]),
    )
    const { site } = protection(store, () => now)
    await site.ready()
    const guards = site.forSite('www.woolworths.com.au', LIMITS)
    guards.breaker.trip('rate-limited', null)
    await site.flushed()
    expect([...(parseBreakerFile(store.text ?? '') ?? new Map()).keys()]).toEqual([
      'www.coles.com.au',
      'www.woolworths.com.au',
    ])

    now += 60_000
    guards.breaker.recordSuccess()
    await site.flushed()
    expect([...(parseBreakerFile(store.text ?? '') ?? new Map()).keys()]).toEqual(['www.coles.com.au'])
  })

  for (const [name, text] of [
    ['not JSON', '{"version":1,"hosts":{'],
    ['the wrong version', '{"version":2,"hosts":{}}'],
    ['an extra field', '{"version":1,"hosts":{},"note":"x"}'],
    ['a negative retry time', '{"version":1,"hosts":{"www.example.com":{"retryAt":-1,"cooldownMs":0}}}'],
    ['a host that is not a hostname', '{"version":1,"hosts":{"WWW Example":{"retryAt":1,"cooldownMs":0}}}'],
  ] as const) {
    it(`fails closed on a file with ${name}: every host is open for its cooldown`, async () => {
      const store = new MemoryJsonStore()
      store.text = text
      const { site, diagnostics, audit } = protection(store)
      const early = site.forSite('www.woolworths.com.au', LIMITS)
      await site.ready()
      const late = site.forSite('www.coles.com.au', { ...LIMITS, cooldownSeconds: 120 })

      expect(early.breaker.retryAfterMs()).toBe(60_000)
      expect(late.breaker.retryAfterMs()).toBe(120_000)
      expect(diagnostics).toEqual([{ type: 'breaker-state-unreadable' }])
      expect(audit).toEqual([])
      expect(store.writes).toEqual([])
    })
  }

  it('fails closed when the store cannot be read', async () => {
    const store = new MemoryJsonStore()
    store.failRead = true
    const { site, diagnostics } = protection(store)
    await site.ready()

    expect(site.forSite('www.woolworths.com.au', LIMITS).breaker.isOpen()).toBe(true)
    expect(diagnostics).toEqual([{ type: 'breaker-state-unreadable' }])
  })

  it('writes a fail-closed hold with the next change, so a second restart does not cut it short', async () => {
    let now = START
    const store = new MemoryJsonStore()
    store.text = 'garbage'
    const { site } = protection(store, () => now)
    const woolworths = site.forSite('www.woolworths.com.au', LIMITS)
    const coles = site.forSite('www.coles.com.au', LIMITS)
    await site.ready()
    now += 60_000
    coles.breaker.trip('blocked-by-site', null)
    now -= 60_000
    await site.flushed()

    expect(woolworths.breaker.isOpen()).toBe(true)
    expect(parseBreakerFile(store.text ?? '')?.get('www.woolworths.com.au')).toEqual({
      retryAt: START + 60_000,
      cooldownMs: 0,
    })
  })

  it('loads once, however often it is asked', async () => {
    const store = new MemoryJsonStore()
    const read = vi.spyOn(store, 'read')
    const { site } = protection(store)
    await Promise.all([site.ready(), site.ready()])
    await site.ready()
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('never writes before the stored state has been read', async () => {
    const store = new MemoryJsonStore()
    store.text = serialiseBreakerFile(
      new Map([['www.coles.com.au', { retryAt: START + 1_000, cooldownMs: 60_000 }]]),
    )
    const { site } = protection(store)
    site.forSite('www.woolworths.com.au', LIMITS).breaker.trip('blocked-by-site', null)
    await site.flushed()

    expect(parseBreakerFile(store.text ?? '')?.has('www.coles.com.au')).toBe(true)
  })

  it('keeps the breaker in memory and reports it when a write fails', async () => {
    const store = new MemoryJsonStore()
    store.failWrite = true
    const { site, diagnostics } = protection(store)
    await site.ready()
    const guards = site.forSite('www.woolworths.com.au', LIMITS)
    guards.breaker.trip('blocked-by-site', null)
    await site.flushed()

    expect(guards.breaker.isOpen()).toBe(true)
    expect(diagnostics).toEqual([{ type: 'breaker-state-write-failed' }])
  })
})

describe('breaker state file', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'siteadapter-breakers-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('reads null before anything is written, then what was written, atomically', async () => {
    const store = new JsonFileStore(join(dir, 'breakers.json'))
    expect(await store.read()).toBeNull()
    await store.write('{"version":1,"hosts":{}}\n')
    expect(await store.read()).toBe('{"version":1,"hosts":{}}\n')
    expect(await readdir(dir)).toEqual(['breakers.json'])
  })

  it('throws when the file exists but cannot be read', async () => {
    await writeFile(join(dir, 'breakers.json'), '')
    const store = new JsonFileStore(dir)
    await expect(store.read()).rejects.toThrow()
  })

  it('round-trips state, sorted by host', () => {
    const text = serialiseBreakerFile(
      new Map([
        ['www.woolworths.com.au', { retryAt: 2, cooldownMs: 60_000 }],
        ['auth.woolworths.com.au', { retryAt: 1, cooldownMs: 0 }],
      ]),
    )
    expect(Object.keys(JSON.parse(text).hosts)).toEqual(['auth.woolworths.com.au', 'www.woolworths.com.au'])
    expect(parseBreakerFile(text)).toEqual(
      new Map([
        ['auth.woolworths.com.au', { retryAt: 1, cooldownMs: 0 }],
        ['www.woolworths.com.au', { retryAt: 2, cooldownMs: 60_000 }],
      ]),
    )
  })

  it('never takes a __proto__ host as a host, or as a prototype', () => {
    const parsed = parseBreakerFile('{"version":1,"hosts":{"__proto__":{"retryAt":1,"cooldownMs":0}}}')
    expect(parsed?.size ?? 0).toBe(0)
    expect(Object.getPrototypeOf({})).toBe(Object.prototype)
    expect('retryAt' in {}).toBe(false)
  })
})

describe('blockCause', () => {
  it('flags a 403 HTML page, as Akamai serves it', () => {
    expect(blockCause({ status: 403, contentType: 'text/html; charset=utf-8', body: '<html>' })).toBe(
      'blocked-by-site',
    )
  })

  it('flags Akamai’s Access Denied page whatever its status', () => {
    expect(
      blockCause({
        status: 200,
        contentType: null,
        body: '<HTML><TITLE>Access Denied</TITLE>Reference #18.2f1</HTML>',
      }),
    ).toBe('blocked-by-site')
  })

  it('flags a 429, whatever its body, as rate-limited', () => {
    expect(blockCause({ status: 429, contentType: 'application/json', body: {} })).toBe('rate-limited')
  })

  it('does not flag an ordinary HTML error page', () => {
    expect(blockCause({ status: 404, contentType: 'text/html', body: '<html>Not found</html>' })).toBeNull()
    expect(blockCause({ status: 500, contentType: null, body: '  <!DOCTYPE html>' })).toBeNull()
  })

  it('does not flag an HTML page that mentions only one Akamai marker', () => {
    expect(
      blockCause({ status: 200, contentType: 'text/html', body: '<p>Access denied to aisle 4</p>' }),
    ).toBeNull()
  })

  it('does not flag a JSON 403, which is the API saying no', () => {
    expect(blockCause({ status: 403, contentType: 'application/json', body: { error: 'x' } })).toBeNull()
  })

  it('does not flag a JSON string that happens to start with <', () => {
    expect(blockCause({ status: 403, contentType: 'application/json', body: '<b>' })).toBeNull()
  })

  it('does not flag a normal JSON answer', () => {
    expect(blockCause({ status: 200, contentType: 'application/json', body: {} })).toBeNull()
  })
})

describe('refusals', () => {
  it('reports the site’s refusal by its cause, and our breaker’s as rate-limited', () => {
    expect(siteRefusal('blocked-by-site')).toMatchObject({ stage: 'tool-run', errorClass: 'blocked-by-site' })
    expect(siteRefusal('rate-limited')).toMatchObject({ stage: 'tool-run', errorClass: 'rate-limited' })
    expect(breakerRefusal()).toMatchObject({ stage: 'tool-run', errorClass: 'rate-limited' })
  })

  it('recognises only those two classes as site refusals', () => {
    expect(isSiteRefusal(siteRefusal('blocked-by-site'))).toBe(true)
    expect(isSiteRefusal(breakerRefusal())).toBe(true)
    expect(isSiteRefusal(new SiteAdapterError('tool-run', 'internal'))).toBe(false)
    expect(isSiteRefusal({ errorClass: 'blocked-by-site' })).toBe(false)
  })
})
