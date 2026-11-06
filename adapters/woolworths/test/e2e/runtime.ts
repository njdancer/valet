// A stand-in for the runtime around the adapter, just big enough for its manifest: an interpreter
// for the auth steps this manifest uses (no waitFor or retry), the secret-fill guards from
// docs/security-model.md, session.ensure() as packages/runtime runs it (probe in the tool page
// under the run's policy, login, hand-off, probe again), tool runs held to the manifest's request
// surface, and output redaction. packages/auth-flow and packages/runtime are the real ones; this
// exists so the adapter can be proven against the fake without them or Electron.

import {
  type AdapterDefinition,
  type AuthPage,
  type AuthStep,
  type Condition,
  CredentialError,
  type EnsureResult,
  ERROR_CLASSES,
  type ErrorClass,
  MESSAGES_SECRET,
  type MessagesOtpQuery,
  type NeedsUserReason,
  originAllowed,
  type SecretField,
  SecretValue,
  SiteAdapterError,
  type Stage,
  type ToolContext,
  type ToolPage,
  toReportable,
} from '@siteadapter/core'
import type { HarnessDriver } from './browser'
import type { Network } from './network'

/** What the person granted, as the runtime's grant store would hold it. */
export interface HarnessGrant {
  readonly secret: string
  /** For the `messages` grant: the approved sender. */
  readonly itemRef: string
  readonly origins: readonly string[]
}

export interface HarnessDeps {
  readonly network: Network
  readonly driver: HarnessDriver
  readonly grants: readonly HarnessGrant[]
  /** The credential provider: a fresh SecretValue per call, which the filler disposes. */
  readonly resolve: (itemRef: string, field: SecretField) => Promise<SecretValue>
  readonly otpReader: { latest(query: MessagesOtpQuery, notBefore: Date): Promise<SecretValue> }
  /** The clock for the flow's start, which Messages codes must not predate. Defaults to now. */
  readonly now?: () => Date
}

/** Cookie values shorter than this are flags, not credentials, as packages/runtime has it. */
const MIN_REDACTED_LENGTH = 8
export const REDACTED = '[redacted]'

class Halt {
  constructor(
    readonly reason: NeedsUserReason,
    readonly note: string | undefined,
  ) {}
}

export class HarnessRuntime {
  /** "needsUser:<reason>" or "failed:<stage>/<class>" or "ok", one per login the runtime ran. */
  readonly logins: string[] = []
  /** Notes from needsUser steps: shown in the app, never returned to tool code. */
  readonly notes: string[] = []
  /** "<secret>.<field>@<origin>" for each secret typed. */
  readonly secretsUsed: string[] = []
  /** When the current auth flow started. */
  private flowStartedAt = new Date(0)

  constructor(
    readonly adapter: AdapterDefinition,
    private readonly deps: HarnessDeps,
  ) {}

  private get manifest() {
    return this.adapter.manifest
  }

  /** Runs one tool as the runtime would: the run's network policy, ensure(), and no confirm. */
  async call(name: string, input: unknown, signal = new AbortController().signal): Promise<unknown> {
    const declaration = this.manifest.tools.find((tool) => tool.name === name)
    const implementation = this.adapter.tools[name]
    if (declaration === undefined || implementation === undefined) throw new Error(`no tool ${name}`)
    this.deps.driver.beginRun(
      {
        egress: this.manifest.egress,
        requests: this.manifest.requests,
        maxPurpose: declaration.sideEffect,
        ceiling: this.manifest.limits.requestsPerRun,
      },
      // The driver keeps its own list of refused requests for the tests.
      () => {},
    )
    try {
      const ctx: ToolContext = {
        page: await this.deps.driver.toolPage(),
        session: { ensure: () => this.ensure() },
        confirm: async () => false,
        signal,
      }
      const output = implementation.output.parse(
        await implementation.run(ctx, implementation.input.parse(input)),
      )
      const { cookieDomains, storage } = this.manifest.session
      return redact(output, await this.deps.driver.sessionSecrets(cookieDomains, storage))
    } finally {
      this.deps.driver.endRun()
    }
  }

  /** As packages/runtime's session does: probe, log in, hand off, probe again. */
  async ensure(): Promise<EnsureResult> {
    const page = await this.deps.driver.runtimePage()
    try {
      if (await this.probe(page)) return { status: 'ok' }
    } catch (error) {
      const { stage, errorClass } = toReportable(error, 'probe')
      return { status: 'failed', stage, errorClass }
    }
    const authPage = await this.deps.driver.openAuthPage()
    try {
      this.flowStartedAt = (this.deps.now ?? (() => new Date()))()
      await this.runSteps(authPage, this.manifest.auth.steps)
    } catch (error) {
      if (error instanceof Halt) {
        this.logins.push(`needsUser:${error.reason}`)
        if (error.note !== undefined) this.notes.push(error.note)
        await authPage.handToUser(error.reason)
        return { status: 'needsUser', reason: error.reason }
      }
      return this.failed(error, 'auth-step')
    } finally {
      await authPage.close()
    }
    await this.deps.driver.handoff(this.manifest.session.cookieDomains, this.manifest.session.storage)
    try {
      if (!(await this.probe(page)))
        return this.failed(new SiteAdapterError('probe', 'not-logged-in'), 'probe')
    } catch (error) {
      return this.failed(error, 'probe')
    }
    this.logins.push('ok')
    return { status: 'ok' }
  }

