// The scratch browser (docs/authoring-tools.md#the-scratch-browser-pr-2): one signed-out, in-memory
// browser per draft, which an agent writing an adapter drives to study a site. It holds nothing of
// the person's. What it may reach is decided by the app's rules (the draft's domains, signed-in
// sites off, pacing); this class enforces them on every request, keeps the network log, and reads
// pages for the agent through the scripts in scratch-scripts.ts.

import type { Socket } from 'node:net'
import {
  type AriaPoint,
  absoluteUrls,
  ariaBootedScript,
  ariaBootScript,
  ariaBoxScript,
  ariaCheckedScript,
  ariaFieldScript,
  ariaPointScript,
  ariaSelectScript,
  ariaSnapshotScript,
  ariaUploadScript,
  findInSnapshot,
  textShownScript,
} from './aria'
import { cookieSetDetails, cookiesForDomains } from './cookies'
import { type Modifier, parseKey } from './keys'
import { partitionName } from './partitions'
import type {
  BrowserPlatform,
  BrowserSurface,
  DownloadEvent,
  NetworkResponse,
  OutgoingRequest,
  PartitionSession,
  ProxyHandle,
  Timers,
} from './platform'
import { realTimers } from './platform'
import {
  documentScript,
  fieldScript,
  type QueryMatch,
  queryScript,
  type SnapshotNode,
  type SnapshotResult,
  snapshotScript,
} from './scratch-scripts'
import { focusScript, pointScript } from './scripts'
import { type PageField, pageFieldsScript, sensitivePage } from './sensitive-page'
import { chromeUserAgentOverride, cleanChromeUserAgent, LANGUAGES } from './user-agent'

/** What a signed-in (granted) browser may send: reads only. */
const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS'])
/** The requests an app page draws itself from, as webRequest and DevTools name them. */
const API_TYPES: ReadonlySet<string> = new Set(['xhr', 'fetch'])
const POSTED = 'The page tried to post a form, which this browser never sends.'

export const SCRATCH_LIMITS = {
  requestsPerLoad: 300,
  requests: 1500,
  loadTimeoutMs: 20_000,
  settleMs: 1500,
  /** After a load or input, the page counts as settled once no request starts or ends for this long… */
  quietMs: 500,
  /** …or after this long in all, for a page that never goes quiet (polling, analytics). */
  quietCapMs: 5000,
  /** Quiet ticks after which an API call still out is taken to be dead. */
  quietStuckTicks: 3,
  logEntries: 500,
  maxNodes: 1000,
  defaultNodes: 300,
  textLimit: 200,
  typeChars: 500,
  /** Text fill inserts at once; typing slowly sends a keystroke per character, so far less. */
  fillChars: 5000,
  /** A snapshot longer than this is cut; a ref or depth reads less of the page. */
  snapshotChars: 150_000,
  snapshotDepth: 100,
  waitMs: 30_000,
  waitPollMs: 250,
  selectValues: 50,
  uploadFiles: 10,
  /** All the files of one upload together, decoded. */
  uploadBytes: 10 * 1024 * 1024,
  /** A picture bigger than this, as PNG, is refused: a smaller part of the page fits. */
  screenshotBytes: 6 * 1024 * 1024,
  /** A session's download bigger than this is cancelled. */
  downloadBytes: 50 * 1024 * 1024,
  dragSteps: 5,
} as const

/** What became of a session's download, for the agent: still coming, ready, or failed. */
export type DownloadNews =
  | { readonly status: 'downloading'; readonly id: string; readonly name: string }
  | {
      readonly status: 'ready'
      readonly id: string
      readonly name: string
      readonly mimeType: string
      readonly data: Buffer
    }
  | {
      readonly status: 'failed'
      readonly id: string
      readonly name: string
      readonly reason: 'too-large' | 'cancelled' | 'interrupted'
    }

/** A file name that names nothing but itself: no folders, no control characters. */
export function safeFileName(name: string): string {
  return (
    [...name]
      .map((c) => (c === '/' || c === '\\' || c < ' ' ? '_' : c))
      .join('')
      .slice(0, 200) || 'file'
  )
}

/** What the app decides; the browser only asks. */
export interface ScratchRules {
  /** A top-level navigation's target. */
  readonly mayNavigate: (url: URL) => boolean
  /** Any request at all, subresources included (a signed-in site's domain is refused here). */
  readonly mayRequest: (url: URL) => boolean
  /**
   * Waits for the site's rate budget before a top-level navigation; rejects to refuse it, with an
   * error whose `detail` is the sentence for the agent.
   */
  readonly pace: (host: string) => Promise<void>
  /** The site refused the browser (a 429, an HTML 403): it has closed. */
  readonly blocked: (host: string, status: number) => void
  /** False for text the browser must not type (a login secret or session value Valet knows). */
  readonly mayType: (text: string) => boolean | Promise<boolean>
  /**
   * A browser grant (docs/browser-grants.md): the browser starts with the installed adapter's
   * tool-partition cookies on these domains, copied in one way, and is read only. Only GET, HEAD
   * and OPTIONS requests leave it, and a page that looks like payment, bank, password or security
   * settings closes the browser. Cookie values never reach the agent, as always.
   */
  readonly signedIn?: { readonly adapterId: string; readonly cookieDomains: readonly string[] }
  /**
   * An agent's browser session (docs/agent-browser.md): forms may post, as in any browser, and
   * the session's own cookie values are shown as they are, since they were set in it and are
   * nothing of the person's.
   */
  readonly session?: boolean
}

export interface ScratchOptions {
  readonly platform: BrowserPlatform
  /** In memory: never a persist: partition. */
  readonly partition: string
  readonly rules: ScratchRules
  /** Opens upstream connections; the app's refuses private addresses once resolved. */
  readonly dial?: (host: string, port: number) => Socket
  readonly timers?: Timers
}

