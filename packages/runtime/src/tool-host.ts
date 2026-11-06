// The tool host: the one entry point for running an adapter's tool. It owns the order of checks,
// and the order is the security argument:
//
//   1. the call id is well formed and the adapter's exact bundle hash is approved;
//   2. the input matches the tool's schema;
//   3. the adapter's lock is held, so one session never runs two tools at once, and the hash is
//      still approved once we hold it;
//   4. the site's circuit breaker is closed;
//   5. an irreversible tool has the person's confirmation, before its run() starts;
//   6. the tool runs with a guarded capability object, a timeout and an abort signal;
//   7. the output matches the tool's schema, is converted to plain JSON, and is redacted on the
//      way out.
//
// Schemas are adapter code too: a zod refine or transform runs whatever the adapter wrote. So input
// parsing runs before the confirmation (the person is shown the parsed input) with nothing but the
// raw input to work on, and both parses run under their own deadline, as does the confirmation
// prompt, so nothing an adapter supplies can hold the lock indefinitely.
//
// After a call ends, its lock is held until the runtime work it started (page operations,
// ensure(), prompts) settles, up to a bound, so a timed-out call can't keep driving the session
// under the next one.
//
// Every call that reaches an adapter is audited as tool-called and tool-finished. Nothing that
// leaves here carries page text or exception messages: failures are a stage and an error class.

import {
  type AdapterDefinition,
  type AuditEvent,
  type AuditSink,
  defineAdapter,
  type EnsureResult,
  ERROR_CLASSES,
  type ErrorClass,
  manifestSchema,
  type SessionDriver,
  SiteAdapterError,
  STAGES,
  type Stage,
  type ToolContext,
  type ToolDeclaration,
  type ToolImplementation,
  type ToolPage,
  toReportable,
} from '@siteadapter/core'
import type { z } from 'zod'
import type { ApprovalLookup } from './approvals'
import { CallState } from './call-state'
import { type Clock, type Sleep, systemClock, systemSleep } from './clock'
import { GuardedToolPage } from './guarded-page'
import type { LoginMarkerStore } from './login-marker'
import { KeyedMutex } from './mutex'
import { redactOutput, SecretRedactionSet } from './redaction'
import { type LoginBackoff, SessionGate } from './session'
import {
  DEFAULT_SITE_PROTECTION,
  type SiteGuards,
  SiteProtection,
  type SiteProtectionOptions,
} from './site-protection'
import type {
  AuthRunner,
  ConfirmationAnswer,
  ConfirmationPrompt,
  ConfirmationRequest,
  ListedTool,
  RuntimeDiagnostic,
  ToolCallRequest,
  ToolCallResult,
} from './types'

export const DEFAULT_TOOL_TIMEOUT_MS = 120_000
/** For each schema parse. Parsing is local work; anything this slow is a refinement misbehaving. */
export const DEFAULT_VALIDATION_TIMEOUT_MS = 10_000
/** For the person to answer a confirmation. */
export const DEFAULT_CONFIRMATION_TIMEOUT_MS = 5 * 60_000
/** How long a finished call's leftover runtime work may hold the adapter's lock. */
export const DEFAULT_SETTLE_TIMEOUT_MS = 30_000
const MAX_CONFIRM_MESSAGE = 500
const MAX_CLIENT = 100
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/
const CALL_ID = /^[A-Za-z0-9_-]{1,64}$/
const HASH = /^[0-9a-f]{64}$/

export interface RegisteredAdapter {
  readonly definition: AdapterDefinition
  /** The bundle's content hash, as computed by bundleHash() when it was loaded. */
  readonly bundleHash: string
  readonly driver: SessionDriver
}

