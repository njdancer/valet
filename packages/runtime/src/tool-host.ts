// The tool host: the one entry point for running an adapter's tool. It owns the order of checks,
// and the order is the security argument:
//
//   1. the call id is well formed and the adapter's exact bundle hash is approved;
//   2. the input matches the tool's schema;
//   3. the adapter's lock is held, so one session never runs two tools at once, and the hash is
//      still approved once we hold it. A call waits its turn for a bounded time only: after that,
//      or at once when the calls in front are too many to get through in that time, it ends busy,
//      having sent nothing, with how many calls were ahead of it;
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
  confirmActionSchema,
  defineAdapter,
  type EnsureResult,
  type ErrorClass,
  manifestSchema,
  NeedsUserError,
  type RequestDeclaration,
  type SessionDriver,
  type Stage,
  type ToolContext,
  type ToolDeclaration,
  type ToolImplementation,
  type ToolPage,
  type ToolRunPolicy,
  toReportable,
  unlockedBy,
  ValetError,
} from '@valet/core'
import type { z } from 'zod'
import type { ApprovalLookup } from './approvals'
import type { JsonStore } from './breaker-state'
import { CallState } from './call-state'
import { type Clock, type Sleep, systemClock, systemSleep } from './clock'
import { GuardedToolPage, MAX_TARGET_LENGTH, PURPOSE_RANK, plainMethod } from './guarded-page'
import { runIsolated, type ToolProcessFactory } from './isolation/host'
import type { LoginMarkerStore } from './login-marker'
import { KeyedMutex } from './mutex'
import { probeDeclaration } from './probe'
import { redactOutput } from './redaction'
import { knownReason, type LoginBackoff, SessionGate } from './session'
import { breakerRefusal, isSiteRefusal, type SiteGuards, SiteProtection } from './site-protection'
import {
  type AuthRunner,
  CLIENT_TRANSPORTS,
  type ClientTransport,
  type ConfirmationAnswer,
  type ConfirmationPrompt,
  type ConfirmationQuestion,
  type ListedTool,
  type LoginStepContext,
  type LoginStepOptions,
  type RuntimeDiagnostic,
  type SiteHealthSnapshot,
  type ToolCallRequest,
  type ToolCallResult,
} from './types'

export const DEFAULT_TOOL_TIMEOUT_MS = 120_000
/** For each schema parse. Parsing is local work; anything this slow is a refinement misbehaving. */
export const DEFAULT_VALIDATION_TIMEOUT_MS = 10_000
/** For the person to answer a confirmation. */
export const DEFAULT_CONFIRMATION_TIMEOUT_MS = 5 * 60_000
/** How long a finished call's leftover runtime work may hold the adapter's lock. */
export const DEFAULT_SETTLE_TIMEOUT_MS = 30_000
/** How long a login step waits for running calls on its adapter before giving up. */
export const DEFAULT_LOGIN_STEP_WAIT_MS = 30_000
/**
 * How long a tool call waits its turn behind earlier calls on its adapter before it ends busy.
 * Short enough that the answer reaches a client with a 60 s timeout, with the queue length and a
 * time to try again, where an unbounded wait would end in the client giving up and maybe repeating
 * a write. It also caps the queue: a call joins only while one of the site's gaps for each call in
 * front adds up to less than this.
 */
export const DEFAULT_QUEUE_WAIT_MS = 30_000
/** The bounds of the "try again" time a busy call is given. */
export const MIN_BUSY_RETRY_MS = 5_000
export const MAX_BUSY_RETRY_MS = 60_000
/** Distinct request-blocked events recorded per call. A page whose analytics are all blocked is chatty. */
export const MAX_BLOCKED_EVENTS_PER_CALL = 50
const MAX_CLIENT = 100
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/
const CALL_ID = /^[A-Za-z0-9_-]{1,64}$/
/** The endpoint's identity label: mcp-server's identityLabel(). */
const CLIENT_ID = /^(local|remote):[a-z0-9][a-z0-9_-]{0,63}$/
const HASH = /^[0-9a-f]{64}$/

export interface RegisteredAdapter {
  readonly definition: AdapterDefinition
  /** The bundle's content hash, as computed by bundleHash() when it was loaded. */
  readonly bundleHash: string
  readonly driver: SessionDriver
  /**
   * Runs this adapter's tool code in a process of its own, a fresh one per call, from `script`
   * (built by buildToolScript from the same sources as `definition`). The definition's schemas still
   * validate input and output here. Without it, tool code runs in this process.
   */
  readonly isolation?: ToolIsolation
}

