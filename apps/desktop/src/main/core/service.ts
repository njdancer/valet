// The main process's state and the API behind every IPC channel: the one place that wires the
// runtime, the auth flow, the credentials, the drivers and the MCP endpoint together. Electron
// reaches it only through the injected ports (driver factory, endpoint, UI), so all of it runs and is
// tested in plain Node.

import { randomBytes } from 'node:crypto'
import { copyFile, mkdir, rm } from 'node:fs/promises'
import {
  type AdapterManifest,
  type AuditEvent,
  type AuditRecord,
  type AuditSink,
  type BlockedRequest,
  CredentialError,
  type Grant,
  MESSAGES_SECRET,
  type NeedsUserReason,
  type ProviderKind,
  type SecretField,
  type SessionDriver,
  type SettingChoice,
  ValetError,
} from '@valet/core'
import { FileGrantStore } from '@valet/credentials'
import {
  type EndpointClient,
  identityLabel,
  type LiveSessions,
  type SessionReportingEndpoint,
  type ToolCall,
  type ToolCaller,
} from '@valet/mcp-server'
import {
  ApprovalStore,
  AuditLog,
  JsonFileStore,
  LoginAttemptMarker,
  pruneOlderThan,
  type RuntimeDiagnostic,
  type Sleep,
  ToolHost,
  type ToolProcessFactory,
} from '@valet/runtime'
import { z } from 'zod'
import type {
  AppEvent,
  AttentionItem,
  ChainStatus,
  ClientInfo,
  ClientSnippet,
  EndpointStatus,
  HashRoute,
  SettingChoicesReply,
  Settings,
  UpdateStatus,
} from '../../shared/api'
import { AdapterSettingsStore } from './adapter-settings'
import {
  type AdapterLookup,
  AuditReader,
  auditPage,
  callCounts,
  runSummaries,
  runTrace,
  statsToday,
} from './audit-view'
import { BlockedAudit, LoginSecrets } from './blocked'
import { type AppRefusal, RuntimeToolCaller } from './caller'
import { ClientRegistry, shownTransport } from './clients'
import { ConfirmationBroker, type Timers } from './confirmations'
import {
  AUTH_FLOW_TIMEOUT_MS,
  CONFIRMATION_TIMEOUT_MS,
  type DataPaths,
  HANDOFF_WINDOW_MS,
  LOGIN_WAIT_MS,
  MCP_SERVER_NAME,
  TYPING_DELAY_MS,
} from './constants'
import type { Credentials } from './credentials'
import { ensurePrivateDir, JsonDocument } from './files'
import { checkGrantRequest, grantInfo } from './grants'
import type { AppWindow, MainApi } from './ipc'
import { createAuthRunner, Handoffs, isBlockedPage, SessionTracker } from './login'
import { type ApprovedSnapshot, type BuiltinAdapter, SnapshotStore } from './registry'
import { RemoteAccess } from './remote'
import { RunMemory } from './run-memory'
import { DEFAULT_SETTINGS, SettingsStore } from './settings'
import { SetupStore } from './setup'
import { type BridgeCommand, clientSnippets, snippetFor } from './snippets'
import { disabledUpdates, type UpdatesHooks, type UpdatesPort, VersionStore } from './updates'
import {
  type AdapterState,
  adapterDetail,
  adapterSummary,
  pendingReview,
  reviewItem,
  siteHealth,
} from './views'

/** What the service asks of the app's windows and the OS. */
export interface UiPort {
  writeClipboard(text: string): void
  /** A native save dialog. Null when cancelled. */
  chooseSaveFile(defaultName: string): Promise<string | null>
  /** A native open dialog for the 1Password CLI. Null when cancelled. */
  chooseOpFile(): Promise<string | null>
  openControlPanel(route: HashRoute | null): void
  showConfirmation(id: string): void
  closeConfirmation(id: string): void
  showNeedsUser(adapterId: string): void
  closeNeedsUser(adapterId: string): void
  setLaunchAtLogin(enabled: boolean): void
  quit(): void
}

export interface ServiceDeps {
  readonly paths: DataPaths
  readonly version: string
  readonly demo: boolean
  readonly now: () => number
  readonly timers: Timers
  readonly sleep: (ms: number) => Promise<void>
  readonly adapters: readonly BuiltinAdapter[]
  /**
   * Starts a tool process for one call. With it, an adapter that has a tool script runs its tool
   * code there; without it (unit tests), in this process.
   */
  readonly toolProcess?: ToolProcessFactory
  /** Builds an adapter's driver, with the reporters its refusals outside a run go to. */
  readonly createDriver: (manifest: AdapterManifest, reporters: DriverReporters) => Promise<SessionDriver>
  readonly credentials: Credentials
  /**
   * Starts the MCP endpoint with a token for each of `clients`, written to its config file; it
   * reports its live sessions to `onSessionsChanged`.
   */
  readonly startEndpoint: (
    caller: ToolCaller,
    clients: readonly EndpointClient[],
    onSessionsChanged: (sessions: LiveSessions) => void,
  ) => Promise<SessionReportingEndpoint>
  readonly ui: UiPort
  readonly emit: (event: AppEvent) => void
  /** The stdio bridge's command line for a client's config file, for snippets; null when it can't be launched. */
  readonly bridge: ((configPath: string) => BridgeCommand) | null
  /** Checks a chosen op binary (checkOpBinary); the resolved path, or null to refuse it. */
  readonly checkOp: (path: string) => Promise<string | null>
  /**
   * Builds the updates for this launch: an updater (electron/app.ts, createUpdater) when the build
   * may update itself, otherwise one that says why not (disabledUpdates).
   */
  readonly updates: (hooks: UpdatesHooks) => Promise<UpdatesPort>
  readonly diagnostics?: (
    diagnostic: RuntimeDiagnostic | { readonly type: string; readonly adapterId?: string },
  ) => void
  readonly newId?: () => string
  /** How the runtime waits for a site's rate budget; real time by default. Tests pass their clock's. */
  readonly pacingSleep?: Sleep
}

