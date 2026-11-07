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

/** A response's headers, as webRequest's onHeadersReceived reports them. */
export interface ObservedResponse {
  readonly url: string
  readonly method: string
  /** As OutgoingRequest's. */
  readonly resourceType: string
  readonly status: number
  /** The content-type header, or null without one. */
  readonly contentType: string | null
}

export interface OutgoingRequest {
  readonly url: string
  readonly method: string
  /**
   * Chromium's resource type, as Electron names it: mainFrame, subFrame, stylesheet, script, image,
   * font, object, xhr, ping, cspReport, media, webSocket or other. fetch() reports as xhr.
   */
  readonly resourceType: string
  /** The request's id: a server redirect keeps it, so its next hop has the same one. */
  readonly id?: number
}

/** Request headers in the order they go out, names in the case they are sent in. */
export type HeaderList = readonly (readonly [string, string])[]

/**
 * One GET the driver makes itself, from the main process, with a partition's cookies. One hop: a
 * redirect is handed back, never followed, so that the caller can check where it goes and word the
 * next hop's headers itself.
 */
export interface SessionFetchRequest {
  /** An absolute https URL. The caller has already checked it. */
  readonly url: string
  /**
   * The origin the request is made on behalf of: the page's. Chromium computes Sec-Fetch-Site from
   * it, and refuses a Referer that its referrer policy wouldn't send to `url`.
   */
  readonly initiator: string
  /**
   * Sent in this order, ahead of what the network stack adds itself (Referer, Accept-Encoding and
   * the cookies, in that order).
   */
  readonly headers: HeaderList
  /** The Referer, or null for none. Must be one strict-origin-when-cross-origin would send. */
  readonly referrer: string | null
  /** The most body bytes to read. A response with more is abandoned. */
  readonly maxBytes: number
  /** Aborting it cancels the request. */
  readonly signal: AbortSignal
}

export type SessionFetchResponse =
  | {
      readonly kind: 'response'
      readonly status: number
      readonly contentType: string | null
      readonly body: Uint8Array
    }
  /** A redirect, not followed: the request was cancelled there. What it set is kept. */
  | { readonly kind: 'redirect'; readonly location: string }
  | { readonly kind: 'failed'; readonly failure: 'too-large' | 'network' | 'aborted' }

/** A local proxy a partition's TCP connections go through. */
export interface ProxyHandle {
  /** Proxy rules for the session, e.g. http://127.0.0.1:53211. */
  readonly url: string
  close(): Promise<void>
}

/** Decides one proxied connection. `host` is as the page asked for it, never resolved. */
export type ProxyPolicy = (host: string, port: number) => boolean

/** One persistent browser partition. */
export interface PartitionSession {
  /** Sets the UA string and the Accept-Language header for every request the partition makes. */
  setUserAgent(userAgent: string, acceptLanguages: string): void
  /** Denies permission prompts and downloads. */
  harden(): void
  /**
   * Installs the session's only request filter. Requests it returns false for are cancelled; a
   * promise holds the request until it settles, and a rejected one cancels it.
   */
  filterRequests(allow: (request: OutgoingRequest) => boolean | Promise<boolean>): void
  /**
   * Sends every connection the session makes, loopback included, through `proxy`. With WebRTC
   * limited to proxied traffic, that takes in the sockets webRequest never sees.
   */
  useProxy(proxy: ProxyHandle): Promise<void>
  /**
   * Calls `listener` with the status and content type of every response the partition receives,
   * the session's own fetch() and redirects included, as its headers arrive. The only listener.
   */
  watchResponses(listener: (response: ObservedResponse) => void): void
  /** Adds a response header to every response, e.g. to switch off DNS prefetch per document. */
  addResponseHeader(name: string, value: string): void
  getCookies(): Promise<readonly CookieRecord[]>
  setCookie(details: CookieSetDetails): Promise<void>
  /**
   * GETs a URL from the main process with the partition's cookies (sending them, and storing what
   * the response sets, a redirect's included), never from a page: no script runs. Uncached, with
   * exactly the headers and referrer given, on behalf of `initiator`. It never follows a redirect
   * and never rejects: every failure is a value.
   */
  fetch(request: SessionFetchRequest): Promise<SessionFetchResponse>
  /**
   * Calls `listener` for every cookie the partition adds, changes or removes, with its value: the
   * old value when one is removed or overwritten, so that a value never goes unseen.
   */
  onCookieChanged(listener: (cookie: CookieRecord) => void): void
}

