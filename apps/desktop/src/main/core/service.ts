// The main process's state and the API behind every IPC channel: the one place that wires the
// runtime, the auth flow, the credentials, the drivers and the MCP endpoint together. Electron
// reaches it only through the injected ports (driver factory, endpoint, UI), so all of it runs and is
// tested in plain Node.

import { randomBytes } from 'node:crypto'
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises'
import type { AuthProbe } from '@siteadapter/auth-flow'
import {
  type AdapterManifest,
  type AuditEvent,
  type AuditRecord,
  type AuditSink,
  type Grant,
  MESSAGES_SECRET,
  type ProviderKind,
  type SecretField,
  type SessionDriver,
  SiteAdapterError,
} from '@siteadapter/core'
import { FileGrantStore } from '@siteadapter/credentials'
import type { RunningEndpoint, ToolCall, ToolCaller } from '@siteadapter/mcp-server'
import {
  ApprovalStore,
  AuditLog,
  JsonFileStore,
  LoginAttemptMarker,
  type RuntimeDiagnostic,
  ToolHost,
} from '@siteadapter/runtime'
import type {
  AppEvent,
  AttentionItem,
  ChainStatus,
  ClientSnippet,
  EndpointStatus,
  HashRoute,
  Settings,
  UpdateStatus,
} from '../../shared/api'
import { AdapterGate } from './adapter-gate'
import {
  type AdapterLookup,
  AuditReader,
  auditPage,
  callCounts,
  runSummaries,
  runTrace,
  statsToday,
} from './audit-view'
import { type AppRefusal, RuntimeToolCaller } from './caller'
import { ClientRegistry } from './clients'
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
import type { MainApi, WindowRole } from './ipc'
import { createAuthRunner, Handoffs, SessionTracker } from './login'
import { type ApprovedSnapshot, type BuiltinAdapter, SnapshotStore } from './registry'
import { RunMemory } from './run-memory'
import { SettingsStore } from './settings'
import { type BridgeCommand, clientSnippets, snippetFor } from './snippets'
import {
  type AdapterState,
  adapterDetail,
  adapterSummary,
  pendingReview,
  reviewItem,
  siteHealth,
} from './views'
import { z } from './zod'

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
  readonly createDriver: (manifest: AdapterManifest) => Promise<SessionDriver>
  readonly credentials: Credentials
  readonly startEndpoint: (caller: ToolCaller, configPath: string) => Promise<RunningEndpoint>
  readonly ui: UiPort
  readonly emit: (event: AppEvent) => void
  /** Probe hooks for drivers whose AuthPage lacks fetch/cookieNames; null to use the page's. */
  readonly probeFallback: (adapterId: string) => AuthProbe | null
  /** The stdio bridge's command line, for client snippets; null when it can't be launched. */
  readonly bridge: BridgeCommand | null
  /** Checks a chosen op binary (checkOpBinary); the resolved path, or null to refuse it. */
  readonly checkOp: (path: string) => Promise<string | null>
  readonly diagnostics?: (diagnostic: RuntimeDiagnostic | { readonly type: string }) => void
  readonly newId?: () => string
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
  'tool-called': ['runs-changed', 'clients-changed'],
  'tool-finished': ['runs-changed', 'adapters-changed'],
  'login-started': ['runs-changed', 'adapters-changed'],
  'login-finished': ['runs-changed', 'adapters-changed'],
  'secret-used': ['runs-changed', 'grants-changed'],
  'request-blocked': ['runs-changed'],
  'breaker-opened': ['health-changed'],
  'breaker-closed': ['health-changed'],
  confirmation: ['runs-changed'],
}

const titlesSchema = z.record(z.string().max(512), z.string().max(200))
const endpointMetaSchema = z.object({ tokenRotatedAt: z.iso.datetime().nullable() }).strict()

