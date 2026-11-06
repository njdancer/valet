// What the MCP endpoint needs from the runtime. The runtime implements it; this package never
// imports the runtime, so the endpoint can be tested against a fake and the runtime can change
// behind this seam.

import type { ErrorClass, NeedsUserReason, Stage, ToolDeclaration } from '@siteadapter/core'
import type { z } from 'zod'

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
  readonly callId: string
  /** Aborts when the client cancels the request or disconnects. */
  readonly signal?: AbortSignal
  /** How the session reached the endpoint, when it came over HTTP or the bridge. A label only. */
  readonly transport?: ClientTransport
}

/** How a call ended: one variant per core RunOutcome. Nothing in it is free text. */
export type CallOutcome =
  | { readonly status: 'ok'; readonly output: unknown }
  /**
   * The run stopped and the person has been asked to act in the app. Only the reason code crosses
   * this seam; a manifest's note for the person is shown in the app and never sent to the client.
   */
  | { readonly status: 'needsUser'; readonly reason: NeedsUserReason }
  | { readonly status: 'failed'; readonly stage: Stage; readonly errorClass: ErrorClass }
  /**
   * The site refused or rate-limited us, or our own rate budget or circuit breaker held the call
   * back (errorClass blocked-by-site or rate-limited). retryAfterMs is when to try again.
   */
  | {
      readonly status: 'blocked'
      readonly stage: Stage
      readonly errorClass: ErrorClass
      readonly retryAfterMs: number
    }
  /** The person declined the confirmation in the app, or didn't answer it in time. */
  | { readonly status: 'declined' }

export interface ToolCaller {
  /** Every tool that may be called right now: approved adapters only. */
  listTools(): readonly ListedTool[]
  call(call: ToolCall): Promise<CallOutcome>
}