export interface ToolHostOptions {
  readonly approvals: ApprovalLookup
  readonly audit: AuditSink
  readonly prompt: ConfirmationPrompt
  readonly authRunner: AuthRunner
  readonly markers: LoginMarkerStore
  /** Shared with the auth flow, which remembers each secret it resolves. */
  readonly secrets?: SecretRedactionSet
  readonly clock?: Clock
  readonly sleep?: Sleep
  readonly timeoutMs?: number
  readonly validationTimeoutMs?: number
  readonly confirmationTimeoutMs?: number
  readonly settleTimeoutMs?: number
  readonly loginBackoff?: LoginBackoff
  readonly siteProtection?: SiteProtectionOptions
  readonly diagnostics?: (diagnostic: RuntimeDiagnostic) => void
}

interface Entry extends RegisteredAdapter {
  readonly gate: SessionGate
  readonly site: SiteGuards
}

type Raced<T> =
  | { readonly kind: 'returned'; readonly value: T }
  | { readonly kind: 'threw'; readonly error: unknown }
  | { readonly kind: 'timed-out' }

export class ToolHost {
  private readonly adapters = new Map<string, Entry>()
  private readonly locks = new KeyedMutex()
  private readonly protection: SiteProtection
  private readonly secrets: SecretRedactionSet
  private readonly clock: Clock
  private readonly sleep: Sleep
  private readonly timeoutMs: number
  private readonly validationTimeoutMs: number
  private readonly confirmationTimeoutMs: number
  private readonly settleTimeoutMs: number
  private readonly diagnostics: (diagnostic: RuntimeDiagnostic) => void

  constructor(private readonly options: ToolHostOptions) {
    this.clock = options.clock ?? systemClock
    this.sleep = options.sleep ?? systemSleep
    this.secrets = options.secrets ?? new SecretRedactionSet()
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS
    this.validationTimeoutMs = options.validationTimeoutMs ?? DEFAULT_VALIDATION_TIMEOUT_MS
    this.confirmationTimeoutMs = options.confirmationTimeoutMs ?? DEFAULT_CONFIRMATION_TIMEOUT_MS
    this.settleTimeoutMs = options.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS
    this.diagnostics = options.diagnostics ?? (() => {})
    this.protection = new SiteProtection(
      this.clock,
      this.sleep,
      options.siteProtection ?? DEFAULT_SITE_PROTECTION,
    )
  }

  /** Adds an adapter. Registration is not approval: its tools stay hidden until its hash is approved. */
  register(adapter: RegisteredAdapter): void {
    const { definition, bundleHash, driver } = adapter
    const manifest = definition.manifest
    if (this.adapters.has(manifest.id)) throw new Error(`adapter ${manifest.id} is already registered`)
    if (!HASH.test(bundleHash)) throw new Error('bundleHash must be a sha256 hex digest')
    // Re-validate in case the manifest was built by hand rather than with parseManifest.
    manifestSchema.parse(manifest)
    defineAdapter(definition)
    const site = this.protection.forSite(new URL(manifest.home).hostname)
    const gate = new SessionGate({
      adapterId: manifest.id,
      adapterHash: bundleHash,
      manifest,
      driver,
      authRunner: this.options.authRunner,
      markers: this.options.markers,
      site,
      secrets: this.secrets,
      clock: this.clock,
      ...(this.options.loginBackoff === undefined ? {} : { backoff: this.options.loginBackoff }),
      audit: (event) => this.record(event),
      diagnostics: this.diagnostics,
    })
    this.adapters.set(manifest.id, { definition, bundleHash, driver, gate, site })
  }

  /** The tools of every adapter whose registered hash is approved. */
  async listTools(): Promise<ListedTool[]> {
    const listed: ListedTool[] = []
    for (const entry of this.adapters.values()) {
      const manifest = entry.definition.manifest
      if (!(await this.isApproved(entry))) continue
      for (const declaration of manifest.tools) {
        const implementation = implementationOf(entry, declaration.name)
        if (implementation === undefined) continue
        listed.push({
          adapterId: manifest.id,
          adapterName: manifest.name,
          adapterHash: entry.bundleHash,
          declaration,
          input: implementation.input,
          output: implementation.output,
        })
      }
    }
    return listed
  }

