// The MCP endpoint's ToolCaller, over the runtime's ToolHost. Two seams are adapted here:
//
// - listTools: the endpoint lists synchronously, the runtime asynchronously (it reads approvals),
//   so the listing is cached and refreshed (then pushed to the endpoint) whenever approvals change.
// - signals: ToolHost.call takes no abort signal, so a client's cancel can't stop a run. The call
//   runs to its own deadlines; the endpoint drops the late answer.
//
// The app's own refusals come first and never reach the runtime: while paused, every call is
// blocked; a client whose name the person revoked is refused (a label, see clients.ts).

import type { CallOutcome, ListedTool, ToolCall, ToolCaller } from '@siteadapter/mcp-server'
import type { ToolCallResult, ToolHost } from '@siteadapter/runtime'

/** How long a paused call tells the client to wait before trying again. */
export const PAUSED_RETRY_MS = 5 * 60_000

export interface CallerHooks {
  readonly paused: () => boolean
  readonly revoked: (client: string) => boolean
  /** A call is about to run (or was refused before running). */
  readonly started: (call: ToolCall) => void
  readonly finished: (call: ToolCall, result: ToolCallResult) => void
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
    if (this.hooks.paused()) {
      return {
        status: 'blocked',
        stage: 'tool-run',
        errorClass: 'rate-limited',
        retryAfterMs: PAUSED_RETRY_MS,
      }
    }
    if (this.hooks.revoked(call.client))
      return { status: 'failed', stage: 'manifest', errorClass: 'not-granted' }
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
