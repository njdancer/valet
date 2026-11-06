// The session driver: one site's auth and tool partitions, the pages in them, and the one-way
// handoff between them. Written against BrowserPlatform; src/electron supplies the real one.

import {
  type AdapterManifest,
  type AuthPage,
  hostAllowed,
  httpsOrigin,
  isBareOrigin,
  originAllowed,
  type Purpose,
  type RequestDeclaration,
  type SessionDriver,
  SiteAdapterError,
  type ToolPage,
} from '@siteadapter/core'
import { SurfaceAuthPage } from './auth-page'
import { cookieSetDetails, cookiesForDomains } from './cookies'
import { type BlockReason, decideToolRequest, pathDigest, requestTarget } from './guards'
import { isRecord, type PageTiming } from './page-core'
import { partitionName } from './partitions'
import type {
  BrowserPlatform,
  BrowserSurface,
  CookieRecord,
  FrameHandle,
  OutgoingRequest,
  PartitionSession,
  ProxyHandle,
  Role,
  Timers,
} from './platform'
import { realTimers } from './platform'
import { readStorageScript, writeStorageScript } from './scripts'
import { SurfaceToolPage } from './tool-page'
import { cleanChromeUserAgent, type UserAgentMode } from './user-agent'

/**
 * A request the tool partition cancelled. Tool code chooses what it asks for, so every field but
 * `reason` is untrusted: `target` is the origin only and `pathDigest` a hash, but a hostname can
 * still carry data, so a report must pass output redaction before it is written to the audit log.
 */
export interface BlockedRequest {
  /** The HTTP method, or CONNECT for a socket the proxy refused. */
  readonly method: string
  /** The origin (scheme, host and port), never the path or query. */
  readonly target: string
  /** A short digest of the path, or null when there is none, e.g. for a refused CONNECT. */
  readonly pathDigest: string | null
  readonly resourceType: string
  readonly reason: BlockReason
}

