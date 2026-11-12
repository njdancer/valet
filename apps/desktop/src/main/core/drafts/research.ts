// The scratch browsers agents study sites with while writing a draft
// (docs/authoring-tools.md#the-scratch-browser-pr-2). One per draft, signed out and in memory; this
// module decides what each may reach (the draft's own domains for pages, never a signed-in site's),
// paces page loads per site, closes idle ones, and scrubs what the network log hands the agent.
// The browser itself is @valet/browser-electron's ScratchBrowser, which the app opens.

import type { LogEntry, ScratchRules, ScratchSnapshot, ScratchTarget } from '@valet/browser-electron'
import type { AdapterManifest } from '@valet/core'
import { siteDomain } from './checks'

export const RESEARCH_LIMITS = {
  /** Open scratch browsers per agent, and in all. */
  perClient: 1,
  total: 3,
  idleMs: 10 * 60_000,
  /** Page loads per registrable domain per hour, across every draft. */
  navigationsPerDomainPerHour: 30,
  /** The least time between two page loads on one domain. */
  minGapMs: 3000,
  bodyChars: 20_000,
  stringChars: 80,
  arrayItems: 20,
  textChars: 4000,
} as const

/** What the app's browser gives this module: ScratchBrowser's methods. */
export interface ScratchHandle {
  navigate(url: string): Promise<ScratchSnapshot>
  click(target: ScratchTarget): Promise<ScratchSnapshot>
  type(target: ScratchTarget, text: string): Promise<ScratchSnapshot>
  snapshot(options?: { readonly root?: string; readonly maxNodes?: number }): Promise<ScratchSnapshot>
  query(selector: string): Promise<{
    readonly count: number
    readonly matches: readonly {
      readonly tag: string
      readonly id: string | null
      readonly classes: string
      readonly text: string
      readonly visible: boolean
    }[]
  }>
  entries(filter?: { readonly sinceSeq?: number; readonly host?: string; readonly type?: string }): LogEntry[]
  body(seq: number): Promise<{ readonly entry: LogEntry; readonly text: string } | null>
  document(): Promise<string>
  isClosed(): boolean
  onClosed(listener: () => void): void
  close(): void
}

export interface ResearchDeps {
  /** Opens a scratch browser for the draft under `rules`. Throws ScratchError in words. */
  readonly open: (draftId: string, rules: ScratchRules) => Promise<ScratchHandle>
  /**
   * The registrable domains of installed adapters that hold a signed-in session or a grant, by
   * adapter id: a scratch browser never reaches them, except the draft's own adapter's.
   */
  readonly signedIn: () => Promise<ReadonlyMap<string, readonly string[]>>
  /** True when the text holds a login secret or session value Valet knows of: never typed. */
  readonly secretIn: (text: string) => Promise<boolean>
  /** The site refused a scratch browser: trip its breaker, tell the person. */
  readonly blocked: (host: string, status: number) => void
  readonly notify: (text: string) => void
  readonly now: () => number
  readonly timers?: {
    setTimeout(run: () => void, ms: number): unknown
    clearTimeout(handle: unknown): void
  }
}

interface Open {
  readonly handle: ScratchHandle
  readonly client: string
  idle: unknown
}

/** A refusal for the agent; the authoring layer turns it into AuthoringRefusal. */
export class ResearchRefusal extends Error {
  constructor(readonly detail: string) {
    super(detail)
    this.name = 'ResearchRefusal'
  }
}

export class ScratchSessions {
  private readonly open = new Map<string, Open>()
  private readonly loads = new Map<string, number[]>()
  private readonly opening = new Map<string, Promise<ScratchHandle>>()

  constructor(private readonly deps: ResearchDeps) {}

  /** The draft's browser, opened now if it isn't, under rules from `manifest` as it is now. */
  async browser(
    draftId: string,
    client: string,
    clientName: string,
    adapterId: string,
    manifest: AdapterManifest | null,
  ): Promise<ScratchHandle> {
    const existing = this.open.get(draftId)
    if (existing !== undefined && !existing.handle.isClosed()) {
      this.touch(draftId)
      return existing.handle
    }
    const pending = this.opening.get(draftId)
    if (pending !== undefined) return pending
    const mine = [...this.open.values()].filter((o) => o.client === client && !o.handle.isClosed())
    if (mine.length >= RESEARCH_LIMITS.perClient)
      throw new ResearchRefusal(
        'You have a scratch browser open for another draft. Close that draft’s first.',
      )
    if (this.live() >= RESEARCH_LIMITS.total)
      throw new ResearchRefusal(
        'Valet has as many scratch browsers open as it allows. Try again in a few minutes.',
      )
    if (manifest === null)
      throw new ResearchRefusal(
        'The draft’s manifest.json doesn’t parse, so Valet can’t tell which site it is for.',
      )
    const opening = this.start(draftId, client, clientName, adapterId, manifest)
    this.opening.set(draftId, opening)
    try {
      return await opening
    } finally {
      this.opening.delete(draftId)
    }
  }

