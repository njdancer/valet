// Fakes for BrowserPlatform, its sessions and surfaces, plus timers the test drives by hand.
// Frames run the real page scripts against FakeWindow, so these tests exercise the scripts too.

import type {
  BrowserPlatform,
  BrowserSurface,
  CookieRecord,
  CookieSetDetails,
  FrameHandle,
  KeyEvents,
  LoadResult,
  NavigationEvent,
  NetworkResponse,
  ObservedResponse,
  OutgoingRequest,
  PartitionSession,
  PendingNavigation,
  ProxyHandle,
  ProxyPolicy,
  SessionFetchRequest,
  SessionFetchResponse,
  StorageValue,
  Timers,
  UserAgentOverride,
} from '../src/platform'
import { FakeWindow } from './fake-dom'

let frameIds = 0

export class FakeFrame implements FrameHandle {
  readonly id = `frame-${++frameIds}`
  /** Stays the same across the frame's navigations; tests that navigate a frame keep it. */
  nodeId = `node-${frameIds}`
  readonly scripts: string[] = []
  /** What ran in the adapter's world rather than the runtime's. */
  readonly adapterScripts: string[] = []
  fail = false
  /**
   * Plays Electron's executeJavaScript on a frame whose document is being replaced: the script
   * never answers. `onHang` runs once the script is sent, so a test can commit the navigation then.
   */
  hang = false
  onHang: (() => void) | null = null
  /** False plays an out-of-process iframe, which trusted input can't reach. */
  receivesInput = true

  constructor(
    public origin: string,
    public url: string,
    readonly parentIndex: number | null,
    readonly window: FakeWindow = new FakeWindow(),
  ) {}

  async run(code: string): Promise<unknown> {
    this.scripts.push(code)
    if (this.hang) {
      this.onHang?.()
      return new Promise(() => undefined)
    }
    if (this.fail) throw new Error('Script failed to execute: frame detached')
    return this.window.run(code)
  }

  async runAdapter(code: string): Promise<unknown> {
    this.adapterScripts.push(code)
    if (this.fail) throw new Error('Script failed to execute: frame detached')
    return this.window.run(code)
  }
}

export class FakeSurface implements BrowserSurface {
  frameList: FakeFrame[]
  readonly loads: string[] = []
  /** How load() answers. The default commits the URL in the main frame and succeeds. */
  onLoad: (url: string) => LoadResult | Promise<LoadResult> = (url) => {
    this.commit(url)
    return { ok: true }
  }
  loading = false
  readonly clicks: { x: number; y: number }[] = []
  readonly chars: string[] = []
  focusCalls = 0
  stopCalls = 0
  readonly shown: string[] = []
  hideCalls = 0
  destroyed = false
  private currentUrl = ''
  private stopWaiters: (() => void)[] = []
  closeHandler: (() => boolean) | null = null
  readonly destroyedHandlers: (() => void)[] = []
  private guard: ((navigation: PendingNavigation) => boolean) | null = null
  private readonly listeners: ((event: NavigationEvent) => void)[] = []
  /** Called after each sendChar, to let a test act mid-typing. */
  afterChar: ((index: number) => void) | null = null

  constructor(
    readonly partition: string,
    frames?: FakeFrame[],
  ) {
    this.frameList = frames ?? [new FakeFrame('https://www.example.com', 'https://www.example.com/', null)]
  }

  async load(url: string): Promise<LoadResult> {
    this.loads.push(url)
    return this.onLoad(url)
  }

  isLoading(): boolean {
    return this.loading
  }

  nextStopLoading(): Promise<void> {
    return new Promise((resolve) => this.stopWaiters.push(resolve))
  }

  stop(): void {
    this.stopCalls++
  }

  url(): string {
    return this.currentUrl
  }

  frames(): readonly FrameHandle[] {
    return this.frameList
  }

  /** Set to pin which frame the browser says has focus; otherwise the frame that focused last. */
  focusedFrame: string | null | undefined = undefined

