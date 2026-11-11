// Protection for the sites themselves, and for our standing with them. The live Woolworths probe
// (docs/findings/2026-11-07-woolworths-live-probe.md) got Akamai's 403 "Access Denied" HTML after a
// handful of scripted fetches 2.5 s apart. So every request the runtime or a tool makes to a site is
// paced by a per-site rate budget, and a block trips a per-site circuit breaker that stops all calls
// for a cooldown instead of hammering the site and deepening the block.
//
// A site may also have an hourly cap (D28). It is checked when a tool call starts, never in the
// middle of one, and it lasts for this run of the app only: a restart forgets the count, which
// only the person can cause.
//
// The numbers come from each adapter's manifest.limits. Adapters that share a host share its budget
// and breaker, which take the most cautious numbers any of them declares. Breaker state is persisted
// (see breaker-state.ts) so a restart doesn't forget a block, and so is the time of each site's last
// request (see budget-state.ts) so a restart doesn't forget the pace.

import {
  type AdapterManifest,
  type AuditEvent,
  type FetchResult,
  type ToolPage,
  ValetError,
} from '@valet/core'
import { type BreakerState, type JsonStore, parseBreakerFile, serialiseBreakerFile } from './breaker-state'
import { BUDGET_MEMORY_MS, parseBudgetFile, serialiseBudgetFile } from './budget-state'
import type { Clock, Sleep } from './clock'
import type { RuntimeDiagnostic } from './types'

/** Why the site refused us: its bot protection, or a 429. */
export type BlockCause = 'blocked-by-site' | 'rate-limited'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
/** More request times than any cap the manifest schema allows. */
const MAX_REMEMBERED = 4000

/**
 * Spaces requests to one site at least `minGapMs` apart, in the order they ask. Optionally (D28):
 * each gap is stretched by a random share of itself, never shortened; no more than a set number go
 * in any minute; and an hourly cap is counted, for whoever starts work to ask about.
 */
export class RateBudget {
  private nextSlot = Number.NEGATIVE_INFINITY
  /** The most requests let through in any hour, or null for no cap. */
  private perHour: number | null = null
  /** The most requests let through in any minute, or null for no cap. */
  private perMinute: number | null = null
  /** The most a gap is stretched, as a share of minGapMs: 0.5 makes gaps of 1 to 1.5 times it. */
  private jitter = 0
  /**
   * The time of each request's slot, oldest first, as far back as the caps look. A slot is listed
   * when it is given, which may be before its time. Kept only under a cap.
   */
  private slots: number[] = []
  /** When the last request was let through, in this run or an earlier one; null before any. */
  private lastUsed: number | null = null

  /**
   * `used` is called each time a request is let through, so its owner can save lastUsedAt(). Must
   * not throw. `random` draws from [0, 1) for the jitter.
   */
  constructor(
    private minGapMs: number,
    private readonly clock: Clock,
    private readonly sleep: Sleep,
    private readonly used: () => void = () => {},
    private readonly random: () => number = Math.random,
  ) {}

  get gapMs(): number {
    return this.minGapMs
  }

  /** Raises the gap; never lowers it. The wider gap counts from the last request too. */
  widen(minGapMs: number): void {
    this.minGapMs = Math.max(this.minGapMs, minGapMs)
    if (this.lastUsed !== null) this.nextSlot = Math.max(this.nextSlot, this.lastUsed + this.minGapMs)
  }

  /** Sets the hourly cap, or lowers it; never raises it. */
  cap(perHour: number | undefined): void {
    if (perHour !== undefined) this.perHour = Math.min(this.perHour ?? perHour, perHour)
  }

  /** Sets the per-minute cap, or lowers it; never raises it. */
  capMinute(perMinute: number | undefined): void {
    if (perMinute !== undefined) this.perMinute = Math.min(this.perMinute ?? perMinute, perMinute)
  }

  /** Sets how far gaps are stretched, as a percentage of the gap, or raises it; never lowers it. */
  stretch(percent: number | undefined): void {
    if (percent !== undefined) this.jitter = Math.max(this.jitter, percent / 100)
  }

  /**
   * How long until the hourly cap has room again: 0 when it has, or when there is no cap. The cap
   * is for whoever starts work (a tool call) to ask about. acquire() never waits on it, so work
   * already under way (a write after its read, a login halfway through) is never stranded by it,
   * and the hour can run over by what one call sends.
   */
  spentForMs(): number {
    if (this.perHour === null) return 0
    const recent = this.remembered()
    const freeing = recent[recent.length - this.perHour]
    return freeing === undefined ? 0 : Math.max(1, freeing + HOUR_MS - this.clock.now())
  }