export interface ToolIsolation {
  readonly script: string
  readonly start: ToolProcessFactory
}

export interface ToolHostOptions {
  readonly approvals: ApprovalLookup
  readonly audit: AuditSink
  readonly prompt: ConfirmationPrompt
  readonly authRunner: AuthRunner
  readonly markers: LoginMarkerStore
  /** Where site circuit breakers keep their state across restarts, e.g. a JsonFileStore. */
  readonly breakerStore: JsonStore
  /**
   * Where each site's last request time is kept across restarts, so a restart can't send a request
   * sooner than the site's gap after the last one. Without it the pace is kept in memory only.
   */
  readonly budgetStore?: JsonStore
  readonly clock?: Clock
  /** For deadlines: tool runs, schema parses, confirmations, settling. */
  readonly sleep?: Sleep
  /** For waiting on a site's rate budget. Defaults to `sleep`. */
  readonly pacingSleep?: Sleep
  readonly timeoutMs?: number
  readonly validationTimeoutMs?: number
  readonly confirmationTimeoutMs?: number
  readonly settleTimeoutMs?: number
  /** How long a call waits for its adapter's lock. Default 30 s; finite and above zero. */
  readonly queueWaitMs?: number
  readonly loginBackoff?: LoginBackoff
  readonly diagnostics?: (diagnostic: RuntimeDiagnostic) => void
}

interface Entry extends RegisteredAdapter {
  readonly gate: SessionGate
  readonly site: SiteGuards
  /** The site host its guards are keyed by. */
  readonly host: string
}

/** A wait for the adapter's lock that ended without it. `ahead`: the calls still in front. */
interface GaveUp {
  readonly kind: 'timed-out' | 'aborted'
  readonly ahead: number
}

type Raced<T> =
  | { readonly kind: 'returned'; readonly value: T }
  | { readonly kind: 'threw'; readonly error: unknown }
  | { readonly kind: 'timed-out' }
  | { readonly kind: 'aborted' }

export class ToolHost {
  private readonly adapters = new Map<string, Entry>()
  private readonly locks = new KeyedMutex()
  /** Per adapter, one ticket for each call or login step holding or waiting for its lock, in order. */
  private readonly queues = new Map<string, symbol[]>()
  private readonly protection: SiteProtection
  private readonly clock: Clock
  private readonly sleep: Sleep
  private readonly timeoutMs: number
  private readonly validationTimeoutMs: number
  private readonly confirmationTimeoutMs: number
  private readonly settleTimeoutMs: number
  private readonly queueWaitMs: number
  private readonly diagnostics: (diagnostic: RuntimeDiagnostic) => void