  focusedFrameId(): string | null {
    if (this.focusedFrame !== undefined) return this.focusedFrame
    let latest: FakeFrame | null = null
    for (const frame of this.frameList) {
      if (frame.window.document.focusedAt > (latest?.window.document.focusedAt ?? 0)) latest = frame
    }
    return latest?.id ?? this.frameList[0]?.id ?? null
  }

  click(x: number, y: number): void {
    this.clicks.push({ x, y })
  }

  sendChar(char: string, events: KeyEvents): void {
    this.chars.push(char)
    this.keyEvents.push(events)
    this.afterChar?.(this.chars.length - 1)
  }

  /** Which key events each sendChar asked for, in order. */
  readonly keyEvents: KeyEvents[] = []
  /** Every DevTools user-agent override, in order, and whether a page had loaded before it. */
  readonly overrides: { override: UserAgentOverride; afterLoad: boolean }[] = []
  /** How overrideUserAgent answers. Tests replace it to make it fail. */
  onOverride: () => Promise<void> = async () => {}

  async overrideUserAgent(override: UserAgentOverride): Promise<void> {
    this.overrides.push({ override, afterLoad: this.loads.length > 0 })
    await this.onOverride()
  }

  /** Whether a page had loaded before each watchStorage(). */
  readonly storageWatches: { afterLoad: boolean }[] = []
  storageListeners: ((value: StorageValue) => void)[] = []
  /** How watchStorage answers. Tests replace it to make it fail or hang. */
  onWatchStorage: () => Promise<void> = async () => {}
  /** Storage events held back until storageSettled(), as the DevTools protocol may deliver late. */
  readonly pendingStorage: StorageValue[] = []
  /** How storageSettled answers. Tests replace it to make it fail. */
  onStorageSettled: () => Promise<void> = async () => {}

  async watchStorage(listener: (value: StorageValue) => void): Promise<void> {
    this.storageWatches.push({ afterLoad: this.loads.length > 0 })
    await this.onWatchStorage()
    this.storageListeners.push(listener)
  }

  async storageSettled(): Promise<void> {
    await this.onStorageSettled()
    for (const value of this.pendingStorage.splice(0)) this.emitStorage(value)
  }

  readonly networkListeners: ((response: NetworkResponse) => void)[] = []
  /** Bodies responseBody() answers with, by response id. */
  readonly bodies = new Map<string, { body: string; base64: boolean }>()

  async watchNetwork(listener: (response: NetworkResponse) => void): Promise<void> {
    this.networkListeners.push(listener)
  }

  async responseBody(id: string): Promise<{ readonly body: string; readonly base64: boolean } | null> {
    return this.bodies.get(id) ?? null
  }

  /** Reports a response to the network watchers, with its body, as the DevTools protocol would. */
  respond(response: NetworkResponse, body?: string): void {
    if (body !== undefined) this.bodies.set(response.id, { body, base64: false })
    for (const listener of this.networkListeners) listener(response)
  }

  /** Reports a storage write to the watchers, as a DevTools DOMStorage event would. */
  emitStorage(value: StorageValue): void {
    for (const listener of this.storageListeners) listener(value)
  }

  focus(): void {
    this.focusCalls++
  }

  show(title: string): void {
    this.shown.push(title)
  }

  hide(): void {
    this.hideCalls++
  }

  onCloseRequested(handler: () => boolean): () => void {
    this.closeHandler = handler
    return () => {
      if (this.closeHandler === handler) this.closeHandler = null
    }
  }

  onDestroyed(handler: () => void): () => void {
    this.destroyedHandlers.push(handler)
    return () => {
      const index = this.destroyedHandlers.indexOf(handler)
      if (index >= 0) this.destroyedHandlers.splice(index, 1)
    }
  }

  guardNavigation(allow: (navigation: PendingNavigation) => boolean): void {
    this.guard = allow
  }

