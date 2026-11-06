// Per-session rate limiting, modelled on what happened live: a burst of scripted API calls got the
// session blocked outright, pages included, for a cool-down.

export interface RateLimit {
  /** More than this many API requests inside `windowMs` blocks the session. */
  readonly maxRequests: number
  readonly windowMs: number
  /** How long a blocked session stays blocked. */
  readonly cooldownMs: number
}

export class RateLimiter {
  private readonly hits = new Map<string, number[]>()
  private readonly blockedUntil = new Map<string, number>()

  constructor(
    private limit: RateLimit | null,
    private readonly now: () => number,
  ) {}

  /** Replaces the limit and forgets every session's history and blocks. Null turns limiting off. */
  setLimit(limit: RateLimit | null): void {
    this.limit = limit
    this.hits.clear()
    this.blockedUntil.clear()
  }

  isBlocked(key: string): boolean {
    const until = this.blockedUntil.get(key)
    if (until === undefined) return false
    if (this.now() < until) return true
    this.blockedUntil.delete(key)
    this.hits.delete(key)
    return false
  }

  /** Counts one API request. Returns true when this request tips the session into a block. */
  hit(key: string): boolean {
    if (this.limit === null) return false
    const { maxRequests, windowMs, cooldownMs } = this.limit
    const now = this.now()
    const recent = (this.hits.get(key) ?? []).filter((at) => now - at < windowMs)
    recent.push(now)
    this.hits.set(key, recent)
    if (recent.length <= maxRequests) return false
    this.blockedUntil.set(key, now + cooldownMs)
    return true
  }
}
