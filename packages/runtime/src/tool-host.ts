// The tool host: the one entry point for running an adapter's tool. It owns the order of checks,
// and the order is the security argument:
//
//   1. the call id is well formed and the adapter's exact bundle hash is approved;
//   2. the input matches the tool's schema;
//   3. the adapter's lock is held, so one session never runs two tools at once, and the hash is
//      still approved once we hold it. A call waits its turn for a bounded time only: after that,
//      or at once when the calls in front are too many to get through in that time, it ends busy,
//      having sent nothing, with how many calls were ahead of it;
//   4. the site's circuit breaker is closed, and its hourly cap, if it has one, has room;
//   5. an irreversible tool has the person's confirmation, before its run() starts;
//   6. the driver holds the whole tool partition to this run's network policy (egress, request
//      surface, the tool's side effect, the ceiling), and only after that confirmation unlocks the
//      run's irreversible declarations;
//   7. the tool runs with a guarded capability object, a timeout and an abort signal. Reads the
//      manifest says may be kept can be answered from the adapter's session cache (read-cache.ts),
//      which sits outside the guard: whatever is sent still passes it;
//   8. the output matches the tool's schema, is converted to plain JSON, and is redacted on the
//      way out.
//
// Settings (D69) add two things between 4 and 5. A call is refused, needsUser `setting-required`,
// while a setting the manifest requires has no value. And a setting with an apply tool has it run
// first, as a run of its own under the same lock, with its own policy and its own audit records,
// whenever the value isn't known to be in force on the site. The tools that serve settings are the
// adapter's own code and get no more than any tool; MCP clients can neither list nor call them.
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

import { randomUUID } from 'node:crypto'
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
  type LocalAccess,
  manifestSchema,
  NeedsUserError,
  type RequestDeclaration,
  type SessionDriver,
  type SettingDeclaration,
  type Stage,
  settingChoicesSchema,
  settingToolNames,
  settingValueSchema,
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
import {
  GuardedToolPage,
  MAX_TARGET_LENGTH,
  NOTEWORTHY_WAIT_MS,
  PURPOSE_RANK,
  plainMethod,
} from './guarded-page'
import { checkInputIsolated, runIsolated, type ToolProcessFactory } from './isolation/host'
import type { LoginMarkerStore } from './login-marker'
import { KeyedMutex } from './mutex'
import { probeDeclaration } from './probe'
import { CachedToolPage, ReadCache } from './read-cache'
import { redactOutput } from './redaction'
import { knownReason, type LoginBackoff, SessionGate } from './session'
import { breakerRefusal, isSiteRefusal, type SiteGuards, SiteProtection } from './site-protection'
import {
  type AdapterSettingsLookup,
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
  type SettingChoicesRequest,
  type SettingChoicesResult,
  type SiteHealthSnapshot,
  type ToolCallRequest,
  type ToolCallResult,
} from './types'

export const DEFAULT_TOOL_TIMEOUT_MS = 120_000
/** For each schema parse. Parsing is local work; anything this slow is a refinement misbehaving. */
export const DEFAULT_VALIDATION_TIMEOUT_MS = 10_000
/** For the person to answer a confirmation (D19, D50): unanswered for this long, it is declined. */
export const DEFAULT_CONFIRMATION_TIMEOUT_MS = 2 * 60_000
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
/**
 * How long a call waits on a login it started before answering its caller without it (D50). A
 * login that is quick (a remembered session, a test double) still finishes inside the call.
 */
export const DEFAULT_LOGIN_ANSWER_MS = 5_000
/** How long a login may run on in the background after its call was answered. */
export const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60_000
/** When a caller answered early is told to call again. A guess: logins are paced, and vary. */
export const LOGIN_RETRY_MS = 30_000
/** Distinct request-blocked events recorded per call. A page whose analytics are all blocked is chatty. */
export const MAX_BLOCKED_EVENTS_PER_CALL = 50
const MAX_CLIENT = 100
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/
const CALL_ID = /^[A-Za-z0-9_-]{1,64}$/
/** The endpoint's identity label: mcp-server's identityLabel(). */
const CLIENT_ID = /^(local|remote):[a-z0-9][a-z0-9_-]{0,63}$/
const HASH = /^[0-9a-f]{64}$/
/**
 * How long an applied setting is trusted to still be in force on the site. A site session can end
 * without the runtime seeing it (an anonymous session's cookies expiring), and the site then goes
 * back to its own default.
 */