/** Why the browser refused, in words for the agent. */
export class ScratchError extends Error {
  constructor(readonly detail: string) {
    super(detail)
    this.name = 'ScratchError'
  }
}

export interface ScratchSnapshot {
  readonly url: string
  readonly title: string
  readonly nodes: readonly (Omit<SnapshotNode, 'path'> & { readonly ref: string })[]
  readonly cut: boolean
}

export interface LogEntry {
  readonly seq: number
  readonly method: string
  readonly url: string
  readonly resourceType: string
  readonly status: number
  readonly mimeType: string | null
}

export type Target = { readonly ref: string } | { readonly selector: string }

/** A page as Playwright MCP shows it: its accessibility snapshot in YAML, refs on what can be acted on. */
export interface AriaPage {
  readonly url: string
  readonly title: string
  readonly yaml: string
  /** The page's last snapshot before this one, for a delta; null when this is a new page. */
  readonly previous: string | null
  readonly cut: boolean
}

export interface ClickOptions {
  readonly button?: 'left' | 'right' | 'middle'
  readonly doubleClick?: boolean
  readonly modifiers?: readonly Modifier[]
}

export type WaitFor =
  | { readonly text: string; readonly timeoutMs?: number }
  | { readonly textGone: string; readonly timeoutMs?: number }
  | { readonly timeMs: number }

export class ScratchBrowser {
  private closed = false
  private readonly closers: (() => void)[] = []
  private requests = 0
  private loadRequests = 0
  /** The main-frame request last paced, whose redirect hops go through unpaced. */
  private pacedRequest: number | null = null
  private readonly log: (LogEntry & { readonly id: string })[] = []
  private seq = 0
  private readonly refs = new Map<string, string>()
  /** Every cookie value the partition has held, replaced wherever it would reach the agent. */
  private readonly cookieValues = new Set<string>()
  /** Why the last top-level navigation was refused, for the agent. */
  private refusal: string | null = null
  /** Main-frame requests seen, so settle() can tell an input started a navigation. */
  private mainFrames = 0
  private refusedWrites = 0
  /** Requests started and responses seen: settle() waits until this stops moving. */
  private activity = 0
  /** Fetch and XHR requests let out, and their responses seen: settle() waits for them too. */
  private apiStarted = 0
  private apiDone = 0
  /** The last snapshot's YAML and the document it was of, for deltas. */
  private lastYaml: { readonly frame: string; readonly url: string; readonly yaml: string } | null = null
  /** A session's downloads not yet handed on (takeDownloads). */
  private readonly downloads = new Map<string, DownloadNews>()

  private constructor(
    private readonly options: ScratchOptions,
    private readonly session: PartitionSession,
    private readonly surface: BrowserSurface,
    private readonly proxy: ProxyHandle,
  ) {}

  static async open(options: ScratchOptions): Promise<ScratchBrowser> {
    if (options.partition.startsWith('persist:')) throw new ScratchError('A scratch browser is never kept.')
    const { platform } = options
    const session = platform.session(options.partition)
    session.harden()
    const userAgent = cleanChromeUserAgent(platform.chromeVersion, platform.os)
    session.setUserAgent(userAgent, LANGUAGES)
    let self: ScratchBrowser | null = null
    session.filterRequests((request) => (self === null ? false : self.allow(request)))
    // Only a session keeps what it downloads; any other scratch browser refuses downloads.
    if (options.rules.session === true)
      session.acceptDownloads(SCRATCH_LIMITS.downloadBytes, (event) => self?.downloaded(event))
    session.onCookieChanged((cookie) => {
      if (cookie.value.length >= 6) self?.cookieValues.add(cookie.value)
    })
    // Seeded before the first request, and never copied back.
    const seeded: string[] = []
    const grant = options.rules.signedIn
    if (grant !== undefined) {
      try {
        const live = platform.session(partitionName('tool', grant.adapterId))
        for (const cookie of cookiesForDomains(await live.getCookies(), grant.cookieDomains)) {
          if (cookie.value.length >= 6) seeded.push(cookie.value)
          await session.setCookie(cookieSetDetails(cookie))
        }
      } catch {
        throw new ScratchError('Valet could not sign the browser in.')
      }
    }
    session.watchResponses((response) => {
      if (self === null || response.resourceType !== 'mainFrame') return
      const html = (response.contentType ?? '').includes('html')
      if (response.status === 429 || (response.status === 403 && html)) {
        const host = hostOf(response.url)
        self.close()
        if (host !== null) options.rules.blocked(host, response.status)
      }
    })
    const proxy = await platform.startProxy((host) => {
      if (self === null || self.closed) return false
      try {
        return options.rules.mayRequest(new URL(`https://${host}/`))
      } catch {
        return false
      }
    }, options.dial)
    await session.useProxy(proxy)
    const surface = platform.openSurface(options.partition)
    const browser = new ScratchBrowser(options, session, surface, proxy)
    for (const value of seeded) browser.cookieValues.add(value)
    self = browser
    try {
      const { chromeVersion, os, systemVersion, arch } = platform
      await surface.overrideUserAgent(
        chromeUserAgentOverride({ chromeVersion, os, systemVersion, arch }, 'chrome'),
      )
      await surface.watchNetwork((response) => browser.record(response))
    } catch {
      browser.close()
      throw new ScratchError('The scratch browser could not start.')
    }
    surface.guardNavigation((navigation) => {
      if (!navigation.isMainFrame) return true
      const url = parseUrl(navigation.url)
      const ok = url !== null && (url.protocol === 'about:' || options.rules.mayNavigate(url))
      // A redirect stopped here never reaches the request filter: say where it went.
      if (!ok && url !== null) browser.refusal = browser.wentOn(url)
      return ok
    })
    surface.onDestroyed(() => browser.close())
    return browser
  }