/** Where a driver reports refusals outside the runtime's runs (browser-electron's DriverOptions). */
export interface DriverReporters {
  /** The tool partition's refusals between runs. */
  readonly onBlocked: (blocked: BlockedRequest) => void
  /** The auth partition's refusals that no open login page took. */
  readonly onAuthBlocked: (blocked: BlockedRequest) => void
  readonly onAuthReportsDropped: () => void
}

/** Wraps the audit log so every record also tells the windows what changed. */
class ObservedAudit implements AuditSink {
  constructor(
    private readonly inner: AuditSink,
    private readonly observe: (record: AuditRecord) => void,
  ) {}

  async append(event: AuditEvent): Promise<AuditRecord> {
    const record = await this.inner.append(event)
    this.observe(record)
    return record
  }
}

const EVENTS_FOR: Readonly<Partial<Record<AuditEvent['type'], readonly AppEvent['type'][]>>> = {
  'adapter-approved': ['approvals-changed', 'adapters-changed', 'attention-changed'],
  'adapter-rejected': ['approvals-changed', 'adapters-changed', 'attention-changed'],
  'grant-made': ['grants-changed', 'adapters-changed'],
  'grant-revoked': ['grants-changed', 'adapters-changed'],
  'grant-copied': ['grants-changed'],
  'tool-called': ['runs-changed', 'clients-changed'],
  'tool-finished': ['runs-changed', 'adapters-changed'],
  'login-started': ['runs-changed', 'adapters-changed'],
  'login-finished': ['runs-changed', 'adapters-changed'],
  'secret-used': ['runs-changed', 'grants-changed'],
  'request-blocked': ['runs-changed'],
  'breaker-opened': ['health-changed'],
  'breaker-closed': ['health-changed'],
  confirmation: ['runs-changed'],
  'setting-changed': ['adapters-changed'],
}

/**
 * The runtime's needs-person reasons (packages/runtime session.ts): a hold for one of these waits for
 * the person whatever they grant, since another automatic login could only make it worse.
 */
const HOLDS_A_GRANT_CANNOT_FIX: ReadonlySet<NeedsUserReason> = new Set<NeedsUserReason>([
  'account-locked',
  'captcha',
  'terms-update',
  'site-changed',
])

/** How often a running app prunes expired traces (D27). */
const PRUNE_EVERY_MS = 60 * 60_000

const titlesSchema = z.record(z.string().max(512), z.string().max(200))

export class AppService {
  readonly api: MainApi
  private readonly audit: ObservedAudit
  private readonly approvals: ApprovalStore
  private readonly grants: FileGrantStore
  private readonly markers: LoginAttemptMarker
  private readonly settings: SettingsStore
  private readonly adapterSettings: AdapterSettingsStore
  /**
   * The choices the last search returned for each `adapter/setting`: the only values setSetting
   * takes, so what is stored is always something the adapter offered and the person was shown.
   */
  private readonly offered = new Map<string, readonly SettingChoice[]>()
  private readonly newId: () => string
  /** The settings as last read or written: the updater reads them synchronously at every check. */
  private settingsNow: Settings = DEFAULT_SETTINGS
  private readonly versions: VersionStore
  private readonly setup: SetupStore
  private updates: UpdatesPort | null = null
  /** Audit writes nothing awaits (an update downloaded); stop() waits for them. */
  private background: Promise<unknown> = Promise.resolve()
  private pruneTimer: ReturnType<typeof setInterval> | null = null
  private readonly snapshots: SnapshotStore
  private readonly clients: ClientRegistry
  private readonly titles: JsonDocument<Record<string, string>>
  private readonly reader: AuditReader
  private readonly memory = new RunMemory()
  private readonly sessions: SessionTracker
  private readonly broker: ConfirmationBroker
  private readonly handoffs: Handoffs
  private readonly drivers = new Map<string, SessionDriver>()
  /** The runtime, from start() on. */
  private host: ToolHost | null = null
  private readonly loginSecrets = new LoginSecrets()
  private readonly blocked: BlockedAudit
  /** When each installed hash was approved, for the confirmation panel (which reads synchronously). */
  private readonly approvedAt = new Map<string, string>()
  private caller: RuntimeToolCaller | null = null
  private endpoint: SessionReportingEndpoint | null = null
  /** The remote listener, its policy and the kill switch (relay.md). Off unless the person turns it on. */
  readonly remote: RemoteAccess
  private paused = false
  private chain: ChainStatus = { state: 'unverified' }
  private readonly startedAt: string

