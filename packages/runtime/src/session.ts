// session.ensure(): probe the tool partition, and if it is logged out, run the auth action in the
// auth partition and copy the session across. Tool code only ever learns ok, needsUser or failed.
//
// Repeated blind attempts are how accounts get locked, so logins are rationed three ways:
//
//   - The durable attempt marker: if a previous attempt never reached a classified outcome (a
//     crash, a hang, an exception), we refuse to try again until the person clears it.
//   - A durable hold after a classified failure. A rejected password, or a login that "worked" but
//     left the probe logged out, waits for the person; any other failure backs off, doubling.
//   - At most one login per tool call: later ensure()s in the same call get its outcome.
//
// Only an explicit logged-out answer from the probe starts a login (see probe.ts).

import {
  type AdapterManifest,
  type AuditEvent,
  type EnsureResult,
  ERROR_CLASSES,
  type ErrorClass,
  type SessionDriver,
  SiteAdapterError,
  STAGES,
  type Stage,
  type ToolPage,
  toReportable,
} from '@siteadapter/core'
import type { Clock } from './clock'
import type { LoginMarkerState, LoginMarkerStore } from './login-marker'
import { probeLoggedIn } from './probe'
import type { SecretRedactionSet } from './redaction'
import { blockedBySite, type SiteGuards } from './site-protection'
import type { AuthOutcome, AuthRunner, RuntimeDiagnostic } from './types'

export const MARKER_SET_REASON =
  'A previous login attempt did not finish. Check the site, then clear the login marker in the app.'

export const LOGIN_HELD_REASON =
  'The last login attempt failed, so automatic logins are paused for a while. Check the site, or clear the login hold in the app to try now.'

export const LOGIN_NEEDS_PERSON_REASON =
  'The site did not accept the last login. Check the saved credentials, then clear the login hold in the app.'

export interface LoginBackoff {
  /** Wait after the first failed login. Each failure in a row doubles it, up to `maxMs`. */
  readonly baseMs: number
  readonly maxMs: number
}

export const DEFAULT_LOGIN_BACKOFF: LoginBackoff = { baseMs: 5 * 60_000, maxMs: 6 * 60 * 60_000 }

export interface SessionGateOptions {
  readonly adapterId: string
  readonly adapterHash: string
  readonly manifest: AdapterManifest
  readonly driver: SessionDriver
  readonly authRunner: AuthRunner
  readonly markers: LoginMarkerStore
  readonly site: SiteGuards
  readonly secrets: SecretRedactionSet
  readonly clock: Clock
  readonly backoff?: LoginBackoff
  /** Appends an audit event. Must not throw. */
  readonly audit: (event: AuditEvent) => Promise<void>
  readonly diagnostics: (diagnostic: RuntimeDiagnostic) => void
}

/** What one tool call has done about logging in. One per call; the gate writes it. */
export interface CallLogin {
  /** The outcome of this call's login, once it has attempted one. */
  outcome: EnsureResult | null
}

export interface EnsureCall {
  readonly callId: string
  readonly signal: AbortSignal
  /** The raw tool page; the probe is the runtime's own request, not tool code's. */
  readonly page: ToolPage
  readonly login: CallLogin
}

const OK: EnsureResult = { status: 'ok' }

/** What a classified login leaves in the marker store. */
type Disposition = 'clear' | 'backoff' | 'needs-person'

export class SessionGate {
  private inFlight: { readonly owner: CallLogin; readonly running: Promise<EnsureResult> } | null = null

  constructor(private readonly options: SessionGateOptions) {}

  /**
   * Concurrent ensure()s from one call share one probe and at most one login. Throws only
   * blocked-by-site or aborted.
   */
  ensure(call: EnsureCall): Promise<EnsureResult> {
    if (this.inFlight !== null) {
      if (this.inFlight.owner === call.login) return this.inFlight.running
      // Another call's ensure() outlived it (it timed out and its work ignored the abort). Joining
      // would hand us its page, its signal and its result, so refuse rather than share.
      return Promise.resolve(failed('probe', 'unavailable'))
    }
    const running = this.run(call).finally(() => {
      if (this.inFlight?.running === running) this.inFlight = null
    })
    this.inFlight = { owner: call.login, running }
    return running
  }

  private async run(call: EnsureCall): Promise<EnsureResult> {
    const { adapterId, markers, audit } = this.options
    const earlier = call.login.outcome
    if (earlier !== null && earlier.status !== 'ok') return earlier
    const before = await this.probe(call)
    if (before !== false) return before === true ? OK : before
    // This call already logged in and the session is gone again: a second login won't fix that.
    if (earlier !== null) return failed('probe', 'not-logged-in')

    let marker: LoginMarkerState
    try {
      marker = await markers.read(adapterId)
    } catch {
      marker = { kind: 'in-progress' }
    }
    const refusal = this.refusal(marker)
    if (refusal !== null) return refusal
    const failures = marker.kind === 'held' ? marker.failures : 0
    try {
      await markers.set(adapterId, call.callId)
    } catch {
      return failed('auth-step', 'internal')
    }
    await audit({ type: 'login-started', adapterId, callId: call.callId })
    // Recorded before the login runs, so nothing in this call can start a second one.
    call.login.outcome = failed('auth-step', 'internal')
    const outcome = await this.login(call, failures)
    call.login.outcome = outcome
    return outcome
  }

