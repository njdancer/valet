// session.ensure(): probe the tool partition, and if it is logged out, run the auth action in the
// auth partition and copy the session across. Tool code only ever learns ok, needsUser (a reason
// code) or failed (a stage and class).
//
// Repeated blind attempts are how accounts get locked, so logins are rationed three ways:
//
//   - The durable attempt marker: if a previous attempt never reached a classified outcome (a
//     crash, a hang, an exception), we refuse to try again until the person clears it.
//   - A durable hold after a classified failure. A rejected password, a login that "worked" but
//     left the probe logged out, or a needsUser that retrying can only make worse (a locked
//     account, a CAPTCHA, new terms, a changed site) waits for the person; any other failure backs
//     off, doubling. The hold keeps the needsUser reason, so callers keep seeing the real one.
//   - At most one login per tool call: later ensure()s in the same call get its outcome.
//
// Only an explicit logged-out answer from the probe starts a login (see probe.ts), and never while
// the site's breaker is open.
//
// Where the manifest's probe sets trustSeconds, a write tool's first ensure() in a call may rest
// on the last "logged in" answer for that long instead of probing again (see trusted()). Nothing
// else is ever skipped: a logged-out answer is never remembered.
//
// The AuthRunner owns the login-started and login-finished audit events (auth-flow's runAuthFlow
// writes them); the gate writes neither, so one login is one pair in the log. What happens after
// the runner returns (the handoff, the re-probe) reaches the log through the call's tool-finished.
//
// The gate also keeps clones of the secrets the latest successful login registered, for output
// redaction, until the next successful login replaces them: a page shown long after the login (an
// account page with the username) is still checked against them.

import {
  type AdapterManifest,
  type EnsureResult,
  ERROR_CLASSES,
  type ErrorClass,
  NEEDS_USER_REASONS,
  type NeedsUserReason,
  type SessionDriver,
  STAGES,
  type Stage,
  type ToolPage,
  toReportable,
  ValetError,
} from '@valet/core'
import type { Clock } from './clock'
import type { LoginMarkerState, LoginMarkerStore } from './login-marker'
import { onProbeOrigin, probeLoggedIn } from './probe'
import { SecretRedactionSet } from './redaction'
import {
  type BlockCause,
  breakerRefusal,
  isSiteRefusal,
  type SiteGuards,
  siteRefusal,
} from './site-protection'
import type { AuthOutcome, AuthRunner } from './types'

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
  readonly clock: Clock
  readonly backoff?: LoginBackoff
}

/** What one tool call has done about logging in. One per call; the gate writes it. */
export interface CallLogin {
  /** The outcome of this call's login, once it has attempted one. */
  outcome: EnsureResult | null
  /** Set once this call has asked ensure() anything, so only its first ask may rest on trust. */
  asked?: boolean
}

export interface EnsureCall {
  readonly callId: string
  readonly signal: AbortSignal
  /** The raw tool page; the probe is the runtime's own request, not tool code's. */
  readonly page: ToolPage
  readonly login: CallLogin
  /**
   * Whether this call may rest on a recent "logged in" answer instead of a probe, where the
   * manifest's probe sets trustSeconds. The tool host says yes for write tools only.
   */
  readonly mayTrust?: boolean
}

const OK: EnsureResult = { status: 'ok' }

/**
 * What a classified login leaves in the marker store. `restore` puts back what was there before
 * the login started: nothing, or the expired hold with its failure count.
 */
type Disposition = 'clear' | 'backoff' | 'needs-person' | 'restore'

/**
 * needsUser reasons that an automatic retry can only make worse: retrying a locked account can
 * extend the lockout, and retrying a CAPTCHA wall raises the bot score. These wait for the person.
 */
const NEEDS_PERSON: ReadonlySet<NeedsUserReason> = new Set<NeedsUserReason>([
  'account-locked',
  'captcha',
  'terms-update',
  'site-changed',
])

export class SessionGate {
  private inFlight: { readonly owner: CallLogin; readonly running: Promise<EnsureResult> } | null = null
  private session = new SecretRedactionSet()
  /** When the probe last answered "logged in", until anything suggests the session changed. */
  private confirmedAt: number | null = null

  constructor(private readonly options: SessionGateOptions) {}

  /** Clones of the secrets the latest successful login registered; replaced by the next one. */
  get secrets(): SecretRedactionSet {
    return this.session
  }

