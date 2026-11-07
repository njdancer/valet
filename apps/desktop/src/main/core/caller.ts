// The MCP endpoint's ToolCaller, over the runtime's ToolHost. Two seams are adapted here:
//
// - listTools: the endpoint lists synchronously, the runtime asynchronously (it reads approvals),
//   so the listing is cached and refreshed (then pushed to the endpoint) whenever approvals change.
// - signals: the client's cancel (or its going away) aborts the call in the runtime, and so does
//   the app quitting (cancelAll). The runtime ends an aborted call failed tool-run/aborted.
//
// The app's own refusals come first and never reach the runtime, but are audited like any call
// (hooks.refused writes tool-called and tool-finished for them). Both fail at stage `config`, which
// the runtime never reports for a call, so the log and the client can tell them from the runtime's:
// - while paused: config: unavailable (not a rate limit: the site isn't involved, and a retry
//   succeeds only once the person resumes);
// - a client whose name the person revoked (a label, see clients.ts): config: not-granted.
//
// The runtime's lock keeps calls and the app's own login work (ToolHost.runLoginStep) on an adapter
// apart, so nothing here waits for either.

import type { CallOutcome, ListedTool, ToolCall, ToolCaller } from '@valet/mcp-server'
import type { ToolCallResult, ToolHost } from '@valet/runtime'

/** A call the app refused before the runtime saw it. */
export type AppRefusal = Extract<ToolCallResult, { readonly status: 'failed' }>

export const PAUSED_REFUSAL: AppRefusal = { status: 'failed', stage: 'config', errorClass: 'unavailable' }
export const REVOKED_REFUSAL: AppRefusal = { status: 'failed', stage: 'config', errorClass: 'not-granted' }

export interface CallerHooks {
  readonly paused: () => boolean
  readonly revoked: (client: string) => boolean
  /** A call is about to run. */
  readonly started: (call: ToolCall) => void
  readonly finished: (call: ToolCall, result: ToolCallResult) => void
  /** The app refused a call itself: audit it. A refusal that can't be recorded is still a refusal. */
  readonly refused: (call: ToolCall, refusal: AppRefusal) => Promise<void>
}

export class RuntimeToolCaller implements ToolCaller {
  private tools: readonly ListedTool[] = []
  /** Aborted when the app stops: every call still running is cancelled. */
  private readonly stopping = new AbortController()

  constructor(
    private readonly host: Pick<ToolHost, 'listTools' | 'call'>,
    private readonly hooks: CallerHooks,
  ) {}

  /** Re-reads the runtime's listing. Call before the endpoint's refresh(). */
  async refresh(): Promise<void> {
    this.tools = (await this.host.listTools()).map(
      ({ adapterId, adapterName, declaration, input, output }) => ({
        adapterId,
        adapterName,
        declaration,
        input,
        output,
      }),
    )
  }

  listTools(): readonly ListedTool[] {
    return this.tools
  }

  /** Cancels every call in flight, and every later one, e.g. on quit. */
  cancelAll(): void {
    this.stopping.abort()
  }

  async call(call: ToolCall): Promise<CallOutcome> {
    const refusal = this.hooks.paused()
      ? PAUSED_REFUSAL
      : this.hooks.revoked(call.client)
        ? REVOKED_REFUSAL
        : null
    if (refusal !== null) {
      await this.hooks.refused(call, refusal).catch(() => undefined)
      return outcomeOf(refusal)
    }
    this.hooks.started(call)
    const result = await this.host.call({
      adapterId: call.adapterId,
      tool: call.tool,
      input: call.input,
      client: call.client,
      callId: call.callId,
      signal:
        call.signal instanceof AbortSignal
          ? AbortSignal.any([call.signal, this.stopping.signal])
          : this.stopping.signal,
      ...(call.transport === undefined ? {} : { transport: call.transport }),
    })
    this.hooks.finished(call, result)
    return outcomeOf(result)
  }
}

export function outcomeOf(result: ToolCallResult): CallOutcome {
  switch (result.status) {
    case 'ok':
      return { status: 'ok', output: result.output }
    case 'needsUser':
      return { status: 'needsUser', reason: result.reason }
    case 'failed':
      return { status: 'failed', stage: result.stage, errorClass: result.errorClass }
    case 'blocked':
      // The runtime reports a block by its retry time alone; the site refused or slowed us.
      return {
        status: 'blocked',
        stage: 'tool-run',
        errorClass: 'blocked-by-site',
        retryAfterMs: result.retryAfterMs,
      }
    case 'declined':
      return { status: 'declined' }
  }
}
