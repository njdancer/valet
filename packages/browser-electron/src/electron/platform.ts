// BrowserPlatform over real Electron. Kept thin: every decision lives in the pure modules, and this
// file only forwards. It is covered by the e2e suite, not unit tests.

import {
  BrowserWindow,
  session as electronSession,
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
  OutgoingRequest,
  PartitionSession,
  PendingNavigation,
  ProxyHandle,
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
  }
}

class ElectronPartition implements PartitionSession {
  private readonly headers: [string, string][] = []

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

  async useProxy(proxy: ProxyHandle): Promise<void> {
    // "<-loopback>" removes Chromium's implicit direct route to localhost, so loopback goes through
    // the proxy too, and is refused there like any other undeclared host.
    await this.ses.setProxy({ mode: 'fixed_servers', proxyRules: proxy.url, proxyBypassRules: '<-loopback>' })
    await this.ses.closeAllConnections()
  }

  addResponseHeader(name: string, value: string): void {
    this.headers.push([name, value])
    if (this.headers.length > 1) return
    this.ses.webRequest.onHeadersReceived((details, callback) => {
      const responseHeaders = { ...details.responseHeaders }
      for (const [header, headerValue] of this.headers) responseHeaders[header] = [headerValue]
      callback({ responseHeaders })
    })
  }

  getCookies(): Promise<readonly CookieRecord[]> {
    return this.ses.cookies.get({})
  }

  setCookie(details: CookieSetDetails): Promise<void> {
    return this.ses.cookies.set({ ...details })
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
    // A web contents that has never loaded has no renderer for the command to reach, and it waits
    // forever; about:blank never touches the network. The override lasts while the debugger stays
    // attached, which is the window's lifetime, and applies to every navigation after it.
    if (this.contents.getURL() === '') await this.contents.loadURL('about:blank')
    const devtools = this.contents.debugger
    if (!devtools.isAttached()) devtools.attach('1.3')
    await devtools.sendCommand('Emulation.setUserAgentOverride', override)
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

  private emit(event: NavigationEvent): void {
    for (const listener of this.navigationListeners) listener(event)
  }
}
