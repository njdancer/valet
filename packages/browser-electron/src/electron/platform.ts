// BrowserPlatform over real Electron. Kept thin: every decision lives in the pure modules, and this
// file only forwards. It is covered by the e2e suite, not unit tests.

import {
  app,
  BrowserWindow,
  session as electronSession,
  net,
  type Session,
  type WebContents,
  webFrameMain,
} from 'electron'
import { type Dial, startEgressProxy } from '../egress-proxy'
import type {
  BrowserPlatform,
  BrowserSurface,
  CookieRecord,
  CookieSetDetails,
  FrameHandle,
  KeyEvents,
  LoadResult,
  NavigationEvent,
  ObservedResponse,
  OutgoingRequest,
  PartitionSession,
  PendingNavigation,
  ProxyHandle,
  SessionFetchRequest,
  SessionFetchResponse,
  StorageValue,
  UserAgentOverride,
} from '../platform'

// keyDown and keyUp need a key code, which Electron derives from the character on a US layout.
// Anything outside printable ASCII has none, so it goes as a char event alone.
const US_KEY = /^[\x20-\x7e]$/

// Isolated worlds on the main frame. 0 is the page's own world and 999 is Electron's preload world.
// The runtime's scripts and adapter code get a world each, so adapter code can't patch the fetch,
// JSON or Storage that the runtime's FETCH, EXTRACT and storage scripts use.
const RUNTIME_WORLD_ID = 1000
const ADAPTER_WORLD_ID = 1001

export interface ElectronPlatformOptions {
  /** Where the egress proxy connects an allowed CONNECT. The e2e suite maps its test hosts here. */
  readonly dial?: Dial
}

export function electronPlatform(options: ElectronPlatformOptions = {}): BrowserPlatform {
  const sessions = new Map<string, ElectronPartition>()
  return {
    chromeVersion: process.versions.chrome,
    os: process.platform,
    systemVersion: process.getSystemVersion(),
    arch: process.arch,
    startProxy: (allow) => startEgressProxy({ allow, ...(options.dial ? { dial: options.dial } : {}) }),
    session(partition) {
      let wrapped = sessions.get(partition)
      if (wrapped === undefined) {
        wrapped = new ElectronPartition(electronSession.fromPartition(partition))
        sessions.set(partition, wrapped)
      }
      return wrapped
    },
    openSurface: (partition) => new ElectronSurface(partition),
    setDefaultUserAgent: (userAgent) => {
      app.userAgentFallback = userAgent
    },
  }
}

class ElectronPartition implements PartitionSession {
  private readonly headers: [string, string][] = []
  private watcher: ((response: ObservedResponse) => void) | null = null
  private listening = false

  constructor(private readonly ses: Session) {}

  setUserAgent(userAgent: string, acceptLanguages: string): void {
    this.ses.setUserAgent(userAgent, acceptLanguages)
  }

  harden(): void {
    this.ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    this.ses.setPermissionCheckHandler(() => false)
    this.ses.on('will-download', (event) => event.preventDefault())
  }

  filterRequests(allow: (request: OutgoingRequest) => boolean): void {
    this.ses.webRequest.onBeforeRequest((details, callback) => {
      callback({
        cancel: !allow({ url: details.url, method: details.method, resourceType: details.resourceType }),
      })
    })
  }

  watchResponses(listener: (response: ObservedResponse) => void): void {
    this.watcher = listener
    this.listenForHeaders()
  }

  async useProxy(proxy: ProxyHandle): Promise<void> {
    // "<-loopback>" removes Chromium's implicit direct route to localhost, so loopback goes through
    // the proxy too, and is refused there like any other undeclared host.
    await this.ses.setProxy({ mode: 'fixed_servers', proxyRules: proxy.url, proxyBypassRules: '<-loopback>' })
    await this.ses.closeAllConnections()
  }

  addResponseHeader(name: string, value: string): void {
    this.headers.push([name, value])
    this.listenForHeaders()
  }