  isClosed(): boolean {
    return this.closed
  }

  /**
   * The session's downloads since the last call: each one still coming (every time, until it ends),
   * then once ready with its bytes or once failed. Nothing is kept after it is handed on.
   */
  takeDownloads(): readonly DownloadNews[] {
    const news = [...this.downloads.values()]
    for (const item of news) if (item.status !== 'downloading') this.downloads.delete(item.id)
    return news
  }

  private downloaded(event: DownloadEvent): void {
    if (this.closed) return
    const name = safeFileName(event.name)
    if (event.kind === 'started') this.downloads.set(event.id, { status: 'downloading', id: event.id, name })
    else if (event.kind === 'done')
      this.downloads.set(event.id, {
        status: 'ready',
        id: event.id,
        name,
        mimeType: event.mimeType.slice(0, 100) || 'application/octet-stream',
        data: event.data,
      })
    else this.downloads.set(event.id, { status: 'failed', id: event.id, name, reason: event.reason })
  }

  onClosed(listener: () => void): void {
    if (this.closed) listener()
    else this.closers.push(listener)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.downloads.clear()
    if (!this.surface.isDestroyed()) this.surface.destroy()
    void this.proxy.close().catch(() => undefined)
    for (const listener of this.closers.splice(0)) listener()
  }

  async navigate(url: string): Promise<ScratchSnapshot> {
    await this.load(url)
    return this.snapshot()
  }

  /** Opens a page and gives its accessibility snapshot (the agents' browser). */
  async go(url: string): Promise<AriaPage> {
    await this.load(url)
    return this.ariaSnapshot()
  }

  /** The page before this one in the history, as the Back button goes. */
  async back(): Promise<AriaPage> {
    this.open()
    if (!this.surface.canGoBack()) throw new ScratchError('There is no page to go back to.')
    const frames = this.mainFrames
    this.refusal = null
    this.surface.goBack()
    await this.settle(frames)
    return this.ariaSnapshot()
  }

  /** Sets the size of the page's window, in CSS pixels, for layouts that change with it. */
  async resize(width: number, height: number): Promise<AriaPage> {
    this.open()
    const w = Math.round(width)
    const h = Math.round(height)
    if (!(w >= 200 && w <= 4000 && h >= 200 && h <= 4000))
      throw new ScratchError('Give a width and height between 200 and 4000 pixels.')
    const frames = this.mainFrames
    this.surface.setSize(w, h)
    await this.settle(frames)
    return this.ariaSnapshot()
  }

  private async load(url: string): Promise<void> {
    this.open()
    const target = parseUrl(url)
    if (target === null || target.protocol !== 'https:') throw new ScratchError('Only https pages open here.')
    if (!this.options.rules.mayNavigate(target))
      throw new ScratchError(
        `${target.hostname} isn't under the draft's domains. Add it to the manifest's home, navigation or egress first.`,
      )
    if (!this.options.rules.mayRequest(target))
      throw new ScratchError(`This browser doesn’t reach ${target.hostname.slice(0, 100)}.`)
    this.refusal = null
    const loaded = await this.withTimeout(this.surface.load(target.href))
    // Only when the page itself didn't load: a page that loaded and then tried to go elsewhere is shown.
    if (this.refusal !== null && (loaded === null || !loaded.ok)) throw new ScratchError(this.refusal)
    if (this.closed) throw new ScratchError('The site refused the scratch browser, so it closed.')
    if (loaded !== null && !loaded.ok && loaded.code !== 'ERR_ABORTED')
      throw new ScratchError(`The page didn't load (${loaded.code.slice(0, 40)}).`)
    await this.quiet()
  }

  async snapshot(
    options: { readonly root?: string; readonly maxNodes?: number } = {},
  ): Promise<ScratchSnapshot> {
    this.open()
    const maxNodes = Math.min(
      Math.max(options.maxNodes ?? SCRATCH_LIMITS.defaultNodes, 1),
      SCRATCH_LIMITS.maxNodes,
    )
    const raw = await this.run(
      snapshotScript({ root: options.root ?? null, maxNodes, textLimit: SCRATCH_LIMITS.textLimit }),
    )
    const result = raw as (SnapshotResult & { error?: string }) | null
    if (result === null || typeof result !== 'object') throw new ScratchError('The page could not be read.')
    if (result.error === 'invalid-selector') throw new ScratchError('That root isn’t a valid selector.')
    if (result.error === 'not-found') throw new ScratchError('Nothing on the page matches that root.')
    if (this.options.rules.signedIn !== undefined)
      await this.guardPage(String(result.url ?? this.surface.url()))
    this.refs.clear()
    const nodes = (Array.isArray(result.nodes) ? result.nodes : []).map((node, index) => {
      const ref = `e${index + 1}`
      this.refs.set(ref, String(node.path))
      return {
        ref,
        kind: node.kind === 'interactive' ? ('interactive' as const) : ('text' as const),
        tag: String(node.tag).slice(0, 20),
        role: typeof node.role === 'string' ? node.role.slice(0, 40) : null,
        text: this.scrub(String(node.text ?? '')),
        href: typeof node.href === 'string' ? this.scrub(node.href) : null,
        inputType: typeof node.inputType === 'string' ? node.inputType.slice(0, 20) : null,
      }
    })
    return {
      url: this.scrub(String(result.url ?? this.surface.url())),
      title: this.scrub(String(result.title ?? '')),
      nodes,
      cut: result.cut === true,
    }
  }

  async query(
    selector: string,
  ): Promise<{ readonly count: number; readonly matches: readonly QueryMatch[] }> {
    this.open()
    if (this.options.rules.signedIn !== undefined) await this.guardPage(this.surface.url())
    const raw = (await this.run(queryScript(selector))) as {
      error?: string
      count?: number
      matches?: QueryMatch[]
    } | null
    if (raw?.error === 'invalid-selector') throw new ScratchError('That isn’t a valid selector.')
    return {
      count: typeof raw?.count === 'number' ? raw.count : 0,
      matches: (raw?.matches ?? []).map((m) => ({ ...m, text: this.scrub(String(m.text ?? '')) })),
    }
  }

