// The session driver: one site's auth and tool partitions, the pages in them, the one-way handoff
// between them, and the tool partition's network policy for each run. Written against
// BrowserPlatform; src/electron supplies the real one.

import {
  type AdapterManifest,
  type AuthPage,
  type AuthPageOptions,
  type BlockedRequest,
  hostAllowed,
  httpsOrigin,
  isBareOrigin,
  originAllowed,
  type RequestDeclaration,
  type SessionDriver,
  type SiteWatcher,
  type ToolPage,
  type ToolRunPolicy,
  urlOriginAllowed,
  ValetError,
} from '@valet/core'
import { SurfaceAuthPage } from './auth-page'
import { cookieSetDetails, cookiesForDomains } from './cookies'
import {
  authBlock,
  authNavigationAllowed,
  type BlockReason,
  decideToolRequest,
  requestTarget,
  siteRefusal,
} from './guards'
import { isRecord, type PageTiming } from './page-core'
import { partitionName, trialPartitionName } from './partitions'
import type {
  BrowserPlatform,
  BrowserSurface,
  CookieRecord,
  FrameHandle,
  HeaderList,
  KeyEvents,
  ObservedResponse,
  OutgoingRequest,
  PartitionSession,
  ProxyHandle,
  Role,
  Timers,
} from './platform'
import { realTimers } from './platform'
import { readStorageScript, writeStorageScript } from './scripts'
import { SessionValues } from './session-values'
import { withTimeout } from './timeout'
import { SurfaceToolPage } from './tool-page'
import {
  type ClientHintBrands,
  chromeUserAgentOverride,
  cleanChromeUserAgent,
  LANGUAGES,
  pageIdentityHeaders,
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
   * The clean Chrome UA with en-AU (the default), set on each partition, as the process default
   * (for service workers), and, so that navigator.language follows, on each page and every worker
   * and out-of-process frame it starts, over the DevTools protocol; or Electron's own, with nothing
   * overridden. The process default is process-wide: once any driver has set it, a driver with
   * Electron's own UA gets the clean one in its service workers too.
   */
  readonly userAgent?: UserAgentMode
  /**
   * Client-hint brands (D24a). `chrome`, the default, also names Google Chrome, as a real Chrome
   * does, so the hints agree with the Chrome user agent. `engine` restates only what Chromium
   * reports itself. Only with the chrome user agent. Electron sends no Sec-CH-UA header either way; this is navigator.userAgentData.
   */
  readonly clientHints?: ClientHintBrands
  /**
   * The key events each typed character sends. `full`, the default, sends keyDown, char and keyUp,
   * as a keyboard does (D38); `char` sends one char event.
   */
  readonly keyEvents?: KeyEvents
  readonly stepTimeoutMs?: number
  readonly typingDelayMs?: number
  /** Up to this much is added to each typing gap, drawn per keystroke. Default 80 ms. */
  readonly typingJitterMs?: number
  /** A uniform draw in [0, 1) for the typing jitter. Defaults to Math.random. */
  readonly random?: () => number
  /**
   * Path of a light document on each storage origin, loaded only when the storage handoff needs a
   * page on that origin and none is open. Its own content doesn't matter; its origin does.
   */
  readonly storageDocumentPath?: string
  /** Where requests blocked between runs are reported. During a run, beginRun's reporter is used. */
  readonly onBlocked?: (blocked: BlockedRequest) => void
  /**
   * Where the auth partition's refused navigations are reported (initiator 'page'), unless the auth
   * page they belong to was opened with a reporter of its own: the main frame leaving the
   * navigation origins, and subframes off navigation and frameOrigins.
   */
  readonly onAuthBlocked?: (blocked: BlockedRequest) => void
  /**
   * Called once for each reporter that onAuthBlocked stands in for, the first time a refusal is
   * not reported because that reporter's budget is spent (see AuthPageRequest.onBlocked). The
   * refusal itself still holds.
   */
  readonly onAuthReportsDropped?: () => void
  readonly timers?: Timers
  /**
   * A draft's live trial (docs/authoring-tools.md#live-trials): both partitions in memory, named by
   * this label, in place of the adapter's persistent ones, so nothing the trial does reaches or
   * outlives the installed adapter's session. Each trial its own label.
   */
  readonly trialLabel?: string
  /**
   * A signed-in trial (docs/authoring-tools.md#signed-in-authoring-sessions-pr-3): the installed
   * adapter's tool-partition cookies on these domains are copied into the trial's tool partition
   * when it is set up, one way, so the trial is signed in and nothing it does reaches the live
   * partition. Only with trialLabel. The values join the ones tool output must never contain.
   */
  readonly trialSession?: { readonly adapterId: string; readonly cookieDomains: readonly string[] }
}

