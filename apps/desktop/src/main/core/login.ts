// The runtime's AuthRunner, over auth-flow's runAuthFlow, and the login hand-off that follows a
// needsUser. The auth flow owns the login-started, login-finished and secret-used audit events; this
// module adds none.
//
// On needsUser the auth window stays open and is shown to the person with the app's banner above
// it, and the call returns needsUser at once (D50). The window closes itself after HANDOFF_WINDOW_MS.
// When the person says they're done, the login probe runs in the auth partition; only if it says
// logged in is the session handed to the tool partition and the login hold cleared. That runs as a
// login step of the runtime's (ToolHost.runLoginStep): under the adapter's lock, paced by the site's
// rate budget, and a block it meets opens the site's breaker.
//
// The person can also open the login window themselves, from the control panel (startedBy
// 'person'). That hand-off leaves the session's state alone: giving up on it changes nothing, and
// only a probe that passes marks the session logged in.

import type { AuthProbe } from '@valet/auth-flow'
import { readJsonPath, runAuthFlow } from '@valet/auth-flow'
import {
  type AdapterManifest,
  type AuditSink,
  type AuthPage,
  type GrantStore,
  type NeedsUserReason,
  type SecretField,
  type SessionDriver,
  ValetError,
} from '@valet/core'
import {
  type AuthOutcome,
  type AuthRunner,
  type AuthRunRequest,
  blockCause,
  type LoginMarkerStore,
  type LoginStepContext,
} from '@valet/runtime'
import type { NeedsUserItem, SessionStatus } from '../../shared/api'
import type { BlockedAudit, LoginSecrets } from './blocked'
import type { Timers } from './confirmations'
import type { Credentials } from './credentials'

// ---------- Session status ----------

export class SessionTracker {
  private readonly states = new Map<string, SessionStatus>()

  constructor(
    private readonly now: () => Date,
    private readonly onChange: () => void,
  ) {}

  get(adapterId: string): SessionStatus {
    return this.states.get(adapterId) ?? { state: 'unknown', checkedAt: null, needsUser: null, since: null }
  }

  set(adapterId: string, state: SessionStatus['state'], needsUser: NeedsUserReason | null = null): void {
    const at = this.now().toISOString()
    const previous = this.states.get(adapterId)
    const since = previous?.state === state ? previous.since : at
    this.states.set(adapterId, {
      state,
      checkedAt: at,
      needsUser: state === 'needs-user' ? needsUser : null,
      since,
    })
    this.onChange()
  }
}

// ---------- The probe ----------

/** True when `url`'s origin is exactly `home`'s. */
function onHomeOrigin(manifest: AdapterManifest, url: string): boolean {
  try {
    return new URL(url).origin === new URL(manifest.home).origin
  } catch {
    return false
  }
}

/**
 * The hooks auth-flow reads its probe through: the auth page's own fetch (a GET from the main
 * process with the auth partition's cookies, held to the navigation origins every hop) and
 * cookieNames. The probe is narrower still here: home's origin only.
 */
export function authProbe(manifest: AdapterManifest, page: AuthPage, pace?: () => Promise<void>): AuthProbe {
  return {
    async fetch(url) {
      if (!onHomeOrigin(manifest, url)) throw new ValetError('probe', 'host-not-allowed')
      await pace?.()
      return page.fetch(url)
    },
    cookieNames: (domains) => page.cookieNames(domains),
  }
}

/** What a login step gets from ToolHost.runLoginStep: the site's rate budget and its breaker. */
export type LoginStepHooks = Pick<LoginStepContext, 'pace' | 'reportBlocked'>

/**
 * authProbe for a login step: a block signature in the answer (a 429, a 403 page, Akamai's page) opens
 * the site's breaker and ends the step, as the runtime's own probe would.
 */
export function steppedProbe(manifest: AdapterManifest, page: AuthPage, step: LoginStepHooks): AuthProbe {
  const probe = authProbe(manifest, page)
  return {
    async fetch(url) {
      const result = await probe.fetch(url)
      const cause = blockCause(result)
      if (cause !== null) {
        step.reportBlocked(cause)
        throw new ValetError('login', cause)
      }
      return result
    },
    cookieNames: probe.cookieNames,
  }
}

/** The manifest's probe, read the way auth-flow reads it, for a login the person finished by hand. */
export async function probeLoggedIn(manifest: AdapterManifest, probe: AuthProbe): Promise<boolean> {
  const spec = manifest.session.probe
  if (spec.kind === 'cookie')
    return (await probe.cookieNames(manifest.session.cookieDomains)).includes(spec.name)
  const url = new URL(spec.path, manifest.home).toString()
  if (!onHomeOrigin(manifest, url)) return false
  const result = await probe.fetch(url)
  if (result.status !== spec.expectStatus) return false
  if (spec.jsonPath === undefined) return true
  const value = readJsonPath(result.body, spec.jsonPath)
  return spec.equals === undefined ? Boolean(value) : value === spec.equals
}