  constructor(private readonly options: ToolHostOptions) {
    this.clock = options.clock ?? systemClock
    this.sleep = options.sleep ?? systemSleep
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS
    this.validationTimeoutMs = options.validationTimeoutMs ?? DEFAULT_VALIDATION_TIMEOUT_MS
    this.confirmationTimeoutMs = options.confirmationTimeoutMs ?? DEFAULT_CONFIRMATION_TIMEOUT_MS
    this.settleTimeoutMs = options.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS
    // An unbounded wait is the fault this bound exists to remove, so a bad value is refused.
    this.queueWaitMs = boundOf(options.queueWaitMs, DEFAULT_QUEUE_WAIT_MS)
    this.diagnostics = options.diagnostics ?? (() => {})
    this.protection = new SiteProtection(this.clock, options.pacingSleep ?? this.sleep, {
      store: options.breakerStore,
      ...(options.budgetStore === undefined ? {} : { budgetStore: options.budgetStore }),
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
    const host = new URL(manifest.home).hostname.toLowerCase()
    const site = this.protection.forSite(host, manifest.limits)
    // D55: what the browser sees in either partition reaches this site's breaker, and an open
    // breaker stops the tool partition sending anything at all.
    driver.watchSite?.({
      refused: (refusal) => site.breaker.trip(refusal.cause, null),
      held: () => site.breaker.isOpen(),
      pace: async () => {
        if (site.breaker.isOpen()) throw breakerRefusal()
        await site.budget.acquire()
      },
    })
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
    })
    this.adapters.set(manifest.id, {
      definition,
      bundleHash,
      driver,
      gate,
      site,
      host,
      ...(adapter.isolation === undefined ? {} : { isolation: adapter.isolation }),
    })
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

  /**
   * Runs one step of a login the person drives (opening the login window, finishing a hand-off)
   * under the protections a tool call gets:
   *
   * - the adapter must be registered with its exact hash approved, before and after the wait;
   * - it takes the adapter's lock, in turn behind running calls (and their settling), and calls
   *   that arrive later wait for it;
   * - it refuses while the site's breaker is open, then waits for and takes one slot of the site's
   *   rate budget before `step` runs; `ctx.pace()` takes another before each further request;
   * - `step` runs under a deadline, and the lock stays held until it settles, up to the settle bound.
   *
   * Rejects with ValetError: `config/invalid` (a `waitMs` or `timeoutMs` that isn't a finite
   * number above zero, before anything else), `manifest/not-granted`, `login/rate-limited` (the breaker is open,
   * before the step or at a `pace()`), `login/timed-out` (the wait or the step ran out of time) or
   * `login/aborted`. Whatever `step` throws is passed on unchanged: it is the app's own code.
   */
  async runLoginStep<T>(
    adapterId: string,
    step: (ctx: LoginStepContext) => Promise<T>,
    options: LoginStepOptions = {},
  ): Promise<T> {
    // An unbounded wait or step would hold, or queue behind, the adapter's lock for good.
    const waitMs = boundOf(options.waitMs, DEFAULT_LOGIN_STEP_WAIT_MS)
    const timeoutMs = boundOf(options.timeoutMs, this.timeoutMs)
    const entry = this.adapters.get(adapterId)
    if (entry === undefined || !(await this.isApproved(entry)))
      throw new ValetError('manifest', 'not-granted')
    const external = signalOf(options.signal)
    if (external?.aborted) throw new ValetError('login', 'aborted')
    // A block persisted by an earlier run of the app must be in force before anything is sent.
    await this.protection.ready()
    const lock = await this.acquireLock(adapterId, waitMs, external)
    if (typeof lock !== 'function') throw new ValetError('login', lock.kind)
    const release = lock
    const controller = new AbortController()
    const stop = (): void => controller.abort()
    external?.addEventListener('abort', stop, { once: true })
    let unsettled: Promise<unknown> | null = null
    try {
      if (!(await this.isApproved(entry))) throw new ValetError('manifest', 'not-granted')
      const pace = async (): Promise<void> => {
        if (controller.signal.aborted) throw new ValetError('login', 'aborted')
        if (entry.site.breaker.isOpen()) throw new ValetError('login', 'rate-limited')
        try {
          await entry.site.budget.acquire(controller.signal)
        } catch {
          throw new ValetError('login', 'aborted')
        }
        // Another adapter on the same host may have been blocked while this one waited.
        if (entry.site.breaker.isOpen()) throw new ValetError('login', 'rate-limited')
        if (controller.signal.aborted) throw new ValetError('login', 'aborted')
      }
      await pace()
      const ctx: LoginStepContext = {
        signal: controller.signal,
        pace,
        reportBlocked: (cause) => {
          entry.site.breaker.trip(cause === 'rate-limited' ? 'rate-limited' : 'blocked-by-site', null)
        },
      }
      const work = Promise.resolve().then(() => step(ctx))
      unsettled = work
      const outcome = await this.race(() => work, timeoutMs, controller.signal)
      if (outcome.kind === 'returned') {
        unsettled = null
        return outcome.value
      }
      if (outcome.kind === 'threw') {
        unsettled = null
        throw outcome.error
      }
      throw new ValetError('login', outcome.kind === 'timed-out' ? 'timed-out' : 'aborted')
    } finally {
      external?.removeEventListener('abort', stop)
      controller.abort()
      const left = unsettled
      if (left === null) release()
      else void this.race(() => left, this.settleTimeoutMs).finally(release)
    }
  }

  /**
   * Each registered site's breaker and rate budget, read from memory once the persisted state is
   * loaded, so the app never reads breakers.json itself. Reads only: it takes no budget slot and
   * changes nothing.
   */
  async siteHealth(): Promise<SiteHealthSnapshot[]> {
    await this.protection.ready()
    const sites = new Map<string, { site: SiteGuards; adapterIds: string[] }>()
    for (const entry of this.adapters.values()) {
      const id = entry.definition.manifest.id
      const known = sites.get(entry.host)
      if (known === undefined) sites.set(entry.host, { site: entry.site, adapterIds: [id] })
      else known.adapterIds.push(id)
    }
    return [...sites].map(([host, { site, adapterIds }]) => {
      const status = site.breaker.status()
      return {
        host,
        adapterIds,
        breaker: status.open ? 'open' : 'closed',
        retryAt: status.retryAt,
        retryAfterMs: status.retryAfterMs,
        cooldownMs: status.cooldownMs,
        nextCooldownMs: status.nextCooldownMs,
        budget: { minGapMs: site.budget.gapMs, waitMs: site.budget.waitMs() },
      }
    })
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
        ...clientIdOf(request.clientId),
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
      result = await this.execute(entry, request, client, transportOf(request.transport))
    } catch (error) {
      result = fromError(error, entry.site)
    }
    await this.record(finishedEvent(adapterId, request.callId, result, this.clock.now() - started))
    return result
  }

