// What the MCP endpoint needs from the runtime. The runtime implements it; this package never
// imports the runtime, so the endpoint can be tested against a fake and the runtime can change
// behind this seam.

import type { ErrorClass, Stage, ToolDeclaration } from '@siteadapter/core'
import type { z } from 'zod'

export interface ListedTool {
  readonly adapterId: string
  readonly adapterName: string
  readonly declaration: ToolDeclaration
  readonly input: z.ZodType
  readonly output: z.ZodType
}

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
}

export type CallOutcome =
  | { readonly status: 'ok'; readonly output: unknown }
  | { readonly status: 'needsUser'; readonly reason: string }
  | { readonly status: 'failed'; readonly stage: Stage; readonly errorClass: ErrorClass }
  | { readonly status: 'blocked'; readonly retryAfterMs: number }
  | { readonly status: 'declined' }

export interface ToolCaller {
  /** Every tool that may be called right now: approved adapters only. */
  listTools(): readonly ListedTool[]
  call(call: ToolCall): Promise<CallOutcome>
}
