// The runtime's own contracts: what it needs injected (the auth runner, the confirmation prompt)
// and what it returns. The auth runner is a function type so that this package never imports
// @valet/auth-flow; the app wires the real one in.

import type {
  AdapterManifest,
  ErrorClass,
  NeedsUserReason,
  RequestDeclaration,
  SecretValue,
  SessionDriver,
  Stage,
  ToolDeclaration,
} from '@valet/core'
import type { z } from 'zod'

/**
 * What the AuthRunner reports. The shape matches auth-flow's own AuthOutcome, so the app can pass
 * runAuthFlow's result straight through.
 */
export type AuthOutcome =
  | {
      readonly status: 'ok'
      /**
       * How many secrets the login filled. When it is more than were registered for redaction, the
       * runtime fails closed: every output is withheld until a login registers them all.
       */
      readonly filledSecrets?: number
    }
  | { readonly status: 'needsUser'; readonly reason: NeedsUserReason }
  | {
      readonly status: 'failed'
      readonly stage: Stage
      readonly errorClass: ErrorClass
      /**
       * Only on `aborted` (the request's signal fired and the login stopped): whether a password or
       * one-time code had begun to be typed. False lets the runtime lift the attempt marker by
       * itself; true, or absent, leaves it for the person.
       */
      readonly attemptStarted?: boolean
    }
  /** The site's bot protection refused us, or told us to slow down. Trips the site's circuit breaker. */
  | { readonly status: 'blocked'; readonly errorClass: 'blocked-by-site' | 'rate-limited' }

export interface AuthRunRequest {
  readonly adapterId: string
  readonly adapterHash: string
  readonly manifest: AdapterManifest
  readonly driver: SessionDriver
  /** The tool call that needed the login. */
  readonly callId: string | null
  readonly signal: AbortSignal
  /**
   * Call with every secret the auth flow resolves, before disposing it. The runtime keeps its own
   * clone until the next successful login, so tool output can be redacted; the caller still owns,
   * and disposes, the value it passed.
   */
  registerForRedaction(secret: SecretValue): void
  /**
   * Call, and wait for, before typing a password or one-time code. It records durably that the
   * site may now see an attempt (D35). If it rejects, type nothing and end the login.
   */
  attemptStarting(): Promise<void>
  /**
   * Waits for the site's rate budget, as a tool's request would (D55). Call before each navigation
   * the login starts, and before each request its probe makes. Rejects with `aborted` if the call
   * gives up while waiting.
   */
  pace(): Promise<void>
  /**
   * True once the site has refused us since this login started, in either partition, as the
   * driver reported it to the site's breaker (D55). The auth flow treats it as a block page: the
   * login ends as blocked at its next check.
   */
  siteRefused(): boolean
}

/**
 * Runs an adapter's declarative auth action in the auth partition. It owns the login-started and
 * login-finished audit events (auth-flow's runAuthFlow writes them); the runtime writes neither.
 */
export type AuthRunner = (request: AuthRunRequest) => Promise<AuthOutcome>

export type ConfirmationAnswer = 'approved' | 'declined' | 'timed-out'

/**
 * How the MCP client reached the endpoint: through the stdio bridge, or plain HTTP. A label for the
 * person and the log only. The bridge says so itself, so any local client could claim it; nothing
 * may grant or refuse anything on it.
 */
export type ClientTransport = 'stdio-bridge' | 'http'

export const CLIENT_TRANSPORTS: readonly ClientTransport[] = ['stdio-bridge', 'http']

interface ConfirmationRequestBase {
  readonly adapterId: string
  readonly adapterName: string
  readonly tool: string
  readonly toolTitle: string
  readonly callId: string
  /** The MCP client that made the call, so the person knows who is asking. */
  readonly client: string
  /** How that client reached the endpoint, when the call says. A label, never a permission. */
  readonly transport?: ClientTransport
}

/**
 * What the person is asked. Everything is the runtime's own knowledge except a tool request's
 * `note`, which the adapter wrote (C4).
 */
export type ConfirmationQuestion =
  | {
      /** The runtime asking before an irreversible tool runs, with the tool's validated input. */
      readonly kind: 'irreversible-tool'
      readonly input: unknown
    }
  | {
      /** Tool code calling ctx.confirm(). */
      readonly kind: 'tool-request'
      /**
       * The manifest's own declarations for the requests the tool says it will make on a yes, each
       * checked to be declared and within the tool's side effect. Approving unlocks none of them.
       */
      readonly requests: readonly RequestDeclaration[]
      /** The adapter's note, unverified, or null. */
      readonly note: string | null
    }

export type ConfirmationRequest = ConfirmationRequestBase & ConfirmationQuestion

