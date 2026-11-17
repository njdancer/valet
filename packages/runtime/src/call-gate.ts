// The checks every capability that sends something shares, whatever it sends through: the page's
// fetch and goto (guarded-page.ts) and the egress broker's fetch and sockets (guarded-http.ts). A
// declaration within the tool's side effect, the run's request ceiling, the site's rate budget and
// breaker, and the request-blocked record and sticky violation for whatever is refused.

import {
  type AdapterManifest,
  type AuditEvent,
  type ErrorClass,
  type Purpose,
  type RequestDeclaration,
  type Stage,
  ValetError,
} from '@valet/core'
import type { CallState } from './call-state'
import type { Clock } from './clock'
import { type BlockCause, breakerRefusal, type SiteGuards, siteRefusal } from './site-protection'

export const PURPOSE_RANK: Readonly<Record<Purpose, number>> = { read: 0, write: 1, irreversible: 2 }

/** Headers some servers honour to turn one method into another, which would bypass method matching. */
export const METHOD_OVERRIDE_HEADERS = ['x-http-method-override', 'x-http-method', 'x-method-override']

export const MAX_TARGET_LENGTH = 300

/** Waits shorter than this aren't worth a line in the trace. */
export const NOTEWORTHY_WAIT_MS = 1000

export interface CallGateOptions {
  readonly adapterId: string
  readonly manifest: AdapterManifest
  /** The running tool's declared side effect. A request may not do more than its tool declares. */
  readonly sideEffect: Purpose
  /**
   * The irreversible declarations the running tool names (C15), the manifest's own objects. An
   * irreversible declaration not among them is refused to this tool whatever its side effect.
   */
  readonly unlocks?: readonly RequestDeclaration[]
  readonly site: SiteGuards
  readonly state: CallState
  /** Appends an audit event. Must not throw. */
  readonly audit: (event: AuditEvent) => Promise<void>
  /** Times the wait for the site's next request slot, so a long one can be recorded. */
  readonly clock?: Clock
}

export class CallGate {
  constructor(private readonly options: CallGateOptions) {}

  /** Within the tool's side effect, and for an irreversible declaration, one the tool names. */
  mayUse(declared: RequestDeclaration): boolean {
    if (PURPOSE_RANK[declared.purpose] > PURPOSE_RANK[this.options.sideEffect]) return false
    return declared.purpose !== 'irreversible' || (this.options.unlocks ?? []).includes(declared)
  }

  /**
   * Counts the request against the ceiling and waits for the site's rate budget. Returns the
   * breaker's admission token for recordSuccess().
   */
  async admit(method: string, target: URL, raw: unknown): Promise<number> {
    const { state, manifest } = this.options
    state.requests++
    if (state.requests > manifest.limits.requestsPerRun) {
      return this.deny('request-surface', 'request-ceiling', method, target, raw)
    }
    return this.pace()
  }

  /** Waits for the site's rate budget, refusing while its breaker is open. */
  async pace(): Promise<number> {
    const { state, site } = this.options
    if (site.breaker.isOpen()) {
      state.blocked = true
      throw breakerRefusal()
    }
    const { clock, adapterId, audit } = this.options
    const before = clock?.now() ?? 0
    await site.budget.acquire(state.signal)
    const waitedMs = (clock?.now() ?? 0) - before
    if (waitedMs >= NOTEWORTHY_WAIT_MS) {
      await audit({ type: 'call-waited', adapterId, callId: state.callId, reason: 'pace', waitedMs })
    }
    state.assertLive()
    // The breaker can open while we wait our turn.
    if (site.breaker.isOpen()) {
      state.blocked = true
      throw breakerRefusal()
    }
    return site.breaker.admit()
  }

  /** The site refused us: trip its breaker and end the call. */
  siteBlocked(cause: BlockCause): never {
    const { state, site } = this.options
    state.blocked = true
    site.breaker.trip(cause, state.callId)
    throw siteRefusal(cause)
  }

  async deny(
    stage: Stage,
    errorClass: ErrorClass,
    method: string,
    target: URL | null,
    raw: unknown,
  ): Promise<never> {
    const { state, adapterId, audit } = this.options
    const error = new ValetError(stage, errorClass)
    state.violation ??= error
    await audit({
      type: 'request-blocked',
      adapterId,
      method: plainMethod(method),
      target: state.redactTarget(describeTarget(target), raw),
      reason: errorClass,
      initiator: 'tool',
      partition: 'tool',
      callId: state.callId,
    })
    throw error
  }
}

/** decideRequest's reasons as the error classes a refusal reports. */
export const SURFACE_CLASS = {
  'host-not-allowed': 'host-not-allowed',
  'bad-url': 'host-not-allowed',
  undeclared: 'undeclared-request',
  'denied-path': 'denied-path',
  'ambiguous-path': 'ambiguous-path',
} as const satisfies Record<string, ErrorClass>

/** An HTTP method as it may appear in the audit log; anything else is recorded as INVALID. */
export function plainMethod(method: unknown): string {
  return typeof method === 'string' && /^[A-Z]{1,10}$/.test(method) ? method : 'INVALID'
}

/** Origin and path only: query strings and fragments can carry data. */
export function describeTarget(target: URL | null): string {
  if (target === null) return '(unparseable)'
  return `${target.origin}${target.pathname}`.slice(0, MAX_TARGET_LENGTH)
}

export function headerValue(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name)
  return key === undefined ? undefined : headers[key]
}