/** What openAuthPage() may be given: core's AuthPageOptions, with the driver's reporting rules. */
export interface AuthPageRequest extends AuthPageOptions {
  /**
   * Told about the auth partition's refused navigations while this page is open, in place of
   * DriverOptions.onAuthBlocked: its own frames' refused navigations, and the partition's
   * request-filter refusals while it is the newest open auth page with a reporter. Each distinct
   * refusal once, up to MAX_AUTH_REPORTS_PER_PAGE subframe refusals and, counted apart so that
   * widgets can't spend it, MAX_AUTH_ESCAPES_PER_PAGE main-frame escapes.
   */
  readonly onBlocked?: (blocked: BlockedRequest) => void
  /** Called once, the first time one of this page's refusals goes unreported for the budget. */
  readonly onReportsDropped?: () => void
}

export type ManifestOptions = Omit<
  DriverOptions,
  'adapterId' | 'siteName' | 'home' | 'navigation' | 'egress' | 'requests' | 'requestsPerRun' | 'frameOrigins'
>

const DEFAULT_STEP_TIMEOUT_MS = 30_000
const DEFAULT_TYPING_DELAY_MS = 60
const DEFAULT_TYPING_JITTER_MS = 80
const DEFAULT_REQUESTS_PER_RUN = 50
const ASSETS_PER_REQUEST = 100
const MIN_ASSETS_PER_RUN = 1000
const DEFAULT_EGRESS_PORTS: readonly number[] = [443]
/** Distinct subframe refusals reported per auth page; a page whose widgets are all refused is chatty. */
const MAX_AUTH_REPORTS_PER_PAGE = 200
/**
 * Distinct main-frame escapes reported per auth page, budgeted apart from subframes so that no
 * number of refused widgets can keep an escape out of the audit. The first escape poisons the page;
 * this only bounds a poisoned page that keeps trying.
 */