  onNavigation(listener: (event: NavigationEvent) => void): void {
    this.listeners.push(listener)
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    for (const handler of [...this.destroyedHandlers]) handler()
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  // Test controls.

  /** Offers a navigation to the guard, as will-frame-navigate would. Returns whether it may proceed. */
  attemptNavigation(url: string, isMainFrame = true): boolean {
    return this.guard === null ? true : this.guard({ url, isMainFrame })
  }

  /**
   * Commits a navigation. A main-frame commit is placed on the first frame's node; a subframe's
   * goes unplaced unless `frameNodeId` says which frame it was.
   */
  commit(url: string, isMainFrame = true, frameNodeId?: string | null): void {
    if (isMainFrame) this.currentUrl = url
    const node =
      frameNodeId !== undefined ? frameNodeId : isMainFrame ? (this.frameList[0]?.nodeId ?? null) : null
    for (const listener of this.listeners) listener({ kind: 'commit', url, isMainFrame, frameNodeId: node })
  }

  redirect(url: string, isMainFrame = true): void {
    const frameNodeId = isMainFrame ? (this.frameList[0]?.nodeId ?? null) : null
    for (const listener of this.listeners) listener({ kind: 'redirect', url, isMainFrame, frameNodeId })
  }

  finishLoading(): void {
    this.loading = false
    const waiters = this.stopWaiters
    this.stopWaiters = []
    for (const resolve of waiters) resolve()
  }

  /** The person clicks the window's close button. Returns true if the window stayed open. */
  requestClose(): boolean {
    const kept = this.closeHandler?.() === true
    if (!kept) this.destroy()
    return kept
  }
}

export class FakeSession implements PartitionSession {
  userAgent: string | null = null
  hardened = 0
  filter: ((request: OutgoingRequest) => boolean | Promise<boolean>) | null = null
  proxy: ProxyHandle | null = null
  readonly headers: [string, string][] = []
  cookies: CookieRecord[] = []
  readonly setCalls: CookieSetDetails[] = []
  getCalls = 0

  acceptLanguages: string | null = null

  constructor(readonly partition: string) {}

  setUserAgent(userAgent: string, acceptLanguages: string): void {
    this.userAgent = userAgent
    this.acceptLanguages = acceptLanguages
  }

  harden(): void {
    this.hardened++
  }

  filterRequests(allow: (request: OutgoingRequest) => boolean | Promise<boolean>): void {
    this.filter = allow
  }

  async useProxy(proxy: ProxyHandle): Promise<void> {
    this.proxy = proxy
  }

  responses: ((response: ObservedResponse) => void) | null = null

  watchResponses(listener: (response: ObservedResponse) => void): void {
    this.responses = listener
  }

  /** A response's headers arriving, as webRequest's onHeadersReceived would report them. */
  respond(response: Partial<ObservedResponse> & { readonly url: string; readonly status: number }): void {
    this.responses?.({ method: 'GET', resourceType: 'mainFrame', contentType: 'text/html', ...response })
  }

  addResponseHeader(name: string, value: string): void {
    this.headers.push([name, value])
  }

  async getCookies(): Promise<readonly CookieRecord[]> {
    this.getCalls++
    return this.cookies
  }

  async setCookie(details: CookieSetDetails): Promise<void> {
    this.setCalls.push(details)
  }

  cookieListeners: ((cookie: CookieRecord) => void)[] = []

  onCookieChanged(listener: (cookie: CookieRecord) => void): void {
    this.cookieListeners.push(listener)
  }

  /** Every fetch(), as it was asked. */
  readonly fetches: SessionFetchRequest[] = []
  /**
   * How fetch() answers each hop. The default answers 200 with an empty JSON body. Tests replace
   * it, and answer { kind: 'redirect' } to play the redirects the network would offer.
   */
  onFetch: (request: SessionFetchRequest) => SessionFetchResponse | Promise<SessionFetchResponse> = () => ({
    kind: 'response',
    status: 200,
    contentType: 'application/json',
    body: new Uint8Array(),
  })

