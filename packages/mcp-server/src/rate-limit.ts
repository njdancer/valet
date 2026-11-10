// Sliding-window counters for the remote listener's pre-consent endpoints (relay.md, "Before
// consent: fetching and limits"). Everything here is in memory: a restart forgets the counts, which
// costs an attacker nothing they couldn't get by waiting, and keeps nothing on disk about strangers.

export interface WindowLimit {
  /** Requests allowed within one window. */
  readonly limit: number
  readonly windowMs: number
}

/** The most keys one limiter tracks. Past it the oldest key is forgotten, never the global count. */
const MAX_KEYS = 4096

export class SlidingWindow {
  private readonly hits = new Map<string, number[]>()

  constructor(
    private readonly rule: WindowLimit,
    private readonly now: () => number = Date.now,
  ) {}

  /** Counts one request for `key` if it fits. False when the key has used its window. */
  take(key: string): boolean {
    const now = this.now()
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.rule.windowMs)
    this.hits.delete(key)
    if (recent.length >= this.rule.limit) {
      this.hits.set(key, recent)
      return false
    }
    recent.push(now)
    this.hits.set(key, recent)
    while (this.hits.size > MAX_KEYS) this.hits.delete(this.hits.keys().next().value as string)
    return true
  }

  /** True when `key` has room for one more, without counting it. */
  hasRoom(key: string): boolean {
    const now = this.now()
    return (this.hits.get(key) ?? []).filter((t) => now - t < this.rule.windowMs).length < this.rule.limit
  }
}

/**
 * A per-source limit and a global one, checked together: a request counts against both or neither.
 * A request whose source is unknown counts against the global limit alone.
 */
export class SourceLimits {
  private readonly perSource: SlidingWindow
  private readonly global: SlidingWindow

  constructor(perSource: WindowLimit, global: WindowLimit, now: () => number = Date.now) {
    this.perSource = new SlidingWindow(perSource, now)
    this.global = new SlidingWindow(global, now)
  }

  take(source: string | null): boolean {
    if (!this.global.hasRoom('*')) return false
    if (source !== null && !this.perSource.take(source)) return false
    return this.global.take('*')
  }
}