  /** The draft's open browser, or a refusal saying to open one. */
  current(draftId: string): ScratchHandle {
    const open = this.open.get(draftId)
    if (open === undefined || open.handle.isClosed())
      throw new ResearchRefusal('No scratch browser is open for this draft. valet_browser_open opens one.')
    this.touch(draftId)
    return open.handle
  }

  close(draftId: string): void {
    this.open.get(draftId)?.handle.close()
  }

  /** On lockdown, pause or quit. */
  closeAll(): void {
    for (const open of [...this.open.values()]) open.handle.close()
  }

  private live(): number {
    return [...this.open.values()].filter((o) => !o.handle.isClosed()).length
  }

  private async start(
    draftId: string,
    client: string,
    clientName: string,
    adapterId: string,
    manifest: AdapterManifest,
  ): Promise<ScratchHandle> {
    const domains = draftDomains(manifest)
    const signedIn = await this.deps.signedIn()
    const refused = new Set<string>()
    let ownSignedIn = false
    for (const [id, list] of signedIn) {
      if (id === adapterId) {
        if (list.some((d) => domains.includes(d))) ownSignedIn = true
        continue
      }
      for (const d of list) refused.add(d)
    }
    const rules: ScratchRules = {
      mayNavigate: (url) => url.protocol === 'https:' && domains.includes(siteDomain(url.hostname)),
      mayRequest: (url) => !refused.has(siteDomain(url.hostname)),
      pace: (host) => this.pace(siteDomain(host)),
      blocked: (host, status) => this.deps.blocked(host, status),
      mayType: async (text) => !(await this.deps.secretIn(text).catch(() => true)),
    }
    const handle = await this.deps.open(draftId, rules)
    const entry: Open = { handle, client, idle: null }
    this.open.set(draftId, entry)
    handle.onClosed(() => {
      const timers = this.deps.timers
      if (entry.idle !== null && timers !== undefined) timers.clearTimeout(entry.idle)
      if (this.open.get(draftId) === entry) this.open.delete(draftId)
    })
    this.touch(draftId)
    // A site the person is signed in to scores this Mac's address; a signed-out look still counts.
    if (ownSignedIn)
      this.deps.notify(`${clientName} is looking at ${domains[0] ?? 'the site'} in a signed-out browser.`)
    return handle
  }

  private touch(draftId: string): void {
    const entry = this.open.get(draftId)
    const timers = this.deps.timers
    if (entry === undefined || timers === undefined) return
    if (entry.idle !== null) timers.clearTimeout(entry.idle)
    entry.idle = timers.setTimeout(() => entry.handle.close(), RESEARCH_LIMITS.idleMs)
  }

  private async pace(domain: string): Promise<void> {
    const now = this.deps.now()
    const recent = (this.loads.get(domain) ?? []).filter((t) => t > now - 3600_000)
    if (recent.length >= RESEARCH_LIMITS.navigationsPerDomainPerHour) {
      const wait = Math.ceil(((recent[0] ?? now) + 3600_000 - now) / 60_000)
      throw new ResearchRefusal(
        `Valet has loaded ${domain} as often as it allows in an hour. Try again in ${wait} minutes.`,
      )
    }
    const last = recent.at(-1)
    if (last !== undefined && now - last < RESEARCH_LIMITS.minGapMs) {
      const seconds = Math.ceil((RESEARCH_LIMITS.minGapMs - (now - last)) / 1000)
      throw new ResearchRefusal(`Wait ${seconds} seconds: Valet spaces page loads on ${domain}.`)
    }
    recent.push(now)
    this.loads.set(domain, recent)
  }
}

/** The registrable domains a draft's pages may be on: from its home, navigation and egress. */
export function draftDomains(manifest: AdapterManifest): string[] {
  const hosts = new Set<string>()
  const add = (value: string) => {
    try {
      hosts.add(
        siteDomain(new URL(value.includes('://') ? value : `https://${value.replace(/^\*\./, '')}`).hostname),
      )
    } catch {
      // Not a host; the manifest check reports it.
    }
  }
  add(manifest.home)
  for (const origin of manifest.navigation) add(origin)
  for (const host of manifest.egress) add(host)
  return [...hosts]
}