  async call(request: ToolCallRequest): Promise<ToolCallResult> {
    // The id goes into audit events and the login marker, so it must be short and plain.
    if (typeof request.callId !== 'string' || !CALL_ID.test(request.callId))
      return failed('tool-input', 'invalid')
    const entry = this.adapters.get(request.adapterId)
    // An unknown adapter answers like an unapproved one, so callers can't enumerate registrations.
    if (entry === undefined) return failed('manifest', 'not-granted')
    const client = normaliseClient(request.client)
    const started = this.clock.now()
    try {
      await this.options.audit.append({
        type: 'tool-called',
        adapterId: entry.definition.manifest.id,
        adapterHash: entry.bundleHash,
        tool: TOOL_NAME.test(request.tool) ? request.tool : '(invalid)',
        client,
        callId: request.callId,
      })
    } catch {
      // A call we can't record doesn't run.
      return failed('tool-run', 'internal')
    }
    let result: ToolCallResult
    try {
      result = await this.execute(entry, request, client)
    } catch (error) {
      result = fromError(error, entry.site)
    }
    await this.record(finishedEvent(request.callId, result, this.clock.now() - started))
    return result
  }

  private async execute(entry: Entry, request: ToolCallRequest, client: string): Promise<ToolCallResult> {
    if (!(await this.isApproved(entry))) return failed('manifest', 'not-granted')
    const declaration = entry.definition.manifest.tools.find((t) => t.name === request.tool)
    const implementation = implementationOf(entry, request.tool)
    if (declaration === undefined || implementation === undefined) return failed('manifest', 'not-found')
    const input = await this.validate(implementation.input, request.input, 'tool-input')
    if (input.status !== 'ok') return input

    const release = await this.locks.acquire(entry.definition.manifest.id)
    const controller = new AbortController()
    const state = new CallState(request.callId, controller.signal, this.secrets)
    try {
      // Again, because a revocation can land while this call waits for the lock.
      if (!(await this.isApproved(entry))) return failed('manifest', 'not-granted')
      if (entry.site.breaker.isOpen()) return blocked(entry.site)
      if (declaration.sideEffect === 'irreversible') {
        const answer = await this.ask(entry, declaration, request.callId, client, {
          kind: 'irreversible-tool',
          message: declaration.description,
          input: input.output,
        })
        if (answer !== 'approved') return { status: 'declined' }
      }
      return await this.run(
        entry,
        declaration,
        implementation,
        request,
        client,
        input.output,
        state,
        controller,
      )
    } finally {
      // Capabilities die with the call, so promises tool code left running can't act afterwards.
      controller.abort()
      if (state.idle) release()
      else void this.afterSettling(state).finally(release)
    }
  }

  private async run(
    entry: Entry,
    declaration: ToolDeclaration,
    implementation: ToolImplementation,
    request: ToolCallRequest,
    client: string,
    input: unknown,
    state: CallState,
    controller: AbortController,
  ): Promise<ToolCallResult> {
    const manifest = entry.definition.manifest
    let inner: ToolPage
    try {
      inner = await entry.driver.toolPage()
    } catch (error) {
      return fromReportable(toReportable(error, 'navigate'))
    }
    await this.collectCookies(entry, state)

    const ctx: ToolContext = {
      page: new GuardedToolPage({
        adapterId: manifest.id,
        manifest,
        sideEffect: declaration.sideEffect,
        inner,
        site: entry.site,
        state,
        audit: (event) => this.record(event),
      }),
      session: { ensure: () => this.ensure(entry, state, inner) },
      confirm: async (message) => {
        state.assertLive()
        const asking = this.ask(
          entry,
          declaration,
          request.callId,
          client,
          { kind: 'tool-request', message: String(message).slice(0, MAX_CONFIRM_MESSAGE) },
          controller.signal,
        )
        return (await state.track(asking)) === 'approved'
      },
      signal: controller.signal,
    }

    const outcome = await this.race(() => implementation.run(ctx, input), this.timeoutMs)
    // Capabilities die with the call, so promises tool code left running can't act afterwards.
    controller.abort()

    if (outcome.kind === 'timed-out') return failed('timeout', 'timed-out')
    if (state.blocked) return blocked(entry.site)
    if (state.violation !== null) return failed(state.violation.stage, state.violation.errorClass)
    if (outcome.kind === 'threw') {
      const ensureOutcome = state.ensureOutcome
      if (ensureOutcome?.status === 'needsUser') return { status: 'needsUser', reason: ensureOutcome.reason }
      if (ensureOutcome?.status === 'failed') {
        return fromEnsureFailure(ensureOutcome)
      }
      return fromError(outcome.error, entry.site)
    }

    const output = await this.validate(implementation.output, outcome.value, 'tool-output')
    if (output.status !== 'ok') return output
    try {
      await this.collectCookies(entry, state)
    } catch {
      // Without the current cookie values we can't redact, so the output doesn't leave.
      return failed('tool-output', 'internal')
    }
    try {
      return { status: 'ok', output: redactOutput(output.output, state.sensitive()) }
    } catch (error) {
      return fromReportable(toReportable(error, 'tool-output'))
    }
  }

