// Per-call state shared by the capabilities handed to tool code. Guard violations and site blocks
// are sticky: tool code can catch the error, but the call still fails, and every capability refuses
// to act again. Otherwise a tool could swallow a denial and keep probing.
//
// It also tracks the runtime-owned work a call starts (page operations, ensure(), prompts), so that
// a call that times out keeps the adapter's lock until that work has settled, rather than leaving
// it to drive the session under the next call.
//
// Output redaction checks against the session values seen during the call, kept here for exactly
// its length, and the clones of the latest login's secrets, which the adapter's session gate keeps.

import { type EnsureResult, SiteAdapterError } from '@siteadapter/core'
import { REDACTED, type SecretRedactionSet, type Sensitive, sensitiveMatcher } from './redaction'
import type { CallLogin } from './session'
import { breakerRefusal } from './site-protection'

export class CallState {
  requests = 0
  violation: SiteAdapterError | null = null
  /** The site refused us, or its breaker opened, during this call. */
  blocked = false
  /** The last ensure() result when it was not ok; a tool that then throws reports this instead. */
  ensureOutcome: Exclude<EnsureResult, { status: 'ok' }> | null = null
  /** At most one login per call; the session gate records it here. */
  readonly login: CallLogin = { outcome: null }
  /** Every session value (cookie or handed-off storage) seen during the call, old and new. */
  readonly sessionValues = new Set<string>()
  /** Request-blocked events already recorded for this call, so a chatty page can't flood the log. */
  readonly reportedBlocks = new Set<string>()
  private readonly work = new Set<Promise<unknown>>()

  /** `secrets` gives the latest login's secrets as they are now: a login during the call replaces them. */
  constructor(
    readonly callId: string,
    readonly signal: AbortSignal,
    private readonly secrets: () => SecretRedactionSet,
  ) {}

  sensitive(): Sensitive {
    return sensitiveMatcher(this.sessionValues, this.secrets())
  }

  /**
   * Redacts a request-blocked target. URL parsing lower-cases hostnames, so session values match it
   * case-insensitively; `raw`, what tool code actually passed, is checked as given, which is how a
   * secret (only ever matched exactly) is still caught in a hostname.
   */
  redactTarget(target: string, raw?: unknown): string {
    const caseless = sensitiveMatcher(this.sessionValues, this.secrets(), { ignoreCase: true })
    const leaks = caseless(target) || (typeof raw === 'string' && this.sensitive()(raw))
    return leaks ? REDACTED : target
  }

  /** Throws if the call may no longer act: it was aborted, blocked by the site, or broke a guard. */
  assertLive(): void {
    if (this.signal.aborted) throw new SiteAdapterError('tool-run', 'aborted')
    if (this.blocked) throw breakerRefusal()
    if (this.violation !== null) throw this.violation
  }

  /** Records `work` as outstanding until it settles, and returns it unchanged. */
  track<T>(work: Promise<T>): Promise<T> {
    this.work.add(work)
    const done = (): void => {
      this.work.delete(work)
    }
    work.then(done, done)
    return work
  }

  /** True when no tracked work is outstanding. */
  get idle(): boolean {
    return this.work.size === 0
  }

  /** Resolves once every tracked piece of work has settled. Never rejects. */
  async settled(): Promise<void> {
    while (this.work.size > 0) await Promise.allSettled([...this.work])
  }
}
