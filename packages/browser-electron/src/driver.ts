// The session driver: one site's auth and tool partitions, the pages in them, and the one-way
// handoff between them. Written against BrowserPlatform; src/electron supplies the real one.

import {
  type AdapterManifest,
  type AuthPage,
  hostAllowed,
  httpsOrigin,
  isBareOrigin,
  originAllowed,
  type SessionDriver,
  SiteAdapterError,
  type ToolPage,
} from '@siteadapter/core'
import { SurfaceAuthPage } from './auth-page'
import { cookieSetDetails, cookiesForDomains } from './cookies'
import { egressAllowed, requestTarget } from './guards'
import { isRecord, type PageTiming } from './page-core'
import { partitionName } from './partitions'
import type {
  BrowserPlatform,
  BrowserSurface,
  CookieRecord,
  FrameHandle,
  PartitionSession,
  Role,
  Timers,
} from './platform'
import { realTimers } from './platform'
import { readStorageScript, writeStorageScript } from './scripts'
import { SurfaceToolPage } from './tool-page'
import { cleanChromeUserAgent, type UserAgentMode } from './user-agent'

/** A request the tool partition's egress guard cancelled. Origin and path only. */
export interface BlockedRequest {
  readonly method: string
  readonly target: string
}

export interface DriverOptions {
  readonly adapterId: string
  /** Where the tool page opens on first use. */
  readonly home: string
  /** Origins the auth partition's main frame may be on. */
  readonly navigation: readonly string[]
  /** Hosts the tool partition may send requests to. */
  readonly egress: readonly string[]
  readonly userAgent?: UserAgentMode
  readonly stepTimeoutMs?: number
  readonly typingDelayMs?: number
  /**
   * Path of a light document on each storage origin, loaded only when the storage handoff needs a
   * page on that origin and none is open. Its own content doesn't matter; its origin does.
   */
  readonly storageDocumentPath?: string
  readonly onBlocked?: (blocked: BlockedRequest) => void
  readonly timers?: Timers
}

export type ManifestOptions = Omit<DriverOptions, 'adapterId' | 'home' | 'navigation' | 'egress'>

const DEFAULT_STEP_TIMEOUT_MS = 30_000
const DEFAULT_TYPING_DELAY_MS = 60

export class ElectronSessionDriver implements SessionDriver {
  static forManifest(
    platform: BrowserPlatform,
    manifest: AdapterManifest,
    options: ManifestOptions = {},
  ): ElectronSessionDriver {
    return new ElectronSessionDriver(platform, {
      ...options,
      adapterId: manifest.id,
      home: manifest.home,
      navigation: manifest.navigation,
      egress: manifest.egress,
    })
  }

  private readonly partitions: Readonly<Record<Role, string>>
  private readonly configured = new Set<Role>()
  private readonly timing: PageTiming
  private readonly authPages = new Map<BrowserSurface, SurfaceAuthPage>()
  private readonly helpers = new Set<BrowserSurface>()
  private tool: { surface: BrowserSurface; page: Promise<SurfaceToolPage> } | null = null

  constructor(
    private readonly platform: BrowserPlatform,
    private readonly options: DriverOptions,
  ) {
    this.partitions = {
      auth: partitionName('auth', options.adapterId),
      tool: partitionName('tool', options.adapterId),
    }
    this.timing = {
      timers: options.timers ?? realTimers,
      stepTimeoutMs: options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS,
      typingDelayMs: options.typingDelayMs ?? DEFAULT_TYPING_DELAY_MS,
    }
  }

  async openAuthPage(): Promise<AuthPage> {
    const surface = this.open('auth')
    const page = new SurfaceAuthPage(surface, this.options.navigation, this.timing)
    this.authPages.set(surface, page)
    surface.onDestroyed(() => this.authPages.delete(surface))
    return page
  }

  toolPage(): Promise<ToolPage> {
    if (this.tool !== null && !this.tool.surface.isDestroyed()) return this.tool.page
    const surface = this.open('tool')
    const page = new SurfaceToolPage(surface, this.options.egress, this.timing)
    const opened = page.goto(this.options.home).then(
      () => page,
      (error: unknown) => {
        surface.destroy()
        throw error
      },
    )
    this.tool = { surface, page: opened }
    return opened
  }

  /**
   * Copies auth -> tool, never the reverse. Cookies keep every attribute; storage keys are read by
   * a runtime script in an auth-partition document and written by one in a tool-partition
   * document on the same origin.
   */
  async handoff(
    cookieDomains: readonly string[],
    storage: readonly { readonly origin: string; readonly keys: readonly string[] }[],
  ): Promise<void> {
    const auth = this.session('auth')
    const tool = this.session('tool')
    try {
      const cookies = cookiesForDomains(await auth.getCookies(), cookieDomains)
      for (const cookie of cookies) await tool.setCookie(cookieSetDetails(cookie))
    } catch {
      throw new SiteAdapterError('session-handoff', 'internal')
    }
    for (const { origin, keys } of storage) await this.copyStorage(origin, keys)
  }