  /** A trusted click at the element's centre; then the page settles and is read again. */
  async click(target: Target): Promise<ScratchSnapshot> {
    this.open()
    const selector = this.selectorOf(target)
    const point = (await this.run(pointScript(selector))) as {
      x?: number
      y?: number
      error?: string
    } | null
    if (point === null) throw new ScratchError('Nothing on the page matches that.')
    if (point.error === 'invalid-selector') throw new ScratchError('That isn’t a valid selector.')
    if (point.error !== undefined || typeof point.x !== 'number' || typeof point.y !== 'number')
      throw new ScratchError('That element isn’t visible, so it can’t be clicked.')
    const frames = this.mainFrames
    this.surface.click(point.x, point.y)
    await this.settle(frames)
    return this.snapshot()
  }

  /** Types literal text into a field; never a password or one-time code field. */
  async type(target: Target, text: string): Promise<ScratchSnapshot> {
    this.open()
    if (text.length > SCRATCH_LIMITS.typeChars)
      throw new ScratchError('That is more text than the browser types.')
    if (!(await this.options.rules.mayType(text))) throw new ScratchError('Valet doesn’t type that here.')
    const selector = this.selectorOf(target)
    const field = (await this.run(fieldScript(selector))) as {
      error?: string
      editable?: boolean
      inputType?: string | null
      autocomplete?: string
      name?: string
    } | null
    if (field === null) throw new ScratchError('Nothing on the page matches that.')
    if (field.error === 'invalid-selector') throw new ScratchError('That isn’t a valid selector.')
    if (
      field.inputType === 'password' ||
      /one-time-code|current-password|new-password/.test(field.autocomplete ?? '') ||
      /otp|passcode|password/.test(field.name ?? '')
    )
      throw new ScratchError('The scratch browser doesn’t type into password or code fields.')
    if (field.editable === false)
      throw new ScratchError(
        'That element isn’t a field you can type into (it is disabled, read only or not a text field).',
      )
    // The window is never shown, and Valet is a menu-bar app, so the page has no keyboard focus of
    // its own: give it focus first, as the tool page does, or no field can take the keyboard.
    this.surface.focus()
    const focused = (await this.run(focusScript(selector))) as { focused?: boolean } | null
    if (focused === null) throw new ScratchError('Nothing on the page matches that.')
    if (focused.focused !== true)
      throw new ScratchError(
        'That field couldn’t take the keyboard: the page moved focus elsewhere. Click it first, or try its selector.',
      )
    const frames = this.mainFrames
    for (const char of text) this.surface.sendChar(char, 'full')
    await this.settle(frames)
    return this.snapshot()
  }

  // The agents' browser (docs/agent-browser.md): Playwright MCP's page reading and input. Targets
  // are a ref from the last snapshot (e12) or a CSS selector, resolved in the page.

  /** The page's accessibility snapshot, or one element's with `target`; `depth` limits how deep. */
  async ariaSnapshot(options: { readonly target?: string; readonly depth?: number } = {}): Promise<AriaPage> {
    this.open()
    const target = options.target === undefined ? null : this.ariaTarget(options.target)
    const depth =
      options.depth === undefined
        ? null
        : Math.min(Math.max(Math.floor(options.depth), 1), SCRATCH_LIMITS.snapshotDepth)
    const raw = (await this.runAria(ariaSnapshotScript({ target, depth }))) as {
      url?: unknown
      title?: unknown
      yaml?: unknown
      error?: string
    } | null
    if (raw === null || typeof raw !== 'object') throw new ScratchError('The page could not be read.')
    if (raw.error !== undefined) throw this.targetError(raw.error)
    const pageUrl = String(raw.url ?? this.surface.url())
    if (this.options.rules.signedIn !== undefined) await this.guardPage(pageUrl)
    let yaml = this.scrub(absoluteUrls(String(raw.yaml ?? ''), pageUrl))
    const cut = yaml.length > SCRATCH_LIMITS.snapshotChars
    if (cut) yaml = yaml.slice(0, yaml.lastIndexOf('\n', SCRATCH_LIMITS.snapshotChars))
    const frame = this.surface.frames()[0]?.id ?? ''
    const last = this.lastYaml
    const previous = last !== null && last.frame === frame && last.url === pageUrl ? last.yaml : null
    // Only a whole-page snapshot is what a later one is compared with.
    if (target === null && depth === null) this.lastYaml = { frame, url: pageUrl, yaml }
    return { url: this.scrub(pageUrl), title: this.scrub(String(raw.title ?? '')), yaml, previous, cut }
  }

  /** The snapshot's lines that match, each under its path, so an agent can find a ref. */
  async find(match: { readonly text: string } | { readonly regex: string }): Promise<{
    readonly url: string
    readonly matches: readonly string[]
  }> {
    let test: { readonly text: string } | { readonly regex: RegExp }
    if ('regex' in match) {
      if (match.regex.length === 0 || match.regex.length > 200)
        throw new ScratchError('That pattern is too long.')
      try {
        test = { regex: new RegExp(match.regex, 'i') }
      } catch {
        throw new ScratchError('That isn’t a valid regular expression.')
      }
    } else {
      if (match.text.trim().length === 0 || match.text.length > 200)
        throw new ScratchError('Give some text to look for, up to 200 characters.')
      test = { text: match.text.trim() }
    }
    const page = await this.ariaSnapshot()
    return { url: page.url, matches: findInSnapshot(page.yaml, test) }
  }

