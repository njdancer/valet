// The narrow slice of Electron the driver uses, as plain interfaces. The pages and the driver are
// written against these so that they run and are tested in plain Node; src/electron implements
// them over BrowserWindow and session.

/** A cookie as the browser reports it. Mirrors Electron's Cookie. */
export interface CookieRecord {
  readonly name: string
  readonly value: string
  readonly domain?: string
  readonly path?: string
  readonly hostOnly?: boolean
  readonly secure?: boolean
  readonly httpOnly?: boolean
  readonly session?: boolean
  readonly expirationDate?: number
  readonly sameSite: 'unspecified' | 'no_restriction' | 'lax' | 'strict'
}

/** What setting a cookie takes. Mirrors Electron's CookiesSetDetails. */
export interface CookieSetDetails {
  readonly url: string
  readonly name: string
  readonly value: string
  readonly domain?: string
  readonly path?: string
  readonly secure?: boolean
  readonly httpOnly?: boolean
  readonly expirationDate?: number
  readonly sameSite: 'unspecified' | 'no_restriction' | 'lax' | 'strict'
}

export interface OutgoingRequest {
  readonly url: string
  readonly method: string
}

/** One persistent browser partition. */
export interface PartitionSession {
  setUserAgent(userAgent: string): void
  /** Denies permission prompts and downloads. */
  harden(): void
  /** Installs the session's only request filter. Requests it returns false for are cancelled. */
  filterRequests(allow: (request: OutgoingRequest) => boolean): void
  /** Adds a response header to every response, e.g. to switch off DNS prefetch per document. */
  addResponseHeader(name: string, value: string): void
  getCookies(): Promise<readonly CookieRecord[]>
  setCookie(details: CookieSetDetails): Promise<void>
}

/** A frame in a page, in tree order. The main frame comes first and has no parent. */
export interface FrameHandle {
  /** Security origin as the browser process sees it, not as the page reports it. */
  readonly origin: string
  readonly url: string
  /** Index of the parent in the same frames() list, or null for the main frame. */
  readonly parentIndex: number | null
  /** Runs runtime-authored script: in an isolated world on the main frame. */
  run(code: string): Promise<unknown>
}

export type LoadResult = { readonly ok: true } | { readonly ok: false; readonly code: string }

export interface NavigationEvent {
  readonly kind: 'commit' | 'redirect'
  readonly url: string
  readonly isMainFrame: boolean
}

/** A navigation about to start, offered to the guard. */
export interface PendingNavigation {
  readonly url: string
  readonly isMainFrame: boolean
}

/** One hidden-but-headed window with its web contents. */
export interface BrowserSurface {
  load(url: string): Promise<LoadResult>
  isLoading(): boolean
  /** Resolves on the next did-stop-loading. */
  nextStopLoading(): Promise<void>
  stop(): void
  url(): string
  frames(): readonly FrameHandle[]
  /** Trusted mouse move, down and up at viewport coordinates. */
  click(x: number, y: number): void
  /** One trusted char event. */
  sendChar(char: string): void
  /** Gives the web contents keyboard focus without showing the window. */
  focus(): void
  show(title: string): void
  hide(): void
  /** Called when the person asks to close a shown window. Return true to keep it open. */
  onCloseRequested(handler: () => boolean): void
  onDestroyed(handler: () => void): void
  /** Installs the only navigation guard. Navigations it returns false for are prevented. */
  guardNavigation(allow: (navigation: PendingNavigation) => boolean): void
  onNavigation(listener: (event: NavigationEvent) => void): void
  destroy(): void
  isDestroyed(): boolean
}

export type Role = 'auth' | 'tool'

export interface BrowserPlatform {
  /** The same object for the same partition name. */
  session(partition: string): PartitionSession
  openSurface(partition: string): BrowserSurface
  readonly chromeVersion: string
  readonly os: NodeJS.Platform
}

/** Timer functions, injected so that tests control time. */
export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export const realTimers: Timers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export function sleep(timers: Timers, ms: number): Promise<void> {
  return new Promise((resolve) => {
    timers.setTimeout(resolve, ms)
  })
}