const MAX_AUTH_ESCAPES_PER_PAGE = 50
/** Main-frame request ids remembered for redirects; navigations don't overlap by the hundred. */
const MAX_REMEMBERED_NAVIGATIONS = 200
/** How long after a tool click its navigation may start and still count as already paced. */
const CLICK_GRACE_MS = 2_000

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
  /** Every value the session's cookies and storage keys have held in the tool partition. */
  private readonly values = new SessionValues()
  /** Storage reads beginRun() and endRun() started, which sessionSecrets() waits for. */
  private readonly snapshots = new Set<Promise<void>>()
  private readonly timing: PageTiming
  private readonly authPages = new Map<BrowserSurface, SurfaceAuthPage>()
  /** Each auth page's reporter and what it has already been told, newest page last. No helpers. */
  private readonly authReports = new Map<BrowserSurface, AuthReports>()
  /** onAuthBlocked's, for refusals no open page's reporter takes. Fresh after close(). */
  private fallbackReports: AuthReports
  /** Refusals that went unreported because their reporter's budget was spent. */
  private droppedReports = 0
  private readonly helpers = new Set<BrowserSurface>()
  private tool: ToolSlot | null = null
  /** The site's breaker, once the runtime has connected it (watchSite). */
  private watcher: SiteWatcher | null = null
  /** Main-frame request ids already paced or let through, so a redirect's next hop isn't paced. */
  private readonly navigations = new Set<number>()
  /** Until when (epoch ms) the next main-frame navigation counts as a tool click's, already paced. */
  private clickPacedUntil = 0

  constructor(
    private readonly platform: BrowserPlatform,
    private readonly options: DriverOptions,
  ) {
    this.partitions =
      options.trialLabel === undefined
        ? { auth: partitionName('auth', options.adapterId), tool: partitionName('tool', options.adapterId) }
        : {
            auth: trialPartitionName('auth', options.trialLabel),
            tool: trialPartitionName('tool', options.trialLabel),
          }
    this.timing = {
      timers: options.timers ?? realTimers,
      stepTimeoutMs: options.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS,
      typingDelayMs: options.typingDelayMs ?? DEFAULT_TYPING_DELAY_MS,
      keyEvents: options.keyEvents ?? 'full',
      typingJitterMs: options.typingJitterMs ?? DEFAULT_TYPING_JITTER_MS,
      ...(options.random === undefined ? {} : { random: options.random }),
    }
    this.run = this.betweenRuns()
    this.fallbackReports = this.newFallbackReports()
  }

  /**
   * Starts a tool run: from now until endRun(), every request the tool partition makes is held to
   * `policy`, and each one refused is reported to `onBlocked`. The count toward the ceiling starts
   * again from zero, and irreversible declarations stay refused until unlockIrreversible().
   */
  beginRun(policy: ToolRunPolicy, onBlocked: (request: BlockedRequest) => void): void {
    this.snapshotStorage()
    this.run = { policy, onBlocked, inRun: true, irreversibleUnlocked: false, counted: 0, assets: 0 }
  }

  /**
   * Connects the site's breaker (D55): block signatures in either partition are reported to it,
   * and while it holds, the tool partition sends nothing.
   */
  watchSite(watcher: SiteWatcher): void {
    this.watcher = watcher
  }

  /** Only after the person approved this run in the app. No effect outside an irreversible run. */
  unlockIrreversible(): void {
    if (this.run.inRun && this.run.policy.maxPurpose === 'irreversible') this.run.irreversibleUnlocked = true
  }

  /** Ends a run: back to the between-runs policy, with a fresh count. */
  endRun(): void {
    this.snapshotStorage()
    this.run = this.betweenRuns()
  }

  /**
   * Opens a page in the auth partition. `request.onBlocked` gets this page's refused navigations
   * instead of DriverOptions.onAuthBlocked (see AuthPageRequest); core's SessionDriver contract
   * passes nothing.
   */
  async openAuthPage(request: AuthPageRequest = {}): Promise<AuthPage> {
    const surface = await this.open('auth')
    const page = await this.authPage(surface, request)
    this.authPages.set(surface, page)
    surface.onDestroyed(() => {
      this.authPages.delete(surface)
      this.authReports.delete(surface)
    })
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
      for (const cookie of cookies) {
        this.values.cookie(cookie)
        await tool.setCookie(cookieSetDetails(cookie))
      }
    } catch {
      throw new ValetError('session-handoff', 'internal')
    }
    for (const { origin, keys } of storage) await this.copyStorage(origin, keys)
  }

  /**
   * Values tool output must never contain. Not a snapshot, since tool code can read a value and
   * then overwrite or expire it before this is called: the tool partition's cookie values on
   * `cookieDomains` now, every value they held before (handed off, or seen in a cookie change
   * event, removals included), every value the storage keys held (handed off, written by a tool
   * page, or read at beginRun() and endRun()), and the keys' current values in an open tool page on
   * the origin. It opens no page to look: tool code can only reach storage through a tool page.
   * Each cookie and key keeps its 16 most recent values.
   */
  async sessionSecrets(
    cookieDomains: readonly string[],
    storage: StorageRequest,
  ): Promise<readonly string[]> {
    const values = new Set<string>()
    for (const cookie of await this.toolCookies(cookieDomains)) values.add(cookie.value)
    for (const value of this.values.cookieValues(cookieDomains)) values.add(value)
    await Promise.all([...this.snapshots])
    for (const { origin, keys } of storage) {
      const wanted = httpsOrigin(origin)
      if (wanted === null || !isBareOrigin(origin)) throw new ValetError('session-handoff', 'invalid')
      this.values.watch(wanted, keys)
      const open = this.openSurfaces('tool').find((surface) => surface.frames()[0]?.origin === wanted)
      if (open !== undefined) {
        try {
          await open.storageSettled()
        } catch {
          throw new ValetError('session-handoff', 'internal')
        }
        const raw = await this.runIn(open, (frame) => frame.run(readStorageScript(keys)))
        if (!isRecord(raw)) throw new ValetError('session-handoff', 'internal')
        for (const key of keys) {
          const value = raw[key]
          if (typeof value === 'string') values.add(value)
        }
      }
      for (const value of this.values.storageValues(wanted, keys)) values.add(value)
    }
    return [...values].filter((value) => value.length > 0)
  }

  /** Names, never values, of the tool partition's cookies on `cookieDomains`. */
  async cookieNames(cookieDomains: readonly string[]): Promise<readonly string[]> {
    return [...new Set((await this.toolCookies(cookieDomains)).map((cookie) => cookie.name))]
  }

  /** Closes every window this driver opened, and the tool partition's proxy. */
  /**
   * How many auth-partition refusals went unreported because their reporter's budget was spent,
   * since the driver was made. The refusals themselves held.
   */
  droppedAuthReports(): number {
    return this.droppedReports
  }

  async close(): Promise<void> {
    // Closing a page first cancels any probe it has in flight.
    for (const page of this.authPages.values()) await page.close()
    const surfaces = [...this.authPages.keys(), ...this.helpers]
    if (this.tool?.surface) surfaces.push(this.tool.surface)
    for (const surface of surfaces) if (!surface.isDestroyed()) surface.destroy()
    this.authPages.clear()
    this.authReports.clear()
    this.fallbackReports = this.newFallbackReports()
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
      throw new ValetError('session-handoff', 'internal')
    }
  }

  /**
   * The auth page on `surface`. A real one (openAuthPage's) reports to its own reporter and joins
   * authReports. A storage-handoff helper (`request` null) is left out of it: it never takes the
   * request filter's refusals, and its own go wherever the filter's would.
   */
  private async authPage(surface: BrowserSurface, request: AuthPageRequest | null): Promise<SurfaceAuthPage> {
    const session = await this.session('auth')
    let onBlocked: (blocked: BlockedRequest, context: { readonly mainFrame: boolean }) => void
    if (request === null) {
      onBlocked = (blocked, { mainFrame }) => this.reportAuthShared(blocked, mainFrame)
    } else {
      const reports = this.newReports(request.onBlocked, request.onReportsDropped)
      this.authReports.set(surface, reports)
      onBlocked = (blocked, { mainFrame }) => this.reportAuth(reports, blocked, mainFrame)
    }
    return new SurfaceAuthPage(surface, this.options.navigation, this.timing, {
      frameOrigins: this.options.frameOrigins ?? [],
      siteName: this.options.siteName ?? this.options.adapterId,
      session,
      identity: this.probeIdentity(),
      onBlocked,
    })
  }

  /** What the auth page's fetch() restates so that it presents as the page does. */
  private probeIdentity(): HeaderList {
    if (this.options.userAgent === 'electron') return []
    const { chromeVersion, os, systemVersion, arch } = this.platform
    const brands = this.options.clientHints ?? 'chrome'
    return pageIdentityHeaders(chromeUserAgentOverride({ chromeVersion, os, systemVersion, arch }, brands))
  }

  /** A page's reporter, falling back to onAuthBlocked when the page brought none. */
  private newReports(
    reporter: ((blocked: BlockedRequest) => void) | undefined,
    onDropped: (() => void) | undefined,
  ): AuthReports {
    if (reporter === undefined) return this.newFallbackReports()
    return { reporter, onDropped, seen: new Set(), escapes: new Set(), dropped: false }
  }

  private newFallbackReports(): AuthReports {
    return {
      reporter: this.options.onAuthBlocked,
      onDropped: this.options.onAuthReportsDropped,
      seen: new Set(),
      escapes: new Set(),
      dropped: false,
    }
  }

  /**
   * A refusal no single page owns: the request filter's, which can't tell which page asked, and a
   * handoff helper's. It goes to the newest open auth page that has a reporter, or to
   * onAuthBlocked when none has.
   */
  private reportAuthShared(blocked: BlockedRequest, mainFrame: boolean): void {
    const open = [...this.authReports.entries()].filter(
      ([surface, reports]) => !surface.isDestroyed() && reports.reporter !== undefined,
    )
    this.reportAuth(open[open.length - 1]?.[1] ?? this.fallbackReports, blocked, mainFrame)
  }

  /**
   * Tells `reports.reporter` about a refusal it hasn't heard of yet. A main-frame navigation reaches
   * the guard more than once (will-frame-navigate and will-navigate), and a page can retry, so each
   * distinct refusal is reported once per page. Escapes and subframes are counted apart, each up to
   * its own budget; past it, the first drop is announced once and every drop is counted.
   */
  private reportAuth(reports: AuthReports, blocked: BlockedRequest, mainFrame: boolean): void {
    if (reports.reporter === undefined) return
    const seen = mainFrame ? reports.escapes : reports.seen
    const budget = mainFrame ? MAX_AUTH_ESCAPES_PER_PAGE : MAX_AUTH_REPORTS_PER_PAGE
    const key = `${blocked.method} ${blocked.target} ${blocked.reason}`
    if (seen.has(key)) return
    if (seen.size >= budget) {
      this.droppedReports++
      if (!reports.dropped) {
        reports.dropped = true
        try {
          reports.onDropped?.()
        } catch {
          // A failing reporter must not turn a block into an allow.
        }
      }
      return
    }
    seen.add(key)
    try {
      reports.reporter(blocked)
    } catch {
      // A failing reporter must not turn a block into an allow.
    }
  }

  private toolPageOn(surface: BrowserSurface): SurfaceToolPage {
    return new SurfaceToolPage(
      surface,
      this.options.egress,
      this.timing,
      (method, url) => this.announce(method, url),
      () => {
        this.clickPacedUntil = Date.now() + CLICK_GRACE_MS
      },
      (method, url, reason) =>
        this.report(this.run, {
          method: /^[A-Z]{1,16}$/i.test(method) ? method.toUpperCase() : 'INVALID',
          // An allowed host's path may be kept like any declared request's; an off-list one is not.
          target: requestTarget(url, reason === 'page-policy'),
          reason,
          initiator: 'tool',
        }),
    )
  }

  private async copyStorage(origin: string, keys: readonly string[]): Promise<void> {
    if (!isBareOrigin(origin)) throw new ValetError('session-handoff', 'invalid')
    if (!originAllowed(origin, this.options.navigation)) {
      throw new ValetError('session-handoff', 'origin-mismatch')
    }
    const host = new URL(origin).hostname
    if (!hostAllowed(host, this.options.egress)) throw new ValetError('session-handoff', 'host-not-allowed')
    const wanted = httpsOrigin(origin) ?? origin
    // From now on a tool page's writes to these keys are recorded, the site's rotations included.
    this.values.watch(wanted, keys)
    const raw = await this.inDocument('auth', origin, (frame) => frame.run(readStorageScript(keys)))
    if (!isRecord(raw)) throw new ValetError('session-handoff', 'internal')
    const entries: [string, string][] = []
    for (const key of keys) {
      const value = raw[key]
      if (typeof value === 'string') entries.push([key, value])
    }
    if (entries.length === 0) return
    for (const [key, value] of entries) this.values.rememberStorage(wanted, key, value)
    await this.inDocument('tool', origin, (frame) => frame.run(writeStorageScript(entries)))
  }

  /**
   * Reads the watched storage keys in the open tool page, so a value already there when a run
   * starts (left from an earlier app session, say) is recorded before tool code can remove it.
   */
  private snapshotStorage(): void {
    const surface = this.openSurfaces('tool')[0]
    const origin = surface?.frames()[0]?.origin
    if (surface === undefined || origin === undefined) return
    const keys = this.values.watchedKeys(origin)
    if (keys.length === 0) return
    const read = this.runIn(surface, (frame) => frame.run(readStorageScript(keys))).then(
      (raw) => {
        if (!isRecord(raw)) return
        for (const key of keys) {
          const value = raw[key]
          if (typeof value === 'string') this.values.rememberStorage(origin, key, value)
        }
      },
      () => {},
    )
    this.snapshots.add(read)
    void read.finally(() => this.snapshots.delete(read))
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
      const page = role === 'auth' ? await this.authPage(surface, null) : this.toolPageOn(surface)
      await page.goto(url)
      if (surface.frames()[0]?.origin !== wanted) throw new ValetError('session-handoff', 'origin-mismatch')
      return await this.runIn(surface, use)
    } catch (error) {
      if (error instanceof ValetError && error.stage === 'session-handoff') throw error
      throw new ValetError('session-handoff', 'unavailable')
    } finally {
      if (surface !== null) {
        this.helpers.delete(surface)
        if (!surface.isDestroyed()) surface.destroy()
      }
    }
  }

  private async runIn<T>(surface: BrowserSurface, use: (frame: FrameHandle) => Promise<T>): Promise<T> {
    const frame = surface.frames()[0]
    if (frame === undefined) throw new ValetError('session-handoff', 'internal')
    try {
      return await use(frame)
    } catch {
      throw new ValetError('session-handoff', 'internal')
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
    try {
      if (this.options.userAgent !== 'electron') {
        const { chromeVersion, os, systemVersion, arch } = this.platform
        const brands = this.options.clientHints ?? 'chrome'
        const override = chromeUserAgentOverride({ chromeVersion, os, systemVersion, arch }, brands)
        await withTimeout(this.timing.timers, this.timing.stepTimeoutMs, () =>
          surface.overrideUserAgent(override),
        )
      }
      if (role === 'tool') {
        await withTimeout(this.timing.timers, this.timing.stepTimeoutMs, () =>
          surface.watchStorage((value) => this.values.storageValue(value)),
        )
      }
    } catch (error) {
      surface.destroy()
      if (error instanceof ValetError) throw error
      throw new ValetError(role === 'tool' ? 'egress' : 'navigate', 'internal')
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
      if (error instanceof ValetError) throw error
      throw new ValetError(role === 'tool' ? 'egress' : 'navigate', 'internal')
    }
  }

  private async configureUnchecked(role: Role): Promise<PartitionSession> {
    const session = this.platform.session(this.partitions[role])
    session.harden()
    if (this.options.userAgent !== 'electron') {
      const userAgent = cleanChromeUserAgent(this.platform.chromeVersion, this.platform.os)
      session.setUserAgent(userAgent, LANGUAGES)
      // A service worker starts with the process default, which no session or page override
      // reaches in time. This is process-wide: a driver with Electron's own UA doesn't undo it.
      this.platform.setDefaultUserAgent(userAgent)
    }
    session.watchResponses((response) => this.observe(role, response))
    if (role === 'auth') {
      // will-frame-navigate is the first line for subframes; this holds the frames it doesn't
      // report, such as an iframe's first load, to the same rule at the network layer.
      const frameOrigins = this.options.frameOrigins ?? []
      session.filterRequests((request) => {
        if (request.resourceType !== 'subFrame') return true
        const pending = { url: request.url, isMainFrame: false }
        if (authNavigationAllowed(pending, this.options.navigation, frameOrigins)) return true
        this.reportAuthShared(authBlock(request.url), false)
        return false
      })
      return session
    }
    session.filterRequests((request) => this.allowToolRequest(request))
    session.onCookieChanged((cookie) => this.values.cookie(cookie))
    const seed = this.options.trialSession
    if (seed !== undefined && this.options.trialLabel !== undefined) {
      const live = this.platform.session(partitionName('tool', seed.adapterId))
      try {
        for (const cookie of cookiesForDomains(await live.getCookies(), seed.cookieDomains)) {
          this.values.cookie(cookie)
          await session.setCookie(cookieSetDetails(cookie))
        }
      } catch {
        throw new ValetError('session-handoff', 'internal')
      }
    }
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
      throw new ValetError('egress', 'unavailable')
    })
  }

  /** Tells the site's breaker about a response that is the site refusing us. */
  private observe(role: Role, response: ObservedResponse): void {
    const watcher = this.watcher
    if (watcher === null) return
    const onSite =
      role === 'auth'
        ? (url: URL) => urlOriginAllowed(url.href, this.options.navigation)
        : (url: URL) => hostAllowed(url.hostname, this.options.egress)
    const refusal = siteRefusal(response, role, onSite)
    if (refusal === null) return
    try {
      watcher.refused(refusal)
    } catch {
      // The breaker's own failure must not break the page; the next refusal reports again.
    }
  }

  /** Whether the site's breaker is open. A watcher that fails holds, never lets through. */
  private held(): boolean {
    try {
      return this.watcher?.held() === true
    } catch {
      return true
    }
  }

  /**
   * The tool partition's filter: nothing while the site's breaker is open, then the run's policy,
   * then its ceiling or its asset budget. Requests held for the breaker are not reported one by
   * one: the breaker's opening is the audit event, and a page retrying would flood the log.
   */
  private allowToolRequest(request: OutgoingRequest): boolean | Promise<boolean> {
    if (this.held()) return false
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
    if (reason === null) return this.paceNavigation(request)
    this.report(run, {
      method: /^[A-Z]{1,16}$/i.test(request.method) ? request.method.toUpperCase() : 'INVALID',
      target: requestTarget(request.url, reason !== 'host-not-allowed' && reason !== 'bad-url'),
      reason,
      initiator: this.announced.has(announcementKey(request.method, request.url)) ? 'tool' : 'page',
    })
    return false
  }

  /**
   * Holds an allowed main-frame navigation for the site's budget (D55), whoever started it: the
   * page's own script, a form, a link. Not paced again: the next hop of a server redirect (the
   * chain is one navigation), tool code's goto() (the runtime paced it), and the first navigation
   * after a tool click (the runtime paced the click). Other requests follow from navigations and
   * are not paced; the run's ceiling bounds them.
   */
  private paceNavigation(request: OutgoingRequest): boolean | Promise<boolean> {
    const watcher = this.watcher
    if (request.resourceType !== 'mainFrame' || watcher?.pace === undefined) return true
    if (request.id !== undefined) {
      if (this.navigations.has(request.id)) return true
      this.navigations.add(request.id)
      if (this.navigations.size > MAX_REMEMBERED_NAVIGATIONS) {
        const oldest = this.navigations.values().next().value
        if (oldest !== undefined) this.navigations.delete(oldest)
      }
    }
    if (this.announced.has(announcementKey(request.method, request.url))) return true
    if (Date.now() < this.clickPacedUntil) {
      this.clickPacedUntil = 0
      return true
    }
    return Promise.resolve()
      .then(() => watcher.pace?.())
      .then(
        () => !this.held(),
        () => false,
      )
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

/** One reporter, and the refusals it has been told about. */
interface AuthReports {
  readonly reporter: ((blocked: BlockedRequest) => void) | undefined
  readonly onDropped: (() => void) | undefined
  /** Subframe refusals reported. */
  readonly seen: Set<string>
  /** Main-frame escapes reported, counted apart. */
  readonly escapes: Set<string>
  /** Whether onDropped has been called. */
  dropped: boolean
}

interface ToolSlot {
  /** Null until the partition is set up and the window exists. */
  surface: BrowserSurface | null
  page: Promise<SurfaceToolPage>
}