  /** Forgets the last "logged in" answer, so the next ensure() probes. */
  distrust(): void {
    this.confirmedAt = null
  }

  /**
   * Whether a call's first ensure() may be answered without a probe: the manifest allows it, the
   * probe said "logged in" within its trustSeconds and nothing since has cast doubt on that, and
   * the page is still where its requests carry the session.
   */
  private trusted(call: EnsureCall): boolean {
    const probe = this.options.manifest.session.probe
    if (call.mayTrust !== true || probe.kind !== 'fetch' || this.confirmedAt === null) return false
    const age = this.options.clock.now() - this.confirmedAt
    if (!(age >= 0 && age < (probe.trustSeconds ?? 0) * 1000)) return false
    return onProbeOrigin(this.options.manifest, call.page)
  }

  /**
   * Concurrent ensure()s from one call share one probe and at most one login. Throws only a site
   * refusal (blocked-by-site, rate-limited) or aborted.
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
    const { adapterId, markers, site } = this.options
    const earlier = call.login.outcome
    if (earlier !== null && earlier.status !== 'ok') return earlier
    // A second ensure() in one call means the tool met a logged-out answer: that one always probes.
    const first = call.login.asked !== true
    call.login.asked = true
    if (first && earlier === null && this.trusted(call)) return OK
    const before = await this.probe(call)
    if (before !== false) return before === true ? OK : before
    // This call already logged in and the session is gone again: a second login won't fix that.
    if (earlier !== null) return failed('probe', 'not-logged-in')
    // A cookie probe never touches the site, so the breaker hasn't been asked yet. A login would.
    if (site.breaker.isOpen()) throw breakerRefusal()

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
      return failed('login', 'login-in-progress')
    }
    // Recorded before the login runs, so nothing in this call can start a second one.
    call.login.outcome = failed('login', 'login-in-progress')
    const outcome = await this.login(call, failures)
    call.login.outcome = outcome
    return outcome
  }

  /**
   * Whether the marker store lets a login start now. An unfinished attempt is pending until the
   * person clears it; a hold means a login is needed that we won't attempt ourselves yet.
   */
  private refusal(marker: LoginMarkerState): EnsureResult | null {
    switch (marker.kind) {
      case 'unset':
        return null
      case 'in-progress': {
        // D35: a login that stopped before typing anything spent no attempt at the site. It holds
        // like a first failure's backoff, then clears itself; one that may have typed waits for
        // the person.
        if (marker.attempted !== false || marker.startedAt === undefined)
          return needsUser('login-attempt-pending')
        const backoff = this.options.backoff ?? DEFAULT_LOGIN_BACKOFF
        if (this.options.clock.now() >= marker.startedAt + backoff.baseMs) return null
        return needsUser('login-required')
      }
      case 'held':
        if (marker.retryAt !== null && this.options.clock.now() >= marker.retryAt) return null
        return needsUser(marker.reason ?? 'login-required')
    }
  }

