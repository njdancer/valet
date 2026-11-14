// A stand-in for the Electron driver: core's AuthPage, ToolPage and SessionDriver over the harness
// network, one cookie jar per partition. It does what the real driver must for these flows:
// follows redirects (navigations and fetches), checks every hop against a guard before requesting
// it, loads an auth page's subframes only from the origins core v2 allows them, runs the fake's
// Akamai sensor script's one effect (setting `_abck`), submits forms, types only into the focused
// element while its frame's origin is allowed, and holds every tool-partition request, the
// runtime's login probe included, to the run's policy. It runs no page script.

import {
  type AdapterManifest,
  type AuthPage,
  type BlockedRequest,
  decideRequest,
  type ElementInfo,
  type FetchInit,
  type FetchResult,
  hostAllowed,
  type NeedsUserReason,
  type Purpose,
  SecretValue,
  type SessionDriver,
  type ToolPage,
  type ToolRunPolicy,
  type TypeOptions,
  urlOriginAllowed,
  ValetError,
} from '@valet/core'
import { type Doc, type Element, isVisible, parseHtml, query } from './dom'
import { CookieJar, type Network } from './network'

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36'
const SENSOR = /document\.cookie = '_abck=([^;']+);/

/** Checked before each hop is requested; throws to stop the navigation there. */
type HopGuard = (url: string) => void
/** Whether a subframe at this URL may load. */
type FrameGuard = (url: string) => boolean

/** A subframe the harness loaded: one level deep, no redirects, no frames of its own. */
interface Frame {
  readonly url: string
  readonly doc: Doc
}

/** Where an element was found: the top document or one of its frames. */
interface Located {
  readonly element: Element
  readonly doc: Doc
  /** The URL of the document it is in, whose origin is the element's frame origin. */
  readonly url: string
}

/** One tab: a URL, its parsed document and subframes, and the partition's cookies. */
class Tab {
  url = 'about:blank'
  doc: Doc = parseHtml('')
  frames: readonly Frame[] = []
  readonly committed: string[] = []
  /** Subframes the frame guard refused, by URL, in order. */
  readonly refusedFrames: string[] = []

  constructor(
    private readonly network: Network,
    readonly jar: CookieJar,
    private readonly guard: HopGuard,
    /** Null: subframes are not loaded at all (the tool partition, where nothing reads them). */
    private readonly frameGuard: FrameGuard | null = null,
  ) {}

  async navigate(method: string, url: string, form?: URLSearchParams): Promise<void> {
    let next = new URL(url, this.url === 'about:blank' ? undefined : this.url).href
    let body = form?.toString()
    for (let hop = 0; hop < 10; hop++) {
      this.guard(next)
      const headers: Record<string, string> = { 'user-agent': USER_AGENT, accept: 'text/html' }
      const cookie = this.jar.header(next)
      if (cookie !== '') Object.assign(headers, { cookie })
      if (body !== undefined) headers['content-type'] = 'application/x-www-form-urlencoded'
      const response = await this.network.send(method, next, headers, body)
      for (const line of response.headers['set-cookie'] ?? []) this.jar.receive(next, line)
      const location = response.headers.location
      if (response.status >= 300 && response.status < 400 && location !== undefined) {
        next = new URL(location, next).href
        method = 'GET'
        body = undefined
        continue
      }
      this.url = next
      this.committed.push(next)
      this.doc = parseHtml(response.body)
      this.runSensor(response.body)
      await this.loadFrames()
      return
    }
    throw new ValetError('navigate', 'invalid')
  }

  /** The fake's inline sensor script sets a script-readable `_abck` when there is none. */
  private runSensor(html: string): void {
    const value = SENSOR.exec(html)?.[1]
    const host = new URL(this.url).hostname
    if (value !== undefined && !this.jar.has(host, '_abck')) {
      this.jar.set({ name: '_abck', value, host, hostOnly: true, httpOnly: false })
    }
  }