  /** The slots the caps still look at: an hour's under an hourly cap, else a minute's. */
  private remembered(): number[] {
    const since = this.clock.now() - (this.perHour === null ? MINUTE_MS : HOUR_MS)
    if ((this.slots[0] ?? Number.POSITIVE_INFINITY) <= since)
      this.slots = this.slots.filter((at) => at > since)
    return this.slots
  }

  /** The gap after one request: minGapMs, stretched by up to the jitter. Never less than minGapMs. */
  private nextGap(): number {
    if (this.jitter === 0) return this.minGapMs
    const draw = this.random()
    const share = Number.isFinite(draw) ? Math.min(1, Math.max(0, draw)) : 1
    return this.minGapMs + Math.round(this.minGapMs * this.jitter * share)
  }

  /** How long a request asking now would wait for its slot. Reads only; takes no slot. */
  waitMs(): number {
    return Math.max(0, this.earliest(this.clock.now()) - this.clock.now())
  }

  /** The first time a new request may go: after the gap, and with room under the per-minute cap. */
  private earliest(now: number): number {
    let slot = Math.max(now, this.nextSlot)
    if (this.perMinute !== null) {
      const slots = this.remembered()
      // With this many slots in the minute before it, the next waits for the oldest to be a minute old.
      const oldest = slots[slots.length - this.perMinute]
      if (oldest !== undefined) slot = Math.max(slot, oldest + MINUTE_MS)
    }
    return slot
  }

  /** When the last request was let through (epoch ms), or null when none has been. */
  lastUsedAt(): number | null {
    return this.lastUsed
  }

  /**
   * Waits for this request's slot. A wait that is aborted sent nothing, so it hands its slot back
   * when nobody has queued behind it; otherwise the slot stays spent, erring on the slow side.
   */
  async acquire(signal?: AbortSignal): Promise<void> {
    const now = this.clock.now()
    const slot = this.earliest(now)
    const after = slot + this.nextGap()
    this.nextSlot = after
    const counted = this.perHour !== null || this.perMinute !== null
    if (counted) {
      this.slots.push(slot)
      // Bounded whatever happens: more than the widest cap's worth is a bug.
      if (this.slots.length > MAX_REMEMBERED) this.slots.splice(0, this.slots.length - MAX_REMEMBERED)
    }
    if (slot > now) {
      try {
        await this.sleep(slot - now, signal)
      } catch (error) {
        if (this.nextSlot === after) {
          this.nextSlot = slot
          // Nothing was sent and nobody is behind it, so it doesn't count against a cap either.
          const index = this.slots.lastIndexOf(slot)
          if (counted && index !== -1) this.slots.splice(index, 1)
        }
        throw error
      }
    }
    this.lastUsed = Math.max(this.lastUsed ?? Number.NEGATIVE_INFINITY, slot)
    this.used()
  }

