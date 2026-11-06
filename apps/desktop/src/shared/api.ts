// The contract between the renderer and the main process: what the preload exposes as
// `window.siteadapter` through contextBridge. The renderer is untrusted UI. It reads plain JSON and
// asks the main process to act; it never receives a secret value, a 1Password item reference's
// contents, a session cookie or the endpoint token, and nothing here can carry one.
//
// Every method is async and every value is structured-clone-safe JSON. Errors reject with a bare
// Error whose message the renderer never shows: the renderer prints its own wording.
//
// Free text that comes from an adapter (titles, descriptions, manifest notes, confirm() messages)
// is shown inside the app only, always as plain text and attributed to the adapter.

import type {
  AuditEvent,
  AuditRecord,
  AuthStep,
  BlockedRequest,
  ErrorClass,
  NeedsUserReason,
  ProviderKind,
  Purpose,
  RequestDeclaration,
  RunOutcome,
  SecretField,
  Stage,
} from '@siteadapter/core'

/** An ISO 8601 timestamp. */
export type IsoTime = string

// ---------- Adapters ----------

export type ApprovalState =
  /** The installed hash is approved and its tools are on MCP. */
  | 'approved'
  /** Installed but never approved: nothing is on MCP. */
  | 'unapproved'
  /** The person rejected this hash. */
  | 'rejected'

export type SessionState =
  | 'logged-in'
  /** The last probe said logged out; the next call logs in. */
  | 'expired'
  /** No probe has run since launch. */
  | 'unknown'
  | 'logging-in'
  /** A login ended in needsUser and its window is waiting for the person. */
  | 'needs-user'

export interface SessionStatus {
  readonly state: SessionState
  /** When the last probe ran. */
  readonly checkedAt: IsoTime | null
  /** Set when state is needs-user. */
  readonly needsUser: NeedsUserReason | null
  readonly since: IsoTime | null
}

export interface SecretSummary {
  readonly name: string
  readonly granted: boolean
}

export interface AdapterSummary {
  readonly id: string
  readonly name: string
  /** The site's host, for display, e.g. woolworths.com.au. */
  readonly site: string
  readonly version: string
  /** Full sha256 hex of the installed bundle. */
  readonly hash: string
  readonly approval: ApprovalState
  /** A newer bundle waiting for review, if any. Calls keep using the installed one until approved. */
  readonly pendingUpdate: { readonly version: string; readonly hash: string } | null
  readonly toolCounts: Readonly<Record<Purpose, number>>
  readonly secrets: readonly SecretSummary[]
  /** Declared Messages one-time-code sources and whether each has a grant. */
  readonly messagesSources: readonly { readonly sender: string; readonly granted: boolean }[]
  readonly session: SessionStatus
  readonly calls7d: number
}

export interface ToolInfo {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly sideEffect: Purpose
  readonly calls7d: number
}

/**
 * A grant as the renderer sees it: which item by opaque id and title, never an `op://` reference,
 * a field or a value.
 */
export interface GrantInfo {
  readonly adapterId: string
  readonly adapterHash: string
  readonly secret: string
  readonly provider: ProviderKind
  /** The VaultItem id the grant uses (the same opaque id GrantRequest.itemRef sent), or for a messages grant the approved sender handle. Not a secret. */
  readonly itemId: string
  /** The 1Password item's title, or for a messages grant the approved sender handle. */
  readonly itemTitle: string
  readonly origins: readonly string[]
  readonly grantedAt: IsoTime
  readonly lastUsedAt: IsoTime | null
}

export interface SecretRequestInfo {
  readonly name: string
  readonly description: string
  readonly fields: readonly SecretField[]
  /** What the manifest asked for. A grant may narrow this, never widen it. */
  readonly origins: readonly string[]
  /** The grant for the installed hash, or null. */
  readonly grant: GrantInfo | null
}

export interface MessagesSourceInfo {
  readonly sender: string
  readonly maxAgeSeconds: number
  /** Origins the code may be typed on: the manifest's navigation origins. */
  readonly requestedOrigins: readonly string[]
  /**
   * Non-null only for the sender the grant names (grant.itemId === sender). Core keeps one messages
   * grant per adapter hash, so when a manifest declares several senders at most one is granted.
   */
  readonly grant: GrantInfo | null
}