  /** Loads each iframe the frame guard allows, as the driver's subframe rule would. */
  private async loadFrames(): Promise<void> {
    this.frames = []
    if (this.frameGuard === null) return
    const frames: Frame[] = []
    for (const element of this.doc.elements) {
      const src = element.attrs.get('src')
      if (element.tag !== 'iframe' || src === undefined) continue
      const url = new URL(src, this.url).href
      if (!this.frameGuard(url)) {
        this.refusedFrames.push(url)
        continue
      }
      const headers: Record<string, string> = { 'user-agent': USER_AGENT, accept: 'text/html' }
      const cookie = this.jar.header(url)
      if (cookie !== '') Object.assign(headers, { cookie })
      const response = await this.network.send('GET', url, headers)
      for (const line of response.headers['set-cookie'] ?? []) this.jar.receive(url, line)
      frames.push({ url, doc: parseHtml(response.body) })
    }
    this.frames = frames
  }

  /** The first match in the top document, else in each frame in order, as the driver searches. */
  locate(selector: string): Located | null {
    for (const { doc, url } of [{ doc: this.doc, url: this.url }, ...this.frames]) {
      const element = query(doc, selector)
      if (element !== null) return { element, doc, url }
    }
    return null
  }

  element(selector: string): Located {
    const located = this.locate(selector)
    if (located === null || !isVisible(located.element)) {
      throw new ValetError('auth-step', 'element-missing')
    }
    return located
  }

  /** Submits the form `submitter` is in, as a browser would, with the submitter's own name and value. */
  async submit({ element: submitter, doc }: Located): Promise<void> {
    // Navigating a frame isn't modelled; the guards stop every framed flow before a submit.
    if (doc !== this.doc) throw new ValetError('auth-step', 'unsupported')
    if (submitter.form === null) return
    const form = this.doc.forms[submitter.form] as Element
    const fields = new URLSearchParams()
    for (const element of this.doc.elements) {
      const name = element.attrs.get('name')
      if (element.form !== submitter.form || name === undefined) continue
      if (element.tag === 'button') continue
      if (element.tag === 'input' && element.attrs.get('type') === 'checkbox') {
        if (element.checked) fields.append(name, element.attrs.get('value') ?? 'on')
        continue
      }
      fields.append(name, element.value)
    }
    const submitterName = submitter.attrs.get('name')
    if (submitterName !== undefined) fields.append(submitterName, submitter.attrs.get('value') ?? '')
    const method = (form.attrs.get('method') ?? 'GET').toUpperCase()
    const action = new URL(form.attrs.get('action') || this.url, this.url)
    if (method === 'GET') {
      action.search = fields.toString()
      await this.navigate('GET', action.href)
    } else {
      await this.navigate('POST', action.href, fields)
    }
  }
}

/** The auth partition's page. */
export class HarnessAuthPage implements AuthPage {
  /** Reasons the run was handed to the person, in order. */
  readonly handedToUser: NeedsUserReason[] = []
  private readonly tab: Tab
  private focused: { readonly located: Located; readonly top: Doc } | null = null

  constructor(
    network: Network,
    jar: CookieJar,
    navigation: readonly string[],
    frameOrigins: readonly string[],
  ) {
    this.tab = new Tab(
      network,
      jar,
      (url) => {
        // Every hop, redirects included, before it is requested: an open redirect stops here.
        if (!urlOriginAllowed(url, navigation)) throw new ValetError('navigate', 'navigation-escaped')
      },
      // Subframes only from navigation's origins and the manifest's frameOrigins (core v2).
      (url) => urlOriginAllowed(url, [...navigation, ...frameOrigins]),
    )
  }

  goto(url: string): Promise<void> {
    this.focused = null
    return this.tab.navigate('GET', url)
  }

  currentUrl(): string {
    return this.tab.url
  }

  committedUrls(): readonly string[] {
    return this.tab.committed
  }

  /** Subframes loaded on the current page, by URL. */
  loadedFrames(): readonly string[] {
    return this.tab.frames.map((frame) => frame.url)
  }

  /** Every subframe the frame rule refused, by URL. */
  refusedFrames(): readonly string[] {
    return this.tab.refusedFrames
  }

  async inspect(selector: string): Promise<ElementInfo | null> {
    const located = this.tab.locate(selector)
    if (located === null) return null
    const { element, doc, url } = located
    const form = element.form === null ? null : (doc.forms[element.form] ?? null)
    return {
      visible: isVisible(element),
      tagName: element.tag.toUpperCase(),
      inputType: element.tag === 'input' ? (element.attrs.get('type') ?? 'text').toLowerCase() : null,
      autocomplete: element.attrs.get('autocomplete') ?? null,
      inputMode: element.attrs.get('inputmode') ?? null,
      // The origin of the frame the element is in, not the top document's.
      frameOrigin: new URL(url).origin,
      formActionOrigin: form === null ? null : new URL(form.attrs.get('action') || url, url).origin,
      inputReachable: true,
    }
  }

