// What the MCP endpoint needs from the runtime. The runtime implements it; this package never
// imports the runtime, so the endpoint can be tested against a fake and the runtime can change
// behind this seam.

import type { ErrorClass, NeedsUserReason, Stage, ToolDeclaration } from '@valet/core'
import type { z } from 'zod'
import type { ClientIdentity } from './auth'

export interface ListedTool {
  readonly adapterId: string
  readonly adapterName: string
  readonly declaration: ToolDeclaration
  readonly input: z.ZodType
  readonly output: z.ZodType
}

/**
 * How a session reached the endpoint: through the stdio bridge, which says so with a header, or
 * plain HTTP. Any local client holding the token could send that header, so this is a label for
 * the person and the log, never a permission.
 */
export type ClientTransport = 'stdio-bridge' | 'http'

export interface ToolCall {
  readonly adapterId: string
  readonly tool: string
  /** Arguments as the endpoint parsed them against the tool's input schema. */
  readonly input: unknown
  /** The MCP client's self-reported name, for the audit log. Untrusted. */
  readonly client: string
  /**
   * The client the session's credential names: the app's id for it and whether it came over the
   * local or a remote listener. Unlike `client`, this is not the client's own claim. Absent only
   * for a server made without one (createMcpServer used directly, as in tests).
   */
  readonly identity?: ClientIdentity
  readonly callId: string
  /** Aborts when the client cancels the request or disconnects. */
  readonly signal?: AbortSignal
  /** How the session reached the endpoint, when it came over HTTP or the bridge. A label only. */
  readonly transport?: ClientTransport
}

/**
 * What the person is being asked to do in the app, when the app knows, so a result can name the
 * Needs you item it is under. Only codes, a time, and a setting title the person approved with the
 * adapter; never page text.
 */
export type NeedsYouHint =
  /** A login hand-off is open for the person until `until` (ISO time; null when it has no end). */
  | { readonly kind: 'login'; readonly until: string | null }
  /** The person closed the login hand-off this call would need without finishing it. */
  | { readonly kind: 'gave-up' }
  /** A setting the adapter needs has no choice yet; `settingTitle` is the manifest's title for it. */
  | { readonly kind: 'setting-missing'; readonly settingTitle: string }
  /** The site needs a login and the person hasn't given Valet one. */
  | { readonly kind: 'login-missing' }

/**
 * How a call ended: one variant per core RunOutcome. Nothing in it is free text but a NeedsYouHint's
 * setting title.
 */
export type CallOutcome =
  | { readonly status: 'ok'; readonly output: unknown }
  /**
   * The run stopped and the person has been asked to act in the app. Only the reason code crosses
   * this seam; a manifest's note for the person is shown in the app and never sent to the client.
   */
  | { readonly status: 'needsUser'; readonly reason: NeedsUserReason; readonly needsYou?: NeedsYouHint }
  | {
      readonly status: 'failed'
      readonly stage: Stage
      readonly errorClass: ErrorClass
      /** A failure the person can fix in the app, such as a login Valet was never given. */
      readonly needsYou?: NeedsYouHint
    }
  /**
   * The site refused or rate-limited us, or our own rate budget or circuit breaker held the call
   * back (errorClass blocked-by-site or rate-limited). retryAfterMs is when to try again. Stage
   * tool-run with rate-limited is our own hourly cap for the site: the call was never started.
   * Stage login with login-in-progress: the call started a login, which is running on without it;
   * the tool did nothing else and the call is to be made again.
   *
   * Or, with errorClass busy, the call could not get its turn behind `ahead` earlier calls in the
   * time the runtime allows and was never started: nothing was sent, so it is safe to make again.
   */
  | {
      readonly status: 'blocked'
      readonly stage: Stage
      readonly errorClass: ErrorClass
      readonly retryAfterMs: number
      /** With errorClass busy: how many calls were still in front of this one. */
      readonly ahead?: number
    }
  /** The person declined the confirmation in the app, or (`timedOut`) didn't answer it in time. */
  | { readonly status: 'declined'; readonly timedOut?: true }

export interface ToolCaller {
  /**
   * Every tool that may be called right now: approved adapters only. With an identity, the tools
   * that client may call (a remote client's grant narrows it); callers that don't care ignore it.
   */
  listTools(identity?: ClientIdentity): readonly ListedTool[]
  call(call: ToolCall): Promise<CallOutcome>
}
