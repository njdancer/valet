// A stand-in for the runtime around the adapter, just big enough for its manifest: an interpreter
// for the auth steps this manifest uses (no waitFor or retry), the secret-fill guards from
// docs/security-model.md, session.ensure() with the probe and the cookie hand-off, and tool runs
// held to the manifest's request surface. packages/auth-flow and packages/runtime are the real ones;
// this exists so the adapter can be proven against the fake without them or Electron.

import {
  type AdapterDefinition,
  type AuthPage,
  type AuthStep,
  type Condition,
  type EnsureResult,
  MESSAGES_SECRET,
  type MessagesOtpQuery,
  type NeedsUserReason,
  originAllowed,
  type SecretField,
  type SecretValue,
  SiteAdapterError,
  type ToolContext,
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
}

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
      const output = await implementation.run(ctx, implementation.input.parse(input))
      return implementation.output.parse(output)
    } finally {
      this.deps.driver.endRun()
    }
  }

  async ensure(): Promise<EnsureResult> {
    await this.deps.driver.toolPage()
    try {
      if (await this.probe(this.deps.driver.toolCookies(this.manifest.home))) return { status: 'ok' }
    } catch (error) {
      const { stage, errorClass } = toReportable(error, 'probe')
      return { status: 'failed', stage, errorClass }
    }
    const page = await this.deps.driver.openAuthPage()
    try {
      await this.runSteps(page, this.manifest.auth.steps)
    } catch (error) {
      if (error instanceof Halt) {
        this.logins.push(`needsUser:${error.reason}`)
        if (error.note !== undefined) this.notes.push(error.note)
        await page.handToUser(error.reason)
        return { status: 'needsUser', reason: error.reason }
      }
      const { stage, errorClass } = toReportable(error, 'auth-step')
      this.logins.push(`failed:${stage}/${errorClass}`)
      return { status: 'failed', stage, errorClass }
    } finally {
      await page.close()
    }
    await this.deps.driver.handoff(this.manifest.session.cookieDomains, this.manifest.session.storage)
    this.logins.push('ok')
    return { status: 'ok' }
  }

  /** The manifest's fetch probe, made by the runtime itself (outside the tool surface) with `cookie`. */
  private async probe(cookie: string): Promise<boolean> {
    const probe = this.manifest.session.probe
    if (probe.kind !== 'fetch') throw new Error('the harness only runs fetch probes')
    const headers: Record<string, string> = { accept: 'application/json' }
    if (cookie !== '') Object.assign(headers, { cookie })
    const response = await this.deps.network.send(
      'GET',
      new URL(probe.path, this.manifest.home).href,
      headers,
    )
    if (probe.loggedOutStatuses.includes(response.status)) return false
    if (response.status !== probe.expectStatus) throw new SiteAdapterError('probe', 'unexpected-shape')
    let value: unknown = JSON.parse(response.body)
    for (const key of (probe.jsonPath ?? '').split('.').filter((part) => part !== '')) {
      value =
        value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined
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
      case 'assertLoggedIn': {
        const www = new URL(this.manifest.home).href
        if (!(await this.probe(this.deps.driver.authJar.header(www)))) {
          throw new SiteAdapterError('probe', 'not-logged-in')
        }
        return
      }
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
    const value = await this.deps.resolve(grant.itemRef, field)
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
    const notBefore = new Date(Date.now() - query.maxAgeSeconds * 1000)
    const value = await this.deps.otpReader.latest(query, notBefore)
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