export interface DriverOptions {
  readonly adapterId: string
  /** Where the tool page opens on first use. */
  readonly home: string
  /** Origins the auth partition's main frame may be on. */
  readonly navigation: readonly string[]
  /** Hosts the tool partition may send requests to. */
  readonly egress: readonly string[]
  /** The manifest's request surface. Without it, the tool partition makes no API call at all. */
  readonly requests?: readonly RequestDeclaration[]
  /** API calls allowed per run, counted from beginRun(). The manifest's default is 50. */
  readonly requestsPerRun?: number
  /** Ports the tool partition may open connections to on egress hosts. Defaults to 443. */
  readonly egressPorts?: readonly number[]
  /**
   * Origins auth-partition subframes may load, besides the navigation origins. Unset, a subframe
   * may load any https page; see guards.ts.
   */
  readonly frameOrigins?: readonly string[]
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

export type ManifestOptions = Omit<
  DriverOptions,
  'adapterId' | 'home' | 'navigation' | 'egress' | 'requests' | 'requestsPerRun'
>

const DEFAULT_STEP_TIMEOUT_MS = 30_000
const DEFAULT_TYPING_DELAY_MS = 60
const DEFAULT_REQUESTS_PER_RUN = 50
const DEFAULT_EGRESS_PORTS: readonly number[] = [443]

/** What the tool partition allows right now. Between runs, a read tool's allowance. */
interface RunState {
  readonly sideEffect: Purpose
  requests: number
}

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
      requests: manifest.requests,
      requestsPerRun: manifest.limits.requestsPerRun,
    })
  }

  private readonly partitions: Readonly<Record<Role, string>>
  private readonly configured = new Map<Role, Promise<PartitionSession>>()
  private proxy: Promise<ProxyHandle> | null = null
  private run: RunState = { sideEffect: 'read', requests: 0 }
  private readonly timing: PageTiming
  private readonly authPages = new Map<BrowserSurface, SurfaceAuthPage>()
  private readonly helpers = new Set<BrowserSurface>()
  private tool: ToolSlot | null = null

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

  /**
   * Starts a tool run: the API-call count starts again from zero, and declarations up to
   * `sideEffect` become usable. Not yet on core's SessionDriver; the runtime calls it around run().
   */
  beginRun(sideEffect: Purpose): void {
    this.run = { sideEffect, requests: 0 }
  }

  /** Ends a run: back to a read tool's allowance, with a fresh count. */
  endRun(): void {
    this.run = { sideEffect: 'read', requests: 0 }
  }

  async openAuthPage(): Promise<AuthPage> {
    const surface = await this.open('auth')
    const page = this.authPage(surface)
    this.authPages.set(surface, page)
    surface.onDestroyed(() => this.authPages.delete(surface))
    return page
  }

  toolPage(): Promise<ToolPage> {
    const current = this.tool
    if (current !== null && (current.surface === null || !current.surface.isDestroyed())) return current.page
    const slot: ToolSlot = { surface: null, page: Promise.resolve(null as never) }
    slot.page = this.open('tool').then(async (surface) => {
      slot.surface = surface
      const page = new SurfaceToolPage(surface, this.options.egress, this.timing)
      try {
        await page.goto(this.options.home)
      } catch (error) {
        surface.destroy()
        throw error
      }
      return page
    })
    this.tool = slot
    // A partition that failed to open leaves no window, so the next call must start again.
    slot.page.catch(() => {
      if (this.tool === slot && slot.surface === null) this.tool = null
    })
    return slot.page
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
    const auth = await this.session('auth')
    const tool = await this.session('tool')
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
      const tool = await this.session('tool')
      cookies = cookiesForDomains(await tool.getCookies(), cookieDomains)
    } catch {
      throw new SiteAdapterError('session-handoff', 'internal')
    }
    return [...new Set(cookies.map((cookie) => cookie.value).filter((value) => value.length > 0))]
  }

  /** Closes every window this driver opened, and the tool partition's proxy. */
  async close(): Promise<void> {
    const surfaces = [...this.authPages.keys(), ...this.helpers]
    if (this.tool?.surface) surfaces.push(this.tool.surface)
    for (const surface of surfaces) if (!surface.isDestroyed()) surface.destroy()
    this.authPages.clear()
    this.helpers.clear()
    this.tool = null
    const proxy = this.proxy
    this.proxy = null
    // The tool partition is set up again, with a new proxy, when a page next opens in it.
    this.configured.delete('tool')
    if (proxy !== null) await proxy.then((handle) => handle.close()).catch(() => {})
  }

  private authPage(surface: BrowserSurface): SurfaceAuthPage {
    const frames = this.options.frameOrigins
    return new SurfaceAuthPage(surface, this.options.navigation, this.timing, frames ?? 'any-https')
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
    let surface: BrowserSurface | null = null
    try {
      surface = await this.open(role)
      this.helpers.add(surface)
      const url = new URL(this.options.storageDocumentPath ?? '/robots.txt', origin).href
      const page =
        role === 'auth'
          ? this.authPage(surface)
          : new SurfaceToolPage(surface, this.options.egress, this.timing)
      await page.goto(url)
      if (surface.frames()[0]?.origin !== wanted)
        throw new SiteAdapterError('session-handoff', 'origin-mismatch')
      return await this.runIn(surface, use)
    } catch (error) {
      if (error instanceof SiteAdapterError && error.stage === 'session-handoff') throw error
      throw new SiteAdapterError('session-handoff', 'unavailable')
    } finally {
      if (surface !== null) {
        this.helpers.delete(surface)
        if (!surface.isDestroyed()) surface.destroy()
      }
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
    const surface = this.tool?.surface
    return surface && !surface.isDestroyed() ? [surface] : []
  }

  private async open(role: Role): Promise<BrowserSurface> {
    await this.session(role)
    return this.platform.openSurface(this.partitions[role])
  }

  /** The partition's session, hardened and guarded before any page opens in it. */
  private session(role: Role): Promise<PartitionSession> {
    let configured = this.configured.get(role)
    if (configured === undefined) {
      configured = this.configure(role)
      this.configured.set(role, configured)
      // A set-up that failed is tried again next time rather than remembered.
      configured.catch(() => {
        if (this.configured.get(role) === configured) this.configured.delete(role)
      })
    }
    return configured
  }

  private async configure(role: Role): Promise<PartitionSession> {
    try {
      return await this.configureUnchecked(role)
    } catch (error) {
      if (error instanceof SiteAdapterError) throw error
      throw new SiteAdapterError(role === 'tool' ? 'egress' : 'navigate', 'internal')
    }
  }

  private async configureUnchecked(role: Role): Promise<PartitionSession> {
    const session = this.platform.session(this.partitions[role])
    session.harden()
    if (this.options.userAgent === 'chrome') {
      session.setUserAgent(cleanChromeUserAgent(this.platform.chromeVersion, this.platform.os))
    }
    if (role === 'tool') {
      session.filterRequests((request) => this.allowToolRequest(request))
      // Stops the page resolving hostnames it only links to: a hostname can carry data out
      // through DNS without any request that webRequest would see.
      session.addResponseHeader('X-DNS-Prefetch-Control', 'off')
      await session.useProxy(await this.startProxy())
    }
    return session
  }

  private startProxy(): Promise<ProxyHandle> {
    const { egress, egressPorts = DEFAULT_EGRESS_PORTS } = this.options
    const proxy = this.platform.startProxy((host, port) => {
      if (hostAllowed(host, egress) && egressPorts.includes(port)) return true
      this.report({
        method: 'CONNECT',
        target: requestTarget(`https://${host}:${port}`),
        pathDigest: null,
        resourceType: 'socket',
        reason: 'host-not-allowed',
      })
      return false
    })
    this.proxy = proxy
    return proxy.catch(() => {
      throw new SiteAdapterError('egress', 'unavailable')
    })
  }

  /** The tool partition's filter: egress, the request surface, then the per-run ceiling. */
  private allowToolRequest(request: OutgoingRequest): boolean {
    const decision = decideToolRequest(request, {
      egress: this.options.egress,
      requests: this.options.requests ?? [],
      sideEffect: this.run.sideEffect,
    })
    let reason: BlockReason | null = decision.allowed ? null : decision.reason
    if (decision.allowed && decision.counts) {
      this.run.requests++
      if (this.run.requests > (this.options.requestsPerRun ?? DEFAULT_REQUESTS_PER_RUN)) {
        reason = 'request-ceiling'
      }
    }
    if (reason === null) return true
    this.report({
      method: /^[A-Z]{1,16}$/i.test(request.method) ? request.method.toUpperCase() : 'INVALID',
      target: requestTarget(request.url),
      pathDigest: pathDigest(request.url),
      resourceType: request.resourceType,
      reason,
    })
    return false
  }

  private report(blocked: BlockedRequest): void {
    try {
      this.options.onBlocked?.(blocked)
    } catch {
      // A failing reporter must not turn a block into an allow.
    }
  }
}

interface ToolSlot {
  /** Null until the partition is set up and the window exists. */
  surface: BrowserSurface | null
  page: Promise<SurfaceToolPage>
}
