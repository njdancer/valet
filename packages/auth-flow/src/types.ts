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
  /** The manifest's session probe, run by the runtime in the tool partition. */
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