  async click(selector: string): Promise<void> {
    const located = this.tab.element(selector)
    const { element } = located
    this.focused = null
    if (element.tag === 'input' && element.attrs.get('type') === 'checkbox') {
      element.checked = !element.checked
      return
    }
    if (element.tag === 'button' && (element.attrs.get('type') ?? 'submit') === 'submit') {
      await this.tab.submit(located)
      return
    }
    const href = element.attrs.get('href')
    if (element.tag === 'a' && href !== undefined) await this.tab.navigate('GET', href)
  }

  async focus(selector: string): Promise<void> {
    this.focused = { located: this.tab.element(selector), top: this.tab.doc }
  }

  async type(text: string | SecretValue, options: TypeOptions = {}): Promise<void> {
    const focused = this.focused
    if (focused === null) throw new ValetError('auth-step', 'element-missing')
    const { allowedOrigins } = options
    if (text instanceof SecretValue && allowedOrigins === undefined) {
      throw new ValetError('secret-fill', 'origin-mismatch')
    }
    const { element, url } = focused.located
    const keystroke = async (character: string): Promise<void> => {
      // Before every key: still the same page, still focused, and the focused frame's origin allowed.
      const moved = this.tab.doc !== focused.top || this.focused !== focused
      if (moved || (allowedOrigins !== undefined && !urlOriginAllowed(url, allowedOrigins))) {
        throw new ValetError('secret-fill', 'origin-mismatch')
      }
      element.value += character
    }
    if (typeof text === 'string') {
      for (const character of text) await keystroke(character)
    } else {
      await text.revealEach(keystroke)
    }
  }

  // The flow probes through its AuthProbe hook, never through the page; these exist for the contract.
  async fetch(_url: string): Promise<FetchResult> {
    throw new ValetError('probe', 'unsupported')
  }

  async cookieNames(_cookieDomains: readonly string[]): Promise<readonly string[]> {
    throw new ValetError('probe', 'unsupported')
  }

  async textPresent(text: string): Promise<boolean> {
    return this.tab.doc.text.includes(text)
  }

  async handToUser(reason: NeedsUserReason): Promise<void> {
    this.handedToUser.push(reason)
  }

  async close(): Promise<void> {
    this.focused = null
  }
}

const RANK: Readonly<Record<Purpose, number>> = { read: 0, write: 1, irreversible: 2 }

/** How a refused request leaves the capability API. */
const REFUSALS: Readonly<Record<BlockedRequest['reason'], ValetError>> = {
  'host-not-allowed': new ValetError('egress', 'host-not-allowed'),
  undeclared: new ValetError('request-surface', 'undeclared-request'),
  'denied-path': new ValetError('request-surface', 'denied-path'),
  'ambiguous-path': new ValetError('request-surface', 'ambiguous-path'),
  'purpose-exceeded': new ValetError('request-surface', 'denied-path'),
  'request-ceiling': new ValetError('request-surface', 'request-ceiling'),
  'bad-url': new ValetError('request-surface', 'invalid'),
  'page-policy': new ValetError('egress', 'page-policy'),
}

/**
 * How the driver treats the runtime's own login probe in the tool partition:
 * - 'none': as core v2 has it today. The probe is an API call like any other, held to the request
 *   surface (where bootstrap is not declared) and the ceiling.
 * - 'counted': the requested runtime-probe allowance, but counted against the run's ceiling.
 * - 'uncounted': the requested allowance (README, core change requests): exactly
 *   GET <home origin><session.probe.path>, from the runtime's handle only, counted apart.
 */
export type ProbeAllowance = 'none' | 'counted' | 'uncounted'

/** Who a tool-partition request comes from. Tool code never holds the runtime's handle. */
type Initiator = 'tool' | 'runtime'

/** One tool run's admitted requests, in order: "nav GET /", "tool GET /apis/…", "probe GET /api/…". */
export interface RunLog {
  readonly requests: string[]
}

interface Run {
  readonly policy: ToolRunPolicy
  readonly onBlocked: (request: BlockedRequest) => void
  readonly log: RunLog
  used: number
  unlocked: boolean
}