  /** Parses with an adapter-supplied schema, which may run adapter code, under a deadline. */
  private async validate(
    schema: z.ZodType,
    value: unknown,
    stage: 'tool-input' | 'tool-output',
  ): Promise<{ readonly status: 'ok'; readonly output: unknown } | ToolCallResult> {
    const parsed = await this.race(() => schema.safeParseAsync(value), this.validationTimeoutMs)
    if (parsed.kind === 'timed-out') return failed(stage, 'timed-out')
    if (parsed.kind === 'threw' || !parsed.value.success) return failed(stage, 'invalid')
    return { status: 'ok', output: parsed.value.data }
  }

  private async ensure(entry: Entry, state: CallState, page: ToolPage): Promise<EnsureResult> {
    state.assertLive()
    try {
      const result = await state.track(
        entry.gate.ensure({ callId: state.callId, signal: state.signal, page, login: state.login }),
      )
      state.ensureOutcome = result.status === 'ok' ? null : result
      await this.collectCookies(entry, state)
      return result
    } catch (error) {
      if (error instanceof SiteAdapterError && error.errorClass === 'blocked-by-site') state.blocked = true
      throw error
    }
  }

  /** Waits, up to the settle bound, for the runtime work a finished call started. */
  private async afterSettling(state: CallState): Promise<void> {
    await this.race(() => state.settled(), this.settleTimeoutMs)
  }

  /**
   * Asks the person, under the confirmation deadline. The prompt's signal aborts when the deadline
   * passes or when `callSignal` (the running tool's) does.
   */
  private async ask(
    entry: Entry,
    declaration: ToolDeclaration,
    callId: string,
    client: string,
    question: Pick<ConfirmationRequest, 'kind' | 'message' | 'input'>,
    callSignal?: AbortSignal,
  ): Promise<ConfirmationAnswer> {
    const manifest = entry.definition.manifest
    const deadline = new AbortController()
    const signal = callSignal === undefined ? deadline.signal : AbortSignal.any([deadline.signal, callSignal])
    const asked = await this.race(
      () =>
        this.options.prompt.ask(
          {
            adapterId: manifest.id,
            adapterName: manifest.name,
            tool: declaration.name,
            toolTitle: declaration.title,
            callId,
            client,
            ...question,
          },
          signal,
        ),
      this.confirmationTimeoutMs,
    )
    deadline.abort()
    let answer: ConfirmationAnswer =
      asked.kind === 'returned' ? asked.value : asked.kind === 'timed-out' ? 'timed-out' : 'declined'
    // Anything but an explicit yes is a no.
    if (answer !== 'approved' && answer !== 'timed-out') answer = 'declined'
    // An approval we can't record doesn't count: this throws, and the call fails.
    await this.options.audit.append({
      type: 'confirmation',
      adapterId: manifest.id,
      tool: declaration.name,
      callId,
      answer,
    })
    return answer
  }