  constructor(private readonly deps: ServiceDeps) {
    const { paths } = deps
    const clock = { now: deps.now }
    const date = () => new Date(deps.now())
    this.startedAt = date().toISOString()
    this.audit = new ObservedAudit(new AuditLog(paths.audit, clock), (record) => this.observe(record))
    this.approvals = new ApprovalStore(paths.approvals, this.audit)
    this.grants = new FileGrantStore({ path: paths.grants })
    this.markers = new LoginAttemptMarker(paths.loginMarkers, clock)
    this.settings = new SettingsStore(paths.settings)
    this.adapterSettings = new AdapterSettingsStore(paths.adapterSettings)
    this.versions = new VersionStore(paths.versions)
    this.setup = new SetupStore(paths.setup, deps.now)
    this.snapshots = new SnapshotStore(paths.manifests)
    this.clients = new ClientRegistry(paths.clients, paths.clientConfigs, date)
    this.titles = new JsonDocument(paths.grantItems, titlesSchema, () => ({}), true)
    this.reader = new AuditReader(paths.audit)
    this.blocked = new BlockedAudit({
      audit: this.audit,
      secrets: this.loginSecrets,
      adapter: (adapterId) => {
        const adapter = this.adapter(adapterId)
        const driver = this.drivers.get(adapterId)
        if (adapter === null || driver === undefined) return null
        const { session } = adapter.definition.manifest
        return {
          manifest: adapter.definition.manifest,
          sessionValues: () => driver.sessionSecrets(session.cookieDomains, session.storage),
        }
      },
      now: deps.now,
      diagnostics: (d) => deps.diagnostics?.(d),
    })
    this.sessions = new SessionTracker(date, () => this.emit('adapters-changed'))
    const newId = deps.newId ?? (() => randomBytes(12).toString('hex'))
    this.newId = newId
    this.broker = new ConfirmationBroker({
      adapter: (adapterId) => {
        const adapter = this.adapter(adapterId)
        return adapter === null
          ? null
          : {
              manifest: adapter.definition.manifest,
              hash: adapter.hash,
              approvedAt: this.approvedAt.get(`${adapterId}:${adapter.hash}`) ?? null,
            }
      },
      call: (callId) => {
        const run = this.memory.get(callId)
        return run === undefined ? null : { input: run.input }
      },
      show: (id) => deps.ui.showConfirmation(id),
      close: (id) => deps.ui.closeConfirmation(id),
      onChange: () => this.emit('attention-changed'),
      now: deps.now,
      timeoutMs: CONFIRMATION_TIMEOUT_MS,
      timers: deps.timers,
      newId: () => `cf_${newId()}`,
    })
    this.handoffs = new Handoffs({
      now: deps.now,
      timers: deps.timers,
      windowMs: HANDOFF_WINDOW_MS,
      showBanner: (adapterId) => deps.ui.showNeedsUser(adapterId),
      closeBanner: (adapterId) => deps.ui.closeNeedsUser(adapterId),
      markers: this.markers,
      sessions: this.sessions,
      onChange: () => {
        this.emit('attention-changed')
        this.emit('adapters-changed')
      },
    })
    this.remote = new RemoteAccess({
      path: paths.remote,
      info: { name: 'valet', version: deps.version },
      now: deps.now,
      changed: () => this.emit('app-changed'),
      audit: async (event) => {
        await this.audit.append(event)
      },
      // Audited like the app's own refusals: stage config, which the runtime never reports.
      refused: (call, reason) =>
        this.auditRefusal(call, {
          status: 'failed',
          stage: 'config',
          errorClass: reason === 'over-cap' ? 'rate-limited' : 'not-found',
        }),
    })
    this.api = this.buildApi()
  }

  /** Opens the stores, builds a driver per adapter, registers them, and starts the endpoint. */
  async start(): Promise<void> {
    const { paths } = this.deps
    await ensurePrivateDir(paths.dir)
    await mkdir(paths.loginMarkers, { recursive: true, mode: 0o700 })
    await mkdir(paths.clientConfigs, { recursive: true, mode: 0o700 })
    await mkdir(paths.traces, { recursive: true, mode: 0o700 })
    // Before per-client tokens, every client shared one token in this file. Nothing reads it now,
    // and a token left lying there would be one more copy to leak.
    await rm(paths.legacyBridgeConfig, { force: true }).catch(() => undefined)
    this.settingsNow = await this.settings.get()
    await this.pruneTraces()
    // A long-running app still drops a trace on the day it expires, not at the next start.
    this.pruneTimer = setInterval(() => {
      this.background = this.background.then(() => this.pruneTraces())
    }, PRUNE_EVERY_MS)
    this.pruneTimer.unref?.()
    // Updates first, before any adapter, credential or endpoint: a release that fails further on can
    // still be replaced by the next one.
    await this.startUpdates()
    await this.deps.credentials.configure(this.settingsNow)
    await this.clients.load()
    const host = new ToolHost({
      approvals: this.approvals,
      audit: this.audit,
      prompt: this.broker,
      authRunner: createAuthRunner({
        grants: this.grants,
        credentials: this.deps.credentials,
        audit: this.audit,
        clock: () => new Date(this.deps.now()),
        sleep: this.deps.sleep,
        typingDelayMs: TYPING_DELAY_MS,
        flowTimeoutMs: AUTH_FLOW_TIMEOUT_MS,
        sessions: this.sessions,
        handoffs: this.handoffs,
        blocked: this.blocked,
        secrets: this.loginSecrets,
        callInfo: (callId) => {
          const run = callId === null ? undefined : this.memory.get(callId)
          return { tool: run?.tool ?? null, client: run?.client ?? null }
        },
        filledFor: (adapterId, callId, since) => this.filledFor(adapterId, callId, since),
      }),
      markers: this.markers,
      breakerStore: new JsonFileStore(paths.breakers),
      settings: this.adapterSettings,
      clock: { now: this.deps.now },
      ...(this.deps.pacingSleep === undefined ? {} : { pacingSleep: this.deps.pacingSleep }),
      confirmationTimeoutMs: CONFIRMATION_TIMEOUT_MS,
      diagnostics: (d) => this.deps.diagnostics?.(d),
    })
    this.host = host
    for (const adapter of this.deps.adapters) {
      const id = adapter.definition.manifest.id
      const driver = await this.deps.createDriver(adapter.definition.manifest, {
        onBlocked: this.blocked.betweenRuns(id),
        onAuthBlocked: this.blocked.authPartition(id),
        onAuthReportsDropped: () => this.deps.diagnostics?.({ type: 'auth-reports-dropped', adapterId: id }),
      })
      this.drivers.set(id, driver)
      const start = this.deps.toolProcess
      host.register({
        definition: adapter.definition,
        bundleHash: adapter.hash,
        driver,
        ...(start === undefined || adapter.toolScript === null
          ? {}
          : { isolation: { script: adapter.toolScript, start } }),
      })
    }
    this.caller = new RuntimeToolCaller(host, {
      paused: () => this.paused,
      started: (call) => {
        this.memory.started(call.callId, call.tool, call.client, call.input)
        // The token named the client; the transport is the endpoint's label for the session.
        const id = call.identity?.origin === 'local' ? call.identity.clientId : null
        if (id !== null && this.clients.seen(id, call.client, shownTransport(call.transport)))
          this.emit('clients-changed')
      },
      finished: (call, result) =>
        this.memory.finished(call.callId, result.status === 'ok' ? result.output : undefined),
      refused: (call, refusal) => this.auditRefusal(call, refusal),
    })
    await this.caller.refresh()
    // Reads approval times into the cache the confirmation panel uses.
    await this.states()
    await this.startListening().catch(() => undefined)
    // The same caller: remote calls go through the same pause, runtime and audit as local ones.
    await this.remote.start(this.caller).catch(() => undefined)
  }

