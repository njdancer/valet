// The tool partition's page, as tool code sees it through the capability API. Adapter code may run
// here, in an isolated world of its own. The partition's request filter and proxy (see driver.ts)
// are what keep anything it learns from leaving for a host the manifest doesn't declare, and hold
// every request to the request surface however it was made; the checks here only fail early and
// with a clear error class.

import { type FetchInit, type FetchResult, SiteAdapterError, type ToolPage } from '@siteadapter/core'
import { egressAllowed } from './guards'
import { characters, isRecord, PageCore, type PageTiming } from './page-core'
import type { BrowserSurface, FrameHandle } from './platform'
import { evaluateScript, extractScript, fetchScript } from './scripts'

const METHOD = /^[A-Z]{1,16}$/

export class SurfaceToolPage implements ToolPage {
  private readonly core: PageCore

  constructor(
    private readonly surface: BrowserSurface,
    private readonly egress: readonly string[],
    private readonly timing: PageTiming,
  ) {
    this.core = new PageCore(surface, timing)
  }

  goto(url: string): Promise<void> {
    return this.core.step('navigate', async () => {
      const target = this.resolve(url)
      const failure = await this.core.load(target)
      if (failure === 'ERR_BLOCKED_BY_CLIENT') throw new SiteAdapterError('egress', 'host-not-allowed')
      if (failure !== null) throw new SiteAdapterError('navigate', 'unavailable')
    })
  }

  currentUrl(): string {
    return this.surface.url()
  }

  click(selector: string): Promise<void> {
    return this.core.step('tool-run', (signal) => this.core.click('tool-run', selector, signal))
  }

  /** Types literal text as trusted input. Tool pages never receive secrets. */
  async fill(selector: string, text: string): Promise<void> {
    if (typeof text !== 'string') throw new SiteAdapterError('tool-input', 'invalid')
    const chars = characters(text)
    const delayMs = this.timing.typingDelayMs
    await this.core.step(
      'tool-run',
      async (signal) => {
        const target = await this.core.focus('tool-run', selector, signal)
        await this.core.typeChars('tool-run', signal, chars.length, delayMs, target.frameId, (index) =>
          this.surface.sendChar(chars[index] ?? ''),
        )
      },
      chars.length * delayMs,
    )
  }

  extract(
    selector: string,
    options?: { readonly attribute?: string; readonly all?: boolean },
  ): Promise<unknown> {
    const script = extractScript(selector, options?.attribute ?? null, options?.all ?? false)
    return this.core.step('tool-run', async () => {
      const raw = await this.mainFrame().run(script)
      if (!isRecord(raw)) throw new SiteAdapterError('tool-run', 'internal')
      if (raw['error'] === 'invalid-selector') throw new SiteAdapterError('tool-run', 'invalid')
      return raw['value'] ?? null
    })
  }

  async evaluate(source: string, args?: unknown): Promise<unknown> {
    if (typeof source !== 'string') throw new SiteAdapterError('tool-input', 'invalid')
    let script: string
    try {
      script = evaluateScript(source, args)
    } catch {
      throw new SiteAdapterError('tool-input', 'invalid')
    }
    return this.core.step('tool-run', () => this.mainFrame().runAdapter(script))
  }

  async fetch(pathOrUrl: string, init?: FetchInit): Promise<FetchResult> {
    const method = (init?.method ?? 'GET').toUpperCase()
    if (!METHOD.test(method)) throw new SiteAdapterError('tool-input', 'invalid')
    const headers = init?.headers ?? {}
    if (!isRecord(headers) || Object.values(headers).some((value) => typeof value !== 'string')) {
      throw new SiteAdapterError('tool-input', 'invalid')
    }
    const hasJson = init !== undefined && 'json' in init && init.json !== undefined
    let script: string
    try {
      script = fetchScript({
        url: this.resolve(pathOrUrl),
        method,
        headers,
        hasJson,
        json: hasJson ? init.json : null,
      })
    } catch (error) {
      if (error instanceof SiteAdapterError) throw error
      throw new SiteAdapterError('tool-input', 'invalid')
    }
    return this.core.step('tool-run', async () => {
      const raw = await this.mainFrame().run(script)
      if (isRecord(raw) && raw['error'] === 'network') throw new SiteAdapterError('tool-run', 'unavailable')
      if (!isRecord(raw) || typeof raw['status'] !== 'number')
        throw new SiteAdapterError('tool-run', 'internal')
      const contentType = raw['contentType']
      return {
        status: raw['status'],
        contentType: typeof contentType === 'string' ? contentType : null,
        body: raw['body'] ?? null,
      }
    })
  }

  async close(): Promise<void> {
    if (!this.surface.isDestroyed()) this.surface.destroy()
  }

  /** Resolves a path against the current page and refuses anything off the egress list. */
  private resolve(pathOrUrl: string): string {
    let url: URL
    try {
      // Before the first load there is no page URL, and only an absolute URL makes sense.
      url = new URL(pathOrUrl, this.surface.url() || undefined)
    } catch {
      throw new SiteAdapterError('tool-input', 'invalid')
    }
    if (url.protocol !== 'https:' || !egressAllowed(url.href, this.egress)) {
      throw new SiteAdapterError('egress', 'host-not-allowed')
    }
    return url.href
  }

  private mainFrame(): FrameHandle {
    const frame = this.surface.frames()[0]
    if (frame === undefined) throw new SiteAdapterError('tool-run', 'aborted')
    return frame
  }
}
