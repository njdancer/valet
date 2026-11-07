// The app's own windows: the control panel, the tray popover, the confirmation panel and the login
// hand-off banner. Every one is sandboxed with context isolation, no Node, the preload's API only,
// and may show only the app's own pages: navigation and new windows are refused, and the default
// session loads nothing but the renderer's files.

import { partitionName } from '@valet/browser-electron'
import { BrowserWindow, type Rectangle, screen, session, type WebContents } from 'electron'
import { parseRoute } from '../../renderer/lib/routes'
import type { HashRoute } from '../../shared/api'
import { onAppOrigin } from '../core/app-scheme'
import { bannerBeside, handoffLayout, topRight, underTrayIcon } from '../core/geometry'
import type { AppWindow, WindowRole } from '../core/ipc'
import { isAppPage, type Page, pageUrl, type RendererBase, windowTitle } from '../core/launch'

export interface WindowsOptions {
  readonly base: RendererBase
  readonly preload: string
  readonly demo: boolean
  readonly e2e: boolean
  readonly devTools: boolean
  /** The confirmation window was shown or regained focus (it re-arms the approve delay). */
  readonly onConfirmationArmed: (id: string) => void
}

const CONFIRMATION_SIZE = { width: 460, height: 620 }
const TRAY_SIZE = { width: 400, height: 640 }
const BANNER_HEIGHT = 168

export class AppWindows {
  /** By webContents id: each window's role and what it was opened for. */
  private readonly windows = new Map<number, AppWindow>()
  private control: BrowserWindow | null = null
  private tray: BrowserWindow | null = null
  private readonly confirmations = new Map<string, BrowserWindow>()
  private readonly banners = new Map<string, BrowserWindow>()
  /** Per banner: stops it following its auth window. */
  private readonly unfollow = new Map<string, () => void>()

  constructor(private readonly options: WindowsOptions) {}

  /** The window a request came from, or null for anything that isn't ours. */
  windowOf(contents: WebContents): AppWindow | null {
    return this.windows.get(contents.id) ?? null
  }

  /** Every live window of ours, for the event channel. */
  all(): BrowserWindow[] {
    return [this.control, this.tray, ...this.confirmations.values(), ...this.banners.values()].filter(
      (w): w is BrowserWindow => w !== null && !w.isDestroyed(),
    )
  }

  /** The default session, which only our windows use, may load the renderer's files and nothing else. */
  lockDefaultSession(): void {
    const base = this.options.base
    const allowed = (url: string) =>
      url.startsWith('devtools:') ||
      url.startsWith('data:') ||
      (base.kind === 'app' ? onAppOrigin(url) : sameOrigin(url, base.origin))
    session.defaultSession.webRequest.onBeforeRequest((details, callback) =>
      callback({ cancel: !allowed(details.url) }),
    )
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    session.defaultSession.setPermissionCheckHandler(() => false)
  }

  openControlPanel(route: HashRoute | null): void {
    const hash = route !== null && parseRoute(route).page !== 'not-found' ? route : null
    if (this.control !== null && !this.control.isDestroyed()) {
      if (hash !== null) this.setHash(this.control, hash)
      this.control.show()
      this.control.focus()
      return
    }
    const window = this.create('control', 'index.html', hash ?? '#/adapters', {
      width: 1180,
      height: 780,
      minWidth: 880,
      minHeight: 560,
      titleBarStyle: 'hiddenInset',
    })
    window.once('ready-to-show', () => window.show())
    window.on('closed', () => {
      this.control = null
    })
    this.control = window
  }

  toggleTray(iconBounds: Rectangle): void {
    if (this.tray !== null && !this.tray.isDestroyed() && this.tray.isVisible()) {
      this.tray.hide()
      return
    }
    const display = screen.getDisplayNearestPoint({ x: iconBounds.x, y: iconBounds.y })
    const bounds = underTrayIcon(iconBounds, TRAY_SIZE, display.workArea)
    if (this.tray === null || this.tray.isDestroyed()) {
      const window = this.create('tray', 'tray.html', '', {
        ...bounds,
        frame: false,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        transparent: true,
        alwaysOnTop: true,
      })
      window.on('blur', () => window.hide())
      window.on('closed', () => {
        this.tray = null
      })
      window.once('ready-to-show', () => window.show())
      this.tray = window
      return
    }
    this.tray.setBounds(bounds)
    this.tray.show()
  }

  hideTray(): void {
    this.tray?.hide()
  }

  /**
   * The confirmation panel, floating and on top, shown inactive: it never takes focus from what the
   * person is typing into, and the click that brings it forward isn't delivered (acceptFirstMouse).
   */
  showConfirmation(id: string): void {
    const existing = this.confirmations.get(id)
    if (existing !== undefined && !existing.isDestroyed()) {
      existing.showInactive()
      this.options.onConfirmationArmed(id)
      return
    }
    const display = screen.getPrimaryDisplay()
    const window = this.create(
      'confirmation',
      'index.html',
      `#/confirm/${encodeURIComponent(id)}`,
      {
        ...topRight(CONFIRMATION_SIZE, display.workArea),
        frame: false,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        acceptFirstMouse: false,
      },
      id,
    )
    window.setAlwaysOnTop(true, 'floating')
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    window.once('ready-to-show', () => {
      window.showInactive()
      this.options.onConfirmationArmed(id)
    })
    window.on('show', () => this.options.onConfirmationArmed(id))
    window.on('focus', () => this.options.onConfirmationArmed(id))
    window.on('closed', () => this.confirmations.delete(id))
    this.confirmations.set(id, window)
  }