  /**
   * Turns one of an installed adapter's tools on or off for remote clients. Throws
   * ValetError('config', 'not-found') for a tool the adapter doesn't declare.
   */
  async setRemoteTool(adapterId: string, tool: string, enabled: boolean): Promise<void> {
    const declaration = this.adapter(adapterId)?.definition.manifest.tools.find((t) => t.name === tool)
    if (declaration === undefined) throw new ValetError('config', 'not-found')
    await this.remote.setTool(adapterId, declaration, enabled)
  }

  async stop(): Promise<void> {
    this.updates?.stop()
    if (this.pruneTimer !== null) clearInterval(this.pruneTimer)
    this.pruneTimer = null
    // Calls still running are cancelled: each ends failed tool-run/aborted, its prompt declined.
    this.caller?.cancelAll()
    this.broker.declineAll()
    this.handoffs.closeAll()
    await this.remote.close().catch(() => undefined)
    await this.endpoint?.close().catch(() => undefined)
    this.endpoint = null
    for (const driver of this.drivers.values()) await driver.close().catch(() => undefined)
    await this.blocked.settled()
    await this.background
    this.loginSecrets.dispose()
  }

  /** For the Electron glue: the confirmation window was shown or focused. */
  confirmationArmed(id: string): void {
    this.broker.armed(id)
  }

  /** Whether a confirmation is still waiting (the glue closes windows for ones that aren't). */
  confirmationPending(id: string): boolean {
    return this.broker.has(id)
  }

  hasHandoff(adapterId: string): boolean {
    return this.handoffs.has(adapterId)
  }

  // ---------- Internals ----------

  /**
   * Records this launch's version (an update-installed event on the first launch of a newer one)
   * and builds the updates, which audit each verified download as update-downloaded.
   */
  private async startUpdates(): Promise<void> {
    const { version } = this.deps
    const launch = await this.versions
      .recordLaunch(version)
      .catch(() => ({ highestRun: version, updatedFrom: null }))
    if (launch.updatedFrom !== null) {
      await this.audit
        .append({ type: 'update-installed', from: launch.updatedFrom, to: version })
        .catch(() => this.deps.diagnostics?.({ type: 'audit-write-failed' }))
    }
    try {
      this.updates = await this.deps.updates({
        channel: () => this.settingsNow.updateChannel,
        autoInstallOnQuit: () => this.settingsNow.autoInstallUpdates,
        highestVersionRun: () => launch.highestRun,
        whenIdle: () => this.whenIdle(),
        downloaded: (from, to) => {
          const write = this.audit
            .append({ type: 'update-downloaded', from, to })
            .then(() => undefined)
            .catch(() => this.deps.diagnostics?.({ type: 'audit-write-failed' }))
          this.background = this.background.then(() => write)
        },
        changed: () => this.emit('app-changed'),
      })
    } catch {
      // An updater that can't be built (a feed or key the controller refuses) checks nothing.
      this.updates = disabledUpdates(version, 'not-configured', false)
    }
    this.updates.start()
  }

  /**
   * Resolves once no adapter has a call in flight or a run open: an empty login step takes each
   * adapter's lock in turn behind them (waiting up to LOGIN_WAIT_MS), as a hand-off would. It takes a
   * slot of each site's rate budget, which only delays the next request. An unapproved adapter runs
   * no call, and a site whose breaker is open was refused only once the lock was held, so both count
   * as idle. Rejects (and the install waits) when an adapter stays busy.
   */
  private async whenIdle(): Promise<void> {
    const host = this.host
    if (host === null) return
    await Promise.all(
      this.deps.adapters.map(async (a) => {
        try {
          await host.runLoginStep(a.definition.manifest.id, async () => {}, { waitMs: LOGIN_WAIT_MS })
        } catch (error) {
          const idle =
            error instanceof ValetError &&
            (error.errorClass === 'not-granted' || error.errorClass === 'rate-limited')
          if (!idle) throw error
        }
      }),
    )
  }

  private runtime(): ToolHost {
    if (this.host === null) throw new ValetError('config', 'unavailable')
    return this.host
  }

  private emit(type: Exclude<AppEvent['type'], 'audit-appended'>): void {
    this.deps.emit({ type })
  }

  private observe(record: AuditRecord): void {
    this.deps.emit({ type: 'audit-appended', seq: record.seq })
    for (const type of EVENTS_FOR[record.event.type] ?? [])
      this.emit(type as Exclude<AppEvent['type'], 'audit-appended'>)
  }

  private adapter(adapterId: string): BuiltinAdapter | null {
    return this.deps.adapters.find((a) => a.definition.manifest.id === adapterId) ?? null
  }

  private requireAdapter(adapterId: string): BuiltinAdapter {
    const adapter = this.adapter(adapterId)
    if (adapter === null) throw new ValetError('manifest', 'not-found')
    return adapter
  }

  private lookup(): AdapterLookup {
    return {
      name: (id) => this.adapter(id)?.definition.manifest.name ?? id,
      sideEffect: (id, tool) =>
        this.adapter(id)?.definition.manifest.tools.find((t) => t.name === tool)?.sideEffect ?? 'read',
      fillSelector: (id, secret, field) => {
        const steps = this.adapter(id)?.definition.manifest.auth.steps ?? []
        return fillSelector(steps, secret, field)
      },
    }
  }