/** Asks the person in the app. The MCP client can never answer it. */
export interface ConfirmationPrompt {
  ask(request: ConfirmationRequest, signal: AbortSignal): Promise<ConfirmationAnswer>
}

export type ToolCallResult =
  | { readonly status: 'ok'; readonly output: unknown }
  /** Only the code: the app renders its own wording, and nothing adapter-authored reaches the client. */
  | { readonly status: 'needsUser'; readonly reason: NeedsUserReason }
  | { readonly status: 'failed'; readonly stage: Stage; readonly errorClass: ErrorClass }
  | { readonly status: 'blocked'; readonly retryAfterMs: number }
  /**
   * The call was never started, and nothing was sent: it waited its turn behind earlier calls for
   * the adapter for as long as the runtime allows, or too many were in front for it to get a turn
   * in that time. `ahead` is how many calls were in front of it when it gave up (at least 1) and
   * `retryAfterMs` an estimate of when a new call would get its turn.
   */
  | { readonly status: 'busy'; readonly retryAfterMs: number; readonly ahead: number }
  | { readonly status: 'declined' }

export interface ToolCallRequest {
  readonly adapterId: string
  readonly tool: string
  readonly input: unknown
  /** The MCP client's name, for the audit log and the confirmation prompt. */
  readonly client: string
  /**
   * The client the endpoint's credential names, `local:<id>` or `remote:<id>`, for the audit log
   * (C12). Anything not of that shape is left out of the record rather than written.
   */
  readonly clientId?: string
  readonly callId: string
  /**
   * Aborts the call, e.g. when the MCP client cancels or disconnects. Before the lock it leaves the
   * queue; during a confirmation the prompt's signal aborts and the answer counts as declined; while
   * the tool runs, the tool's own signal aborts. Each ends the call `failed tool-run/aborted`.
   */
  readonly signal?: AbortSignal
  /** How the client reached the endpoint, passed on to the confirmation prompt. A label only. */
  readonly transport?: ClientTransport
}

export interface ListedTool {
  readonly adapterId: string
  readonly adapterName: string
  readonly adapterHash: string
  readonly declaration: ToolDeclaration
  readonly input: z.ZodType
  readonly output: z.ZodType
}

export interface LoginStepOptions {
  /** How long to wait for running calls on the adapter. Default 30 s; then `login/timed-out`. */
  readonly waitMs?: number
  /** How long the step itself may run. Defaults to the tool timeout (2 min). */
  readonly timeoutMs?: number
  /** Gives up the wait, or stops waiting for the step: `login/aborted`. */
  readonly signal?: AbortSignal
}

/** What a login step gets from the runtime. */
export interface LoginStepContext {
  /** Aborts when the step's deadline passes, its caller aborts, or it returns. */
  readonly signal: AbortSignal
  /**
   * Call before each further request the step makes to the site (a navigation, a form post): waits
   * for the site's rate budget. Rejects with `login/rate-limited` while the breaker is open, and
   * `login/aborted` once the signal has aborted. The first slot is taken before the step starts.
   */
  pace(): Promise<void>
  /** The step landed on the site's block page, or got a 429: opens the site's breaker. */
  reportBlocked(cause: 'blocked-by-site' | 'rate-limited'): void
}

/** One site host as the app shows it. Times are epoch milliseconds, from the runtime's clock. */
export interface SiteHealthSnapshot {
  readonly host: string
  /** Registered adapters on this host, in registration order. */
  readonly adapterIds: readonly string[]
  readonly breaker: 'open' | 'closed'
  /** When calls may resume, while open. */
  readonly retryAt: number | null
  /** 0 when closed. */
  readonly retryAfterMs: number
  /** The cooldown the current run of blocks applied; 0 when there is none. */
  readonly cooldownMs: number
  /** The cooldown the next block would start, after doubling, within the maximum. */
  readonly nextCooldownMs: number
  readonly budget: {
    /** The gap between requests: the most cautious any adapter on the host declares. */
    readonly minGapMs: number
    /** How long a request asking now would wait. */
    readonly waitMs: number
  }
}

/** Things the app may want to show or log that are not audit events. Never carries page text. */
export type RuntimeDiagnostic =
  | { readonly type: 'audit-write-failed'; readonly event: string }
  /** The persisted breaker state could not be read: every site's breaker opens for its cooldown. */
  | { readonly type: 'breaker-state-unreadable' }
  | { readonly type: 'breaker-state-write-failed' }
  /** The persisted last request times could not be read: every site waits one gap first. */
  | { readonly type: 'budget-state-unreadable' }
  | { readonly type: 'budget-state-write-failed' }
  /** A run hit the cap on request-blocked audit events; later blocks in it are not recorded. */
  | { readonly type: 'request-blocked-capped'; readonly adapterId: string; readonly callId: string }