  /**
   * Takes up the time of the last request from an earlier run of the app: the next one waits out
   * the rest of the gap. A time in the future is a clock change or a hand edit, and counts as now,
   * so what is restored never holds a request longer than one gap.
   */
  restore(lastRequestAt: number): void {
    const at = Math.min(lastRequestAt, this.clock.now())
    this.lastUsed = Math.max(this.lastUsed ?? Number.NEGATIVE_INFINITY, at)
    this.nextSlot = Math.max(this.nextSlot, at + this.minGapMs)
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

export interface BreakerStatus {
  readonly open: boolean
  /** When calls may resume (epoch ms), while open. */
  readonly retryAt: number | null
  /** 0 when closed. */
  readonly retryAfterMs: number
  /** The cooldown the current run of blocks applied; 0 after a normal answer. */
  readonly cooldownMs: number
  /** The cooldown the next block would apply, after doubling, within the maximum. */
  readonly nextCooldownMs: number
}

export class SiteCircuitBreaker {
  private openUntil = 0
  /** The cooldown applied by the current run of blocks; 0 after a normal answer. */
  private cooldown = 0
  /** How many times it has tripped. A request admitted before the latest trip can't close it. */
  private trips = 0
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

  /** What the breaker is doing now, for the app to show. Reads only. */
  status(): BreakerStatus {
    const retryAfterMs = this.retryAfterMs()
    const { cooldownMs, maxCooldownMs } = this.options
    return {
      open: retryAfterMs > 0,
      retryAt: retryAfterMs > 0 ? this.openUntil : null,
      retryAfterMs,
      cooldownMs: this.cooldown,
      nextCooldownMs: Math.min(maxCooldownMs, this.cooldown === 0 ? cooldownMs : this.cooldown * 2),
    }
  }

  trip(cause: BlockCause, callId: string | null): void {
    // Several in-flight requests can all come back blocked; that's one block, not several.
    if (this.isOpen()) return
    const { cooldownMs, maxCooldownMs } = this.options
    this.cooldown = Math.min(maxCooldownMs, this.cooldown === 0 ? cooldownMs : this.cooldown * 2)
    this.openUntil = this.clock.now() + this.cooldown
    this.trips++
    this.events.changed()
    this.events.opened(cause, this.openUntil, callId)
  }

  /**
   * Taken when a request is let through, and handed back to recordSuccess() with its answer, so an
   * answer to a request sent before the latest block can't close the breaker that block opened.
   */
  admit(): number {
    return this.trips
  }

  /**
   * A normal response from the site: the next block starts from the base cooldown again. Ignored
   * while the breaker is open, and for a request admitted (see admit()) before the latest trip: an
   * answer that was already in flight when another request was blocked says nothing about now.
   */
  recordSuccess(admitted: number = this.trips): void {
    if (this.isOpen() || admitted !== this.trips) return
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
  /**
   * Where the time of each site's last request survives restarts. Without one the pace is kept in
   * memory only, and a restart may send a request sooner than the gap after the last.
   */
  readonly budgetStore?: JsonStore
  /** Appends an audit event. Must not throw. */
  readonly audit: (event: AuditEvent) => Promise<void>
  readonly diagnostics: (diagnostic: RuntimeDiagnostic) => void
  /** Draws from [0, 1) for the budgets' jitter. Default Math.random. */
  readonly random?: () => number
}

/** The parts of manifest.limits that pace and guard a site. */
export type SiteLimits = Pick<
  AdapterManifest['limits'],
  | 'minGapMs'
  | 'cooldownSeconds'
  | 'maxCooldownSeconds'
  | 'requestsPerHour'
  | 'requestsPerMinute'
  | 'gapJitterPercent'
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
  /** Last request times on disk when loaded, for hosts no adapter registered this run. */
  private readonly storedBudgets = new Map<string, number>()
  /** Set when the stored times couldn't be read: every site waits one gap from this. */
  private budgetsUnreadableSince: number | null = null
  private budgetWrites: Promise<void> = Promise.resolve()

  constructor(
    private readonly clock: Clock,
    private readonly sleep: Sleep,
    private readonly options: SiteProtectionOptions,
  ) {}

  /**
   * The guards for `host`, widened to `limits`. Usable at once; call ready() before trusting the
   * breaker or the budget, so that state persisted by an earlier run is in force.
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
        budget: new RateBudget(
          limits.minGapMs,
          this.clock,
          this.sleep,
          () => this.persistBudgets(),
          this.options.random,
        ),
        breaker: new SiteCircuitBreaker(this.clock, breakerOptions, this.eventsFor(key)),
      }
      guards.budget.cap(limits.requestsPerHour)
      guards.budget.capMinute(limits.requestsPerMinute)
      guards.budget.stretch(limits.gapJitterPercent)
      this.sites.set(key, guards)
      if (this.loaded) {
        this.applyStored(key, guards)
        // A host first seen after an unreadable load is held too; write that down.
        if (this.failClosedSince !== null) this.persist()
      }
    } else {
      guards.budget.widen(limits.minGapMs)
      guards.budget.cap(limits.requestsPerHour)
      guards.budget.capMinute(limits.requestsPerMinute)
      guards.budget.stretch(limits.gapJitterPercent)
      guards.breaker.widen(breakerOptions)
    }
    return guards
  }

  /** Loads the persisted breaker state and last request times, once. Never rejects. */
  ready(): Promise<void> {
    this.loading ??= this.load()
    return this.loading
  }

  /** Resolves once every state change so far has been written (or has failed to be). */
  async flushed(): Promise<void> {
    await this.writes
    await this.budgetWrites
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
    const budgetsUnreadable = await this.loadBudgets()
    this.loaded = true
    for (const [host, guards] of this.sites) this.applyStored(host, guards)
    // Replace the unreadable file at once, fail-closed holds included. Otherwise it would only be
    // rewritten when some site next trips, and every restart until then would fail closed again.
    if (stored === null) this.persist()
    if (budgetsUnreadable) this.persistBudgets()
  }

  /** Reads the last request times. True when there is a store and it couldn't be read. */
  private async loadBudgets(): Promise<boolean> {
    const store = this.options.budgetStore
    if (store === undefined) return false
    let stored: Map<string, number> | null
    try {
      const text = await store.read()
      stored = text === null ? new Map() : parseBudgetFile(text)
    } catch {
      stored = null
    }
    if (stored === null) {
      // We can't tell when the last request went out, so assume it just did.
      this.budgetsUnreadableSince = this.clock.now()
      this.options.diagnostics({ type: 'budget-state-unreadable' })
      return true
    }
    const now = this.clock.now()
    for (const [host, at] of stored) {
      if (at + BUDGET_MEMORY_MS > now) this.storedBudgets.set(host, at)
    }
    return false
  }

  private applyStored(host: string, guards: SiteGuards): void {
    if (this.failClosedSince !== null) guards.breaker.failClosed(this.failClosedSince)
    const state = this.stored.get(host)
    if (state !== undefined) guards.breaker.restore(state)
    if (this.budgetsUnreadableSince !== null) guards.budget.restore(this.budgetsUnreadableSince)
    const lastRequestAt = this.storedBudgets.get(host)
    if (lastRequestAt !== undefined) guards.budget.restore(lastRequestAt)
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

  /**
   * Writes every site's last request time, after any write already queued and never before the
   * stored times have been read. Not waited for: a request is not held up by the disk, and only a
   * restart within the moment before the write lands forgets that one request.
   */
  private persistBudgets(): void {
    const store = this.options.budgetStore
    if (store === undefined) return
    this.budgetWrites = this.budgetWrites
      .then(() => this.ready())
      .then(() => store.write(serialiseBudgetFile(this.currentBudgets())))
      .catch(() => {
        // The budget still holds in memory; only a restart before the next good write forgets it.
        this.options.diagnostics({ type: 'budget-state-write-failed' })
      })
  }

  private currentBudgets(): Map<string, number> {
    const times = new Map(this.storedBudgets)
    for (const [host, guards] of this.sites) {
      const at = guards.budget.lastUsedAt()
      if (at !== null) times.set(host, at)
    }
    return times
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

/**
 * Run in the page's isolated world after a navigation. It reads the title and the start of the
 * text, and makes no request: true when Akamai's "Access Denied ... Reference #" page loaded.
 */
const DENIED_PAGE_CHECK = String.raw`(() => {
  const text = (document.title || '') + ' ' + ((document.body && document.body.innerText) || '').slice(0, 2000)
  return /access denied/i.test(text) && /reference\s*#/i.test(text)
})()`

/**
 * Whether a navigation landed on the site's block page. goto() reports no status or content type
 * (core's ToolPage), so a 403 or 429 from a navigation can't be seen, only Akamai's page by its
 * text. A page we can't inspect counts as not blocked.
 */
export async function navigationBlocked(page: ToolPage): Promise<BlockCause | null> {
  try {
    return (await page.evaluate(DENIED_PAGE_CHECK)) === true ? 'blocked-by-site' : null
  } catch {
    return null
  }
}

export function isHtml(result: FetchResult): boolean {
  if (result.contentType?.toLowerCase().includes('html')) return true
  return (
    typeof result.body === 'string' && /^\s*</.test(result.body) && !/json/i.test(result.contentType ?? '')
  )
}

/** What tool code gets when the site refused a request: the site's block, or its 429. */
export function siteRefusal(cause: BlockCause): ValetError {
  return new ValetError('tool-run', cause)
}

/** What tool code gets when our own breaker refuses to send anything while the site cools down. */
export function breakerRefusal(): ValetError {
  return new ValetError('tool-run', 'rate-limited')
}

/** True for an error that means the site is refusing us, by its own answer or our breaker. */
export function isSiteRefusal(error: unknown): boolean {
  return (
    error instanceof ValetError &&
    (error.errorClass === 'blocked-by-site' || error.errorClass === 'rate-limited')
  )
}