  private async state(
    adapter: BuiltinAdapter,
    records: readonly AuditRecord[],
    grants: readonly Grant[],
  ): Promise<AdapterState> {
    const manifest = adapter.definition.manifest
    const approved = await this.approvals.isApproved(manifest.id, adapter.hash)
    const snapshot: ApprovedSnapshot | null = await this.snapshots.get(manifest.id)
    const decisions = records.filter(
      (r) =>
        (r.event.type === 'adapter-approved' || r.event.type === 'adapter-rejected') &&
        r.event.adapterId === manifest.id &&
        r.event.adapterHash === adapter.hash,
    )
    const last = decisions.at(-1)
    const approvedRecord = [...decisions].reverse().find((r) => r.event.type === 'adapter-approved')
    const approvedAt = approved
      ? snapshot?.hash === adapter.hash
        ? snapshot.approvedAt
        : (approvedRecord?.at ?? null)
      : null
    const key = `${manifest.id}:${adapter.hash}`
    if (approvedAt === null) this.approvedAt.delete(key)
    else this.approvedAt.set(key, approvedAt)
    return {
      adapter,
      approved,
      approvedAt,
      rejected: !approved && last?.event.type === 'adapter-rejected',
      previous: snapshot !== null && snapshot.hash !== adapter.hash ? snapshot : null,
      grants,
      titles: await this.titles.read(),
      session: this.sessions.get(manifest.id),
      calls: callCounts(records, new Date(this.deps.now())),
      lastUsed: (grant) => lastUsed(records, grant),
      handedOver: null,
      chosen: await this.adapterSettings.chosen(manifest.id),
    }
  }

  private async states(): Promise<AdapterState[]> {
    const records = await this.reader.records()
    const grants = await this.grants.list().catch(() => [] as readonly Grant[])
    return Promise.all(this.deps.adapters.map((a) => this.state(a, records, grants)))
  }

  /**
   * A call the app refused before the runtime saw it, audited the way the runtime audits one: the
   * client's name made printable, an undeclared tool as "(invalid)". A call id the runtime wouldn't
   * accept, or an adapter that isn't installed, has nothing to attribute it to and isn't recorded.
   */
  private async auditRefusal(call: ToolCall, refusal: AppRefusal): Promise<void> {
    const adapter = this.adapter(call.adapterId)
    if (adapter === null || !CALL_ID.test(call.callId)) return
    const manifest = adapter.definition.manifest
    await this.audit.append({
      type: 'tool-called',
      adapterId: manifest.id,
      adapterHash: adapter.hash,
      tool: manifest.tools.some((t) => t.name === call.tool) ? call.tool : '(invalid)',
      client: printableClient(call.client),
      ...(call.identity === undefined ? {} : { clientId: identityLabel(call.identity) }),
      callId: call.callId,
    })
    await this.audit.append({
      type: 'tool-finished',
      adapterId: manifest.id,
      callId: call.callId,
      outcome: 'failed',
      stage: refusal.stage,
      errorClass: refusal.errorClass,
      durationMs: 0,
    })
  }

  /**
   * A new grant is the person acting on a login that couldn't fill (not-granted) or was refused
   * (auth-failed): the runtime's hold on automatic logins exists to wait for exactly that. Without
   * this, the next call after granting was told the person had been asked to act, when nothing was
   * asking them (the e2e suite found it). Holds a grant can't fix stay: a locked account, a CAPTCHA,
   * new terms or a changed site, and an attempt that never finished (in progress). So does any hold
   * while the person has the login window open, which they finish or give up themselves.
   */
  private async releaseLoginHold(adapterId: string): Promise<void> {
    if (this.handoffs.has(adapterId)) return
    const marker = await this.markers.read(adapterId).catch(() => null)
    if (marker?.kind !== 'held') return
    if (marker.reason !== undefined && HOLDS_A_GRANT_CANNOT_FIX.has(marker.reason)) return
    await this.markers.clear(adapterId)
    if (this.sessions.get(adapterId).state === 'needs-user') this.sessions.set(adapterId, 'expired')
  }

  private async filledFor(
    adapterId: string,
    callId: string | null,
    since: Date,
  ): Promise<{ filled: { secret: string; field: SecretField }[]; origin: string | null }> {
    try {
      const records = await this.reader.records()
      const used = records.filter(
        (r) =>
          r.event.type === 'secret-used' &&
          r.event.adapterId === adapterId &&
          r.event.callId === callId &&
          Date.parse(r.at) >= since.getTime(),
      )
      const filled: { secret: string; field: SecretField }[] = []
      let origin: string | null = null
      for (const record of used) {
        if (record.event.type !== 'secret-used') continue
        const field = record.event.field
        if (field === 'username' || field === 'password' || field === 'otp')
          filled.push({ secret: record.event.secret, field })
        origin = record.event.origin
      }
      return { filled, origin }
    } catch {
      return { filled: [], origin: null }
    }
  }

  /** Refuses a setting the installed adapter doesn't declare, as ValetError('manifest', 'not-found'). */
  private requireSetting(adapterId: string, setting: string): void {
    const { settings } = this.requireAdapter(adapterId).definition.manifest
    if (!Object.hasOwn(settings, setting)) throw new ValetError('manifest', 'not-found')
  }

  /**
   * One search for a setting's choices: the runtime runs the adapter's lookup as it runs any tool
   * (approved adapters only, paced, audited), and what comes back is remembered as what the person
   * was offered. A failure reaches the renderer as one of a few fixed answers, never as text.
   */
  private async settingChoices(adapterId: string, setting: string, query: string): Promise<SettingChoicesReply> {
    this.requireSetting(adapterId, setting)
    const result = await this.runtime().settingChoices({
      adapterId,
      setting,
      query,
      callId: `st_${this.newId()}`,
    })
    switch (result.status) {
      case 'ok':
        this.offered.set(`${adapterId}/${setting}`, result.choices)
        return {
          status: 'ok',
          choices: result.choices.map((c) => ({ id: c.value, label: c.label, detail: c.detail ?? null })),
        }
      case 'blocked':
        return { status: 'blocked', retryAt: new Date(this.deps.now() + result.retryAfterMs).toISOString() }
      case 'failed':
        if (result.errorClass === 'not-granted') return { status: 'not-approved' }
        if (result.errorClass === 'site-changed') return { status: 'site-changed' }
        return { status: 'failed' }
      default:
        return { status: 'failed' }
    }
  }

  private async setSetting(adapterId: string, setting: string, value: string): Promise<void> {
    this.requireSetting(adapterId, setting)
    const choice = this.offered.get(`${adapterId}/${setting}`)?.find((c) => c.value === value)
    if (choice === undefined) throw new ValetError('config', 'invalid')
    // Audited first: a choice that can't be recorded isn't made.
    await this.audit.append({ type: 'setting-changed', adapterId, setting, cleared: false })
    await this.adapterSettings.set(adapterId, setting, choice, new Date(this.deps.now()).toISOString())
    this.emit('adapters-changed')
  }

