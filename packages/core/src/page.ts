// The browser surfaces the runtime drives. Both are implemented by the Electron driver and by test
// fakes; nothing here imports Electron.

import type { NeedsUserReason } from './errors'
import type { Purpose, RequestDeclaration } from './request-surface'
import type { SecretValue } from './secret'
import type { BLOCK_REASONS } from './vocab'

/** What the auth interpreter needs to know about an element before it types into it. */
export interface ElementInfo {
  readonly visible: boolean
  readonly tagName: string
  /** The `type` attribute of an input, lower-cased, or null. */
  readonly inputType: string | null
  readonly autocomplete: string | null
  readonly inputMode: string | null
  /** Security origin of the frame that contains the element. */
  readonly frameOrigin: string
  /** Resolved origin of the owning form's action, or null when the element has no form. */
  readonly formActionOrigin: string | null
  /**
   * Whether trusted input can reach the element. False inside an out-of-process (cross-site) frame,
   * where the driver cannot deliver keystrokes without weakening site isolation.
   */
  readonly inputReachable: boolean
}

export interface TypeOptions {
  readonly delayMs?: number
  /**
   * Origins the focused element's frame must be on, checked by the driver immediately before each
   * keystroke. If the frame navigates or focus moves while typing, the driver stops and throws
   * ValetError('secret-fill', 'origin-mismatch'). Required when typing a SecretValue.
   */
  readonly allowedOrigins?: readonly string[]
}

/**
 * The auth partition's page. Only the runtime's declarative interpreter holds one. No method accepts
 * script: selectors and text are data.
 */
export interface AuthPage {
  goto(url: string): Promise<void>
  currentUrl(): string
  /** Every URL the page has committed to since it opened, in order. */
  committedUrls(): readonly string[]
  inspect(selector: string): Promise<ElementInfo | null>
  click(selector: string): Promise<void>
  focus(selector: string): Promise<void>
  /**
   * Types as trusted input, one character at a time, into the element the last focus(selector)
   * targeted. That element must still have focus. A SecretValue requires options.allowedOrigins.
   */
  type(text: string | SecretValue, options?: TypeOptions): Promise<void>
  textPresent(text: string): Promise<boolean>
  /**
   * GET `url` with the auth partition's cookies, for the session probe. Issued by the driver from
   * outside the page (no script runs), and only to the manifest's navigation origins.
   */
  fetch(url: string): Promise<FetchResult>
  /** Names (not values) of the auth partition's cookies on `cookieDomains`, for cookie probes. */
  cookieNames(cookieDomains: readonly string[]): Promise<readonly string[]>
  /** Shows the window to the person and resolves when they close it. */
  handToUser(reason: NeedsUserReason): Promise<void>
  close(): Promise<void>
}

export interface FetchInit {
  readonly method?: string
  readonly headers?: Readonly<Record<string, string>>
  /** A JSON-serialisable body. Sent with content-type application/json. */
  readonly json?: unknown
  /**
   * 'reload' asks the site even when the session's read cache holds an answer (D28), and replaces
   * that answer. Only a tool page handed to tool code reads it.
   */
  readonly cache?: 'reload'
}

export interface FetchResult {
  readonly status: number
  readonly contentType: string | null
  /** Parsed JSON when the content type is JSON and it parses; otherwise the text, or null if empty. */
  readonly body: unknown
  /** Present when the runtime answered from the session's read cache and sent nothing. */
  readonly fromCache?: true
}

/** The tool partition's page, as tool code sees it through the capability API. */
export interface ToolPage {
  goto(url: string): Promise<void>
  currentUrl(): string
  click(selector: string): Promise<void>
  fill(selector: string, text: string): Promise<void>
  extract(
    selector: string,
    options?: { readonly attribute?: string; readonly all?: boolean },
  ): Promise<unknown>
  /** Runs adapter-supplied code in an isolated world. `source` is an expression or async IIFE. */
  evaluate(source: string, args?: unknown): Promise<unknown>
  /** fetch() from inside the page, same-origin credentials. The request surface guard applies. */
  fetch(pathOrUrl: string, init?: FetchInit): Promise<FetchResult>
}

/**
 * One site's pair of browser sessions, as the runtime sees them. The Electron driver implements
 * it; tests use fakes. See docs/security-model.md for why auth and tool partitions are separate.
 */
