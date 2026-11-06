// The auth interpreter's inputs and outcome. Every effect is injected so that the interpreter runs
// in plain Node against fakes, and so that the runtime decides what a clock, a sleep or a page is.

import type {
  AdapterManifest,
  AuditSink,
  AuthPage,
  CredentialProvider,
  ErrorClass,
  GrantStore,
  OtpReader,
  ProviderKind,
  Stage,
} from '@siteadapter/core'

export type AuthOutcome =
  /** Logged in, as the probe saw it from the auth partition. Only now may the session be copied. */
  | { readonly status: 'ok' }
  /** `reason` comes from the manifest's needsUser step, never from the page. */
  | { readonly status: 'needsUser'; readonly reason: string }
  | { readonly status: 'failed'; readonly stage: Stage; readonly errorClass: ErrorClass }
  /** The site's bot protection refused us. The caller cools down rather than retrying. */
  | { readonly status: 'blocked' }

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
   * The manifest's session probe, run against the auth partition: a cookie probe reads the auth
   * session's cookie jar, and a fetch probe is made from the auth page. It must not look at the tool
   * partition, which nothing has been copied to yet. The caller copies the session from auth to tool
   * only once this flow returns ok, so a failed or half-finished login never reaches tool code.
   * (The probe `session.ensure()` runs first, before deciding to log in, is the tool partition's.)
   */
  readonly probe: () => Promise<boolean>
  /** True when the page is the site's bot-block page, e.g. Akamai's "Access Denied". */
  readonly isBlockedPage: () => Promise<boolean>
  readonly audit: AuditSink
  readonly clock: () => Date
  readonly sleep: (ms: number) => Promise<void>
  /** Gap between typed characters. Sites time keystrokes. */
  readonly typingDelayMs: number
  /** Budget for the whole flow, including waiting for one-time codes. */
  readonly flowTimeoutMs: number
}
