// The tool partition's page, as tool code sees it through the capability API. Adapter code may run
// here, in an isolated world of its own. The partition's request filter and proxy (see driver.ts)
// are what keep anything it learns from leaving for a host the manifest doesn't declare, and hold
// every request to the request surface however it was made; the checks here only fail early and
// with a clear error class.

import { type FetchInit, type FetchResult, type ToolPage, ValetError } from '@valet/core'
import { egressAllowed } from './guards'
import { characters, isRecord, PageCore, type PageTiming } from './page-core'
import type { BrowserSurface, FrameHandle } from './platform'
import { evaluateScript, extractScript, fetchScript } from './scripts'

const METHOD = /^[A-Z]{1,16}$/

/**
 * Tells the driver that tool code is about to make this request through the capability API, so
 * that a block report can say the tool, not the page, asked for it. Returns the function that
 * withdraws the announcement once the request has settled.
 */
export type Announce = (method: string, url: string) => () => void

const unannounced: Announce = () => () => {}

export class SurfaceToolPage implements ToolPage {
  private readonly core: PageCore

  constructor(
    private readonly surface: BrowserSurface,
    private readonly egress: readonly string[],
    private readonly timing: PageTiming,
    private readonly announce: Announce = unannounced,
  ) {
    this.core = new PageCore(surface, timing)
  }

  goto(url: string): Promise<void> {
    return this.core.step('navigate', async () => {
      const target = this.resolve(url)
      const withdraw = this.announce('GET', target)
      const failure = await this.core.load(target).finally(withdraw)
      if (failure === 'ERR_BLOCKED_BY_CLIENT') throw new ValetError('egress', 'host-not-allowed')
      if (failure !== null) throw new ValetError('navigate', 'unavailable')
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
    if (typeof text !== 'string') throw new ValetError('tool-input', 'invalid')
    const chars = characters(text)
    const delayMs = this.timing.typingDelayMs
    await this.core.step(
      'tool-run',
      async (signal) => {
        const target = await this.core.focus('tool-run', selector, signal)
        const guard = { stage: 'tool-run', target, moved: 'aborted' } as const
        await this.core.typeChars(guard, signal, chars.length, delayMs, (index) =>
          this.core.sendChar(chars[index] ?? ''),
        )
      },
      this.core.typingBudget(chars.length, delayMs),
    )
  }

  extract(
    selector: string,
    options?: { readonly attribute?: string; readonly all?: boolean },
  ): Promise<unknown> {
    const script = extractScript(selector, options?.attribute ?? null, options?.all ?? false)
    return this.core.step('tool-run', async () => {
      const raw = await this.mainFrame().run(script)
      if (!isRecord(raw)) throw new ValetError('tool-run', 'internal')
      if (raw['error'] === 'invalid-selector') throw new ValetError('tool-run', 'invalid')
      return raw['value'] ?? null
    })
  }

  async evaluate(source: string, args?: unknown): Promise<unknown> {
    if (typeof source !== 'string') throw new ValetError('tool-input', 'invalid')
    let script: string
    try {
      script = evaluateScript(source, args)
    } catch {
      throw new ValetError('tool-input', 'invalid')
    }
    return this.core.step('tool-run', () => this.mainFrame().runAdapter(script))
  }

  async fetch(pathOrUrl: string, init?: FetchInit): Promise<FetchResult> {
    const method = (init?.method ?? 'GET').toUpperCase()
    if (!METHOD.test(method)) throw new ValetError('tool-input', 'invalid')
    const headers = init?.headers ?? {}
    if (!isRecord(headers) || Object.values(headers).some((value) => typeof value !== 'string')) {
      throw new ValetError('tool-input', 'invalid')
    }
    const hasJson = init !== undefined && 'json' in init && init.json !== undefined
    let script: string
    let url: string
    try {
      url = this.resolve(pathOrUrl)
      script = fetchScript({
        url,
        method,
        headers,
        hasJson,
        json: hasJson ? init.json : null,
      })
    } catch (error) {
      if (error instanceof ValetError) throw error
      throw new ValetError('tool-input', 'invalid')
    }
    return this.core.step('tool-run', async () => {
      const withdraw = this.announce(method, url)
      const raw = await this.mainFrame().run(script).finally(withdraw)
      if (isRecord(raw) && raw['error'] === 'network') throw new ValetError('tool-run', 'unavailable')
      if (!isRecord(raw) || typeof raw['status'] !== 'number') throw new ValetError('tool-run', 'internal')
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
      throw new ValetError('tool-input', 'invalid')
    }
    if (url.protocol !== 'https:' || !egressAllowed(url.href, this.egress)) {
      throw new ValetError('egress', 'host-not-allowed')
    }
    return url.href
  }

  private mainFrame(): FrameHandle {
    const frame = this.surface.frames()[0]
    if (frame === undefined) throw new ValetError('tool-run', 'aborted')
    return frame
  }
}
