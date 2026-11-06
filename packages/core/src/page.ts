// The browser surfaces the runtime drives. Both are implemented by the Electron driver and by test
// fakes; nothing here imports Electron.

import type { SecretValue } from './secret'

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
  /** Types into the focused element as trusted input, one character at a time. */
  type(text: string | SecretValue, options?: { readonly delayMs?: number }): Promise<void>
  textPresent(text: string): Promise<boolean>
  /** Shows the window to the person and resolves when they close it or the condition is met. */
  handToUser(reason: string): Promise<void>
  close(): Promise<void>
}

export interface FetchInit {
  readonly method?: string
  readonly headers?: Readonly<Record<string, string>>
  /** A JSON-serialisable body. Sent with content-type application/json. */
  readonly json?: unknown
}

export interface FetchResult {
  readonly status: number
  readonly contentType: string | null
  readonly body: unknown
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
  /** Opens a page in the auth partition. Only the declarative interpreter may use it. */
  openAuthPage(): Promise<AuthPage>
  /** The tool partition's page, opened at the manifest's home URL on first use. */
  toolPage(): Promise<ToolPage>
  /** Copies cookies for `cookieDomains`, and the named storage keys, from auth to tool. Never the reverse. */
  handoff(
    cookieDomains: readonly string[],
    storage: readonly { readonly origin: string; readonly keys: readonly string[] }[],
  ): Promise<void>
  /** Current values of the tool partition's cookies on `cookieDomains`, for output redaction. */
  sessionCookieValues(cookieDomains: readonly string[]): Promise<readonly string[]>
  /** Closes every window this driver opened. */
  close(): Promise<void>
}
