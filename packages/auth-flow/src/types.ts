// The auth interpreter's inputs and outcome. Every effect is injected so that the interpreter runs
// in plain Node against fakes, and so that the runtime decides what a clock, a sleep or a page is.

import type {
  AdapterManifest,
  AuditSink,
  AuthPage,
  CredentialProvider,
  ErrorClass,
  FetchResult,
  GrantStore,
  NeedsUserReason,
  OtpReader,
  ProviderKind,
  SecretValue,
  Stage,
} from '@siteadapter/core'
import type { UrlPatternMatcher } from './url-matcher'

export type AuthOutcome =
  /** Logged in, as the probe saw it from the auth partition. Only now may the session be copied. */
  | { readonly status: 'ok' }
  /**
   * `reason` is a code from core's fixed vocabulary and may reach the MCP client. `appNote` is the
   * manifest's free text: show it in the app, and never send it anywhere else.
   */
  | { readonly status: 'needsUser'; readonly reason: NeedsUserReason; readonly appNote?: string }
  | {
      readonly status: 'failed'
      readonly stage: Stage
      readonly errorClass: ErrorClass
      /** From a manifest fail step. For the app only, like needsUser's. */
      readonly appNote?: string
    }
  /** The site's bot protection refused us, or told us to slow down. The caller cools down. */
  | {
      readonly status: 'blocked'
      readonly stage: Stage
      readonly errorClass: 'blocked-by-site' | 'rate-limited'
      readonly appNote?: string
    }

/**
 * How the interpreter asks the auth partition whether it is logged in. The interpreter reads the
 * manifest's probe and decides; these only fetch the evidence. Both look at the auth partition,
 * never the tool partition, which nothing has been copied to yet.
 */
export interface AuthProbe {
  /**
   * GETs `url` from inside the auth partition with its cookies, as the page would, and returns
   * whatever the site answered. `url` is always on the manifest's home origin and on `navigation`.
   * The flow itself reads a 429, an HTML 403 or Akamai's block page as the site refusing us and
   * ends as blocked. The hook may also throw SiteAdapterError('probe', 'blocked-by-site' |
   * 'rate-limited') itself, e.g. when the site's breaker is open; anything else thrown becomes
   * probe: internal.
   */
  fetch(url: string): Promise<FetchResult>
  /** Names, not values, of the auth partition's cookies on `cookieDomains`. */
  cookieNames(cookieDomains: readonly string[]): Promise<readonly string[]>
}

export interface AuthFlowInput {
  readonly manifest: AdapterManifest
  /** Content hash of the approved adapter bundle. Grants are keyed by it. */
  readonly adapterHash: string
  /** The tool call that triggered this login, for the audit log; null when the person started it. */
  readonly callId: string | null
  readonly page: AuthPage
  readonly grants: GrantStore
  readonly providers: Partial<Record<ProviderKind, CredentialProvider>>
  readonly otpReader: OtpReader
  /**
   * The manifest's session probe, run against the auth partition by assertLoggedIn and, if the
   * flow didn't just do that, once more before the flow reports ok. The caller copies the session
   * from auth to tool only once this flow returns ok, so a failed or half-finished login never
   * reaches tool code. (The probe `session.ensure()` runs first, before deciding to log in, is the
   * tool partition's.)
   */
  readonly probe: AuthProbe
  /** True when the page is the site's bot-block page, e.g. Akamai's "Access Denied". */
  readonly isBlockedPage: () => Promise<boolean>
  /**
   * Given an independent copy of every secret just before it is typed, so the runtime can redact
   * it from tool output for the rest of the run. The runtime owns and disposes the copy. If it
   * throws, the secret is not typed.
   */
  readonly rememberSecret: (secret: SecretValue) => void
  readonly audit: AuditSink
  readonly clock: () => Date
  readonly sleep: (ms: number) => Promise<void>
  /** Gap between typed characters. Sites time keystrokes. */
  readonly typingDelayMs: number
  /** Budget for the whole flow, including waiting for one-time codes. */
  readonly flowTimeoutMs: number
  /**
   * Runs urlRegex conditions off the main thread under a deadline. Defaults to a WorkerUrlMatcher
   * the flow starts on first use and closes when it finishes; one passed in is the caller's to close.
   */
  readonly urlMatcher?: UrlPatternMatcher
}