  /** Runs the auth action, hands off and re-probes, then records the outcome. */
  private async login(call: EnsureCall, failures: number): Promise<EnsureResult> {
    const { adapterId, adapterHash, manifest, driver, authRunner } = this.options
    const fresh = new SecretRedactionSet()
    const { breaker, budget } = this.options.site
    // The breaker counts its trips; any trip after this one means the site refused us mid-login.
    const tripsBefore = breaker.admit()
    const pace = async (): Promise<void> => {
      if (breaker.isOpen()) throw new ValetError('login', 'blocked-by-site')
      await budget.acquire(call.signal)
      if (breaker.isOpen()) throw new ValetError('login', 'blocked-by-site')
    }
    let outcome: AuthOutcome
    try {
      outcome = await authRunner({
        adapterId,
        adapterHash,
        manifest,
        driver,
        callId: call.callId,
        signal: call.signal,
        registerForRedaction: (secret) => fresh.register(secret),
        attemptStarting: () => this.options.markers.markAttempted(adapterId),
        pace,
        siteRefused: () => breaker.admit() !== tripsBefore,
      })
    } catch (error) {
      // Unclassified: the marker stays in progress, so nothing retries this login blindly.
      fresh.dispose()
      const reportable = toReportable(error, 'login')
      return failed(reportable.stage, reportable.errorClass)
    }
    if (outcome.status === 'ok') this.adopt(fresh, outcome.filledSecrets)
    else fresh.dispose()

    switch (outcome.status) {
      case 'blocked': {
        const cause: BlockCause = outcome.errorClass === 'rate-limited' ? 'rate-limited' : 'blocked-by-site'
        // The breaker first, so a marker store that fails can't hide the block.
        this.options.site.breaker.trip(cause, call.callId)
        await this.finish(OK, failures, 'clear')
        throw siteRefusal(cause)
      }
      case 'needsUser': {
        const reason = knownReason(outcome.reason)
        const disposition = NEEDS_PERSON.has(reason) ? 'needs-person' : 'backoff'
        return this.finish(needsUser(reason), failures, disposition, reason)
      }
      case 'failed': {
        const { stage, errorClass } = inVocabulary(outcome.stage, outcome.errorClass)
        if (errorClass === 'aborted') {
          // The call gave up and the login stopped. Before any password or code was typed, the site
          // saw no attempt, so the marker goes back to what it was. After, or if the runner can't
          // say, it stays in progress for the person, as after a crash.
          if (outcome.attemptStarted === false)
            return this.finish(failed(stage, errorClass), failures, 'restore')
          return failed(stage, errorClass)
        }
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
   * Takes up the secrets a successful login registered, in place of the last one's. A runner that
   * says it filled more secrets than it registered leaves the set incomplete, so every output is
   * withheld until a login registers them all.
   */
  private adopt(fresh: SecretRedactionSet, filled: unknown): void {
    if (typeof filled === 'number' && !(filled <= fresh.size)) fresh.markIncomplete()
    this.session.dispose()
    this.session = fresh
  }

  /** Clears the marker, or replaces it with a hold, and returns `result`. */
  private async finish(
    result: EnsureResult,
    failures: number,
    disposition: Disposition,
    reason?: NeedsUserReason,
  ): Promise<EnsureResult> {
    const { adapterId, markers, clock } = this.options
    const backoff = this.options.backoff ?? DEFAULT_LOGIN_BACKOFF
    try {
      if (disposition === 'clear' || (disposition === 'restore' && failures === 0))
        await markers.clear(adapterId)
      else if (disposition === 'restore') await markers.hold(adapterId, failures, clock.now())
      else if (disposition === 'needs-person') await markers.hold(adapterId, failures + 1, null, reason)
      else {
        const wait = Math.min(backoff.maxMs, backoff.baseMs * 2 ** failures)
        await markers.hold(adapterId, failures + 1, clock.now() + wait, reason)
      }
    } catch {
      // The marker is still in progress, which only errs towards asking the person.
      return failed('login', 'login-in-progress')
    }
    return result
  }

  /** true or false from the probe, or a failure to report. Rethrows site refusals and aborted. */
  private async probe(call: EnsureCall): Promise<boolean | EnsureResult> {
    // Only a probe that answers "logged in" is remembered; any other ending forgets the last one.
    this.confirmedAt = null
    try {
      const loggedIn = await this.ask(call)
      if (loggedIn) this.confirmedAt = this.options.clock.now()
      return loggedIn
    } catch (error) {
      if (isPassThrough(error)) throw error
      const reportable = toReportable(error, 'probe')
      return failed(reportable.stage, reportable.errorClass)
    }
  }

  private ask(call: EnsureCall): Promise<boolean> {
    return probeLoggedIn({
      manifest: this.options.manifest,
      page: call.page,
      driver: this.options.driver,
      site: this.options.site,
      signal: call.signal,
      callId: call.callId,
    })
  }
}

function failed(stage: Stage, errorClass: ErrorClass): EnsureResult {
  return { status: 'failed', stage, errorClass }
}

function needsUser(reason: NeedsUserReason): EnsureResult {
  return { status: 'needsUser', reason }
}

/** Only known vocabulary reaches the audit log or tool code. */
function inVocabulary(stage: string, errorClass: string): { stage: Stage; errorClass: ErrorClass } {
  return {
    stage: STAGES.find((s) => s === stage) ?? 'login',
    errorClass: ERROR_CLASSES.find((c) => c === errorClass) ?? 'internal',
  }
}

/** The auth runner is injected; a reason outside the vocabulary becomes 'other'. */
export function knownReason(reason: unknown): NeedsUserReason {
  return NEEDS_USER_REASONS.find((r) => r === reason) ?? 'other'
}

function isPassThrough(error: unknown): boolean {
  return isSiteRefusal(error) || (error instanceof ValetError && error.errorClass === 'aborted')
}