export type ProbeInfo =
  | {
      readonly kind: 'fetch'
      readonly path: string
      readonly expectStatus: number
      readonly loggedOutStatuses: readonly number[]
      readonly jsonPath: string | null
      /** What the value at jsonPath must equal; null means present and truthy. */
      readonly equals: string | number | boolean | null
    }
  | { readonly kind: 'cookie'; readonly name: string }

export interface AdapterDetail extends AdapterSummary {
  readonly description: string
  readonly home: string
  readonly approvedAt: IsoTime | null
  readonly partitions: { readonly auth: string; readonly tool: string }
  readonly navigation: readonly string[]
  readonly frameOrigins: readonly string[]
  readonly egress: readonly string[]
  readonly cookieDomains: readonly string[]
  readonly storage: readonly { readonly origin: string; readonly keys: readonly string[] }[]
  readonly probe: ProbeInfo
  readonly requests: readonly RequestDeclaration[]
  readonly limits: {
    readonly requestsPerRun: number
    readonly minGapMs: number
    readonly cooldownSeconds: number
    readonly maxCooldownSeconds: number
  }
  readonly tools: readonly ToolInfo[]
  readonly secretRequests: readonly SecretRequestInfo[]
  readonly messages: readonly MessagesSourceInfo[]
  /** What the last hand-off copied: counts only. */
  readonly handedOver: { readonly cookies: number; readonly storageKeys: number } | null
}

// ---------- Approvals ----------

/** One list in a permission diff. An entry whose content changed is one removal plus one addition. */
export interface ListDiff<T> {
  readonly added: readonly T[]
  readonly removed: readonly T[]
  readonly unchanged: readonly T[]
}

export interface ToolDiffEntry {
  readonly name: string
  readonly title: string
  readonly sideEffect: Purpose
}

export interface SecretDiffEntry {
  readonly name: string
  readonly description: string
  readonly fields: readonly SecretField[]
  readonly origins: readonly string[]
}

/** Which selector an auth step types which secret field into. */
export interface SecretFillEntry {
  readonly selector: string
  readonly secret: string
  readonly field: SecretField
}

/**
 * One declarative auth step other than `fill` (secretFills covers those), in manifest order, with
 * steps inside when/retry flattened after their parent. `detail` is rendered by the runtime from the
 * manifest's structured fields (selector, URL, condition, reason code), never from page text and
 * never from a needsUser or fail step's note. A step whose detail changed is one removal plus one
 * addition.
 */
export interface AuthStepEntry {
  readonly op: AuthStep['op']
  readonly detail: string
}

export interface LimitsInfo {
  readonly requestsPerRun: number
  readonly minGapMs: number
  readonly cooldownSeconds: number
  readonly maxCooldownSeconds: number
}

export interface PermissionDiff {
  readonly navigation: ListDiff<string>
  readonly frameOrigins: ListDiff<string>
  readonly egress: ListDiff<string>
  readonly cookieDomains: ListDiff<string>
  readonly storage: ListDiff<{ readonly origin: string; readonly key: string }>
  readonly requests: ListDiff<RequestDeclaration>
  readonly tools: ListDiff<ToolDiffEntry>
  readonly secrets: ListDiff<SecretDiffEntry>
  readonly secretFills: ListDiff<SecretFillEntry>
  /** Every other login step: goto, click, waitFor, when/retry, otp, needsUser, fail, and so on. */
  readonly authSteps: ListDiff<AuthStepEntry>
  readonly messagesSources: ListDiff<{ readonly sender: string }>
  /** Null for a first install. */
  readonly limits: { readonly before: LimitsInfo; readonly after: LimitsInfo } | null
  /** Null for a first install. The renderer compares the two itself. */
  readonly probe: { readonly before: ProbeInfo; readonly after: ProbeInfo } | null
}

export interface ManifestDiffLine {
  readonly kind: 'hunk' | 'add' | 'del' | 'same'
  readonly oldLine: number | null
  readonly newLine: number | null
  readonly text: string
}

export interface FileChange {
  readonly path: string
  readonly status: 'added' | 'modified' | 'removed'
  readonly added: number
  readonly removed: number
}

