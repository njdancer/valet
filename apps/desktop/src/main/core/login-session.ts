// Login sessions (docs/agent-browser.md, "Login sessions"): an agent works out or repairs an
// installed site's sign-in with tools alone. browser_session_create with `login` opens the adapter's
// own login page, in its auth partition, and browser_login_steps runs auth steps there through
// auth-flow's LoginWorkbench: the same interpreter, secret filler and checks a real login has. The
// agent sees the page only through describe(), cleaned as a stalled login's is (login-stall.ts):
// no field values, no line holding a secret this session typed.
//
// The walls, beyond a login's own:
// - Clicks and typing only while the main frame is on a login origin (the origins the manifest's
//   secrets may be typed on). Elsewhere on the site, the session can look but not act, so a session
//   that has logged in can't go on to change anything in the person's account.
// - Each batch is one of the runtime's login steps: under the adapter's lock (no real login or
//   call runs beside it), paced by the site's budget, and a block it meets opens the breaker.
// - It never copies the session to the tool partition: only a real login hands a session to tools.
// - 30 minutes at most, and the agents' browser's idle close too.
// - Opening one is the person's call: today, only while developer mode is on.

import { LoginWorkbench, type WorkbenchOutcome } from '@valet/auth-flow'
import type { AriaPage, ConsoleMessage, CookieRecord, DownloadNews, LogEntry } from '@valet/browser-electron'
import {
  type AdapterManifest,
  type AuditSink,
  type AuthPage,
  type AuthStep,
  type Condition,
  type GrantStore,
  originAllowed,
  ValetError,
} from '@valet/core'
import type { LoginStepContext } from '@valet/runtime'
import { BrowserRefusal, type LoginStepsOutcome, type SessionBrowser } from './agent-browser'
import type { LoginSecretsRun } from './blocked'
import type { Credentials } from './credentials'
import { authProbe, isBlockedPage } from './login'
import { cleanStallSnapshot, stallUrl } from './login-stall'

/** The longest a login session stays open, however busy. */
export const LOGIN_SESSION_MS = 30 * 60_000
/** The most one batch of steps may take, waits for a one-time code included. */
export const LOGIN_BATCH_MS = 90_000

const ONLY =
  'A login session takes browser_login_steps, browser_navigate, browser_snapshot and browser_session_close only.'

export interface LoginSessionDeps {
  readonly adapterId: string
  readonly manifest: AdapterManifest
  readonly adapterHash: string
  readonly page: AuthPage
  readonly grants: GrantStore
  readonly credentials: Credentials
  readonly audit: AuditSink
  readonly clock: () => Date
  readonly sleep: (ms: number) => Promise<void>
  readonly typingDelayMs: number
  /** Keeps what the session types, for redaction everywhere a login's is redacted. */
  readonly secrets: LoginSecretsRun
  /** True when the text holds a secret any login of this adapter typed. */
  readonly holdsSecret: (text: string) => boolean
  /** Runs `step` as one of the runtime's login steps for the adapter. */
  readonly loginStep: <T>(step: (ctx: LoginStepContext) => Promise<T>) => Promise<T>
  readonly timers?: {
    setTimeout(run: () => void, ms: number): unknown
    clearTimeout(handle: unknown): void
  }
}

/** The origins the manifest's secrets may be typed on: where a login session may act. */
export function loginOrigins(manifest: AdapterManifest): readonly string[] {
  const origins = new Set<string>()
  for (const secret of Object.values(manifest.secrets))
    for (const origin of secret.origins) origins.add(origin)
  return [...origins]
}

export class LoginSession implements SessionBrowser {
  private readonly workbench: LoginWorkbench
  private readonly acts: readonly string[]
  private closed = false
  private readonly listeners: (() => void)[] = []
  private lastYaml: { url: string; yaml: string } | null = null
  private readonly expiry: unknown

