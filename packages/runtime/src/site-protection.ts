// Protection for the sites themselves, and for our standing with them. The live Woolworths probe
// (docs/findings/2026-11-07-woolworths-live-probe.md) got Akamai's 403 "Access Denied" HTML after a
// handful of scripted fetches 2.5 s apart. So every request the runtime or a tool makes to a site is
// paced by a per-site rate budget, and a block trips a per-site circuit breaker that stops all calls
// for a cooldown instead of hammering the site and deepening the block.
//
// The numbers come from each adapter's manifest.limits. Adapters that share a host share its budget
// and breaker, which take the most cautious numbers any of them declares. Breaker state is persisted
// (see breaker-state.ts) so a restart doesn't forget a block.

import { type AdapterManifest, type AuditEvent, type FetchResult, SiteAdapterError } from '@siteadapter/core'
import { type BreakerState, type JsonStore, parseBreakerFile, serialiseBreakerFile } from './breaker-state'
import type { Clock, Sleep } from './clock'
import type { RuntimeDiagnostic } from './types'

/** Why the site refused us: its bot protection, or a 429. */
export type BlockCause = 'blocked-by-site' | 'rate-limited'

/** Spaces requests to one site at least `minGapMs` apart, in the order they ask. */
export class RateBudget {
  private nextSlot = Number.NEGATIVE_INFINITY

  constructor(
    private minGapMs: number,
    private readonly clock: Clock,
    private readonly sleep: Sleep,
  ) {}

  get gapMs(): number {
    return this.minGapMs
  }

  /** Raises the gap; never lowers it. */
  widen(minGapMs: number): void {
    this.minGapMs = Math.max(this.minGapMs, minGapMs)
  }

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

/** What a breaker tells its owner. None of these may throw. */
export interface BreakerEvents {
  opened(cause: BlockCause, retryAt: number, callId: string | null): void
  closed(): void
  /** Its state changed and should be persisted; see snapshot(). */
  changed(): void
}

export class SiteCircuitBreaker {
  private openUntil = 0
  /** The cooldown applied by the current run of blocks; 0 after a normal answer. */
  private cooldown = 0
  private options: BreakerOptions

  constructor(
    private readonly clock: Clock,
    options: BreakerOptions,
    private readonly events: BreakerEvents = { opened: () => {}, closed: () => {}, changed: () => {} },
  ) {
    this.options = { ...options }
  }

  /** Raises the cooldowns; never lowers them. */
  widen(options: BreakerOptions): void {
    this.options = {
      cooldownMs: Math.max(this.options.cooldownMs, options.cooldownMs),
      maxCooldownMs: Math.max(this.options.maxCooldownMs, options.maxCooldownMs),
    }
  }

  /** Milliseconds until calls may resume; 0 when closed. */
  retryAfterMs(): number {
    return Math.max(0, this.openUntil - this.clock.now())
  }

  isOpen(): boolean {
    return this.retryAfterMs() > 0
  }

  trip(cause: BlockCause, callId: string | null): void {
    // Several in-flight requests can all come back blocked; that's one block, not several.
    if (this.isOpen()) return
    const { cooldownMs, maxCooldownMs } = this.options
    this.cooldown = Math.min(maxCooldownMs, this.cooldown === 0 ? cooldownMs : this.cooldown * 2)
    this.openUntil = this.clock.now() + this.cooldown
    this.events.changed()
    this.events.opened(cause, this.openUntil, callId)
  }

  /** A normal response from the site: the next block starts from the base cooldown again. */
  recordSuccess(): void {
    if (this.cooldown === 0) return
    this.cooldown = 0
    this.events.changed()
    this.events.closed()
  }

  /** The state worth persisting, or null when it is closed with no run of blocks behind it. */
  snapshot(): BreakerState | null {
    if (this.cooldown === 0 && !this.isOpen()) return null
    return { retryAt: this.openUntil, cooldownMs: this.cooldown }
  }

  /** Takes up state from an earlier run of the app, never trusting it to be longer than our maximum. */
  restore(state: BreakerState): void {
    const { maxCooldownMs } = this.options
    this.cooldown = Math.min(state.cooldownMs, maxCooldownMs)
    // A retry time further out than our longest cooldown is a clock jump or a hand edit.
    this.openUntil = Math.max(this.openUntil, Math.min(state.retryAt, this.clock.now() + maxCooldownMs))
  }

  /**
   * Stays open for the base cooldown from `since`, without counting it as a block: used when the
   * persisted state could not be read, so we can't know whether the site blocked us.
   */
  failClosed(since: number): void {
    this.openUntil = Math.max(this.openUntil, since + this.options.cooldownMs)
  }
}

export interface SiteGuards {
  readonly budget: RateBudget
  readonly breaker: SiteCircuitBreaker
}

export interface SiteProtectionOptions {
  /** Where breaker state survives restarts. */
  readonly store: JsonStore
  /** Appends an audit event. Must not throw. */
  readonly audit: (event: AuditEvent) => Promise<void>
  readonly diagnostics: (diagnostic: RuntimeDiagnostic) => void
}

/** The parts of manifest.limits that pace and guard a site. */
export type SiteLimits = Pick<
  AdapterManifest['limits'],
  'minGapMs' | 'cooldownSeconds' | 'maxCooldownSeconds'
>

/** One budget and breaker per site host, shared by every adapter and call for that site. */
export class SiteProtection {
  private readonly sites = new Map<string, SiteGuards>()
  /** What was on disk when loaded. Kept so hosts no adapter registered this run aren't forgotten. */
  private readonly stored = new Map<string, BreakerState>()
  private loading: Promise<void> | null = null
  private loaded = false
  /** Set when the stored state couldn't be read: every host stays closed until this plus its cooldown. */
  private failClosedSince: number | null = null
  private writes: Promise<void> = Promise.resolve()

