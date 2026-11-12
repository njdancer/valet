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
// - while locked down: config: locked-down, whatever else is set.
// - while paused: config: unavailable (not a rate limit: the site isn't involved, and a retry
//   succeeds only once the person resumes).
// - while the call's site is paused: config: site-paused.
// A client the person revoked never gets this far: its token is gone, so the endpoint refuses it.
//
// The runtime's lock keeps calls and the app's own login work (ToolHost.runLoginStep) on an adapter
// apart, so nothing here waits for either.

import {
  type CallOutcome,
  type ClientIdentity,
  identityLabel,
  type ListedTool,
  type ToolCall,
  type ToolCaller,
} from '@valet/mcp-server'
import type { ToolCallResult, ToolHost } from '@valet/runtime'

/** A call the app refused before the runtime saw it. */
export type AppRefusal = Extract<ToolCallResult, { readonly status: 'failed' }>

export const PAUSED_REFUSAL: AppRefusal = { status: 'failed', stage: 'config', errorClass: 'unavailable' }
export const LOCKED_DOWN_REFUSAL: AppRefusal = {
  status: 'failed',
  stage: 'config',
  errorClass: 'locked-down',
}
/** A tool the client turned off for itself: as if it weren't there. */
export const TOOL_OFF_REFUSAL: AppRefusal = { status: 'failed', stage: 'config', errorClass: 'not-found' }
export const SITE_PAUSED_REFUSAL: AppRefusal = {
  status: 'failed',
  stage: 'config',
  errorClass: 'site-paused',
}

export interface CallerHooks {
  readonly paused: () => boolean
  /** Lock down: every call is refused. Absent: never. */
  readonly lockedDown?: () => boolean
  /** The person paused this one site. Absent: never. */
  readonly sitePaused?: (adapterId: string) => boolean
  /**
   * Site tools this client turned off for itself (valet_turn_off_tool), as `<adapterId>.<tool>`:
   * left out of its listing and refused if it calls one anyway. Absent: none.
   */
  readonly toolsOff?: (identity: ClientIdentity) => ReadonlySet<string>
  /**
   * Adds what the app knows about an outcome for the tool result: which Needs you item it is under
   * (a login window and when it closes, a login given up, a missing setting or login).
   */
  readonly explain?: (call: ToolCall, outcome: CallOutcome) => CallOutcome | Promise<CallOutcome>
  /** A call is about to run. */
  readonly started: (call: ToolCall) => void
  readonly finished: (call: ToolCall, result: ToolCallResult) => void
  /** The app refused a call itself: audit it. A refusal that can't be recorded is still a refusal. */
  readonly refused: (call: ToolCall, refusal: AppRefusal) => Promise<void>
}

const NONE: ReadonlySet<string> = new Set()

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

  listTools(identity?: ClientIdentity): readonly ListedTool[] {
    const off = this.off(identity)
    if (off.size === 0) return this.tools
    return this.tools.filter((t) => !off.has(`${t.adapterId}.${t.declaration.name}`))
  }

  private off(identity: ClientIdentity | undefined): ReadonlySet<string> {
    if (identity === undefined || this.hooks.toolsOff === undefined) return NONE
    try {
      return this.hooks.toolsOff(identity)
    } catch {
      return NONE
    }
  }

  /** Cancels every call in flight, and every later one, e.g. on quit. */
  cancelAll(): void {
    this.stopping.abort()
  }

  /** The app's own refusal of this call, or null to let it through to the runtime. */
  private refusal(call: ToolCall): AppRefusal | null {
    if (this.hooks.lockedDown?.() === true) return LOCKED_DOWN_REFUSAL
    if (this.hooks.paused()) return PAUSED_REFUSAL
    if (this.hooks.sitePaused?.(call.adapterId) === true) return SITE_PAUSED_REFUSAL
    if (this.off(call.identity).has(`${call.adapterId}.${call.tool}`)) return TOOL_OFF_REFUSAL
    return null
  }

  async call(call: ToolCall): Promise<CallOutcome> {
    const refusal = this.refusal(call)
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
      ...(call.identity === undefined ? {} : { clientId: identityLabel(call.identity) }),
      callId: call.callId,
      signal:
        call.signal instanceof AbortSignal
          ? AbortSignal.any([call.signal, this.stopping.signal])
          : this.stopping.signal,
      ...(call.transport === undefined ? {} : { transport: call.transport }),
    })
    this.hooks.finished(call, result)
    const outcome = outcomeOf(result)
    if (this.hooks.explain === undefined) return outcome
    try {
      return await this.hooks.explain(call, outcome)
    } catch {
      return outcome
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
      // Valet's own hourly cap for the site: a wait like a block, with our budget as the cause.
      if (result.cause === 'hourly-cap') {
        return {
          status: 'blocked',
          stage: 'tool-run',
          errorClass: 'rate-limited',
          retryAfterMs: result.retryAfterMs,
        }
      }
      // The runtime reports a block by its retry time alone; the site refused or slowed us.
      return {
        status: 'blocked',
        stage: 'tool-run',
        errorClass: 'blocked-by-site',
        retryAfterMs: result.retryAfterMs,
      }
    case 'busy':
      // Reported as a block the client can wait out, with our own queue as the cause, not the site.
      return {
        status: 'blocked',
        stage: 'tool-run',
        errorClass: 'busy',
        retryAfterMs: result.retryAfterMs,
        ahead: result.ahead,
      }
    case 'logging-in':
      // A wait the client can sit out, with the login as the cause.
      return {
        status: 'blocked',
        stage: 'login',
        errorClass: 'login-in-progress',
        retryAfterMs: result.retryAfterMs,
      }
    case 'declined':
      return result.timedOut === true ? { status: 'declined', timedOut: true } : { status: 'declined' }
  }
}