/** The tool partition's page, as tool code (or, with the runtime's handle, the runtime) sees it. */
class HarnessToolPage implements ToolPage {
  constructor(
    private readonly tab: Tab,
    private readonly network: Network,
    private readonly driver: HarnessDriver,
    private readonly initiator: Initiator,
  ) {}

  async goto(url: string): Promise<void> {
    // The tab's hop guard holds every hop, the first included, to the run's policy.
    await this.tab.navigate('GET', url)
  }

  currentUrl(): string {
    return this.tab.url
  }

  /** Follows redirects as fetch() does, each hop held to the run's policy before it is sent. */
  async fetch(pathOrUrl: string, init: FetchInit = {}): Promise<FetchResult> {
    let method = (init.method ?? 'GET').toUpperCase()
    let url = new URL(pathOrUrl, this.tab.url).href
    let body: string | undefined
    const headers: Record<string, string> = {
      'user-agent': USER_AGENT,
      accept: 'application/json',
      ...init.headers,
    }
    if (init.json !== undefined) {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(init.json)
    }
    for (let hop = 0; hop < 10; hop++) {
      this.driver.admitApiCall(method, url, this.initiator)
      const cookie = this.tab.jar.header(url)
      const response = await this.network.send(
        method,
        url,
        cookie === '' ? headers : { ...headers, cookie },
        body,
      )
      for (const line of response.headers['set-cookie'] ?? []) this.tab.jar.receive(url, line)
      const location = response.headers.location
      if (response.status >= 300 && response.status < 400 && location !== undefined) {
        url = new URL(location, url).href
        if (response.status !== 307 && response.status !== 308) {
          method = 'GET'
          body = undefined
        }
        continue
      }
      if (this.initiator === 'runtime') this.driver.probed()
      const contentType = response.headers['content-type'] ?? null
      return { status: response.status, contentType, body: parseBody(contentType, response.body) }
    }
    throw new ValetError('tool-run', 'unavailable')
  }

  click(): Promise<void> {
    return unsupported()
  }
  fill(): Promise<void> {
    return unsupported()
  }
  extract(): Promise<unknown> {
    return unsupported()
  }
  evaluate(): Promise<unknown> {
    return unsupported()
  }
}

function parseBody(contentType: string | null, text: string): unknown {
  if (text === '') return null
  if (contentType?.includes('json')) {
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }
  return text
}

async function unsupported(): Promise<never> {
  throw new ValetError('tool-run', 'unsupported')
}

export interface HarnessDriverOptions {
  /** Defaults to 'uncounted', the allowance core is asked for; 'none' is core v2 as it is. */
  readonly probeAllowance?: ProbeAllowance
}

export class HarnessDriver implements SessionDriver {
  readonly authJar = new CookieJar()
  readonly toolJar = new CookieJar()
  /** Every auth page opened, so tests can look at where each one went. */
  readonly authPages: HarnessAuthPage[] = []
  /** Every request refused in the tool partition. */
  readonly blocked: BlockedRequest[] = []
  /** Each tool run's admitted requests, one log per beginRun(). */
  readonly runs: RunLog[] = []
  /** How many hand-offs copied the auth partition's cookies across. */
  handoffs = 0
  /** Called after each probe the runtime makes, with how many it has made, for timing tests. */
  onProbe: ((count: number) => void) | null = null
  private probes = 0
  private tool: HarnessToolPage | null = null
  private runtime: HarnessToolPage | null = null
  private run: Run | null = null
  private readonly home: string
  private readonly navigation: readonly string[]
  private readonly frameOrigins: readonly string[]
  private readonly probePath: string | null
  private readonly probeAllowance: ProbeAllowance

  constructor(
    private readonly network: Network,
    manifest: AdapterManifest,
    options: HarnessDriverOptions = {},
  ) {
    this.home = manifest.home
    this.navigation = manifest.navigation
    this.frameOrigins = manifest.auth.frameOrigins
    const probe = manifest.session.probe
    this.probePath = probe.kind === 'fetch' ? probe.path : null
    this.probeAllowance = options.probeAllowance ?? 'uncounted'
  }

  async openAuthPage(): Promise<AuthPage> {
    const page = new HarnessAuthPage(this.network, this.authJar, this.navigation, this.frameOrigins)
    this.authPages.push(page)
    return page
  }

