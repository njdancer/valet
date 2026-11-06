// Per-call state shared by the capabilities handed to tool code. Guard violations and site blocks
// are sticky: tool code can catch the error, but the call still fails, and every capability refuses
// to act again. Otherwise a tool could swallow a denial and keep probing.
//
// It also tracks the runtime-owned work a call starts (page operations, ensure(), prompts), so that
// a call that times out keeps the adapter's lock until that work has settled, rather than leaving
// it to drive the session under the next call.

import { type EnsureResult, SiteAdapterError } from '@siteadapter/core'
import { type SecretRedactionSet, type Sensitive, sensitiveMatcher } from './redaction'
import type { CallLogin } from './session'
import { blockedBySite } from './site-protection'

export class CallState {
  requests = 0
  violation: SiteAdapterError | null = null
  blocked = false
  /** The last ensure() result when it was not ok; a tool that then throws reports this instead. */
  ensureOutcome: Exclude<EnsureResult, { status: 'ok' }> | null = null
  /** At most one login per call; the session gate records it here. */
  readonly login: CallLogin = { outcome: null }
  /** Every session cookie value seen during the call, old and new, for redaction. */
  readonly cookieValues = new Set<string>()
  private readonly work = new Set<Promise<unknown>>()

  constructor(
    readonly callId: string,
    readonly signal: AbortSignal,
    private readonly secrets: SecretRedactionSet,
  ) {}

  sensitive(): Sensitive {
    return sensitiveMatcher(this.cookieValues, this.secrets)
  }

  /** Throws if the call may no longer act: it was aborted, blocked by the site, or broke a guard. */
  assertLive(): void {
    if (this.signal.aborted) throw new SiteAdapterError('tool-run', 'aborted')
    if (this.blocked) throw blockedBySite()
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