export class AppService {
  readonly api: MainApi
  private readonly audit: ObservedAudit
  private readonly approvals: ApprovalStore
  private readonly grants: FileGrantStore
  private readonly markers: LoginAttemptMarker
  private readonly settings: SettingsStore
  private readonly snapshots: SnapshotStore
  private readonly clients: ClientRegistry
  private readonly titles: JsonDocument<Record<string, string>>
  private readonly endpointMeta: JsonDocument<{ tokenRotatedAt: string | null }>
  private readonly reader: AuditReader
  private readonly memory = new RunMemory()
  private readonly sessions: SessionTracker
  private readonly broker: ConfirmationBroker
  private readonly handoffs: Handoffs
  private readonly drivers = new Map<string, SessionDriver>()
  private readonly gate: AdapterGate
  /** When each installed hash was approved, for the confirmation panel (which reads synchronously). */
  private readonly approvedAt = new Map<string, string>()
  private caller: RuntimeToolCaller | null = null
  private endpoint: RunningEndpoint | null = null
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
    this.snapshots = new SnapshotStore(paths.manifests)
    this.clients = new ClientRegistry(paths.clients, date)
    this.titles = new JsonDocument(paths.grantItems, titlesSchema, () => ({}), true)
    this.endpointMeta = new JsonDocument(
      paths.endpoint,
      endpointMetaSchema,
      () => ({ tokenRotatedAt: null }),
      true,
    )
    this.reader = new AuditReader(paths.audit)
    this.gate = new AdapterGate(deps.timers)
    this.sessions = new SessionTracker(date, () => this.emit('adapters-changed'))
    const newId = deps.newId ?? (() => randomBytes(12).toString('hex'))
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
        return run === undefined ? null : { transport: run.transport, input: run.input }
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
      probeFallback: deps.probeFallback,
    })
    this.api = this.buildApi()
  }

  /** Opens the stores, builds a driver per adapter, registers them, and starts the endpoint. */
  async start(): Promise<void> {
    const { paths } = this.deps
    await ensurePrivateDir(paths.dir)
    await mkdir(paths.loginMarkers, { recursive: true, mode: 0o700 })
    await this.deps.credentials.configure(await this.settings.get())
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
        probeFallback: this.deps.probeFallback,
        callInfo: (callId) => {
          const run = callId === null ? undefined : this.memory.get(callId)
          return { tool: run?.tool ?? null, client: run?.client ?? null }
        },
        filledFor: (adapterId, callId, since) => this.filledFor(adapterId, callId, since),
      }),
      markers: this.markers,
      breakerStore: new JsonFileStore(paths.breakers),
      confirmationTimeoutMs: CONFIRMATION_TIMEOUT_MS,
      diagnostics: (d) => this.deps.diagnostics?.(d),
    })
    for (const adapter of this.deps.adapters) {
      const id = adapter.definition.manifest.id
      // The runtime gets the tracked driver, so the gate sees its runs (adapter-gate.ts).
      const driver = this.gate.track(id, await this.deps.createDriver(adapter.definition.manifest))
      this.drivers.set(id, driver)
      host.register({ definition: adapter.definition, bundleHash: adapter.hash, driver })
    }
    this.caller = new RuntimeToolCaller(host, {
      paused: () => this.paused,
      revoked: (client) => this.clients.isRevoked(client),
      started: (call) => {
        // The bridge reaches the endpoint over HTTP too, so the runtime only ever sees HTTP.
        this.memory.started(call.callId, call.tool, call.client, call.input, 'http')
        if (this.clients.seen(call.client, 'http')) this.emit('clients-changed')
      },
      finished: (call, result) =>
        this.memory.finished(call.callId, result.status === 'ok' ? result.output : undefined),
      refused: (call, refusal) => this.auditRefusal(call, refusal),
      enter: (adapterId) => this.gate.enter(adapterId),
    })
    await this.caller.refresh()
    // Reads approval times into the cache the confirmation panel uses.
    await this.states()
    await this.startListening().catch(() => undefined)
  }

  async stop(): Promise<void> {
    this.broker.declineAll()
    this.handoffs.closeAll()
    await this.endpoint?.close().catch(() => undefined)
    this.endpoint = null
    for (const driver of this.drivers.values()) await driver.close().catch(() => undefined)
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
    if (adapter === null) throw new SiteAdapterError('manifest', 'not-found')
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

  /** Whether the site's circuit breaker is open now: no login may start, nor a hand-off reach it. */
  private async siteBlocked(adapterId: string): Promise<boolean> {
    const sites = await this.api.health.sites()
    return sites.some((s) => s.adapterIds.includes(adapterId) && s.breaker === 'open')
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

  private async refreshTools(): Promise<void> {
    await this.caller?.refresh()
    try {
      this.endpoint?.refresh()
    } catch {
      // The runtime couldn't list; every session keeps what it had.
    }
  }

  private async startListening(): Promise<void> {
    if (this.endpoint !== null || this.caller === null) return
    this.endpoint = await this.deps.startEndpoint(this.caller, this.deps.paths.bridgeConfig)
    this.endpoint.refresh()
    this.emit('endpoint-changed')
  }

  private snippets(): ClientSnippet[] {
    if (this.deps.bridge === null) return []
    const name = this.deps.demo ? `${MCP_SERVER_NAME}-demo` : MCP_SERVER_NAME
    return clientSnippets(name, this.deps.bridge)
  }

  private async available(): Promise<Set<ProviderKind>> {
    const status = await this.deps.credentials.status()
    return new Set(status.filter((s) => s.available).map((s) => s.kind))
  }

  private async afterSettings(settings: Settings): Promise<Settings> {
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
          if (adapter.hash !== hash) throw new SiteAdapterError('manifest', 'invalid')
          await this.approvals.approve(adapterId, hash, adapter.definition.manifest.version)
          const at = new Date(deps.now()).toISOString()
          await this.snapshots.put(adapterId, adapter, at)
          this.approvedAt.set(`${adapterId}:${hash}`, at)
          await this.refreshTools()
        },
        reject: async (adapterId, hash) => {
          const adapter = this.requireAdapter(adapterId)
          if (adapter.hash !== hash) throw new SiteAdapterError('manifest', 'invalid')
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
          return (await deps.credentials.status()).map((s) => ({
            ...s,
            grantCount: grants.filter((g) => g.provider === s.kind).length,
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
          this.emit('grants-changed')
        },
        revoke: async (adapterId, secret) => {
          const adapter = this.requireAdapter(adapterId)
          if (secret !== MESSAGES_SECRET && !Object.hasOwn(adapter.definition.manifest.secrets, secret)) {
            throw new SiteAdapterError('grant', 'not-found')
          }
          await this.audit.append({ type: 'grant-revoked', adapterId, secret })
          await this.grants.revoke(adapterId, secret)
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
          return this.chain
        },
        chainStatus: async () => this.chain,
        exportJsonl: async () => {
          const target = await deps.ui.chooseSaveFile('siteadapter-audit.jsonl')
          if (target === null) return
          await copyFile(deps.paths.audit, target)
        },
      },
      endpoint: {
        status: async (): Promise<EndpointStatus> => ({
          listening: this.endpoint !== null,
          url: this.endpoint?.url ?? null,
          connectedClients: this.endpoint === null ? 0 : this.clients.connected(),
          tokenRotatedAt: (await this.endpointMeta.read()).tokenRotatedAt,
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
        rotateToken: async () => {
          if (this.endpoint !== null) {
            await this.endpoint.resetToken()
          } else {
            // Stopped: drop the saved token, so the next start makes a new one.
            await rm(deps.paths.bridgeConfig, { force: true })
          }
          await this.endpointMeta.update(() => ({ tokenRotatedAt: new Date(deps.now()).toISOString() }))
          this.emit('endpoint-changed')
        },
        snippets: async () => this.snippets(),
        copyClientConfig: async (client) => {
          const text = snippetFor(this.snippets(), client)
          if (text === null) throw new SiteAdapterError('config', 'unavailable')
          deps.ui.writeClipboard(text)
        },
        copyUrl: async () => {
          if (this.endpoint === null) throw new SiteAdapterError('config', 'unavailable')
          deps.ui.writeClipboard(this.endpoint.url)
        },
      },
      clients: {
        list: async () => {
          const records = await this.reader.records()
          const since = deps.now() - 7 * 24 * 60 * 60_000
          return this.clients.list(
            (name) =>
              records.filter(
                (r) => r.event.type === 'tool-called' && r.event.client === name && Date.parse(r.at) >= since,
              ).length,
          )
        },
        revoke: async (clientId) => {
          if (!(await this.clients.revoke(clientId))) throw new SiteAdapterError('config', 'not-found')
          this.emit('clients-changed')
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
      answerConfirmation: async (confirmationId: string, approved: boolean, from: WindowRole) => {
        this.broker.answer(confirmationId, approved, from)
      },
      // The person's own login work: never while the site's breaker is open, and never alongside a
      // tool call or run on the adapter (it waits for them, and new calls wait for it).
      openLoginWindow: async (adapterId) => {
        if (this.handoffs.show(adapterId)) return
        const adapter = this.requireAdapter(adapterId)
        const manifest = adapter.definition.manifest
        // The auth partition is driven only under an approved manifest's navigation rules.
        if (!(await this.approvals.isApproved(adapterId, adapter.hash)))
          throw new SiteAdapterError('manifest', 'not-granted')
        const driver = this.drivers.get(adapterId)
        if (driver === undefined) throw new SiteAdapterError('manifest', 'not-found')
        await this.gate.exclusive(adapterId, LOGIN_WAIT_MS, async () => {
          // A call's login may have handed a window to the person while this waited.
          if (this.handoffs.show(adapterId)) return
          if (await this.siteBlocked(adapterId)) throw new SiteAdapterError('login', 'rate-limited')
          const page = await driver.openAuthPage()
          const first = manifest.auth.steps.find((s) => s.op === 'goto')
          if (first?.op === 'goto') await page.goto(first.url).catch(() => undefined)
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
        })
      },
      finishLogin: (adapterId) =>
        this.gate.exclusive(adapterId, LOGIN_WAIT_MS, async () => {
          if (await this.siteBlocked(adapterId)) throw new SiteAdapterError('login', 'rate-limited')
          await this.handoffs.finish(adapterId)
        }),
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
          if ((await deps.checkOp(chosen)) === null) throw new SiteAdapterError('config', 'insecure-file')
          return this.afterSettings(await this.settings.setOpPath(chosen))
        },
        clearOpPath: async () => this.afterSettings(await this.settings.setOpPath(null)),
      },
      updates: {
        // The updater is another unit's (src/main/updater); until it lands, nothing is checked.
        status: async (): Promise<UpdateStatus> => ({
          current: deps.version,
          state: 'up-to-date',
          available: null,
          checkedAt: null,
          signed: false,
        }),
        check: async () => {},
      },
      health: {
        sites: async () => {
          const breakers = await readFile(deps.paths.breakers, 'utf8').catch(() => null)
          return siteHealth(
            deps.adapters.map((a) => a.definition.manifest),
            breakers,
            await this.reader.records(),
            deps.now(),
          )
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
  steps: readonly import('@siteadapter/core').AuthStep[],
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