/** Akamai's "Access Denied … Reference #" page, as the runtime recognises it in the tool partition. */
export async function isBlockedPage(page: AuthPage): Promise<boolean> {
  try {
    return (await page.textPresent('Access Denied')) && (await page.textPresent('Reference #'))
  } catch {
    return false
  }
}

// ---------- Hand-offs ----------

interface Handoff {
  item: NeedsUserItem
  readonly page: AuthPage
  readonly driver: SessionDriver
  readonly manifest: AdapterManifest
  readonly timer: unknown
}

export interface HandoffOptions {
  readonly now: () => number
  readonly timers: Timers
  readonly windowMs: number
  readonly showBanner: (adapterId: string) => void
  readonly closeBanner: (adapterId: string) => void
  readonly markers: LoginMarkerStore
  readonly sessions: SessionTracker
  readonly onChange: () => void
}

export interface HandoffStart {
  readonly manifest: AdapterManifest
  readonly driver: SessionDriver
  readonly page: AuthPage
  readonly reason: NeedsUserReason
  readonly note: string | null
  /** 'call': a tool call's login needed the person. 'person': they opened the window themselves. */
  readonly startedBy: NeedsUserItem['startedBy']
  readonly callId: string | null
  readonly tool: string | null
  readonly client: string | null
  readonly filled: readonly { readonly secret: string; readonly field: SecretField }[]
  readonly filledOrigin: string | null
}

export class Handoffs {
  private readonly open_ = new Map<string, Handoff>()

  constructor(private readonly options: HandoffOptions) {}

  list(): NeedsUserItem[] {
    return [...this.open_.values()].map((h) => h.item)
  }

  has(adapterId: string): boolean {
    return this.open_.has(adapterId)
  }

  /** Shows `page` to the person with the banner. An earlier hand-off for the adapter is closed first. */
  start(start: HandoffStart): void {
    const adapterId = start.manifest.id
    const earlier = this.open_.get(adapterId)
    if (earlier !== undefined) this.dispose(adapterId, earlier)
    const now = this.options.now()
    const timer = this.options.timers.setTimeout(() => void this.close(adapterId), this.options.windowMs)
    const item: NeedsUserItem = {
      kind: 'needs-user',
      id: `nu_${adapterId}`,
      adapterId,
      adapterName: start.manifest.name,
      reason: start.reason,
      note: start.note,
      startedBy: start.startedBy,
      tool: start.tool,
      client: start.client,
      callId: start.callId,
      at: new Date(now).toISOString(),
      filled: [...start.filled],
      filledOrigin: start.filledOrigin,
      navigation: [...start.manifest.navigation],
      windowOpen: true,
      closesAt: new Date(now + this.options.windowMs).toISOString(),
    }
    this.open_.set(adapterId, {
      item,
      page: start.page,
      driver: start.driver,
      manifest: start.manifest,
      timer,
    })
    if (start.startedBy === 'call') this.options.sessions.set(adapterId, 'needs-user', start.reason)
    this.reveal(adapterId)
    this.options.onChange()
  }

  /** Shows the waiting window again. False when nothing is waiting for this adapter. */
  show(adapterId: string): boolean {
    if (!this.open_.has(adapterId)) return false
    this.reveal(adapterId)
    return true
  }

  /**
   * The person says they're signed in: probe the auth partition; only then hand off and clear the
   * hold. Throws, leaving the window up, when the probe says otherwise. Run it as a login step: the
   * probe takes the step's first budget slot, and copying storage keys loads a page, which waits
   * for another.
   */
  async finish(adapterId: string, step: LoginStepHooks): Promise<void> {
    const handoff = this.open_.get(adapterId)
    if (handoff === undefined) throw new ValetError('login', 'not-found')
    const { manifest, page, driver } = handoff
    const probe = steppedProbe(manifest, page, step)
    if (!(await probeLoggedIn(manifest, probe))) throw new ValetError('probe', 'not-logged-in')
    // Cookies are copied inside the browser; storage keys are read and written in loaded pages.
    if (manifest.session.storage.length > 0) await step.pace()
    await driver.handoff(manifest.session.cookieDomains, manifest.session.storage)
    await this.options.markers.clear(adapterId)
    this.dispose(adapterId, handoff)
    this.options.sessions.set(adapterId, 'logged-in')
    this.options.onChange()
  }

  /**
   * The person gives up, or the window's time ran out: close it without a hand-off. A call's
   * hand-off leaves the session expired; one the person opened leaves it as it was.
   */
  async close(adapterId: string): Promise<void> {
    const handoff = this.open_.get(adapterId)
    if (handoff === undefined) return
    this.dispose(adapterId, handoff)
    if (handoff.item.startedBy === 'call') this.options.sessions.set(adapterId, 'expired')
    this.options.onChange()
  }

  closeAll(): void {
    for (const [adapterId, handoff] of [...this.open_]) this.dispose(adapterId, handoff)
  }