  private async execute(
    entry: Entry,
    request: ToolCallRequest,
    client: string,
    transport: ClientTransport | undefined,
  ): Promise<ToolCallResult> {
    const external = signalOf(request.signal)
    if (external?.aborted) return failed('tool-run', 'aborted')
    if (!(await this.isApproved(entry))) return failed('manifest', 'not-granted')
    const manifest = entry.definition.manifest
    const declaration = manifest.tools.find((t) => t.name === request.tool)
    const implementation = implementationOf(entry, request.tool)
    if (declaration === undefined || implementation === undefined) return failed('manifest', 'not-found')
    const input = await this.validate(implementation.input, request.input, 'tool-input')
    if (input.status !== 'ok') return input

    // One lock per adapter, for reads and writes alike: the driver holds one run policy at a time,
    // so two calls on one session can't safely overlap.
    // A call that can't get its turn in time is told so at once: with one of the site's gaps for
    // each call in front, the wait would run out first. Waiting it out anyway would only keep the
    // client for the whole wait before the same answer.
    const inFront = this.queues.get(manifest.id)?.length ?? 0
    if (inFront * entry.site.budget.gapMs >= this.queueWaitMs) return busy(entry.site, inFront)
    const lock = await this.acquireLock(manifest.id, this.queueWaitMs, external)
    if (typeof lock !== 'function') {
      return lock.kind === 'aborted' ? failed('tool-run', 'aborted') : busy(entry.site, lock.ahead)
    }
    const release = lock
    const controller = new AbortController()
    // The caller giving up stops the tool the way a timeout does.
    const stop = (): void => controller.abort()
    external?.addEventListener('abort', stop, { once: true })
    const state = new CallState(request.callId, controller.signal, () => entry.gate.secrets)
    let running = false
    try {
      if (external?.aborted) return failed('tool-run', 'aborted')
      // Again, because a revocation can land while this call waits for the lock.
      if (!(await this.isApproved(entry))) return failed('manifest', 'not-granted')
      if (entry.site.breaker.isOpen()) return blocked(entry.site)
      const irreversible = declaration.sideEffect === 'irreversible'
      if (irreversible) {
        const answer = await this.ask(
          entry,
          declaration,
          request.callId,
          client,
          { kind: 'irreversible-tool', input: input.output },
          external,
          transport,
        )
        // Even a yes doesn't run a tool whose caller has gone.
        if (external?.aborted) return failed('tool-run', 'aborted')
        if (answer !== 'approved') return { status: 'declined' }
      }
      try {
        // Before the run begins: opening the tool page loads home under the run policy, and what
        // the driver refuses then is redacted against these.
        await this.collectSessionSecrets(entry, state)
      } catch {
        return failed('tool-run', 'internal')
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
      return await this.run(
        entry,
        declaration,
        implementation,
        client,
        transport,
        input.output,
        state,
        controller,
      )
    } finally {
      external?.removeEventListener('abort', stop)
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
    transport: ClientTransport | undefined,
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

    const ctx: ToolContext = {
      page: new GuardedToolPage({
        adapterId: manifest.id,
        manifest,
        sideEffect: declaration.sideEffect,
        unlocks: unlockedBy(manifest.requests, declaration.unlocks),
        inner,
        site: entry.site,
        state,
        audit: (event) => this.record(event),
      }),
      session: { ensure: () => this.ensure(entry, state, inner) },
      confirm: async (action) => {
        state.assertLive()
        const question = confirmQuestion(manifest, declaration, action)
        if (question instanceof ValetError) {
          // Sticky, like a guard violation: a tool can't catch the refusal and try another wording.
          state.violation ??= question
          throw question
        }
        const asking = this.ask(
          entry,
          declaration,
          state.callId,
          client,
          question,
          controller.signal,
          transport,
        )
        return (await state.track(asking)) === 'approved'
      },
      signal: controller.signal,
    }

    const isolation = entry.isolation
    const execute =
      isolation === undefined
        ? () => implementation.run(ctx, input)
        : () => runIsolated(isolation.start, isolation.script, ctx, declaration.name, input)
    const outcome = await this.race(execute, this.timeoutMs, controller.signal)
    // Capabilities die with the call, so promises tool code left running can't act afterwards.
    controller.abort()

    if (outcome.kind === 'timed-out') return failed('timeout', 'timed-out')
    if (outcome.kind === 'aborted') return failed('tool-run', 'aborted')
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
    if (parsed.kind !== 'returned' || !parsed.value.success) return failed(stage, 'invalid')
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
   * site refusing us, so none of them touches the site's breaker.
   *
   * The driver can only tell tool code apart for the raw capability calls it is handed (initiator
   * 'tool'); a fetch from evaluate()d code reaches it like the site's own scripts' (initiator
   * 'page'). So a page-initiated refusal ends the run too when it is one the site has no reason to
   * cause: a path that touches a denied segment or is ambiguous, more than the tool's side effect, or
   * the run over its ceiling. The site's own scripts calling an off-list host or an undeclared
   * endpoint (its analytics, say) is normal and only recorded.
   */
  private onBlocked(entry: Entry, state: CallState, request: BlockedRequest): void {
    const reason = Object.hasOwn(BLOCKED_REASON, request.reason) ? request.reason : 'bad-url'
    const initiator = request.initiator === 'page' ? 'page' : 'tool'
    const [stage, errorClass] = BLOCKED_REASON[reason]
    if (initiator === 'tool' || VIOLATION_WHOEVER_ASKED.has(reason)) {
      state.violation ??= new ValetError(stage, errorClass)
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
        partition: 'tool',
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
    question: ConfirmationQuestion,
    callSignal: AbortSignal | undefined,
    transport: ClientTransport | undefined,
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
            ...(transport === undefined ? {} : { transport }),
            ...question,
          },
          signal,
        ),
      this.confirmationTimeoutMs,
      callSignal,
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
   * Runs `task` against a deadline kept with the injected sleep, and against `signal` when given.
   * The task itself can't be stopped (callers abort their own signals), only stopped being waited for.
   */
  private async race<T>(task: () => Promise<T>, ms: number, signal?: AbortSignal): Promise<Raced<T>> {
    const timer = new AbortController()
    const running: Promise<Raced<T>> = Promise.resolve()
      .then(task)
      .then(
        (value) => ({ kind: 'returned', value }),
        (error: unknown) => ({ kind: 'threw', error }),
      )
    const contenders: Promise<Raced<T>>[] = [running]
    // An unbounded wait needs no timer.
    if (Number.isFinite(ms)) {
      contenders.push(
        this.sleep(ms, timer.signal).then(
          () => ({ kind: 'timed-out' }),
          () => running,
        ),
      )
    }
    let onAbort: (() => void) | undefined
    if (signal !== undefined) {
      contenders.push(
        new Promise<Raced<T>>((resolve) => {
          onAbort = () => resolve({ kind: 'aborted' })
          if (signal.aborted) onAbort()
          else signal.addEventListener('abort', onAbort, { once: true })
        }),
      )
    }
    const outcome = await Promise.race(contenders)
    timer.abort()
    if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort)
    return outcome
  }

  /**
   * Joins the adapter's queue. Gives up after `waitMs` or when `signal` aborts, and says how many
   * were still ahead. A waiter that gave up still takes its turn and hands it straight on, so the
   * queue keeps its order.
   */
  private async acquireLock(
    adapterId: string,
    waitMs: number,
    signal: AbortSignal | undefined,
  ): Promise<(() => void) | GaveUp> {
    const ticket = Symbol(adapterId)
    let queue = this.queues.get(adapterId)
    if (queue === undefined) {
      queue = []
      this.queues.set(adapterId, queue)
    }
    queue.push(ticket)
    const tickets = queue
    const leave = (): void => {
      const index = tickets.indexOf(ticket)
      if (index !== -1) tickets.splice(index, 1)
      if (tickets.length === 0 && this.queues.get(adapterId) === tickets) this.queues.delete(adapterId)
    }
    const pending = this.locks.acquire(adapterId)
    const outcome = await this.race(() => pending, waitMs, signal)
    if (outcome.kind === 'returned') {
      const release = outcome.value
      return () => {
        leave()
        release()
      }
    }
    // Everyone still in front: the holder, and those waiting who have not given up.
    const ahead = tickets.indexOf(ticket)
    leave()
    void pending.then((release) => release())
    return { kind: outcome.kind === 'aborted' ? 'aborted' : 'timed-out', ahead }
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

/** Refusals that end the run whoever made the request; see onBlocked. */
const VIOLATION_WHOEVER_ASKED: ReadonlySet<BlockedRequest['reason']> = new Set<BlockedRequest['reason']>([
  'denied-path',
  'ambiguous-path',
  'purpose-exceeded',
  'request-ceiling',
])

/**
 * The network policy for one run. The probe's own request is added to the declarations: it is the
 * runtime's, not tool code's, but it goes through the same partition.
 *
 * Of the manifest's irreversible declarations, the person's yes unlocks only the ones this tool
 * names (C15), so it can't be spent on another tool's request, by tool code or by the page. The
 * others stay in the request surface, still matched and still refused: taking them out would let a
 * wider declaration further down the list match the same request.
 */
function runPolicy(manifest: AdapterManifest, declaration: ToolDeclaration): ToolRunPolicy {
  return {
    egress: manifest.egress,
    requests: [...manifest.requests, ...probeDeclaration(manifest)],
    unlocks: unlockedBy(manifest.requests, declaration.unlocks).map(({ method, path }) => ({ method, path })),
    maxPurpose: declaration.sideEffect,
    ceiling: manifest.limits.requestsPerRun,
  }
}

function implementationOf(entry: RegisteredAdapter, name: string): ToolImplementation | undefined {
  // hasOwn, so a tool named "constructor" or "__proto__" can't reach Object.prototype.
  return Object.hasOwn(entry.definition.tools, name) ? entry.definition.tools[name] : undefined
}

/** A transport the runtime knows, or none: the label is never invented or passed on unchecked. */
function transportOf(value: unknown): ClientTransport | undefined {
  return CLIENT_TRANSPORTS.find((t) => t === value)
}

/** The credential's client id when it has the endpoint's shape; otherwise nothing is recorded. */
function clientIdOf(value: unknown): { readonly clientId?: string } {
  return typeof value === 'string' && CLIENT_ID.test(value) ? { clientId: value } : {}
}

/** The caller's signal, if it is one. Anything else is ignored rather than trusted to behave. */
function signalOf(value: unknown): AbortSignal | undefined {
  return value instanceof AbortSignal ? value : undefined
}

/** A login step's wait or deadline: the default when not given, else finite and above zero. */
function boundOf(value: unknown, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    throw new ValetError('config', 'invalid')
  return value
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

/**
 * A call that gave up waiting its turn. The time to try again is a guess, since nothing says how
 * long the calls in front will take: one of the site's gaps for each, within fixed bounds.
 */
function busy(site: SiteGuards, ahead: number): ToolCallResult {
  const calls = Math.max(1, ahead)
  const estimate = calls * site.budget.gapMs
  return {
    status: 'busy',
    retryAfterMs: Math.min(MAX_BUSY_RETRY_MS, Math.max(MIN_BUSY_RETRY_MS, estimate)),
    ahead: calls,
  }
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
    case 'busy':
      // Not the site refusing us, which is what `blocked` means in the log: our own queue was full.
      return { ...base, outcome: 'failed', stage: 'tool-run', errorClass: 'busy' }
    case 'declined':
      return { ...base, outcome: 'declined' }
  }
}

/**
 * Turns what tool code passed to ctx.confirm() into the runtime's question: each request it names
 * becomes the manifest's own declaration (C4). Anything malformed, undeclared or beyond the tool's
 * side effect is refused, since the person would be shown a request the tool can't make.
 */
function confirmQuestion(
  manifest: AdapterManifest,
  declaration: ToolDeclaration,
  action: unknown,
): ConfirmationQuestion | ValetError {
  const parsed = confirmActionSchema.safeParse(action)
  if (!parsed.success) return new ValetError('confirm', 'invalid')
  const requests: RequestDeclaration[] = []
  for (const named of parsed.data.requests) {
    const declared = manifest.requests.find((r) => r.method === named.method && r.path === named.path)
    if (declared === undefined) return new ValetError('confirm', 'undeclared-request')
    if (PURPOSE_RANK[declared.purpose] > PURPOSE_RANK[declaration.sideEffect]) {
      return new ValetError('confirm', 'invalid')
    }
    if (!requests.includes(declared)) requests.push(declared)
  }
  return { kind: 'tool-request', requests, note: parsed.data.note ?? null }
}
