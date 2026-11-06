// The tool host: the one entry point for running an adapter's tool. It owns the order of checks,
// and the order is the security argument:
//
//   1. the call id is well formed and the adapter's exact bundle hash is approved;
//   2. the input matches the tool's schema;
//   3. the adapter's lock is held, so one session never runs two tools at once, and the hash is
//      still approved once we hold it;
//   4. the site's circuit breaker is closed;
//   5. an irreversible tool has the person's confirmation, before its run() starts;
//   6. the driver holds the whole tool partition to this run's network policy (egress, request
//      surface, the tool's side effect, the ceiling), and only after that confirmation unlocks the
//      run's irreversible declarations;
//   7. the tool runs with a guarded capability object, a timeout and an abort signal;
//   8. the output matches the tool's schema, is converted to plain JSON, and is redacted on the
//      way out.
//
// Schemas are adapter code too: a zod refine or transform runs whatever the adapter wrote. So input
// parsing runs before the confirmation (the person is shown the parsed input) with nothing but the
// raw input to work on, and both parses run under their own deadline, as does the confirmation
// prompt, so nothing an adapter supplies can hold the lock indefinitely.
//
// After a call ends, its lock (and the driver's run) is held until the runtime work it started
// (page operations, ensure(), prompts) settles, up to a bound, so a timed-out call can't keep
// driving the session under the next one, or outside its run policy.
//
// Every call that reaches an adapter is audited as tool-called and tool-finished. Nothing that
// leaves here carries page text or exception messages: failures are a stage and an error class, and
// needsUser is a reason code.