export interface PendingReview {
  readonly adapterId: string
  readonly name: string
  readonly site: string
  /** Null for a first install. */
  readonly from: { readonly version: string; readonly hash: string } | null
  readonly to: { readonly version: string; readonly hash: string }
  readonly submittedAt: IsoTime
  /** Where the bundle came from. */
  readonly source: 'import' | 'ide' | 'authoring-agent'
  readonly diff: PermissionDiff
  readonly manifestDiff: readonly ManifestDiffLine[]
  readonly files: readonly FileChange[]
}

// ---------- Grants ----------

export interface ProviderStatus {
  readonly kind: ProviderKind
  /** Installed, configured and reachable. */
  readonly available: boolean
  /** Why not, as a code the renderer words itself. */
  readonly unavailableReason: 'not-configured' | 'not-installed' | 'disabled' | null
  readonly grantCount: number
}

/** An item in the siteadapter vault. Title only: no fields, no URLs, no usernames. */
export interface VaultItem {
  readonly id: string
  readonly title: string
}

export interface GrantRequest {
  readonly adapterId: string
  /** The exact hash the person is granting for. A grant never carries to another hash. */
  readonly adapterHash: string
  readonly secret: string
  readonly provider: ProviderKind
  /** A VaultItem id, or for provider 'messages' the sender handle the manifest declared. */
  readonly itemRef: string
  readonly origins: readonly string[]
}

// ---------- Runs ----------

export interface RunSummary {
  readonly callId: string
  readonly adapterId: string
  readonly adapterName: string
  readonly tool: string
  readonly sideEffect: Purpose
  readonly client: string
  readonly startedAt: IsoTime
  /** Null while running. */
  readonly durationMs: number | null
  readonly outcome: RunOutcome | 'running'
  readonly needsUser: NeedsUserReason | null
  readonly stage: Stage | null
  readonly errorClass: ErrorClass | null
  readonly blockedRequests: number
}

export type FillCheck = 'frame-origin' | 'input-type' | 'form-action' | 'paced-keystrokes' | 'input-reachable'

export type TraceStep = {
  readonly atMs: number
  readonly durationMs: number | null
  readonly stage: Stage
} & (
  | { readonly type: 'called'; readonly client: string; readonly sideEffect: Purpose }
  | {
      readonly type: 'probe'
      readonly partition: 'auth' | 'tool'
      readonly path: string
      readonly status: number | null
      readonly loggedIn: boolean
      /** True for the probe the runtime makes after a hand-off (assertLoggedIn). */
      readonly afterHandoff: boolean
    }
  | { readonly type: 'login-started' }
  /** A declarative auth step, rendered by the runtime from the manifest (never page text). */
  | { readonly type: 'auth-step'; readonly op: string; readonly detail: string; readonly skipped: boolean }
  | {
      readonly type: 'secret-fill'
      readonly selector: string
      readonly secret: string
      readonly field: SecretField
      readonly origin: string
      readonly checks: readonly FillCheck[]
    }
  | {
      readonly type: 'handoff'
      readonly cookies: number
      readonly storageKeys: number
      readonly cookieDomains: readonly string[]
    }
  | { readonly type: 'tool-code' }
  | {
      readonly type: 'request'
      readonly method: string
      /** Origin and path only. Same-origin requests show the path alone. */
      readonly target: string
      readonly initiator: 'tool' | 'page'
      readonly decision: 'allowed' | 'blocked'
      readonly purpose: Purpose | null
      readonly status: number | null
      readonly blockedReason: BlockedRequest['reason'] | null
    }
  | { readonly type: 'confirmation'; readonly answer: 'approved' | 'declined' | 'timed-out' }
  | { readonly type: 'needs-user'; readonly reason: NeedsUserReason }
  | { readonly type: 'failed'; readonly errorClass: ErrorClass }
  | { readonly type: 'output'; readonly redactions: number; readonly bytes: number }
)

/**
 * A redacted JSON preview, split into text and markers so the renderer can draw redactions without
 * parsing. The main process has already replaced every secret and session value.
 */
export type PreviewPart =
  | { readonly kind: 'text'; readonly text: string }
  | {
      readonly kind: 'redacted'
      readonly label: 'secret' | 'session-cookie' | 'session-storage'
      readonly ref: string | null
    }

