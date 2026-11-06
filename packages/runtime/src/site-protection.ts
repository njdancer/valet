// Protection for the sites themselves, and for our standing with them. The live Woolworths probe
// (docs/findings/2026-11-07-woolworths-live-probe.md) got Akamai's 403 "Access Denied" HTML after a
// handful of scripted fetches 2.5 s apart. So every request a tool makes to a site is paced by a
// per-site rate budget, and a block trips a per-site circuit breaker that stops all calls for a
// cooldown instead of hammering the site and deepening the block.

import { type FetchResult, SiteAdapterError } from '@siteadapter/core'
import type { Clock, Sleep } from './clock'

/** Spaces requests to one site at least `minGapMs` apart, in the order they ask. */
export class RateBudget {
  private nextSlot = Number.NEGATIVE_INFINITY

  constructor(
    private readonly minGapMs: number,
    private readonly clock: Clock,
    private readonly sleep: Sleep,
  ) {}

  /** Waits for this request's slot. An aborted wait still uses up its slot, erring on the slow side. */
  async acquire(signal?: AbortSignal): Promise<void> {
    const now = this.clock.now()
    const slot = Math.max(now, this.nextSlot)
    this.nextSlot = slot + this.minGapMs
    if (slot > now) await this.sleep(slot - now, signal)
  }
}

export interface BreakerOptions {
  /** Cooldown after the first block. Each block in a row doubles it, up to `maxCooldownMs`. */
  readonly cooldownMs: number
  readonly maxCooldownMs: number
}

export class SiteCircuitBreaker {
  private openUntil = 0
  private consecutiveTrips = 0

  constructor(
    private readonly clock: Clock,
    private readonly options: BreakerOptions,
  ) {}

  /** Milliseconds until calls may resume; 0 when closed. */
  retryAfterMs(): number {
    return Math.max(0, this.openUntil - this.clock.now())
  }

  isOpen(): boolean {
    return this.retryAfterMs() > 0
  }

  trip(): void {
    // Several in-flight requests can all come back blocked; that's one block, not several.
    if (this.isOpen()) return
    const cooldown = Math.min(
      this.options.maxCooldownMs,
      this.options.cooldownMs * 2 ** this.consecutiveTrips,
    )
    this.consecutiveTrips++
    this.openUntil = this.clock.now() + cooldown
  }

  /** A normal response from the site: the next block starts from the base cooldown again. */
  recordSuccess(): void {
    this.consecutiveTrips = 0
  }
}

export interface SiteGuards {
  readonly budget: RateBudget
  readonly breaker: SiteCircuitBreaker
}

export interface SiteProtectionOptions extends BreakerOptions {
  readonly minRequestGapMs: number
}

export const DEFAULT_SITE_PROTECTION: SiteProtectionOptions = {
  minRequestGapMs: 2_000,
  cooldownMs: 10 * 60_000,
  maxCooldownMs: 2 * 60 * 60_000,
}

/** One budget and breaker per site host, shared by every adapter and call for that site. */
export class SiteProtection {
  private readonly sites = new Map<string, SiteGuards>()

  constructor(
    private readonly clock: Clock,
    private readonly sleep: Sleep,
    private readonly options: SiteProtectionOptions = DEFAULT_SITE_PROTECTION,
  ) {}

  forSite(host: string): SiteGuards {
    const key = host.toLowerCase()
    let guards = this.sites.get(key)
    if (guards === undefined) {
      guards = {
        budget: new RateBudget(this.options.minRequestGapMs, this.clock, this.sleep),
        breaker: new SiteCircuitBreaker(this.clock, this.options),
      }
      this.sites.set(key, guards)
    }
    return guards
  }
}

/**
 * True for a response that looks like a bot-protection block: a 403 HTML page, or HTML where an API
 * answer was expected. Akamai serves its "Access Denied" page this way.
 */
export function looksBlocked(result: FetchResult, expectsJson: boolean): boolean {
  const html = isHtml(result)
  return html && (result.status === 403 || expectsJson)
}

function isHtml(result: FetchResult): boolean {
  if (result.contentType?.toLowerCase().includes('html')) return true
  return (
    typeof result.body === 'string' && /^\s*</.test(result.body) && !/json/i.test(result.contentType ?? '')
  )
}

export function blockedBySite(): SiteAdapterError {
  return new SiteAdapterError('tool-run', 'blocked-by-site')
}
