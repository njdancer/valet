// session.ensure(): probe the tool partition, and if it is logged out, run the auth action in the
// auth partition and copy the session across. Tool code only ever learns ok, needsUser or failed.
//
// A login is guarded by the durable attempt marker: if a previous attempt never reached a
// classified outcome (a crash, a hang, an exception), we refuse to try again until the person
// clears it, because repeated blind attempts are how accounts get locked.

import {
  type AdapterManifest,
  type AuditEvent,
  type EnsureResult,
  type ErrorClass,
  type SessionDriver,
  SiteAdapterError,
  type Stage,
  type ToolPage,
  toReportable,
} from '@siteadapter/core'
import type { LoginMarkerStore } from './login-marker'
import { probeLoggedIn } from './probe'
import type { SecretRedactionSet } from './redaction'
import { blockedBySite, type SiteGuards } from './site-protection'
import type { AuthOutcome, AuthRunner, RuntimeDiagnostic } from './types'

export const MARKER_SET_REASON =
  'A previous login attempt did not finish. Check the site, then clear the login marker in the app.'

export interface SessionGateOptions {
  readonly adapterId: string
  readonly adapterHash: string
  readonly manifest: AdapterManifest
  readonly driver: SessionDriver
  readonly authRunner: AuthRunner
  readonly markers: LoginMarkerStore
  readonly site: SiteGuards
  readonly secrets: SecretRedactionSet
  /** Appends an audit event. Must not throw. */
  readonly audit: (event: AuditEvent) => Promise<void>
  readonly diagnostics: (diagnostic: RuntimeDiagnostic) => void
}

export interface EnsureCall {
  readonly callId: string
  readonly signal: AbortSignal
  /** The raw tool page; the probe is the runtime's own request, not tool code's. */
  readonly page: ToolPage
}

const OK: EnsureResult = { status: 'ok' }

export class SessionGate {
  private inFlight: Promise<EnsureResult> | null = null

  constructor(private readonly options: SessionGateOptions) {}

  /** Concurrent callers share one probe and at most one login. Throws only blocked-by-site or aborted. */
  ensure(call: EnsureCall): Promise<EnsureResult> {
    if (this.inFlight !== null) return this.inFlight
    const running = this.run(call).finally(() => {
      this.inFlight = null
    })
    this.inFlight = running
    return running
  }

  private async run(call: EnsureCall): Promise<EnsureResult> {
    const { adapterId, adapterHash, manifest, driver, authRunner, markers, site, secrets, audit } =
      this.options
    const before = await this.probe(call)
    if (before !== false) return before === true ? OK : before

    let markerSet: boolean
    try {
      markerSet = await markers.isSet(adapterId)
    } catch {
      markerSet = true
    }
    if (markerSet) return { status: 'needsUser', reason: MARKER_SET_REASON }
    try {
      await markers.set(adapterId, call.callId)
    } catch {
      return failed('auth-step', 'internal')
    }
    await audit({ type: 'login-started', adapterId, callId: call.callId })

    let outcome: AuthOutcome
    try {
      outcome = await authRunner({
        adapterId,
        adapterHash,
        manifest,
        driver,
        callId: call.callId,
        signal: call.signal,
        rememberSecret: (secret) => secrets.remember(secret),
      })
    } catch (error) {
      // Unclassified: the marker stays set, so nothing retries this login blindly.
      const reportable = toReportable(error, 'auth-step')
      await audit({ type: 'login-finished', adapterId, outcome: 'failed', ...reportable })
      return failed(reportable.stage, reportable.errorClass)
    }

    let handoffFailure: EnsureResult | null = null
    if (outcome.status === 'ok') {
      try {
        await driver.handoff(manifest.session.cookieDomains, manifest.session.storage)
      } catch (error) {
        const reportable = toReportable(error, 'session-handoff')
        handoffFailure = failed(reportable.stage, reportable.errorClass)
      }
    }
    try {
      await markers.clear(adapterId)
    } catch {
      // Still set, which only errs towards asking the person.
      return failed('auth-step', 'internal')
    }
    await audit(loginFinished(adapterId, outcome))

    switch (outcome.status) {
      case 'blocked':
        site.breaker.trip()
        throw blockedBySite()
      case 'needsUser':
        return { status: 'needsUser', reason: outcome.reason }
      case 'failed':
        return failed(outcome.stage, outcome.errorClass)
    }
    if (handoffFailure !== null) return handoffFailure
    const after = await this.probe(call)
    if (after === true) return OK
    return after === false ? failed('probe', 'not-logged-in') : after
  }

  /** true or false from the probe, or a failure to report. Rethrows blocked-by-site and aborted. */
  private async probe(call: EnsureCall): Promise<boolean | EnsureResult> {
    try {
      return await probeLoggedIn({
        manifest: this.options.manifest,
        page: call.page,
        site: this.options.site,
        signal: call.signal,
        onUnsupported: (kind) =>
          this.options.diagnostics({ type: 'unsupported-probe', adapterId: this.options.adapterId, kind }),
      })
    } catch (error) {
      if (isPassThrough(error)) throw error
      const reportable = toReportable(error, 'probe')
      return failed(reportable.stage, reportable.errorClass)
    }
  }
}

function failed(stage: Stage, errorClass: ErrorClass): EnsureResult {
  return { status: 'failed', stage, errorClass }
}

function isPassThrough(error: unknown): boolean {
  return (
    error instanceof SiteAdapterError &&
    (error.errorClass === 'blocked-by-site' || error.errorClass === 'aborted')
  )
}

function loginFinished(adapterId: string, outcome: AuthOutcome): AuditEvent {
  switch (outcome.status) {
    case 'ok':
      return { type: 'login-finished', adapterId, outcome: 'ok' }
    case 'needsUser':
      return { type: 'login-finished', adapterId, outcome: 'needsUser' }
    case 'failed':
      return {
        type: 'login-finished',
        adapterId,
        outcome: 'failed',
        stage: outcome.stage,
        errorClass: outcome.errorClass,
      }
    case 'blocked':
      return {
        type: 'login-finished',
        adapterId,
        outcome: 'failed',
        stage: 'auth-step',
        errorClass: 'blocked-by-site',
      }
  }
}