export interface SessionDriver {
  /**
   * Opens a page in the auth partition. Only the declarative interpreter may use it. `onBlocked`
   * hears the auth partition's refused navigations while the page is open, for the audit log.
   */
  openAuthPage(options?: AuthPageOptions): Promise<AuthPage>
  /** The tool partition's page, opened at the manifest's home URL on first use. */
  toolPage(): Promise<ToolPage>
  /** Copies cookies for `cookieDomains`, and the named storage keys, from auth to tool. Never the reverse. */
  handoff(
    cookieDomains: readonly string[],
    storage: readonly { readonly origin: string; readonly keys: readonly string[] }[],
  ): Promise<void>
  /**
   * Values a tool's output must never contain: the tool partition's cookies on `cookieDomains` and
   * the handed-off storage values. For output redaction.
   */
  sessionSecrets(
    cookieDomains: readonly string[],
    storage: readonly { readonly origin: string; readonly keys: readonly string[] }[],
  ): Promise<readonly string[]>
  /** Names (not values) of the tool partition's cookies on `cookieDomains`, for cookie probes. */
  cookieNames(cookieDomains: readonly string[]): Promise<readonly string[]>
  /**
   * Starts a tool run: from now until endRun(), every request the tool partition makes, whether
   * from tool code or the site's own scripts, is held to `policy` at the network layer, and each
   * refused one is reported to `onBlocked`.
   */
  beginRun(policy: ToolRunPolicy, onBlocked: (request: BlockedRequest) => void): void
  /**
   * Called only after the person approved this run in the app: from now until endRun(), the run's
   * irreversible declarations are usable. Has no effect unless policy.maxPurpose is irreversible.
   */
  unlockIrreversible(): void
  endRun(): void
  /**
   * Connects the site's breaker and budget (D55). From now on the driver tells `watcher` about
   * every block signature it sees in either partition, cancels every tool-partition request while
   * `watcher.held()` is true, and paces the tool partition's main-frame navigations. Optional: a driver without it leaves blocks to the runtime's own checks.
   */
  watchSite?(watcher: SiteWatcher): void
  /** Closes every window this driver opened. */
  close(): Promise<void>
}

/**
 * A response that looks like the site refusing us: a 429, or a 403 HTML page (Akamai's Access
 * Denied page is one), on a main-frame navigation or an API call (xhr or fetch) to the site.
 */
export interface SiteRefusal {
  readonly partition: 'auth' | 'tool'
  readonly cause: 'blocked-by-site' | 'rate-limited'
  readonly status: number
  /** Origin and path only. */
  readonly target: string
  readonly resourceType: string
}

/** The runtime's side of watchSite(). Neither method may throw. */
export interface SiteWatcher {
  refused(refusal: SiteRefusal): void
  /** True while the site's breaker is open. */
  held(): boolean
  /**
   * Waits for the site's rate budget (D28, D55). The driver calls it before each main-frame
   * navigation in the tool partition that tool code didn't already pace through the capability
   * API. Rejects when the navigation must not go: the breaker opened, or the driver closed.
   */
  pace?(): Promise<void>
}

/** The network policy for one tool run. */
export interface ToolRunPolicy {
  /** Host patterns any request may go to (the manifest's egress list). */
  readonly egress: readonly string[]
  /** The manifest's request surface, applied to API calls (xhr and fetch) on egress hosts. */
  readonly requests: readonly RequestDeclaration[]
  /**
   * The strongest purpose this run may use: the tool's declared side effect. Irreversible
   * declarations stay refused until unlockIrreversible().
   */
  readonly maxPurpose: Purpose
  /**
   * The irreversible declarations, by method and path as declared, that unlockIrreversible() makes
   * usable in this run: the ones the tool names (C15). Any other irreversible declaration stays
   * refused whatever the person approved. Absent means none.
   */
  readonly unlocks?: readonly { readonly method: string; readonly path: string }[]
  /** Navigations and API calls this run may make; static resources don't count. */
  readonly ceiling: number
}

export interface AuthPageOptions {
  readonly onBlocked?: (blocked: BlockedRequest) => void
  /** Called once, the first time a refusal goes unreported because the driver's budget is spent. */
  readonly onReportsDropped?: () => void
}

export interface BlockedRequest {
  readonly method: string
  /** Origin and path only. Hostnames can carry data too, so the runtime still redacts it. */
  readonly target: string
  readonly reason: (typeof BLOCK_REASONS)[number]
  readonly initiator: 'tool' | 'page'
}