  private refusal(marker: LoginMarkerState): EnsureResult | null {
    switch (marker.kind) {
      case 'unset':
        return null
      case 'in-progress':
        return { status: 'needsUser', reason: MARKER_SET_REASON }
      case 'held':
        if (marker.retryAt === null) return { status: 'needsUser', reason: LOGIN_NEEDS_PERSON_REASON }
        if (this.options.clock.now() < marker.retryAt)
          return { status: 'needsUser', reason: LOGIN_HELD_REASON }
        return null
    }
  }

  /** Runs the auth action, hands off and re-probes, then records the outcome. */
  private async login(call: EnsureCall, failures: number): Promise<EnsureResult> {
    const { adapterId, adapterHash, manifest, driver, authRunner, secrets, audit } = this.options
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
      // Unclassified: the marker stays in progress, so nothing retries this login blindly.
      const reportable = toReportable(error, 'auth-step')
      await audit({ type: 'login-finished', adapterId, outcome: 'failed', ...reportable })
      return failed(reportable.stage, reportable.errorClass)
    }

    switch (outcome.status) {
      case 'blocked':
        await this.finish(outcome, failures, 'clear')
        throw blockedBySite()
      case 'needsUser':
        return this.finish({ status: 'needsUser', reason: outcome.reason }, failures, 'backoff')
      case 'failed': {
        const { stage, errorClass } = inVocabulary(outcome.stage, outcome.errorClass)
        return this.finish(
          failed(stage, errorClass),
          failures,
          errorClass === 'auth-failed' ? 'needs-person' : 'backoff',
        )
      }
      case 'ok':
        break
    }
    try {
      await driver.handoff(manifest.session.cookieDomains, manifest.session.storage)
    } catch (error) {
      const reportable = toReportable(error, 'session-handoff')
      return this.finish(failed(reportable.stage, reportable.errorClass), failures, 'backoff')
    }
    let after: boolean | EnsureResult
    try {
      after = await this.probe(call)
    } catch (error) {
      // Blocked or aborted after a login the auth action reported as done. Nothing says it
      // failed, so record it as it was, and let the next call's probe find out.
      await this.finish(OK, failures, 'clear')
      throw error
    }
    if (after === false) return this.finish(failed('probe', 'not-logged-in'), failures, 'needs-person')
    return this.finish(after === true ? OK : after, failures, 'clear')
  }

  /**
   * Audits the outcome and trips the breaker for a block before touching the marker, so a marker
   * store that fails can't hide a login that happened.
   */
  private async finish(
    result: EnsureResult | { readonly status: 'blocked' },
    failures: number,
    disposition: Disposition,
  ): Promise<EnsureResult> {
    const { adapterId, markers, site, audit, clock } = this.options
    await audit(loginFinished(adapterId, result))
    if (result.status === 'blocked') site.breaker.trip()
    const backoff = this.options.backoff ?? DEFAULT_LOGIN_BACKOFF
    try {
      if (disposition === 'clear') await markers.clear(adapterId)
      else if (disposition === 'needs-person') await markers.hold(adapterId, failures + 1, null)
      else {
        const wait = Math.min(backoff.maxMs, backoff.baseMs * 2 ** failures)
        await markers.hold(adapterId, failures + 1, clock.now() + wait)
      }
    } catch {
      // The marker is still in progress, which only errs towards asking the person.
      return failed('auth-step', 'internal')
    }
    return result.status === 'blocked' ? failed('auth-step', 'blocked-by-site') : result
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

/** Only known vocabulary reaches the audit log or tool code. */
function inVocabulary(stage: string, errorClass: string): { stage: Stage; errorClass: ErrorClass } {
  return {
    stage: STAGES.find((s) => s === stage) ?? 'auth-step',
    errorClass: ERROR_CLASSES.find((c) => c === errorClass) ?? 'internal',
  }
}

function isPassThrough(error: unknown): boolean {
  return (
    error instanceof SiteAdapterError &&
    (error.errorClass === 'blocked-by-site' || error.errorClass === 'aborted')
  )
}

function loginFinished(adapterId: string, result: EnsureResult | { readonly status: 'blocked' }): AuditEvent {
  switch (result.status) {
    case 'ok':
      return { type: 'login-finished', adapterId, outcome: 'ok' }
    case 'needsUser':
      return { type: 'login-finished', adapterId, outcome: 'needsUser' }
    case 'failed':
      return {
        type: 'login-finished',
        adapterId,
        outcome: 'failed',
        ...inVocabulary(result.stage, result.errorClass),
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