export const SETTING_REAPPLY_MS = 6 * 60 * 60_000
/** The client named in the audit records of the runtime's own runs of a setting's tools. */
export const SETTINGS_CLIENT = 'Valet (settings)'

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
  /**
   * What tool code reaches through `ctx.local` (docs/sandbox.md): the adapter's declared sandbox
   * exceptions, enforced by the implementation. Without it every local call is not-granted.
   */
  readonly local?: LocalAccess
}

export interface ToolHostOptions {
  readonly approvals: ApprovalLookup
  readonly audit: AuditSink
  readonly prompt: ConfirmationPrompt
  readonly authRunner: AuthRunner
  readonly markers: LoginMarkerStore
  /** Where site circuit breakers keep their state across restarts, e.g. a JsonFileStore. */
  readonly breakerStore: JsonStore
  /** The person's chosen setting values. Without it no setting has a value. */
  readonly settings?: AdapterSettingsLookup
  /** Call ids for the runtime's own runs of apply tools. Random by default. */
  readonly newCallId?: () => string
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
  /** Draws from [0, 1) for the rate budgets' jitter (limits.gapJitterPercent). Default Math.random. */
  readonly random?: () => number
  readonly timeoutMs?: number
  readonly validationTimeoutMs?: number
  readonly confirmationTimeoutMs?: number
  readonly settleTimeoutMs?: number
  /** How long a call waits for its adapter's lock. Default 30 s; finite and above zero. */
  readonly queueWaitMs?: number
  /** How long a call waits on its own login before answering early. Default 5 s. */
  readonly loginAnswerMs?: number
  /** How long that login may then run on in the background. Default 5 min. */
  readonly loginTimeoutMs?: number
  readonly loginBackoff?: LoginBackoff
  readonly diagnostics?: (diagnostic: RuntimeDiagnostic) => void
}

interface Entry extends RegisteredAdapter {
  readonly gate: SessionGate
  readonly site: SiteGuards
  /** The site host its guards are keyed by. */
  readonly host: string
  /**
   * Settings whose apply tool has run in this process, with the value it applied and when. Memory
   * only: a restart applies again. Emptied whenever the session may have changed under it.
   */
  readonly applied: Map<string, { readonly value: string; readonly at: number }>
  /** This adapter's session read cache (D28). */
  readonly cache: ReadCache
}