  private failed(error: unknown, fallback: Stage): EnsureResult {
    const { stage, errorClass } = toReportable(error, fallback)
    this.logins.push(`failed:${stage}/${errorClass}`)
    return { status: 'failed', stage, errorClass }
  }

  /** The manifest's fetch probe, made through the tool page (the runtime's handle on it). */
  private async probe(page: ToolPage): Promise<boolean> {
    const probe = this.fetchProbe()
    const result = await page.fetch(new URL(probe.path, this.manifest.home).href, {
      method: 'GET',
      headers: { accept: 'application/json' },
    })
    return this.answer(result.status, result.body)
  }

  /** assertLoggedIn's probe, which auth-flow makes from the auth partition, outside any tool run. */
  private async authProbe(): Promise<boolean> {
    const probe = this.fetchProbe()
    const url = new URL(probe.path, this.manifest.home).href
    const cookie = this.deps.driver.authJar.header(url)
    const headers: Record<string, string> = { accept: 'application/json' }
    if (cookie !== '') Object.assign(headers, { cookie })
    const response = await this.deps.network.send('GET', url, headers)
    let body: unknown = response.body
    try {
      body = JSON.parse(response.body)
    } catch {
      // Left as text, which answer() treats as no value.
    }
    return this.answer(response.status, body)
  }

  private fetchProbe() {
    const probe = this.manifest.session.probe
    if (probe.kind !== 'fetch') throw new Error('the harness only runs fetch probes')
    return probe
  }

  /** As packages/runtime reads a probe: logged-out statuses, the expected status, the JSON path. */
  private answer(status: number, body: unknown): boolean {
    const probe = this.fetchProbe()
    if (probe.loggedOutStatuses.includes(status)) return false
    if (status !== probe.expectStatus) throw new SiteAdapterError('probe', 'unavailable')
    let value: unknown = body
    for (const key of (probe.jsonPath ?? '').split('.').filter((part) => part !== '')) {
      value =
        value !== null && typeof value === 'object' && Object.hasOwn(value, key)
          ? (value as Record<string, unknown>)[key]
          : undefined
    }
    return probe.equals === undefined ? Boolean(value) : value === probe.equals
  }

  private async runSteps(page: AuthPage, steps: readonly AuthStep[]): Promise<void> {
    for (const step of steps) await this.runStep(page, step)
  }

  private async runStep(page: AuthPage, step: AuthStep): Promise<void> {
    switch (step.op) {
      case 'goto':
        if (!originAllowed(new URL(step.url).origin, this.manifest.navigation)) {
          throw new SiteAdapterError('navigate', 'navigation-escaped')
        }
        await page.goto(step.url)
        return
      case 'click':
        await this.requireVisible(page, step.selector)
        await page.click(step.selector)
        return
      case 'fill':
        if ('literal' in step.value) throw new Error('the harness does not model literal fills')
        await this.fillSecret(page, step.selector, step.value.secret, step.value.field)
        return
      case 'otp':
        if ('secret' in step.source) await this.fillSecret(page, step.selector, step.source.secret, 'otp')
        else await this.fillMessagesCode(page, step.selector, step.source.messages)
        return
      case 'pause':
        // Pages here change only on a request, which completes before the step that made it.
        return
      case 'when':
        await this.runSteps(
          page,
          (await this.holds(page, step.condition)) ? step.steps : (step.otherwise ?? []),
        )
        return
      case 'assertLoggedIn':
        if (!(await this.authProbe())) throw new SiteAdapterError('probe', 'not-logged-in')
        return
      case 'needsUser':
        throw new Halt(step.reason, step.note)
      case 'fail':
        throw new SiteAdapterError('auth-step', step.errorClass)
      default:
        throw new Error(`the harness does not model ${step.op}`)
    }
  }

  private async holds(page: AuthPage, condition: Condition): Promise<boolean> {
    if ('visible' in condition) return (await page.inspect(condition.visible))?.visible === true
    const url = new URL(page.currentUrl())
    const target = `${url.pathname}${url.search}`
    if ('urlContains' in condition) return target.includes(condition.urlContains)
    if ('urlRegex' in condition) return new RegExp(condition.urlRegex).test(target)
    if ('textPresent' in condition) return page.textPresent(condition.textPresent)
    if ('not' in condition) return !(await this.holds(page, condition.not))
    if ('any' in condition) {
      for (const inner of condition.any) if (await this.holds(page, inner)) return true
      return false
    }
    for (const inner of condition.all) if (!(await this.holds(page, inner))) return false
    return true
  }