  constructor(private readonly deps: LoginSessionDeps) {
    this.acts = loginOrigins(deps.manifest)
    const page = deps.page
    this.workbench = new LoginWorkbench({
      manifest: deps.manifest,
      adapterHash: deps.adapterHash,
      callId: null,
      page,
      grants: deps.grants,
      providers: deps.credentials.providers(),
      otpReader: deps.credentials.otpReader(),
      ...(deps.credentials.mailReader === undefined ? {} : { mailReader: deps.credentials.mailReader() }),
      probe: authProbe(deps.manifest, page),
      isBlockedPage: () => isBlockedPage(page),
      rememberSecret: (copy) => {
        try {
          deps.secrets.register(copy)
        } finally {
          copy.dispose()
        }
      },
      audit: deps.audit,
      clock: deps.clock,
      sleep: deps.sleep,
      typingDelayMs: deps.typingDelayMs,
      beforeAct: async () => {
        if (!this.onLoginOrigin()) throw new ValetError('auth-step', 'navigation-escaped')
      },
    })
    this.expiry = deps.timers?.setTimeout(() => this.close(), LOGIN_SESSION_MS) ?? null
  }

  async loginSteps(steps: readonly AuthStep[]): Promise<{ page: AriaPage; outcome: LoginStepsOutcome }> {
    this.open()
    if (!selectorsAllowed(steps))
      throw new BrowserRefusal(
        'A login session’s selectors can’t test a field’s value or what an element contains (value, :has). Pick the element by its name, type, id or test id.',
      )
    const outcome = await this.batch(steps)
    return { page: await this.ariaSnapshot(), outcome: outcomeView(outcome) }
  }

  async go(url: string): Promise<AriaPage> {
    this.open()
    const outcome = await this.batch([{ op: 'goto', url }])
    if (outcome.status !== 'ok') throw new BrowserRefusal(refusalWords(outcome))
    return this.ariaSnapshot()
  }

  async ariaSnapshot(options: { readonly target?: string; readonly depth?: number } = {}): Promise<AriaPage> {
    this.open()
    if (options.target !== undefined || options.depth !== undefined)
      throw new BrowserRefusal('A login session’s snapshot is the whole page only.')
    const view = await this.deps.page.describe?.()
    if (view === null || view === undefined) throw new BrowserRefusal('The login page could not be read.')
    const url = stallUrl(view.url)
    const { snapshot, cut } = cleanStallSnapshot(view.snapshot, this.deps.holdsSecret)
    const title = view.title.replace(/\s+/g, ' ').trim().slice(0, 200)
    const previous = this.lastYaml !== null && this.lastYaml.url === url ? this.lastYaml.yaml : null
    this.lastYaml = { url, yaml: snapshot }
    return {
      url: this.deps.holdsSecret(url) ? '' : url,
      title: this.deps.holdsSecret(title) ? '' : title,
      yaml: snapshot,
      previous,
      cut,
    }
  }

  url(): string {
    return stallUrl(this.deps.page.currentUrl())
  }

  isClosed(): boolean {
    return this.closed
  }