  private async clearSetting(adapterId: string, setting: string): Promise<void> {
    this.requireSetting(adapterId, setting)
    await this.audit.append({ type: 'setting-changed', adapterId, setting, cleared: true })
    await this.adapterSettings.clear(adapterId, setting)
    this.emit('adapters-changed')
  }

  private async refreshTools(): Promise<void> {
    await this.caller?.refresh()
    try {
      this.endpoint?.refresh()
    } catch {
      // The runtime couldn't list; every session keeps what it had.
    }
    this.remote.refresh()
  }

  private async startListening(): Promise<void> {
    if (this.endpoint !== null || this.caller === null) return
    this.endpoint = await this.deps.startEndpoint(this.caller, this.clients.active(), () =>
      this.emit('endpoint-changed'),
    )
    this.endpoint.refresh()
    this.emit('endpoint-changed')
  }

  /** Snippets that launch the bridge with this client's own config file. */
  private snippets(clientId: string): ClientSnippet[] {
    if (this.deps.bridge === null || !this.clients.isActive(clientId)) return []
    const name = this.deps.demo ? `${MCP_SERVER_NAME}-demo` : MCP_SERVER_NAME
    return clientSnippets(name, this.deps.bridge(this.clients.configPath(clientId)))
  }

  /** The client as the screens show it, with its calls over the last seven days. */
  private async clientInfos(): Promise<ClientInfo[]> {
    const records = await this.reader.records()
    const since = this.deps.now() - 7 * 24 * 60 * 60_000
    const counts = new Map<string, number>()
    for (const r of records) {
      if (r.event.type !== 'tool-called' || r.event.clientId === undefined || Date.parse(r.at) < since)
        continue
      counts.set(r.event.clientId, (counts.get(r.event.clientId) ?? 0) + 1)
    }
    return this.clients.list((id) => counts.get(`local:${id}`) ?? 0)
  }

  /** Copies a keychain-copy grant's fields from 1Password, audited, as ValetError on failure. */
  private async copyGrantItem(grant: Grant, manifest: AdapterManifest): Promise<void> {
    const fields = manifest.secrets[grant.secret]?.fields ?? []
    try {
      await this.deps.credentials.copyItem(grant.itemRef, fields)
    } catch (error) {
      const failure = error instanceof CredentialError ? error.failure : 'unavailable'
      throw new ValetError('credential', failure)
    }
    await this.audit.append({
      type: 'grant-copied',
      adapterId: grant.adapterId,
      secret: grant.secret,
      fields: [...fields],
    })
  }

  private async available(): Promise<Set<ProviderKind>> {
    const status = await this.deps.credentials.status()
    return new Set(status.filter((s) => s.available).map((s) => s.kind))
  }

  /** Removes traces and screenshots older than the retention setting (D27). Never fails a caller. */
  private async pruneTraces(): Promise<void> {
    await pruneOlderThan(this.deps.paths.traces, this.settingsNow.traceRetentionDays, this.deps.now()).catch(
      () => undefined,
    )
  }

  private async afterSettings(settings: Settings): Promise<Settings> {
    const shorter = settings.traceRetentionDays < this.settingsNow.traceRetentionDays
    this.settingsNow = settings
    if (shorter) await this.pruneTraces()
    await this.deps.credentials.configure(settings)
    this.emit('settings-changed')
    this.emit('grants-changed')
    return settings
  }