  /** A trusted click at the element's centre, as a mouse makes it; then the page settles. */
  async clickElement(target: string, options: ClickOptions = {}): Promise<AriaPage> {
    const point = await this.pointAt(target)
    const frames = this.mainFrames
    const button = options.button ?? 'left'
    const modifiers = options.modifiers ?? []
    const { x, y } = point
    this.surface.focus()
    this.surface.mouse({ type: 'move', x, y, modifiers })
    for (let count = 1; count <= (options.doubleClick === true ? 2 : 1); count++) {
      this.surface.mouse({ type: 'down', x, y, button, clickCount: count, modifiers })
      this.surface.mouse({ type: 'up', x, y, button, clickCount: count, modifiers })
    }
    await this.settle(frames)
    return this.ariaSnapshot()
  }

  /** A PNG of the page as it shows: the viewport, the whole page, or one element. */
  async screenshot(options: { readonly target?: string; readonly fullPage?: boolean } = {}): Promise<{
    readonly url: string
    readonly png: Buffer
  }> {
    this.open()
    let clip: { x: number; y: number; width: number; height: number } | null = null
    if (options.target !== undefined) {
      const raw = (await this.runAria(ariaBoxScript(this.ariaTarget(options.target)))) as {
        error?: string
        x?: number
        y?: number
        width?: number
        height?: number
      } | null
      if (raw === null || typeof raw !== 'object') throw new ScratchError('The page could not be read.')
      if (raw.error !== undefined) throw this.targetError(raw.error)
      const { x, y, width, height } = raw
      if (
        typeof x !== 'number' ||
        typeof y !== 'number' ||
        typeof width !== 'number' ||
        typeof height !== 'number'
      )
        throw new ScratchError('The page could not be read.')
      clip = { x, y, width: Math.min(width, 8000), height: Math.min(height, 8000) }
    }
    if (this.options.rules.signedIn !== undefined) await this.guardPage(this.surface.url())
    const png = await this.surface.screenshot({ fullPage: options.fullPage === true, clip })
    if (png === null) throw new ScratchError('The page couldn’t be pictured.')
    if (png.length > SCRATCH_LIMITS.screenshotBytes)
      throw new ScratchError(
        'That picture is too big. Picture one element, or the window instead of the whole page.',
      )
    return { url: this.scrub(this.surface.url()), png }
  }

  /** Puts files in a file input, as choosing them in its dialog would; then the page settles. */
  async upload(
    target: string,
    files: readonly { readonly name: string; readonly mimeType: string; readonly data: Buffer }[],
  ): Promise<AriaPage> {
    this.open()
    if (files.length === 0 || files.length > SCRATCH_LIMITS.uploadFiles)
      throw new ScratchError(`Give between 1 and ${SCRATCH_LIMITS.uploadFiles} files.`)
    if (files.reduce((sum, f) => sum + f.data.length, 0) > SCRATCH_LIMITS.uploadBytes)
      throw new ScratchError('Those files are more than the browser uploads at once (10 MB).')
    const payload = files.map((f) => ({
      name: safeFileName(f.name),
      mimeType: f.mimeType.slice(0, 100),
      buffer: f.data.toString('base64'),
    }))
    const raw = (await this.runAria(
      ariaUploadScript({ target: this.ariaTarget(target), files: payload }),
    )) as {
      error?: string
    } | null
    if (raw === null || typeof raw !== 'object') throw new ScratchError('The page could not be read.')
    if (raw.error === 'not-file-input')
      throw new ScratchError(
        'That element isn’t a file input. Find the page’s <input type=file> (or its label).',
      )
    if (raw.error !== undefined) throw this.targetError(raw.error)
    const frames = this.mainFrames
    await this.settle(frames)
    return this.ariaSnapshot()
  }

  /** Ticks or unticks a checkbox, or picks a radio button, by clicking it when it isn't so already. */
  async check(target: string, checked: boolean): Promise<AriaPage> {
    this.open()
    const raw = (await this.runAria(ariaCheckedScript(this.ariaTarget(target)))) as {
      error?: string
      checked?: boolean
    } | null
    if (raw === null || typeof raw !== 'object') throw new ScratchError('The page could not be read.')
    if (raw.error === 'not-checkbox') throw new ScratchError('That element isn’t a checkbox or radio button.')
    if (raw.error !== undefined) throw this.targetError(raw.error)
    if (raw.checked === checked) return this.ariaSnapshot()
    return this.clickElement(target)
  }

  /** Moves the mouse over the element, for menus and tooltips that open on hover. */
  async hover(target: string): Promise<AriaPage> {
    const { x, y } = await this.pointAt(target)
    const frames = this.mainFrames
    this.surface.mouse({ type: 'move', x, y })
    await this.settle(frames)
    return this.ariaSnapshot()
  }

  /** Drags one element onto another with the mouse held down. */
  async drag(from: string, to: string): Promise<AriaPage> {
    const start = await this.pointAt(from)
    const frames = this.mainFrames
    this.surface.mouse({ type: 'move', x: start.x, y: start.y })
    this.surface.mouse({ type: 'down', x: start.x, y: start.y })
    try {
      const end = await this.pointAt(to)
      for (let step = 1; step <= SCRATCH_LIMITS.dragSteps; step++) {
        const x = start.x + ((end.x - start.x) * step) / SCRATCH_LIMITS.dragSteps
        const y = start.y + ((end.y - start.y) * step) / SCRATCH_LIMITS.dragSteps
        this.surface.mouse({ type: 'move', x, y })
      }
      this.surface.mouse({ type: 'up', x: end.x, y: end.y })
    } catch (error) {
      this.surface.mouse({ type: 'up', x: start.x, y: start.y })
      throw error
    }
    await this.settle(frames)
    return this.ariaSnapshot()
  }

