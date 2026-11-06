import { describe, expect, it } from 'vitest'
import { RateLimiter } from '../src/rate-limit'

const limit = { maxRequests: 3, windowMs: 1000, cooldownMs: 5000 }

describe('RateLimiter', () => {
  it('allows up to maxRequests inside the window', () => {
    let now = 0
    const limiter = new RateLimiter(limit, () => now)
    for (let i = 0; i < 3; i++) {
      expect(limiter.hit('a')).toBe(false)
      now += 100
    }
    expect(limiter.isBlocked('a')).toBe(false)
  })

  it('blocks on the request after maxRequests', () => {
    let now = 0
    const limiter = new RateLimiter(limit, () => now)
    for (let i = 0; i < 3; i++) limiter.hit('a')
    now = 10
    expect(limiter.hit('a')).toBe(true)
    expect(limiter.isBlocked('a')).toBe(true)
  })

  it('forgets requests older than the window', () => {
    let now = 0
    const limiter = new RateLimiter(limit, () => now)
    for (let i = 0; i < 3; i++) limiter.hit('a')
    now = 1000
    expect(limiter.hit('a')).toBe(false)
  })

  it('keeps sessions separate', () => {
    const limiter = new RateLimiter(limit, () => 0)
    for (let i = 0; i < 4; i++) limiter.hit('a')
    expect(limiter.isBlocked('a')).toBe(true)
    expect(limiter.isBlocked('b')).toBe(false)
    expect(limiter.hit('b')).toBe(false)
  })

  it('lifts the block after the cool-down and starts counting afresh', () => {
    let now = 0
    const limiter = new RateLimiter(limit, () => now)
    for (let i = 0; i < 4; i++) limiter.hit('a')
    now = 4999
    expect(limiter.isBlocked('a')).toBe(true)
    now = 5000
    expect(limiter.isBlocked('a')).toBe(false)
    expect(limiter.hit('a')).toBe(false)
  })

  it('does nothing without a limit', () => {
    const limiter = new RateLimiter(null, () => 0)
    for (let i = 0; i < 1000; i++) expect(limiter.hit('a')).toBe(false)
  })

  it('clears blocks and history when the limit changes', () => {
    const limiter = new RateLimiter(limit, () => 0)
    for (let i = 0; i < 4; i++) limiter.hit('a')
    limiter.setLimit({ maxRequests: 1, windowMs: 1000, cooldownMs: 1000 })
    expect(limiter.isBlocked('a')).toBe(false)
    expect(limiter.hit('a')).toBe(false)
    expect(limiter.hit('a')).toBe(true)
    limiter.setLimit(null)
    expect(limiter.isBlocked('a')).toBe(false)
    expect(limiter.hit('a')).toBe(false)
  })
})