  private buildApi(): MainApi {
    const deps = this.deps
    return {
      adapters: {
        list: async () => (await this.states()).map(adapterSummary),
        get: async (adapterId) => {
          const state = (await this.states()).find((s) => s.adapter.definition.manifest.id === adapterId)
          return state === undefined ? null : adapterDetail(state)
        },
        settingChoices: (adapterId, setting, query) => this.settingChoices(adapterId, setting, query),
        setSetting: (adapterId, setting, value) => this.setSetting(adapterId, setting, value),
        clearSetting: (adapterId, setting) => this.clearSetting(adapterId, setting),
      },
      approvals: {
        pending: async () =>
          (await this.states()).flatMap((s) => {
            const review = pendingReview(s, this.startedAt)
            return review === null ? [] : [review]
          }),
        approve: async (adapterId, hash) => {
          const adapter = this.requireAdapter(adapterId)
          // Only the bundle installed and waiting now; a stale review's hash is refused.
          if (adapter.hash !== hash) throw new ValetError('manifest', 'invalid')
          await this.approvals.approve(adapterId, hash, adapter.definition.manifest.version)
          const at = new Date(deps.now()).toISOString()
          await this.snapshots.put(adapterId, adapter, at)
          this.approvedAt.set(`${adapterId}:${hash}`, at)
          await this.refreshTools()
        },
        reject: async (adapterId, hash) => {
          const adapter = this.requireAdapter(adapterId)
          if (adapter.hash !== hash) throw new ValetError('manifest', 'invalid')
          await this.approvals.reject(adapterId, hash, adapter.definition.manifest.version)
          await this.refreshTools()
        },
      },
      grants: {
        list: async () => {
          const records = await this.reader.records()
          const titles = await this.titles.read()
          return (await this.grants.list()).map((g) => grantInfo(g, titles, lastUsed(records, g)))
        },
        providers: async () => {
          const grants = await this.grants.list().catch(() => [] as readonly Grant[])
          // Only grants for an adapter's installed hash, while that hash is approved: a grant for an
          // older bundle (or one waiting for review) can't be used, so it isn't counted as live.
          const live = new Set<string>()
          for (const adapter of deps.adapters) {
            const id = adapter.definition.manifest.id
            if (await this.approvals.isApproved(id, adapter.hash).catch(() => false))
              live.add(`${id}:${adapter.hash}`)
          }
          return (await deps.credentials.status()).map((s) => ({
            ...s,
            grantCount: grants.filter(
              (g) => g.provider === s.kind && live.has(`${g.adapterId}:${g.adapterHash}`),
            ).length,
          }))
        },
        vaultItems: (provider) => deps.credentials.vaultItems(provider),
        make: async (request) => {
          const adapter = this.requireAdapter(request.adapterId)
          const checked = await checkGrantRequest(request, {
            manifest: adapter.definition.manifest,
            installedHash: adapter.hash,
            available: await this.available(),
            vaultItems: (provider) => deps.credentials.vaultItems(provider),
            now: () => new Date(deps.now()),
          })
          const { grant } = checked
          // D6: a Keychain copy is made now, with the person approving in 1Password; a grant whose
          // copy couldn't be made would only fail its first login.
          if (grant.provider === 'keychain-copy') {
            await this.copyGrantItem(grant, adapter.definition.manifest)
          }
          // Audited first: a grant that can't be recorded isn't made.
          await this.audit.append({
            type: 'grant-made',
            adapterId: grant.adapterId,
            adapterHash: grant.adapterHash,
            secret: grant.secret,
            provider: grant.provider,
            origins: [...grant.origins],
          })
          await this.grants.put(grant)
          if (grant.provider !== 'messages') {
            await this.titles.update((titles) => ({ ...titles, [grant.itemRef]: checked.title }))
          }
          await this.releaseLoginHold(grant.adapterId)
          this.emit('grants-changed')
        },
        revoke: async (adapterId, secret) => {
          const adapter = this.requireAdapter(adapterId)
          if (secret !== MESSAGES_SECRET && !Object.hasOwn(adapter.definition.manifest.secrets, secret)) {
            throw new ValetError('grant', 'not-found')
          }
          const before = await this.grants.list()
          await this.audit.append({ type: 'grant-revoked', adapterId, secret })
          await this.grants.revoke(adapterId, secret)
          // A copy no remaining grant uses goes too.
          const after = await this.grants.list()
          for (const gone of before.filter((g) => g.provider === 'keychain-copy' && !after.includes(g))) {
            if (!after.some((g) => g.provider === 'keychain-copy' && g.itemRef === gone.itemRef)) {
              await deps.credentials.forgetCopy(gone.itemRef).catch(() => {})
            }
          }
          this.emit('grants-changed')
        },
        resync: async (adapterId, secret) => {
          const adapter = this.requireAdapter(adapterId)
          const grant = await this.grants.find(adapterId, adapter.hash, secret)
          if (grant === null || grant.provider !== 'keychain-copy') throw new ValetError('grant', 'not-found')
          await this.copyGrantItem(grant, adapter.definition.manifest)
          await this.releaseLoginHold(adapterId)
          this.emit('grants-changed')
        },
      },
      runs: {
        list: async (query) => runSummaries(await this.reader.records(), this.lookup(), query ?? {}),
        trace: async (callId) =>
          runTrace(await this.reader.records(), callId, this.lookup(), this.memory, (id) => {
            const adapter = this.adapter(id)
            return { version: adapter?.definition.manifest.version ?? '', hash: adapter?.hash ?? '' }
          }),
        statsToday: async () => statsToday(await this.reader.records(), new Date(deps.now())),
      },
      audit: {
        page: async (query) => auditPage(await this.reader.records(), query),
        verify: async () => {
          this.chain = await this.reader.verify(new Date(deps.now()))
          // The sidebar's chain status (in every window) would otherwise keep the old answer until
          // the next record is appended: "not verified yet" beside a broken chain.
          this.emit('audit-verified')
          return this.chain
        },
        chainStatus: async () => this.chain,
        exportJsonl: async () => {
          const target = await deps.ui.chooseSaveFile('valet-audit.jsonl')
          if (target === null) return
          await copyFile(deps.paths.audit, target)
        },
      },
      endpoint: {
        status: async (): Promise<EndpointStatus> => ({
          listening: this.endpoint !== null,
          url: this.endpoint?.url ?? null,
          // Sessions open now, bridged or HTTP, as the endpoint counts them.
          connectedClients: this.endpoint?.sessions().total ?? 0,
        }),
        setListening: async (listening) => {
          if (listening) {
            await this.startListening()
          } else if (this.endpoint !== null) {
            const endpoint = this.endpoint
            this.endpoint = null
            await endpoint.close()
            this.emit('endpoint-changed')
          }
        },
        copyUrl: async () => {
          if (this.endpoint === null) throw new ValetError('config', 'unavailable')
          deps.ui.writeClipboard(this.endpoint.url)
        },
      },
      clients: {
        list: async () => this.clientInfos(),
        add: async (name) => {
          const client = await this.clients.add(name)
          // A stopped endpoint issues the client its token when it next starts.
          await this.endpoint?.addClient({ id: client.id, configPath: this.clients.configPath(client.id) })
          this.emit('clients-changed')
          return (await this.clientInfos()).find((c) => c.id === client.id) as ClientInfo
        },
        resetAccess: async (clientId) => {
          if (!this.clients.isActive(clientId)) throw new ValetError('config', 'not-found')
          if (this.endpoint !== null) {
            // The new token is written to the client's file first; if that fails, nothing changes.
            await this.endpoint.resetClient(clientId)
          } else {
            // Stopped: drop the saved token, so the next start can't keep it whatever the rotation.
            await rm(this.clients.configPath(clientId), { force: true })
          }
          await this.clients.reset(clientId)
          this.emit('clients-changed')
          this.emit('endpoint-changed')
        },
        revoke: async (clientId) => {
          if (!this.clients.isActive(clientId)) throw new ValetError('config', 'not-found')
          // The registry first: if the app quits part-way, the next start issues it no token.
          await this.clients.revoke(clientId)
          await this.endpoint?.removeClient(clientId)
          await rm(this.clients.configPath(clientId), { force: true })
          this.emit('clients-changed')
          this.emit('endpoint-changed')
        },
        snippets: async (clientId) => this.snippets(clientId),
        copyConfig: async (clientId, kind) => {
          const text = snippetFor(this.snippets(clientId), kind)
          if (text === null) throw new ValetError('config', 'unavailable')
          deps.ui.writeClipboard(text)
        },
      },
      attention: {
        list: async (): Promise<AttentionItem[]> => {
          const reviews = (await this.states()).flatMap((s) => {
            const review = pendingReview(s, this.startedAt)
            return review === null ? [] : [reviewItem(review)]
          })
          return [...this.handoffs.list(), ...this.broker.list(), ...reviews]
        },
      },
      answerConfirmation: async (confirmationId: string, approved: boolean, from: AppWindow) => {
        this.broker.answer(confirmationId, approved, from)
      },
      // The person's own login work runs as the runtime's login steps: under the adapter's lock (it
      // waits for calls and their runs, and new calls wait for it), never while the site's breaker is
      // open, approved adapters only, and paced by the site's rate budget.
      openLoginWindow: async (adapterId) => {
        if (this.handoffs.show(adapterId)) return
        const adapter = this.requireAdapter(adapterId)
        const manifest = adapter.definition.manifest
        const driver = this.drivers.get(adapterId)
        if (driver === undefined) throw new ValetError('manifest', 'not-found')
        await this.runtime().runLoginStep(
          adapterId,
          async (ctx) => {
            // A call's login may have handed a window to the person while this waited.
            if (this.handoffs.show(adapterId)) return
            // The person's own login window: its refusals are audited too, with no call behind them.
            const page = await driver.openAuthPage(this.blocked.authPage(adapterId, null))
            let shown = false
            try {
              const first = manifest.auth.steps.find((s) => s.op === 'goto')
              if (first?.op === 'goto') await page.goto(first.url).catch(() => undefined)
              if (await isBlockedPage(page)) {
                ctx.reportBlocked('blocked-by-site')
                throw new ValetError('login', 'blocked-by-site')
              }
              // Gave up waiting (the step's deadline): the person was already told it failed.
              if (ctx.signal.aborted) return
              this.handoffs.start({
                manifest,
                driver,
                page,
                reason: 'login-required',
                note: null,
                startedBy: 'person',
                callId: null,
                tool: null,
                client: null,
                filled: [],
                filledOrigin: null,
              })
              shown = true
            } finally {
              if (!shown) await page.close().catch(() => undefined)
            }
          },
          { waitMs: LOGIN_WAIT_MS },
        )
      },
      finishLogin: async (adapterId) => {
        if (!this.handoffs.has(adapterId)) throw new ValetError('login', 'not-found')
        await this.runtime().runLoginStep(adapterId, (ctx) => this.handoffs.finish(adapterId, ctx), {
          waitMs: LOGIN_WAIT_MS,
        })
      },
      closeLoginWindow: (adapterId) => this.handoffs.close(adapterId),
      settings: {
        get: () => this.settings.get(),
        set: async (patch) => {
          const settings = await this.settings.set(patch)
          if (patch.launchAtLogin !== undefined) deps.ui.setLaunchAtLogin(settings.launchAtLogin)
          return this.afterSettings(settings)
        },
        chooseOpPath: async () => {
          const chosen = await deps.ui.chooseOpFile()
          if (chosen === null) return this.settings.get()
          // Not the 1Password CLI, or not safe to run: the old value stays, and the call rejects.
          if ((await deps.checkOp(chosen)) === null) throw new ValetError('config', 'insecure-file')
          return this.afterSettings(await this.settings.setOpPath(chosen))
        },
        clearOpPath: async () => this.afterSettings(await this.settings.setOpPath(null)),
      },
      updates: {
        status: async (): Promise<UpdateStatus> =>
          (this.updates ?? disabledUpdates(deps.version, 'not-configured', false)).status(),
        check: async () => {
          await this.updates?.check()
          this.emit('app-changed')
        },
      },
      health: {
        sites: async () =>
          this.host === null ? [] : siteHealth(await this.host.siteHealth(), await this.reader.records()),
      },
      setup: {
        status: () => this.setup.status(),
        finish: async () => {
          const status = await this.setup.finish()
          this.emit('app-changed')
          return status
        },
      },
      app: {
        status: async () => ({ paused: this.paused, version: deps.version, demo: deps.demo }),
        setPaused: async (paused) => {
          this.paused = paused
          this.emit('app-changed')
        },
        openControlPanel: async (route) => deps.ui.openControlPanel(route ?? null),
        copyText: async (text) => deps.ui.writeClipboard(text),
        quit: async () => deps.ui.quit(),
      },
    }
  }
}