  closeConfirmation(id: string): void {
    const window = this.confirmations.get(id)
    this.confirmations.delete(id)
    if (window !== undefined && !window.isDestroyed()) window.destroy()
  }

  /**
   * The hand-off banner, beside the adapter's auth window (found by its partition) and never over
   * it: the auth window is moved down, and shortened if need be, to make room above it
   * (handoffLayout), and the banner follows the window as the person moves or resizes it.
   */
  showNeedsUser(adapterId: string): void {
    const authWindow = BrowserWindow.getAllWindows().find(
      (w) =>
        !w.isDestroyed() && w.webContents.session === session.fromPartition(partitionName('auth', adapterId)),
    )
    const target = authWindow?.getBounds() ?? null
    const display = target === null ? screen.getPrimaryDisplay() : screen.getDisplayMatching(target)
    const layout = handoffLayout(target, BANNER_HEIGHT, display.workArea)
    if (authWindow !== undefined && layout.window !== null) authWindow.setBounds(layout.window)
    const bounds = layout.banner
    const existing = this.banners.get(adapterId)
    if (existing !== undefined && !existing.isDestroyed()) {
      existing.setBounds(bounds)
      existing.showInactive()
      if (authWindow !== undefined) this.follow(adapterId, existing, authWindow)
      return
    }
    const window = this.create(
      'needs-user',
      'index.html',
      `#/needs-user/${encodeURIComponent(adapterId)}`,
      {
        ...bounds,
        frame: false,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
      },
      adapterId,
    )
    window.once('ready-to-show', () => window.showInactive())
    window.on('closed', () => {
      if (this.banners.get(adapterId) === window) {
        this.banners.delete(adapterId)
        this.stopFollowing(adapterId)
      }
    })
    this.banners.set(adapterId, window)
    if (authWindow !== undefined) this.follow(adapterId, window, authWindow)
  }

  closeNeedsUser(adapterId: string): void {
    const window = this.banners.get(adapterId)
    this.banners.delete(adapterId)
    this.stopFollowing(adapterId)
    if (window !== undefined && !window.isDestroyed()) window.destroy()
  }

  /** Keeps `banner` beside `authWindow` as the person moves or resizes it. */
  private follow(adapterId: string, banner: BrowserWindow, authWindow: BrowserWindow): void {
    this.stopFollowing(adapterId)
    const place = () => {
      if (banner.isDestroyed() || authWindow.isDestroyed()) return
      const bounds = authWindow.getBounds()
      banner.setBounds(bannerBeside(bounds, BANNER_HEIGHT, screen.getDisplayMatching(bounds).workArea))
    }
    authWindow.on('move', place)
    authWindow.on('resize', place)
    this.unfollow.set(adapterId, () => {
      if (authWindow.isDestroyed()) return
      authWindow.off('move', place)
      authWindow.off('resize', place)
    })
  }

  private stopFollowing(adapterId: string): void {
    this.unfollow.get(adapterId)?.()
    this.unfollow.delete(adapterId)
  }

  closeAll(): void {
    for (const window of this.all()) window.destroy()
  }

  private create(
    role: WindowRole,
    page: Page,
    hash: string,
    options: Electron.BrowserWindowConstructorOptions,
    detail = '',
  ): BrowserWindow {
    const window = new BrowserWindow({
      ...options,
      show: false,
      title: windowTitle(role, this.options.demo, this.options.e2e, detail),
      backgroundColor: options.transparent === true ? '#00000000' : '#f5f5f7',
      webPreferences: {
        preload: this.options.preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        navigateOnDragDrop: false,
        spellcheck: false,
        devTools: this.options.devTools,
      },
    })
    const contents = window.webContents
    this.windows.set(contents.id, { role, shows: detail === '' ? null : detail })
    window.on('closed', () => this.windows.delete(contents.id))
    // The window keeps the title we gave it, not the one in its HTML, and so does the document, so
    // tests that read either see the same deterministic title.
    const title = window.getTitle()
    window.on('page-title-updated', (event) => event.preventDefault())
    contents.on('did-finish-load', () => {
      void contents
        .executeJavaScript(`document.title = ${JSON.stringify(title)}`, false)
        .catch(() => undefined)
    })
    contents.on('will-navigate', (event, url) => {
      if (!isAppPage(this.options.base, url)) event.preventDefault()
    })
    contents.on('will-redirect', (event) => event.preventDefault())
    contents.on('will-attach-webview', (event) => event.preventDefault())
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    void window.loadURL(pageUrl(this.options.base, page, hash))
    return window
  }

  /** Moves an open control panel to a route without reloading it. The route is already checked. */
  private setHash(window: BrowserWindow, hash: HashRoute): void {
    void window.webContents
      .executeJavaScript(`location.hash = ${JSON.stringify(hash)}`, false)
      .catch(() => undefined)
  }
}

function sameOrigin(url: string, origin: string): boolean {
  try {
    const parsed = new URL(url)
    const expected = new URL(origin)
    // The dev server's HMR socket is on the same host and port.
    return parsed.host === expected.host && ['http:', 'ws:'].includes(parsed.protocol)
  } catch {
    return false
  }
}
