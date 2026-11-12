// The sandbox renderers (docs/sandbox.md#the-renderer-around-it): tool code for a sandboxed adapter
// runs in QuickJS inside one of these hidden, sandboxed windows, one per adapter version, with a
// fresh QuickJS instance per run. Each window's session is in memory, refuses every request, and
// sends anything that slips past that to the deny-all egress proxy; it may open nothing, navigate
// nowhere and be granted no permission.
//
// The main process watches each window: a run that broke (a slice past its deadline, a bootstrap
// failure), a crash, or no answer to a ping while a run waits destroys the window, and every run in
// it ends as tool-run/internal (its channel exits). Idle windows close after a minute; at most
// MAX_WINDOWS live at once, the least recently used idle one closing first.

import { readFile } from 'node:fs/promises'
import type { ToolChannel, ToolProcessFactory } from '@valet/runtime'
import { END_RUN, SANDBOX_CHANNELS } from '@valet/sandbox/renderer'
import { BrowserWindow, MessageChannelMain, type MessagePortMain, type Session, session } from 'electron'

export const IDLE_CLOSE_MS = 60_000
export const MAX_WINDOWS = 6
const PING_EVERY_MS = 1_000
const PONG_WITHIN_MS = 3_000
const START_WITHIN_MS = 15_000

/**
 * The page: empty, and allowed to do nothing. The preload runs QuickJS in its isolated world, which
 * the page's CSP governs for WebAssembly: 'wasm-unsafe-eval' lets it compile QuickJS, and allows no
 * script of any kind (no 'self', no inline), so the main world stays empty.
 */
