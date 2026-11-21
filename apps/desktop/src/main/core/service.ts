// The main process's state and the API behind every IPC channel: the one place that wires the
// runtime, the auth flow, the credentials, the drivers and the MCP endpoint together. Electron
// reaches it only through the injected ports (driver factory, endpoint, UI), so all of it runs and is
// tested in plain Node.

import { randomBytes } from 'node:crypto'
import { copyFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { CertificateStore } from '@valet/acme'
import { AdapterStore, type BuildRecord, type PackageRuntime } from '@valet/adapter-store'
import type { ScratchRules } from '@valet/browser-electron'
import {
  type AdapterManifest,
  type ApprovalKind,
  type ApprovalSubject,
  type AuditEvent,
  type AuditRecord,
  type AuditSink,
  approvalDecisionSchema,
  type BlockedRequest,
  bundleHash,
  CredentialError,
  type CredentialGrant,
  credentialsOf,
  DEFAULT_SANDBOX,
  describeCredentialUse,
  describeDeclaration,
  folderAllowed,
  type Grant,
  type GrantStore,
  type ImapProtocol,
  type LocalAccess,
  MAIL_SECRET,
  type MacToPhoneMessage,
  type MailAccountRef,
  type MailReader,
  MESSAGES_SECRET,
  mailSourcesIn,
  mayWriteInbox,
  messagesSourcesIn,
  type NeedsUserReason,
  needsYouTitle,
  type PackageFiles,
  type PrivateHost,
  type ProviderKind,
  parseManifest,
  plainName,
  type Requester,
  runtimeOf,
  type SecretField,
  type SecretValue,
  type SessionDriver,
  type SettingChoice,
  type SftpProtocol,
  type SmtpProtocol,
  settingToolNames,
  sha256Hex,
  type ToolDeclaration,
  ValetError,
} from '@valet/core'
import { FileCredentialGrantStore, FileGrantStore } from '@valet/credentials'
import type { OpenTunnels, RunContext } from '@valet/egress'
import {
  type AdminReader,
  type Authoring,
  type CallOutcome,
  displayCode,
  type EndpointClient,
  identityLabel,
  type LiveSessions,
  type NeedsYouHint,
  normaliseCode,
  normaliseRemoteHost,
  type ProtocolRefusal,
  type SessionReportingEndpoint,
  type ToolCall,
  type ToolCaller,
} from '@valet/mcp-server'
import { addDependency, diskTarballStore } from '@valet/node-runtime'
import type { MailAccount } from '@valet/protocols'
import {
  ApprovalStore,
  AuditLog,
  CredentialGate,
  DEFAULT_LOGIN_BACKOFF,
  type HttpEgress,
  type ImapBackend,
  JsonFileStore,
  LoginAttemptMarker,
  noBrowserDriver,
  pruneOlderThan,
  type RuntimeDiagnostic,
  SecretRedactionSet,
  type SftpBackend,
  type Sleep,
  type SmtpBackend,
  sensitiveMatcher,
  ToolHost,
  type ToolProcessFactory,
} from '@valet/runtime'
import { z } from 'zod'
import { href } from '../../renderer/lib/routes'
import type {
  AdapterVersions,
  AgentRequestItem,
  AppEvent,
  AttentionItem,
  ChainStatus,
  ClientInfo,
  ClientSnippet,
  ConfirmationItem,
  DraftOverview,
  DraftPage,
  EndpointStatus,
  HashRoute,
  KeysChangedItem,
  PendingReview,
  RemoteConsentItem,
  RemoteConsentRequest,
  RemoteSetup,
  RemoteSetupTool,
  RepairItem,
  RollbackPreview,
  SettingChoicesReply,
  Settings,
  SettingsPatch,
  UpdateStatus,
  VaultItem,
} from '../../shared/api'
import { AdapterSettingsStore } from './adapter-settings'
import { adminReader } from './admin'
import { AdminWriterImpl, type AgentSettingValues, type WriterSource } from './admin-writer'
import { agentRequestItem, draftReviewRequest } from './agent-requests'
import { AppStateStore } from './app-state'
import {
  AnchoredFile,
  ApprovalBroker,
  adapterSettingSubject,
  DeviceStore,
  grantSubject,
  type HubConsent,
  installSubject,
  itemFingerprint,
  type KindHandlers,
  type MacApprovalKeys,
  permissionChanges,
  type RemoteCapability,
  remoteAskClient,
  remoteAskSetting,
  remoteAskSubject,
  remoteClientSubject,
  requestRef,
  settingSubject,
  settingValue,
  settingWidens,
  showable,
  subjectProvider,
  TRUSTED_STORE,
  TrustedLedger,
  toolEnableSubject,
  WIDENING_SETTINGS,
  type WideningSetting,
} from './approvals'
import { MissedItems, sortAttention } from './attention'
import {
  type AdapterLookup,
  AuditReader,
  auditPage,
  callCounts,
  runSummaries,
  runTrace,
  statsToday,
} from './audit-view'
import { type BlindRelaySetup, BlindTunnel } from './blind-tunnel'
import { BlockedAudit, LoginSecrets } from './blocked'
import { type AppRefusal, RefusalBudget, RuntimeToolCaller } from './caller'
import { addToDesktopConfig } from './claude-desktop'
import { ClientRegistry, capabilityNames, shownTransport } from './clients'
import { ConfirmationBroker, type ConfirmationSigning, type Timers } from './confirmations'
import {
  AUTH_FLOW_TIMEOUT_MS,
  CONFIRMATION_TIMEOUT_MS,
  type DataPaths,
  HANDOFF_WINDOW_MS,
  LOGIN_WAIT_MS,
  MCP_SERVER_NAME,
  TYPING_DELAY_MS,
} from './constants'
import { CredentialKeeper } from './credential-grants'
import type { Credentials } from './credentials'
import {
  type AskOutcome,
  DraftAuthoring,
  type PrivateNetworkRequest,
  type RequestState,
  type SessionRequest,
  type SubmitOutcome,
  type SubmitRequest,
} from './drafts/authoring'
import type { CaseBrowser } from './drafts/cases'
import { RepairTickets } from './drafts/repairs'
import { draftDomains, type ScratchHandle, ScratchSessions } from './drafts/research'
import { type DraftRecord, DraftStore } from './drafts/store'
import type { SignedInTrial } from './drafts/trial'
import { type EraseKind, type EraseReport, type EraseStep, eraseEverything } from './erase'
import { FeedbackDeskImpl } from './feedback'
import { ensurePrivateDir, JsonDocument } from './files'
import { carriesOver, checkGrantRequest, grantInfo } from './grants'
import type { AppWindow, MainApi } from './ipc'
import {
  KEYS_CHANGED_ID,
  KeysNotice,
  keysChangedItem,
  type OldKeysSigned,
  signedByOldKeys,
} from './keys-changed'
import { createAuthRunner, Handoffs, isBlockedPage, SessionTracker } from './login'
import { type AppNotification, attentionTitle, Notifier } from './notifications'
import { type FolderInstall, InstallError, installReason, PackageManager, rollbackEligible } from './packages'
import { addsPermissions, permissionDiff } from './permission-diff'
import { Phones, type RelaySetup, relayFromHost } from './phones'
import { type ApprovedSnapshot, type BuiltinAdapter, SnapshotStore, snapshotIntact } from './registry'
import { RemoteAccess } from './remote'
import { RunMemory } from './run-memory'
import { DEFAULT_SETTINGS, SettingsStore, traceRetentionDaysSchema } from './settings'
import { SetupStore } from './setup'
import { type BridgeCommand, clientSnippets, snippetFor } from './snippets'
import { disabledUpdates, type UpdatesHooks, type UpdatesPort, VersionStore } from './updates'
import {
  type AdapterState,
  adapterDetail,
  adapterSummary,
  missingItems,
  pendingReview,
  reviewItem,
  siteHealth,
} from './views'

/** What the service asks of the app's windows and the OS. */
export interface UiPort {
  writeClipboard(text: string): void
  /** Opens an https page in the person's default browser. */
  openExternal(url: string): void
  /** Shows a folder of Valet's own (a draft's) in Finder. */
  showFolder(path: string): void
  /** A native save dialog. Null when cancelled. */
  chooseSaveFile(defaultName: string): Promise<string | null>
  /** A native open dialog for the 1Password CLI. Null when cancelled. */
  chooseOpFile(): Promise<string | null>
  openControlPanel(route: HashRoute | null): void
  showConfirmation(id: string): void
  /** Brings the confirmation's own panel forward and focuses it, reopening it if it was closed. */
  focusConfirmation(id: string): void
  closeConfirmation(id: string): void
  showNeedsUser(adapterId: string): void
  closeNeedsUser(adapterId: string): void
  setLaunchAtLogin(enabled: boolean): void
  quit(): void
  /** Quits and starts again, after the Mac's keys changed under everything holding them. */
  relaunch?(): void
  /** A system notification; a click opens its target window and does nothing else. */
  notify(notification: AppNotification): void
  closeNotification(key: string): void
  /**
   * Asks the person, in a native dialog of the main process, whether to erase everything. Only a
   * click there says yes: the renderer that asked for it never answers it.
   */
  confirmErase(kind: EraseKind): Promise<boolean>
  /** Clears one site's auth and tool partitions (the site was removed). */
  clearSiteData?(adapterId: string): Promise<void>
  /** Clears what the browser sessions hold, before their files are removed. */
  clearBrowserData(): Promise<void>
  /** After an erase: restart as new (reset), or move the app to the Trash and quit (uninstall). */
  finishErase(report: EraseReport): void
}

export interface ServiceDeps {
  readonly paths: DataPaths
  readonly version: string
  readonly demo: boolean
  readonly now: () => number
  readonly timers: Timers
  readonly sleep: (ms: number) => Promise<void>
  /**
   * Adapters already loaded, for tests. With `packages`, the service loads its own from the adapter
   * store at start, and these are ignored.
   */
  readonly adapters: readonly BuiltinAdapter[]
  /**
   * Adapter packages (docs/adapter-packages.md): the built-ins this build ships, seeded into the
   * store; how to compile and describe them; and what the hash doesn't cover, for the history.
   */
  readonly packages?: {
    readonly builtins: readonly PackageFiles[]
    readonly runtime: PackageRuntime
    readonly build: BuildRecord
    /** Development builds only: installing a package from a folder (docs/adapter-packages.md). */
    readonly folders?: FolderInstall
  }
  /**
   * Starts a tool process for one call. With it, an adapter that has a tool script runs its tool
   * code there; without it (unit tests), in this process.
   */
  readonly toolProcess?: ToolProcessFactory
  /**
   * The adapter sandbox (docs/sandbox.md). With it, a sandboxed adapter's tool code runs in a
   * sandbox renderer for its version, and an unsandboxed one in `toolProcess`; each gets `local`,
   * the capabilities its declared exceptions allow. Without it, every adapter runs in `toolProcess`.
   */
  readonly sandbox?: {
    forAdapter(adapterHash: string): ToolProcessFactory
    local(manifest: AdapterManifest): LocalAccess
  }
  /**
   * The egress broker for an adapter whose runtime isn't browser (docs/adapter-kinds.md), built
   * from its manifest's endpoints. Without it, ctx.http is not granted.
   */
  readonly egress?: (endpoints: {
    readonly egress: readonly string[]
    readonly privateHosts?: readonly PrivateHost[] | undefined
    readonly endpoints?: readonly string[] | undefined
  }) => HttpEgress & {
    /** A raw adapter's tunnels for one call (EgressBroker.tunnels). */
    readonly tunnels?: (run: RunContext, options: { readonly admit: () => Promise<void> }) => OpenTunnels
  }
  /**
   * The Node runtime for `raw` adapters (docs/node-runtime.md): one call's process for a raw
   * adapter's version, its tunnels opened by `openTunnels`. Without it (off macOS, or no Node
   * binary), a raw adapter's calls are unavailable.
   */
  readonly raw?: {
    start(manifest: AdapterManifest, openTunnels: OpenTunnels): ToolProcessFactory
  }
  /**
   * The protocol host behind a protocol adapter's ctx.imap (docs/imap.md), for its protocols.imap.
   * Without it, every ctx.imap call is not-granted.
   */
  readonly imap?: (protocol: ImapProtocol) => ImapBackend
  /** The protocol host behind ctx.smtp, for protocols.smtp. Without it, every send is not-granted. */
  readonly smtp?: (protocol: SmtpProtocol) => SmtpBackend
  /**
   * The SFTP host behind a protocol adapter's ctx.sftp (docs/sftp.md), for its protocols.sftp.
   * Without it, every ctx.sftp call is not-granted.
   */
  readonly sftp?: (protocol: SftpProtocol) => SftpBackend
  /**
   * Reads sign-in links and codes from mail (docs/imap.md#email-sign-in), through the same protocol
   * host, in whichever account the service says a grant names (mailAccount). Without it, sign-in
   * mail is unavailable: it can't be granted, and a mail step ends `otp: unavailable`.
   */
  readonly mailReader?: (
    account: (ref: MailAccountRef) => Promise<MailAccount | null>,
  ) => MailReader & { close(): void }
  /** Builds an adapter's driver, with the reporters its refusals outside a run go to. */
  readonly createDriver: (manifest: AdapterManifest, reporters: DriverReporters) => Promise<SessionDriver>
  readonly credentials: Credentials
  /**
   * The Mac's approval keys and the trusted ledger's anchor (approvals/mac-keys.ts): the Secure
   * Enclave and the Keychain in a packaged app.
   */
  readonly approvalKeys: MacApprovalKeys
  /** The relay paired phones reach this Mac through (docs/phone-channel.md); none, no phones. */
  readonly relay?: RelaySetup | null
  /**
   * The blind relay (docs/blind-relay.md): where this Mac's tunnel dials, and where its
   * certificate is kept. None: no tunnel.
   */
  readonly blindRelay?: { readonly setup: BlindRelaySetup; readonly store: CertificateStore } | null
  /**
   * Where agents' feedback goes (docs/feedback.md): the repository, and the GitHub token from the
   * Keychain (null when the person hasn't added one). None: agents get no feedback tools.
   */
  readonly feedback?: {
    readonly repo: string
    readonly token: () => Promise<SecretValue | null>
    readonly fetch?: typeof fetch
  } | null
  /** This Mac's name, as a paired phone shows it. */
  readonly macName?: string
  /**
   * Starts the MCP endpoint with a token for each of `clients`, written to its config file; it
   * reports its live sessions to `onSessionsChanged`. `admin` is Valet's own read-only tools, for
   * local clients' sessions (docs/admin-tools.md); `authoring`, the tools agents write adapters
   * with (docs/authoring-tools.md), when this build can install adapters.
   */
  readonly startEndpoint: (
    caller: ToolCaller,
    clients: readonly EndpointClient[],
    onSessionsChanged: (sessions: LiveSessions) => void,
    admin: AdminReader,
    authoring: Authoring | null,
  ) => Promise<SessionReportingEndpoint>
  /**
   * Opens a draft's scratch browser (docs/authoring-tools.md#the-scratch-browser-pr-2): signed
   * out, in memory, through a proxy that refuses private addresses once resolved. None in tests
   * that don't drive a browser, and then the research tools say so.
   */
  readonly scratch?: (
    draftId: string,
    rules: ScratchRules,
    /** The private addresses (and ports) the person let this draft reach, asked at each dial. */
    allowPrivate: (address: string, port: number) => boolean,
  ) => Promise<ScratchHandle>
  /**
   * A session driver for a draft's live trial (docs/authoring-tools.md#live-trials): partitions in
   * memory named by `label`, through the same public-only dial. None in tests that don't drive a
   * browser, and then valet_live_trial says so.
   */
  readonly trialDriver?: (
    manifest: AdapterManifest,
    label: string,
    allowPrivate: (address: string, port: number) => boolean,
    /** A signed-in trial: the installed adapter whose tool-partition cookies are copied in, one way. */
    session: { readonly adapterId: string; readonly cookieDomains: readonly string[] } | null,
  ) => Promise<SessionDriver>
  /**
   * The fixture browser for a case's pages (docs/authoring-tools.md#the-agents-cases): served from
   * memory, scripts off, nothing sent. None in tests that don't drive a browser.
   */
  readonly fixtureBrowser?: (
    pages: Readonly<Record<string, string>>,
    egress: readonly string[],
  ) => Promise<CaseBrowser>
  readonly ui: UiPort
  readonly emit: (event: AppEvent) => void
  /** The stdio bridge's command line for a client's config file, for snippets; null when it can't be launched. */
  readonly bridge: ((configPath: string) => BridgeCommand) | null
  /** Claude Desktop's claude_desktop_config.json, which "Add to Claude Desktop" writes. Null: none. */
  readonly claudeDesktopConfig: string | null
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
  /** What a reset or an uninstall removes besides the data folder (erase.ts); none by default. */
  readonly leftovers?: readonly string[]
  /** How the runtime waits for a site's rate budget; real time by default. Tests pass their clock's. */
  readonly pacingSleep?: Sleep
  /** For clock times in notifications; the machine's own zone by default. Tests pass one. */
  readonly timeZone?: string
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
  'adapter-installed': ['approvals-changed', 'adapters-changed', 'attention-changed'],
  'adapter-activated': ['approvals-changed', 'adapters-changed', 'attention-changed'],
  'adapter-refused': ['adapters-changed', 'health-changed', 'attention-changed'],
  'adapter-removed': ['adapters-changed', 'approvals-changed', 'attention-changed'],
  // A grant or a setting can make a "Give Valet your login" or "Choose your store" item come or go.
  'grant-made': ['grants-changed', 'adapters-changed', 'attention-changed'],
  'grant-revoked': ['grants-changed', 'adapters-changed', 'attention-changed'],
  'grant-copied': ['grants-changed'],
  // The adapter's queue count changes with every call that arrives, waits or finishes.
  'tool-called': ['runs-changed', 'clients-changed', 'health-changed'],
  'call-waited': ['runs-changed', 'health-changed'],
  'tool-finished': ['runs-changed', 'adapters-changed', 'health-changed'],
  'login-started': ['runs-changed', 'adapters-changed'],
  'login-finished': ['runs-changed', 'adapters-changed'],
  'secret-used': ['runs-changed', 'grants-changed'],
  'request-blocked': ['runs-changed'],
  'breaker-opened': ['health-changed'],
  'breaker-closed': ['health-changed'],
  confirmation: ['runs-changed'],
  'setting-changed': ['adapters-changed', 'attention-changed'],
  'lock-down': ['app-changed', 'adapters-changed', 'health-changed', 'attention-changed'],
  'site-paused': ['adapters-changed', 'health-changed'],
}

/** What a phone's tabs show (relay-protocol's `status`), before the channel numbers it. */
type PhoneStatusBody = Omit<Extract<MacToPhoneMessage, { type: 'status' }>, 'type' | 'seq'>

/** The write tools' setting names, as the signed `setting` subject names them (approvals/subjects.ts). */
const SETTING_SUBJECT_NAMES = {
  messagesOtpEnabled: 'messages_otp',
  notifications: 'notifications',
  traceRetentionDays: 'trace_retention',
} as const

/** Error classes only an adapter update fixes: the site's last call raises a repair item. */
const NEEDS_REPAIR: ReadonlySet<string> = new Set(['site-changed'])

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

/** How long a declined credential ask holds the same agent's same ask back. */
const CREDENTIAL_DECLINE_COOLDOWN_MS = 60 * 60_000
/** Credential asks one agent, and all agents, may keep waiting at once. */
const CREDENTIAL_ASKS_PER_AGENT = 3
const CREDENTIAL_ASKS_TOTAL = 10

export class AppService {
  readonly api: MainApi
  private readonly audit: ObservedAudit
  private readonly approvals: ApprovalStore
  private readonly grants: FileGrantStore
  /** Credential grants (secrets v2): made, signed, carried and looked up for each call. */
  readonly credentialKeeper: CredentialKeeper
  /** Sign-in mail's reader (deps.mailReader), or null when this Mac can't run the protocol host. */
  private readonly mail: (MailReader & { close(): void }) | null
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
  /** Paired devices, once the approval broker is open: whether a phone was told too. */
  private deviceStore: DeviceStore | null = null
  /** Paired phones and the relay connection they use (phones.ts). */
  private readonly phones: Phones
  /** This Mac at the blind relay, when one is set up (docs/blind-relay.md). */
  private readonly tunnel: BlindTunnel | null
  private phoneStatus: PhoneStatusBody | null = null
  /** The write tools' side (admin-writer.ts): one for the app's life, so it remembers requests. */
  private writer: AdminWriterImpl | null = null
  /** Agents' feedback (feedback.ts): one for the app's life. */
  private feedbackDesk: FeedbackDeskImpl | null = null
  /** Agents' asks to remove a site, by id, until the person answers or Valet restarts. */
  private readonly removalAsks = new Map<string, AgentRequestItem & { readonly asker: string }>()
  /**
   * Agents' asks to grant a credential (valet_request_credential). The person answers on the site's
   * Credentials card, where they pick the item; an ask ends when that credential is granted for the
   * version it was asked for, the version changes, it is declined, or it expires.
   */
  private readonly credentialAsks = new Map<
    string,
    AgentRequestItem & { readonly asker: string; readonly credential: string; readonly adapterHash: string }
  >()
  /** When the person declined a credential ask, by asker, adapter and credential: it waits an hour. */
  private readonly credentialDeclines = new Map<string, number>()
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
  /** How many of each client's protocol refusals are recorded one by one. */
  private readonly refusalBudget: RefusalBudget
  /**
   * Signed approvals (docs/approval-broker.md), from start() on. Null before, or if the Mac's keys
   * couldn't be read: then nothing that needs an approval can be approved.
   */
  private approvalBroker: ApprovalBroker | null = null
  /** Each running call's client, by its token's identity, as the broker names agents. */
  private readonly callers = new Map<string, string>()
  /**
   * The trusted ledger, opened at start whatever happens to the keys: its lockdown, and a lockdown
   * for tampering, hold even while the broker can't open.
   */
  private ledger: TrustedLedger | null = null
  /**
   * Whether an installed hash may run: approved in approvals.json (the applied mark) and backed by
   * signed evidence, or by the one-time legacy record of what was approved before signatures.
   */
  private readonly installGate = {
    isApproved: async (adapterId: string, adapterHash: string): Promise<boolean> =>
      this.installSigned(adapterId, adapterHash) && (await this.approvals.isApproved(adapterId, adapterHash)),
  }
  private readonly handoffs: Handoffs
  private readonly drivers = new Map<string, SessionDriver>()
  /** Per adapter, the install or rollback in progress: they run one at a time. */
  private readonly changing = new Map<string, Promise<unknown>>()
  /** The adapter versions registered now: deps.adapters, or what the store loaded at start. */
  private installed: BuiltinAdapter[]
  private readonly packages: PackageManager | null
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
  /** A reset or uninstall is under way: a second one is refused. */
  private erasing = false
  private readonly notifier: Notifier
  private chain: ChainStatus = { state: 'unverified' }
  private readonly startedAt: string
  /** Lock down and the sites the person paused, kept across restarts. */
  private readonly appState: AppStateStore
  /** Needs you items nobody answered in time, kept 24 hours. */
  private readonly missed: MissedItems
  /** Whether the person dismissed the approval-keys-changed notice (keys-changed.ts). */
  private readonly keysNotice: KeysNotice
  /** signedByOldKeys's answer for the ledger's evidence as last read. */
  private oldKeys: {
    readonly evidence: unknown
    readonly macId: string
    readonly signed: OldKeysSigned | null
  } | null = null
  private missedTimer: unknown = null
  private consentTimer: unknown = null
  /** Per adapter: its most recent call, when that failed in a way only an adapter update fixes. */
  private readonly repairs = new Map<
    string,
    { readonly callId: string; readonly errorClass: string; readonly at: string }
  >()
  /** Private addresses the person let a draft reach, until when (R21), by draft id. */
  private readonly privateNetwork = new Map<
    string,
    { readonly address: string; readonly port: number | null; readonly until: number }[]
  >()
  /** Signed-in authoring sessions the person lent a draft's live trials (D81), by draft id. */
  private readonly authoringSessions = new Map<
    string,
    { readonly adapterId: string; readonly until: number }
  >()
  /** Repair tickets for installed adapters (docs/authoring-tools.md#repairs-pr-3), from the audit log. */
  private readonly repairTickets = new RepairTickets()
  /** Drafts agents are writing (docs/authoring-tools.md), and the tools over them once started. */
  private readonly drafts: DraftStore
  private authoring: DraftAuthoring | null = null
  /** Who asked each draft's approval request, for the broker's asker-only status. */
  private readonly draftAskers = new Map<string, Requester>()
  /** Staged draft versions loaded once at submit (or on first view), by `adapterId:hash`. */
  private readonly stagedAdapters = new Map<string, BuiltinAdapter>()
  /** Staged drafts' swaps and tidying, one after another, outside the broker's lock. */
  private staging: Promise<unknown> = Promise.resolve()
  /** Adapters whose last call-started login the person closed without finishing, not yet told to a call. */
  private readonly gaveUp = new Set<string>()

  constructor(private readonly deps: ServiceDeps) {
    this.tunnel =
      deps.blindRelay === undefined || deps.blindRelay === null
        ? null
        : new BlindTunnel({
            setup: deps.blindRelay.setup,
            store: deps.blindRelay.store,
            // Made below; only called once the tunnel runs.
            accept: () => this.remote.tunnelAccept(),
            setHost: (host, ready) => this.remote.setTunnelHost(host, ready),
            changed: () => this.emit('remote-changed'),
            log: (line) => deps.diagnostics?.({ type: line }),
          })
    this.phones = new Phones({
      tunnel: this.tunnel,
      relay: deps.relay ?? null,
      macName: deps.macName ?? 'This Mac',
      statePath: join(deps.paths.dir, 'phone-channel.json'),
      bindingPath: join(deps.paths.dir, 'relay-binding.json'),
      emit: () => this.emit('phones-changed'),
      log: (line) => deps.diagnostics?.({ type: line }),
      // Made below; only called once the relay client runs.
      remote: {
        setRelayHost: (host) => this.remote.setRelayHost(host),
        relayListener: () => this.remote.relayListener(),
        relayConsent: (id, query, source) => this.remote.relayConsent(id, query, source),
        hubAuthorization: (grantId) => this.remote.hubAuthorization(grantId),
        hubGrantsChanged: (live) => {
          this.remote.hubGrantsChanged(live)
          this.emit('remote-changed')
        },
      },
    })
    const { paths } = deps
    const clock = { now: deps.now }
    const date = () => new Date(deps.now())
    this.startedAt = date().toISOString()
    this.notifier = new Notifier({
      enabled: () => this.settingsNow.notifications,
      show: (notification) => deps.ui.notify(notification),
      close: (key) => deps.ui.closeNotification(key),
      now: deps.now,
      ...(deps.timeZone === undefined ? {} : { timeZone: deps.timeZone }),
    })
    this.appState = new AppStateStore(paths.appState)
    this.missed = new MissedItems({
      path: paths.missed,
      now: deps.now,
      changed: () => {
        this.scheduleMissedExpiry()
        this.emit('attention-changed')
      },
    })
    this.keysNotice = new KeysNotice(paths.keysNotice)
    this.audit = new ObservedAudit(new AuditLog(paths.audit, clock), (record) => this.observe(record))
    this.approvals = new ApprovalStore(paths.approvals, this.audit)
    this.grants = new FileGrantStore({ path: paths.grants })
    this.mail = deps.mailReader?.((ref) => this.mailAccount(ref)) ?? null
    this.credentialKeeper = new CredentialKeeper({
      store: new FileCredentialGrantStore({ path: paths.credentialGrants }),
      adapter: (adapterId) => {
        const adapter = this.adapter(adapterId)
        return adapter === null ? null : { hash: adapter.hash, manifest: adapter.definition.manifest }
      },
      approve: (subject) => this.approveHere('credential-grant', subject),
      honoured: (kind, matches) => this.approvalBroker?.honoured(kind, matches) ?? null,
      revokeEvidence: async (matches) => {
        await this.approvalBroker?.revoke('credential-grant', matches)
      },
      carried: () => {
        const ledger = this.ledger
        return ledger === null || ledger.tampered !== null ? null : (ledger.data.carriedCredentials ?? [])
      },
      recordCarried: async (adapterId, records) => {
        const ledger = this.ledger
        if (ledger === null) throw new ValetError('config', 'unavailable')
        await ledger.commit((draft) => {
          // Only the latest carry per adapter matters; older ones name hashes no longer approved.
          draft.carriedCredentials = [
            ...(draft.carriedCredentials ?? []).filter((c) => c.adapterId !== adapterId),
            ...records.map((r) => ({ ...r, targets: [...r.targets] })),
          ].slice(-500)
        })
      },
      dropCarried: async (matches) => {
        const ledger = this.ledger
        if (ledger === null) return
        await ledger.commit(
          (draft) => {
            if (draft.carriedCredentials !== undefined)
              draft.carriedCredentials = draft.carriedCredentials.filter((c) => !matches(c))
          },
          { tightening: true },
        )
      },
      providers: () => deps.credentials.providers(),
      keys: deps.credentials.valetKeys?.() ?? null,
      available: () => this.available(),
      vaultItems: (provider) => deps.credentials.vaultItems(provider),
      copyItem: (itemRef, fields) => deps.credentials.copyItem(itemRef, fields),
      audit: this.audit,
      now: deps.now,
    })
    this.markers = new LoginAttemptMarker(paths.loginMarkers, clock)
    this.settings = new SettingsStore(paths.settings)
    this.adapterSettings = new AdapterSettingsStore(paths.adapterSettings)
    this.versions = new VersionStore(paths.versions)
    this.setup = new SetupStore(paths.setup, deps.now)
    this.snapshots = new SnapshotStore(paths.manifests)
    this.drafts = new DraftStore(paths.drafts, date, () => this.emit('drafts-changed'))
    this.installed = [...deps.adapters]
    this.packages =
      deps.packages === undefined
        ? null
        : new PackageManager({
            store: new AdapterStore(paths.adapters),
            runtime: deps.packages.runtime,
            build: deps.packages.build,
            audit: this.audit,
            now: date,
            keep: (id) => this.keepHashes(id),
          })
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
    this.refusalBudget = new RefusalBudget(
      deps.timers,
      async ({ client, clientId, count }) => {
        await this.audit.append({
          type: 'refusals-dropped',
          client,
          ...(clientId === undefined ? {} : { clientId }),
          count,
        })
      },
      deps.now,
    )
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
      onMissed: (item) =>
        this.missed.add({
          of: 'confirmation',
          id: item.id,
          title: attentionTitle(item),
          adapterId: item.adapterId,
          adapterName: item.adapterName,
          callId: item.callId,
          at: item.requestedAt,
        }),
      onChange: () => this.emit('attention-changed'),
      signing: this.confirmationSigning(),
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
      onEnded: (item, how) => {
        // A window the person opened themselves was never waiting on them.
        if (item.startedBy !== 'call') return
        if (how === 'gave-up') {
          this.gaveUp.add(item.adapterId)
          return
        }
        this.missed.add({
          of: 'needs-user',
          id: item.id,
          title: attentionTitle(item),
          adapterId: item.adapterId,
          adapterName: item.adapterName,
          callId: item.callId,
          at: item.at,
        })
      },
    })
    this.remote = new RemoteAccess({
      path: paths.remote,
      clientsPath: paths.remoteClients,
      info: { name: 'valet', version: deps.version },
      now: deps.now,
      changed: () => {
        if (this.remote.status().pendingConsents + this.hubConsents().length === 0)
          this.notifier.remoteConsent(0)
        this.emit('app-changed')
        this.emit('remote-changed')
        this.emit('attention-changed')
      },
      // One notification and the one sheet that lists every waiting request, never a window per
      // request (relay.md), so a flood can't bury the screen.
      consentRequested: () => this.consentRequested(),
      consentEnded: (request, answer) => {
        if (answer !== 'expired') return
        this.missed.add({
          of: 'remote-consent',
          id: request.id,
          title: needsYouTitle({ kind: 'remote-consent' }),
          adapterId: null,
          adapterName: null,
          callId: null,
          at: new Date(request.requestedAt).toISOString(),
        })
      },
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
    // Before the endpoint starts: a lock down set before a restart refuses the first call too.
    await this.appState.load()
    await this.openApprovals()
    await this.missed.load()
    await this.keysNotice.load()
    this.scheduleMissedExpiry()
    await this.loadRepairs()
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
    // Check the audit chain once at launch, in the background, so the sidebar says intact or broken
    // rather than "not verified yet" until someone opens the Audit log and clicks Verify.
    this.background = this.background
      .then(async () => {
        this.chain = await this.reader.verify(new Date(this.deps.now()))
        this.emit('audit-verified')
      })
      .catch(() => undefined)
    // Updates first, before any adapter, credential or endpoint: a release that fails further on can
    // still be replaced by the next one.
    await this.startUpdates()
    await this.deps.credentials.configure(this.settingsNow)
    await this.clients.load()
    const host = new ToolHost({
      approvals: this.installGate,
      audit: this.audit,
      prompt: this.broker,
      authRunner: createAuthRunner({
        grants: this.signedGrants,
        credentials:
          this.mail === null
            ? this.deps.credentials
            : { ...this.deps.credentials, mailReader: () => this.mail as MailReader },
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
      budgetStore: new JsonFileStore(paths.budgets),
      clock: { now: this.deps.now },
      ...(this.deps.pacingSleep === undefined ? {} : { pacingSleep: this.deps.pacingSleep }),
      confirmationTimeoutMs: CONFIRMATION_TIMEOUT_MS,
      diagnostics: (d) => this.deps.diagnostics?.(d),
    })
    this.host = host
    if (this.packages !== null && this.deps.packages !== undefined) {
      await mkdir(paths.adapters, { recursive: true, mode: 0o700 })
      this.installed = await this.packages.boot(this.deps.packages.builtins)
    }
    // Before anything is gated by signatures for the first time: what was approved until now.
    await this.recordLegacy()
    for (const adapter of this.installed) {
      const driver = await this.driverFor(adapter)
      host.register(this.registration(adapter, driver))
      this.drivers.set(adapter.definition.manifest.id, driver)
    }
    this.caller = new RuntimeToolCaller(host, {
      paused: () => this.paused,
      lockedDown: () => this.lockedDown,
      sitePaused: (adapterId) => this.appState.sitePaused(adapterId),
      // What a local app turned off for itself with valet_turn_off_tool.
      toolsOff: (identity) =>
        identity.origin === 'local' ? this.clients.toolsOff(identity.clientId) : new Set(),
      explain: (call, outcome) => this.explain(call, outcome),
      started: (call) => {
        this.memory.started(call.callId, call.tool, call.client, call.input)
        if (call.identity !== undefined) this.callers.set(call.callId, identityLabel(call.identity))
        // The token named the client; the transport is the endpoint's label for the session.
        const id = call.identity?.origin === 'local' ? call.identity.clientId : null
        if (id !== null && this.clients.seen(id, call.client, shownTransport(call.transport)))
          this.emit('clients-changed')
      },
      finished: (call, result) => {
        this.callers.delete(call.callId)
        this.memory.finished(call.callId, result.status === 'ok' ? result.output : undefined)
      },
      refused: (call, refusal) => this.auditRefusal(call, refusal),
      protocolRefused: (refusal) => this.auditProtocolRefusal(refusal),
    })
    await this.caller.refresh()
    await this.reapplyInstalls()
    this.authoring = await this.startAuthoring()
    // Reads approval times into the cache the confirmation panel uses.
    await this.states()
    await this.startListening().catch(() => undefined)
    // The same caller: remote calls go through the same pause, runtime and audit as local ones.
    await this.remote
      .start(this.caller, {
        admin: this.adminReader(),
        authoring: this.authoring,
        allowed: (clientId) => {
          try {
            return this.remoteCapabilities(clientId).seeValet
          } catch {
            return false
          }
        },
      })
      .catch(() => undefined)
    // Reports an agent sent while GitHub couldn't be reached, or before the token was there.
    void this.feedback()
      ?.flush()
      .catch(() => undefined)
  }

  /**
   * Turns one of an installed adapter's tools on or off for remote clients. Throws
   * ValetError('config', 'not-found') for a tool the adapter doesn't declare.
   */
  async setRemoteTool(adapterId: string, tool: string, enabled: boolean): Promise<void> {
    const declaration = await this.remoteToolDeclaration(adapterId, tool, enabled)
    await this.remote.setTool(adapterId, declaration, enabled)
  }

  /** The tool's declaration in the adapter in use, unless it is one of its setting tools. */
  private remoteDeclared(adapterId: string, tool: string): ToolDeclaration | null {
    const adapter = this.adapter(adapterId)
    const declaration = adapter?.definition.manifest.tools.find((t) => t.name === tool)
    if (adapter === null || declaration === undefined) return null
    return settingToolNames(adapter.definition.manifest).has(tool) ? null : declaration
  }

  /** The tool as remote access would turn it on or off, or not-found when it can't be. */
  private async remoteToolDeclaration(adapterId: string, tool: string, enabled: boolean) {
    const adapter = this.adapter(adapterId)
    const declaration = adapter?.definition.manifest.tools.find((t) => t.name === tool)
    if (adapter === null || declaration === undefined) throw new ValetError('config', 'not-found')
    // A setting's tool isn't a client's to call, remote or not (remoteSetup leaves it out too).
    if (enabled && settingToolNames(adapter.definition.manifest).has(tool))
      throw new ValetError('config', 'not-found')
    // Turning on is for approved adapters only; turning off always works.
    if (enabled && !(await this.installGate.isApproved(adapterId, adapter.hash).catch(() => false)))
      throw new ValetError('config', 'not-found')
    return declaration
  }

  /** Remote access as set up now: its state, names, and every tool of each approved adapter. */
  async remoteSetup(): Promise<RemoteSetup> {
    const status = this.remote.status()
    const on = new Set(status.tools)
    const tools: RemoteSetupTool[] = []
    for (const adapter of this.installed) {
      const { manifest } = adapter.definition
      if (!(await this.installGate.isApproved(manifest.id, adapter.hash).catch(() => false))) continue
      // A setting's tools (the store's) run only for Valet itself; no client lists or calls them,
      // so a cloud agent can't be given them either.
      const internal = settingToolNames(manifest)
      for (const declaration of manifest.tools) {
        if (internal.has(declaration.name)) continue
        const ref = `${manifest.id}.${declaration.name}`
        tools.push({
          ref,
          adapterId: manifest.id,
          adapterName: manifest.name,
          tool: declaration.name,
          toolTitle: declaration.title,
          sideEffect: declaration.sideEffect,
          enabled: on.has(ref),
        })
      }
    }
    return {
      enabled: status.enabled,
      listening: status.listening,
      url: status.url,
      hosts: status.hosts,
      relayUrl: status.relayUrl,
      tools,
    }
  }

  /**
   * What the phone would be shown and answer, for the e2e suite and the evals in demo builds only
   * (app.ts exposes it under VALET_E2E): the requests waiting, and the person's approval or decline
   * of one as the Mac window gives it.
   */
  e2eRequests(): {
    list(): readonly { readonly requestId: string; readonly kind: string; readonly text: string }[]
    approve(requestId: string): Promise<boolean>
    decline(requestId: string): Promise<boolean>
  } {
    const broker = () => {
      if (this.approvalBroker === null) throw new ValetError('config', 'unavailable')
      return this.approvalBroker
    }
    return {
      list: () =>
        broker()
          .list()
          .map((p) => ({ requestId: p.request.id, kind: p.request.kind, text: p.text })),
      approve: async (requestId) => (await broker().approveOnMac(requestId)).ok,
      decline: (requestId) => broker().decline(requestId, { via: 'mac' }),
    }
  }

  async stop(): Promise<void> {
    this.updates?.stop()
    this.phones.stop()
    if (this.pruneTimer !== null) clearInterval(this.pruneTimer)
    this.pruneTimer = null
    // Calls still running are cancelled: each ends failed tool-run/aborted, its prompt declined.
    this.caller?.cancelAll()
    this.broker.declineAll()
    this.approvalBroker?.stop()
    this.handoffs.closeAll()
    this.mail?.close()
    this.notifier.clear()
    if (this.missedTimer !== null) this.deps.timers.clearTimeout(this.missedTimer)
    if (this.consentTimer !== null) this.deps.timers.clearTimeout(this.consentTimer)
    this.missedTimer = null
    this.consentTimer = null
    await this.missed.flushed()
    await this.remote.close().catch(() => undefined)
    await this.endpoint?.close().catch(() => undefined)
    this.endpoint = null
    for (const driver of this.drivers.values()) await driver.close().catch(() => undefined)
    await this.blocked.settled()
    await this.background
    // Breaker and pacing state still on its way to disk: a quit must not cut the write short.
    await this.host?.flushed()
    this.loginSecrets.dispose()
  }

  /** Whether a confirmation is still waiting (the glue closes windows for ones that aren't). */
  confirmationPending(id: string): boolean {
    return this.broker.has(id)
  }

  /** The ids of the adapters registered now. */
  adapterIds(): string[] {
    return this.installed.map((a) => a.definition.manifest.id)
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
          this.notifier.updateDownloaded(to, this.settingsNow.autoInstallUpdates)
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
      this.installed.map(async (a) => {
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

  private emit(type: Exclude<AppEvent['type'], 'audit-appended' | 'focus-banner'>): void {
    // What waits on the person changed: tell them, in case no window of Valet's is in view. Only
    // what the app holds in memory notifies; the rest (reviews, missing settings and logins) never
    // does, so this needs no file read.
    if (type === 'attention-changed')
      this.notifier.attention([
        ...this.handoffs.list(),
        ...this.broker.list(),
        ...this.repairItems(),
        ...this.missed.list(),
      ])
    this.deps.emit({ type })
  }

  private observe(record: AuditRecord): void {
    this.deps.emit({ type: 'audit-appended', seq: record.seq })
    const { event } = record
    if (event.type === 'breaker-opened')
      this.notifier.breakerOpened(event.host, event.cause, event.retryAt, this.siteName(event.host))
    else if (event.type === 'breaker-closed') this.notifier.breakerClosed(event.host)
    else if (event.type === 'tool-finished' && this.noteFinished(event, record.at))
      this.emit('attention-changed')
    if (this.repairTickets.note(event, record.at)) this.emit('attention-changed')
    for (const type of EVENTS_FOR[record.event.type] ?? [])
      this.emit(type as Exclude<AppEvent['type'], 'audit-appended' | 'focus-banner'>)
  }

  /** The name of the one adapter on a host, for a notification; null when none or several. */
  private siteName(host: string): string | undefined {
    const on = this.installed.filter((a) => {
      const { manifest } = a.definition
      return manifest.navigation.some((origin) => {
        try {
          return new URL(origin).host === host
        } catch {
          return false
        }
      })
    })
    return on.length === 1 ? on[0]?.definition.manifest.name : undefined
  }

  /**
   * Keeps the repair items up to date with a call that finished: a failure only an adapter update
   * fixes raises one, anything else the site answered clears it. The app's own refusals (stage
   * config) say nothing about the site. True when the items changed.
   */
  private noteFinished(event: Extract<AuditEvent, { type: 'tool-finished' }>, at: string): boolean {
    // A refusal before the site was reached (bad input, setup) says nothing about the adapter's health.
    if (event.outcome === 'failed' && (event.stage === 'config' || event.stage === 'tool-input')) return false
    const before = this.repairs.get(event.adapterId)
    if (event.outcome === 'failed' && event.errorClass !== undefined && NEEDS_REPAIR.has(event.errorClass)) {
      this.repairs.set(event.adapterId, { callId: event.callId, errorClass: event.errorClass, at })
      return before?.callId !== event.callId
    }
    if (before === undefined) return false
    this.repairs.delete(event.adapterId)
    return true
  }

  /** The repair items as the audit log stood at launch. */
  private async loadRepairs(): Promise<void> {
    try {
      for (const record of await this.reader.records()) {
        if (record.event.type === 'tool-finished') this.noteFinished(record.event, record.at)
        this.repairTickets.note(record.event, record.at)
      }
    } catch {
      // An unreadable log raises none.
    }
  }

  private repairItems(): RepairItem[] {
    const failing = new Map(this.repairs)
    // A ticket raises the item too: the same failure twice in a row, of any kind a new version fixes.
    for (const t of this.repairTickets.list())
      if (t.state === 'open' && !failing.has(t.adapterId))
        failing.set(t.adapterId, { callId: t.lastCallId, errorClass: t.errorClass, at: t.lastFailedAt })
    return [...failing].flatMap(([adapterId, repair]) => {
      const adapter = this.adapter(adapterId)
      if (adapter === null) return []
      return [
        {
          kind: 'repair',
          id: `rp_${adapterId}`,
          adapterId,
          adapterName: adapter.definition.manifest.name,
          callId: repair.callId,
          errorClass: repair.errorClass as RepairItem['errorClass'],
          at: repair.at,
          repairId: this.repairTickets.openForAdapter(adapterId)?.id ?? null,
        },
      ]
    })
  }

  /** Agents' requests that only the person can answer and no other item shows (agent-requests.ts). */
  private agentRequestItems(): AgentRequestItem[] {
    const now = this.deps.now()
    for (const [id, ask] of this.removalAsks)
      if (Date.parse(ask.expiresAt) <= now || this.adapter(ask.adapterId ?? '') === null)
        this.removalAsks.delete(id)
    const removals = [...this.removalAsks.values()].map(({ asker: _asker, ...item }) => item)
    this.pruneCredentialAsks()
    const credentials = [...this.credentialAsks.values()].map(
      ({ asker: _asker, credential: _credential, adapterHash: _hash, ...item }) => item,
    )
    return [
      ...removals,
      ...credentials,
      ...(this.approvalBroker?.list() ?? []).flatMap((r) => {
        const item = agentRequestItem(r, (id) => this.adapter(id)?.definition.manifest.name ?? null)
        return item === null ? [] : [item]
      }),
    ]
  }

  /** Drops credential asks that ended: expired, or another version (or none) installed. */
  private pruneCredentialAsks(): void {
    const now = this.deps.now()
    for (const [id, ask] of this.credentialAsks) {
      const adapter = this.adapter(ask.adapterId ?? '')
      if (Date.parse(ask.expiresAt) <= now || adapter === null || adapter.hash !== ask.adapterHash)
        this.credentialAsks.delete(id)
    }
  }

  /**
   * Drops an agent's asks that aren't broker requests (removal and credential asks) when the agent
   * goes: disconnected, revoked, or its Ask for changes taken away. Null drops every agent's
   * (lockdown).
   */
  private dropAgentAsks(asker: string | null): void {
    let dropped = false
    for (const asks of [this.removalAsks, this.credentialAsks] as Map<string, { readonly asker: string }>[])
      for (const [id, ask] of asks)
        if (asker === null || ask.asker === asker) {
          asks.delete(id)
          dropped = true
        }
    if (dropped) this.emit('attention-changed')
  }

  /** Drops the asks a grant just answered: every agent's, for that credential and version. */
  private answerCredentialAsks(adapterId: string, adapterHash: string, credential: string): boolean {
    let dropped = false
    for (const [id, ask] of this.credentialAsks)
      if (ask.adapterId === adapterId && ask.adapterHash === adapterHash && ask.credential === credential) {
        this.credentialAsks.delete(id)
        dropped = true
      }
    return dropped
  }

  private consentItems(): RemoteConsentItem[] {
    return this.consentRequests().map((r) => ({
      kind: 'remote-consent',
      id: r.id,
      clientHost: r.clientHost,
      clientName: r.clientName,
      source: r.source,
      requestedAt: r.requestedAt,
      expiresAt: r.expiresAt,
      ...(r.via === undefined ? {} : { via: r.via }),
    }))
  }

  /** Agents' sign-ins waiting at the hub (relay-hub.md, step 3); none while not connected. */
  private hubConsents(): HubConsent[] {
    return this.phones?.hubAgents?.consents() ?? []
  }

  /**
   * Every connection waiting for the person: the Mac's own, then those through the hub. A hub
   * sign-in's id is `hub:<id>`, so declining knows where to send it.
   */
  private consentRequests(): RemoteConsentRequest[] {
    const own = this.remote.consentView().requests.map((r) => ({
      ...r,
      requestedAt: new Date(r.requestedAt).toISOString(),
      expiresAt: new Date(r.expiresAt).toISOString(),
    }))
    const hub = this.hubConsents().map((c) => ({
      id: `hub:${c.id}`,
      clientId: c.clientId,
      clientHost: c.host,
      clientName: c.clientName,
      source: c.source === '' ? null : c.source,
      requestedAt: new Date(c.seenAt).toISOString(),
      expiresAt: new Date(c.expiresAt).toISOString(),
      via: 'hub' as const,
    }))
    return [...own, ...hub]
  }

  /** A connection began waiting: one notification for all of them, and the one sheet. */
  private consentRequested(): void {
    const requests = this.consentRequests()
    const soonest = Math.min(...requests.map((r) => Date.parse(r.expiresAt)))
    this.notifier.remoteConsent(
      requests.length,
      Number.isFinite(soonest) ? new Date(soonest).toISOString() : undefined,
    )
    this.scheduleConsentSweep()
    this.deps.ui.openControlPanel(href.approveConnection())
  }

  /** Missed items drop off after 24 hours even with no window open to read them. */
  private scheduleMissedExpiry(): void {
    if (this.missedTimer !== null) this.deps.timers.clearTimeout(this.missedTimer)
    this.missedTimer = null
    const next = this.missed.nextExpiry()
    if (next === null) return
    this.missedTimer = this.deps.timers.setTimeout(
      () => {
        this.missedTimer = null
        if (this.missed.prune()) {
          this.missed.list()
          this.emit('attention-changed')
        }
        this.scheduleMissedExpiry()
      },
      Math.max(0, next - this.deps.now()) + 50,
    )
  }

  /**
   * A connection request expires only when something reads the list; this reads it as the soonest
   * one runs out, so it becomes a missed item on time.
   */
  private scheduleConsentSweep(): void {
    if (this.consentTimer !== null) this.deps.timers.clearTimeout(this.consentTimer)
    this.consentTimer = null
    const requests = this.remote.consentView().requests
    if (requests.length === 0) return
    const soonest = Math.min(...requests.map((r) => r.expiresAt))
    this.consentTimer = this.deps.timers.setTimeout(
      () => {
        this.consentTimer = null
        this.remote.consentView()
        this.scheduleConsentSweep()
      },
      Math.max(0, soonest - this.deps.now()) + 50,
    )
  }

  /** What the app knows about an outcome that names a Needs you item, for the tool result. */
  private async explain(call: ToolCall, outcome: CallOutcome): Promise<CallOutcome> {
    if (outcome.status === 'needsUser') {
      const hint = await this.needsYouHint(call.adapterId, outcome.reason)
      return hint === null ? outcome : { ...outcome, needsYou: hint }
    }
    if (
      outcome.status === 'failed' &&
      outcome.errorClass === 'not-granted' &&
      outcome.stage === 'secret-fill'
    ) {
      if (await this.loginMissing(call.adapterId)) return { ...outcome, needsYou: { kind: 'login-missing' } }
    }
    return outcome
  }

  private async needsYouHint(adapterId: string, reason: NeedsUserReason): Promise<NeedsYouHint | null> {
    if (reason === 'setting-required') {
      const title = await this.missingSettingTitle(adapterId)
      return title === null ? null : { kind: 'setting-missing', settingTitle: title }
    }
    const handoff = this.handoffs.get(adapterId)
    if (handoff !== null) return { kind: 'login', until: handoff.closesAt }
    // Told once: the call after this one finds the login held as any other.
    if (this.gaveUp.delete(adapterId)) return { kind: 'gave-up' }
    if (reason === 'login-required' && (await this.loginMissing(adapterId))) return { kind: 'login-missing' }
    return this.loginHoldHint(adapterId)
  }

  /**
   * What a login hold means for the agent, when nothing in Needs you is open for it: a backoff
   * waits for a time (nobody is asked), any other hold waits for the person, who hasn't been asked
   * either. Null when there is no hold, and the plain wording applies.
   */
  private async loginHoldHint(adapterId: string): Promise<NeedsYouHint | null> {
    const marker = await this.markers.read(adapterId).catch(() => null)
    if (marker === null || marker.kind === 'unset') return null
    const now = this.deps.now()
    const waiting = (at: number): NeedsYouHint | null =>
      at > now ? { kind: 'login-waiting', retryAt: new Date(at).toISOString() } : null
    if (marker.kind === 'held')
      return marker.retryAt === null ? { kind: 'login-stopped' } : waiting(marker.retryAt)
    // D35: a login that stopped before typing anything holds like a first failure's backoff.
    if (marker.attempted === false && marker.startedAt !== undefined)
      return waiting(marker.startedAt + DEFAULT_LOGIN_BACKOFF.baseMs)
    return { kind: 'login-stopped' }
  }

  /** True when the installed bundle declares a login with no grant for its hash. */
  private async loginMissing(adapterId: string): Promise<boolean> {
    const adapter = this.adapter(adapterId)
    if (adapter === null) return false
    const declared = Object.keys(adapter.definition.manifest.secrets)
    if (declared.length === 0) return false
    const grants = await this.signedGrants.list().catch(() => null)
    if (grants === null) return false
    return declared.some(
      (secret) =>
        !grants.some(
          (g) => g.adapterId === adapterId && g.adapterHash === adapter.hash && g.secret === secret,
        ),
    )
  }

  /** The title of the first required setting with no choice, or null. */
  private async missingSettingTitle(adapterId: string): Promise<string | null> {
    const adapter = this.adapter(adapterId)
    if (adapter === null) return null
    const chosen = await this.adapterSettings.chosen(adapterId).catch(() => null)
    if (chosen === null) return null
    for (const [name, setting] of Object.entries(adapter.definition.manifest.settings))
      if (setting.required && !Object.hasOwn(chosen, name)) return setting.title
    return null
  }

  /**
   * Lock down (IA 2.10): every call is refused from now on, a confirmation still waiting is
   * declined, and every cloud agent is revoked; remote access stays as the person set it, so its
   * agents get the locked-down answer too, and are asked to connect again. Unlocking lets calls
   * through; nothing revoked comes back.
   */
  private async setLockedDown(locked: boolean): Promise<void> {
    if (!locked) {
      // Unlocking needs the person at this Mac: a signed `resume`, Touch ID in a packaged app. A
      // phone can lock down but never unlock, and neither can a click on its own. The handler
      // (approvalHandlers) clears the switch once the decision is signed.
      if (!this.lockedDown) return
      // The helper may have been slow at launch: try again before refusing.
      if (this.approvalBroker === null) await this.openApprovals()
      const broker = this.approvalBroker
      if (broker === null) throw new ValetError('config', 'unavailable')
      const asked = await broker.request('resume', { from: 'lockdown' }, { kind: 'person' })
      if (!asked.ok) throw new ValetError('config', 'unavailable')
      const answered = await broker.approveOnMac(asked.requestId)
      // Cancelled at the prompt: still locked, and the request is withdrawn rather than left
      // waiting. A second click while the first prompt is open leaves that prompt alone.
      if (!answered.ok && answered.reason !== 'busy') {
        await broker.withdraw(asked.requestId, { kind: 'person' }).catch(() => false)
      }
      return
    }
    // In memory at once: no call gets through while the rest happens, even if a write fails.
    const saved = this.appState.setLockedDown(true)
    this.authoring?.closeBrowsers()
    // Lockdown ends every lent session and private address (B).
    this.authoringSessions.clear()
    this.privateNetwork.clear()
    const ledger = this.approvalBroker?.lockdown().catch(() => undefined)
    this.dropAgentAsks(null)
    let revoked = 0
    if (locked) {
      this.broker.declineAll()
      revoked = await this.remote.revokeAllClients().catch(() => 0)
    }
    await ledger
    await saved
    await this.audit.append({ type: 'lock-down', locked: true, revokedClients: revoked })
  }

  /**
   * Locked down by the person's switch (app-state.json), or by the ledger: a phone's lockdown, or a
   * ledger that didn't match its anchor at launch. Either keeps every call refused.
   */
  private get lockedDown(): boolean {
    // No ledger at all (it couldn't be opened): locked, so nothing it might have held is lost.
    return this.appState.lockedDown || (this.ledger?.data.safety.lockdown ?? true)
  }

  /**
   * Opens the trusted ledger, then the approval broker. The ledger opens first and on its own: a
   * failure to read the Mac's keys leaves approvals unavailable, never the ledger's lockdown lifted.
   */
  private async openApprovals(): Promise<void> {
    const keys = this.deps.approvalKeys
    if (this.ledger === null) {
      this.ledger = await TrustedLedger.open(
        new AnchoredFile(this.deps.paths.trusted, TRUSTED_STORE, keys.anchor),
      )
      if (this.ledger.tampered !== null)
        this.deps.diagnostics?.({ type: `approvals-ledger-${this.ledger.tampered}` })
    }
    const ledger = this.ledger
    try {
      const devices = new DeviceStore(ledger, await keys.signer.keys())
      this.deviceStore = devices
      this.approvalBroker = await ApprovalBroker.open({
        ledger,
        devices,
        signer: keys.signer,
        audit: this.audit,
        handlers: this.approvalHandlers(),
        outbox: this.phones,
        now: this.deps.now,
        timers: this.deps.timers,
        onChange: () => {
          this.emit('app-changed')
          this.emit('attention-changed')
          this.emit('approvals-changed')
          this.tidyDraftsSoon()
        },
      })
      // New keys (lost, or made again) void what the old ones signed. Nothing of it counts; the
      // diagnostics log and Needs you (keysChangedItems) say why.
      if (signedByOldKeys(ledger.data.evidence, devices.macId) !== null)
        this.deps.diagnostics?.({ type: 'approval-keys-changed' })
      await this.openPhones(this.approvalBroker, devices, ledger)
    } catch {
      this.approvalBroker = null
      this.deps.diagnostics?.({ type: 'approvals-unavailable' })
    }
  }

  /** Null where the signer can't say (a software signer, whose keys aren't affected). */
  private async keysWorkLocked(): Promise<boolean | null> {
    const signer = this.deps.approvalKeys.signer
    if (signer.worksLocked === undefined) return null
    return signer.worksLocked().catch(() => null)
  }

  /**
   * Keys made before they could work while locked can't be changed, only replaced. Every phone
   * was paired with the old agreement key, so each is removed first (told, and refused by the
   * relay); the relay binding is signed again for the new transport key after the restart.
   */
  private async renewKeys(): Promise<void> {
    const signer = this.deps.approvalKeys.signer
    const devices = this.deviceStore
    if (signer.rotateChannel === undefined || devices === null) throw new ValetError('config', 'not-found')
    // Phones paired here only: one on the account's list stays on it (revoking it here would
    // take it off the account).
    for (const phone of devices.activePhones().filter((p) => !devices.isAccountPhone(p.deviceId))) {
      this.phones.unpair(phone.deviceId)
      await devices.revoke(phone.deviceId, 'mac-ui', new Date(this.deps.now()).toISOString())
      await this.audit.append({ type: 'device-revoked', deviceId: phone.deviceId, by: 'mac-ui' })
    }
    await signer.rotateChannel()
    await this.audit.append({ type: 'device-keys-renewed' })
    this.emit('phones-changed')
    this.deps.ui.relaunch?.()
  }

  /** Starts the relay connection and the phone channel, once the broker is open. */
  private async openPhones(
    broker: ApprovalBroker,
    devices: DeviceStore,
    ledger: TrustedLedger,
  ): Promise<void> {
    try {
      await this.phones.setRelay(await this.relaySetup())
      await this.phones.open({
        broker,
        devices,
        signer: this.deps.approvalKeys.signer,
        safety: {
          pauseRemote: async () => {
            await broker.pauseRemote()
            this.emit('app-changed')
          },
          lockdown: () => this.setLockedDown(true),
          revokeClient: async (clientId) => void (await this.remote.revokeClient(clientId)),
          revokeDevice: async (deviceId, by) => {
            if (await devices.revoke(deviceId, by, new Date(this.deps.now()).toISOString())) {
              this.phones.unpair(deviceId)
              await this.audit.append({ type: 'device-revoked', deviceId, by })
              void this.phones.rosterChanged().catch(() => undefined)
            }
          },
        },
        approvePairing: async (pair) => {
          const asked = await broker.request('device-pair', { ...pair, platform: 'ios' }, { kind: 'person' })
          if (!asked.ok) return false
          const answered = await broker.approveOnMac(asked.requestId)
          if (!answered.ok && answered.reason !== 'busy')
            await broker.withdraw(asked.requestId, { kind: 'person' }).catch(() => false)
          return answered.ok
        },
        paired: async (record) => {
          await this.audit.append({ type: 'device-paired', deviceId: record.deviceId, platform: 'ios' })
          await this.refreshPhoneStatus()
        },
        status: () => this.phoneStatus ?? undefined,
        hubConsents: (opened) => {
          if (opened) this.consentRequested()
          else if (this.remote.status().pendingConsents + this.hubConsents().length === 0)
            this.notifier.remoteConsent(0)
          this.emit('remote-changed')
          this.emit('attention-changed')
        },
        ledger,
        removedFromAccount: async (deviceId, by) => {
          if (await devices.revoke(deviceId, by, new Date(this.deps.now()).toISOString())) {
            this.phones.unpair(deviceId)
            await this.audit.append({ type: 'device-revoked', deviceId, by })
            this.emit('phones-changed')
            await this.refreshPhoneStatus()
          }
        },
        now: this.deps.now,
      })
      await this.refreshPhoneStatus()
    } catch {
      this.deps.diagnostics?.({ type: 'phones-unavailable' })
    }
  }

  /** What the phone's tabs show: the sites, the agents, the devices. */
  private async refreshPhoneStatus(): Promise<void> {
    const sites = await this.api.adapters.list().catch(() => [])
    const devices = this.deviceStore
    this.phoneStatus = {
      at: new Date(this.deps.now()).toISOString(),
      safety: this.lockedDown ? 'lockdown' : this.paused ? 'paused' : 'running',
      sites: sites.slice(0, 50).map((a) => ({
        adapterId: a.id,
        name: a.name.slice(0, 80),
        health: a.paused ? 'paused' : a.approval === 'approved' ? 'ok' : 'needs-you',
      })),
      agents: [],
      devices:
        devices === null
          ? []
          : [devices.mac, ...devices.activePhones()].slice(0, 10).map((d) => ({
              deviceId: d.deviceId,
              name: d.deviceId === devices.macId ? (this.deps.macName ?? 'This Mac') : d.name,
              platform: d.platform,
              lastSeenAt: null,
            })),
      recent: [],
    }
    this.phones.statusChanged()
  }

  /**
   * The kinds this app can act on once approved. Anything else an agent asks for isn't available
   * yet (E's admin tools check this before filing a request).
   */
  wiredKinds(): ReadonlySet<ApprovalKind> {
    return new Set(Object.keys(this.approvalHandlers()) as ApprovalKind[])
  }

  /** What each approved kind does here. Kinds not listed aren't wired yet and do nothing. */
  private approvalHandlers(): KindHandlers {
    return {
      // Pairing: the phone channel signs the records once the person approved (phone-channel.ts).
      'device-pair': {
        precheck: (subject) => {
          const pairing = this.phones.status().pairing
          return pairing.step === 'approving' && pairing.deviceName === subject.deviceName
        },
      },
      // The subject names its confirmation, so an approval applies to the one question it was
      // signed for, never another of the same call.
      'irreversible-call': {
        precheck: (subject) => this.broker.waiting(subject.confirmationId),
        apply: async (subject) => {
          if (!this.broker.approvedById(subject.confirmationId)) throw new ValetError('config', 'not-found')
        },
      },
      'adapter-install': {
        // A rollback is applied by rollbackNow itself, after the swap. A staged draft (an update
        // an agent submitted while the approved version keeps serving) is fresh while it is still
        // stored and the version it replaces is still the one active. Anything else is the
        // version installed now, and stale if that changed.
        precheck: async (subject) => {
          // A card that said the session stays behind is stale once there is one to inherit.
          if (
            subject.previousHash !== null &&
            !subject.inheritsSession &&
            (await this.inheritsSession(subject.adapterId))
          )
            return false
          if (subject.source === 'rollback') return true
          const active = this.adapter(subject.adapterId)
          if (active?.hash === subject.adapterHash) return true
          return (
            subject.source === 'draft' &&
            active !== null &&
            active.hash === subject.previousHash &&
            (await this.isStored(subject.adapterId, subject.adapterHash))
          )
        },
        apply: async (subject) => {
          if (subject.source === 'rollback') return
          if (this.adapter(subject.adapterId)?.hash === subject.adapterHash) {
            await this.applyInstall(subject.adapterId, subject.adapterHash)
            // An agent's request has no signInstall around it to retire the others; that revokes
            // through the broker, so after its lock is let go.
            if (subject.source === 'draft') {
              const { adapterId, adapterHash } = subject
              this.staging = this.staging
                .then(() => this.retireOthers(adapterId, adapterHash))
                .catch(() => undefined)
            }
          } else if (subject.source === 'draft') this.finishStagedSoon(subject.adapterId, subject.adapterHash)
        },
        // One approved hash per adapter: a new approval replaces the evidence of the last. Not a
        // rollback's or a staged draft's, until its swap has worked (rollbackNow, finishStaged), so
        // a failed swap leaves the running version approved.
        supersedes: (next, older) =>
          next.source !== 'rollback' &&
          next.adapterId === older.adapterId &&
          this.adapter(next.adapterId)?.hash === next.adapterHash,
      },
      // The person's own grant (grants.make) stores the grant once signed; the gate then reads
      // this evidence (grantSigned). Stale once the version it names isn't the one installed.
      'secret-grant': {
        precheck: (subject) => this.adapter(subject.adapterId)?.hash === subject.adapterHash,
        // One grant per secret: a new one replaces the evidence of the last.
        // Per version (a rollback brings the old version's grants back), and per sender for Messages.
        supersedes: (next, older) =>
          next.adapterId === older.adapterId &&
          next.adapterHash === older.adapterHash &&
          next.secret === older.secret &&
          (next.secret !== MESSAGES_SECRET || next.itemFingerprint === older.itemFingerprint),
      },
      // A credential grant (secrets v2): stored by credentialKeeper.make once signed; each call's
      // gate reads this evidence. Stale once the version it names isn't the one installed.
      'credential-grant': {
        precheck: (subject) => this.adapter(subject.adapterId)?.hash === subject.adapterHash,
        // One grant per credential and version: a new one replaces the evidence of the last.
        supersedes: (next, older) =>
          next.adapterId === older.adapterId &&
          next.adapterHash === older.adapterHash &&
          next.credential === older.credential,
      },
      // Valet's own settings, or an adapter's setting picked on the card (E's admin tools ask;
      // the person's own paths ask too, through changeValetSetting).
      setting: {
        precheck: (subject) => {
          // One cloud agent's Ask for changes: still an approved agent, and only ever turned on.
          const asker = subject.scope === 'valet' ? remoteAskClient(subject.setting) : null
          if (asker !== null) return subject.to === 'On' && this.remote.clients.get(asker)?.grant != null
          if (subject.scope === 'adapter') {
            const adapter = subject.adapterId === null ? null : this.adapter(subject.adapterId)
            return adapter !== null && Object.hasOwn(adapter.definition.manifest.settings, subject.setting)
          }
          if (!Object.hasOwn(WIDENING_SETTINGS, subject.setting)) return false
          const name = subject.setting as WideningSetting
          const to = settingValue(name, subject.to)
          // Still the change it was asked as: from the value set now, to a value read back exactly.
          return to !== null && settingSubject(name, this.valetSetting(name).get(), to).from === subject.from
        },
        apply: async (subject, evidence) => {
          // The evidence is the grant (remoteCapabilities reads it); its next session has the tools.
          const asker = subject.scope === 'valet' ? remoteAskClient(subject.setting) : null
          if (asker !== null) {
            await this.remote.reopenClient(asker).catch(() => undefined)
            this.emit('remote-changed')
            return
          }
          if (subject.scope === 'adapter') {
            const value = evidence === null ? undefined : decisionChoice(evidence.decision.payload)
            // From the signed card's own list (the decision was checked against it), not the
            // picker's latest lookup, which another search or a restart may have replaced.
            const picked = subject.choices?.find((c) => c.value === value)
            if (subject.adapterId === null || picked === undefined) throw new ValetError('config', 'invalid')
            await this.storeSetting(subject.adapterId, subject.setting, {
              value: picked.value,
              label: picked.label,
            })
            return
          }
          const name = subject.setting as WideningSetting
          const to = settingValue(name, subject.to)
          if (to === null) throw new ValetError('config', 'invalid')
          if (name === 'remote_hosts') {
            const hosts = this.remote.status().hosts
            if (!hosts.includes(String(to))) await this.remote.setHosts([...hosts, String(to)])
            return
          }
          await this.valetSetting(name).set(to)
        },
        supersedes: (next, older) =>
          next.scope === older.scope && next.adapterId === older.adapterId && next.setting === older.setting,
      },
      // A tool turned on for remote clients (all of them; one client's own list is consent's).
      'tool-enable': {
        precheck: (subject) => {
          if (subject.scope !== 'remote' || this.adapter(subject.adapterId)?.hash !== subject.adapterHash)
            return false
          if (subject.clientId === null) return true
          // One cloud agent's own (valet_request_tool): an approved agent without the tool yet.
          const client = remoteClientKey(subject.clientId)
          const declaration = this.remoteDeclared(subject.adapterId, subject.tool)
          return (
            client !== null &&
            declaration !== null &&
            declaration.sideEffect === subject.sideEffect &&
            this.remote.canRequestForClient(subject.adapterId, declaration, client)
          )
        },
        apply: async (subject) => {
          if (subject.clientId === null) return this.setRemoteTool(subject.adapterId, subject.tool, true)
          const client = remoteClientKey(subject.clientId)
          const declaration = this.remoteDeclared(subject.adapterId, subject.tool)
          if (client === null || declaration === null) throw new ValetError('config', 'not-found')
          // The person approved this tool for this agent: it is on for cloud agents from now on
          // (each still needs it in its own grant), then in this agent's grant.
          if (!this.remote.allows(subject.adapterId, declaration))
            await this.setRemoteTool(subject.adapterId, subject.tool, true)
          if (!(await this.remote.allowForClient(subject.adapterId, declaration, client)))
            throw new ValetError('config', 'not-found')
        },
        supersedes: (next, older) =>
          next.adapterId === older.adapterId &&
          next.tool === older.tool &&
          next.scope === older.scope &&
          next.clientId === older.clientId,
      },
      // A remote client's consent, approved with the code the person typed from their browser.
      'remote-client': {
        precheck: (subject) =>
          this.remote.consentView().requests.some((r) => `remote:${r.clientId}` === subject.clientId),
        apply: async (subject, evidence) => {
          const code = evidence === null ? undefined : decisionTypedCode(evidence.decision.payload)
          if (code === undefined) throw new ValetError('config', 'invalid')
          const answer = await this.remote.approveConsent(code, subject.tools)
          if (answer !== 'approved') throw new ValetError('config', 'not-found')
        },
        // A client approved again keeps only what this approval ticked.
        supersedes: (next, older) => next.clientId === older.clientId,
      },
      // A draft's live trials may use the adapter's signed-in session for a while (D81).
      'authoring-session': {
        precheck: async (subject) => {
          const record = await this.drafts.record(subject.draftId).catch(() => null)
          return (
            record !== null &&
            record.adapterId === subject.adapterId &&
            this.adapter(subject.adapterId) !== null
          )
        },
        apply: async (subject) => {
          this.authoringSessions.set(subject.draftId, {
            adapterId: subject.adapterId,
            until: this.deps.now() + subject.minutes * 60_000,
          })
          const name = this.adapter(subject.adapterId)?.definition.manifest.name ?? subject.adapterId
          this.notifier.draftActivity(
            `An agent’s draft may try ${name} with your session for ${subject.minutes} minutes. End it from the draft’s page.`,
          )
          this.emit('drafts-changed')
        },
      },
      // A draft's scratch browser and live trials may reach one private address for a while (R21).
      'private-network': {
        precheck: async (subject) => (await this.drafts.record(subject.draftId).catch(() => null)) !== null,
        apply: async (subject) => {
          const until = this.deps.now() + subject.minutes * 60_000
          const now = this.deps.now()
          const kept = (this.privateNetwork.get(subject.draftId) ?? []).filter((g) => g.until > now)
          kept.push({ address: subject.address.toLowerCase(), port: subject.port, until })
          this.privateNetwork.set(subject.draftId, kept.slice(-5))
          this.notifier.draftActivity(
            `An agent’s draft may reach ${subject.address} on your network for ${subject.minutes} minutes.`,
          )
        },
      },
      resume: {
        precheck: (subject) =>
          subject.from === 'lockdown' ? this.lockedDown : (this.approvalBroker?.isRemotePaused() ?? false),
        supersedes: () => true,
        apply: async (subject) => {
          if (subject.from !== 'lockdown') return
          await this.audit.append({ type: 'lock-down', locked: false, revokedClients: 0 })
          await this.appState.setLockedDown(false)
          this.emit('app-changed')
        },
      },
    }
  }

  /** The approval broker's side of each confirmation the runtime asks for (confirmations.ts). */
  private confirmationSigning(): ConfirmationSigning {
    const app = { kind: 'app' } as const
    return {
      open: async (item) => {
        const broker = this.approvalBroker
        if (broker === null) return null
        const siteName = shown(item.adapterName, 80)
        const toolTitle = shown(item.toolTitle, 80)
        const asked = await broker.request(
          'irreversible-call',
          {
            adapterId: item.adapterId,
            adapterHash: item.adapterHash,
            tool: item.tool,
            callId: item.callId,
            confirmationId: item.id,
            ...confirmationPreview(item),
          },
          app,
          {
            // The calling agent's: refused while it is cooling down, and a decline counts against it.
            ...(this.callers.has(item.callId) ? { onBehalfOf: this.callers.get(item.callId) as string } : {}),
            display: {
              ...(shown(item.client, 100) === undefined
                ? {}
                : { client: { label: shown(item.client, 100) as string, badge: 'local' as const } }),
              fromAdapter: {
                ...(siteName === undefined ? {} : { siteName }),
                ...(toolTitle === undefined ? {} : { toolTitles: { [item.tool]: toolTitle } }),
              },
            },
          },
        )
        return asked.ok ? { requestId: asked.requestId, ref: asked.ref } : null
      },
      approve: async (requestId) => {
        const broker = this.approvalBroker
        if (broker === null) return 'refused'
        const answered = await broker.approveOnMac(requestId)
        if (answered.ok) return 'approved'
        return answered.reason === 'cancelled' ? 'cancelled' : 'refused'
      },
      // The person's Decline on the panel is their decline of the signed request: audited as
      // declined from this Mac, and counted against the agent the call was for.
      decline: (requestId) => {
        void this.approvalBroker?.decline(requestId, { via: 'mac' }).catch(() => false)
      },
      withdraw: (requestId, why) => {
        void this.approvalBroker
          ?.withdraw(requestId, app, why === 'unanswered' ? 'asker' : why)
          .catch(() => false)
      },
    }
  }

  /**
   * Ends, as revoked, the confirmations waiting for one agent's calls (`local:<id>` or
   * `remote:<id>`): their requests are withdrawn as client-revoked, and each call ends at once.
   */
  private cancelConfirmationsOf(label: string): void {
    this.broker.cancelWhere((item) => this.callers.get(item.callId) === label, 'client-revoked')
    this.dropAgentAsks(label)
  }

  private async setSitePaused(adapterId: string, paused: boolean): Promise<void> {
    this.requireAdapter(adapterId)
    await this.appState.setSitePaused(adapterId, paused)
    await this.audit.append({ type: 'site-paused', adapterId, paused })
  }

  private async driverFor(adapter: BuiltinAdapter): Promise<SessionDriver> {
    const id = adapter.definition.manifest.id
    // An adapter that opens no pages gets no browser at all: ctx.http is its only way out.
    if (runtimeOf(adapter.definition.manifest) !== 'browser') return noBrowserDriver()
    return this.deps.createDriver(adapter.definition.manifest, {
      onBlocked: this.blocked.betweenRuns(id),
      onAuthBlocked: this.blocked.authPartition(id),
      onAuthReportsDropped: () => this.deps.diagnostics?.({ type: 'auth-reports-dropped', adapterId: id }),
    })
  }

  private registration(adapter: BuiltinAdapter, driver: SessionDriver) {
    const manifest = adapter.definition.manifest
    const sandbox = this.deps.sandbox
    // Unsandboxed only when the manifest says so, and then it was approved as such (docs/sandbox.md).
    const sandboxed = (manifest.sandbox ?? DEFAULT_SANDBOX).mode === 'sandboxed'
    const start =
      sandbox !== undefined && sandboxed ? sandbox.forAdapter(adapter.hash) : this.deps.toolProcess
    const kind = runtimeOf(manifest)
    if (kind === 'raw') return this.rawRegistration(adapter, driver)
    return {
      definition: adapter.definition,
      bundleHash: adapter.hash,
      driver,
      // Each call's CredentialGate finds this version's signed grants (secrets v2).
      credentialGrants: this.credentialKeeper.sourceFor(manifest.id, adapter.hash),
      ...(this.deps.egress === undefined || kind !== 'http' ? {} : { http: this.deps.egress(manifest) }),
      ...(this.deps.imap === undefined ||
      runtimeOf(manifest) !== 'protocol' ||
      manifest.protocols?.imap === undefined
        ? {}
        : { imap: this.deps.imap(manifest.protocols.imap) }),
      ...(this.deps.sftp === undefined ||
      runtimeOf(manifest) !== 'protocol' ||
      manifest.protocols?.sftp === undefined
        ? {}
        : { sftp: this.deps.sftp(manifest.protocols.sftp) }),
      ...(this.deps.smtp === undefined ||
      runtimeOf(manifest) !== 'protocol' ||
      manifest.protocols?.smtp === undefined
        ? {}
        : { smtp: this.deps.smtp(manifest.protocols.smtp) }),
      ...(start === undefined || adapter.toolScript === null
        ? {}
        : {
            isolation: {
              script: adapter.toolScript,
              start,
              ...(sandbox === undefined ? {} : { local: sandbox.local(manifest) }),
            },
          }),
    }
  }

  /**
   * A raw adapter's registration (docs/adapter-kinds.md#raw): its Node bundle runs only in the Node
   * runtime, its network only through the broker's tunnels for its endpoints. Without either, it
   * registers with no runtime at all and its calls are unavailable; it never falls back to another.
   */
  private rawRegistration(adapter: BuiltinAdapter, driver: SessionDriver) {
    const manifest = adapter.definition.manifest
    const raw = this.deps.raw
    const broker = this.deps.egress?.({
      egress: [],
      privateHosts: manifest.privateHosts ?? [],
      endpoints: manifest.endpoints ?? [],
    })
    const tunnels = broker?.tunnels
    return {
      definition: adapter.definition,
      bundleHash: adapter.hash,
      driver,
      // Entrusted credentials come through this version's signed grants (secrets v2).
      credentialGrants: this.credentialKeeper.sourceFor(manifest.id, adapter.hash),
      ...(raw === undefined || tunnels === undefined || adapter.toolScript === null
        ? {}
        : {
            raw: {
              script: adapter.toolScript,
              start: (openTunnels: OpenTunnels) => raw.start(manifest, openTunnels),
              tunnels: (run: RunContext, options: { readonly admit: () => Promise<void> }) =>
                tunnels.call(broker, run, options),
            },
          }),
    }
  }

  /** The hashes the store must keep for an adapter: the approved one and any a grant names. */
  private async keepHashes(adapterId: string): Promise<ReadonlySet<string>> {
    const keep = new Set<string>(await this.approvals.approvedHashes(adapterId).catch(() => []))
    for (const grant of await this.grants.list().catch(() => [] as readonly Grant[]))
      if (grant.adapterId === adapterId) keep.add(grant.adapterHash)
    // A draft waiting for the person, staged or installed: its version must still be there.
    for (const request of this.draftRequests(adapterId)) keep.add(request.subject.adapterHash)
    return keep
  }

  /**
   * Swaps `next` in for whatever version of its adapter is registered now: the runtime takes the
   * adapter's lock (running calls finish first, queued ones are told to retry), then the old
   * driver closes. Refused while the person is in the middle of a login for it, since the login
   * window belongs to the old driver.
   */
  private async swapIn(next: BuiltinAdapter): Promise<void> {
    const host = this.runtime()
    const id = next.definition.manifest.id
    if (this.handoffs.has(id)) throw new InstallError('Finish or cancel the login for this site first.')
    const previous = this.drivers.get(id)
    const driver = await this.driverFor(next)
    try {
      await host.replace(this.registration(next, driver))
    } catch (error) {
      await driver.close().catch(() => undefined)
      throw error instanceof ValetError && error.errorClass === 'busy'
        ? new InstallError('The site is busy with calls; try again in a minute.')
        : error
    }
    // Only now: until the swap is done, a login window or a blocked report finds the old driver.
    this.drivers.set(id, driver)
    await previous?.close().catch(() => undefined)
    const at = this.installed.findIndex((a) => a.definition.manifest.id === id)
    if (at === -1) this.installed.push(next)
    else this.installed[at] = next
    await this.refreshTools()
    this.emit('adapters-changed')
  }

  /**
   * Installs a package (docs/adapter-packages.md#install-update-and-rollback). The new version
   * starts unapproved, so its tools stay hidden until the person approves it with the permission
   * diff. Throws InstallError.
   */
  async installPackage(
    files: PackageFiles,
    source: 'folder' | 'draft',
  ): Promise<{ adapterId: string; hash: string }> {
    const packages = this.packages
    if (packages === null) throw new InstallError('This build cannot install adapters.')
    const prepared = await packages.prepare(files, source)
    const { adapter } = prepared
    const id = adapter.definition.manifest.id
    await this.oneAtATime(id, async () => {
      // Stored and audited only once it is the version running, so a refused swap changes nothing.
      await this.swapIn(adapter)
      await packages.commit(prepared)
    })
    return { adapterId: id, hash: adapter.hash }
  }

  /** Runs `change` after any other install or rollback of the same adapter has finished. */
  private oneAtATime<T>(adapterId: string, change: () => Promise<T>): Promise<T> {
    const before = this.changing.get(adapterId) ?? Promise.resolve()
    const run = before.catch(() => undefined).then(change)
    const settled = run.catch(() => undefined)
    this.changing.set(adapterId, settled)
    void settled.then(() => {
      if (this.changing.get(adapterId) === settled) this.changing.delete(adapterId)
    })
    return run
  }

  /** Whether the person can remove this site: one that isn't built in, in a build with a store. */
  canRemove(adapterId: string): boolean {
    return this.packages !== null && this.adapter(adapterId) !== null && !this.packages.isBuiltinId(adapterId)
  }

  /**
   * Removes a site that isn't built in (docs/adapter-packages.md, "Removing a site"): its tools go
   * from every listing, then its stored versions, approvals and their evidence, logins, settings and
   * browser data. Only tightens, so the person's click (or their yes to an agent's ask) is enough;
   * nothing is signed. Throws InstallError.
   */
  removeAdapter(adapterId: string, clientId: string | null = null): Promise<void> {
    return this.oneAtATime(adapterId, async () => {
      const adapter = this.requireAdapter(adapterId)
      const packages = this.packages
      if (packages === null || packages.isBuiltinId(adapterId))
        throw new InstallError('A built-in site can’t be removed. Pause it instead.')
      if (this.handoffs.has(adapterId))
        throw new InstallError('Finish or cancel the login for this site first.')
      try {
        await this.runtime().remove(adapterId)
      } catch (error) {
        throw error instanceof ValetError && error.errorClass === 'busy'
          ? new InstallError('The site is busy with calls; try again in a minute.')
          : error
      }
      const driver = this.drivers.get(adapterId)
      this.drivers.delete(adapterId)
      this.installed = this.installed.filter((a) => a.definition.manifest.id !== adapterId)
      await driver?.close().catch(() => undefined)
      await this.refreshTools()
      // Waiting requests about it end; its approvals and their evidence go.
      await this.approvalBroker?.withdrawAdapter(adapterId).catch(() => 0)
      await this.approvalBroker?.revoke('adapter-install', (s) => s.adapterId === adapterId).catch(() => 0)
      // Its credential grants, their evidence, and Valet-made keys nothing else uses.
      await this.credentialKeeper.revokeAdapter(adapterId).catch(() => undefined)
      await this.ledger
        ?.commit(
          (draft) => {
            if (draft.legacy !== undefined)
              draft.legacy.installs = draft.legacy.installs.filter((l) => l.adapterId !== adapterId)
          },
          { tightening: true },
        )
        .catch(() => undefined)
      await this.approvals.forget(adapterId).catch(() => undefined)
      // Its logins: the grants, their evidence, and a Keychain copy nothing else uses.
      const before = await this.grants.list().catch(() => [] as readonly Grant[])
      for (const secret of new Set(before.filter((g) => g.adapterId === adapterId).map((g) => g.secret))) {
        await this.revokeGrantEvidence(adapterId, secret).catch(() => undefined)
        await this.grants.revoke(adapterId, secret).catch(() => undefined)
      }
      const after = await this.grants.list().catch(() => [] as readonly Grant[])
      for (const gone of before.filter((g) => g.adapterId === adapterId && g.provider === 'keychain-copy')) {
        if (!after.some((g) => g.provider === 'keychain-copy' && g.itemRef === gone.itemRef))
          await this.deps.credentials.forgetCopy(gone.itemRef).catch(() => {})
      }
      for (const setting of Object.keys(await this.adapterSettings.chosen(adapterId).catch(() => ({}))))
        await this.adapterSettings.clear(adapterId, setting).catch(() => undefined)
      await packages.remove(adapterId)
      await this.deps.ui.clearSiteData?.(adapterId).catch(() => undefined)
      await this.audit.append({
        type: 'adapter-removed',
        adapterId,
        adapterHash: adapter.hash,
        version: adapter.definition.manifest.version,
        clientId,
      })
      this.emit('adapters-changed')
      this.emit('grants-changed')
      this.emit('attention-changed')
    })
  }

  /**
   * The stored versions of one adapter, newest first, each with whether a rollback to it is
   * offered: a version the person approved and never rejected afterwards, by the audit chain,
   * that isn't the one active now.
   */
  async adapterVersions(adapterId: string): Promise<AdapterVersions> {
    const active = this.requireAdapter(adapterId)
    const state = this.packages === null ? null : await this.packages.versions(adapterId)
    const records = await this.reader.records()
    const eligible = rollbackEligible(records, adapterId)
    const versions = [...(state?.versions ?? [])].reverse().map((v) => ({
      hash: v.hash,
      version: v.version,
      source: v.source,
      installedAt: v.installedAt,
      appVersion: v.build.appVersion,
      active: v.hash === active.hash,
      canRollBack: v.hash !== active.hash && eligible.has(v.hash),
    }))
    return { adapterId, pinned: state?.pinned ?? false, versions }
  }

  /**
   * What a rollback to `hash` would change, against the version active now (B's review, point 3):
   * the permission diff, and the grants that come back with it.
   */
  async rollbackPreview(adapterId: string, hash: string): Promise<RollbackPreview> {
    const target = await this.rollbackTarget(adapterId, hash)
    const active = this.requireAdapter(adapterId)
    const grants = (await this.grants.list().catch(() => [] as readonly Grant[])).filter(
      (g) => g.adapterId === adapterId && g.adapterHash === hash,
    )
    const changes = permissionDiff(active.definition.manifest, target.definition.manifest)
    return {
      adapterId,
      hash,
      version: target.definition.manifest.version,
      changes,
      widens: addsPermissions(changes),
      grants: grants.map((g) => g.secret),
    }
  }

  /**
   * Rolls back to a stored version the person approved before. The click in the app is the
   * approval: audited as adapter-approved (with the hash it replaces) and adapter-activated. Its
   * grants come back exactly as the grant store still holds them; a revoked one stays revoked.
   */
  rollback(adapterId: string, hash: string): Promise<void> {
    return this.oneAtATime(adapterId, () => this.rollbackNow(adapterId, hash))
  }

  private async rollbackNow(adapterId: string, hash: string): Promise<void> {
    const target = await this.rollbackTarget(adapterId, hash)
    const active = this.requireAdapter(adapterId)
    // The person approves the rollback with Touch ID first; nothing is swapped without it.
    if (!(await this.signInstall(target, 'rollback', active)))
      throw new InstallError('Not rolled back: the approval was cancelled.')
    try {
      await this.swapIn(target)
    } catch (error) {
      await this.revokeInstall(adapterId, hash, { legacy: false })
      throw error
    }
    const version = target.definition.manifest.version
    const already = (await this.approvals.approvedHashes(adapterId)).includes(hash)
    await this.approvals.approve(adapterId, hash, version)
    // The click is the decision even when the hash was still the approved one (an update installed
    // but never approved), so it is audited either way.
    if (already)
      await this.audit.append({
        type: 'adapter-approved',
        adapterId,
        adapterHash: hash,
        version,
        previousHash: hash,
      })
    const at = new Date(this.deps.now()).toISOString()
    await this.snapshots.put(adapterId, target, at)
    this.approvedAt.set(`${adapterId}:${hash}`, at)
    await this.packages?.activate(adapterId, hash)
    await this.audit.append({
      type: 'adapter-activated',
      adapterId,
      adapterHash: hash,
      version,
      previousHash: active.hash,
    })
    // Swapped and applied: the version it replaces loses its approval, as any signed install's
    // would. Last, so the rolled-back version reads as approved as soon as it is in use.
    await this.retireOthers(adapterId, hash)
    await this.refreshTools()
  }

  /**
   * Whether a new version of the adapter would inherit a signed-in session: it has grants (logins or
   * credentials), or its
   * tool partition holds any cookie on the cookie domains of the version in use. Fails closed: a
   * partition that can't be read counts as holding one.
   */
  private async inheritsSession(adapterId: string): Promise<boolean> {
    const grants = await this.grants.list().catch(() => [] as readonly Grant[])
    if (grants.some((g) => g.adapterId === adapterId)) return true
    // Credential grants (secrets v2) carry the same way, so the card says so. Fails closed.
    const credentials = await this.credentialKeeper.list().catch(() => null)
    if (credentials === null || credentials.some((g) => g.adapterId === adapterId)) return true
    return this.holdsSession(adapterId)
  }

  /** The partition half of inheritsSession. */
  private async holdsSession(adapterId: string): Promise<boolean> {
    const driver = this.drivers.get(adapterId)
    const adapter = this.adapter(adapterId)
    if (driver === undefined || adapter === null) return false
    const { cookieDomains } = adapter.definition.manifest.session
    if (cookieDomains.length === 0) return false
    try {
      return (await driver.cookieNames(cookieDomains)).length > 0
    } catch {
      return true
    }
  }

  /**
   * Whether this version would run without the sandbox here: its manifest says unsandboxed, or this
   * build has no sandbox and it isn't one of the app's own built-ins (B). Built in means the hash
   * this app ships, never a stored version's source tag, which anything can write.
   */
  private runsUnsandboxed(adapter: BuiltinAdapter): boolean {
    if ((adapter.definition.manifest.sandbox ?? DEFAULT_SANDBOX).mode === 'unsandboxed') return true
    if (this.deps.sandbox !== undefined) return false
    return !this.isBuiltIn(adapter)
  }

  /** One of the app's own built-ins: the hash it ships (or, without a store, its own copy). */
  private isBuiltIn(adapter: BuiltinAdapter): boolean {
    if (this.packages === null) return adapter.source === undefined || adapter.source === 'builtin'
    return this.packages.isShipped(adapter.definition.manifest.id, adapter.hash)
  }

  /** Signed evidence (or the legacy record) for this hash, in the mode it would run in now. */
  private installSigned(adapterId: string, adapterHash: string): boolean {
    const adapter = this.adapter(adapterId)
    const unsandboxed = adapter?.hash === adapterHash ? this.runsUnsandboxed(adapter) : true
    const signed = this.approvalBroker?.honoured(
      'adapter-install',
      (s) => s.adapterId === adapterId && s.adapterHash === adapterHash && s.unsandboxed === unsandboxed,
    )
    if (signed !== null && signed !== undefined) return true
    return (this.ledger?.data.legacy?.installs ?? []).some(
      (l) => l.adapterId === adapterId && l.adapterHash === adapterHash,
    )
  }

  /**
   * Asks the person to approve installing `adapter` (an update, a first install, a rollback), with
   * Touch ID at this Mac. Resolves true once signed; false if they cancelled. The diff is against
   * `against` (the active version, for a rollback) or the last approved snapshot.
   */
  private async signInstall(
    adapter: BuiltinAdapter,
    source: 'draft' | 'local-folder' | 'rollback' | 'builtin',
    against?: BuiltinAdapter,
  ): Promise<boolean> {
    const broker = this.approvalBroker
    if (broker === null) throw new ValetError('config', 'unavailable')
    const id = adapter.definition.manifest.id
    const snapshot = await this.snapshots.get(id)
    const previous =
      against !== undefined
        ? { hash: against.hash, manifest: against.definition.manifest }
        : snapshot !== null && snapshot.hash !== adapter.hash
          ? { hash: snapshot.hash, manifest: snapshot.manifest }
          : null
    const subject = installSubject({
      manifest: adapter.definition.manifest,
      hash: adapter.hash,
      files: adapter.files,
      previous,
      source,
      inheritsSession: previous !== null && (await this.inheritsSession(id)),
      unsandboxed: this.runsUnsandboxed(adapter),
    })
    if (!(await this.approveHere('adapter-install', subject))) return false
    // A rollback retires the others only once its swap has worked (rollbackNow).
    if (source !== 'rollback') await this.retireOthers(id, adapter.hash)
    return true
  }

  /**
   * The person's own request, approved with Touch ID at this Mac: true once signed, false if they
   * cancelled. Throws when nothing can be approved (no broker, locked down).
   */
  private async approveHere<K extends ApprovalKind>(
    kind: K,
    subject: ApprovalSubject<K>,
    extras: ConsentExtras = {},
  ): Promise<boolean> {
    const broker = this.approvalBroker
    if (broker === null) throw new ValetError('config', 'unavailable')
    const asked = await broker.request(
      kind,
      subject,
      // A consent is raised by the app for the client that asked; everything else is the person's.
      kind === 'remote-client' ? { kind: 'app' } : { kind: 'person' },
      extras.consentCode === undefined ? null : { consentCode: extras.consentCode },
    )
    if (!asked.ok)
      throw new ValetError('config', asked.reason === 'locked-down' ? 'locked-down' : 'unavailable')
    const answered = await broker.approveOnMac(
      asked.requestId,
      extras.typedCode === undefined ? {} : { typedCode: extras.typedCode },
    )
    if (answered.ok) return true
    // Busy: another prompt is up and this one may still be answered, unless it's a consent,
    // which is never reused and would only pile up.
    if (answered.reason !== 'busy' || kind === 'remote-client')
      await broker
        .withdraw(asked.requestId, kind === 'remote-client' ? { kind: 'app' } : { kind: 'person' })
        .catch(() => false)
    return false
  }

  /**
   * What a cloud agent may do beyond Use tools: only what a signature backs now (F's design,
   * docs/authoring-tools.md "Who can author"). Ask for changes from its consent card or a later
   * `setting`; See Valet from its consent card, or with Ask for changes. Nothing for an agent
   * without an approved registration, or without the broker.
   */
  private remoteCapabilities(clientId: string): {
    readonly seeValet: boolean
    readonly askForChanges: boolean
  } {
    const none = { seeValet: false, askForChanges: false }
    const broker = this.approvalBroker
    if (broker === null || this.remote.clients.get(clientId)?.grant == null) return none
    const id = `remote:${clientId}`
    const consented = (capability: RemoteCapability): boolean =>
      broker.honoured(
        'remote-client',
        (s) => s.clientId === id && (s.capabilities ?? []).includes(capability),
      ) !== null
    const setting = remoteAskSetting(clientId)
    const askForChanges =
      consented('ask-for-changes') ||
      (setting !== null &&
        broker.honoured('setting', (s) => s.scope === 'valet' && s.setting === setting && s.to === 'On') !==
          null)
    return { seeValet: askForChanges || consented('see-valet'), askForChanges }
  }

  /** Turns a cloud agent's Ask for changes on (Touch ID) or off (at once, tightening). */
  private async setRemoteAsk(clientId: string, on: boolean): Promise<void> {
    const client = this.remote.remoteClients().find((c) => c.id === clientId)
    if (client === undefined || client.grant === null || this.approvalBroker === null)
      throw new ValetError('config', 'not-found')
    if (on) {
      if (this.remoteCapabilities(clientId).askForChanges) return
      const subject = remoteAskSubject(clientId, client.host, true)
      if (subject === null) throw new ValetError('config', 'invalid')
      await this.approveOrRefuse('setting', subject)
      if (!this.remoteCapabilities(clientId).askForChanges) throw new ValetError('config', 'unavailable')
      return
    }
    await this.dropRemoteCapabilities(clientId)
    // Its requests about changes go with the capability.
    await this.approvalBroker.withdrawClient(`remote:${clientId}`).catch(() => 0)
    this.dropAgentAsks(`remote:${clientId}`)
    await this.remote.reopenClient(clientId).catch(() => undefined)
    this.emit('remote-changed')
  }

  /** Removes the evidence behind a cloud agent's See Valet and Ask for changes. Only tightens. */
  private async dropRemoteCapabilities(clientId: string): Promise<void> {
    const broker = this.approvalBroker
    if (broker === null) return
    const setting = remoteAskSetting(clientId)
    if (setting !== null) await broker.revoke('setting', (s) => s.setting === setting).catch(() => 0)
    await broker
      .revoke(
        'remote-client',
        (s) => s.clientId === `remote:${clientId}` && (s.capabilities ?? []).length > 0,
      )
      .catch(() => 0)
  }

  /** A widening change the person asked for: Touch ID first, then the kind's handler applies it. */
  private async approveOrRefuse<K extends ApprovalKind>(
    kind: K,
    subject: ApprovalSubject<K>,
    extras: ConsentExtras = {},
  ): Promise<void> {
    if (!(await this.approveHere(kind, subject, extras))) throw new ValetError('config', 'not-granted')
  }

  /** Valet's own widening settings: where each is read and written. */
  private valetSetting(name: WideningSetting): {
    get(): unknown
    set(value: unknown): Promise<void>
  } {
    const settings = async (patch: SettingsPatch) => {
      await this.afterSettings(await this.settings.set(patch))
      this.emit('app-changed')
    }
    switch (name) {
      case 'messages_otp':
        return {
          get: () => this.settingsNow.messagesOtpEnabled,
          set: (v) => settings({ messagesOtpEnabled: v === true }),
        }
      case 'notifications':
        return {
          get: () => this.settingsNow.notifications,
          set: (v) => settings({ notifications: v === true }),
        }
      case 'trace_retention':
        return {
          get: () => this.settingsNow.traceRetentionDays,
          set: (v) => settings({ traceRetentionDays: Number(v) }),
        }
      case 'remote_enabled':
        return { get: () => this.remote.status().enabled, set: (v) => this.remote.setEnabled(v === true) }
      case 'remote_hosts':
        return {
          get: () => this.remote.status().hosts,
          set: (v) => this.remote.setHosts(Array.isArray(v) ? (v as string[]) : []),
        }
    }
  }

  /**
   * Changes one of Valet's own widening settings: with Touch ID when it widens (the handler then
   * applies it), at once otherwise.
   */
  private async changeValetSetting(name: WideningSetting, value: unknown): Promise<void> {
    // Checked before asking: a handler's failure after the approval can't reach the caller.
    const to = value
    if (name === 'trace_retention' && !traceRetentionDaysSchema.safeParse(value).success)
      throw new ValetError('config', 'invalid')
    if (name === 'remote_hosts') return this.changeRemoteHosts(value)
    const setting = this.valetSetting(name)
    const from = setting.get()
    // Unchanged or narrower: set at once (setting remote access off again still closes it all).
    if (!settingWidens(name, from, to)) return setting.set(to)
    await this.approveOrRefuse('setting', settingSubject(name, from, to))
    // Applied by the handler, which can't report a failure: read it back.
    if (JSON.stringify(setting.get()) !== JSON.stringify(to)) throw new ValetError('config', 'unavailable')
  }

  /** Hosts removed at once; each host added is its own signed request, so it fits on the card. */
  private async changeRemoteHosts(value: unknown): Promise<void> {
    const normalised = (Array.isArray(value) ? value : []).map((h) => normaliseRemoteHost(String(h)))
    if (!Array.isArray(value) || normalised.some((h) => h === null)) throw new ValetError('config', 'invalid')
    const wanted = [...new Set(normalised as string[])]
    const from = this.remote.status().hosts
    const added = wanted.filter((h) => !from.includes(h))
    if (wanted.length > MAX_REMOTE_HOSTS || added.some((h) => settingValue('remote_hosts', h) === null))
      throw new ValetError('config', 'invalid')
    const kept = from.filter((h) => wanted.includes(h))
    if (kept.length !== from.length) await this.remote.setHosts(kept)
    for (const host of added) {
      await this.approveOrRefuse('setting', settingSubject('remote_hosts', this.remote.status().hosts, host))
      if (!this.remote.status().hosts.includes(host)) throw new ValetError('config', 'unavailable')
    }
  }

  /**
   * Whether a stored grant may hand out its secret: signed `secret-grant` evidence for exactly it
   * (the item, the provider, origins within those signed); a grant an approved update kept (the
   * ledger's `carried`, while that install's evidence stands); or the legacy record, honoured only
   * for origins the version's own manifest declares (B's condition).
   */
  private grantSigned(grant: Grant): boolean {
    const adapter = this.adapter(grant.adapterId)
    if (this.secretGrantSigned(grant) || this.grantCarried(grant)) return true
    return (
      adapter !== null &&
      adapter.hash === grant.adapterHash &&
      this.legacyGrant(grant, adapter.definition.manifest)
    )
  }

  /** Signed `secret-grant` evidence for exactly `grant`. */
  private secretGrantSigned(grant: Grant): boolean {
    const fingerprint = itemFingerprint(grant.itemRef)
    const signed = this.approvalBroker?.honoured(
      'secret-grant',
      (s) =>
        s.adapterId === grant.adapterId &&
        s.adapterHash === grant.adapterHash &&
        s.secret === grant.secret &&
        s.provider === subjectProvider(grant.provider) &&
        s.itemFingerprint === fingerprint &&
        grant.origins.every((o) => s.origins.includes(o)),
    )
    return signed !== null && signed !== undefined
  }

  /**
   * A grant an approved update kept from the version it replaced: the ledger's record of exactly
   * it, and the signed install that kept it, which said it inherits the session, still honoured.
   * A retired or rejected install takes its carried grants with it.
   */
  private grantCarried(grant: Grant): boolean {
    const fingerprint = itemFingerprint(grant.itemRef)
    const records = (this.ledger?.data.carried ?? []).filter(
      (c) =>
        c.adapterId === grant.adapterId &&
        c.toHash === grant.adapterHash &&
        c.secret === grant.secret &&
        c.provider === subjectProvider(grant.provider) &&
        c.itemFingerprint === fingerprint &&
        grant.origins.every((o) => c.origins.includes(o)),
    )
    return records.some((c) => {
      const install = this.approvalBroker?.honoured(
        'adapter-install',
        (s) =>
          s.adapterId === c.adapterId &&
          s.adapterHash === c.toHash &&
          s.previousHash === c.fromHash &&
          s.inheritsSession &&
          s.source !== 'rollback',
      )
      return install !== null && install !== undefined
    })
  }

  /** The legacy record for `grant`, honoured only for origins `manifest` declares for it. */
  private legacyGrant(grant: Grant, manifest: AdapterManifest): boolean {
    const legacy = (this.ledger?.data.legacy?.grants ?? []).some(
      (l) =>
        l.adapterId === grant.adapterId && l.adapterHash === grant.adapterHash && l.secret === grant.secret,
    )
    if (!legacy) return false
    const declared =
      grant.secret === MESSAGES_SECRET
        ? messagesSourcesIn(manifest.auth.steps).some((m) => m.sender === grant.itemRef)
          ? manifest.navigation
          : []
        : grant.provider !== 'messages' && Object.hasOwn(manifest.secrets, grant.secret)
          ? (manifest.secrets[grant.secret]?.origins ?? [])
          : []
    return grant.origins.length > 0 && grant.origins.every((o) => declared.includes(o))
  }

  /**
   * After a signed update that said it inherits the session (`inheritsSession`, shown on its card),
   * keeps each of the replaced version's grants the update doesn't widen (carriesOver), for the
   * new hash, so the person isn't asked for the same login again (D47). A grant the update widens
   * stays behind, and the person grants it again as before. Never for a rollback, whose own
   * version's grants come back as they were. Best effort: a grant not kept is only asked for again.
   */
  private async carryGrants(
    adapterId: string,
    adapterHash: string,
    previous: ApprovedSnapshot | null,
  ): Promise<void> {
    const ledger = this.ledger
    const adapter = this.adapter(adapterId)
    if (ledger === null || ledger.tampered !== null || previous === null || adapter?.hash !== adapterHash)
      return
    // The old manifest decides what isn't widened, so it must be the approved version's own.
    if (!snapshotIntact(previous)) return
    const install = this.approvalBroker?.honoured(
      'adapter-install',
      (s) =>
        s.adapterId === adapterId &&
        s.adapterHash === adapterHash &&
        s.previousHash === previous.hash &&
        s.inheritsSession &&
        s.source !== 'rollback',
    )
    if (install === null || install === undefined) return
    const all = await this.grants.list().catch(() => [] as readonly Grant[])
    const kept = all.filter(
      (g) =>
        g.adapterId === adapterId &&
        g.adapterHash === previous.hash &&
        // Signed for the old version (its install may be retired by now, so not grantCarried's
        // check of the install), and not widened by this update.
        this.grantBackedFor(g, previous.manifest) &&
        carriesOver(g, previous.manifest, adapter.definition.manifest) &&
        // One already made for the new version, by the person, stands as it is.
        !all.some(
          (n) =>
            n.adapterId === adapterId &&
            n.adapterHash === adapterHash &&
            n.secret === g.secret &&
            (g.secret !== MESSAGES_SECRET || n.itemRef === g.itemRef),
        ),
    )
    if (kept.length === 0) return
    const at = new Date(this.deps.now()).toISOString()
    try {
      await ledger.commit((draft) => {
        const records = (draft.carried ?? []).filter(
          (c) => !(c.adapterId === adapterId && c.toHash === adapterHash),
        )
        for (const g of kept)
          records.push({
            adapterId,
            fromHash: previous.hash,
            toHash: adapterHash,
            secret: g.secret,
            provider: subjectProvider(g.provider),
            itemFingerprint: itemFingerprint(g.itemRef),
            origins: [...g.origins],
            at,
          })
        // Only the latest carry per adapter matters; older ones name hashes no longer approved.
        draft.carried = records
          .filter((c) => c.adapterId !== adapterId || c.toHash === adapterHash)
          .slice(-500)
      })
    } catch {
      return
    }
    for (const g of kept) {
      const grant: Grant = { ...g, origins: [...g.origins], adapterHash, grantedAt: at }
      try {
        await this.audit.append({
          type: 'grant-made',
          adapterId,
          adapterHash,
          secret: g.secret,
          provider: g.provider,
          origins: [...g.origins],
          carriedFrom: previous.hash,
        })
        await this.grants.put(grant)
      } catch {
        // Not kept: the person is asked for it again, as before.
      }
    }
    this.emit('grants-changed')
  }

  /** `grant` signed for its own version, whose manifest is `manifest` (active or not). */
  private grantBackedFor(grant: Grant, manifest: AdapterManifest): boolean {
    return this.secretGrantSigned(grant) || this.grantCarried(grant) || this.legacyGrant(grant, manifest)
  }

  /** The grant store as everything that hands out secrets sees it: only grants the person signed. */
  private readonly signedGrants: GrantStore = {
    find: async (adapterId, adapterHash, secret) => {
      const grant = await this.grants.find(adapterId, adapterHash, secret)
      return grant !== null && this.grantSigned(grant) ? grant : null
    },
    list: async () => (await this.grants.list()).filter((g) => this.grantSigned(g)),
    put: (grant) => this.grants.put(grant),
    revoke: (adapterId, secret) => this.grants.revoke(adapterId, secret),
  }

  /** Takes a grant's evidence and legacy record away (a revoke). Only tightens. */
  private async revokeGrantEvidence(adapterId: string, secret: string): Promise<void> {
    await this.approvalBroker?.revoke('secret-grant', (s) => s.adapterId === adapterId && s.secret === secret)
    await this.ledger
      ?.commit(
        (draft) => {
          if (draft.legacy !== undefined)
            draft.legacy.grants = draft.legacy.grants.filter(
              (l) => !(l.adapterId === adapterId && l.secret === secret),
            )
          if (draft.carried !== undefined)
            draft.carried = draft.carried.filter((c) => !(c.adapterId === adapterId && c.secret === secret))
        },
        { tightening: true },
      )
      .catch(() => undefined)
  }

  /** Applies a signed install of the hash installed now: the applied mark, the snapshot, the tools. */
  private async applyInstall(adapterId: string, adapterHash: string): Promise<void> {
    const adapter = this.adapter(adapterId)
    if (adapter === null || adapter.hash !== adapterHash) return
    await this.approvals.approve(adapterId, adapterHash, adapter.definition.manifest.version)
    // Before the snapshot moves on: the grants kept are the approved version's.
    const previous = await this.snapshots.get(adapterId).catch(() => null)
    await this.carryGrants(adapterId, adapterHash, previous?.hash === adapterHash ? null : previous)
    if (previous !== null && previous.hash !== adapterHash && snapshotIntact(previous))
      await this.credentialKeeper.carry(adapterId, adapterHash, previous).catch(() => undefined)
    const at = new Date(this.deps.now()).toISOString()
    await this.snapshots.put(adapterId, adapter, at)
    this.approvedAt.set(`${adapterId}:${adapterHash}`, at)
    await this.refreshTools()
  }

  /**
   * Once a version is approved with Touch ID, the adapter's other versions keep no approval: their
   * signed evidence and their legacy records go, so a version can't be put back as active later
   * without asking again (a downgrade). Only tightens.
   */
  private async retireOthers(adapterId: string, keep: string): Promise<void> {
    await this.approvalBroker?.revoke(
      'adapter-install',
      (s) => s.adapterId === adapterId && s.adapterHash !== keep,
    )
    await this.ledger
      ?.commit(
        (draft) => {
          if (draft.legacy !== undefined)
            draft.legacy.installs = draft.legacy.installs.filter((l) => l.adapterId !== adapterId)
        },
        { tightening: true },
      )
      .catch(() => undefined)
  }

  /** Takes an install's evidence and legacy record away (a reject). Only tightens. */
  private async revokeInstall(
    adapterId: string,
    adapterHash: string,
    options: { readonly legacy: boolean } = { legacy: true },
  ): Promise<void> {
    await this.approvalBroker?.revoke(
      'adapter-install',
      (s) => s.adapterId === adapterId && s.adapterHash === adapterHash,
    )
    if (!options.legacy) return
    await this.ledger
      ?.commit(
        (draft) => {
          if (draft.legacy !== undefined)
            draft.legacy.installs = draft.legacy.installs.filter(
              (l) => !(l.adapterId === adapterId && l.adapterHash === adapterHash),
            )
        },
        { tightening: true },
      )
      .catch(() => undefined)
  }

  /**
   * At the first launch of a signed build: what was approved before, recorded once in the ledger
   * (docs/approval-broker.md#migration). Only the built-ins' own hashes, so an approvals.json or a
   * package planted in the data folder can't be carried over as approved.
   */
  private async recordLegacy(): Promise<void> {
    const ledger = this.ledger
    if (ledger === null || ledger.tampered !== null || ledger.data.legacy !== undefined) return
    const builtin = this.installed.filter((a) => this.isBuiltIn(a))
    const installs: { adapterId: string; adapterHash: string }[] = []
    for (const adapter of builtin) {
      const id = adapter.definition.manifest.id
      if (await this.approvals.isApproved(id, adapter.hash).catch(() => false))
        installs.push({ adapterId: id, adapterHash: adapter.hash })
    }
    const grants = (await this.grants.list().catch(() => [] as readonly Grant[]))
      .filter((g) => installs.some((i) => i.adapterId === g.adapterId && i.adapterHash === g.adapterHash))
      .map((g) => ({ adapterId: g.adapterId, adapterHash: g.adapterHash, secret: g.secret }))
    await ledger
      .commit((draft) => {
        draft.legacy = { at: new Date(this.deps.now()).toISOString(), installs, grants }
      })
      .catch(() => undefined)
  }

  /**
   * Signed installs whose apply didn't finish (a crash after the evidence was written): applied
   * now, for the hash still installed, without asking again.
   */
  private async reapplyInstalls(): Promise<void> {
    for (const adapter of this.installed) {
      const id = adapter.definition.manifest.id
      const signed = this.approvalBroker?.honoured(
        'adapter-install',
        (s) => s.adapterId === id && s.adapterHash === adapter.hash && s.source !== 'rollback',
      )
      if (signed === null || signed === undefined) continue
      if (!(await this.approvals.isApproved(id, adapter.hash).catch(() => true)))
        await this.applyInstall(id, adapter.hash).catch(() => undefined)
    }
    // A staged draft approved before a crash, or whose swap was busy: finished now.
    for (const adapter of [...this.installed]) {
      const id = adapter.definition.manifest.id
      let hash: string | null = null
      const staged = this.approvalBroker?.honoured('adapter-install', (s) => {
        const match =
          s.adapterId === id &&
          s.source === 'draft' &&
          s.adapterHash !== adapter.hash &&
          s.previousHash === adapter.hash
        if (match) hash = s.adapterHash
        return match
      })
      if (staged === null || staged === undefined || hash === null) continue
      if (await this.isStored(id, hash)) await this.finishStaged(id, hash).catch(() => undefined)
    }
  }

  // ---------- Drafts (docs/authoring-tools.md) ----------

  /** The authoring tools over the draft store, when this build can install adapters. */
  private async startAuthoring(): Promise<DraftAuthoring | null> {
    const packages = this.packages
    const runtime = this.deps.packages?.runtime
    if (packages === null || runtime === undefined) return null
    for (const record of await this.drafts.list().catch(() => [])) {
      if (record.submission === null) continue
      this.draftAskers.set(record.submission.requestId, {
        kind: 'agent',
        clientId: record.submission.by,
        clientName: record.createdByName,
      })
    }
    this.tidyDraftsSoon()
    return new DraftAuthoring({
      store: this.drafts,
      repairs: this.repairTickets,
      prepare: async (files) => (await packages.prepare(files, 'draft')).loaded,
      // Each case in a fresh one-shot sandbox window, as describing a package runs (docs/sandbox.md).
      caseProcess: runtime.start,
      // A raw draft's cases in the Node runtime, with no network (docs/adapter-kinds.md#raw).
      ...(runtime.raw === undefined ? {} : { rawCaseProcess: runtime.raw.start }),
      installed: async (adapterId) => {
        const adapter = this.adapter(adapterId)
        if (adapter === null) return null
        // The whole package: an adapter's own `files` are its code only.
        const files = (await this.packages?.files(adapterId, adapter.hash)) ?? adapter.files
        return { manifest: adapter.definition.manifest, hash: adapter.hash, files }
      },
      approved: async (adapterId) => {
        const snapshot = await this.snapshots.get(adapterId)
        return snapshot === null ? null : { manifest: snapshot.manifest, hash: snapshot.hash }
      },
      sites: () =>
        this.installed.map((a) => ({ id: a.definition.manifest.id, name: a.definition.manifest.name })),
      permissionLines: (before, after) =>
        permissionChanges(
          before,
          after,
          (after.sandbox ?? DEFAULT_SANDBOX).mode === 'unsandboxed' || this.deps.sandbox === undefined,
        ),
      submit: (request) => this.submitDraft(request),
      askPrivateNetwork: (request) => this.askPrivateNetwork(request),
      askSession: (request) => this.askSession(request),
      sessionFor: (draftId) => {
        const lent = this.authoringSessions.get(draftId)
        return lent === undefined || lent.until <= this.deps.now() ? null : lent
      },
      withdraw: async (requestId) => {
        const asker = this.draftAskers.get(requestId)
        if (asker !== undefined) await this.approvalBroker?.withdraw(requestId, asker).catch(() => false)
      },
      requestState: (requestId) => this.draftRequestState(requestId),
      clientName: (viewer) =>
        viewer.origin === 'local'
          ? (this.clients.get(viewer.clientId)?.name ?? 'An app')
          : (this.remote.remoteClients().find((c) => c.id === viewer.clientId)?.host ?? 'A cloud agent'),
      audit: async (event) => {
        await this.audit.append(event)
      },
      notify: (text) => this.notifier.draftActivity(text),
      now: this.deps.now,
      // Raw drafts' npm packages, kept by integrity in Valet's own folder (docs/node-runtime.md).
      dependencies: {
        add: (lock, name, range) =>
          addDependency(lock, name, range, diskTarballStore(join(this.deps.paths.dir, 'npm-tarballs'))),
      },
      ...(this.deps.scratch === undefined ? {} : { research: this.scratchSessions(this.deps.scratch) }),
      ...(this.deps.fixtureBrowser === undefined ? {} : { caseBrowser: this.deps.fixtureBrowser }),
      ...(this.deps.trialDriver === undefined
        ? {}
        : {
            trials: {
              // A fresh one-shot sandbox window for the call, as for a case.
              start: runtime.start,
              driver: (manifest: AdapterManifest, label: string, signedIn: SignedInTrial | null) =>
                (this.deps.trialDriver as NonNullable<ServiceDeps['trialDriver']>)(
                  manifest,
                  label,
                  this.privateAllowance(/^(dr-[a-z2-7]{10})-/.exec(label)?.[1] ?? ''),
                  signedIn === null
                    ? null
                    : {
                        adapterId: signedIn.adapterId,
                        cookieDomains: signedIn.installed.session.cookieDomains,
                      },
                ),
              // The installed adapters' own budget and breaker for the host.
              guards: (host: string) => this.runtime().siteGuards(host),
              signedIn: () => this.signedInDomains(),
              ...(this.deps.egress === undefined
                ? {}
                : {
                    egress: (endpoints: { readonly egress: readonly string[] }) =>
                      (this.deps.egress as NonNullable<ServiceDeps['egress']>)({ egress: endpoints.egress }),
                  }),
              // A raw draft's trial: its public endpoints only, through the broker's tunnels.
              ...(this.deps.raw === undefined || this.deps.egress === undefined
                ? {}
                : {
                    raw: {
                      start: (manifest: AdapterManifest, openTunnels: OpenTunnels) =>
                        (this.deps.raw as NonNullable<ServiceDeps['raw']>).start(manifest, openTunnels),
                      tunnels: (endpoints: readonly string[]) => {
                        const broker = (this.deps.egress as NonNullable<ServiceDeps['egress']>)({
                          egress: [],
                          endpoints,
                        })
                        return (run: RunContext, options: { readonly admit: () => Promise<void> }) => {
                          if (broker.tunnels === undefined) throw new ValetError('tool-run', 'unavailable')
                          return broker.tunnels(run, options)
                        }
                      },
                    },
                  }),
            },
          }),
    })
  }

  /**
   * The registrable domains of installed adapters with a grant or a signed-in (or expired)
   * session, by adapter id: scratch browsers and live trials don't reach them but for their own.
   */
  private async signedInDomains(): Promise<ReadonlyMap<string, readonly string[]>> {
    const grants = await this.grants.list().catch(() => [] as readonly Grant[])
    const out = new Map<string, readonly string[]>()
    for (const adapter of this.installed) {
      const id = adapter.definition.manifest.id
      const session = this.sessions.get(id).state
      if (grants.some((g) => g.adapterId === id) || session === 'logged-in' || session === 'expired')
        out.set(id, draftDomains(adapter.definition.manifest))
    }
    return out
  }

  /** Sites' Drafts section: open drafts, and closed ones from the last week, newest first. */
  private async draftOverviews(): Promise<DraftOverview[]> {
    const weekAgo = this.deps.now() - 7 * 24 * 3600_000
    const records = (await this.drafts.list().catch(() => [] as DraftRecord[]))
      .filter((r) => r.status === 'editing' || r.status === 'waiting' || Date.parse(r.updatedAt) >= weekAgo)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    const out: DraftOverview[] = []
    for (const record of records) {
      const files = await this.drafts.files(record.id).catch(() => null)
      if (files !== null) out.push(this.draftOverview(record, files))
    }
    return out
  }

  private async draftPage(draftId: string): Promise<DraftPage | null> {
    const record = await this.drafts.record(draftId).catch(() => null)
    if (record === null) return null
    const files = await this.drafts.files(draftId).catch(() => null)
    if (files === null) return null
    return {
      ...this.draftOverview(record, files),
      createdAt: record.createdAt,
      files: Object.entries(files)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([path, text]) => ({
          path,
          bytes: Buffer.byteLength(text, 'utf8'),
          recordedByValet: record.recorded[path] === sha256Hex(text),
        })),
    }
  }

  /** What Valet ran and recorded, bound to the files as they are now; nothing the agent claims. */
  private draftOverview(record: DraftRecord, files: PackageFiles): DraftOverview {
    let name = record.adapterId
    let version: string | null = null
    try {
      const manifest = parseManifest(JSON.parse(files['manifest.json'] ?? 'null'))
      name = manifest.name
      version = manifest.version
    } catch {
      // A manifest that doesn't parse yet: the draft is still named by its id.
    }
    const packageHash = bundleHash(files)
    const latest = new Map<string, DraftRecord['trials'][number]>()
    for (const t of record.trials) if (t.packageHash === packageHash) latest.set(t.tool, t)
    const check = record.lastCheck
    return {
      draftId: record.id,
      adapterId: record.adapterId,
      name,
      version,
      writtenBy: record.createdByName,
      status: record.status,
      updatedAt: record.updatedAt,
      check:
        check === null || check.packageHash !== packageHash
          ? null
          : { at: check.at, ok: check.ok, cases: check.cases, passed: check.passed, problem: check.problem },
      trials: [...latest.values()].map((t) => ({ tool: t.tool, at: t.at, ok: t.ok, problem: t.problem })),
      submission:
        record.submission === null
          ? null
          : { ref: record.submission.ref, at: record.submission.at, note: record.submission.note },
      update: record.basedOn !== null,
      session: this.lentSession(record.id),
    }
  }

  /** The scratch browsers' rules from what is installed and signed in now. */
  /** What a draft's dial may reach besides public addresses: what the person approved, until it ends. */
  private privateAllowance(draftId: string): (address: string, port: number) => boolean {
    return (address, port) => {
      const now = this.deps.now()
      const plain = address.toLowerCase().replace(/^::ffff:/, '')
      return (this.privateNetwork.get(draftId) ?? []).some(
        (g) => g.until > now && g.address === plain && (g.port === null || g.port === port),
      )
    }
  }

  /** An agent asks to try its draft with the adapter's session (docs/authoring-tools.md, D81). */
  private async askSession(request: SessionRequest): Promise<AskOutcome> {
    const broker = this.approvalBroker
    if (broker === null) return { ok: false, sentence: 'Valet can’t ask for approvals right now.' }
    if (this.lockedDown) return { ok: false, sentence: 'Valet is locked down.' }
    const requester: Requester = {
      kind: 'agent',
      clientId: request.requester.clientId,
      clientName: request.requester.clientName,
    }
    const asked = await broker.request(
      'authoring-session',
      {
        adapterId: request.adapterId,
        draftId: request.draftId,
        origins: [...request.origins],
        minutes: request.minutes,
      },
      requester,
      {
        agentNote: null,
        context: { kind: 'draft', draftId: request.draftId },
        display: {
          client: {
            label: request.requester.clientName,
            badge: request.requester.clientId.startsWith('remote:') ? 'remote' : 'local',
          },
        },
      },
    )
    if (!asked.ok)
      return { ok: false, sentence: submitRefusal(asked.reason, asked.until).replace(/^Not submitted: /, '') }
    this.emit('approvals-changed')
    this.emit('attention-changed')
    return { ok: true, requestId: asked.requestId, ref: asked.ref, expiresAt: asked.expiresAt }
  }

  /** The draft's lent session for the Mac, while it runs. */
  private lentSession(draftId: string): { readonly until: string } | null {
    const lent = this.authoringSessions.get(draftId)
    if (lent === undefined || lent.until <= this.deps.now()) return null
    return { until: new Date(lent.until).toISOString() }
  }

  /** The person ends a draft's signed-in session early, from the draft's page. */
  endAuthoringSession(draftId: string): void {
    if (this.authoringSessions.delete(draftId)) this.emit('drafts-changed')
  }

  /** An agent asks for one private address for its draft (docs/authoring-tools.md, R21). */
  private async askPrivateNetwork(request: PrivateNetworkRequest): Promise<AskOutcome> {
    const broker = this.approvalBroker
    if (broker === null) return { ok: false, sentence: 'Valet can’t ask for approvals right now.' }
    if (this.lockedDown) return { ok: false, sentence: 'Valet is locked down.' }
    const requester: Requester = {
      kind: 'agent',
      clientId: request.requester.clientId,
      clientName: request.requester.clientName,
    }
    const asked = await broker.request(
      'private-network',
      {
        adapterId: request.adapterId,
        draftId: request.draftId,
        address: request.address,
        port: request.port,
        minutes: request.minutes,
      },
      requester,
      {
        agentNote: null,
        context: { kind: 'draft', draftId: request.draftId },
        display: {
          client: {
            label: request.requester.clientName,
            badge: request.requester.clientId.startsWith('remote:') ? 'remote' : 'local',
          },
        },
      },
    )
    if (!asked.ok)
      return { ok: false, sentence: submitRefusal(asked.reason, asked.until).replace(/^Not submitted: /, '') }
    this.emit('approvals-changed')
    this.emit('attention-changed')
    return { ok: true, requestId: asked.requestId, ref: asked.ref, expiresAt: asked.expiresAt }
  }

  private scratchSessions(open: NonNullable<ServiceDeps['scratch']>): ScratchSessions {
    return new ScratchSessions({
      open: (draftId, rules) => open(draftId, rules, this.privateAllowance(draftId)),
      signedIn: () => this.signedInDomains(),
      secretIn: (text) => this.knownSecretIn([text]),
      blocked: (host) => {
        this.deps.diagnostics?.({ type: 'scratch-blocked' })
        this.notifier.draftActivity(`${host} refused an agent’s signed-out browser, so Valet closed it.`)
      },
      notify: (text) => this.notifier.draftActivity(text),
      now: this.deps.now,
      timers: this.deps.timers,
    })
  }

  /**
   * A draft the person is asked to approve (docs/authoring-tools.md#submitting). A first install,
   * or an update to a version that isn't approved, is installed and waits, its tools hidden, as a
   * folder install does. An update to an approved version is staged: stored, not active, so the
   * approved one keeps serving, and the approval's apply swaps it in. Either way the request is
   * the agent's, so its status and a decline's note go back to it.
   */
  private async submitDraft(request: SubmitRequest): Promise<SubmitOutcome> {
    const broker = this.approvalBroker
    const packages = this.packages
    if (broker === null || packages === null)
      return { ok: false, sentence: 'Not submitted: Valet can’t ask for approvals right now.' }
    if (this.lockedDown) return { ok: false, sentence: 'Not submitted: Valet is locked down.' }
    const requester: Requester = {
      kind: 'agent',
      clientId: request.requester.clientId,
      clientName: request.requester.clientName,
    }
    let prepared: ReturnType<PackageManager['prepared']>
    try {
      prepared = packages.prepared(request.loaded, 'draft')
    } catch (error) {
      return { ok: false, sentence: `Not submitted: ${installReason(error)}` }
    }
    const { adapter } = prepared
    const id = adapter.definition.manifest.id
    let staged = false
    let stagedNew = false
    try {
      // Only the store and the swap under the adapter's lock: the broker's own lock is taken after,
      // never inside it (an approval's apply takes the adapter's lock under the broker's).
      await this.oneAtATime(id, async () => {
        const active = this.adapter(id)
        if (active !== null && active.hash === adapter.hash)
          throw new InstallError('That version is the one installed now.')
        if (active !== null && (await this.installGate.isApproved(id, active.hash))) {
          stagedNew = !(await this.isStored(id, adapter.hash))
          await packages.stage(prepared)
          staged = true
        } else {
          await this.swapIn(adapter)
          await packages.commit(prepared)
        }
      })
    } catch (error) {
      return { ok: false, sentence: `Not submitted: ${installReason(error)}` }
    }
    if (staged) this.stagedAdapters.set(`${id}:${adapter.hash}`, adapter)
    const snapshot = await this.snapshots.get(id)
    const previous = snapshot !== null && snapshot.hash !== adapter.hash ? snapshot : null
    const subject = {
      ...installSubject({
        manifest: adapter.definition.manifest,
        hash: adapter.hash,
        files: adapter.files,
        previous: previous === null ? null : { hash: previous.hash, manifest: previous.manifest },
        source: 'draft',
        inheritsSession: previous !== null && (await this.inheritsSession(id)),
        unsandboxed: this.runsUnsandboxed(adapter),
      }),
      references: request.references.filter((r) => /^https:\/\/\S{1,490}$/.test(r)).slice(0, 10),
    }
    const asked = await broker.request('adapter-install', subject, requester, {
      agentNote: request.agentNote === null ? null : request.agentNote.slice(0, 280),
      context: { kind: 'draft', draftId: request.draftId },
      // The draft's earlier request, withdrawn as replaced only once this one is made, so the
      // person never sees two of one draft and a refused resubmission leaves the earlier one.
      ...(request.replaces === null ? {} : { replaces: request.replaces }),
      display: {
        client: {
          label: request.requester.clientName,
          badge: request.requester.clientId.startsWith('remote:') ? 'remote' : 'local',
        },
        ...(/^[a-z0-9.-]{1,253}$/.test(request.domain) ? { domain: request.domain } : {}),
        checks: request.checks.slice(0, 20).map((line) => line.slice(0, 200)),
        // The agent's own cases, in B's field apart from Valet's checks, so they can't pass for them.
        agentTests: {
          passed: Math.min(request.agentTests.passed, 10_000),
          failed: Math.min(request.agentTests.failed, 10_000),
        },
      },
    })
    if (!asked.ok) {
      if (staged && stagedNew) await this.discardStaged(id, adapter.hash)
      return { ok: false, sentence: submitRefusal(asked.reason, asked.until) }
    }
    this.draftAskers.set(asked.requestId, requester)
    this.emit('approvals-changed')
    this.emit('attention-changed')
    return {
      ok: true,
      requestId: asked.requestId,
      ref: asked.ref,
      expiresAt: asked.expiresAt,
      previousHash: subject.previousHash,
      stagedNew,
    }
  }

  private draftRequestState(requestId: string): RequestState {
    const asker = this.draftAskers.get(requestId)
    const status = asker === undefined ? null : (this.approvalBroker?.status(requestId, asker) ?? null)
    if (status === null) return { state: 'unknown', note: null }
    if (!('outcome' in status)) return { state: 'pending', note: null }
    return { state: status.outcome, note: status.note ?? null }
  }

  /** The agents' draft install requests waiting now, for one adapter or all. */
  private draftRequests(adapterId?: string) {
    return (this.approvalBroker?.list() ?? []).flatMap((p) => {
      const r = p.request
      if (r.kind !== 'adapter-install' || r.requester.kind !== 'agent' || r.context?.kind !== 'draft')
        return []
      if (adapterId !== undefined && r.subject.adapterId !== adapterId) return []
      return [r]
    })
  }

  private draftRequestFor(adapterId: string, hash: string) {
    return this.draftRequests(adapterId).find((r) => r.subject.adapterHash === hash) ?? null
  }

  /** The draft's request as the review shows it, or null when no agent's request names this hash. */
  private draftReviewInfo(adapterId: string, hash: string) {
    const request = this.draftRequestFor(adapterId, hash)
    const serialized = request === null ? undefined : this.approvalBroker?.get(request.id)
    const info = serialized === null || serialized === undefined ? null : draftReviewRequest(serialized)
    return info === null || request === null ? null : { request: info, requestedAt: request.createdAt }
  }

  /** Every review waiting: each installed bundle not yet decided, then each agent's staged update. */
  private async pendingReviews(states: readonly AdapterState[]): Promise<PendingReview[]> {
    return [
      ...states.flatMap((s) => {
        const id = s.adapter.definition.manifest.id
        const review = pendingReview(s, this.startedAt, this.draftReviewInfo(id, s.adapter.hash) ?? {})
        return review === null ? [] : [review]
      }),
      ...(await this.stagedReviews(states)),
    ]
  }

  /**
   * The versions the person turned down that came with Valet or from a folder, for them to
   * reconsider: approving one later is still their decision, signed like any approval. An agent's
   * declined draft isn't here: its request is over, and the agent submits it again.
   */
  private turnedDownReviews(states: readonly AdapterState[]): PendingReview[] {
    return states.flatMap((s) => {
      if (!s.rejected || s.adapter.source === 'draft') return []
      const review = pendingReview(s, this.startedAt, { turnedDown: true })
      return review === null ? [] : [review]
    })
  }

  private async isStored(adapterId: string, hash: string): Promise<boolean> {
    const state = await this.packages?.versions(adapterId)
    return state?.versions.some((v) => v.hash === hash) ?? false
  }

  /** A staged version, loaded once (a compile and a describe in the sandbox). */
  private async stagedAdapter(adapterId: string, hash: string): Promise<BuiltinAdapter | null> {
    const key = `${adapterId}:${hash}`
    const cached = this.stagedAdapters.get(key)
    if (cached !== undefined) return cached
    const loaded = await this.packages?.load(adapterId, hash).catch(() => null)
    if (loaded === null || loaded === undefined) return null
    this.stagedAdapters.set(key, loaded)
    return loaded
  }

  /**
   * An approved staged draft, swapped in after the broker's lock is let go: then activated,
   * approved and the others retired, as a rollback is. A swap that fails takes the approval away
   * again, so the version still running keeps its own (docs/authoring-tools.md#submitting).
   */
  private finishStagedSoon(adapterId: string, hash: string): void {
    this.staging = this.staging
      .then(() => this.finishStaged(adapterId, hash))
      .catch(() => this.deps.diagnostics?.({ type: 'draft-apply-failed', adapterId }))
  }

  private finishStaged(adapterId: string, hash: string): Promise<void> {
    return this.oneAtATime(adapterId, async () => {
      const packages = this.packages
      const active = this.adapter(adapterId)
      if (packages === null || active === null) return
      if (active.hash === hash) {
        await this.applyInstall(adapterId, hash)
        return
      }
      try {
        const target = await packages.load(adapterId, hash)
        await this.swapIn(target)
      } catch (error) {
        await this.revokeInstall(adapterId, hash, { legacy: false })
        throw error
      }
      await packages.activate(adapterId, hash)
      const now = this.adapter(adapterId)
      const build = this.deps.packages?.build
      if (now !== null && build !== undefined)
        await this.audit.append({
          type: 'adapter-installed',
          adapterId,
          adapterHash: hash,
          version: now.definition.manifest.version,
          source: 'draft',
          previousHash: active.hash,
          ...build,
        })
      await this.applyInstall(adapterId, hash)
      await this.retireOthers(adapterId, hash)
      this.stagedAdapters.delete(`${adapterId}:${hash}`)
      this.emit('approvals-changed')
    })
  }

  private tidyDraftsSoon(): void {
    this.staging = this.staging.then(() => this.tidyDrafts()).catch(() => undefined)
  }

  /**
   * Once a draft's request is closed without approval, a version that was stored only for it is
   * dropped, unless it is active, kept for another reason, or another draft still names it.
   */
  private async tidyDrafts(): Promise<void> {
    for (const record of await this.drafts.list().catch(() => [])) {
      const submission = record.submission
      if (submission === null || !submission.stagedNew) continue
      const state = this.draftRequestState(submission.requestId).state
      if (state === 'pending' || state === 'approved') continue
      await this.discardStaged(record.adapterId, submission.adapterHash)
      await this.drafts
        .update(record.id, (r) =>
          r.submission === null ? r : { ...r, submission: { ...r.submission, stagedNew: false } },
        )
        .catch(() => undefined)
    }
  }

  private async discardStaged(adapterId: string, hash: string): Promise<void> {
    if (this.adapter(adapterId)?.hash === hash) return
    if ((await this.keepHashes(adapterId)).has(hash)) return
    await this.packages?.discard(adapterId, hash).catch(() => false)
    this.stagedAdapters.delete(`${adapterId}:${hash}`)
  }

  /** The Mac's review of each staged draft, against the approved version it would replace. */
  private async stagedReviews(states: readonly AdapterState[]): Promise<PendingReview[]> {
    const out: PendingReview[] = []
    for (const request of this.draftRequests()) {
      const { adapterId, adapterHash } = request.subject
      const state = states.find((s) => s.adapter.definition.manifest.id === adapterId)
      if (state === undefined || state.adapter.hash === adapterHash) continue
      const staged = await this.stagedAdapter(adapterId, adapterHash)
      if (staged === null) continue
      const snapshot = await this.snapshots.get(adapterId)
      const review = pendingReview(
        { ...state, adapter: staged, approved: false, rejected: false, previous: snapshot },
        request.createdAt,
        { ...(this.draftReviewInfo(adapterId, adapterHash) ?? {}), staged: true },
      )
      if (review !== null) out.push(review)
    }
    return out
  }

  private async rollbackTarget(adapterId: string, hash: string): Promise<BuiltinAdapter> {
    if (this.packages === null) throw new InstallError('This build cannot roll back adapters.')
    const active = this.requireAdapter(adapterId)
    if (hash === active.hash) throw new InstallError('That version is already active.')
    // Eligibility comes from the audit log, so only from one whose chain checks out: a line added
    // by hand doesn't make a version look approved.
    if ((await this.reader.verify(new Date(this.deps.now()))).state !== 'intact')
      throw new InstallError('The activity log doesn’t verify, so Valet can’t tell what you approved.')
    const eligible = rollbackEligible(await this.reader.records(), adapterId)
    if (!eligible.has(hash))
      throw new InstallError('Only a version you approved before can be rolled back to.')
    return this.packages.load(adapterId, hash)
  }

  private adapter(adapterId: string): BuiltinAdapter | null {
    return this.installed.find((a) => a.definition.manifest.id === adapterId) ?? null
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
    const approved = await this.installGate.isApproved(manifest.id, adapter.hash)
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
      paused: this.appState.sitePaused(manifest.id),
    }
  }

  private async states(): Promise<AdapterState[]> {
    const records = await this.reader.records()
    const stored = await this.grants.list().catch(() => [] as readonly Grant[])
    const grants = stored.filter((g) => this.grantSigned(g))
    // Given before and not signed now (the Mac's keys changed, or the file was edited): never
    // handed out, and shown as to give again rather than as ready.
    const lapsed = stored.filter((g) => !grants.includes(g))
    const old = this.oldKeysSigned()
    const all = await Promise.all(this.installed.map((a) => this.state(a, records, grants)))
    return all.map((state) => {
      const id = state.adapter.definition.manifest.id
      return {
        ...state,
        lapsed: lapsed.filter((g) => g.adapterId === id && g.adapterHash === state.adapter.hash),
        approvedBefore: !state.approved && (old?.installs.has(id) ?? false),
      }
    })
  }

  /** What this Mac's earlier approval keys signed and no longer counts, or null (keys-changed.ts). */
  private oldKeysSigned(): OldKeysSigned | null {
    const ledger = this.ledger
    const macId = this.deviceStore?.macId
    if (ledger === null || macId === undefined) return null
    const evidence = ledger.data.evidence
    if (this.oldKeys?.evidence !== evidence || this.oldKeys.macId !== macId)
      this.oldKeys = { evidence, macId, signed: signedByOldKeys(evidence, macId) }
    return this.oldKeys.signed
  }

  /** The approval-keys-changed notice, while a site still has something to do again and it isn't dismissed. */
  private keysChangedItems(states: readonly AdapterState[]): KeysChangedItem[] {
    const old = this.oldKeysSigned()
    const macId = this.deviceStore?.macId
    if (old === null || macId === undefined || this.keysNotice.dismissed(macId)) return []
    const item = keysChangedItem(
      old,
      states.map((state) => {
        const manifest = state.adapter.definition.manifest
        const declared = new Set(Object.keys(manifest.secrets))
        if (messagesSourcesIn(manifest.auth.steps).length > 0) declared.add(MESSAGES_SECRET)
        if (mailSourcesIn(manifest.auth.steps).length > 0) declared.add(MAIL_SECRET)
        return {
          adapterId: manifest.id,
          adapterName: manifest.name,
          approved: state.approved,
          declared,
          granted: new Set(
            state.grants
              .filter((g) => g.adapterId === manifest.id && g.adapterHash === state.adapter.hash)
              .map((g) => g.secret),
          ),
        }
      }),
    )
    return item === null ? [] : [item]
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
   * A call the MCP SDK refused before the app saw it (server.ts): a site tool's arguments that its
   * schema refused are recorded as a refused call of that tool (so it shows among the calls), and a
   * name the session doesn't offer as call-refused, with the name only if it is a well-formed tool
   * name. Never the arguments. Past each client's budget, only counted (refusals-dropped).
   */
  private async auditProtocolRefusal(refusal: ProtocolRefusal): Promise<void> {
    const client = printableClient(refusal.client)
    const clientId = refusal.identity === undefined ? undefined : identityLabel(refusal.identity)
    if (!this.refusalBudget.take(client, clientId)) return
    if (refusal.tool !== undefined && this.adapter(refusal.tool.adapterId) !== null) {
      await this.auditRefusal(
        {
          adapterId: refusal.tool.adapterId,
          tool: refusal.tool.tool,
          input: undefined,
          client: refusal.client,
          callId: refusal.callId,
          ...(refusal.identity === undefined ? {} : { identity: refusal.identity }),
        },
        { status: 'failed', stage: 'tool-input', errorClass: 'invalid' },
      )
      return
    }
    await this.audit.append({
      type: 'call-refused',
      client,
      ...(clientId === undefined ? {} : { clientId }),
      tool: refusal.name,
      reason: refusal.reason,
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
  private async settingChoices(
    adapterId: string,
    setting: string,
    query: string,
  ): Promise<SettingChoicesReply> {
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
    await this.storeSetting(adapterId, setting, choice)
  }

  /** Stores a choice already checked: one offered now, or one picked on a signed card. */
  private async storeSetting(adapterId: string, setting: string, choice: SettingChoice): Promise<void> {
    this.requireSetting(adapterId, setting)
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
    this.endpoint = await this.deps.startEndpoint(
      this.caller,
      this.clients.active(),
      (sessions) => {
        // A client that opened a session has connected, whether or not it has called a site tool
        // yet: setup's "Connect" step and the Connections page wait on lastSeen.
        let seen = false
        for (const session of sessions.sessions) {
          if (session.identity.origin !== 'local') continue
          const existing = this.clients.get(session.identity.clientId)
          const name = session.client === 'unknown' ? (existing?.reportedName ?? 'unknown') : session.client
          if (this.clients.seen(session.identity.clientId, name, shownTransport(session.transport)))
            seen = true
        }
        if (seen) this.emit('clients-changed')
        this.emit('endpoint-changed')
      },
      this.adminReader(),
      this.authoring,
    )
    this.endpoint.refresh()
    this.emit('endpoint-changed')
  }

  /** The valet_ tools' view of the app: the control panel's, mapped and scanned (admin.ts). */
  private adminReader(): AdminReader {
    return adminReader({
      api: this.api,
      adapterDetails: async () => (await this.states()).map(adapterDetail),
      callIndex: async () =>
        (await this.reader.records()).flatMap((r) =>
          r.event.type === 'tool-called'
            ? [{ callId: r.event.callId, startedAt: r.at, clientId: r.event.clientId ?? null }]
            : [],
        ),
      access: (clientId) => {
        const capabilities = this.clients.capabilities(clientId)
        const client = this.clients.get(clientId)
        return capabilities === null || client === null ? null : { ...capabilities, name: client.name }
      },
      remoteAccess: (clientId) => {
        const client = this.remote.remoteClients().find((c) => c.id === clientId)
        if (client === undefined || client.grant === null) return null
        // A cloud agent sees its own activity only: All agents' activity is for apps on this Mac.
        return { ...this.remoteCapabilities(clientId), allActivity: false, name: client.host }
      },
      lockedDown: () => this.lockedDown,
      remoteTools: () => new Set(this.remote.status().tools),
      sensitive: (texts) => this.knownSecretIn(texts),
      // Which tool, never what matched.
      withheld: () => this.deps.diagnostics?.({ type: 'admin-result-withheld' }),
      writer: this.adminWriter(),
      ...feedbackPart(this.feedback()),
    })
  }

  /** Agents' reports to the Valet team (docs/feedback.md); null when this launch has no channel. */
  private feedback(): FeedbackDeskImpl | null {
    const channel = this.deps.feedback
    if (channel === undefined || channel === null) return null
    this.feedbackDesk ??= new FeedbackDeskImpl({
      path: this.deps.paths.feedback,
      repo: channel.repo,
      token: channel.token,
      ...(channel.fetch === undefined ? {} : { fetch: channel.fetch }),
      agentName: (viewer) => {
        if (viewer.origin === 'remote') {
          const agent = this.remote.remoteClients().find((c) => c.id === viewer.clientId)
          return agent === undefined || agent.grant === null ? null : agent.host
        }
        if (!this.clients.isActive(viewer.clientId)) return null
        return this.clients.get(viewer.clientId)?.name ?? null
      },
      sensitive: (texts) => this.knownSecretIn(texts),
      version: this.deps.version,
      now: () => this.deps.now(),
    })
    return this.feedbackDesk
  }

  private adminWriter(): AdminWriterImpl {
    this.writer ??= new AdminWriterImpl(this.writerSource())
    return this.writer
  }

  /**
   * What the write tools may do here (docs/admin-tools.md, "Write tier"). Every widening goes
   * through the broker with D's subject builders; this only makes changes that tighten.
   */
  private writerSource(): WriterSource {
    return {
      now: () => this.deps.now(),
      lockedDown: () => this.lockedDown,
      client: (viewer) => {
        if (viewer.origin === 'remote') {
          const agent = this.remote.remoteClients().find((c) => c.id === viewer.clientId)
          return agent === undefined || agent.grant === null ? null : { name: agent.host }
        }
        if (!this.clients.isActive(viewer.clientId)) return null
        const client = this.clients.get(viewer.clientId)
        return client === null ? null : { name: client.name }
      },
      toolRequest: (viewer, adapterId, tool) => {
        const adapter = this.adapter(adapterId)
        const declaration = this.remoteDeclared(adapterId, tool)
        const agent = viewer.origin === 'remote' ? viewer.clientId : null
        // Only a tool of an approved adapter, as the caller lists them (the precheck asks again).
        const listed = this.caller
          ?.listTools()
          .some((t) => t.adapterId === adapterId && t.declaration.name === tool)
        if (adapter === null || declaration === null || agent === null || listed !== true)
          return { ok: false, reason: 'not-found' }
        if (this.remote.allows(adapterId, declaration, agent))
          return { ok: false, reason: 'already', title: declaration.title }
        const subject = toolEnableSubject(
          adapter.definition.manifest,
          adapter.hash,
          tool,
          'remote',
          `remote:${agent}`,
        )
        if (subject === null || !this.remote.canRequestForClient(adapterId, declaration, agent))
          return { ok: false, reason: 'not-found' }
        return { ok: true, subject, title: declaration.title }
      },
      broker: () => {
        const broker = this.approvalBroker
        if (broker === null) return null
        return {
          macId: broker.macId,
          request: (kind, subject, requester, note) => broker.request(kind, subject, requester, note),
          status: (id, asker) => broker.status(id, asker),
          withdraw: (id, asker) => broker.withdraw(id, asker),
          ended: () => broker.ended(),
          waiting: () =>
            broker.list().map((p) => ({
              requestId: p.request.id,
              ref: requestRef(p),
              kind: p.request.kind,
              requester: p.request.requester,
              createdAt: p.request.createdAt,
              expiresAt: p.request.expiresAt,
            })),
        }
      },
      wiredKinds: () => this.wiredKinds(),
      phonePaired: () => (this.deviceStore?.activePhones().length ?? 0) > 0,
      settings: () => this.agentSettings(),
      widens: (name, from, to) => settingWidens(SETTING_SUBJECT_NAMES[name], from, to),
      settingSubject: (name, from, to) => settingSubject(SETTING_SUBJECT_NAMES[name], from, to),
      applySetting: async (name, from, value) => {
        // Never through the person's own path, which would ask on their behalf: only what still
        // starts from `from` and doesn't widen is written; anything else changes nothing.
        const subjectName = SETTING_SUBJECT_NAMES[name]
        const setting = this.valetSetting(subjectName)
        if (setting.get() !== from || settingWidens(subjectName, from, value))
          throw new ValetError('config', 'not-granted')
        try {
          await setting.set(value)
        } catch (error) {
          // Stored, and only what follows a store failed: the change is made.
          if (setting.get() !== value) throw error
        }
      },
      adapterSetting: async (adapterId, setting, query) => {
        const adapter = this.adapter(adapterId)
        const manifest = adapter?.definition.manifest
        const declared = manifest === undefined ? undefined : manifest.settings[setting]
        if (adapter === null || manifest === undefined || declared === undefined)
          return { ok: false, reason: 'not-found' }
        if (!(await this.installGate.isApproved(adapterId, adapter.hash).catch(() => false)))
          return { ok: false, reason: 'not-found' }
        const reply = await this.settingChoices(adapterId, setting, query ?? '')
        if (reply.status === 'blocked') return { ok: false, reason: 'unavailable' }
        if (reply.status !== 'ok') return { ok: false, reason: 'no-choices' }
        const chosen = (await this.adapterSettings.chosen(adapterId).catch(() => null))?.[setting]
        const subject = adapterSettingSubject(manifest, setting, chosen?.label ?? null, reply.choices)
        if (subject === null) return { ok: false, reason: 'no-choices' }
        return { ok: true, subject, title: `Choose ${subject.label} for ${plainName(manifest.name)}` }
      },
      tool: (adapterId, tool) => {
        const listed = this.caller
          ?.listTools()
          .find((t) => t.adapterId === adapterId && t.declaration.name === tool)
        return listed === undefined
          ? null
          : { adapterName: listed.adapterName, title: listed.declaration.title }
      },
      toolOff: (clientId, qualified) => this.clients.toolsOff(clientId).has(qualified),
      requestRemoval: async (clientId, clientName, adapterId, note) => {
        const adapter = this.adapter(adapterId)
        if (adapter === null) return 'not-found'
        if (!this.canRemove(adapterId)) return 'built-in'
        const siteName = adapter.definition.manifest.name
        const asker = clientId
        for (const ask of this.removalAsks.values())
          if (ask.adapterId === adapterId && ask.asker === asker) return { kind: 'removal-already', siteName }
        const id = `rm${randomBytes(15).toString('base64url')}`
        const at = this.deps.now()
        this.removalAsks.set(id, {
          kind: 'agent-request',
          id,
          requestKind: 'uninstall',
          ref: id.slice(2, 6).toUpperCase(),
          title: `Remove ${siteName}`,
          details: [
            `Its tools go for every app and agent.`,
            `Valet deletes its versions, approvals, the logins you gave it, its settings and its browser data.`,
          ],
          adapterId,
          agentName: clientName,
          agentNote: note,
          choices: null,
          requestedAt: new Date(at).toISOString(),
          expiresAt: new Date(at + 24 * 60 * 60_000).toISOString(),
          asker,
        })
        this.emit('attention-changed')
        return { kind: 'removal-asked', siteName }
      },
      requestCredential: async (asker, clientName, adapterId, credential, note) => {
        const adapter = this.adapter(adapterId)
        if (adapter === null) return 'not-found'
        const manifest = adapter.definition.manifest
        const declaration = Object.hasOwn(manifest.credentials ?? {}, credential)
          ? manifest.credentials?.[credential]
          : undefined
        if (declaration === undefined) return 'not-found'
        // Granted only after the person approved this version, as on the card.
        if (!(await this.installGate.isApproved(adapterId, adapter.hash).catch(() => false)))
          return 'not-approved'
        const siteName = plainName(manifest.name)
        if ((await this.credentialKeeper.sourceFor(adapterId, adapter.hash).findGrant(credential)) !== null)
          return { kind: 'credential-granted', siteName }
        this.pruneCredentialAsks()
        const mine = [...this.credentialAsks.values()].filter((ask) => ask.asker === asker)
        if (mine.some((ask) => ask.adapterId === adapterId && ask.credential === credential))
          return { kind: 'credential-already', siteName }
        const at = this.deps.now()
        // As for the broker's requests: a decline holds this ask back for an hour, and an agent (and
        // all agents) can keep only a few waiting, so asking can't flood the person.
        const declined = this.credentialDeclines.get(`${asker} ${adapterId} ${credential}`)
        if (declined !== undefined && at - declined < CREDENTIAL_DECLINE_COOLDOWN_MS)
          return {
            refused: 'cooling-down',
            until: new Date(declined + CREDENTIAL_DECLINE_COOLDOWN_MS).toISOString(),
          }
        if (mine.length >= CREDENTIAL_ASKS_PER_AGENT) return { refused: 'too-many-waiting' }
        if (this.credentialAsks.size >= CREDENTIAL_ASKS_TOTAL) return { refused: 'too-many-total' }
        const id = `cr${randomBytes(15).toString('base64url')}`
        this.credentialAsks.set(id, {
          kind: 'agent-request',
          id,
          requestKind: 'credential',
          ref: id.slice(2, 6).toUpperCase(),
          title: `Grant ${credential} to ${siteName}`,
          details: [
            describeCredentialUse(credential, declaration),
            `Any app or agent that can use ${siteName}’s tools can then use it.`,
            'You pick where it comes from on the site’s page, and approve with Touch ID. The agent never sees it.',
          ],
          adapterId,
          agentName: clientName,
          agentNote: note,
          choices: null,
          requestedAt: new Date(at).toISOString(),
          expiresAt: new Date(at + 24 * 60 * 60_000).toISOString(),
          asker,
          credential,
          adapterHash: adapter.hash,
        })
        this.emit('attention-changed')
        return { kind: 'credential-asked', siteName }
      },
      turnOffTool: async (clientId, qualified) => {
        const done = await this.clients.turnOffTool(clientId, qualified)
        if (done === 'done') {
          try {
            this.endpoint?.refresh()
          } catch {
            // Stored: the caller refuses the tool anyway, and the next refresh drops it.
          }
          this.emit('clients-changed')
        }
        return done
      },
      disconnect: async (viewer) => {
        if (viewer.origin === 'remote') {
          const id = viewer.clientId
          if (this.remote.clients.get(id) === null) return false
          await this.approvalBroker?.withdrawClient(`remote:${id}`).catch(() => 0)
          this.dropAgentAsks(`remote:${id}`)
          await this.dropRemoteCapabilities(id)
          // Just after, so this call's own result still reaches the agent.
          const timer = setTimeout(() => void this.remote.revokeClient(id).catch(() => false), 1000)
          timer.unref?.()
          return true
        }
        const clientId = viewer.clientId
        if (!this.clients.isActive(clientId)) return false
        await this.clients.revoke(clientId)
        this.cancelConfirmationsOf(`local:${clientId}`)
        await this.approvalBroker?.withdrawClient(`local:${clientId}`).catch(() => 0)
        await rm(this.clients.configPath(clientId), { force: true }).catch(() => undefined)
        // The token is refused from the next request on; the session itself ends just after, so
        // this call's own result still reaches the agent.
        this.endpoint?.refuseClient(clientId)
        const timer = setTimeout(() => {
          void this.endpoint?.removeClient(clientId)
          this.emit('clients-changed')
          this.emit('endpoint-changed')
        }, 1000)
        timer.unref?.()
        return true
      },
      audit: async (event) => {
        await this.audit.append({ type: 'agent-change', ...event })
      },
      told: (clientId, name, count) => this.notifier.agentChanges(clientId, name, count),
    }
  }

  /** Valet's own settings as the write tools name them. */
  private agentSettings(): AgentSettingValues {
    return {
      messagesOtpEnabled: this.settingsNow.messagesOtpEnabled,
      notifications: this.settingsNow.notifications,
      traceRetentionDays: this.settingsNow.traceRetentionDays,
    }
  }

  /**
   * True when any of `texts` holds a secret a login registered this session, or a value from any
   * adapter's tool-partition session. Each session is read once per call. Fails closed: a session
   * that can't be read counts as a match.
   */
  private async knownSecretIn(texts: readonly string[]): Promise<boolean> {
    for (const adapter of this.deps.adapters) {
      const { id, session } = adapter.definition.manifest
      if (texts.some((text) => this.loginSecrets.occursIn(id, text))) return true
      const driver = this.drivers.get(id)
      if (driver === undefined) continue
      let values: readonly string[]
      try {
        values = await driver.sessionSecrets(session.cookieDomains, session.storage)
      } catch {
        return true
      }
      const match = sensitiveMatcher(values, NO_SECRETS)
      if (texts.some(match)) return true
    }
    return false
  }

  /** Snippets that launch the bridge with this client's own config file. */
  private serverName(): string {
    return this.deps.demo ? `${MCP_SERVER_NAME}-demo` : MCP_SERVER_NAME
  }

  private snippets(clientId: string): ClientSnippet[] {
    if (this.deps.bridge === null || !this.clients.isActive(clientId)) return []
    return clientSnippets(this.serverName(), this.deps.bridge(this.clients.configPath(clientId)))
  }

  /** The client as the screens show it, with its calls over the last seven days. */
  /** Tells connected clients their tool lists changed; a failure only delays it to the next refresh. */
  private refreshEndpoint(): void {
    try {
      this.endpoint?.refresh()
    } catch {
      // The caller checks access on every call anyway.
    }
  }

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
    const kinds = new Set(status.filter((s) => s.available).map((s) => s.kind))
    // Sign-in mail is this Mac's own, through the protocol host: there when the host is.
    if (this.mail !== null) kinds.add('mail')
    return kinds
  }

  /**
   * The mail accounts sign-in mail may be read from now (docs/imap.md#email-sign-in), as the grant
   * sheet offers them: each installed, approved protocol adapter's kept IMAP credential that has a
   * grant which counts, in an adapter none of whose tools may change INBOX, and whose granted item
   * no other adapter that may change INBOX also holds (it may be the same mailbox). A forged
   * message planted in INBOX by a write tool would skip the receiving server's checks.
   */
  async mailAccounts(): Promise<readonly VaultItem[]> {
    if (this.mail === null) return []
    const out: VaultItem[] = []
    for (const adapter of this.installed) {
      const account = await this.mailAccountOf(adapter).catch(() => null)
      if (account !== null) out.push({ id: account.ref, title: adapter.definition.manifest.name })
    }
    return out
  }

  /** One protocol adapter as a mail account, or null when it can't serve sign-in mail now. */
  private async mailAccountOf(
    adapter: BuiltinAdapter,
  ): Promise<{ readonly ref: MailAccountRef; readonly grant: CredentialGrant } | null> {
    const manifest = adapter.definition.manifest
    const imap = manifest.protocols?.imap
    if (runtimeOf(manifest) !== 'protocol' || imap === undefined) return null
    if (mayWriteInbox(manifest) || !folderAllowed('INBOX', imap.folders ?? null)) return null
    if (!(await this.installGate.isApproved(manifest.id, adapter.hash).catch(() => false))) return null
    const grant = await this.credentialKeeper.sourceFor(manifest.id, adapter.hash).findGrant(imap.credential)
    if (grant === null || grant.custody !== 'kept') return null
    // The same item granted to an adapter that may write INBOX: possibly the same mailbox. Only a
    // protocol adapter with no INBOX write tool is known not to: a raw adapter speaks IMAP itself
    // whatever its tools claim, and an http one is counted too, to be safe (red team I, XK-1).
    for (const other of this.installed) {
      const m = other.definition.manifest
      if (m.id === manifest.id) continue
      if (runtimeOf(m) === 'protocol' && !mayWriteInbox(m)) continue
      for (const name of Object.keys(credentialsOf(m))) {
        const theirs = await this.credentialKeeper.sourceFor(m.id, other.hash).findGrant(name)
        if (theirs !== null && sameVaultItem(theirs.itemRef, grant.itemRef)) return null
      }
    }
    return { ref: `${manifest.id}/${imap.credential}`, grant }
  }

  /**
   * The account a mail grant names, for one lookup: checked again now, so a revoked credential, an
   * update that adds an INBOX write tool, or an uninstall stops sign-in mail at once. It signs in
   * through the account adapter's own CredentialGate, audited as that adapter's credential use.
   */
  private async mailAccount(ref: MailAccountRef): Promise<MailAccount | null> {
    const [adapterId] = ref.split('/')
    const adapter = this.installed.find((a) => a.definition.manifest.id === adapterId)
    if (adapter === undefined) return null
    const found = await this.mailAccountOf(adapter)
    const manifest = adapter.definition.manifest
    const imap = manifest.protocols?.imap
    if (found === null || found.ref !== ref || imap === undefined) return null
    const source = this.credentialKeeper.sourceFor(manifest.id, adapter.hash)
    return {
      protocol: imap,
      mayWriteInbox: false,
      signIn: () =>
        new CredentialGate({
          adapterId: manifest.id,
          adapterHash: adapter.hash,
          credentials: manifest.credentials,
          findGrant: source.findGrant,
          resolve: source.resolve,
          audit: this.audit,
          // The password goes only to the protocol host; nothing it returns reaches any output.
          remember: () => {},
          callId: null,
        }).signIn(imap.credential, 'imap', imap.endpoint),
      record: (c) =>
        void this.audit
          .append({
            type: 'egress-connection',
            adapterId: manifest.id,
            // Not a tool call: the lookup a login made for its sign-in mail.
            callId: 'sign-in-mail',
            endpoint: c.endpoint,
            kind: c.kind,
            bytesUp: c.bytesUp,
            bytesDown: c.bytesDown,
            errorClass: c.errorClass,
          })
          .catch(() => undefined),
    }
  }

  /** Removes traces and screenshots older than the retention setting (D27). Never fails a caller. */
  private async pruneTraces(): Promise<void> {
    await pruneOlderThan(this.deps.paths.traces, this.settingsNow.traceRetentionDays, this.deps.now()).catch(
      () => undefined,
    )
  }

  /**
   * The relay: the one a development build was started with (VALET_RELAY_ORIGIN), otherwise the
   * host the person set in Settings › Devices.
   */
  private async relaySetup(): Promise<RelaySetup | null> {
    if (this.deps.relay !== undefined && this.deps.relay !== null) return this.deps.relay
    const settings = await this.settings.get()
    return relayFromHost(settings.relayHost, settings.relayMacHost)
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
      phones: {
        status: async () => ({ ...this.phones.status(), worksLocked: await this.keysWorkLocked() }),
        startPairing: async () => this.phones.startPairing(),
        confirmPairing: (code) => this.phones.confirmPairing(code),
        cancelPairing: async () => this.phones.cancelPairing(),
        remove: async (deviceId) => {
          const devices = this.deviceStore
          if (devices === null || !devices.isActivePhone(deviceId))
            throw new ValetError('config', 'not-found')
          this.phones.unpair(deviceId)
          await devices.revoke(deviceId, 'mac-ui', new Date(this.deps.now()).toISOString())
          await this.audit.append({ type: 'device-revoked', deviceId, by: 'mac-ui' })
          this.emit('phones-changed')
          await this.refreshPhoneStatus()
          // Off the account's list too; a cancelled prompt leaves "Try again" in Settings.
          void this.phones.rosterChanged().catch(() => undefined)
        },
        renewKeys: () => this.renewKeys(),
        joinHub: async () => {
          if (!this.phones.joinHub()) throw new ValetError('config', 'not-found')
          const url = this.phones.hubPage('/link')
          if (url !== null) deps.ui.openExternal(url)
        },
        openHub: async () => {
          const url = this.phones.hubPage('/')
          if (url === null) throw new ValetError('config', 'not-found')
          deps.ui.openExternal(url)
        },
        leaveHub: async () => {
          if (!this.phones.leaveHub()) throw new ValetError('config', 'not-found')
        },
        retryRoster: () => this.phones.rosterChanged(),
      },
      adapters: {
        list: async () => (await this.states()).map(adapterSummary),
        get: async (adapterId) => {
          const state = (await this.states()).find((s) => s.adapter.definition.manifest.id === adapterId)
          return state === undefined ? null : adapterDetail(state)
        },
        settingChoices: (adapterId, setting, query) => this.settingChoices(adapterId, setting, query),
        setSetting: (adapterId, setting, value) => this.setSetting(adapterId, setting, value),
        clearSetting: (adapterId, setting) => this.clearSetting(adapterId, setting),
        openCart: async (adapterId) => {
          const state = (await this.states()).find((s) => s.adapter.definition.manifest.id === adapterId)
          const url = state === undefined ? null : adapterSummary(state).cartUrl
          if (url === null) throw new ValetError('config', 'not-found')
          // The manifest's own https page on one of its navigation origins (core checks both).
          deps.ui.openExternal(url)
        },
        setPaused: (adapterId, paused) => this.setSitePaused(adapterId, paused),
        versions: (adapterId) => this.adapterVersions(adapterId),
        rollbackPreview: (adapterId, hash) => this.rollbackPreview(adapterId, hash),
        rollback: (adapterId, hash) => this.rollback(adapterId, hash),
        canRemove: async (adapterId) => this.canRemove(adapterId),
        remove: (adapterId) => this.removeAdapter(adapterId),
        canInstallFromFolder: async () => this.packages !== null && deps.packages?.folders !== undefined,
        installFromFolder: async () => {
          const folders = deps.packages?.folders
          if (this.packages === null || folders === undefined) throw new ValetError('config', 'unavailable')
          try {
            const files = await folders.pick()
            if (files === null) return null
            return { ok: true, ...(await this.installPackage(files, 'folder')) }
          } catch (error) {
            return { ok: false, reason: installReason(error) }
          }
        },
      },
      drafts: {
        list: () => this.draftOverviews(),
        get: (draftId) => this.draftPage(draftId),
        openFolder: async (draftId) => {
          const record = await this.drafts.record(draftId).catch(() => null)
          if (record === null) throw new ValetError('config', 'not-found')
          deps.ui.showFolder(this.drafts.filesFolder(draftId))
        },
        endSession: async (draftId) => this.endAuthoringSession(draftId),
      },
      approvals: {
        pending: async () => this.pendingReviews(await this.states()),
        turnedDown: async () => this.turnedDownReviews(await this.states()),
        approve: async (adapterId, hash) => {
          const adapter = this.requireAdapter(adapterId)
          // An agent's draft: the person approves the agent's own request, so the agent learns
          // the outcome and the card it was shown is the one signed (docs/authoring-tools.md).
          const draft = this.draftRequestFor(adapterId, hash)
          if (draft !== null) {
            const broker = this.approvalBroker
            if (broker === null) throw new ValetError('config', 'unavailable')
            const answered = await broker.approveOnMac(draft.id)
            if (!answered.ok && answered.reason !== 'cancelled' && answered.reason !== 'busy')
              throw new ValetError('manifest', 'invalid')
            return
          }
          // Only the bundle installed and waiting now; a stale review's hash is refused.
          if (adapter.hash !== hash) throw new ValetError('manifest', 'invalid')
          // Touch ID at this Mac signs it; the handler applies it (approvalHandlers).
          // A version this app ships is labelled built in; anything else by where it came from.
          const source = this.isBuiltIn(adapter)
            ? 'builtin'
            : adapter.source === 'draft'
              ? 'draft'
              : 'local-folder'
          await this.signInstall(adapter, source)
        },
        reject: async (adapterId, hash, note) => {
          const adapter = this.requireAdapter(adapterId)
          // An agent's draft is declined, so the agent hears it, with the person's note if they gave
          // one; a staged one never ran.
          const draft = this.draftRequestFor(adapterId, hash)
          const said = note?.trim() ?? ''
          if (draft !== null)
            await this.approvalBroker
              ?.decline(draft.id, { via: 'mac' }, said === '' ? {} : { note: said })
              .catch(() => false)
          if (draft !== null && adapter.hash !== hash) return
          if (adapter.hash !== hash) throw new ValetError('manifest', 'invalid')
          // Only tightens: the evidence goes first, so a failed store write still leaves it off.
          await this.revokeInstall(adapterId, hash)
          await this.approvals.reject(adapterId, hash, adapter.definition.manifest.version)
          await this.refreshTools()
        },
      },
      grants: {
        list: async () => {
          const records = await this.reader.records()
          const titles = await this.titles.read()
          return (await this.signedGrants.list()).map((g) => grantInfo(g, titles, lastUsed(records, g)))
        },
        providers: async () => {
          const grants = await this.signedGrants.list().catch(() => [] as readonly Grant[])
          // Only grants for an adapter's installed hash, while that hash is approved: a grant for an
          // older bundle (or one waiting for review) can't be used, so it isn't counted as live.
          const live = new Set<string>()
          for (const adapter of this.installed) {
            const id = adapter.definition.manifest.id
            if (await this.installGate.isApproved(id, adapter.hash).catch(() => false))
              live.add(`${id}:${adapter.hash}`)
          }
          return (await deps.credentials.status()).map((s) => ({
            ...s,
            grantCount: grants.filter(
              (g) => g.provider === s.kind && live.has(`${g.adapterId}:${g.adapterHash}`),
            ).length,
          }))
        },
        vaultItems: async (provider) => {
          try {
            // Sign-in mail's "items" are the mail accounts it may be read from.
            if (provider === 'mail') return { status: 'ok', items: await this.mailAccounts() }
            return { status: 'ok', items: await deps.credentials.vaultItems(provider) }
          } catch (error) {
            // Only the kind of failure crosses to the window, and the account name the person typed.
            const account = (await this.settings.get()).onePasswordAccount
            const declined = error instanceof CredentialError && error.failure === 'locked'
            return { status: declined ? 'declined' : 'unavailable', account }
          }
        },
        make: async (request) => {
          const adapter = this.requireAdapter(request.adapterId)
          const checked = await checkGrantRequest(request, {
            manifest: adapter.definition.manifest,
            installedHash: adapter.hash,
            available: await this.available(),
            vaultItems: (provider) => deps.credentials.vaultItems(provider),
            mailAccounts: () => this.mailAccounts(),
            now: () => new Date(deps.now()),
          })
          const { grant } = checked
          // Touch ID at this Mac signs exactly this grant: the item, the fields, the origins.
          const signed = await this.approveHere(
            'secret-grant',
            grantSubject(adapter.definition.manifest, grant, checked.title),
          )
          if (!signed) throw new ValetError('grant', 'not-granted')
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
          if (
            secret !== MESSAGES_SECRET &&
            secret !== MAIL_SECRET &&
            !Object.hasOwn(adapter.definition.manifest.secrets, secret)
          ) {
            throw new ValetError('grant', 'not-found')
          }
          const before = await this.grants.list()
          await this.revokeGrantEvidence(adapterId, secret)
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
          const grant = await this.signedGrants.find(adapterId, adapter.hash, secret)
          if (grant === null || grant.provider !== 'keychain-copy') throw new ValetError('grant', 'not-found')
          await this.copyGrantItem(grant, adapter.definition.manifest)
          await this.releaseLoginHold(adapterId)
          this.emit('grants-changed')
        },
      },
      credentials: {
        list: () => this.credentialKeeper.list(),
        make: async (request) => {
          const info = await this.oneAtATime(request.adapterId, () => this.credentialKeeper.make(request))
          this.emit('grants-changed')
          if (this.answerCredentialAsks(info.adapterId, info.adapterHash, info.credential))
            this.emit('attention-changed')
          return info
        },
        revoke: async (adapterId, credential) => {
          await this.oneAtATime(adapterId, () => this.credentialKeeper.revoke(adapterId, credential))
          this.emit('grants-changed')
        },
        generateKey: async (adapterId, credential) => {
          const { itemRef, publicKey, fingerprint, createdAt } = await this.credentialKeeper.generateKey(
            adapterId,
            credential,
          )
          return { itemRef, publicKey, fingerprint, createdAt }
        },
      },
      runs: {
        list: async (query) =>
          runSummaries(await this.reader.records(), this.lookup(), query ?? {}, this.memory),
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
          // Apps with a session open now, bridged or HTTP: one app reconnecting, or leaving a
          // session behind when it went away without ending it, is still one app.
          connectedClients: new Set(
            (this.endpoint?.sessions().sessions ?? []).map((session) => identityLabel(session.identity)),
          ).size,
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
          // The client exists either way: a log that can't be written (its own Needs you item says
          // so) doesn't make adding it look failed.
          await this.audit
            .append({ type: 'client-added', clientId: `local:${client.id}` })
            .catch(() => undefined)
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
          await this.audit
            .append({ type: 'client-reset', clientId: `local:${clientId}` })
            .catch(() => undefined)
          this.emit('clients-changed')
          this.emit('endpoint-changed')
        },
        revoke: async (clientId) => {
          if (!this.clients.isActive(clientId)) throw new ValetError('config', 'not-found')
          const label = `local:${clientId}`
          // The registry first: if the app quits part-way, the next start issues it no token.
          await this.clients.revoke(clientId)
          // Its token is refused from here on. A call of its waiting on a confirmation ends now, as
          // cancelled by the revoke (not as the person's decline), and its answer still reaches it
          // before its sessions close; so do its other calls (removeClient). All of it happens before
          // the audit record, so a log that can't be written never leaves a revoked app working.
          this.endpoint?.refuseClient(clientId)
          this.cancelConfirmationsOf(label)
          await this.approvalBroker?.withdrawClient(label).catch(() => 0)
          try {
            await this.endpoint?.removeClient(clientId)
            await rm(this.clients.configPath(clientId), { force: true })
          } finally {
            await this.audit.append({ type: 'client-revoked', clientId: label }).catch(() => undefined)
          }
          this.emit('clients-changed')
          this.emit('endpoint-changed')
        },
        snippets: async (clientId) => this.snippets(clientId),
        copyConfig: async (clientId, kind) => {
          const text = snippetFor(this.snippets(clientId), kind)
          if (text === null) throw new ValetError('config', 'unavailable')
          deps.ui.writeClipboard(text)
        },
        addToClaudeDesktop: async (clientId) => {
          const path = deps.claudeDesktopConfig
          if (path === null || deps.bridge === null) throw new ValetError('config', 'unavailable')
          if (!this.clients.isActive(clientId)) throw new ValetError('config', 'not-found')
          const bridge = deps.bridge(this.clients.configPath(clientId))
          const result = await addToDesktopConfig(path, this.serverName(), bridge, deps.now())
          return { path, ...result }
        },
        access: async (clientId) => {
          const capabilities = this.clients.capabilities(clientId)
          if (capabilities === null) throw new ValetError('config', 'not-found')
          return { ...capabilities, toolsOff: [...this.clients.toolsOff(clientId)].sort() }
        },
        setAccess: async (clientId, patch) => {
          const before = this.clients.capabilities(clientId)
          if (before === null || !(await this.clients.setCapabilities(clientId, patch)))
            throw new ValetError('config', 'not-found')
          const after = this.clients.capabilities(clientId) ?? before
          // Turning Ask for changes on widens what the app may do: every change is recorded, and
          // one that can't be recorded is undone before the app could use it.
          if (capabilityNames(before).join() !== capabilityNames(after).join()) {
            try {
              await this.audit.append({
                type: 'client-access-changed',
                clientId: `local:${clientId}`,
                before: capabilityNames(before),
                after: capabilityNames(after),
              })
            } catch (error) {
              await this.clients.setCapabilities(clientId, before)
              throw error
            }
          }
          this.refreshEndpoint()
          this.emit('clients-changed')
        },
        turnToolOn: async (clientId, qualified) => {
          if (!(await this.clients.turnOnTool(clientId, qualified)))
            throw new ValetError('config', 'not-found')
          // Recorded before the app can use it; undone if it can't be.
          try {
            await this.audit.append({
              type: 'client-tool-on',
              clientId: `local:${clientId}`,
              tool: qualified,
            })
          } catch (error) {
            await this.clients.turnOffTool(clientId, qualified)
            throw error
          }
          this.refreshEndpoint()
          this.emit('clients-changed')
        },
      },
      attention: {
        list: async (): Promise<AttentionItem[]> => {
          const states = await this.states()
          const reviews = (await this.pendingReviews(states)).map(reviewItem)
          return sortAttention([
            ...this.handoffs.list(),
            ...this.broker.list(),
            ...this.consentItems(),
            ...this.agentRequestItems(),
            ...reviews,
            ...states.flatMap(missingItems),
            ...this.repairItems(),
            ...this.missed.list(),
            ...this.keysChangedItems(states),
          ])
        },
        dismiss: async (id) => {
          const macId = this.deviceStore?.macId
          if (id === KEYS_CHANGED_ID && macId !== undefined && this.oldKeysSigned() !== null) {
            await this.keysNotice.dismiss(macId)
            this.emit('attention-changed')
            return
          }
          if (!this.missed.dismiss(id)) throw new ValetError('config', 'not-found')
        },
        approveRequest: async (id, choice) => {
          // A credential is granted on the site's Credentials card, where the person picks the item.
          if (this.credentialAsks.has(id)) throw new ValetError('config', 'invalid')
          const removal = this.removalAsks.get(id)
          if (removal !== undefined) {
            this.removalAsks.delete(id)
            await this.removeAdapter(removal.adapterId ?? '', removal.asker)
            return true
          }
          const broker = this.approvalBroker
          const pending = broker?.get(id) ?? null
          if (broker === null || pending === null || agentRequestItem(pending) === null)
            throw new ValetError('config', 'not-found')
          const result = await broker.approveOnMac(id, choice === null ? {} : { choice })
          return result.ok
        },
        declineRequest: async (id) => {
          const credentialAsk = this.credentialAsks.get(id)
          if (credentialAsk !== undefined) {
            const now = this.deps.now()
            for (const [key, at] of this.credentialDeclines)
              if (now - at >= CREDENTIAL_DECLINE_COOLDOWN_MS) this.credentialDeclines.delete(key)
            this.credentialDeclines.set(
              `${credentialAsk.asker} ${credentialAsk.adapterId} ${credentialAsk.credential}`,
              now,
            )
          }
          if (this.removalAsks.delete(id) || this.credentialAsks.delete(id)) {
            this.emit('attention-changed')
            return true
          }
          const broker = this.approvalBroker
          const pending = broker?.get(id) ?? null
          if (broker === null || pending === null || agentRequestItem(pending) === null) return false
          return broker.decline(id, { via: 'mac' })
        },
      },
      answerConfirmation: (confirmationId: string, approved: boolean, from: AppWindow) =>
        this.broker.answer(confirmationId, approved, from),
      openConfirmation: async (confirmationId: string) => {
        if (!this.broker.has(confirmationId)) throw new ValetError('config', 'not-found')
        deps.ui.focusConfirmation(confirmationId)
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
          // What widens (codes from Messages on, notifications off, a shorter retention) is a
          // signed setting request, applied by its handler once approved; the rest is a click.
          const { messagesOtpEnabled, notifications, traceRetentionDays, ...rest } = patch
          if (messagesOtpEnabled !== undefined)
            await this.changeValetSetting('messages_otp', messagesOtpEnabled)
          if (notifications !== undefined) await this.changeValetSetting('notifications', notifications)
          if (traceRetentionDays !== undefined)
            await this.changeValetSetting('trace_retention', traceRetentionDays)
          const settings = await this.settings.set(rest)
          if (patch.launchAtLogin !== undefined) deps.ui.setLaunchAtLogin(settings.launchAtLogin)
          if (patch.relayHost !== undefined || patch.relayMacHost !== undefined)
            await this.phones.setRelay(await this.relaySetup())
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
      remote: {
        consents: async () => {
          const view = this.remote.consentView()
          return {
            requests: this.consentRequests(),
            tools: view.tools.map((t) => {
              const manifest = this.adapter(t.adapterId)?.definition.manifest
              const declaration = manifest?.tools.find((d) => d.name === t.tool)
              return {
                ...t,
                adapterName: manifest?.name ?? t.adapterId,
                toolTitle: declaration?.title ?? t.tool,
              }
            }),
          }
        },
        approveConsent: async (code, tools, capabilities = []) => {
          const consent = this.remote.consentFor(code)
          const typed = normaliseCode(code)
          // A sign-in through the hub: the grant covers what each Mac lets remote agents use.
          const agents = this.phones.hubAgents
          const viaHub = consent === null ? (agents?.matching(code) ?? null) : null
          if (agents !== null && agents !== undefined && viaHub !== null) {
            if (!(await agents.approve(viaHub))) throw new ValetError('config', 'not-found')
            await this.audit.append({
              type: 'remote-consent',
              clientId: `hub:${viaHub.clientId}`,
              clientHost: viaHub.host,
              source: viaHub.source === '' ? null : viaHub.source,
              tools: [],
              answer: 'approved',
            })
            return 'approved'
          }
          // A wrong code goes straight through, so it counts against the three tries.
          if (consent === null || typed === null) return this.remote.approveConsent(code, tools)
          const on = new Set(this.remote.status().tools)
          if (tools.some((t) => !on.has(t))) throw new ValetError('config', 'invalid')
          await this.approveOrRefuse('remote-client', remoteClientSubject(consent, tools, capabilities), {
            consentCode: displayCode(typed),
            typedCode: displayCode(typed),
          })
          // Applied by the handler: the request is no longer waiting once it was.
          if (this.remote.consentFor(code) !== null) throw new ValetError('config', 'not-found')
          return 'approved'
        },
        declineConsent: async (id) => {
          if (id.startsWith('hub:')) {
            if (this.phones.hubAgents?.decline(id.slice(4)) !== true)
              throw new ValetError('config', 'not-found')
            return
          }
          if (!this.remote.declineConsent(id)) throw new ValetError('config', 'not-found')
        },
        declineAllConsents: async () => {
          this.phones.hubAgents?.declineAll()
          this.remote.declineAllConsents()
        },
        clients: async () =>
          this.remote.remoteClients().map((c) => ({
            id: c.id,
            host: c.host,
            clientName: c.clientName,
            registeredAt: new Date(c.registeredAt).toISOString(),
            grant:
              c.grant === null
                ? null
                : { tools: c.grant.tools, grantedAt: new Date(c.grant.grantedAt).toISOString() },
            ...this.remoteCapabilities(c.id),
          })),
        revokeClient: async (id) => {
          if (this.remote.clients.get(id) === null) throw new ValetError('config', 'not-found')
          // As for a local app: a call waiting on a confirmation ends now, as revoked.
          this.cancelConfirmationsOf(`remote:${id}`)
          if (!(await this.remote.revokeClient(id))) throw new ValetError('config', 'not-found')
          await this.dropRemoteCapabilities(id)
        },
        hubAgents: async () => {
          const agents = this.phones.hubAgents
          return (agents?.grants() ?? []).map(({ id, grant }) => ({
            id,
            host: grant.host,
            clientName: grant.clientName,
            approvedAt: grant.at,
            expiresAt: grant.expiresAt,
            approvedHere: grant.by === agents?.macId,
          }))
        },
        revokeHubAgent: async (id) => {
          const agent = this.phones.hubAgents?.grants().find((g) => g.id === id)
          if (agent === undefined || !this.phones.revokeHubAgent(id))
            throw new ValetError('config', 'not-found')
          await this.audit.append({
            type: 'remote-revoked',
            clientId: `hub:${agent.grant.clientId}`,
            clients: 1,
          })
        },
        revokeAllClients: async () => {
          const ids = this.remote.remoteClients().map((c) => c.id)
          for (const id of ids) this.cancelConfirmationsOf(`remote:${id}`)
          const count = await this.remote.revokeAllClients()
          for (const id of ids) await this.dropRemoteCapabilities(id)
          return count
        },
        setAskForChanges: (id, on) => this.setRemoteAsk(id, on),
        setup: () => this.remoteSetup(),
        setEnabled: async (enabled) => {
          await this.changeValetSetting('remote_enabled', enabled)
          return this.remoteSetup()
        },
        setHosts: async (hosts) => {
          await this.changeValetSetting('remote_hosts', [...hosts])
          return this.remoteSetup()
        },
        setTool: async (adapterId, tool, enabled) => {
          const adapter = this.adapter(adapterId)
          const declaration = adapter?.definition.manifest.tools.find((t) => t.name === tool)
          // On only at a side effect at least the one declared now: an update that raised it needs
          // turning on again, with Touch ID.
          const on = declaration !== undefined && this.remote.allows(adapterId, declaration)
          if (!enabled || on || adapter === null) await this.setRemoteTool(adapterId, tool, enabled)
          else {
            await this.remoteToolDeclaration(adapterId, tool, true)
            const subject = toolEnableSubject(adapter.definition.manifest, adapter.hash, tool, 'remote')
            if (subject === null) throw new ValetError('config', 'not-found')
            await this.approveOrRefuse('tool-enable', subject)
          }
          return this.remoteSetup()
        },
      },
      app: {
        status: async () => ({
          paused: this.paused,
          lockedDown: this.lockedDown,
          version: deps.version,
          demo: deps.demo,
        }),
        setPaused: async (paused) => {
          const changed = this.paused !== paused
          // In memory at once, as lock down: no call gets through while the record is written.
          this.paused = paused
          if (paused) this.authoring?.closeBrowsers()
          this.emit('app-changed')
          if (changed) await this.audit.append({ type: 'app-paused', paused })
        },
        setLockedDown: (locked) => this.setLockedDown(locked),
        openControlPanel: async (route) => deps.ui.openControlPanel(route ?? null),
        copyText: async (text) => deps.ui.writeClipboard(text),
        quit: async () => deps.ui.quit(),
        erase: async (kind) => {
          if (this.erasing) throw new ValetError('config', 'unavailable')
          this.erasing = true
          try {
            if (!(await deps.ui.confirmErase(kind))) return false
            const report = await eraseEverything({
              kind,
              dataDir: deps.paths.dir,
              leftovers: deps.leftovers ?? [],
              stop: () => this.stop(),
              eraseCredentials: async () => {
                const failed = [...(await deps.credentials.erase())] as EraseStep[]
                // Without this, the next launch's empty ledger wouldn't match its anchor.
                await deps.approvalKeys.forget().catch(() => failed.push('approvals-anchor'))
                return failed
              },
              setLaunchAtLogin: (enabled) => deps.ui.setLaunchAtLogin(enabled),
              clearBrowserData: () => deps.ui.clearBrowserData(),
            })
            // Nothing is written from here on: the folder is gone, and the app is about to be.
            deps.ui.finishErase(report)
            return true
          } finally {
            this.erasing = false
          }
        },
      },
    }
  }
}

/** The runtime's call-id alphabet: what ToolHost.call accepts. */
const CALL_ID = /^[A-Za-z0-9_-]{1,64}$/

/** A client name as the runtime records it: printable, trimmed, at most 100 characters. */
/** A set nothing is registered in: sensitiveMatcher's secrets, when only session values are matched. */
const NO_SECRETS = new SecretRedactionSet()

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
        ('messages' in step.source && secret === MESSAGES_SECRET) ||
        ('mail' in step.source && secret === MAIL_SECRET)
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

/**
 * Whether two stored references name the same vault item. A 1Password grant is `op://Valet/<id>`
 * and a Keychain copy of the same item `op://<vault id>/<id>`; 1Password item ids are unique across
 * vaults, so the item id decides (red team I, XK-1). Anything else compares exactly.
 */
export function sameVaultItem(a: string, b: string): boolean {
  if (a === b) return true
  if (!a.startsWith('op://') || !b.startsWith('op://')) return false
  const id = (ref: string) => ref.slice(ref.lastIndexOf('/') + 1)
  return id(a) !== '' && id(a) === id(b)
}

/**
 * One line of a signed preview: invisible and unprintable characters written out as codes (never
 * dropped, so nothing in it can hide), at most `max` characters with "…" where it was cut. `cut`
 * says whether anything was left off.
 */
function shownLine(text: string, max: number): { readonly line: string | undefined; readonly cut: boolean } {
  const line = showable(text)
  if (line === '(blank)' || line === '') return { line: undefined, cut: false }
  const chars = [...line]
  return chars.length <= max
    ? { line, cut: false }
    : {
        line: `${chars
          .slice(0, max - 1)
          .join('')
          .trimEnd()}…`,
        cut: true,
      }
}

function shown(text: string, max: number): string | undefined {
  return shownLine(text, max).line
}

/**
 * What a confirmation's signed request shows, at most 20 lines of 200 characters: what it asks (the
 * requests it would make, the adapter's note as the adapter's words), then the input. Past 20
 * lines, the last one says how many more there are, so a card never looks complete when it isn't.
 * A raw confirmation adds what the run reaches, and whether the lines show the whole input: when
 * they don't, only the Mac, which shows all of it, may approve.
 */
export function confirmationPreview(item: ConfirmationItem): {
  preview: string[]
  raw?: {
    endpoints: string[]
    credentials: string[]
    readFolders: string[]
    writeFolders: string[]
    inputComplete: boolean
  }
} {
  const lines: string[] = []
  for (const r of [...item.unlocks, ...item.requests]) {
    const kept = shown(describeDeclaration(r), 200)
    if (kept !== undefined) lines.push(kept)
  }
  if (item.adapterNote !== null) {
    const note = shown(`The adapter says: ${item.adapterNote}`, 200)
    if (note !== undefined) lines.push(note)
  }
  const text = item.input.map((p) => (p.kind === 'text' ? p.text : `[${p.label}]`)).join('')
  let cut = false
  for (const line of text.split('\n')) {
    const kept = shownLine(line, 200)
    // Cut short, or shown other than as it is (a code for an invisible character, spaces run
    // together): the phone's card isn't the whole input.
    cut ||= kept.cut || (kept.line !== undefined && kept.line !== line.trim())
    if (kept.line !== undefined) lines.push(kept.line)
  }
  const kept =
    lines.length <= 20 ? lines : [...lines.slice(0, 19), `and ${lines.length - 19} more lines not shown`]
  // A send's recipients are what a yes is about: every one must be on the signed preview, whole, or
  // nobody is asked at all and the send is declined (red team I). The body may be cut, and says so.
  if (item.trigger === 'mail-send') {
    const recipients = text.split('\n').filter((l) => /^(To|Cc|Bcc): /.test(l))
    if (!recipients.every((l) => kept.includes(l))) throw new ValetError('tool-run', 'unavailable')
  }
  if (item.trigger !== 'raw-tool') return { preview: kept }
  // Without its reach, a raw confirmation would read as an ordinary one: nobody is asked.
  if (item.raw === null || item.raw.endpoints.length === 0) throw new ValetError('tool-run', 'unavailable')
  return {
    preview: kept,
    raw: {
      endpoints: [...item.raw.endpoints],
      credentials: [...item.raw.credentials],
      readFolders: [...item.raw.readFolders],
      writeFolders: [...item.raw.writeFolders],
      inputComplete: !cut && lines.length <= 20,
    },
  }
}

/** A remote client's registration id from its `remote:<id>` name, or null for any other. */
function remoteClientKey(clientId: string): string | null {
  return clientId.startsWith('remote:') && clientId.length > 7 ? clientId.slice(7) : null
}

/** The value a signed decision picked on a card with choices, if any. */
function decisionChoice(payload: string): string | undefined {
  try {
    return approvalDecisionSchema.parse(JSON.parse(payload)).choice
  } catch {
    return undefined
  }
}

/** The consent code a signed decision carries, if any. */
function decisionTypedCode(payload: string): string | undefined {
  try {
    return approvalDecisionSchema.parse(JSON.parse(payload)).typedCode
  } catch {
    return undefined
  }
}

/** For a remote client's consent: the code the browser shows, and the code the person typed. */
interface ConsentExtras {
  readonly consentCode?: string
  readonly typedCode?: string
}

/** As remote.ts keeps them: more is refused whole. */
const MAX_REMOTE_HOSTS = 8

/** A broker refusal of a draft's request, in words for the agent. */
function submitRefusal(reason: string, until?: string): string {
  const when = until === undefined ? '' : ` until ${until}`
  switch (reason) {
    case 'locked-down':
      return 'Not submitted: Valet is locked down.'
    case 'cooling-down':
      return `Not submitted: the person declined your last request and asked for a pause${when}.`
    case 'daily-limit':
      return `Not submitted: you have asked for as many approvals as Valet allows in a day${when}.`
    case 'too-many-waiting':
      return 'Not submitted: you have as many requests waiting as Valet allows. Withdraw one first.'
    case 'too-many-total':
      return 'Not submitted: the person has as many requests waiting as Valet shows. Try later.'
    case 'not-allowed':
      return 'Not submitted: Valet doesn’t take this request from an agent.'
    default:
      return 'Not submitted: Valet can’t ask for approvals right now.'
  }
}

function feedbackPart(desk: FeedbackDeskImpl | null): { feedback?: FeedbackDeskImpl } {
  return desk === null ? {} : { feedback: desk }
}