  /**
   * Runs `task` against a deadline kept with the injected sleep. The task itself can't be stopped
   * (callers abort their own signals), only stopped being waited for.
   */
  private async race<T>(task: () => Promise<T>, ms: number): Promise<Raced<T>> {
    const timer = new AbortController()
    const running: Promise<Raced<T>> = Promise.resolve()
      .then(task)
      .then(
        (value) => ({ kind: 'returned', value }),
        (error: unknown) => ({ kind: 'threw', error }),
      )
    const timeout: Promise<Raced<T>> = this.sleep(ms, timer.signal).then(
      () => ({ kind: 'timed-out' }),
      () => running,
    )
    const outcome = await Promise.race([running, timeout])
    timer.abort()
    return outcome
  }

  private async collectCookies(entry: Entry, state: CallState): Promise<void> {
    const values = await entry.driver.sessionCookieValues(entry.definition.manifest.session.cookieDomains)
    for (const value of values) state.cookieValues.add(value)
  }

  private isApproved(entry: Entry): Promise<boolean> {
    return this.options.approvals
      .isApproved(entry.definition.manifest.id, entry.bundleHash)
      .catch(() => false)
  }

  private async record(event: AuditEvent): Promise<void> {
    try {
      await this.options.audit.append(event)
    } catch {
      this.diagnostics({ type: 'audit-write-failed', event: event.type })
    }
  }
}

function implementationOf(entry: RegisteredAdapter, name: string): ToolImplementation | undefined {
  // hasOwn, so a tool named "constructor" or "__proto__" can't reach Object.prototype.
  return Object.hasOwn(entry.definition.tools, name) ? entry.definition.tools[name] : undefined
}

/** One string for both the audit log and the prompt: printable, and at most MAX_CLIENT long. */
function normaliseClient(client: unknown): string {
  const printable = typeof client === 'string' ? client.replace(/[\p{Cc}\p{Cf}]/gu, '').trim() : ''
  return printable.length === 0 ? '(unknown)' : printable.slice(0, MAX_CLIENT)
}

function failed(stage: Stage, errorClass: ErrorClass): ToolCallResult {
  return { status: 'failed', stage, errorClass }
}

function blocked(site: SiteGuards): ToolCallResult {
  return { status: 'blocked', retryAfterMs: site.breaker.retryAfterMs() }
}

function fromReportable(reportable: { stage: Stage; errorClass: ErrorClass }): ToolCallResult {
  return failed(reportable.stage, reportable.errorClass)
}

// EnsureResult carries plain strings; only known vocabulary leaves the runtime.
function fromEnsureFailure(outcome: { readonly stage: string; readonly errorClass: string }): ToolCallResult {
  const stage = STAGES.find((s) => s === outcome.stage) ?? 'tool-run'
  const errorClass = ERROR_CLASSES.find((c) => c === outcome.errorClass) ?? 'internal'
  return failed(stage, errorClass)
}

function fromError(error: unknown, site: SiteGuards): ToolCallResult {
  const reportable = toReportable(error, 'tool-run')
  if (reportable.errorClass === 'blocked-by-site') return blocked(site)
  return fromReportable(reportable)
}

function finishedEvent(callId: string, result: ToolCallResult, durationMs: number): AuditEvent {
  const base = { type: 'tool-finished', callId, durationMs } as const
  switch (result.status) {
    case 'ok':
      return { ...base, outcome: 'ok' }
    case 'needsUser':
      return { ...base, outcome: 'needsUser' }
    case 'failed':
      return { ...base, outcome: 'failed', stage: result.stage, errorClass: result.errorClass }
    case 'blocked':
      return { ...base, outcome: 'failed', stage: 'tool-run', errorClass: 'blocked-by-site' }
    case 'declined':
      return { ...base, outcome: 'failed', stage: 'confirm', errorClass: 'declined' }
  }
}