  private async requireVisible(page: AuthPage, selector: string): Promise<void> {
    if ((await page.inspect(selector))?.visible !== true)
      throw new SiteAdapterError('auth-step', 'element-missing')
  }

  /** The guards from docs/security-model.md, then a paced, origin-checked fill. */
  private async fillSecret(
    page: AuthPage,
    selector: string,
    secret: string,
    field: SecretField,
  ): Promise<void> {
    const request = Object.hasOwn(this.manifest.secrets, secret) ? this.manifest.secrets[secret] : undefined
    const grant = this.deps.grants.find((g) => g.secret === secret)
    if (request === undefined || grant === undefined) throw new SiteAdapterError('grant', 'not-granted')
    const origins = grant.origins.filter((origin) => request.origins.includes(origin))
    await this.guard(page, selector, field, origins)
    const value = await resolveSecret(() => this.deps.resolve(grant.itemRef, field), 'credential')
    try {
      await this.type(page, selector, value, origins)
      this.secretsUsed.push(`${secret}.${field}@${new URL(page.currentUrl()).origin}`)
    } finally {
      value.dispose()
    }
  }

  private async fillMessagesCode(
    page: AuthPage,
    selector: string,
    query: { readonly sender: string; readonly pattern: string; readonly maxAgeSeconds: number },
  ): Promise<void> {
    const grant = this.deps.grants.find((g) => g.secret === MESSAGES_SECRET && g.itemRef === query.sender)
    if (grant === undefined) throw new SiteAdapterError('grant', 'not-granted')
    await this.guard(page, selector, 'otp', grant.origins)
    // As auth-flow does: a code that arrived before this flow started is never accepted.
    const value = await resolveSecret(() => this.deps.otpReader.latest(query, this.flowStartedAt), 'otp')
    try {
      await this.type(page, selector, value, grant.origins)
      this.secretsUsed.push(`messages.otp@${new URL(page.currentUrl()).origin}`)
    } finally {
      value.dispose()
    }
  }

  private async guard(
    page: AuthPage,
    selector: string,
    field: SecretField,
    origins: readonly string[],
  ): Promise<void> {
    const info = await page.inspect(selector)
    if (info === null || !info.visible) throw new SiteAdapterError('auth-step', 'element-missing')
    if (!originAllowed(info.frameOrigin, origins))
      throw new SiteAdapterError('secret-fill', 'origin-mismatch')
    if (!info.inputReachable) throw new SiteAdapterError('secret-fill', 'input-unreachable')
    const suits =
      field === 'password'
        ? info.inputType === 'password'
        : field === 'username'
          ? ['email', 'text', 'tel'].includes(info.inputType ?? '')
          : ['text', 'tel', 'number'].includes(info.inputType ?? '')
    if (info.tagName !== 'INPUT' || !suits) throw new SiteAdapterError('secret-fill', 'element-unsuitable')
    if (
      field === 'password' &&
      (info.formActionOrigin === null || !originAllowed(info.formActionOrigin, origins))
    ) {
      throw new SiteAdapterError('secret-fill', 'form-action-mismatch')
    }
  }

  private async type(
    page: AuthPage,
    selector: string,
    value: SecretValue,
    origins: readonly string[],
  ): Promise<void> {
    await page.focus(selector)
    await page.type(value, { delayMs: 0, allowedOrigins: origins })
  }
}

/** A provider's failure as `<stage>: <failure>`, and nothing more, as auth-flow reports it. */
async function resolveSecret(resolve: () => Promise<SecretValue>, stage: Stage): Promise<SecretValue> {
  let value: unknown
  try {
    value = await resolve()
  } catch (error) {
    if (error instanceof CredentialError && (ERROR_CLASSES as readonly string[]).includes(error.failure)) {
      throw new SiteAdapterError(stage, error.failure as ErrorClass)
    }
    throw new SiteAdapterError(stage, 'internal')
  }
  if (!(value instanceof SecretValue)) throw new SiteAdapterError(stage, 'internal')
  return value
}

/** Replaces every string holding a session secret, as packages/runtime's redaction does. */
function redact(output: unknown, secrets: readonly string[]): unknown {
  const needles = secrets.filter((value) => value.length >= MIN_REDACTED_LENGTH)
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return needles.some((needle) => value.includes(needle)) ? REDACTED : value
    if (Array.isArray(value)) return value.map(walk)
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, inner]) => [walk(key), walk(inner)]))
    }
    return value
  }
  return walk(JSON.parse(JSON.stringify(output ?? null)))
}