export const SANDBOX_PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(
  `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'wasm-unsafe-eval'"><title>Valet sandbox</title>`,
)}`

export interface SandboxPoolOptions {
  /** out/preload/sandbox.cjs */
  readonly preload: string
  /** out/preload/quickjs.wasm */
  readonly wasm: string
  /** The deny-all egress proxy's rules, e.g. http://127.0.0.1:53211. */
  readonly proxyUrl: string
  readonly log?: (line: string) => void
}

interface Run {
  readonly port: MessagePortMain
  readonly exit: () => void
}

interface SandboxWindow {
  readonly key: string
  readonly window: BrowserWindow
  readonly ready: Promise<boolean>
  readonly runs: Set<Run>
  lastUsed: number
  idleTimer: NodeJS.Timeout | null
  watchdog: NodeJS.Timeout | null
  lastPong: number
  destroyed: boolean
}

const configured = new WeakSet<Session>()

/** Every web capability of the session, off; every request refused; the proxy behind that. */
async function lockDown(ses: Session, proxyUrl: string): Promise<void> {
  if (configured.has(ses)) return
  configured.add(ses)
  ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: details.url !== SANDBOX_PAGE }))
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  ses.setDevicePermissionHandler(() => false)
  ses.on('will-download', (event) => event.preventDefault())
  await ses.setProxy({ mode: 'fixed_servers', proxyRules: proxyUrl, proxyBypassRules: '<-loopback>' })
}

export class SandboxPool {
  private readonly windows = new Map<string, SandboxWindow>()
  private wasm: Promise<ArrayBuffer> | null = null
  private oneShots = 0

  constructor(private readonly options: SandboxPoolOptions) {}

  /** Runs for one adapter version share its window. */
  forAdapter(adapterHash: string): ToolProcessFactory {
    return () => this.channel(`adapter:${adapterHash}`, false)
  }

  /** A window of its own for each run, closed when it ends: describe and check of anything new. */
  oneShot(): ToolProcessFactory {
    return () => this.channel(`one-shot:${++this.oneShots}`, true)
  }

  /** Closes every window, ending their runs. */
  closeAll(): void {
    for (const w of [...this.windows.values()]) this.destroy(w, 'closed')
  }

  /** How many windows are open now (for tests and diagnostics). */
  get size(): number {
    return this.windows.size
  }

  private wasmBytes(): Promise<ArrayBuffer> {
    this.wasm ??= readFile(this.options.wasm).then(
      (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer,
    )
    return this.wasm
  }

  private open(key: string): SandboxWindow {
    this.evict()
    const ses = session.fromPartition(`sandbox:${key}`, { cache: false })
    const window = new BrowserWindow({
      show: false,
      width: 100,
      height: 100,
      skipTaskbar: true,
      focusable: false,
      webPreferences: {
        session: ses,
        preload: this.options.preload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        webviewTag: false,
        spellcheck: false,
        backgroundThrottling: false,
        devTools: false,
        javascript: true,
        images: false,
        webgl: false,
        navigateOnDragDrop: false,
        safeDialogs: true,
        disableDialogs: true,
        autoplayPolicy: 'user-gesture-required',
      },
    })
    const contents = window.webContents
    contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', (event) => event.preventDefault())
    contents.on('will-redirect', (event) => event.preventDefault())
    contents.on('will-attach-webview', (event) => event.preventDefault())
    const entry: SandboxWindow = {
      key,
      window,
      ready: Promise.resolve(false),
      runs: new Set(),
      lastUsed: Date.now(),
      idleTimer: null,
      watchdog: null,
      lastPong: Date.now(),
      destroyed: false,
    }
    const ready = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), START_WITHIN_MS)
      contents.ipc.once(SANDBOX_CHANNELS.ready, (_event, ok) => {
        clearTimeout(timer)
        resolve(ok === true)
      })
    })
    ;(entry as { ready: Promise<boolean> }).ready = (async () => {
      try {
        await lockDown(ses, this.options.proxyUrl)
        await window.loadURL(SANDBOX_PAGE)
        contents.send(SANDBOX_CHANNELS.wasm, await this.wasmBytes())
      } catch {
        return false
      }
      return ready
    })().then((ok) => {
      if (!ok) this.destroy(entry, 'did not start')
      return ok
    })
    contents.ipc.on(SANDBOX_CHANNELS.pong, () => {
      entry.lastPong = Date.now()
    })
    // A run that broke leaves its QuickJS state suspect, and maybe the renderer's: start again.
    contents.ipc.on(SANDBOX_CHANNELS.broken, () => this.destroy(entry, 'a run broke'))
    contents.on('render-process-gone', () => this.destroy(entry, 'renderer gone'))
    contents.on('unresponsive', () => this.destroy(entry, 'unresponsive'))
    window.on('closed', () => this.destroy(entry, 'closed'))
    this.windows.set(key, entry)
    return entry
  }

  private destroy(entry: SandboxWindow, why: string): void {
    if (entry.destroyed) return
    entry.destroyed = true
    if (this.windows.get(entry.key) === entry) this.windows.delete(entry.key)
    if (entry.idleTimer !== null) clearTimeout(entry.idleTimer)
    if (entry.watchdog !== null) clearInterval(entry.watchdog)
    for (const run of [...entry.runs]) run.exit()
    entry.runs.clear()
    if (why !== 'closed' && why !== 'idle' && why !== 'one-shot done' && why !== 'evicted')
      this.options.log?.(`sandbox: window ${entry.key.split(':')[0]} ended (${why})`)
    const ses = entry.window.isDestroyed() ? null : entry.window.webContents.session
    if (!entry.window.isDestroyed()) entry.window.destroy()
    // Nothing should be in it; cleared anyway, in case something wrote there.
    void ses?.clearStorageData().catch(() => {})
    void ses?.clearCache().catch(() => {})
  }

  /** Closes the least recently used idle window while there are too many. */
  private evict(): void {
    while (this.windows.size >= MAX_WINDOWS) {
      const idle = [...this.windows.values()]
        .filter((w) => w.runs.size === 0)
        .sort((a, b) => a.lastUsed - b.lastUsed)
      const oldest = idle[0]
      if (oldest === undefined) return
      this.destroy(oldest, 'evicted')
    }
  }

  private watch(entry: SandboxWindow): void {
    if (entry.watchdog !== null) return
    entry.lastPong = Date.now()
    let id = 0
    entry.watchdog = setInterval(() => {
      if (entry.destroyed) return
      if (Date.now() - entry.lastPong > PONG_WITHIN_MS) {
        // Stuck in something QuickJS's interrupt can't reach (a C-level operation): end it.
        this.destroy(entry, 'no answer to ping')
        return
      }
      if (!entry.window.isDestroyed()) entry.window.webContents.send(SANDBOX_CHANNELS.ping, ++id)
    }, PING_EVERY_MS)
  }

  private settle(entry: SandboxWindow, oneShot: boolean): void {
    entry.lastUsed = Date.now()
    if (entry.runs.size > 0 || entry.destroyed) return
    if (entry.watchdog !== null) {
      clearInterval(entry.watchdog)
      entry.watchdog = null
    }
    if (oneShot) {
      this.destroy(entry, 'one-shot done')
      return
    }
    void entry.window.webContents.session.clearStorageData().catch(() => {})
    entry.idleTimer = setTimeout(() => this.destroy(entry, 'idle'), IDLE_CLOSE_MS)
  }

  private channel(key: string, oneShot: boolean): ToolChannel {
    let entry = this.windows.get(key)
    if (entry === undefined || entry.destroyed) entry = this.open(key)
    const w = entry
    if (w.idleTimer !== null) {
      clearTimeout(w.idleTimer)
      w.idleTimer = null
    }
    const listeners: ((message: unknown) => void)[] = []
    const exits: (() => void)[] = []
    const queued: unknown[] = []
    let exited = false
    let port: MessagePortMain | null = null
    const { port1, port2 } = new MessageChannelMain()
    const run: Run = {
      port: port1,
      exit: () => {
        if (exited) return
        exited = true
        w.runs.delete(run)
        try {
          port1.postMessage(END_RUN)
          port1.close()
        } catch {}
        for (const listener of exits.splice(0)) listener()
        this.settle(w, oneShot)
      },
    }
    w.runs.add(run)
    this.watch(w)
    port1.on('message', (event) => {
      if (!exited) for (const listener of listeners) listener(event.data)
    })
    port1.on('close', () => run.exit())
    port1.start()
    void w.ready.then((ok) => {
      if (exited) return
      if (!ok || w.destroyed || w.window.isDestroyed()) {
        run.exit()
        return
      }
      w.window.webContents.postMessage(SANDBOX_CHANNELS.run, null, [port2])
      port = port1
      for (const message of queued.splice(0)) port1.postMessage(message)
    })
    return {
      send: (message) => {
        if (exited) return
        if (port === null) queued.push(message)
        else port.postMessage(message)
      },
      onMessage: (listener) => {
        listeners.push(listener)
      },
      onExit: (listener) => {
        if (exited) listener()
        else exits.push(listener)
      },
      kill: () => run.exit(),
    }
  }
}