/** A setting whose apply tool must run before the call that found it. */
interface DueSetting {
  readonly name: string
  readonly value: string
  readonly declaration: ToolDeclaration
  readonly implementation: ToolImplementation
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
  /** Per adapter, the input checks running in tool processes now (MAX_INPUT_CHECKS). */
  private readonly checking = new Map<string, number>()
  private readonly protection: SiteProtection
  private readonly clock: Clock
  private readonly sleep: Sleep
  private readonly timeoutMs: number
  private readonly validationTimeoutMs: number
  private readonly confirmationTimeoutMs: number
  private readonly settleTimeoutMs: number
  private readonly queueWaitMs: number
  private readonly loginAnswerMs: number
  private readonly loginTimeoutMs: number
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
    this.loginAnswerMs = boundOf(options.loginAnswerMs, DEFAULT_LOGIN_ANSWER_MS)
    this.loginTimeoutMs = boundOf(options.loginTimeoutMs, DEFAULT_LOGIN_TIMEOUT_MS)
    this.diagnostics = options.diagnostics ?? (() => {})
    this.protection = new SiteProtection(this.clock, options.pacingSleep ?? this.sleep, {
      store: options.breakerStore,
      ...(options.budgetStore === undefined ? {} : { budgetStore: options.budgetStore }),
      ...(options.random === undefined ? {} : { random: options.random }),
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
      applied: new Map(),
      cache: new ReadCache(this.clock),
      ...(adapter.isolation === undefined ? {} : { isolation: adapter.isolation }),
    })
  }

  /**
   * Swaps in another version of a registered adapter (docs/adapter-packages.md#install-update-and-rollback),
   * or registers it if its id is new. It takes the adapter's lock like a call, so running calls
   * finish first; a call that was queued behind it finds a different entry when its turn comes and
   * is answered "busy" without starting. The site's guards are the host's and carry over, as do
   * the login's secrets for redaction; the login markers are keyed by id and persist anyway.
   * Rejects with ValetError('config', 'busy') if the lock isn't free within `waitMs`. The caller
   * closes the old driver once this resolves.
   */
  async replace(adapter: RegisteredAdapter, waitMs: number = this.queueWaitMs): Promise<void> {
    const id = manifestSchema.parse(adapter.definition.manifest).id
    const previous = this.adapters.get(id)
    if (previous === undefined) {
      this.register(adapter)
      return
    }
    const lock = await this.acquireLock(id, boundOf(waitMs, this.queueWaitMs), undefined)
    if (typeof lock !== 'function') throw new ValetError('config', 'busy')
    try {
      const current = this.adapters.get(id)
      this.adapters.delete(id)
      try {
        this.register(adapter)
      } catch (error) {
        if (current !== undefined) this.adapters.set(id, current)
        throw error
      }
      if (current !== undefined) this.adapters.get(id)?.gate.inherit(current.gate)
    } finally {
      lock()
    }
  }

  /** The tools of every adapter whose registered hash is approved. */
  async listTools(): Promise<ListedTool[]> {
    const listed: ListedTool[] = []
    for (const entry of this.adapters.values()) {
      const manifest = entry.definition.manifest
      if (!(await this.isApproved(entry))) continue
      const internal = settingToolNames(manifest)
      for (const declaration of manifest.tools) {
        if (internal.has(declaration.name)) continue
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
      if (this.adapters.get(adapterId) !== entry) throw new ValetError('login', 'busy')
      if (!(await this.isApproved(entry))) throw new ValetError('manifest', 'not-granted')
      // The person is logging in or out: nothing remembered about the old session holds.
      forget(entry)
      entry.gate.leave(null)
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
      // The person's login work can replace the tool partition's session, and with it whatever the
      // site held for the old one: every setting is applied again before the next call.
      entry.applied.clear()
      external?.removeEventListener('abort', stop)
      controller.abort()
      const left = unsettled
      if (left === null) release()
      else void this.race(() => left, this.settleTimeoutMs).finally(release)
    }
  }

  /**
   * Resolves once every breaker and rate-budget change so far is on disk (or has failed to be).
   * Those writes are not waited for while calls run; the app waits for them here before it stops,
   * so quitting doesn't lose the last request's time or a breaker that just opened.
   */
  flushed(): Promise<void> {
    return this.protection.flushed()
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
        calls: adapterIds.reduce((sum, id) => sum + (this.queues.get(id)?.length ?? 0), 0),
      }
    })
  }

  call(request: ToolCallRequest): Promise<ToolCallResult> {
    return this.dispatch(request, false)
  }

  /**
   * The choices for one of an adapter's settings, for the app to show the person (D69): one run of
   * the setting's choices tool, with everything a tool call gets (approval, the lock, the breaker,
   * the rate budget, the run policy, the audit records, redaction). Its output must also be the
   * shape core fixes for choices, whatever the tool's own schema allows.
   */
  async settingChoices(request: SettingChoicesRequest): Promise<SettingChoicesResult> {
    const entry = this.adapters.get(request.adapterId)
    if (entry === undefined) return failed('manifest', 'not-granted')
    const setting = settingOf(entry.definition.manifest, request.setting)
    if (setting === undefined) return failed('manifest', 'not-found')
    const result = await this.dispatch(
      {
        adapterId: request.adapterId,
        tool: setting.choices.tool,
        input: { query: request.query },
        client: SETTINGS_CLIENT,
        callId: request.callId,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      },
      true,
    )
    if (result.status !== 'ok') return result
    const parsed = settingChoicesSchema.safeParse(result.output)
    if (!parsed.success) return failed('tool-output', 'invalid')
    return { status: 'ok', choices: parsed.data.choices }
  }

  /** `internal`: the runtime's own run of a tool that serves a setting, which no client may call. */
  private async dispatch(request: ToolCallRequest, internal: boolean): Promise<ToolCallResult> {
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
      result = await this.execute(entry, request, client, transportOf(request.transport), internal)
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
    internal: boolean,
  ): Promise<ToolCallResult> {
    const external = signalOf(request.signal)
    if (external?.aborted) return failed('tool-run', 'aborted')
    if (!(await this.isApproved(entry))) return failed('manifest', 'not-granted')
    const manifest = entry.definition.manifest
    const declaration = manifest.tools.find((t) => t.name === request.tool)
    const implementation = implementationOf(entry, request.tool)
    if (declaration === undefined || implementation === undefined) return failed('manifest', 'not-found')
    // A setting's tool answers a client exactly as a tool that doesn't exist.
    if (settingToolNames(manifest).has(declaration.name) !== internal) return failed('manifest', 'not-found')
    const input = await this.validate(implementation.input, request.input, 'tool-input')
    if (input.status !== 'ok') return input
    // Code that runs in the tool process has its own schemas there; they decide too, now, before the
    // queue, any setting's apply tool or a confirmation, so a call they refuse sends nothing.
    const isolation = entry.isolation
    if (isolation !== undefined && !internal) {
      // Each check is a tool process of its own, started before the queue's limits apply, so a
      // client firing calls in parallel is held to a few at once.
      const checking = this.checking.get(manifest.id) ?? 0
      if (checking >= MAX_INPUT_CHECKS) return busy(entry.site, 0)
      this.checking.set(manifest.id, checking + 1)
      let accepted: boolean
      try {
        accepted = await checkInputIsolated(isolation.start, isolation.script, declaration.name, input.output)
      } finally {
        this.checking.set(manifest.id, (this.checking.get(manifest.id) ?? 1) - 1)
      }
      if (!accepted) return failed('tool-input', 'invalid')
    }

    // One lock per adapter, for reads and writes alike: the driver holds one run policy at a time,
    // so two calls on one session can't safely overlap.
    // A call that can't get its turn in time is told so at once: with one of the site's gaps for
    // each call in front, the wait would run out first. Waiting it out anyway would only keep the
    // client for the whole wait before the same answer.
    const inFront = this.queues.get(manifest.id)?.length ?? 0
    if (inFront * entry.site.budget.gapMs >= this.queueWaitMs) return busy(entry.site, inFront)
    const queuedAt = this.clock.now()
    const lock = await this.acquireLock(manifest.id, this.queueWaitMs, external)
    if (typeof lock !== 'function') {
      return lock.kind === 'aborted' ? failed('tool-run', 'aborted') : busy(entry.site, lock.ahead)
    }
    // D-pacing: a turn that took a while goes in the trace, so a slow call says why it was slow.
    const waitedMs = this.clock.now() - queuedAt
    if (waitedMs >= NOTEWORTHY_WAIT_MS) {
      await this.record({
        type: 'call-waited',
        adapterId: manifest.id,
        callId: request.callId,
        reason: 'queue',
        waitedMs,
        ahead: inFront,
      })
    }
    const release = lock
    // Once the tool's own run starts, the run releases the lock, after its leftover work settles.
    let handedOn = false
    try {
      if (external?.aborted) return failed('tool-run', 'aborted')
      // Another version was swapped in while this call waited (replace): nothing was started, and
      // the call may be made again against the version now installed.
      if (this.adapters.get(manifest.id) !== entry) return busy(entry.site, 0)
      // Again, because a revocation can land while this call waits for the lock.
      if (!(await this.isApproved(entry))) return failed('manifest', 'not-granted')
      if (entry.site.breaker.isOpen()) return blocked(entry.site)
      // The site's hourly cap (D28) is asked about here and nowhere else: before the person is
      // asked anything and before anything is sent, so no call is cut off halfway by it.
      const spentForMs = entry.site.budget.spentForMs()
      if (spentForMs > 0) return { status: 'blocked', retryAfterMs: spentForMs, cause: 'hourly-cap' }
      // A setting's own tools run without the settings: the choices are how one gets its value.
      const due = internal ? [] : await this.dueSettings(entry)
      if (due === 'missing') return { status: 'needsUser', reason: 'setting-required' }
      if (due === 'unreadable') return failed('tool-run', 'internal')
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
        if (answer === 'timed-out') return { status: 'declined', timedOut: true }
        if (answer !== 'approved') return { status: 'declined' }
      }
      for (const setting of due) {
        const applied = await this.applySetting(entry, setting, external)
        if (applied.status !== 'ok') return applied
        if (external?.aborted) return failed('tool-run', 'aborted')
        if (entry.site.breaker.isOpen()) return blocked(entry.site)
      }
      handedOn = true
      return await this.guardedRun(
        entry,
        declaration,
        implementation,
        input.output,
        request.callId,
        client,
        transport,
        external,
        release,
      )
    } finally {
      if (!handedOn) release()
    }
  }

  /**
   * One run of one tool under the driver's policy for it: steps 6 to 8. `done` is called once the
   * run is over and the runtime work it started has settled (or the settle bound has passed): at
   * once when nothing is left, otherwise later, after this has returned.
   */
  private async guardedRun(
    entry: Entry,
    declaration: ToolDeclaration,
    implementation: ToolImplementation,
    input: unknown,
    callId: string,
    client: string,
    transport: ClientTransport | undefined,
    external: AbortSignal | undefined,
    done: () => void,
  ): Promise<ToolCallResult> {
    const controller = new AbortController()
    // The caller giving up stops the tool the way a timeout does.
    const stop = (): void => controller.abort()
    external?.addEventListener('abort', stop, { once: true })
    const state = new CallState(callId, controller.signal, () => entry.gate.secrets)
    // Whatever stops the call stops its login too, unless the caller was answered early and the
    // login left to finish (D50).
    controller.signal.addEventListener(
      'abort',
      () => {
        if (!state.detached) state.login.abort()
      },
      { once: true },
    )
    let running = false
    try {
      if (external?.aborted) return failed('tool-run', 'aborted')
      try {
        // Before the run begins: opening the tool page loads home under the run policy, and what
        // the driver refuses then is redacted against these.
        await this.collectSessionSecrets(entry, state)
      } catch {
        return failed('tool-run', 'internal')
      }
      try {
        entry.driver.beginRun(runPolicy(entry.definition.manifest, declaration), (b) =>
          this.onBlocked(entry, state, b),
        )
        running = true
        // Only the runtime's own confirmation unlocks; ctx.confirm() never does.
        if (declaration.sideEffect === 'irreversible') entry.driver.unlockIrreversible()
      } catch (error) {
        // Without the driver's policy in force, nothing tool code does would be held to it.
        return fromReportable(toReportable(error, 'egress'))
      }
      let result: ToolCallResult
      try {
        result = await this.run(
          entry,
          declaration,
          implementation,
          client,
          transport,
          input,
          state,
          controller,
        )
      } catch (error) {
        forget(entry)
        throw error
      }
      // Any ending but ok may mean the session isn't what it was (logged out, blocked, cut off
      // halfway through a write), so the next call starts from the site, not from memory.
      if (result.status !== 'ok') forget(entry)
      return result
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
        done()
      }
      if (state.idle) finish()
      else void this.afterSettling(state).finally(finish)
    }
  }

  /**
   * The settings whose apply tool must run before this call: `missing` when a required setting has
   * no value, `unreadable` when the values can't be read (nothing runs on a guess).
   */
  private async dueSettings(entry: Entry): Promise<DueSetting[] | 'missing' | 'unreadable'> {
    const manifest = entry.definition.manifest
    const declared = Object.entries(manifest.settings)
    if (declared.length === 0) return []
    let values: Readonly<Record<string, string>>
    try {
      values = (await this.options.settings?.values(manifest.id)) ?? {}
    } catch {
      return 'unreadable'
    }
    const due: DueSetting[] = []
    for (const [name, setting] of declared) {
      const stored = Object.hasOwn(values, name) ? values[name] : undefined
      const parsed = settingValueSchema.safeParse({ value: stored })
      if (!parsed.success) {
        if (setting.required) return 'missing'
        continue
      }
      const { value } = parsed.data
      if (setting.apply === undefined) continue
      const last = entry.applied.get(name)
      const age = last === undefined ? Number.POSITIVE_INFINITY : this.clock.now() - last.at
      if (last?.value === value && age >= 0 && age < SETTING_REAPPLY_MS) continue
      const declaration = manifest.tools.find((t) => t.name === setting.apply?.tool)
      const implementation = implementationOf(entry, setting.apply.tool)
      // parseManifest and defineAdapter both rule this out; a hand-built definition could still do it.
      if (declaration === undefined || implementation === undefined) return 'unreadable'
      due.push({ name, value, declaration, implementation })
    }
    return due
  }

  /**
   * Runs a setting's apply tool as a run of its own, with the calling tool's lock held: its own
   * call id, its own tool-called and tool-finished records, and its own run policy (the apply tool's
   * side effect, not the caller's). The caller's run starts only after this one has settled.
   */
  private async applySetting(
    entry: Entry,
    setting: DueSetting,
    external: AbortSignal | undefined,
  ): Promise<ToolCallResult> {
    const adapterId = entry.definition.manifest.id
    const callId = (this.options.newCallId ?? defaultCallId)()
    if (!CALL_ID.test(callId)) return failed('tool-run', 'internal')
    const started = this.clock.now()
    try {
      await this.options.audit.append({
        type: 'tool-called',
        adapterId,
        adapterHash: entry.bundleHash,
        tool: setting.declaration.name,
        client: SETTINGS_CLIENT,
        callId,
      })
    } catch {
      // A run we can't record doesn't run, and neither does the call that needed it.
      return failed('tool-run', 'internal')
    }
    let result: ToolCallResult
    let settled: Promise<void> = Promise.resolve()
    try {
      const input = await this.validate(setting.implementation.input, { value: setting.value }, 'tool-input')
      if (input.status !== 'ok') {
        // The adapter no longer accepts the stored value (an update changed what a value is): the
        // person chooses again.
        result = { status: 'needsUser', reason: 'setting-required' }
      } else {
        result = await new Promise<ToolCallResult>((resolve, reject) => {
          settled = new Promise<void>((over) => {
            this.guardedRun(
              entry,
              setting.declaration,
              setting.implementation,
              input.output,
              callId,
              SETTINGS_CLIENT,
              undefined,
              external,
              over,
            ).then(resolve, reject)
          })
        })
      }
    } catch (error) {
      result = fromError(error, entry.site)
    }
    // The next run's policy replaces this one's, so this one's leftover work must be over first.
    await settled
    if (result.status === 'ok') {
      entry.applied.set(setting.name, { value: setting.value, at: this.clock.now() })
      // Answers read before it (prices at another store, say) are no longer this session's.
      entry.cache.clear()
      // What an apply tool returns is nobody's to read.
      result = { status: 'ok', output: null }
    }
    await this.record(finishedEvent(adapterId, callId, result, this.clock.now() - started))
    return result
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

    const guarded = new GuardedToolPage({
      adapterId: manifest.id,
      manifest,
      sideEffect: declaration.sideEffect,
      unlocks: unlockedBy(manifest.requests, declaration.unlocks),
      inner,
      site: entry.site,
      state,
      audit: (event) => this.record(event),
      clock: this.clock,
    })
    const ctx: ToolContext = {
      // Declared reads may be answered from the session's cache; everything sent goes through the guard.
      page: new CachedToolPage({ manifest, inner: guarded, cache: entry.cache, state, clock: this.clock }),
      // Only a write may rest on a recent login check: a read's whole worth is its answer, and an
      // irreversible tool must know whose session it acts in.
      session: { ensure: () => this.ensure(entry, state, inner, declaration.sideEffect === 'write') },
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
      ...(entry.isolation?.local === undefined
        ? {}
        : { local: this.liveLocal(entry.isolation.local, manifest.id, state) }),
    }

    const isolation = entry.isolation
    const execute =
      isolation === undefined
        ? () => implementation.run(ctx, input)
        : () => runIsolated(isolation.start, isolation.script, ctx, declaration.name, input)
    // D50: a login this call starts doesn't keep the caller. If it is still running after a few
    // seconds, the caller is answered, tool code is stopped for good, and the login alone runs on
    // under the adapter's lock (see afterSettling).
    const loginOutlasted = new Promise<'logging-in'>((resolve) => {
      state.onLoginStarting = () => {
        this.sleep(this.loginAnswerMs, controller.signal).then(
          () => {
            if (state.loggingIn && !controller.signal.aborted) resolve('logging-in')
          },
          () => {},
        )
      }
    })
    const outcome = await Promise.race([
      this.race(execute, this.timeoutMs, controller.signal),
      loginOutlasted,
    ])
    if (outcome === 'logging-in') {
      // Before the abort, which would otherwise stop the login with the call.
      state.detached = true
      controller.abort()
      return { status: 'logging-in', retryAfterMs: LOGIN_RETRY_MS }
    }
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

  private async ensure(
    entry: Entry,
    state: CallState,
    page: ToolPage,
    mayTrust: boolean,
  ): Promise<EnsureResult> {
    state.assertLive()
    try {
      const result = await state.track(
        entry.gate
          .ensure({
            callId: state.callId,
            signal: state.login.signal,
            page,
            login: state.attempt,
            mayTrust,
            loginStarting: () => {
              state.loggingIn = true
              state.onLoginStarting?.()
            },
          })
          .finally(() => {
            state.loggingIn = false
          }),
      )
      // A login, or anything but ok, is a different session from the one the cache was read in.
      if (result.status !== 'ok' || state.attempt.outcome !== null) entry.cache.clear()
      // This call logged in, and the hand-off replaced the tool partition's session: what the site
      // held for the old one may be gone, so every setting is applied again before the next call.
      if (state.attempt.outcome !== null) entry.applied.clear()
      // The caller was answered while the login ran: tool code gets nothing back and does no more.
      // How the login ended is kept for the next call, which would otherwise never learn it.
      if (state.detached) {
        entry.gate.leave(result)
        throw new ValetError('tool-run', 'aborted')
      }
      state.ensureOutcome = result.status === 'ok' ? null : result
      await this.collectSessionSecrets(entry, state)
      return result
    } catch (error) {
      entry.cache.clear()
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
    if (state.detached) {
      // The login the call left running: it gets its own, longer, time, then is stopped like any
      // other leftover work.
      await this.race(() => state.settled(), this.loginTimeoutMs)
      state.login.abort()
    }
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

  /**
   * `local` for one call: each capability refused once the call is over, tracked like a capability
   * call so the call waits for it, and audited with its outcome (never its path or body).
   */
  private liveLocal(local: LocalAccess, adapterId: string, state: CallState): LocalAccess {
    const wrap =
      <A extends unknown[], R>(capability: string, fn: (...args: A) => Promise<R>) =>
      async (...args: A): Promise<R> => {
        state.assertLive()
        let errorClass: ErrorClass | null = null
        try {
          return await state.track(fn(...args))
        } catch (error) {
          errorClass = error instanceof ValetError ? error.errorClass : 'internal'
          throw error instanceof ValetError ? error : new ValetError('tool-run', 'internal')
        } finally {
          await this.record({ type: 'local-access', adapterId, callId: state.callId, capability, errorClass })
        }
      }
    const files = local.files
    return {
      files: {
        list: wrap('files.list', (d) => files.list(d)),
        stat: wrap('files.stat', (p) => files.stat(p)),
        read: wrap('files.read', (p, o) => files.read(p, o)),
        write: wrap('files.write', (p, c, o) => files.write(p, c, o)),
        mkdir: wrap('files.mkdir', (d) => files.mkdir(d)),
      },
      fetch: wrap('fetch', (u, i) => local.fetch(u, i)),
      service: wrap('service', (port, p, i) => local.service(port, p, i)),
      run: wrap('run', (a, o) => local.run(a, o)),
      appleScript: wrap('appleScript', (id, source) => local.appleScript(id, source)),
    }
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

function settingOf(manifest: AdapterManifest, name: string): SettingDeclaration | undefined {
  return Object.hasOwn(manifest.settings, name) ? manifest.settings[name] : undefined
}

function defaultCallId(): string {
  return `st_${randomUUID()}`
}

/** Drops what is remembered about an adapter's session: its cached reads and its last login check. */
function forget(entry: Entry): void {
  entry.cache.clear()
  entry.gate.distrust()
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

function failed(
  stage: Stage,
  errorClass: ErrorClass,
): Extract<ToolCallResult, { readonly status: 'failed' }> {
  return { status: 'failed', stage, errorClass }
}

function blocked(site: SiteGuards): ToolCallResult {
  return { status: 'blocked', retryAfterMs: site.breaker.retryAfterMs() }
}

/** Input checks one adapter may have running at once; a call past that is told to retry. */
export const MAX_INPUT_CHECKS = 4

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
      // In the log `blocked` means the site refused us. Our own hourly cap is not that.
      if (result.cause === 'hourly-cap')
        return { ...base, outcome: 'failed', stage: 'tool-run', errorClass: 'rate-limited' }
      return { ...base, outcome: 'blocked' }
    case 'busy':
      // Not the site refusing us, which is what `blocked` means in the log: our own queue was full.
      return { ...base, outcome: 'failed', stage: 'tool-run', errorClass: 'busy' }
    case 'logging-in':
      return { ...base, outcome: 'failed', stage: 'login', errorClass: 'login-in-progress' }
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
