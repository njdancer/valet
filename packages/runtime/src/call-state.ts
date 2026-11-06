// Per-call state shared by the capabilities handed to tool code. Guard violations and site blocks
// are sticky: tool code can catch the error, but the call still fails, and every capability refuses
// to act again. Otherwise a tool could swallow a denial and keep probing.

import { type EnsureResult, SiteAdapterError } from '@siteadapter/core'
import { type SecretRedactionSet, type Sensitive, sensitiveMatcher } from './redaction'
import { blockedBySite } from './site-protection'

export class CallState {
  requests = 0
  violation: SiteAdapterError | null = null
  blocked = false
  /** The last ensure() result when it was not ok; a tool that then throws reports this instead. */
  ensureOutcome: Exclude<EnsureResult, { status: 'ok' }> | null = null
  /** Every session cookie value seen during the call, old and new, for redaction. */
  readonly cookieValues = new Set<string>()

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
}
