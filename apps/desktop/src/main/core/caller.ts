// The MCP endpoint's ToolCaller, over the runtime's ToolHost. Two seams are adapted here:
//
// - listTools: the endpoint lists synchronously, the runtime asynchronously (it reads approvals),
//   so the listing is cached and refreshed (then pushed to the endpoint) whenever approvals change.
// - signals: ToolHost.call takes no abort signal, so a client's cancel can't stop a run. The call
//   runs to its own deadlines; the endpoint drops the late answer.
//
// The app's own refusals come first and never reach the runtime, but are audited like any call
// (hooks.refused writes tool-called and tool-finished for them). Both fail at stage `config`, which
// the runtime never reports for a call, so the log and the client can tell them from the runtime's:
// - while paused: config: unavailable (not a rate limit: the site isn't involved, and a retry
//   succeeds only once the person resumes);
// - a client whose name the person revoked (a label, see clients.ts): config: not-granted.
//
// A call that runs enters the adapter's gate first (adapter-gate.ts), so the app's own login work
// never overlaps it.

import type { CallOutcome, ListedTool, ToolCall, ToolCaller } from '@siteadapter/mcp-server'
import type { ToolCallResult, ToolHost } from '@siteadapter/runtime'

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
  /** Waits until the call may use the adapter; the result is called once the call is done. */
  readonly enter: (adapterId: string) => Promise<() => void>
}

export class RuntimeToolCaller implements ToolCaller {
  private tools: readonly ListedTool[] = []

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
    const leave = await this.hooks.enter(call.adapterId)
    try {
      this.hooks.started(call)
      const result = await this.host.call({
        adapterId: call.adapterId,
        tool: call.tool,
        input: call.input,
        client: call.client,
        callId: call.callId,
      })
      this.hooks.finished(call, result)
      return outcomeOf(result)
    } finally {
      leave()
    }
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