/** The runtime's call-id alphabet: what ToolHost.call accepts. */
const CALL_ID = /^[A-Za-z0-9_-]{1,64}$/

/** A client name as the runtime records it: printable, trimmed, at most 100 characters. */
export function printableClient(client: string): string {
  const printable = client.replace(/[\p{Cc}\p{Cf}]/gu, '').trim()
  return printable.length === 0 ? '(unknown)' : printable.slice(0, 100)
}

/** The selector the manifest fills this secret field into, for the run trace. */
export function fillSelector(
  steps: readonly import('@valet/core').AuthStep[],
  secret: string,
  field: string,
): string {
  for (const step of steps) {
    if (
      step.op === 'fill' &&
      'secret' in step.value &&
      step.value.secret === secret &&
      step.value.field === field
    ) {
      return step.selector
    }
    if (step.op === 'otp' && field === 'otp') {
      if (
        ('secret' in step.source && step.source.secret === secret) ||
        ('messages' in step.source && secret === MESSAGES_SECRET)
      ) {
        return step.selector
      }
    }
    const nested =
      step.op === 'when' ? [...step.steps, ...(step.otherwise ?? [])] : step.op === 'retry' ? step.steps : []
    if (nested.length > 0) {
      const found = fillSelector(nested, secret, field)
      if (found !== '') return found
    }
  }
  return ''
}

function lastUsed(records: readonly AuditRecord[], grant: Grant): string | null {
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i]
    const event = record?.event
    if (
      event?.type === 'secret-used' &&
      event.adapterId === grant.adapterId &&
      event.adapterHash === grant.adapterHash &&
      event.secret === grant.secret
    ) {
      return record?.at ?? null
    }
  }
  return null
}