import {
  type AdapterDefinition,
  type AdapterManifest,
  type AuditEvent,
  type AuditSink,
  type BlockedRequest,
  defineAdapter,
  type EnsureResult,
  type ErrorClass,
  manifestSchema,
  NeedsUserError,
  type SessionDriver,
  SiteAdapterError,
  type Stage,
  type ToolContext,
  type ToolDeclaration,
  type ToolImplementation,
  type ToolPage,
  type ToolRunPolicy,
  toReportable,
} from '@siteadapter/core'
import type { z } from 'zod'
import type { ApprovalLookup } from './approvals'
import type { JsonStore } from './breaker-state'
import { CallState } from './call-state'
import { type Clock, type Sleep, systemClock, systemSleep } from './clock'
import { GuardedToolPage, MAX_TARGET_LENGTH, plainMethod } from './guarded-page'
import type { LoginMarkerStore } from './login-marker'
import { KeyedMutex } from './mutex'
import { probeDeclaration } from './probe'
import { redactOutput } from './redaction'
import { knownReason, type LoginBackoff, SessionGate } from './session'
import { isSiteRefusal, type SiteGuards, SiteProtection } from './site-protection'
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
/** Distinct request-blocked events recorded per call. A page whose analytics are all blocked is chatty. */
export const MAX_BLOCKED_EVENTS_PER_CALL = 50
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
  /** Where site circuit breakers keep their state across restarts, e.g. a JsonFileStore. */
  readonly breakerStore: JsonStore
  readonly clock?: Clock
  /** For deadlines: tool runs, schema parses, confirmations, settling. */
  readonly sleep?: Sleep
  /** For waiting on a site's rate budget. Defaults to `sleep`. */
  readonly pacingSleep?: Sleep
  readonly timeoutMs?: number
  readonly validationTimeoutMs?: number
  readonly confirmationTimeoutMs?: number
  readonly settleTimeoutMs?: number
  readonly loginBackoff?: LoginBackoff
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
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS
    this.validationTimeoutMs = options.validationTimeoutMs ?? DEFAULT_VALIDATION_TIMEOUT_MS
    this.confirmationTimeoutMs = options.confirmationTimeoutMs ?? DEFAULT_CONFIRMATION_TIMEOUT_MS
    this.settleTimeoutMs = options.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS
    this.diagnostics = options.diagnostics ?? (() => {})
    this.protection = new SiteProtection(this.clock, options.pacingSleep ?? this.sleep, {
      store: options.breakerStore,
      audit: (event) => this.record(event),
      diagnostics: this.diagnostics,
    })
  }

  /** Adds an adapter. Registration is not approval: its tools stay hidden until its hash is approved. */
  register(adapter: RegisteredAdapter): void {
    const { bundleHash, driver } = adapter
    if (!HASH.test(bundleHash)) throw new Error('bundleHash must be a sha256 hex digest')
    // Re-validate in case the manifest was built by hand rather than with parseManifest, and keep
    // the parsed copy, so the schema's defaults (limits, loggedOutStatuses) are always in force.
    const manifest = manifestSchema.parse(adapter.definition.manifest)
    const definition = defineAdapter({ manifest, tools: adapter.definition.tools })
    if (this.adapters.has(manifest.id)) throw new Error(`adapter ${manifest.id} is already registered`)
    const site = this.protection.forSite(new URL(manifest.home).hostname, manifest.limits)
    const gate = new SessionGate({
      adapterId: manifest.id,
      adapterHash: bundleHash,
      manifest,
      driver,
      authRunner: this.options.authRunner,
      markers: this.options.markers,
      site,
      clock: this.clock,
      ...(this.options.loginBackoff === undefined ? {} : { backoff: this.options.loginBackoff }),
      audit: (event) => this.record(event),
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
    const adapterId = entry.definition.manifest.id
    const client = normaliseClient(request.client)
    const started = this.clock.now()
    try {
      await this.options.audit.append({
        type: 'tool-called',
        adapterId,
        adapterHash: entry.bundleHash,
        tool: TOOL_NAME.test(request.tool) ? request.tool : '(invalid)',
        client,
        callId: request.callId,
      })
    } catch {
      // A call we can't record doesn't run.
      return failed('tool-run', 'internal')
    }
    // A block persisted by an earlier run of the app must be in force before anything is sent.
    await this.protection.ready()
    let result: ToolCallResult
    try {
      result = await this.execute(entry, request, client)
    } catch (error) {
      result = fromError(error, entry.site)
    }
    await this.record(finishedEvent(adapterId, request.callId, result, this.clock.now() - started))
    return result
  }

  private async execute(entry: Entry, request: ToolCallRequest, client: string): Promise<ToolCallResult> {
    if (!(await this.isApproved(entry))) return failed('manifest', 'not-granted')
    const manifest = entry.definition.manifest
    const declaration = manifest.tools.find((t) => t.name === request.tool)
    const implementation = implementationOf(entry, request.tool)
    if (declaration === undefined || implementation === undefined) return failed('manifest', 'not-found')
    const input = await this.validate(implementation.input, request.input, 'tool-input')
    if (input.status !== 'ok') return input

    // One lock per adapter, for reads and writes alike: the driver holds one run policy at a time,
    // so two calls on one session can't safely overlap.
    const release = await this.locks.acquire(manifest.id)
    const controller = new AbortController()
    const state = new CallState(request.callId, controller.signal)
    let running = false
    try {
      // Again, because a revocation can land while this call waits for the lock.
      if (!(await this.isApproved(entry))) return failed('manifest', 'not-granted')
      if (entry.site.breaker.isOpen()) return blocked(entry.site)
      const irreversible = declaration.sideEffect === 'irreversible'
      if (irreversible) {
        const answer = await this.ask(entry, declaration, request.callId, client, {
          kind: 'irreversible-tool',
          message: declaration.description,
          input: input.output,
        })
        if (answer !== 'approved') return { status: 'declined' }
      }
      try {
        entry.driver.beginRun(runPolicy(manifest, declaration), (b) => this.onBlocked(entry, state, b))
        running = true
        // Only the runtime's own confirmation above unlocks; ctx.confirm() never does.
        if (irreversible) entry.driver.unlockIrreversible()
      } catch (error) {
        // Without the driver's policy in force, nothing tool code does would be held to it.
        return fromReportable(toReportable(error, 'egress'))
      }
      return await this.run(entry, declaration, implementation, client, input.output, state, controller)
    } finally {
      // Capabilities die with the call, so promises tool code left running can't act afterwards.
      controller.abort()
      const finish = (): void => {
        if (running) {
          try {
            entry.driver.endRun()
          } catch {
            // Nothing more to stop; the next beginRun replaces the policy.
          }
        }
        state.dispose()
        release()
      }
      if (state.idle) finish()
      else void this.afterSettling(state).finally(finish)
    }
  }

  private async run(
    entry: Entry,
    declaration: ToolDeclaration,
    implementation: ToolImplementation,
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
    await this.collectSessionSecrets(entry, state)

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
          state.callId,
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
    if (outcome.kind === 'threw') return fromThrown(outcome.error, state, entry.site)

    const output = await this.validate(implementation.output, outcome.value, 'tool-output')
    if (output.status !== 'ok') return output
    try {
      await this.collectSessionSecrets(entry, state)
    } catch {
      // Without the current session values we can't redact, so the output doesn't leave.
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
        entry.gate.ensure({
          callId: state.callId,
          signal: state.signal,
          page,
          login: state.login,
          secrets: state.secrets,
        }),
      )
      state.ensureOutcome = result.status === 'ok' ? null : result
      await this.collectSessionSecrets(entry, state)
      return result
    } catch (error) {
      if (isSiteRefusal(error)) state.blocked = true
      throw error
    }
  }

  /**
   * What the driver reports refusing during a run. Each refusal is our own policy at work, never the
   * site refusing us, so none of them touches the site's breaker. Tool code reaching past the
   * capability API (initiator 'tool'), or a run over its ceiling, ends the run as a violation; the
   * site's own scripts being refused (its analytics, say) is normal and only recorded.
   */
  private onBlocked(entry: Entry, state: CallState, request: BlockedRequest): void {
    const reason = Object.hasOwn(BLOCKED_REASON, request.reason) ? request.reason : 'bad-url'
    const initiator = request.initiator === 'page' ? 'page' : 'tool'
    const [stage, errorClass] = BLOCKED_REASON[reason]
    if (initiator === 'tool' || reason === 'request-ceiling') {
      state.violation ??= new SiteAdapterError(stage, errorClass)
    }
    const method = plainMethod(request.method)
    const target = typeof request.target === 'string' ? request.target.slice(0, MAX_TARGET_LENGTH) : ''
    const key = `${initiator} ${method} ${target} ${errorClass}`
    if (state.reportedBlocks.has(key)) return
    if (state.reportedBlocks.size >= MAX_BLOCKED_EVENTS_PER_CALL) {
      if (state.reportedBlocks.size === MAX_BLOCKED_EVENTS_PER_CALL) {
        state.reportedBlocks.add('(capped)')
        this.diagnostics({
          type: 'request-blocked-capped',
          adapterId: entry.definition.manifest.id,
          callId: state.callId,
        })
      }
      return
    }
    state.reportedBlocks.add(key)
    void state.track(
      this.record({
        type: 'request-blocked',
        adapterId: entry.definition.manifest.id,
        method,
        target: state.redactTarget(target),
        reason: errorClass,
        initiator,
        callId: state.callId,
      }),
    )
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
      client,
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

  /** Cookie values and handed-off storage values, old and new, so output can't carry them. */
  private async collectSessionSecrets(entry: Entry, state: CallState): Promise<void> {
    const { cookieDomains, storage } = entry.definition.manifest.session
    const values = await entry.driver.sessionSecrets(cookieDomains, storage)
    for (const value of values) if (typeof value === 'string') state.sessionValues.add(value)
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

/** How each refusal the driver reports is reported as an error, and in the audit log. */
const BLOCKED_REASON = {
  'host-not-allowed': ['egress', 'host-not-allowed'],
  undeclared: ['request-surface', 'undeclared-request'],
  'denied-path': ['request-surface', 'denied-path'],
  'ambiguous-path': ['request-surface', 'ambiguous-path'],
  'purpose-exceeded': ['request-surface', 'denied-path'],
  'request-ceiling': ['request-surface', 'request-ceiling'],
  'bad-url': ['request-surface', 'invalid'],
} as const satisfies Record<BlockedRequest['reason'], readonly [Stage, ErrorClass]>

/**
 * The network policy for one run. The probe's own request is added to the declarations: it is the
 * runtime's, not tool code's, but it goes through the same partition.
 */
function runPolicy(manifest: AdapterManifest, declaration: ToolDeclaration): ToolRunPolicy {
  return {
    egress: manifest.egress,
    requests: [...manifest.requests, ...probeDeclaration(manifest)],
    maxPurpose: declaration.sideEffect,
    ceiling: manifest.limits.requestsPerRun,
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

function fromError(error: unknown, site: SiteGuards): ToolCallResult {
  if (isSiteRefusal(error)) return blocked(site)
  return fromReportable(toReportable(error, 'tool-run'))
}

/**
 * A tool that threw. NeedsUserError ends the run as needsUser with its reason; otherwise a tool that
 * gave up after ensure() said needsUser or failed reports what ensure() said.
 */
function fromThrown(error: unknown, state: CallState, site: SiteGuards): ToolCallResult {
  if (error instanceof NeedsUserError) return { status: 'needsUser', reason: knownReason(error.reason) }
  const ensured = state.ensureOutcome
  if (ensured?.status === 'needsUser') return { status: 'needsUser', reason: ensured.reason }
  if (ensured?.status === 'failed') return failed(ensured.stage, ensured.errorClass)
  return fromError(error, site)
}

function finishedEvent(
  adapterId: string,
  callId: string,
  result: ToolCallResult,
  durationMs: number,
): AuditEvent {
  const base = { type: 'tool-finished', adapterId, callId, durationMs } as const
  switch (result.status) {
    case 'ok':
      return { ...base, outcome: 'ok' }
    case 'needsUser':
      return { ...base, outcome: 'needsUser', needsUser: result.reason }
    case 'failed':
      return { ...base, outcome: 'failed', stage: result.stage, errorClass: result.errorClass }
    case 'blocked':
      return { ...base, outcome: 'blocked' }
    case 'declined':
      return { ...base, outcome: 'declined' }
  }
}