  onClosed(listener: () => void): void {
    if (this.closed) listener()
    else this.listeners.push(listener)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.expiry !== null) this.deps.timers?.clearTimeout(this.expiry)
    this.workbench.close()
    // Kept beside the adapter's other login sets, as a hand-off's are: what was typed may come back.
    this.deps.secrets.finish('needs-user')
    void this.deps.page.close().catch(() => undefined)
    for (const listener of this.listeners.splice(0)) {
      try {
        listener()
      } catch {
        // One listener failing must not keep the others from hearing.
      }
    }
  }

  // Everything else a session does is refused here.
  takeDownloads(): readonly DownloadNews[] {
    return []
  }
  takeNotices(): readonly string[] {
    return []
  }
  back(): Promise<AriaPage> {
    return refuse()
  }
  resize(): Promise<AriaPage> {
    return refuse()
  }
  find(): Promise<{ readonly url: string; readonly matches: readonly string[] }> {
    return refuse()
  }
  clickElement(): Promise<AriaPage> {
    return refuse()
  }
  hover(): Promise<AriaPage> {
    return refuse()
  }
  drag(): Promise<AriaPage> {
    return refuse()
  }
  fill(): Promise<AriaPage> {
    return refuse()
  }
  check(): Promise<AriaPage> {
    return refuse()
  }
  press(): Promise<AriaPage> {
    return refuse()
  }
  select(): Promise<AriaPage> {
    return refuse()
  }
  waitFor(): Promise<AriaPage & { readonly met: boolean }> {
    return refuse()
  }
  screenshot(): Promise<{ readonly url: string; readonly png: Buffer }> {
    return refuse()
  }
  upload(): Promise<AriaPage> {
    return refuse()
  }
  consoleMessages(): readonly ConsoleMessage[] {
    throw new BrowserRefusal(ONLY)
  }
  evaluate(): Promise<{ readonly result: string; readonly cut: boolean }> {
    return refuse()
  }
  cookies(): Promise<readonly CookieRecord[]> {
    return refuse()
  }
  storage(): Promise<{
    readonly origin: string
    readonly local: readonly { readonly key: string; readonly value: string }[]
    readonly session: readonly { readonly key: string; readonly value: string }[]
  }> {
    return refuse()
  }
  entries(): readonly LogEntry[] {
    throw new BrowserRefusal(ONLY)
  }
  body(): Promise<{ readonly entry: LogEntry; readonly text: string } | null> {
    return refuse()
  }

  private open(): void {
    if (this.closed) throw new BrowserRefusal('This login session has closed.')
  }

  private onLoginOrigin(): boolean {
    try {
      return originAllowed(new URL(this.deps.page.currentUrl()).origin, this.acts)
    } catch {
      return false
    }
  }

  private async batch(steps: readonly AuthStep[]): Promise<WorkbenchOutcome> {
    try {
      return await this.deps.loginStep(async (ctx) => {
        const outcome = await this.workbench.run({
          steps,
          timeoutMs: LOGIN_BATCH_MS,
          signal: ctx.signal,
          paceNavigation: () => ctx.pace(),
        })
        if (outcome.status === 'blocked') ctx.reportBlocked(outcome.errorClass)
        return outcome
      })
    } catch (error) {
      if (error instanceof ValetError) {
        if (error.errorClass === 'rate-limited' || error.errorClass === 'blocked-by-site')
          throw new BrowserRefusal('The site refused Valet recently, so it is cooling down. Try again later.')
        throw new BrowserRefusal(`The steps didn’t start (${error.stage}: ${error.errorClass}).`)
      }
      throw new BrowserRefusal('The steps didn’t start.')
    }
  }
}

/**
 * Selectors that could read back what was typed: an attribute test on `value` (a React field
 * mirrors its value into the attribute, so `input[value^="a"]` would spell out a password one
 * guess at a time), and :has(), which can carry such a test inside. A manifest the person approved
 * may use them; an agent's unreviewed steps may not.
 */
const PROBING_SELECTOR = /value|:has\(/i

function selectorsAllowed(steps: readonly AuthStep[]): boolean {
  const condition = (c: Condition): boolean => {
    if ('visible' in c) return !PROBING_SELECTOR.test(c.visible)
    if ('not' in c) return condition(c.not)
    if ('any' in c) return c.any.every(condition)
    if ('all' in c) return c.all.every(condition)
    return true
  }
  return steps.every((step) => {
    switch (step.op) {
      case 'click':
      case 'fill':
      case 'otp':
        return !PROBING_SELECTOR.test(step.selector)
      case 'waitFor':
        return condition(step.condition)
      case 'when':
        return (
          condition(step.condition) && selectorsAllowed(step.steps) && selectorsAllowed(step.otherwise ?? [])
        )
      case 'retry':
        return selectorsAllowed(step.steps)
      default:
        return true
    }
  })
}

function refuse<T>(): Promise<T> {
  return Promise.reject(new BrowserRefusal(ONLY))
}

function outcomeView(outcome: WorkbenchOutcome): LoginStepsOutcome {
  switch (outcome.status) {
    case 'ok':
      return { status: 'ok', reason: null, stage: null, errorClass: null }
    case 'needsUser':
      return { status: 'needsUser', reason: outcome.reason, stage: null, errorClass: null }
    case 'failed':
    case 'blocked':
      return { status: outcome.status, reason: null, stage: outcome.stage, errorClass: outcome.errorClass }
  }
}

function refusalWords(outcome: Exclude<WorkbenchOutcome, { status: 'ok' }>): string {
  if (outcome.status === 'needsUser') return `The page needs the person (${outcome.reason}).`
  return `That didn’t work (${outcome.stage}: ${outcome.errorClass}).`
}
