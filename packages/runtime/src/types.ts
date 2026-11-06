// The runtime's own contracts: what it needs injected (the auth runner, the confirmation prompt)
// and what it returns. The auth runner is a function type so that this package never imports
// @siteadapter/auth-flow; the app wires the real one in.

import type {
  AdapterManifest,
  ErrorClass,
  SecretValue,
  SessionDriver,
  Stage,
  ToolDeclaration,
} from '@siteadapter/core'
import type { z } from 'zod'

export type AuthOutcome =
  | { readonly status: 'ok' }
  | { readonly status: 'needsUser'; readonly reason: string }
  | { readonly status: 'failed'; readonly stage: Stage; readonly errorClass: ErrorClass }
  /** The site's bot protection refused us. Trips the site's circuit breaker. */
  | { readonly status: 'blocked' }

export interface AuthRunRequest {
  readonly adapterId: string
  readonly adapterHash: string
  readonly manifest: AdapterManifest
  readonly driver: SessionDriver
  /** The tool call that needed the login. */
  readonly callId: string | null
  readonly signal: AbortSignal
  /** Every secret the auth flow resolves must be passed here, so tool output can be redacted. */
  rememberSecret(secret: SecretValue): void
}

/** Runs an adapter's declarative auth action in the auth partition. */
export type AuthRunner = (request: AuthRunRequest) => Promise<AuthOutcome>

export type ConfirmationAnswer = 'approved' | 'declined' | 'timed-out'

export interface ConfirmationRequest {
  readonly adapterId: string
  readonly adapterName: string
  readonly tool: string
  readonly toolTitle: string
  readonly callId: string
  /** The MCP client that made the call, so the person knows who is asking. */
  readonly client: string
  /**
   * `irreversible-tool`: the runtime asking before an irreversible tool runs; `message` is the
   * tool's declared description and `input` its validated input. `tool-request`: tool code calling
   * ctx.confirm(); `message` is adapter-authored.
   */
  readonly kind: 'irreversible-tool' | 'tool-request'
  readonly message: string
  readonly input?: unknown
}

/** Asks the person in the app. The MCP client can never answer it. */
export interface ConfirmationPrompt {
  ask(request: ConfirmationRequest, signal: AbortSignal): Promise<ConfirmationAnswer>
}

export type ToolCallResult =
  | { readonly status: 'ok'; readonly output: unknown }
  | { readonly status: 'needsUser'; readonly reason: string }
  | { readonly status: 'failed'; readonly stage: Stage; readonly errorClass: ErrorClass }
  | { readonly status: 'blocked'; readonly retryAfterMs: number }
  | { readonly status: 'declined' }

export interface ToolCallRequest {
  readonly adapterId: string
  readonly tool: string
  readonly input: unknown
  /** The MCP client's name, for the audit log and the confirmation prompt. */
  readonly client: string
  readonly callId: string
}

export interface ListedTool {
  readonly adapterId: string
  readonly adapterName: string
  readonly adapterHash: string
  readonly declaration: ToolDeclaration
  readonly input: z.ZodType
  readonly output: z.ZodType
}

/** Things the app may want to show or log that are not audit events. Never carries page text. */
export type RuntimeDiagnostic =
  | { readonly type: 'unsupported-probe'; readonly adapterId: string; readonly kind: 'cookie' }
  | { readonly type: 'audit-write-failed'; readonly event: string }