export interface RunTrace {
  readonly summary: RunSummary
  readonly adapterVersion: string
  readonly adapterHash: string
  readonly secretsUsed: readonly { readonly secret: string; readonly field: SecretField }[]
  readonly requests: { readonly sent: number; readonly probes: number; readonly blocked: number }
  readonly steps: readonly TraceStep[]
  /** The tool input as the client sent it, after redaction. */
  readonly input: readonly PreviewPart[]
  /** What the client received, after redaction; null unless the outcome is ok. */
  readonly output: readonly PreviewPart[] | null
  readonly outputBytes: number | null
}

export interface RunStats {
  readonly toolCalls: number
  readonly logins: number
  readonly loginsFailed: number
  readonly blockedRequests: number
  /** Per hour of the day so far, oldest first, for the sparklines. */
  readonly hourly: {
    readonly toolCalls: readonly number[]
    readonly logins: readonly number[]
    readonly blockedRequests: readonly number[]
  }
}

// ---------- Audit ----------

export type AuditCategory =
  | 'tool-calls'
  | 'logins'
  | 'secret-use'
  | 'blocked'
  | 'confirmations'
  | 'approvals-grants'

export interface AuditQuery {
  readonly category?: AuditCategory
  readonly adapterId?: string
  readonly client?: string
  readonly since?: IsoTime
  /** Matches call ids, tool names and hosts. */
  readonly search?: string
  /** Records with seq below this, newest first. */
  readonly beforeSeq?: number
  readonly limit?: number
}

export interface AuditPage {
  readonly records: readonly AuditRecord[]
  readonly total: number
  readonly nextBeforeSeq: number | null
}

export type ChainStatus =
  | { readonly state: 'unverified' }
  | {
      readonly state: 'intact'
      readonly records: number
      readonly headSeq: number
      readonly headHash: string
      readonly verifiedAt: IsoTime
    }
  | {
      readonly state: 'broken'
      readonly records: number
      /** The first record whose prev or hash doesn't match. */
      readonly firstBadSeq: number
      readonly verifiedAt: IsoTime
    }

// ---------- Endpoint and clients ----------

export type ClientKind = 'claude-code' | 'claude-desktop'

export interface EndpointStatus {
  readonly listening: boolean
  /** http://127.0.0.1:<port>/mcp, or null while stopped. */
  readonly url: string | null
  readonly connectedClients: number
  readonly tokenRotatedAt: IsoTime | null
}

/** A setup snippet. Never contains the token: the bridge reads it from its own 0600 config file. */
export interface ClientSnippet {
  readonly client: ClientKind
  readonly text: string
}

export interface ClientInfo {
  readonly id: string
  /** What the client says its name is, from MCP initialize. Proves nothing. */
  readonly reportedName: string
  readonly transport: 'http' | 'stdio'
  readonly firstSeen: IsoTime
  readonly lastSeen: IsoTime
  readonly calls7d: number
  readonly revokedAt: IsoTime | null
}

// ---------- Attention ----------

export interface NeedsUserItem {
  readonly kind: 'needs-user'
  readonly id: string
  readonly adapterId: string
  readonly adapterName: string
  readonly reason: NeedsUserReason
  /** The manifest's note for this needsUser step, shown in the app only. */
  readonly note: string | null
  readonly tool: string | null
  readonly client: string | null
  readonly callId: string | null
  readonly at: IsoTime
  /** Secret fields filled before the hand-off, and the origin they were typed on. */
  readonly filled: readonly { readonly secret: string; readonly field: SecretField }[]
  readonly filledOrigin: string | null
  readonly navigation: readonly string[]
  readonly windowOpen: boolean
  readonly closesAt: IsoTime | null
}

/**
 * A confirmation the runtime is waiting on. Everything except `adapterNote` is the runtime's own
 * knowledge; the note is whatever the adapter passed to confirm(), shown attributed and unverified.
 */