  async fetch(request: SessionFetchRequest): Promise<SessionFetchResponse> {
    this.fetches.push(request)
    return this.onFetch(request)
  }

  /** Reports a cookie change, as session.cookies' changed event would. */
  emitCookie(cookie: CookieRecord): void {
    for (const listener of this.cookieListeners) listener(cookie)
  }
}

export class FakePlatform implements BrowserPlatform {
  readonly chromeVersion = '142.0.7444.59'
  readonly os = 'darwin' as NodeJS.Platform
  readonly systemVersion = '15.5.0'
  readonly arch = 'arm64'
  readonly sessions = new Map<string, FakeSession>()
  readonly surfaces: FakeSurface[] = []
  /** Every proxy started, with the policy it was given. */
  readonly proxies: { policy: ProxyPolicy; handle: ProxyHandle; closed: boolean }[] = []
  /** How startProxy answers. Tests replace it to make it fail. */
  onStartProxy: (policy: ProxyPolicy) => Promise<ProxyHandle> = async (policy) => {
    const entry = {
      policy,
      closed: false,
      handle: {
        url: `http://127.0.0.1:${40_000 + this.proxies.length}`,
        close: async () => {
          entry.closed = true
        },
      },
    }
    this.proxies.push(entry)
    return entry.handle
  }

  /** The dials passed to startProxy, in order (undefined: the platform's own). */
  readonly dials: unknown[] = []

  startProxy(policy: ProxyPolicy, dial?: unknown): Promise<ProxyHandle> {
    this.dials.push(dial)
    return this.onStartProxy(policy)
  }

  /** Every process-wide default UA set, in order. */
  readonly defaultUserAgents: string[] = []

  setDefaultUserAgent(userAgent: string): void {
    this.defaultUserAgents.push(userAgent)
  }

  /** Builds each new surface. Tests replace it to give pages frames. */
  makeSurface: (partition: string) => FakeSurface = (partition) => new FakeSurface(partition)

  session(partition: string): FakeSession {
    let session = this.sessions.get(partition)
    if (session === undefined) {
      session = new FakeSession(partition)
      this.sessions.set(partition, session)
    }
    return session
  }

  openSurface(partition: string): FakeSurface {
    const surface = this.makeSurface(partition)
    this.surfaces.push(surface)
    return surface
  }
}

/** Timers that only move when the test says so. */
export class ManualTimers implements Timers {
  now = 0
  readonly requested: number[] = []
  private nextId = 1
  private queue: { id: number; at: number; callback: () => void }[] = []

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.nextId++
    this.requested.push(ms)
    this.queue.push({ id, at: this.now + ms, callback })
    return id
  }

  clearTimeout(handle: unknown): void {
    this.queue = this.queue.filter((entry) => entry.id !== handle)
  }

  get pending(): number {
    return this.queue.length
  }

  /** Fires timers in time order, letting promises run in between, until `promise` settles. */
  async settle<T>(promise: Promise<T>): Promise<T> {
    let settled = false
    promise.then(
      () => (settled = true),
      () => (settled = true),
    )
    for (;;) {
      await flush()
      if (settled) return promise
      const next = [...this.queue].sort((a, b) => a.at - b.at)[0]
      if (next === undefined) throw new Error('promise is stuck: no timers left to fire')
      this.queue = this.queue.filter((entry) => entry !== next)
      this.now = next.at
      next.callback()
    }
  }

  /** Fires every timer due by now + ms. */
  async advance(ms: number): Promise<void> {
    const target = this.now + ms
    for (;;) {
      await flush()
      const next = [...this.queue].sort((a, b) => a.at - b.at)[0]
      if (next === undefined || next.at > target) break
      this.queue = this.queue.filter((entry) => entry !== next)
      this.now = next.at
      next.callback()
    }
    this.now = target
    await flush()
  }
}

export function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}