  private reveal(adapterId: string): void {
    const handoff = this.open_.get(adapterId)
    if (handoff === undefined) return
    handoff.item = { ...handoff.item, windowOpen: true }
    this.options.showBanner(adapterId)
    // Resolves when the person closes (hides) the window; the hand-off stays until done or given up.
    void handoff.page.handToUser(handoff.item.reason).then(() => {
      const current = this.open_.get(adapterId)
      if (current !== handoff) return
      current.item = { ...current.item, windowOpen: false }
      this.options.closeBanner(adapterId)
      this.options.onChange()
    })
  }

  private dispose(adapterId: string, handoff: Handoff): void {
    this.open_.delete(adapterId)
    this.options.timers.clearTimeout(handoff.timer)
    this.options.closeBanner(adapterId)
    void handoff.page.close().catch(() => undefined)
  }
}

// ---------- The runner ----------

export interface AuthRunnerOptions {
  readonly grants: GrantStore
  readonly credentials: Credentials
  readonly audit: AuditSink
  readonly clock: () => Date
  readonly sleep: (ms: number) => Promise<void>
  readonly typingDelayMs: number
  readonly flowTimeoutMs: number
  readonly sessions: SessionTracker
  readonly handoffs: Handoffs
  /** Audits the login page's refused navigations (partition 'auth'). */
  readonly blocked: BlockedAudit
  /** Keeps what each login registered for redaction, for those audit targets. */
  readonly secrets: LoginSecrets
  /** The tool and client of the call that needed the login, for the banner. */
  readonly callInfo: (callId: string | null) => {
    readonly tool: string | null
    readonly client: string | null
  }
  /** Secret fields this login filled, and where: read back from the audit events it wrote. */
  readonly filledFor: (
    adapterId: string,
    callId: string | null,
    since: Date,
  ) => Promise<{ filled: { secret: string; field: SecretField }[]; origin: string | null }>
}

export function createAuthRunner(options: AuthRunnerOptions): AuthRunner {
  return async (request: AuthRunRequest): Promise<AuthOutcome> => {
    const { manifest, adapterHash, driver, callId } = request
    const adapterId = manifest.id
    const startedAt = options.clock()
    options.sessions.set(adapterId, 'logging-in')
    const secrets = options.secrets.begin(adapterId)
    let finished: 'ok' | 'needs-user' | 'failed' = 'failed'
    let page: AuthPage
    try {
      page = await driver.openAuthPage(options.blocked.authPage(adapterId, callId))
    } catch (error) {
      secrets.finish('failed')
      throw error
    }
    let handedToPerson = false
    try {
      const outcome = await runAuthFlow({
        manifest,
        adapterHash,
        callId,
        page,
        grants: options.grants,
        providers: options.credentials.providers(),
        otpReader: options.credentials.otpReader(),
        // The login's navigations and its probe wait on the site's budget, as tool calls do (D55).
        probe: authProbe(manifest, page, () => request.pace()),
        paceNavigation: () => request.pace(),
        isBlockedPage: () => isBlockedPage(page),
        // The runtime clones what it is given and keeps the clone, and so do the app's own login
        // secrets (for the audit's targets); this copy is ours to dispose.
        rememberSecret: (copy) => {
          try {
            secrets.register(copy)
            request.registerForRedaction(copy)
          } finally {
            copy.dispose()
          }
        },
        audit: options.audit,
        clock: options.clock,
        sleep: options.sleep,
        typingDelayMs: options.typingDelayMs,
        flowTimeoutMs: options.flowTimeoutMs,
        // The call giving up stops the login too, so it doesn't run on to its own deadline.
        signal: request.signal,
        beforeAttempt: () => request.attemptStarting(),
      })
      switch (outcome.status) {
        case 'ok':
          finished = 'ok'
          options.sessions.set(adapterId, 'logged-in')
          return { status: 'ok' }
        case 'needsUser': {
          const info = options.callInfo(callId)
          const filled = await options.filledFor(adapterId, callId, startedAt)
          handedToPerson = true
          finished = 'needs-user'
          options.handoffs.start({
            manifest,
            driver,
            page,
            reason: outcome.reason,
            // The manifest's note, for the banner only: never returned to the runtime or a client.
            note: outcome.appNote ?? null,
            startedBy: 'call',
            callId,
            tool: info.tool,
            client: info.client,
            filled: filled.filled,
            filledOrigin: filled.origin,
          })
          return { status: 'needsUser', reason: outcome.reason }
        }
        case 'failed':
          options.sessions.set(adapterId, 'expired')
          return {
            status: 'failed',
            stage: outcome.stage,
            errorClass: outcome.errorClass,
            ...(outcome.attemptStarted === undefined ? {} : { attemptStarted: outcome.attemptStarted }),
          }
        case 'blocked':
          options.sessions.set(adapterId, 'expired')
          return { status: 'blocked', errorClass: outcome.errorClass }
      }
    } finally {
      secrets.finish(finished)
      if (!handedToPerson) await page.close().catch(() => undefined)
    }
  }
}