  /**
   * Puts text in a field, as Playwright's fill does: what was there is replaced, all at once. With
   * `slowly` it is typed a key at a time after what is there, for pages that react to each key. With
   * `submit` Enter is pressed after. Never a password or one-time code field.
   */
  async fill(
    target: string,
    text: string,
    options: { readonly slowly?: boolean; readonly submit?: boolean } = {},
  ): Promise<AriaPage> {
    this.open()
    const slowly = options.slowly === true
    if (text.length > (slowly ? SCRATCH_LIMITS.typeChars : SCRATCH_LIMITS.fillChars))
      throw new ScratchError(
        slowly
          ? 'That is more text than the browser types a key at a time.'
          : 'That is more text than the browser fills.',
      )
    if (!(await this.options.rules.mayType(text))) throw new ScratchError('Valet doesn’t type that here.')
    // The window is never shown, and Valet is a menu-bar app, so the page has no keyboard focus of
    // its own: give it focus first, or no field can take the keyboard.
    this.surface.focus()
    const raw = (await this.runAria(
      ariaFieldScript({ target: this.ariaTarget(target), value: text, keep: slowly }),
    )) as { error?: string; done?: boolean; focused?: boolean; message?: string } | null
    if (raw === null || typeof raw !== 'object') throw new ScratchError('The page could not be read.')
    if (raw.error === 'secret')
      throw new ScratchError(
        'Agents don’t type into password or code fields; Valet signs in to sites itself.',
      )
    if (raw.error === 'not-editable')
      throw new ScratchError(
        'That element isn’t a field you can type into (it is disabled, read only or not a text field).',
      )
    if (raw.error === 'cannot-fill')
      throw new ScratchError(`That field can’t take text: ${String(raw.message ?? '').slice(0, 200)}`)
    if (raw.error !== undefined) throw this.targetError(raw.error)
    const frames = this.mainFrames
    if (raw.done !== true) {
      if (raw.focused !== true)
        throw new ScratchError(
          'That field couldn’t take the keyboard: the page moved focus elsewhere. Click it first, then type.',
        )
      if (slowly) for (const char of text) this.surface.sendChar(char, 'full')
      else if (text === '') this.surface.pressKey({ keyCode: 'Delete', modifiers: [], char: null })
      else await this.surface.insertText(text)
    }
    if (options.submit === true) {
      await this.settleShort()
      this.surface.pressKey({ keyCode: 'Enter', modifiers: [], char: '\r' })
    }
    await this.settle(frames)
    return this.ariaSnapshot()
  }

  /** Presses a key or combination on whatever has focus: Enter, Escape, ArrowDown, Shift+Tab. */
  async press(key: string): Promise<AriaPage> {
    this.open()
    const parsed = parseKey(key)
    if (parsed === null)
      throw new ScratchError(
        'Valet doesn’t know that key. Use a name like Enter, Tab, Escape, ArrowDown or PageDown, one character, or a combination like Shift+Tab.',
      )
    if (
      parsed.char !== null &&
      parsed.char !== '\r' &&
      parsed.char !== '\t' &&
      !(await this.options.rules.mayType(parsed.char))
    )
      throw new ScratchError('Valet doesn’t type that here.')
    const frames = this.mainFrames
    this.surface.focus()
    this.surface.pressKey(parsed)
    await this.settle(frames)
    return this.ariaSnapshot()
  }

  /** Chooses options in a select by their value or label. */
  async select(target: string, values: readonly string[]): Promise<AriaPage> {
    this.open()
    if (
      values.length === 0 ||
      values.length > SCRATCH_LIMITS.selectValues ||
      values.some((v) => v.length > 500)
    )
      throw new ScratchError('Give between 1 and 50 options to choose.')
    const raw = (await this.runAria(ariaSelectScript({ target: this.ariaTarget(target), values }))) as {
      error?: string
    } | null
    if (raw === null || typeof raw !== 'object') throw new ScratchError('The page could not be read.')
    if (raw.error === 'not-select') throw new ScratchError('That element isn’t a select (a dropdown list).')
    if (raw.error === 'no-option')
      throw new ScratchError('The select has no option with that value or label.')
    if (raw.error === 'option-disabled') throw new ScratchError('That option is disabled.')
    if (raw.error !== undefined) throw this.targetError(raw.error)
    const frames = this.mainFrames
    await this.settle(frames)
    return this.ariaSnapshot()
  }

  /** Waits until text appears or goes, or for a time; then the page as it is. */
  async waitFor(condition: WaitFor): Promise<AriaPage & { readonly met: boolean }> {
    this.open()
    const timers = this.options.timers ?? realTimers
    const sleep = (ms: number) => new Promise<void>((resolve) => timers.setTimeout(resolve, ms))
    if ('timeMs' in condition) {
      await sleep(Math.min(Math.max(condition.timeMs, 0), SCRATCH_LIMITS.waitMs))
      this.open()
      return { ...(await this.ariaSnapshot()), met: true }
    }
    const appear = 'text' in condition
    const text = appear ? condition.text : condition.textGone
    if (text.trim().length === 0 || text.length > 500)
      throw new ScratchError('Give the text to wait for, up to 500 characters.')
    const limit = Math.min(Math.max(condition.timeoutMs ?? SCRATCH_LIMITS.waitMs, 0), SCRATCH_LIMITS.waitMs)
    let met = false
    for (let waited = 0; ; waited += SCRATCH_LIMITS.waitPollMs) {
      // A page mid-navigation has no document to read for a moment: that is not yet, not an error.
      const shown = await this.runAria(textShownScript(text)).catch((error: unknown) => {
        if (this.closed) throw error
        return null
      })
      if (shown !== null && shown === appear) {
        met = true
        break
      }
      if (waited >= limit) break
      await sleep(SCRATCH_LIMITS.waitPollMs)
      this.open()
    }
    return { ...(await this.ariaSnapshot()), met }
  }

