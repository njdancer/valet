import { describe, expect, it } from 'vitest'
import {
  blockedBySite,
  DEFAULT_SITE_PROTECTION,
  looksBlocked,
  RateBudget,
  SiteCircuitBreaker,
  SiteProtection,
} from '../src/site-protection'

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
})

describe('SiteCircuitBreaker', () => {
  const options = { cooldownMs: 60_000, maxCooldownMs: 200_000 }

  it('starts closed', () => {
    const breaker = new SiteCircuitBreaker({ now: () => 0 }, options)
    expect(breaker.isOpen()).toBe(false)
    expect(breaker.retryAfterMs()).toBe(0)
  })

  it('opens for the cooldown when tripped, then closes', () => {
    let now = 0
    const breaker = new SiteCircuitBreaker({ now: () => now }, options)
    breaker.trip()

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
      breaker.trip()
      cooldowns.push(breaker.retryAfterMs())
      now += breaker.retryAfterMs()
    }
    expect(cooldowns).toEqual([60_000, 120_000, 200_000, 200_000])
  })

  it('counts trips while already open as the same block', () => {
    let now = 0
    const breaker = new SiteCircuitBreaker({ now: () => now }, options)
    breaker.trip()
    breaker.trip()
    breaker.trip()
    expect(breaker.retryAfterMs()).toBe(60_000)

    now = 60_000
    breaker.trip()
    expect(breaker.retryAfterMs()).toBe(120_000)
  })

  it('starts again from the base cooldown after a success', () => {
    let now = 0
    const breaker = new SiteCircuitBreaker({ now: () => now }, options)
    breaker.trip()
    now = 60_000
    breaker.recordSuccess()
    breaker.trip()
    expect(breaker.retryAfterMs()).toBe(60_000)
  })
})

describe('SiteProtection', () => {
  it('shares guards per host, case-insensitively', () => {
    const protection = new SiteProtection({ now: () => 0 }, async () => {})
    const a = protection.forSite('www.woolworths.com.au')
    expect(protection.forSite('WWW.Woolworths.com.au')).toBe(a)
    expect(protection.forSite('www.coles.com.au')).not.toBe(a)
  })

  it('uses conservative defaults', () => {
    expect(DEFAULT_SITE_PROTECTION.minRequestGapMs).toBeGreaterThanOrEqual(1_000)
    expect(DEFAULT_SITE_PROTECTION.cooldownMs).toBeGreaterThanOrEqual(60_000)
  })
})

describe('looksBlocked', () => {
  it('flags a 403 HTML page, as Akamai serves it', () => {
    expect(looksBlocked({ status: 403, contentType: 'text/html; charset=utf-8', body: '<html>' })).toBe(true)
  })

  it('flags Akamai’s Access Denied page whatever its status', () => {
    expect(
      looksBlocked({
        status: 200,
        contentType: null,
        body: '<HTML><TITLE>Access Denied</TITLE>Reference #18.2f1</HTML>',
      }),
    ).toBe(true)
  })

  it('flags a 429, whatever its body', () => {
    expect(looksBlocked({ status: 429, contentType: 'application/json', body: {} })).toBe(true)
  })

  it('does not flag an ordinary HTML error page', () => {
    expect(looksBlocked({ status: 404, contentType: 'text/html', body: '<html>Not found</html>' })).toBe(
      false,
    )
    expect(looksBlocked({ status: 500, contentType: null, body: '  <!DOCTYPE html>' })).toBe(false)
  })

  it('does not flag an HTML page that mentions only one Akamai marker', () => {
    expect(
      looksBlocked({ status: 200, contentType: 'text/html', body: '<p>Access denied to aisle 4</p>' }),
    ).toBe(false)
  })

  it('does not flag a JSON 403, which is the API saying no', () => {
    expect(looksBlocked({ status: 403, contentType: 'application/json', body: { error: 'x' } })).toBe(false)
  })

  it('does not flag a JSON string that happens to start with <', () => {
    expect(looksBlocked({ status: 403, contentType: 'application/json', body: '<b>' })).toBe(false)
  })

  it('does not flag a normal JSON answer', () => {
    expect(looksBlocked({ status: 200, contentType: 'application/json', body: {} })).toBe(false)
  })
})

describe('blockedBySite', () => {
  it('is a tool-run blocked-by-site error', () => {
    expect(blockedBySite()).toMatchObject({ stage: 'tool-run', errorClass: 'blocked-by-site' })
  })
})