  /**
   * The session's one onHeadersReceived listener, for both jobs. Headers rather than onCompleted:
   * a request cancelled or failed after its headers arrived (a page navigating away, a stopped
   * load) never completes, and its status would go unseen.
   */
  private listenForHeaders(): void {
    if (this.listening) return
    this.listening = true
    this.ses.webRequest.onHeadersReceived((details, callback) => {
      try {
        const header = Object.entries(details.responseHeaders ?? {}).find(
          ([name]) => name.toLowerCase() === 'content-type',
        )
        this.watcher?.({
          url: details.url,
          method: details.method,
          resourceType: details.resourceType,
          status: details.statusCode,
          contentType: header?.[1]?.[0] ?? null,
        })
      } catch {
        // A watcher's failure must not hold the response.
      }
      if (this.headers.length === 0) {
        callback({})
        return
      }
      const responseHeaders = { ...details.responseHeaders }
      for (const [headerName, headerValue] of this.headers) responseHeaders[headerName] = [headerValue]
      callback({ responseHeaders })
    })
  }

  getCookies(): Promise<readonly CookieRecord[]> {
    return this.ses.cookies.get({})
  }

  setCookie(details: CookieSetDetails): Promise<void> {
    return this.ses.cookies.set({ ...details })
  }

  fetch(request: SessionFetchRequest): Promise<SessionFetchResponse> {
    return new Promise((resolve) => {
      let settled = false
      let client: Electron.ClientRequest | null = null
      // Settles first and only then aborts, so that the abort's own event can't overtake the answer.
      const finish = (response: SessionFetchResponse, abort = false) => {
        if (settled) return
        settled = true
        request.signal.removeEventListener('abort', onAbort)
        resolve(response)
        if (abort) client?.abort()
      }
      const onAbort = () => finish({ kind: 'failed', failure: 'aborted' }, true)
      if (request.signal.aborted) {
        finish({ kind: 'failed', failure: 'aborted' })
        return
      }
      request.signal.addEventListener('abort', onAbort, { once: true })
      try {
        client = net.request({
          method: 'GET',
          url: request.url,
          session: this.ses,
          // The session's cookies go out, and what the response sets is kept, as for the page.
          credentials: 'include',
          // A cached answer from before a login or logout would make the probe lie.
          cache: 'no-store',
          // The page's default. Chromium refuses an explicit Referer this policy wouldn't send.
          referrerPolicy: 'strict-origin-when-cross-origin',
          // Every redirect comes back to the caller, which decides about the next hop itself.
          redirect: 'manual',
          // The page's origin: Chromium computes Sec-Fetch-Site from it, in place of the header's
          // placeholder value.
          origin: request.initiator,
        })
        // setHeader keeps the order and the case. The network stack puts the Referer straight after
        // these, then Accept-Encoding and the cookies, as Chrome sends a page's fetch().
        for (const [name, value] of request.headers) client.setHeader(name, value)
        if (request.referrer !== null) client.setHeader('Referer', request.referrer)
      } catch {
        finish({ kind: 'failed', failure: 'network' }, true)
        return
      }
      const current = client
      current.on('redirect', (_status, _method, location) =>
        finish({ kind: 'redirect', location: String(location) }, true),
      )
      // HTTP authentication is never answered: cancel it.
      current.on('login', (_info, callback) => callback())
      current.on('error', () => finish({ kind: 'failed', failure: 'network' }))
      current.on('abort', () => finish({ kind: 'failed', failure: 'aborted' }))
      current.on('response', (response) => {
        const chunks: Buffer[] = []
        let size = 0
        response.on('data', (chunk: Buffer) => {
          if (settled) return
          size += chunk.length
          if (size > request.maxBytes) {
            finish({ kind: 'failed', failure: 'too-large' }, true)
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => {
          const header = response.headers['content-type']
          const contentType = Array.isArray(header) ? (header[0] ?? null) : (header ?? null)
          finish({ kind: 'response', status: response.statusCode, contentType, body: Buffer.concat(chunks) })
        })
        response.on('error', () => finish({ kind: 'failed', failure: 'network' }))
        response.on('aborted', () => finish({ kind: 'failed', failure: 'aborted' }))
      })
      current.end()
    })
  }

  onCookieChanged(listener: (cookie: CookieRecord) => void): void {
    // A removal (expired, overwritten, evicted, explicit) carries the value that was removed.
    this.ses.cookies.on('changed', (_event, cookie) => listener(cookie))
  }
}

class ElectronSurface implements BrowserSurface {
  private readonly window: BrowserWindow
  private readonly contents: WebContents
  private guard: (navigation: PendingNavigation) => boolean = () => true
  private closeHandler: (() => boolean) | null = null
  private readonly navigationListeners: ((event: NavigationEvent) => void)[] = []
  private readonly destroyedHandlers: (() => void)[] = []

  constructor(partition: string) {
    // Hidden but headed: headless gets fingerprinted, a hidden window doesn't (the earlier app).
    this.window = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: {
        partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webviewTag: false,
        // The spellchecker can send typed words to a service; usernames and codes are typed here.
        spellcheck: false,
        devTools: false,
        backgroundThrottling: false,
        safeDialogs: true,
        navigateOnDragDrop: false,
      },
    })
    const contents = this.window.webContents
    this.contents = contents
    // With a proxy set (the tool partition's), WebRTC may then only use TCP through it, where the
    // egress list applies; UDP, which no proxy here carries, is off.
    contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-frame-navigate', (event) => {
      if (!this.guard({ url: event.url, isMainFrame: event.isMainFrame })) event.preventDefault()
    })
    contents.on('will-navigate', (event) => {
      if (!this.guard({ url: event.url, isMainFrame: true })) event.preventDefault()
    })
    contents.on('will-redirect', (event) => {
      if (!this.guard({ url: event.url, isMainFrame: event.isMainFrame })) event.preventDefault()
    })
    contents.on('did-frame-navigate', (_event, url, _code, _status, isMainFrame, processId, routingId) => {
      const frame = isMainFrame ? contents.mainFrame : webFrameMain.fromId(processId, routingId)
      const frameNodeId = frame === undefined || frame === null ? null : String(frame.frameTreeNodeId)
      this.emit({ kind: 'commit', url, isMainFrame, frameNodeId })
    })
    contents.on('did-redirect-navigation', (event) => {
      const frameNodeId = event.frame === null ? null : String(event.frame.frameTreeNodeId)
      this.emit({ kind: 'redirect', url: event.url, isMainFrame: event.isMainFrame, frameNodeId })
    })
    this.window.on('close', (event) => {
      if (this.closeHandler?.() === true) event.preventDefault()
    })
    this.window.on('closed', () => {
      for (const handler of [...this.destroyedHandlers]) handler()
    })
  }

  load(url: string): Promise<LoadResult> {
    return this.contents.loadURL(url).then(
      (): LoadResult => ({ ok: true }),
      (error: unknown): LoadResult => {
        const code = (error as { code?: unknown }).code
        return { ok: false, code: typeof code === 'string' ? code : 'ERR_FAILED' }
      },
    )
  }

  isLoading(): boolean {
    return !this.contents.isDestroyed() && this.contents.isLoading()
  }

  nextStopLoading(): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        this.contents.removeListener('did-stop-loading', done)
        removeDestroyed()
        resolve()
      }
      const removeDestroyed = this.onDestroyed(done)
      this.contents.once('did-stop-loading', done)
    })
  }

  stop(): void {
    if (!this.contents.isDestroyed()) this.contents.stop()
  }

  url(): string {
    return this.contents.isDestroyed() ? '' : this.contents.getURL()
  }

  frames(): readonly FrameHandle[] {
    if (this.contents.isDestroyed()) return []
    const main = this.contents.mainFrame
    const subtree = [
      main,
      ...main.framesInSubtree.filter((frame) => frame.frameTreeNodeId !== main.frameTreeNodeId),
    ]
    return subtree.map((frame, index): FrameHandle => {
      const parentId = frame.parent?.frameTreeNodeId
      return {
        id: frame.frameToken,
        nodeId: String(frame.frameTreeNodeId),
        origin: frame.origin,
        url: frame.url,
        parentIndex:
          index === 0 ? null : subtree.findIndex((candidate) => candidate.frameTreeNodeId === parentId),
        receivesInput: index === 0 || frame.processId === main.processId,
        run: (code) => {
          // Touching a destroyed frame can take the main process down with it.
          if (this.contents.isDestroyed() || frame.isDestroyed() || frame.detached) {
            return Promise.reject(new Error('frame is gone'))
          }
          return index === 0
            ? this.contents.executeJavaScriptInIsolatedWorld(RUNTIME_WORLD_ID, [{ code }])
            : frame.executeJavaScript(code)
        },
        runAdapter: (code) => {
          if (index !== 0) return Promise.reject(new Error('adapter code runs in the main frame only'))
          if (this.contents.isDestroyed() || frame.isDestroyed() || frame.detached) {
            return Promise.reject(new Error('frame is gone'))
          }
          return this.contents.executeJavaScriptInIsolatedWorld(ADAPTER_WORLD_ID, [{ code }])
        },
      }
    })
  }

  focusedFrameId(): string | null {
    if (this.contents.isDestroyed()) return null
    return this.contents.focusedFrame?.frameToken ?? null
  }

  click(x: number, y: number): void {
    this.contents.sendInputEvent({ type: 'mouseMove', x, y })
    this.contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
    this.contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
  }

  sendChar(char: string, events: KeyEvents): void {
    const full = events === 'full' && US_KEY.test(char)
    if (full) this.contents.sendInputEvent({ type: 'keyDown', keyCode: char })
    this.contents.sendInputEvent({ type: 'char', keyCode: char })
    if (full) this.contents.sendInputEvent({ type: 'keyUp', keyCode: char })
  }

  async overrideUserAgent(override: UserAgentOverride): Promise<void> {
    // The override lasts while the debugger stays attached, which is the window's lifetime, and
    // applies to every navigation after it. It reaches only the page's own target, though: a
    // worker or an out-of-process (cross-site) iframe is a target of its own, and would otherwise
    // show Electron's UA and the Mac's languages. So every such target is attached as it starts,
    // paused, given the same override, and only then let run. Shared workers aren't the page's
    // children, so they are found by discovery instead, in this partition only, and attached
    // once they are already running.
    const devtools = await this.devtools()
    const own = targetContext(await devtools.sendCommand('Target.getTargetInfo'))
    devtools.on('message', (_event, method: string, params: unknown) => {
      if (method === 'Target.attachedToTarget') {
        const child = attachedTarget(params)
        if (child !== null) void this.overrideChild(devtools, child, override)
      }
      if (method === 'Target.targetCreated') {
        const shared = sharedWorkerIn(params, own)
        if (shared !== null) {
          devtools.sendCommand('Target.attachToTarget', { targetId: shared, flatten: true }).catch(() => {})
        }
      }
    })
    await devtools.sendCommand('Emulation.setUserAgentOverride', override)
    await devtools.sendCommand('Target.setAutoAttach', AUTO_ATTACH)
    if (own !== null) {
      await devtools.sendCommand('Target.setDiscoverTargets', {
        discover: true,
        filter: [{ type: 'shared_worker' }],
      })
    }
  }

  async watchStorage(listener: (value: StorageValue) => void): Promise<void> {
    const devtools = await this.devtools()
    devtools.on('message', (_event, method: string, params: unknown, sessionId?: string) => {
      // Only the page's own target: DOMStorage isn't enabled on any other.
      if (sessionId !== undefined && sessionId !== '') return
      for (const value of storageValues(method, params)) listener(value)
    })
    await devtools.sendCommand('DOMStorage.enable')
  }

  async storageSettled(): Promise<void> {
    // The protocol answers in order on one session, so once this command is answered, every
    // storage event the page sent before it has been delivered.
    if (this.contents.isDestroyed() || !this.contents.debugger.isAttached()) return
    await this.contents.debugger.sendCommand('DOMStorage.enable')
  }

  focus(): void {
    this.contents.focus()
  }

  show(title: string): void {
    this.window.setTitle(title)
    this.window.show()
  }

  hide(): void {
    this.window.hide()
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
    this.navigationListeners.push(listener)
  }

  destroy(): void {
    if (!this.window.isDestroyed()) this.window.destroy()
  }

  isDestroyed(): boolean {
    return this.window.isDestroyed()
  }

  /**
   * Gives a newly attached frame or worker target the page's override, has it attach its own
   * children the same way, and resumes it. It is resumed whatever happens, or the page would hang.
   * A frame takes Emulation's override; a worker only Network's, which sets its navigator too.
   */
  private async overrideChild(
    devtools: Electron.Debugger,
    child: { readonly sessionId: string; readonly type: string },
    override: UserAgentOverride,
  ): Promise<void> {
    // Nothing here may wait forever: a command a target never answers would leave it paused.
    const send = (method: string, params: object = {}) =>
      Promise.race([
        devtools.sendCommand(method, params, child.sessionId).catch(() => {}),
        new Promise<void>((resolve) => setTimeout(resolve, CHILD_COMMAND_TIMEOUT_MS)),
      ])
    if (child.type === 'service_worker') {
      // A paused service worker answers no command, and is stopped once its start times out, so
      // it is resumed first and overridden as soon as it runs. Its UA is the process default,
      // which the session's UA has already set (see setDefaultUserAgent).
      await send('Runtime.runIfWaitingForDebugger')
      await send('Network.setUserAgentOverride', override)
      return
    }
    try {
      const frame = child.type === 'iframe' || child.type === 'page'
      await send(frame ? 'Emulation.setUserAgentOverride' : 'Network.setUserAgentOverride', override)
      await send('Target.setAutoAttach', AUTO_ATTACH)
    } finally {
      await send('Runtime.runIfWaitingForDebugger')
    }
  }

  /** The page's DevTools session, attached once for the window's lifetime. */
  private async devtools(): Promise<Electron.Debugger> {
    // A web contents that has never loaded has no renderer for a command to reach, and it waits
    // forever; about:blank never touches the network.
    if (this.contents.getURL() === '') await this.contents.loadURL('about:blank')
    const devtools = this.contents.debugger
    if (!devtools.isAttached()) devtools.attach('1.3')
    return devtools
  }

  private emit(event: NavigationEvent): void {
    for (const listener of this.navigationListeners) listener(event)
  }
}