  /** Where to send trusted input for an element, refusing one no one could click. */
  private async pointAt(target: string): Promise<AriaPoint> {
    this.open()
    const raw = (await this.runAria(ariaPointScript(this.ariaTarget(target)))) as
      | (Partial<AriaPoint> & { error?: string })
      | null
    if (raw === null || typeof raw !== 'object') throw new ScratchError('The page could not be read.')
    if (raw.error !== undefined) throw this.targetError(raw.error)
    if (typeof raw.x !== 'number' || typeof raw.y !== 'number')
      throw new ScratchError('The page could not be read.')
    if (raw.covered === true)
      throw new ScratchError(
        'Something else covers that element (a dialog, banner or overlay?). Take a snapshot and deal with it first.',
      )
    return raw as AriaPoint
  }

  private ariaTarget(target: string): string {
    if (target.length === 0 || target.length > 500)
      throw new ScratchError('That isn’t a ref or a valid selector.')
    return target
  }

  private targetError(error: string): ScratchError {
    if (error === 'stale')
      return new ScratchError('No element has that ref now: the page changed. Take a new snapshot.')
    if (error === 'invalid-selector') return new ScratchError('That isn’t a ref or a valid selector.')
    if (error === 'not-found') return new ScratchError('Nothing on the page matches that selector.')
    if (error === 'hidden') return new ScratchError('That element isn’t visible, so it can’t be used.')
    return new ScratchError('The page could not be read.')
  }

  /** Runs a script that needs Playwright's injected script, booting it in this document first. */
  private async runAria(script: string): Promise<unknown> {
    if ((await this.run(ariaBootedScript())) !== true) await this.run(ariaBootScript())
    return this.run(script)
  }

  /** A moment between a field's input and its Enter, so the page has handled the one before the other. */
  private async settleShort(): Promise<void> {
    const timers = this.options.timers ?? realTimers
    await new Promise<void>((resolve) => timers.setTimeout(resolve, 100))
    this.open()
  }

  /** The log since `sinceSeq`, newest last. URLs carry no cookie values. */
  entries(
    filter: { readonly sinceSeq?: number; readonly host?: string; readonly type?: string } = {},
  ): LogEntry[] {
    return this.log
      .filter((e) => e.seq > (filter.sinceSeq ?? 0))
      .filter((e) => filter.host === undefined || hostOf(e.url) === filter.host)
      .filter((e) => filter.type === undefined || e.resourceType.toLowerCase() === filter.type.toLowerCase())
      .map(({ id: _id, ...entry }) => ({ ...entry, url: this.scrub(entry.url) }))
  }

  /** One response's body as text, cookie values replaced; null once the browser no longer holds it. */
  async body(seq: number): Promise<{ readonly entry: LogEntry; readonly text: string } | null> {
    this.open()
    const found = this.log.find((e) => e.seq === seq)
    if (found === undefined) return null
    const body = await this.surface.responseBody(found.id)
    if (body === null) return null
    const text = body.base64 ? Buffer.from(body.body, 'base64').toString('utf8') : body.body
    const { id: _id, ...entry } = found
    return { entry: { ...entry, url: this.scrub(entry.url) }, text: this.scrub(text) }
  }

  /** The current document, cookie values replaced: a page fixture. */
  async document(): Promise<string> {
    this.open()
    if (this.options.rules.signedIn !== undefined) await this.guardPage(this.surface.url())
    const html = await this.run(documentScript())
    if (typeof html !== 'string') throw new ScratchError('The page could not be read.')
    return this.scrub(html)
  }

  url(): string {
    return this.scrub(this.surface.url())
  }

  /** Requests a signed-in browser refused for not being reads, since it opened. */
  get writesRefused(): number {
    return this.refusedWrites
  }

  /** A signed-in page the agent must not see: the browser closes and says why. */
  private async guardPage(url: string): Promise<void> {
    const raw = (await this.run(pageFieldsScript).catch(() => null)) as {
      readonly url?: unknown
      readonly fields?: unknown
    } | null
    const list = Array.isArray(raw?.fields) ? (raw.fields as Partial<PageField>[]) : []
    const fields = list.map((f) => ({
      type: String(f.type ?? ''),
      autocomplete: String(f.autocomplete ?? ''),
      name: String(f.name ?? ''),
    }))
    const where = typeof raw?.url === 'string' ? raw.url : url
    const what = sensitivePage(where, fields)
    if (what === null) return
    this.close()
    throw new ScratchError(
      `Valet closed the signed-in browser: this looks like ${what}, which a browser grant never shows. ` +
        'Open it again with valet_browser_open and stay away from that page.',
    )
  }

  /** Replaces every cookie value the partition has held, so none reaches the agent or a fixture. */
  scrub(text: string): string {
    if (this.options.rules.session === true) return text
    let out = text
    for (const value of this.cookieValues) if (out.includes(value)) out = out.replaceAll(value, '[cookie]')
    return out
  }