/**
 * A URL for the agent: identifier-like path segments as :param, query values as their type and
 * length, so a session or account id in a URL never reaches the log.
 */
export function scrubUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return '(invalid)'
  }
  if (url.protocol === 'data:') return 'data:…'
  const path = url.pathname
    .split('/')
    .map((segment) => (identifierLike(segment) ? ':param' : segment.slice(0, 60)))
    .join('/')
  const query = [...url.searchParams.entries()]
    .slice(0, 20)
    .map(
      ([key, value]) =>
        `${key.slice(0, 40)}=<${/^-?\d+(\.\d+)?$/.test(value) ? 'number' : 'text'}:${value.length}>`,
    )
  return `${url.origin}${path}${query.length === 0 ? '' : `?${query.join('&')}`}`
}

function identifierLike(segment: string): boolean {
  if (segment.length === 0) return false
  if (/^\d{4,}$/.test(segment)) return true
  if (/^[0-9a-f]{16,}$/i.test(segment)) return true
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return true
  return segment.length >= 20 && /\d/.test(segment) && /[A-Za-z]/.test(segment) && !/[-_.]/.test(segment)
}

const SECRET_KEY = /token|csrf|auth|session|secret|password|passwd|cookie|apikey|api_key|signature/i

/**
 * A response body for the agent: JSON as JSON with long strings cut, long arrays cut and values
 * under secret-looking keys hidden; HTML refused (pages are read by snapshot); other text cut.
 */
export function scrubBody(
  text: string,
  mimeType: string | null,
): { readonly value: unknown; readonly truncated: boolean } | { readonly refused: string } {
  const type = (mimeType ?? '').toLowerCase()
  if (type.includes('html'))
    return {
      refused:
        'That response is a page; read it with valet_browser_snapshot, or save it with valet_capture_fixture.',
    }
  if (type.startsWith('image/') || type.startsWith('font/') || type.includes('octet-stream'))
    return { refused: 'That response isn’t text.' }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    const cut = text.length > RESEARCH_LIMITS.textChars
    return { value: text.slice(0, RESEARCH_LIMITS.textChars), truncated: cut }
  }
  let truncated = false
  const walk = (value: unknown, depth: number): unknown => {
    if (typeof value === 'string') {
      if (value.length > RESEARCH_LIMITS.stringChars) truncated = true
      return value.slice(0, RESEARCH_LIMITS.stringChars)
    }
    if (value === null || typeof value !== 'object') return value
    if (depth > 12) {
      truncated = true
      return '…'
    }
    if (Array.isArray(value)) {
      if (value.length > RESEARCH_LIMITS.arrayItems) truncated = true
      return value.slice(0, RESEARCH_LIMITS.arrayItems).map((item) => walk(item, depth + 1))
    }
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value).slice(0, 100))
      out[key.slice(0, 80)] = SECRET_KEY.test(key) ? '[hidden]' : walk(item, depth + 1)
    return out
  }
  let value = walk(parsed, 0)
  if (JSON.stringify(value).length > RESEARCH_LIMITS.bodyChars) {
    truncated = true
    value = JSON.stringify(value).slice(0, RESEARCH_LIMITS.bodyChars)
  }
  return { value, truncated }
}

/** What capture may write a fixture as: the body's own type, by the path's extension. */
export function fixtureFits(path: string, mimeType: string | null, page: boolean): string | null {
  if (!/^fixtures\/[a-z0-9][a-z0-9._/-]*\.(json|html|txt)$/.test(path))
    return 'A fixture goes under fixtures/ as .json, .html or .txt.'
  const ext = path.slice(path.lastIndexOf('.') + 1)
  if (page) return ext === 'html' ? null : 'A page is saved as fixtures/<name>.html.'
  const type = (mimeType ?? '').toLowerCase()
  if (type.includes('json'))
    return ext === 'json' ? null : 'A JSON response is saved as fixtures/<name>.json.'
  if (type.includes('html'))
    return ext === 'html' ? null : 'An HTML response is saved as fixtures/<name>.html.'
  if (type.startsWith('text/'))
    return ext === 'txt' || ext === 'json' ? null : 'Save text as fixtures/<name>.txt.'
  return 'Only JSON, HTML and text responses are saved as fixtures.'
}