export interface ConfirmationItem {
  readonly kind: 'confirmation'
  readonly id: string
  readonly adapterId: string
  readonly adapterName: string
  readonly adapterVersion: string
  readonly adapterHash: string
  readonly approvedAt: IsoTime | null
  readonly tool: string
  readonly toolTitle: string
  readonly sideEffect: Purpose
  /** irreversible-tool: the runtime asks before an irreversible tool runs. tool-request: ctx.confirm(). */
  readonly trigger: 'irreversible-tool' | 'tool-request'
  /** The name the client reported in MCP initialize. A claim: any process with the token can send any name. */
  readonly client: string
  /** How that client reached the endpoint, which the runtime knows for itself. */
  readonly clientTransport: ClientInfo['transport']
  readonly callId: string
  readonly requestedAt: IsoTime
  readonly expiresAt: IsoTime
  /** The run's request ceiling. */
  readonly requestCeiling: number
  /** The declared irreversible requests approving would unlock for this run. */
  readonly unlocks: readonly RequestDeclaration[]
  /** The validated tool input, redacted. */
  readonly input: readonly PreviewPart[]
  readonly adapterNote: string | null
}

export interface ReviewItem {
  readonly kind: 'review'
  readonly id: string
  readonly adapterId: string
  readonly adapterName: string
  readonly version: string
  readonly addsPermissions: boolean
}

export type AttentionItem = NeedsUserItem | ConfirmationItem | ReviewItem

/**
 * How long Approve stays disabled after the confirmation window mounts, and again after it regains
 * focus or becomes visible, so a click already on its way in another app can't land on it.
 */
export const CONFIRM_ARM_MS = 800

// ---------- Settings, updates, health ----------

export interface Settings {
  readonly updateChannel: 'stable' | 'beta'
  readonly autoInstallUpdates: boolean
  readonly launchAtLogin: boolean
  /**
   * Path to the 1Password CLI, or null to search the usual places. Read-only here: only
   * settings.chooseOpPath() changes it, so the renderer can never name a binary to run.
   */
  readonly opPath: string | null
  readonly messagesOtpEnabled: boolean
}

/** What the renderer may change directly. The 1Password CLI path isn't among them. */
export type SettingsPatch = Partial<Omit<Settings, 'opPath'>>

/** A control-panel route: a hash that lib/router.ts parses to a page other than not-found. */
export type HashRoute = `#/${string}`

export interface UpdateStatus {
  readonly current: string
  readonly state: 'up-to-date' | 'checking' | 'available' | 'downloading' | 'ready' | 'error'
  readonly available: string | null
  readonly checkedAt: IsoTime | null
  readonly signed: boolean
}

export interface SiteHealth {
  readonly host: string
  readonly adapterIds: readonly string[]
  readonly breaker: 'closed' | 'open'
  /** Set while open. */
  readonly retryAt: IsoTime | null
  readonly cause: 'blocked-by-site' | 'rate-limited' | null
  readonly lastOpenedAt: IsoTime | null
  /** The cool-down the next block would start, after doubling. */
  readonly nextCooldownSeconds: number
}

export interface AppStatus {
  readonly paused: boolean
  readonly version: string
  /** Demo mode: a local fake site and a test credential, never a real account. Shown as a badge. */
  readonly demo: boolean
}

// ---------- Events ----------

/** Live-update notices. They carry no data: the renderer refetches what it shows. */
export type AppEvent =
  | { readonly type: 'adapters-changed' }
  | { readonly type: 'approvals-changed' }
  | { readonly type: 'grants-changed' }
  | { readonly type: 'runs-changed' }
  | { readonly type: 'audit-appended'; readonly seq: number }
  | { readonly type: 'endpoint-changed' }
  | { readonly type: 'clients-changed' }
  | { readonly type: 'attention-changed' }
  | { readonly type: 'settings-changed' }
  | { readonly type: 'health-changed' }
  | { readonly type: 'app-changed' }

export type AppEventType = AppEvent['type']

// ---------- The API ----------