const CHILD_COMMAND_TIMEOUT_MS = 2000

/** Attach every child target (worker, out-of-process frame) as it starts, paused until set up. */
const AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }

/** The browser context (partition) a Target.getTargetInfo answer names, or null. */
function targetContext(answer: unknown): string | null {
  const context = (answer as { targetInfo?: { browserContextId?: unknown } } | null)?.targetInfo
    ?.browserContextId
  return typeof context === 'string' && context !== '' ? context : null
}

/** The target id of a shared worker created in browser context `own`, or null. */
function sharedWorkerIn(params: unknown, own: string | null): string | null {
  const info = (params as { targetInfo?: Record<string, unknown> } | null)?.targetInfo
  if (own === null || info === undefined) return null
  const { type, browserContextId, targetId } = info
  if (type !== 'shared_worker' || browserContextId !== own || typeof targetId !== 'string') return null
  return targetId
}

function attachedTarget(params: unknown): { sessionId: string; type: string } | null {
  if (typeof params !== 'object' || params === null) return null
  const { sessionId, targetInfo } = params as { sessionId?: unknown; targetInfo?: { type?: unknown } }
  if (typeof sessionId !== 'string' || typeof targetInfo?.type !== 'string') return null
  return { sessionId, type: targetInfo.type }
}

