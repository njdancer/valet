// The scratch browser (docs/authoring-tools.md#the-scratch-browser-pr-2): one signed-out, in-memory
// browser per draft, which an agent writing an adapter drives to study a site. It holds nothing of
// the person's. What it may reach is decided by the app's rules (the draft's domains, signed-in
// sites off, pacing); this class enforces them on every request, keeps the network log, and reads
// pages for the agent through the scripts in scratch-scripts.ts.

import type { Socket } from 'node:net'
import type {
  BrowserPlatform,
  BrowserSurface,
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
import { chromeUserAgentOverride, cleanChromeUserAgent, LANGUAGES } from './user-agent'

export const SCRATCH_LIMITS = {
  requestsPerLoad: 300,
  requests: 1500,
  loadTimeoutMs: 20_000,
  settleMs: 1500,
  logEntries: 500,
  maxNodes: 1000,
  defaultNodes: 300,
  textLimit: 200,
  typeChars: 500,
} as const

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

export class ScratchBrowser {
  private closed = false
  private readonly closers: (() => void)[] = []
  private requests = 0
  private loadRequests = 0
  private readonly log: (LogEntry & { readonly id: string })[] = []
  private seq = 0
  private readonly refs = new Map<string, string>()
  /** Every cookie value the partition has held, replaced wherever it would reach the agent. */
  private readonly cookieValues = new Set<string>()
  /** Why the last top-level navigation was refused, for the agent. */
  private refusal: string | null = null
  /** Main-frame requests seen, so settle() can tell an input started a navigation. */
  private mainFrames = 0

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
    session.onCookieChanged((cookie) => {
      if (cookie.value.length >= 6) self?.cookieValues.add(cookie.value)
    })
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
      return url !== null && (url.protocol === 'about:' || options.rules.mayNavigate(url))
    })
    surface.onDestroyed(() => browser.close())
    return browser
  }

  isClosed(): boolean {
    return this.closed
  }

  onClosed(listener: () => void): void {
    if (this.closed) listener()
    else this.closers.push(listener)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (!this.surface.isDestroyed()) this.surface.destroy()
    void this.proxy.close().catch(() => undefined)
    for (const listener of this.closers.splice(0)) listener()
  }

  async navigate(url: string): Promise<ScratchSnapshot> {
    this.open()
    const target = parseUrl(url)
    if (target === null || target.protocol !== 'https:') throw new ScratchError('Only https pages open here.')
    if (!this.options.rules.mayNavigate(target))
      throw new ScratchError(
        `${target.hostname} isn't under the draft's domains. Add it to the manifest's home, navigation or egress first.`,
      )
    this.refusal = null
    const loaded = await this.withTimeout(this.surface.load(target.href))
    if (this.refusal !== null) throw new ScratchError(this.refusal)
    if (this.closed) throw new ScratchError('The site refused the scratch browser, so it closed.')
    if (loaded !== null && !loaded.ok && loaded.code !== 'ERR_ABORTED')
      throw new ScratchError(`The page didn't load (${loaded.code.slice(0, 40)}).`)
    return this.snapshot()
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
    const focused = (await this.run(focusScript(selector))) as { focused?: boolean } | null
    if (focused?.focused !== true) throw new ScratchError('That field couldn’t take the keyboard.')
    const frames = this.mainFrames
    for (const char of text) this.surface.sendChar(char, 'full')
    await this.settle(frames)
    return this.snapshot()
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
    const html = await this.run(documentScript())
    if (typeof html !== 'string') throw new ScratchError('The page could not be read.')
    return this.scrub(html)
  }

  url(): string {
    return this.scrub(this.surface.url())
  }

  /** Replaces every cookie value the partition has held, so none reaches the agent or a fixture. */
  scrub(text: string): string {
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
    if (!this.options.rules.mayRequest(url)) return false
    if (request.resourceType === 'webSocket') {
      const page = parseUrl(this.surface.url())
      if (page === null || page.hostname !== url.hostname) return false
    }
    this.requests++
    if (request.resourceType === 'mainFrame') {
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
    if (request.method !== 'GET' || !this.options.rules.mayNavigate(url)) return false
    return this.options.rules.pace(url.hostname).then(
      () => !this.closed,
      (error: unknown) => {
        const detail = (error as { readonly detail?: unknown } | null)?.detail
        this.refusal = typeof detail === 'string' ? detail.slice(0, 300) : 'Valet held that page back.'
        return false
      },
    )
  }

  private record(response: NetworkResponse): void {
    if (this.closed) return
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
