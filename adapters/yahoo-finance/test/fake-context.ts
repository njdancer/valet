// A ToolContext over captured pages. goto() loads a fixture page by its quote URL; extract() finds
// an embedded-response script by the data-url fragment in its selector, the one form of selector
// the adapter uses; fetch() checks each request against the manifest's request surface first, as
// the runtime does, then serves a canned response.

import { readFileSync } from 'node:fs'
import {
  type AdapterManifest,
  decideRequest,
  type EnsureResult,
  type FetchInit,
  type FetchResult,
  type ToolContext,
  type ToolPage,
  ValetError,
} from '@valet/core'
import { createManifest } from '../src/manifest'

export const FAKE_ORIGIN = 'https://finance.yahoo.test'

export function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
}

export function json(body: unknown, status = 200): FetchResult {
  return { status, contentType: 'application/json;charset=utf-8', body }
}

/** Decodes the five entities an HTML attribute value can carry here. */
function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

export class FakeYahoo implements ToolContext {
  readonly visits: string[] = []
  readonly fetches: string[] = []
  readonly blocked: string[] = []
  readonly controller = new AbortController()
  readonly signal = this.controller.signal
  /** Quote pages by path, e.g. "/quote/AAPL/" → fixture HTML. Anything else is a 404 sent home. */
  readonly pages = new Map<string, string>()
  readonly routes = new Map<string, FetchResult>()
  private url = 'about:blank'

  constructor(readonly manifest: AdapterManifest = createManifest({ origin: FAKE_ORIGIN })) {}

  readonly session = {
    ensure: async (): Promise<EnsureResult> => {
      throw new Error('no tool of this adapter logs in')
    },
  }

  async confirm(): Promise<boolean> {
    throw new Error('confirm is not used by this adapter')
  }

  private html(): string | null {
    return this.pages.get(new URL(this.url).pathname) ?? null
  }

  readonly page: ToolPage = {
    goto: async (url: string) => {
      const target = new URL(url)
      if (!this.manifest.egress.includes(target.hostname)) throw new ValetError('egress', 'host-not-allowed')
      this.visits.push(url)
      // An unknown symbol's 404 page sends the browser home with ?err=404.
      this.url = this.pages.has(target.pathname) ? target.href : `${target.origin}/?err=404`
    },
    currentUrl: () => this.url,
    click: async () => {
      throw new Error('not used')
    },
    fill: async () => {
      throw new Error('not used')
    },
    evaluate: async () => {
      throw new Error('not used')
    },
    extract: async (selector: string) => {
      const html = this.html()
      if (html === null) return null
      const fragment = /\[data-url\*="([^"]+)"\]/.exec(selector)?.[1]
      if (fragment === undefined) throw new Error(`unexpected selector ${selector}`)
      for (const m of html.matchAll(
        /<script type="application\/json" data-sveltekit-fetched data-url="([^"]*)"[^>]*>([\s\S]*?)<\/script>/g,
      )) {
        if (decodeEntities(m[1] ?? '').includes(fragment)) return (m[2] ?? '').trim()
      }
      return null
    },
    fetch: async (pathOrUrl: string, init?: FetchInit): Promise<FetchResult> => {
      const method = (init?.method ?? 'GET').toUpperCase()
      const url = new URL(pathOrUrl, this.url)
      const decision = decideRequest(method, url.href, this.manifest.egress, this.manifest.requests)
      if (!decision.allowed) {
        this.blocked.push(`${method} ${url.href}`)
        throw new ValetError('request-surface', 'undeclared-request')
      }
      this.fetches.push(url.href)
      const response = this.routes.get(url.pathname)
      if (response === undefined) return json({ error: 'no route' }, 404)
      return response
    },
  }
}

/** A context on the fake's home page, with the four captured quote pages. */
export function yahoo(): FakeYahoo {
  const ctx = new FakeYahoo()
  ctx.pages.set('/quote/AAPL/', fixture('quote-aapl.html'))
  ctx.pages.set('/quote/BHP.AX/', fixture('quote-bhpax.html'))
  ctx.pages.set('/quote/%5EGSPC/', fixture('quote-gspc.html'))
  ctx.pages.set('/quote/AUDUSD%3DX/', fixture('quote-audusd.html'))
  ctx.pages.set('/', '<!doctype html><title>home</title>')
  void ctx.page.goto(`${FAKE_ORIGIN}/`)
  return ctx
}