/** One web-storage value a page held, as the DevTools protocol reports it. */
export interface StorageValue {
  /** The storage's security origin, e.g. https://www.example.com. */
  readonly origin: string
  readonly key: string
  readonly value: string
}

/** A frame in a page, in tree order. The main frame comes first and has no parent. */
export interface FrameHandle {
  /** Stable for the frame's lifetime, and comparable with BrowserSurface.focusedFrameId(). */
  readonly id: string
  /**
   * The frame's place in the frame tree, which stays the same across its navigations (Chromium's
   * frame tree node id), unlike `id`. Comparable with NavigationEvent.frameNodeId.
   */
  readonly nodeId: string
  /** Security origin as the browser process sees it, not as the page reports it. */
  readonly origin: string
  readonly url: string
  /** Index of the parent in the same frames() list, or null for the main frame. */
  readonly parentIndex: number | null
  /**
   * False for an out-of-process frame. Trusted input is sent to the window's main widget, and
   * with site isolation it never reaches a frame rendered by another process.
   */
  readonly receivesInput: boolean
  /** Runs runtime-authored script: in the runtime's isolated world on the main frame. */
  run(code: string): Promise<unknown>
  /**
   * Runs adapter-supplied script in a world of its own on the main frame, so that it can't patch
   * the globals the runtime's scripts rely on. Rejects in a subframe.
   */
  runAdapter(code: string): Promise<unknown>
}

/** Which trusted key events typing sends per character. */
export type KeyEvents = 'char' | 'full'

/** What Emulation.setUserAgentOverride takes, in the DevTools protocol's own shape. */
export interface UserAgentOverride {
  readonly userAgent: string
  readonly acceptLanguage: string
  /** navigator.platform, e.g. MacIntel. */
  readonly platform: string
  readonly userAgentMetadata: {
    readonly brands: readonly { readonly brand: string; readonly version: string }[]
    readonly fullVersionList: readonly { readonly brand: string; readonly version: string }[]
    readonly platform: string
    readonly platformVersion: string
    readonly architecture: string
    readonly model: string
    readonly mobile: boolean
    readonly bitness: string
    readonly wow64: boolean
    readonly formFactors: readonly string[]
  }
}

export type LoadResult = { readonly ok: true } | { readonly ok: false; readonly code: string }

export interface NavigationEvent {
  readonly kind: 'commit' | 'redirect'
  readonly url: string
  readonly isMainFrame: boolean
  /** The navigating frame's FrameHandle.nodeId, or null when the browser couldn't say. */
  readonly frameNodeId: string | null
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
  /** The id of the frame that has keyboard focus, as the browser process sees it. */
  focusedFrameId(): string | null
  /** Trusted mouse move, down and up at viewport coordinates. */
  click(x: number, y: number): void
  /**
   * One trusted keystroke: a char event, or with `full` a keyDown, char and keyUp, as a keyboard
   * sends them.
   */
  sendChar(char: string, events: KeyEvents): void
  /**
   * Overrides the UA, Accept-Language and client hints for this page's documents over the DevTools
   * protocol. Must be called before the first load.
   */
  overrideUserAgent(override: UserAgentOverride): Promise<void>
  /**
   * Calls `listener` with every web-storage value the page's documents write from now on, the old
   * value as well as the new when one is overwritten, over the DevTools protocol. Must be called
   * before the first load.
   */
  watchStorage(listener: (value: StorageValue) => void): Promise<void>
  /** Resolves once every storage write the page has made so far has reached watchStorage's listener. */
  storageSettled(): Promise<void>
  /** Gives the web contents keyboard focus without showing the window. */
  focus(): void
  show(title: string): void
  hide(): void
  /**
   * Called when the person asks to close a window. Return true to keep it open. There is one
   * handler at a time; the returned function removes it, if it is still the current one.
   */
  onCloseRequested(handler: () => boolean): () => void
  /** Returns a function that removes the handler. */
  onDestroyed(handler: () => void): () => void
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
  /** Starts a local proxy that allows a connection only when `allow` says so. */
  startProxy(allow: ProxyPolicy): Promise<ProxyHandle>
  /**
   * Sets the process-wide UA for renderers that neither a session's UA nor a page's DevTools
   * override reaches before they run: a service worker's (app.userAgentFallback).
   */
  setDefaultUserAgent(userAgent: string): void
  readonly chromeVersion: string
  readonly os: NodeJS.Platform
  /** The OS's own version, e.g. 15.5.0 on macOS. Only client hints use it. */
  readonly systemVersion: string
  readonly arch: string
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