  constructor(
    private readonly clock: Clock,
    private readonly sleep: Sleep,
    private readonly options: SiteProtectionOptions,
  ) {}

  /**
   * The guards for `host`, widened to `limits`. Usable at once; call ready() before trusting the
   * breaker, so that state persisted by an earlier run is in force.
   */
  forSite(host: string, limits: SiteLimits): SiteGuards {
    const key = host.toLowerCase()
    const breakerOptions = {
      cooldownMs: limits.cooldownSeconds * 1000,
      maxCooldownMs: limits.maxCooldownSeconds * 1000,
    }
    let guards = this.sites.get(key)
    if (guards === undefined) {
      guards = {
        budget: new RateBudget(limits.minGapMs, this.clock, this.sleep),
        breaker: new SiteCircuitBreaker(this.clock, breakerOptions, this.eventsFor(key)),
      }
      this.sites.set(key, guards)
      if (this.loaded) this.applyStored(key, guards.breaker)
    } else {
      guards.budget.widen(limits.minGapMs)
      guards.breaker.widen(breakerOptions)
    }
    return guards
  }

  /** Loads the persisted breaker state, once. Never rejects. */
  ready(): Promise<void> {
    this.loading ??= this.load()
    return this.loading
  }

  /** Resolves once every state change so far has been written (or has failed to be). */
  flushed(): Promise<void> {
    return this.writes
  }

  private async load(): Promise<void> {
    let stored: Map<string, BreakerState> | null
    try {
      const text = await this.options.store.read()
      stored = text === null ? new Map() : parseBreakerFile(text)
    } catch {
      stored = null
    }
    if (stored === null) {
      // We can't tell whether a site blocked us just before the restart, so assume it did.
      this.failClosedSince = this.clock.now()
      this.options.diagnostics({ type: 'breaker-state-unreadable' })
    } else {
      for (const [host, state] of stored) this.stored.set(host, state)
    }
    this.loaded = true
    for (const [host, guards] of this.sites) this.applyStored(host, guards.breaker)
  }

  private applyStored(host: string, breaker: SiteCircuitBreaker): void {
    if (this.failClosedSince !== null) breaker.failClosed(this.failClosedSince)
    const state = this.stored.get(host)
    if (state !== undefined) breaker.restore(state)
  }

  private eventsFor(host: string): BreakerEvents {
    return {
      opened: (cause, retryAt, callId) => {
        void this.options.audit({
          type: 'breaker-opened',
          host,
          cause,
          retryAt: new Date(retryAt).toISOString(),
          callId,
        })
      },
      closed: () => {
        void this.options.audit({ type: 'breaker-closed', host })
      },
      changed: () => this.persist(),
    }
  }

  /**
   * Writes the whole state, after any write already queued and never before the stored state has
   * been read (or we would overwrite it unseen). A breaker held open because the stored state was
   * unreadable is written too, so a second restart doesn't cut that short.
   */
  private persist(): void {
    this.writes = this.writes
      .then(() => this.ready())
      .then(() => this.options.store.write(serialiseBreakerFile(this.current())))
      .catch(() => {
        // The breaker still holds in memory; only a restart before the next good write forgets it.
        this.options.diagnostics({ type: 'breaker-state-write-failed' })
      })
  }

  private current(): Map<string, BreakerState> {
    const states = new Map(this.stored)
    for (const [host, guards] of this.sites) {
      const state = guards.breaker.snapshot()
      if (state === null) states.delete(host)
      else states.set(host, state)
    }
    return states
  }
}

/**
 * The block signature in a response, if any: a 429, a 403 HTML page, or Akamai's "Access Denied ...
 * Reference #" page whatever its status. Other HTML, such as an ordinary 404 page, is not a block: one
 * adapter's bad request must not stop every adapter for the site.
 */
export function blockCause(result: FetchResult): BlockCause | null {
  if (result.status === 429) return 'rate-limited'
  if (!isHtml(result)) return null
  if (result.status === 403) return 'blocked-by-site'
  const akamai =
    typeof result.body === 'string' && AKAMAI_DENIED.test(result.body) && AKAMAI_REFERENCE.test(result.body)
  return akamai ? 'blocked-by-site' : null
}

const AKAMAI_DENIED = /access denied/i
const AKAMAI_REFERENCE = /reference\s*#/i

export function isHtml(result: FetchResult): boolean {
  if (result.contentType?.toLowerCase().includes('html')) return true
  return (
    typeof result.body === 'string' && /^\s*</.test(result.body) && !/json/i.test(result.contentType ?? '')
  )
}

/** What tool code gets when the site refused a request: the site's block, or its 429. */
export function siteRefusal(cause: BlockCause): SiteAdapterError {
  return new SiteAdapterError('tool-run', cause)
}

/** What tool code gets when our own breaker refuses to send anything while the site cools down. */
export function breakerRefusal(): SiteAdapterError {
  return new SiteAdapterError('tool-run', 'rate-limited')
}

/** True for an error that means the site is refusing us, by its own answer or our breaker. */
export function isSiteRefusal(error: unknown): boolean {
  return (
    error instanceof SiteAdapterError &&
    (error.errorClass === 'blocked-by-site' || error.errorClass === 'rate-limited')
  )
}
