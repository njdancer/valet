// The fixture browser (docs/authoring-tools.md#the-agents-cases): a case's pages, served from the
// draft's fixtures into an in-memory partition that reaches nothing else, so tool code that reads
// the DOM (extract, evaluate, click, fill) can be tested without the site. The page is the runtime's
// own SurfaceToolPage; fetch is the case's to answer, not the browser's.
//
// What the partition does: answers https from the fixtures (anything else is a 404), runs none of
// the fixture's own scripts (a CSP on every answer), loads a page the case lacks as a 404, cancels
// every other request that isn't for a fixture, and sends nothing to the network (a proxy that refuses every host).

import { ValetError } from '@valet/core'
import type { PageTiming } from './page-core'
import type { BrowserPlatform, BrowserSurface, FixtureResponse, ProxyHandle, Timers } from './platform'
import { realTimers } from './platform'
import { SurfaceToolPage } from './tool-page'

export interface FixtureBrowserOptions {
  readonly platform: BrowserPlatform
  /** In memory, new for each case. */
  readonly partition: string
  /** Absolute https URL → the page's HTML. */
  readonly pages: Readonly<Record<string, string>>
  /** The manifest's egress, which SurfaceToolPage resolves and checks goto() against. */
  readonly egress: readonly string[]
  readonly timers?: Timers
  readonly stepTimeoutMs?: number
}

export const FIXTURE_LIMITS = { pages: 20, pageChars: 2_000_000, stepTimeoutMs: 5_000 } as const

export class FixtureBrowser {
  private closed = false

  private constructor(
    private readonly surface: BrowserSurface,
    private readonly proxy: ProxyHandle,
    readonly page: SurfaceToolPage,
  ) {}

  static async open(options: FixtureBrowserOptions): Promise<FixtureBrowser> {
    if (options.partition.startsWith('persist:')) throw new ValetError('config', 'invalid')
    const entries = Object.entries(options.pages)
    if (entries.length > FIXTURE_LIMITS.pages) throw new ValetError('config', 'invalid')
    const pages = new Map<string, string>()
    for (const [url, html] of entries) {
      const parsed = parse(url)
      if (parsed === null || parsed.protocol !== 'https:' || html.length > FIXTURE_LIMITS.pageChars)
        throw new ValetError('config', 'invalid')
      pages.set(key(parsed), html)
    }
    const answer = (url: string): FixtureResponse | null => {
      const parsed = parse(url)
      const html = parsed === null ? undefined : pages.get(key(parsed))
      return html === undefined ? null : { status: 200, contentType: 'text/html; charset=utf-8', body: html }
    }
    const { platform } = options
    const session = platform.session(options.partition)
    session.harden()
    session.serveOnly(answer)
    session.filterRequests((request) => {
      const url = parse(request.url)
      if (url === null) return false
      if (url.protocol === 'about:' || url.protocol === 'data:') return true
      if (request.method !== 'GET' || url.protocol !== 'https:') return false
      // A page the case lacks loads as the handler's 404, so the tool sees what a missing page is;
      // anything else a page asks for is served only if it is a fixture.
      const document = request.resourceType === 'mainFrame' || request.resourceType === 'subFrame'
      return document || answer(request.url) !== null
    })
    const proxy = await platform.startProxy(() => false)
    await session.useProxy(proxy)
    const surface = platform.openSurface(options.partition)
    const timing: PageTiming = {
      timers: options.timers ?? realTimers,
      stepTimeoutMs: options.stepTimeoutMs ?? FIXTURE_LIMITS.stepTimeoutMs,
      typingDelayMs: 0,
      keyEvents: 'char',
    }
    return new FixtureBrowser(surface, proxy, new SurfaceToolPage(surface, options.egress, timing))
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.surface.destroy()
    void this.proxy.close().catch(() => undefined)
  }
}

function parse(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

/** A page by origin, path and query; the fragment never reaches the handler. */
function key(url: URL): string {
  return `${url.origin}${url.pathname}${url.search}`
}
