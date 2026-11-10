// The remote policy: a ToolCaller wrapper the remote listener puts in front of the same caller the
// local listener uses (D41). Everything a remote call goes through after this (the runtime's
// ToolHost, rate budgets, breakers, confirmations on the Mac, the audit log) is the local path.
//
// - Default deny. A tool is offered and callable remotely only while the policy says so; the app
//   keeps that per tool, off until the person turns it on (relay.md, "Per-tool remote policy"),
//   and per client, as the tools the person ticked when they approved it on the Mac.
// - tools/list shows each client only the tools it may call, so a remote client can't see what else is installed.
//   A call to a tool turned off since the client listed fails as not-found, never as "not allowed".
// - Each remote client has a cap on calls per hour, applied before the site's own rate budget, so a
//   client stuck in a loop spends its own quota and not the person's standing with the site.
// - Only calls whose credential is a remote one pass: a local identity here means miswiring.
// - abortInFlight() fails every running remote call with aborted, for the kill switch.

import type { ToolDeclaration } from '@valet/core'
import type { ClientIdentity } from './auth'
import type { CallOutcome, ListedTool, ToolCall, ToolCaller } from './tool-caller'

export interface RemotePolicy {
  /**
   * Whether this tool, as declared now, may be listed and called by a remote client: the one with
   * this registration id, whose grant must cover it, or (null) any remote client at all.
   */
  allows(adapterId: string, declaration: ToolDeclaration, clientId: string | null): boolean
}

/** relay.md's starting point for one person; a setting, not a constant. */
export const DEFAULT_REMOTE_CALLS_PER_HOUR = 120
const HOUR_MS = 60 * 60_000

/** Why the policy refused a call before the inner caller saw it. */
export type RemoteRefusal = 'not-remote' | 'not-enabled' | 'over-cap'

export interface RemotePolicyOptions {
  readonly callsPerHour?: number
  readonly now?: () => number
  /**
   * The policy refused a call: audit it. Awaited, so the record is written before the client hears;
   * a refusal that can't be recorded is still a refusal.
   */
  readonly refused?: (call: ToolCall, reason: RemoteRefusal, outcome: CallOutcome) => Promise<void>
}

export const NOT_REMOTE_ENABLED: CallOutcome = { status: 'failed', stage: 'config', errorClass: 'not-found' }

export class RemotePolicyCaller implements ToolCaller {
  private readonly callsPerHour: number
  private readonly now: () => number
  /** Start times of each client's calls within the last hour, oldest first. */
  private readonly recent = new Map<string, number[]>()
  private inFlight = new AbortController()

  constructor(
    private readonly inner: ToolCaller,
    private readonly policy: RemotePolicy,
    private readonly options: RemotePolicyOptions = {},
  ) {
    this.callsPerHour = options.callsPerHour ?? DEFAULT_REMOTE_CALLS_PER_HOUR
    this.now = options.now ?? Date.now
  }

  listTools(identity?: ClientIdentity): readonly ListedTool[] {
    // A local identity here is miswiring, and sees nothing.
    if (identity !== undefined && identity.origin !== 'remote') return []
    const clientId = identity?.clientId ?? null
    return this.inner
      .listTools()
      .filter((tool) => this.policy.allows(tool.adapterId, tool.declaration, clientId))
  }

  async call(call: ToolCall): Promise<CallOutcome> {
    if (call.identity?.origin !== 'remote') return this.refuse(call, 'not-remote', NOT_REMOTE_ENABLED)
    if (!this.allowed(call.adapterId, call.tool, call.identity.clientId))
      return this.refuse(call, 'not-enabled', NOT_REMOTE_ENABLED)
    const retryAfterMs = this.spend(call.identity.clientId)
    if (retryAfterMs !== null) {
      return this.refuse(call, 'over-cap', {
        status: 'blocked',
        stage: 'config',
        errorClass: 'rate-limited',
        retryAfterMs,
      })
    }
    const stop = this.inFlight.signal
    return this.inner.call({
      ...call,
      signal: call.signal instanceof AbortSignal ? AbortSignal.any([call.signal, stop]) : stop,
    })
  }

  /** Aborts every remote call running now. Later calls run normally. */
  abortInFlight(): void {
    const running = this.inFlight
    this.inFlight = new AbortController()
    running.abort()
  }

  /** Forgets every client's call count, e.g. when the person revokes all remote clients. */
  resetCounts(): void {
    this.recent.clear()
  }

  /** Looked up afresh by name: the policy and the tool's current declaration both decide. */
  private allowed(adapterId: string, tool: string, clientId: string): boolean {
    const listed = this.inner
      .listTools()
      .find((t) => t.adapterId === adapterId && t.declaration.name === tool)
    return listed !== undefined && this.policy.allows(adapterId, listed.declaration, clientId)
  }

  /** Counts a call against the client's hour. Null when it fits; else how long until one would. */
  private spend(clientId: string): number | null {
    const now = this.now()
    const times = (this.recent.get(clientId) ?? []).filter((t) => now - t < HOUR_MS)
    if (times.length >= this.callsPerHour) {
      this.recent.set(clientId, times)
      return Math.max(1, (times[0] as number) + HOUR_MS - now)
    }
    times.push(now)
    this.recent.set(clientId, times)
    return null
  }

  private async refuse(call: ToolCall, reason: RemoteRefusal, outcome: CallOutcome): Promise<CallOutcome> {
    await this.options.refused?.(call, reason, outcome).catch(() => undefined)
    return outcome
  }
}