/**
 * The values a DOMStorage event carries: the new value of an added item, and both the old and the
 * new of an updated one. A removal carries no value; the old one was reported when it was written.
 */
function storageValues(method: string, params: unknown): StorageValue[] {
  if (typeof params !== 'object' || params === null) return []
  const { storageId, key, oldValue, newValue } = params as Record<string, unknown>
  if (typeof key !== 'string' || typeof storageId !== 'object' || storageId === null) return []
  const origin = storageOrigin(storageId as Record<string, unknown>)
  if (origin === null) return []
  const values =
    method === 'DOMStorage.domStorageItemAdded'
      ? [newValue]
      : method === 'DOMStorage.domStorageItemUpdated'
        ? [oldValue, newValue]
        : []
  return values
    .filter((value): value is string => typeof value === 'string')
    .map((value) => ({ origin, key, value }))
}

/** The origin of a DOMStorage storage id: securityOrigin, or the storage key's (minus "^..." partitioning). */
function storageOrigin(storageId: Record<string, unknown>): string | null {
  const { securityOrigin, storageKey } = storageId
  const raw =
    typeof securityOrigin === 'string' && securityOrigin !== ''
      ? securityOrigin
      : typeof storageKey === 'string'
        ? (storageKey.split('^')[0] ?? '')
        : ''
  try {
    const origin = new URL(raw).origin
    return origin === 'null' ? null : origin
  } catch {
    return null
  }
}
