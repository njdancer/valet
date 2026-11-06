// The session driver: one site's auth and tool partitions, the pages in them, the one-way handoff
// between them, and the tool partition's network policy for each run. Written against
// BrowserPlatform; src/electron supplies the real one.

import {
  type AdapterManifest,
  type AuthPage,
  type BlockedRequest,
  hostAllowed,
  httpsOrigin,
  isBareOrigin,
  originAllowed,
  type RequestDeclaration,
  type SessionDriver,
  SiteAdapterError,
  type ToolPage,
  type ToolRunPolicy,
} from '@siteadapter/core'
import { SurfaceAuthPage } from './auth-page'
import { cookieSetDetails, cookiesForDomains } from './cookies'
import { authNavigationAllowed, type BlockReason, decideToolRequest, requestTarget } from './guards'
import { isRecord, type PageTiming } from './page-core'
import { partitionName } from './partitions'
import type {
  BrowserPlatform,
  BrowserSurface,
  CookieRecord,
  FrameHandle,
  KeyEvents,
  OutgoingRequest,
  PartitionSession,
  ProxyHandle,
  Role,
  Timers,
} from './platform'
import { realTimers } from './platform'
import { readStorageScript, writeStorageScript } from './scripts'
import { withTimeout } from './timeout'
import { SurfaceToolPage } from './tool-page'
import {
  type ClientHintBrands,
  chromeUserAgentOverride,
  cleanChromeUserAgent,
  LANGUAGES,
  type UserAgentMode,
} from './user-agent'

export interface DriverOptions {
  readonly adapterId: string
  /** The manifest's name, for the hand-off window's title. */
  readonly siteName?: string
  /** Where the tool page opens on first use. */
  readonly home: string
  /** Origins the auth partition's main frame may be on. */
  readonly navigation: readonly string[]
  /** Hosts the tool partition may send requests to. A run's policy can narrow this, never widen it. */
  readonly egress: readonly string[]
  /**
   * The manifest's request surface. Between runs, only its read declarations are usable; without
   * it, the tool partition makes no API call at all between runs.
   */
  readonly requests?: readonly RequestDeclaration[]
  /** Navigations and API calls allowed between runs, counted from the last endRun(). Defaults to 50. */
  readonly requestsPerRun?: number
  /**
   * Requests for a page's assets (images, scripts, styles, fonts, media) allowed per run, and
   * between runs. Page script picks a request's type, so these are capped too, if more loosely:
   * by default 100 for each request the ceiling allows, and never fewer than 1000.
   */
  readonly assetsPerRun?: number
  /** Ports the tool partition may open connections to on egress hosts. Defaults to 443. */
  readonly egressPorts?: readonly number[]
  /** The manifest's auth.frameOrigins: origins besides navigation's that auth subframes may load. */
  readonly frameOrigins?: readonly string[]
  /**
   * The clean Chrome UA with en-AU (the default), set on each partition and, so that
   * navigator.language follows, on each page over the DevTools protocol; or Electron's own, with
   * nothing overridden.
   */
  readonly userAgent?: UserAgentMode
  /**
   * Client-hint brands (D24a, undecided). `engine`, the default, restates what Chromium reports
   * itself. `chrome` also names Google Chrome, as Nick's own Chrome does. Only with the chrome user
   * agent. Electron sends no Sec-CH-UA header either way; this is navigator.userAgentData.
   */
  readonly clientHints?: ClientHintBrands
  /**
   * The key events each typed character sends. `char`, the default, sends one char event; `full`
   * sends keyDown, char and keyUp, as a keyboard does. Which one sites prefer is Nick's call.
   */
  readonly keyEvents?: KeyEvents
  readonly stepTimeoutMs?: number
  readonly typingDelayMs?: number
  /**
   * Path of a light document on each storage origin, loaded only when the storage handoff needs a
   * page on that origin and none is open. Its own content doesn't matter; its origin does.
   */
  readonly storageDocumentPath?: string
  /** Where requests blocked between runs are reported. During a run, beginRun's reporter is used. */
  readonly onBlocked?: (blocked: BlockedRequest) => void
  readonly timers?: Timers
}

