// A stand-in for the Electron driver: core's AuthPage, ToolPage and SessionDriver over the harness
// network, one cookie jar per partition. It does what the real driver must for these flows:
// follows redirects, checks every hop against a guard before requesting it, runs the fake's
// Akamai sensor script's one effect (setting `_abck`), submits forms, types only into the focused
// element while its frame's origin is allowed, and holds every tool-partition request to the run's
// policy. It runs no page script.

import {
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
  SiteAdapterError,
  type ToolPage,
  type ToolRunPolicy,
  type TypeOptions,
  urlOriginAllowed,
} from '@siteadapter/core'
import { type Doc, type Element, isVisible, parseHtml, query } from './dom'
import { CookieJar, type Network } from './network'

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36'
const SENSOR = /document\.cookie = '_abck=([^;']+);/

/** Checked before each hop is requested; throws to stop the navigation there. */
type HopGuard = (url: string) => void

/** One tab: a URL, its parsed document, and the partition's cookies. */
class Tab {
  url = 'about:blank'
  doc: Doc = parseHtml('')
  readonly committed: string[] = []

  constructor(
    private readonly network: Network,
    readonly jar: CookieJar,
    private readonly guard: HopGuard,
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
      return
    }
    throw new SiteAdapterError('navigate', 'invalid')
  }

  /** The fake's inline sensor script sets a script-readable `_abck` when there is none. */
  private runSensor(html: string): void {
    const value = SENSOR.exec(html)?.[1]
    const host = new URL(this.url).hostname
    if (value !== undefined && !this.jar.has(host, '_abck')) {
      this.jar.set({ name: '_abck', value, host, httpOnly: false })
    }
  }

  element(selector: string): Element {
    const element = query(this.doc, selector)
    if (element === null || !isVisible(element)) throw new SiteAdapterError('auth-step', 'element-missing')
    return element
  }

  /** Submits the form `submitter` is in, as a browser would, with the submitter's own name and value. */
  async submit(submitter: Element): Promise<void> {
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
  private focused: { element: Element; doc: Doc } | null = null

  constructor(network: Network, jar: CookieJar, navigation: readonly string[]) {
    this.tab = new Tab(network, jar, (url) => {
      // Every hop, redirects included, before it is requested: an open redirect stops here.
      if (!urlOriginAllowed(url, navigation)) throw new SiteAdapterError('navigate', 'navigation-escaped')
    })
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

  async inspect(selector: string): Promise<ElementInfo | null> {
    const element = query(this.tab.doc, selector)
    if (element === null) return null
    const form = element.form === null ? null : (this.tab.doc.forms[element.form] ?? null)
    return {
      visible: isVisible(element),
      tagName: element.tag.toUpperCase(),
      inputType: element.tag === 'input' ? (element.attrs.get('type') ?? 'text').toLowerCase() : null,
      autocomplete: element.attrs.get('autocomplete') ?? null,
      inputMode: element.attrs.get('inputmode') ?? null,
      frameOrigin: new URL(this.tab.url).origin,
      formActionOrigin:
        form === null ? null : new URL(form.attrs.get('action') || this.tab.url, this.tab.url).origin,
      inputReachable: true,
    }
  }

  async click(selector: string): Promise<void> {
    const element = this.tab.element(selector)
    this.focused = null
    if (element.tag === 'input' && element.attrs.get('type') === 'checkbox') {
      element.checked = !element.checked
      return
    }
    if (element.tag === 'button' && (element.attrs.get('type') ?? 'submit') === 'submit') {
      await this.tab.submit(element)
      return
    }
    const href = element.attrs.get('href')
    if (element.tag === 'a' && href !== undefined) await this.tab.navigate('GET', href)
  }

  async focus(selector: string): Promise<void> {
    this.focused = { element: this.tab.element(selector), doc: this.tab.doc }
  }

  async type(text: string | SecretValue, options: TypeOptions = {}): Promise<void> {
    const focused = this.focused
    if (focused === null) throw new SiteAdapterError('auth-step', 'element-missing')
    const { allowedOrigins } = options
    if (text instanceof SecretValue && allowedOrigins === undefined) {
      throw new SiteAdapterError('secret-fill', 'origin-mismatch')
    }
    const keystroke = async (character: string): Promise<void> => {
      // Before every key: still the same document, still focused, still an allowed origin.
      const moved = this.tab.doc !== focused.doc || this.focused !== focused
      if (moved || (allowedOrigins !== undefined && !urlOriginAllowed(this.tab.url, allowedOrigins))) {
        throw new SiteAdapterError('secret-fill', 'origin-mismatch')
      }
      focused.element.value += character
    }
    if (typeof text === 'string') {
      for (const character of text) await keystroke(character)
    } else {
      await text.revealEach(keystroke)
    }
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
const REFUSALS: Readonly<Record<BlockedRequest['reason'], SiteAdapterError>> = {
  'host-not-allowed': new SiteAdapterError('egress', 'host-not-allowed'),
  undeclared: new SiteAdapterError('request-surface', 'undeclared-request'),
  'denied-path': new SiteAdapterError('request-surface', 'denied-path'),
  'ambiguous-path': new SiteAdapterError('request-surface', 'ambiguous-path'),
  'purpose-exceeded': new SiteAdapterError('request-surface', 'denied-path'),
  'request-ceiling': new SiteAdapterError('request-surface', 'request-ceiling'),
  'bad-url': new SiteAdapterError('request-surface', 'invalid'),
}

interface Run {
  readonly policy: ToolRunPolicy
  readonly onBlocked: (request: BlockedRequest) => void
  used: number
  unlocked: boolean
}

/** The tool partition's page, as tool code sees it. */
class HarnessToolPage implements ToolPage {
  constructor(
    private readonly tab: Tab,
    private readonly network: Network,
    private readonly driver: HarnessDriver,
  ) {}

  async goto(url: string): Promise<void> {
    this.driver.admitNavigation(new URL(url, this.tab.url).href)
    await this.tab.navigate('GET', url)
  }

  currentUrl(): string {
    return this.tab.url
  }

  async fetch(pathOrUrl: string, init: FetchInit = {}): Promise<FetchResult> {
    const method = (init.method ?? 'GET').toUpperCase()
    const url = new URL(pathOrUrl, this.tab.url).href
    this.driver.admitApiCall(method, url)
    const headers: Record<string, string> = {
      'user-agent': USER_AGENT,
      accept: 'application/json',
      ...init.headers,
    }
    const cookie = this.tab.jar.header(url)
    if (cookie !== '') Object.assign(headers, { cookie })
    let body: string | undefined
    if (init.json !== undefined) {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(init.json)
    }
    const response = await this.network.send(method, url, headers, body)
    for (const line of response.headers['set-cookie'] ?? []) this.tab.jar.receive(url, line)
    const contentType = response.headers['content-type'] ?? null
    return { status: response.status, contentType, body: parseBody(contentType, response.body) }
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
  throw new SiteAdapterError('tool-run', 'unsupported')
}

export class HarnessDriver implements SessionDriver {
  readonly authJar = new CookieJar()
  readonly toolJar = new CookieJar()
  /** Every auth page opened, so tests can look at where each one went. */
  readonly authPages: HarnessAuthPage[] = []
  /** Every request refused in the tool partition. */
  readonly blocked: BlockedRequest[] = []
  private tool: HarnessToolPage | null = null
  private toolTab: Tab | null = null
  private run: Run | null = null

  constructor(
    private readonly network: Network,
    private readonly home: string,
    private readonly navigation: readonly string[],
  ) {}

  async openAuthPage(): Promise<AuthPage> {
    const page = new HarnessAuthPage(this.network, this.authJar, this.navigation)
    this.authPages.push(page)
    return page
  }

  async toolPage(): Promise<ToolPage> {
    if (this.tool === null) {
      const tab = new Tab(this.network, this.toolJar, () => {})
      this.toolTab = tab
      this.tool = new HarnessToolPage(tab, this.network, this)
      await this.tool.goto(this.home)
    }
    return this.tool
  }

  /** The tool partition's own cookie header for `url`, for the runtime's probe. */
  toolCookies(url: string): string {
    return this.toolTab === null ? '' : this.toolTab.jar.header(url)
  }

  async handoff(cookieDomains: readonly string[], _storage: readonly unknown[]): Promise<void> {
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
    this.run = { policy, onBlocked, used: 0, unlocked: false }
  }

  unlockIrreversible(): void {
    if (this.run !== null) this.run.unlocked = true
  }

  endRun(): void {
    this.run = null
  }

  async close(): Promise<void> {
    this.tool = null
    this.toolTab = null
  }

  admitNavigation(url: string): void {
    const run = this.run
    if (run === null) return
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || !hostAllowed(parsed.hostname, run.policy.egress)) {
      this.refuse(run, 'GET', parsed, 'host-not-allowed')
    }
    this.count(run, 'GET', parsed)
  }

  admitApiCall(method: string, url: string): void {
    const run = this.run
    if (run === null) throw new SiteAdapterError('request-surface', 'undeclared-request')
    const parsed = new URL(url)
    const decision = decideRequest(method, url, run.policy.egress, run.policy.requests)
    if (!decision.allowed) this.refuse(run, method, parsed, decision.reason)
    const purpose = decision.declaration.purpose
    const locked = purpose === 'irreversible' && !run.unlocked
    if (RANK[purpose] > RANK[run.policy.maxPurpose] || locked)
      this.refuse(run, method, parsed, 'purpose-exceeded')
    this.count(run, method, parsed)
  }

  private count(run: Run, method: string, url: URL): void {
    if (run.used >= run.policy.ceiling) this.refuse(run, method, url, 'request-ceiling')
    run.used += 1
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