  private allow(request: OutgoingRequest): boolean | Promise<boolean> {
    if (this.closed) return false
    const url = parseUrl(request.url)
    if (url === null) return false
    if (url.protocol === 'data:' || url.protocol === 'blob:' || url.protocol === 'about:') return true
    if (url.protocol !== 'https:' && url.protocol !== 'wss:') return false
    const mainFrame = request.resourceType === 'mainFrame'
    if (!this.options.rules.mayRequest(url)) {
      if (mainFrame) this.refusal = this.wentOn(url)
      return false
    }
    // Read only: nothing that could change something on the site leaves a signed-in browser.
    if (this.options.rules.signedIn !== undefined && !READ_METHODS.has(request.method.toUpperCase())) {
      this.refusedWrites++
      if (mainFrame) this.refusal = POSTED
      return false
    }
    if (request.resourceType === 'webSocket') {
      const page = parseUrl(this.surface.url())
      if (page === null || page.hostname !== url.hostname) return false
    }
    this.requests++
    this.activity++
    if (API_TYPES.has(request.resourceType.toLowerCase())) this.apiStarted++
    if (request.resourceType === 'mainFrame') {
      // A new document: calls the last one left without an answer no longer hold settle() up.
      this.apiStarted = 0
      this.apiDone = 0
      this.loadRequests = 0
      this.mainFrames++
    }
    this.loadRequests++
    if (this.requests > SCRATCH_LIMITS.requests || this.loadRequests > SCRATCH_LIMITS.requestsPerLoad) {
      this.close()
      return false
    }
    if (request.resourceType !== 'mainFrame') return true
    // A form that posts is a request the agent could make as anyone; only GET pages open.
    if (request.method !== 'GET' && this.options.rules.session !== true) {
      this.refusal = POSTED
      return false
    }
    if (!this.options.rules.mayNavigate(url)) {
      this.refusal = this.wentOn(url)
      return false
    }
    // A server redirect is the same load (it keeps the request's id): paced once, at its first hop,
    // so a page that sends a signed-out visitor to its sign-in page isn't refused as a second load.
    if (request.id !== undefined && request.id === this.pacedRequest) return true
    this.pacedRequest = request.id ?? null
    return this.options.rules.pace(url.hostname).then(
      () => !this.closed,
      (error: unknown) => {
        const detail = (error as { readonly detail?: unknown } | null)?.detail
        this.refusal = typeof detail === 'string' ? detail.slice(0, 300) : 'Valet held that page back.'
        return false
      },
    )
  }

  /** Why a page load was held back: the host it went on to, never its path or query. */
  private wentOn(url: URL): string {
    return `The page went on to ${this.scrub(url.hostname).slice(0, 100)}, which this browser doesn’t open.`
  }

  private record(response: NetworkResponse): void {
    if (this.closed) return
    this.activity++
    if (API_TYPES.has(response.resourceType.toLowerCase())) this.apiDone++
    this.seq++
    this.log.push({
      seq: this.seq,
      id: response.id,
      method: response.method.slice(0, 10),
      url: response.url.slice(0, 2000),
      resourceType: response.resourceType.slice(0, 20),
      status: response.status,
      mimeType: response.mimeType === null ? null : response.mimeType.slice(0, 100),
    })
    if (this.log.length > SCRATCH_LIMITS.logEntries) this.log.shift()
  }

  private selectorOf(target: Target): string {
    if ('ref' in target) {
      const selector = this.refs.get(target.ref)
      if (selector === undefined) throw new ScratchError('No element has that ref now. Take a new snapshot.')
      return selector
    }
    if (target.selector.length === 0 || target.selector.length > 500)
      throw new ScratchError('That isn’t a valid selector.')
    return target.selector
  }

  private async run(script: string): Promise<unknown> {
    const frame = this.surface.frames()[0]
    if (frame === undefined) throw new ScratchError('No page is open. Open one first.')
    try {
      return await frame.run(script)
    } catch {
      if (this.closed) throw new ScratchError('The scratch browser closed.')
      throw new ScratchError('The page could not be read.')
    }
  }

  /**
   * Waits for a navigation the last input started, if any, and a moment for the page to settle. A
   * click's navigation can start a while after the click (later on a busy Mac), so this watches for
   * one for up to settleMs rather than looking once.
   */
  private async settle(framesBefore: number): Promise<void> {
    const timers = this.options.timers ?? realTimers
    const sleep = (ms: number) => new Promise<void>((resolve) => timers.setTimeout(resolve, ms))
    await sleep(300)
    for (let waited = 300; waited < SCRATCH_LIMITS.settleMs; waited += 100) {
      if (this.closed || this.mainFrames !== framesBefore || this.surface.isLoading()) break
      await sleep(100)
    }
    if (this.surface.isLoading()) await this.withTimeout(this.surface.nextStopLoading())
    if (this.closed) throw new ScratchError('The site refused the scratch browser, so it closed.')
    await this.quiet()
  }

  /**
   * Waits until the page stops fetching: an app that draws itself from its API (a React page, say)
   * has its content only once those requests are back, well after the load event.
   */
  private async quiet(): Promise<void> {
    const timers = this.options.timers ?? realTimers
    const sleep = (ms: number) => new Promise<void>((resolve) => timers.setTimeout(resolve, ms))
    let still = 0
    for (let waited = 0; waited < SCRATCH_LIMITS.quietCapMs; waited += SCRATCH_LIMITS.quietMs) {
      const before = this.activity
      await sleep(SCRATCH_LIMITS.quietMs)
      if (this.closed) break
      still = this.activity === before ? still + 1 : 0
      // Quiet with no API call still out; or quiet for a while even so, since a call that failed,
      // was cancelled or was answered somewhere Valet doesn't see never counts as answered.
      if (still >= 1 && this.apiDone >= this.apiStarted) return
      if (still >= SCRATCH_LIMITS.quietStuckTicks) return
    }
    if (this.closed) throw new ScratchError('The scratch browser closed while the page was loading.')
  }

  private withTimeout<T>(work: Promise<T>): Promise<T | null> {
    const timers = this.options.timers ?? realTimers
    return new Promise((resolve, reject) => {
      const handle = timers.setTimeout(() => {
        this.surface.stop()
        resolve(null)
      }, SCRATCH_LIMITS.loadTimeoutMs)
      work.then(
        (value) => {
          timers.clearTimeout(handle)
          resolve(value)
        },
        (error) => {
          timers.clearTimeout(handle)
          reject(error)
        },
      )
    })
  }

  private open(): void {
    if (this.closed)
      throw new ScratchError('The scratch browser has closed. valet_browser_open starts it again.')
  }
}

function parseUrl(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

function hostOf(url: string): string | null {
  return parseUrl(url)?.hostname ?? null
}