export type ManifestOptions = Omit<
  DriverOptions,
  'adapterId' | 'siteName' | 'home' | 'navigation' | 'egress' | 'requests' | 'requestsPerRun' | 'frameOrigins'
>

const DEFAULT_STEP_TIMEOUT_MS = 30_000
const DEFAULT_TYPING_DELAY_MS = 60
const DEFAULT_REQUESTS_PER_RUN = 50
const ASSETS_PER_REQUEST = 100
const MIN_ASSETS_PER_RUN = 1000
const DEFAULT_EGRESS_PORTS: readonly number[] = [443]

type StorageRequest = readonly { readonly origin: string; readonly keys: readonly string[] }[]

/** The policy the tool partition holds requests to right now, and what it has let through. */
interface RunState {
  readonly policy: ToolRunPolicy
  readonly onBlocked: ((blocked: BlockedRequest) => void) | undefined
  readonly inRun: boolean
  irreversibleUnlocked: boolean
  /** Toward the policy's ceiling. */
  counted: number
  /** Toward the asset budget. */
  assets: number
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
      siteName: manifest.name,
      home: manifest.home,
      navigation: manifest.navigation,
      egress: manifest.egress,
      requests: manifest.requests,
      requestsPerRun: manifest.limits.requestsPerRun,
      frameOrigins: manifest.auth.frameOrigins,
    })
  }

  private readonly partitions: Readonly<Record<Role, string>>
  private readonly configured = new Map<Role, Promise<PartitionSession>>()
  private proxy: Promise<ProxyHandle> | null = null
  private run: RunState
  /** Requests tool code announced through the capability API, by method and URL. */
  private readonly announced = new Map<string, number>()
  /** Storage values this driver handed off, by origin then key, for sessionSecrets(). */
  private readonly handedOff = new Map<string, Map<string, string>>()
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
      keyEvents: options.keyEvents ?? 'char',
    }
    this.run = this.betweenRuns()
  }

  /**
   * Starts a tool run: from now until endRun(), every request the tool partition makes is held to
   * `policy`, and each one refused is reported to `onBlocked`. The count toward the ceiling starts
   * again from zero, and irreversible declarations stay refused until unlockIrreversible().
   */
  beginRun(policy: ToolRunPolicy, onBlocked: (request: BlockedRequest) => void): void {
    this.run = { policy, onBlocked, inRun: true, irreversibleUnlocked: false, counted: 0, assets: 0 }
  }

  /** Only after the person approved this run in the app. No effect outside an irreversible run. */
  unlockIrreversible(): void {
    if (this.run.inRun && this.run.policy.maxPurpose === 'irreversible') this.run.irreversibleUnlocked = true
  }

  /** Ends a run: back to the between-runs policy, with a fresh count. */
  endRun(): void {
    this.run = this.betweenRuns()
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
      const page = this.toolPageOn(surface)
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
  async handoff(cookieDomains: readonly string[], storage: StorageRequest): Promise<void> {
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

  /**
   * Values tool output must never contain: the tool partition's cookie values on `cookieDomains`,
   * the storage values this driver handed off, and those keys' current values in an open tool page
   * on the origin (the site may have rotated them). It opens no page to look: tool code can only
   * read storage through a tool page, and if none is open on the origin there is nothing newer.
   */
  async sessionSecrets(
    cookieDomains: readonly string[],
    storage: StorageRequest,
  ): Promise<readonly string[]> {
    const values = new Set<string>()
    for (const cookie of await this.toolCookies(cookieDomains)) values.add(cookie.value)
    for (const { origin, keys } of storage) {
      const wanted = httpsOrigin(origin)
      if (wanted === null || !isBareOrigin(origin)) throw new SiteAdapterError('session-handoff', 'invalid')
      const remembered = this.handedOff.get(wanted)
      for (const key of keys) {
        const value = remembered?.get(key)
        if (value !== undefined) values.add(value)
      }
      const open = this.openSurfaces('tool').find((surface) => surface.frames()[0]?.origin === wanted)
      if (open === undefined) continue
      const raw = await this.runIn(open, (frame) => frame.run(readStorageScript(keys)))
      if (!isRecord(raw)) throw new SiteAdapterError('session-handoff', 'internal')
      for (const key of keys) {
        const value = raw[key]
        if (typeof value === 'string') values.add(value)
      }
    }
    return [...values].filter((value) => value.length > 0)
  }

  /** Names, never values, of the tool partition's cookies on `cookieDomains`. */
  async cookieNames(cookieDomains: readonly string[]): Promise<readonly string[]> {
    return [...new Set((await this.toolCookies(cookieDomains)).map((cookie) => cookie.name))]
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

  /** Between runs: the egress list, read declarations only, and the per-run ceiling. */
  private betweenRuns(): RunState {
    return {
      policy: {
        egress: this.options.egress,
        requests: (this.options.requests ?? []).filter((declaration) => declaration.purpose === 'read'),
        maxPurpose: 'read',
        ceiling: this.options.requestsPerRun ?? DEFAULT_REQUESTS_PER_RUN,
      },
      onBlocked: this.options.onBlocked,
      inRun: false,
      irreversibleUnlocked: false,
      counted: 0,
      assets: 0,
    }
  }

  private async toolCookies(cookieDomains: readonly string[]): Promise<CookieRecord[]> {
    try {
      const tool = await this.session('tool')
      return cookiesForDomains(await tool.getCookies(), cookieDomains)
    } catch {
      throw new SiteAdapterError('session-handoff', 'internal')
    }
  }

  private authPage(surface: BrowserSurface): SurfaceAuthPage {
    return new SurfaceAuthPage(surface, this.options.navigation, this.timing, {
      frameOrigins: this.options.frameOrigins ?? [],
      siteName: this.options.siteName ?? this.options.adapterId,
    })
  }

  private toolPageOn(surface: BrowserSurface): SurfaceToolPage {
    return new SurfaceToolPage(surface, this.options.egress, this.timing, (method, url) =>
      this.announce(method, url),
    )
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
    const wanted = httpsOrigin(origin) ?? origin
    const remembered = this.handedOff.get(wanted) ?? new Map<string, string>()
    for (const [key, value] of entries) remembered.set(key, value)
    this.handedOff.set(wanted, remembered)
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
      const page = role === 'auth' ? this.authPage(surface) : this.toolPageOn(surface)
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
    const surface = this.platform.openSurface(this.partitions[role])
    if (this.options.userAgent === 'electron') return surface
    try {
      const { chromeVersion, os, systemVersion, arch } = this.platform
      const brands = this.options.clientHints ?? 'engine'
      const override = chromeUserAgentOverride({ chromeVersion, os, systemVersion, arch }, brands)
      await withTimeout(this.timing.timers, this.timing.stepTimeoutMs, () =>
        surface.overrideUserAgent(override),
      )
    } catch (error) {
      surface.destroy()
      if (error instanceof SiteAdapterError) throw error
      throw new SiteAdapterError(role === 'tool' ? 'egress' : 'navigate', 'internal')
    }
    return surface
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
    if (this.options.userAgent !== 'electron') {
      const userAgent = cleanChromeUserAgent(this.platform.chromeVersion, this.platform.os)
      session.setUserAgent(userAgent, LANGUAGES)
    }
    if (role === 'auth') {
      // will-frame-navigate is the first line for subframes; this holds the frames it doesn't
      // report, such as an iframe's first load, to the same rule at the network layer.
      const frameOrigins = this.options.frameOrigins ?? []
      session.filterRequests(
        (request) =>
          request.resourceType !== 'subFrame' ||
          authNavigationAllowed(
            { url: request.url, isMainFrame: false },
            this.options.navigation,
            frameOrigins,
          ),
      )
      return session
    }
    session.filterRequests((request) => this.allowToolRequest(request))
    // Stops the page resolving hostnames it only links to: a hostname can carry data out
    // through DNS without any request that webRequest would see.
    session.addResponseHeader('X-DNS-Prefetch-Control', 'off')
    await session.useProxy(await this.startProxy())
    return session
  }

  private startProxy(): Promise<ProxyHandle> {
    const { egress, egressPorts = DEFAULT_EGRESS_PORTS } = this.options
    const proxy = this.platform.startProxy((host, port) => {
      const run = this.run
      if (hostAllowed(host, egress) && hostAllowed(host, run.policy.egress) && egressPorts.includes(port)) {
        return true
      }
      // Sockets come from page script (WebRTC, WebTransport): tool code can't open one through
      // the capability API.
      this.report(run, {
        method: 'CONNECT',
        target: requestTarget(`https://${host}:${port}`, false),
        reason: 'host-not-allowed',
        initiator: 'page',
      })
      return false
    })
    this.proxy = proxy
    return proxy.catch(() => {
      throw new SiteAdapterError('egress', 'unavailable')
    })
  }

  /** The tool partition's filter: the run's policy, then its ceiling or its asset budget. */
  private allowToolRequest(request: OutgoingRequest): boolean {
    const run = this.run
    const decision = decideToolRequest(
      request,
      run.policy,
      this.options.egress,
      run.irreversibleUnlocked,
      this.options.requests ?? [],
    )
    let reason: BlockReason | null = decision.allowed ? null : decision.reason
    if (decision.allowed && decision.counts === 'request') {
      if (run.counted >= ceilingOf(run.policy)) reason = 'request-ceiling'
      else run.counted++
    }
    if (decision.allowed && decision.counts === 'asset') {
      if (run.assets >= this.assetBudget(run.policy)) reason = 'request-ceiling'
      else run.assets++
    }
    if (reason === null) return true
    this.report(run, {
      method: /^[A-Z]{1,16}$/i.test(request.method) ? request.method.toUpperCase() : 'INVALID',
      target: requestTarget(request.url, reason !== 'host-not-allowed' && reason !== 'bad-url'),
      reason,
      initiator: this.announced.has(announcementKey(request.method, request.url)) ? 'tool' : 'page',
    })
    return false
  }

  private assetBudget(policy: ToolRunPolicy): number {
    const configured = this.options.assetsPerRun
    if (configured !== undefined) return Number.isInteger(configured) && configured >= 0 ? configured : 0
    return Math.max(MIN_ASSETS_PER_RUN, ceilingOf(policy) * ASSETS_PER_REQUEST)
  }

  /**
   * Records that tool code asked for this request through the capability API. Anything else, the
   * site's scripts and adapter code in evaluate() alike, is reported as the page's: webRequest
   * can't tell them apart.
   */
  private announce(method: string, url: string): () => void {
    const key = announcementKey(method, url)
    this.announced.set(key, (this.announced.get(key) ?? 0) + 1)
    let withdrawn = false
    return () => {
      if (withdrawn) return
      withdrawn = true
      const left = (this.announced.get(key) ?? 1) - 1
      if (left > 0) this.announced.set(key, left)
      else this.announced.delete(key)
    }
  }

  private report(run: RunState, blocked: BlockedRequest): void {
    try {
      run.onBlocked?.(blocked)
    } catch {
      // A failing reporter must not turn a block into an allow.
    }
  }
}

/** A usable ceiling: anything that isn't a whole, non-negative number allows nothing. */
function ceilingOf(policy: ToolRunPolicy): number {
  return Number.isInteger(policy.ceiling) && policy.ceiling >= 0 ? policy.ceiling : 0
}

/** Method and URL without the fragment, which never reaches the network. */
function announcementKey(method: string, url: string): string {
  return `${method.toUpperCase()} ${url.split('#')[0]}`
}

interface ToolSlot {
  /** Null until the partition is set up and the window exists. */
  surface: BrowserSurface | null
  page: Promise<SurfaceToolPage>
}