  async toolPage(): Promise<ToolPage> {
    if (this.tool === null) {
      const tab = new Tab(this.network, this.toolJar, (url) => this.admitNavigation(url))
      this.tool = new HarnessToolPage(tab, this.network, this, 'tool')
      this.runtime = new HarnessToolPage(tab, this.network, this, 'runtime')
      await this.tool.goto(this.home)
    }
    return this.tool
  }

  /**
   * The runtime's own handle on the tool page, for the login probe: the same tab and cookies as
   * toolPage(), but its requests are marked as the runtime's. Only HarnessRuntime calls this.
   */
  async runtimePage(): Promise<ToolPage> {
    await this.toolPage()
    return this.runtime as HarnessToolPage
  }

  async handoff(cookieDomains: readonly string[], _storage: readonly unknown[]): Promise<void> {
    this.handoffs += 1
    for (const cookie of this.authJar.on(cookieDomains)) this.toolJar.set(cookie)
  }

  async sessionSecrets(
    cookieDomains: readonly string[],
    _storage: readonly unknown[],
  ): Promise<readonly string[]> {
    return this.toolJar.on(cookieDomains).map((cookie) => cookie.value)
  }

  async cookieNames(cookieDomains: readonly string[]): Promise<readonly string[]> {
    return this.toolJar.on(cookieDomains).map((cookie) => cookie.name)
  }

  beginRun(policy: ToolRunPolicy, onBlocked: (request: BlockedRequest) => void): void {
    const log: RunLog = { requests: [] }
    this.runs.push(log)
    this.run = { policy, onBlocked, log, used: 0, unlocked: false }
  }

  unlockIrreversible(): void {
    if (this.run !== null) this.run.unlocked = true
  }

  endRun(): void {
    this.run = null
  }

  async close(): Promise<void> {
    this.tool = null
    this.runtime = null
  }

  /** Every hop of a tool-partition navigation: egress, then the ceiling. */
  admitNavigation(url: string): void {
    const run = this.run
    if (run === null) return
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || !hostAllowed(parsed.hostname, run.policy.egress)) {
      this.refuse(run, 'GET', parsed, 'host-not-allowed')
    }
    this.count(run, 'GET', parsed, 'nav')
  }

  /** Every hop of a tool-partition fetch: the runtime's probe allowance, else the full policy. */
  admitApiCall(method: string, url: string, initiator: Initiator): void {
    const run = this.run
    if (run === null) throw new ValetError('request-surface', 'undeclared-request')
    const parsed = new URL(url)
    if (initiator === 'runtime' && this.probeAllowance !== 'none' && this.isProbe(method, parsed)) {
      if (this.probeAllowance === 'counted') this.count(run, method, parsed, 'probe')
      else run.log.requests.push(`probe ${method} ${parsed.pathname}`)
      return
    }
    const decision = decideRequest(method, url, run.policy.egress, run.policy.requests)
    if (!decision.allowed) this.refuse(run, method, parsed, decision.reason)
    const purpose = decision.declaration.purpose
    const locked = purpose === 'irreversible' && !run.unlocked
    if (RANK[purpose] > RANK[run.policy.maxPurpose] || locked)
      this.refuse(run, method, parsed, 'purpose-exceeded')
    this.count(run, method, parsed, initiator === 'runtime' ? 'probe' : 'tool')
  }

  /** Called by the runtime's handle once a probe has its answer. */
  probed(): void {
    this.probes += 1
    this.onProbe?.(this.probes)
  }

  /** Exactly the manifest's probe: a GET of its path on the home origin, with no query. */
  private isProbe(method: string, url: URL): boolean {
    const home = new URL(this.home)
    return (
      method === 'GET' && url.origin === home.origin && url.pathname === this.probePath && url.search === ''
    )
  }

  private count(run: Run, method: string, url: URL, kind: 'nav' | 'tool' | 'probe'): void {
    if (run.used >= run.policy.ceiling) this.refuse(run, method, url, 'request-ceiling')
    run.used += 1
    run.log.requests.push(`${kind} ${method} ${url.pathname}`)
  }

  private refuse(run: Run, method: string, url: URL, reason: BlockedRequest['reason']): never {
    const blocked: BlockedRequest = {
      method,
      target: `${url.origin}${url.pathname}`,
      reason,
      initiator: 'tool',
    }
    this.blocked.push(blocked)
    run.onBlocked(blocked)
    throw REFUSALS[reason]
  }
}
