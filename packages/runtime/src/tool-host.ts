// The tool host: the one entry point for running an adapter's tool. It owns the order of checks,
// and the order is the security argument:
//
//   1. the adapter's exact bundle hash is approved;
//   2. the input matches the tool's schema;
//   3. the adapter's lock is held, so one session never runs two tools at once;
//   4. the site's circuit breaker is closed;
//   5. an irreversible tool has the person's confirmation, before any of its code runs;
//   6. the tool runs with a guarded capability object, a timeout and an abort signal;
//   7. the output matches the tool's schema and is redacted on the way out.
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
import type { ApprovalLookup } from './approvals'
import { CallState } from './call-state'
import { type Clock, type Sleep, systemClock, systemSleep } from './clock'
import { GuardedToolPage } from './guarded-page'
import type { LoginMarkerStore } from './login-marker'
import { KeyedMutex } from './mutex'
import { redactDeep, SecretRedactionSet } from './redaction'
import { SessionGate } from './session'
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
const MAX_CONFIRM_MESSAGE = 500
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/
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
  readonly siteProtection?: SiteProtectionOptions
  readonly diagnostics?: (diagnostic: RuntimeDiagnostic) => void
}

interface Entry extends RegisteredAdapter {
  readonly gate: SessionGate
  readonly site: SiteGuards
}

type RunOutcome =
  | { readonly kind: 'returned'; readonly value: unknown }
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
  private readonly diagnostics: (diagnostic: RuntimeDiagnostic) => void

  constructor(private readonly options: ToolHostOptions) {
    this.clock = options.clock ?? systemClock
    this.sleep = options.sleep ?? systemSleep
    this.secrets = options.secrets ?? new SecretRedactionSet()
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS
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
    const entry = this.adapters.get(request.adapterId)
    // An unknown adapter answers like an unapproved one, so callers can't enumerate registrations.
    if (entry === undefined) return failed('manifest', 'not-granted')
    const started = this.clock.now()
    try {
      await this.options.audit.append({
        type: 'tool-called',
        adapterId: entry.definition.manifest.id,
        adapterHash: entry.bundleHash,
        tool: TOOL_NAME.test(request.tool) ? request.tool : '(invalid)',
        client: String(request.client).slice(0, 100),
        callId: request.callId,
      })
    } catch {
      // A call we can't record doesn't run.
      return failed('tool-run', 'internal')
    }
    let result: ToolCallResult
    try {
      result = await this.execute(entry, request)
    } catch (error) {
      result = fromError(error, entry.site)
    }
    await this.record(finishedEvent(request.callId, result, this.clock.now() - started))
    return result
  }

  private async execute(entry: Entry, request: ToolCallRequest): Promise<ToolCallResult> {
    if (!(await this.isApproved(entry))) return failed('manifest', 'not-granted')
    const declaration = entry.definition.manifest.tools.find((t) => t.name === request.tool)
    const implementation = implementationOf(entry, request.tool)
    if (declaration === undefined || implementation === undefined) return failed('manifest', 'not-found')
    const input = await implementation.input.safeParseAsync(request.input)
    if (!input.success) return failed('tool-input', 'invalid')

    return this.locks.run(entry.definition.manifest.id, async () => {
      if (entry.site.breaker.isOpen()) return blocked(entry.site)
      if (declaration.sideEffect === 'irreversible') {
        const answer = await this.ask(
          entry,
          declaration,
          request,
          { kind: 'irreversible-tool', message: declaration.description, input: input.data },
          new AbortController().signal,
        )
        if (answer !== 'approved') return { status: 'declined' }
      }
      return this.run(entry, declaration, implementation, request, input.data)
    })
  }

  private async run(
    entry: Entry,
    declaration: ToolDeclaration,
    implementation: ToolImplementation,
    request: ToolCallRequest,
    input: unknown,
  ): Promise<ToolCallResult> {
    const manifest = entry.definition.manifest
    const controller = new AbortController()
    const state = new CallState(request.callId, controller.signal, this.secrets)
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
        const answer = await this.ask(
          entry,
          declaration,
          request,
          { kind: 'tool-request', message: String(message).slice(0, MAX_CONFIRM_MESSAGE) },
          controller.signal,
        )
        return answer === 'approved'
      },
      signal: controller.signal,
    }

    let outcome: RunOutcome
    try {
      outcome = await this.withTimeout(() => implementation.run(ctx, input), controller)
    } finally {
      // Capabilities die with the call, so promises tool code left running can't act afterwards.
      controller.abort()
    }

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

    const output = await implementation.output.safeParseAsync(outcome.value)
    if (!output.success) return failed('tool-output', 'invalid')
    try {
      await this.collectCookies(entry, state)
    } catch {
      // Without the current cookie values we can't redact, so the output doesn't leave.
      return failed('tool-output', 'internal')
    }
    return { status: 'ok', output: redactDeep(output.data, state.sensitive()) }
  }

  private async ensure(entry: Entry, state: CallState, page: ToolPage): Promise<EnsureResult> {
    state.assertLive()
    try {
      const result = await entry.gate.ensure({ callId: state.callId, signal: state.signal, page })
      state.ensureOutcome = result.status === 'ok' ? null : result
      await this.collectCookies(entry, state)
      return result
    } catch (error) {
      if (error instanceof SiteAdapterError && error.errorClass === 'blocked-by-site') state.blocked = true
      throw error
    }
  }

  private async ask(
    entry: Entry,
    declaration: ToolDeclaration,
    request: ToolCallRequest,
    question: Pick<ConfirmationRequest, 'kind' | 'message' | 'input'>,
    signal: AbortSignal,
  ): Promise<ConfirmationAnswer> {
    const manifest = entry.definition.manifest
    let answer: ConfirmationAnswer
    try {
      answer = await this.options.prompt.ask(
        {
          adapterId: manifest.id,
          adapterName: manifest.name,
          tool: declaration.name,
          toolTitle: declaration.title,
          callId: request.callId,
          client: request.client,
          ...question,
        },
        signal,
      )
    } catch {
      answer = 'declined'
    }
    // Anything but an explicit yes is a no.
    if (answer !== 'approved' && answer !== 'timed-out') answer = 'declined'
    // An approval we can't record doesn't count: this throws, and the call fails.
    await this.options.audit.append({
      type: 'confirmation',
      adapterId: manifest.id,
      tool: declaration.name,
      callId: request.callId,
      answer,
    })
    return answer
  }

  private async withTimeout(task: () => Promise<unknown>, controller: AbortController): Promise<RunOutcome> {
    const timer = new AbortController()
    const running: Promise<RunOutcome> = Promise.resolve()
      .then(task)
      .then(
        (value) => ({ kind: 'returned', value }),
        (error: unknown) => ({ kind: 'threw', error }),
      )
    const timeout: Promise<RunOutcome> = this.sleep(this.timeoutMs, timer.signal).then(
      () => ({ kind: 'timed-out' }),
      () => running,
    )
    const outcome = await Promise.race([running, timeout])
    timer.abort()
    if (outcome.kind === 'timed-out') controller.abort()
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