  async sessionCookieValues(cookieDomains: readonly string[]): Promise<readonly string[]> {
    let cookies: CookieRecord[]
    try {
      cookies = cookiesForDomains(await this.session('tool').getCookies(), cookieDomains)
    } catch {
      throw new SiteAdapterError('session-handoff', 'internal')
    }
    return [...new Set(cookies.map((cookie) => cookie.value).filter((value) => value.length > 0))]
  }

  async close(): Promise<void> {
    const surfaces = [...this.authPages.keys(), ...this.helpers]
    if (this.tool !== null) surfaces.push(this.tool.surface)
    for (const surface of surfaces) if (!surface.isDestroyed()) surface.destroy()
    this.authPages.clear()
    this.helpers.clear()
    this.tool = null
  }

  private async copyStorage(origin: string, keys: readonly string[]): Promise<void> {
    if (!isBareOrigin(origin)) throw new SiteAdapterError('session-handoff', 'invalid')
    if (!originAllowed(origin, this.options.navigation)) {
      throw new SiteAdapterError('session-handoff', 'origin-mismatch')
    }
    const host = new URL(origin).hostname
    if (!hostAllowed(host, this.options.egress))
      throw new SiteAdapterError('session-handoff', 'host-not-allowed')
    const raw = await this.inDocument('auth', origin, (frame) => frame.run(readStorageScript(keys)))
    if (!isRecord(raw)) throw new SiteAdapterError('session-handoff', 'internal')
    const entries: [string, string][] = []
    for (const key of keys) {
      const value = raw[key]
      if (typeof value === 'string') entries.push([key, value])
    }
    if (entries.length === 0) return
    await this.inDocument('tool', origin, (frame) => frame.run(writeStorageScript(entries)))
  }

  /**
   * Runs `use` against the main frame of a document on `origin` in `role`'s partition: an open page
   * already there, or a short-lived helper page that is destroyed afterwards.
   */
  private async inDocument<T>(
    role: Role,
    origin: string,
    use: (frame: FrameHandle) => Promise<T>,
  ): Promise<T> {
    const wanted = httpsOrigin(origin)
    const open = this.openSurfaces(role).find((surface) => surface.frames()[0]?.origin === wanted)
    if (open !== undefined) return this.runIn(open, use)
    const surface = this.open(role)
    this.helpers.add(surface)
    try {
      const url = new URL(this.options.storageDocumentPath ?? '/robots.txt', origin).href
      const page =
        role === 'auth'
          ? new SurfaceAuthPage(surface, this.options.navigation, this.timing)
          : new SurfaceToolPage(surface, this.options.egress, this.timing)
      await page.goto(url)
      if (surface.frames()[0]?.origin !== wanted)
        throw new SiteAdapterError('session-handoff', 'origin-mismatch')
      return await this.runIn(surface, use)
    } catch (error) {
      if (error instanceof SiteAdapterError && error.stage === 'session-handoff') throw error
      throw new SiteAdapterError('session-handoff', 'unavailable')
    } finally {
      this.helpers.delete(surface)
      if (!surface.isDestroyed()) surface.destroy()
    }
  }

  private async runIn<T>(surface: BrowserSurface, use: (frame: FrameHandle) => Promise<T>): Promise<T> {
    const frame = surface.frames()[0]
    if (frame === undefined) throw new SiteAdapterError('session-handoff', 'internal')
    try {
      return await use(frame)
    } catch {
      throw new SiteAdapterError('session-handoff', 'internal')
    }
  }

  private openSurfaces(role: Role): BrowserSurface[] {
    if (role === 'auth') return [...this.authPages.keys()].filter((surface) => !surface.isDestroyed())
    return this.tool !== null && !this.tool.surface.isDestroyed() ? [this.tool.surface] : []
  }

  private open(role: Role): BrowserSurface {
    this.session(role)
    return this.platform.openSurface(this.partitions[role])
  }

  /** The partition's session, hardened and guarded before any page opens in it. */
  private session(role: Role): PartitionSession {
    const session = this.platform.session(this.partitions[role])
    if (this.configured.has(role)) return session
    session.harden()
    if (this.options.userAgent === 'chrome') {
      session.setUserAgent(cleanChromeUserAgent(this.platform.chromeVersion, this.platform.os))
    }
    if (role === 'tool') {
      const { egress, onBlocked } = this.options
      session.filterRequests((request) => {
        if (egressAllowed(request.url, egress)) return true
        try {
          onBlocked?.({ method: request.method, target: requestTarget(request.url) })
        } catch {
          // A failing reporter must not turn a block into an allow.
        }
        return false
      })
      // Stops the page resolving hostnames it only links to: a hostname can carry data out
      // through DNS without any request that webRequest would see.
      session.addResponseHeader('X-DNS-Prefetch-Control', 'off')
    }
    this.configured.add(role)
    return session
  }
}