export interface SiteAdapterApi {
  readonly adapters: {
    list(): Promise<readonly AdapterSummary[]>
    /** Null when no adapter has that id. */
    get(adapterId: string): Promise<AdapterDetail | null>
  }
  readonly approvals: {
    pending(): Promise<readonly PendingReview[]>
    /** Approves exactly this hash; rejects if a different bundle is now pending. */
    approve(adapterId: string, hash: string): Promise<void>
    reject(adapterId: string, hash: string): Promise<void>
  }
  readonly grants: {
    list(): Promise<readonly GrantInfo[]>
    providers(): Promise<readonly ProviderStatus[]>
    /** Items in the siteadapter vault, title only. */
    vaultItems(provider: ProviderKind): Promise<readonly VaultItem[]>
    /** The main process checks origins ⊆ the manifest's request for that hash, and refuses otherwise. */
    make(request: GrantRequest): Promise<void>
    revoke(adapterId: string, secret: string): Promise<void>
  }
  readonly runs: {
    list(query?: { readonly adapterId?: string; readonly limit?: number }): Promise<readonly RunSummary[]>
    /** Null when no run has that call id. */
    trace(callId: string): Promise<RunTrace | null>
    statsToday(): Promise<RunStats>
  }
  readonly audit: {
    page(query: AuditQuery): Promise<AuditPage>
    verify(): Promise<ChainStatus>
    /** The last verification result, without re-running it. */
    chainStatus(): Promise<ChainStatus>
    /** Shows a save dialog in the main process. */
    exportJsonl(): Promise<void>
  }
  readonly endpoint: {
    status(): Promise<EndpointStatus>
    setListening(listening: boolean): Promise<void>
    /** Issues a new token and rewrites the bridge config. The token never reaches the renderer. */
    rotateToken(): Promise<void>
    snippets(): Promise<readonly ClientSnippet[]>
    copyClientConfig(client: ClientKind): Promise<void>
    copyUrl(): Promise<void>
  }
  readonly clients: {
    list(): Promise<readonly ClientInfo[]>
    revoke(clientId: string): Promise<void>
  }
  readonly attention: {
    list(): Promise<readonly AttentionItem[]>
  }
  /**
   * The main process refuses an approval that arrives within CONFIRM_ARM_MS of the confirmation
   * window showing or regaining focus, as the renderer's own delay does.
   */
  answerConfirmation(confirmationId: string, approved: boolean): Promise<void>
  /** Shows the adapter's auth window to the person. */
  openLoginWindow(adapterId: string): Promise<void>
  /** The person says they finished: run the probe and hand the session over. */
  finishLogin(adapterId: string): Promise<void>
  /** The person gives up: close the auth window without a hand-off. */
  closeLoginWindow(adapterId: string): Promise<void>
  readonly settings: {
    get(): Promise<Settings>
    /** The main process ignores keys outside SettingsPatch (opPath above all). */
    set(patch: SettingsPatch): Promise<Settings>
    /**
     * Shows a native open dialog in the main process; the person picks the op binary there. Before
     * saving, the main process checks the path is absolute, the file and its directories aren't
     * writable by group or others, and it carries 1Password's code signature; otherwise it keeps the
     * old value and rejects. Resolves with the settings as they now are (unchanged if cancelled).
     */
    chooseOpPath(): Promise<Settings>
    /** Goes back to searching the usual places, where the same checks apply. */
    clearOpPath(): Promise<Settings>
  }
  readonly updates: {
    status(): Promise<UpdateStatus>
    check(): Promise<void>
  }
  readonly health: {
    sites(): Promise<readonly SiteHealth[]>
  }
  readonly app: {
    status(): Promise<AppStatus>
    /** Pauses or resumes every adapter: paused calls return blocked without reaching a site. */
    setPaused(paused: boolean): Promise<void>
    /**
     * Opens or focuses the control panel at a renderer route (a hash such as "#/activity"). The main
     * process accepts only a hash that parseRoute reads as a page (not-found is refused), sets it as
     * the window's hash on its own index.html, and never passes it to loadURL as a URL.
     */
    openControlPanel(route?: HashRoute): Promise<void>
    /** Writes text to the clipboard (a sandboxed renderer can't, outside a user gesture). */
    copyText(text: string): Promise<void>
    quit(): Promise<void>
  }
  /** Subscribes to live-update notices. Returns the unsubscribe. */
  onEvent(listener: (event: AppEvent) => void): () => void
}

export type { AuditEvent, AuditRecord }

declare global {
  interface Window {
    /** Set by the preload. Absent in a plain browser, where the dev entry uses the fake. */
    readonly siteadapter?: SiteAdapterApi
  }
}
