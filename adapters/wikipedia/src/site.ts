// Calls to Wikipedia's APIs from the tool page, which is on the site, so they are same-origin.

import { type FetchResult, httpsOriginOf, type ToolContext, urlOn, ValetError } from '@valet/core'

export const REAL_ORIGIN = 'https://en.wikipedia.org'

/** Wikimedia asks API clients to say who they are (its User-Agent policy). */
const API_USER_AGENT = 'Valet/0.1 (https://github.com/njdancer/valet)'

/** `path` on the tool page's origin, or the real site's before the page has loaded. */
export function siteUrl(ctx: ToolContext, path: string, query: Record<string, string> = {}): string {
  // about:blank, or nothing yet, means the real site.
  return urlOn(httpsOriginOf(ctx.page.currentUrl()) ?? REAL_ORIGIN, path, query)
}

/** The JSON body, or null for a 404 (no such article). Other failures throw a ValetError. */
export async function getJson(ctx: ToolContext, url: string): Promise<unknown> {
  if (ctx.signal.aborted) throw new ValetError('tool-run', 'aborted')
  let response: FetchResult
  try {
    response = await ctx.page.fetch(url, {
      headers: { accept: 'application/json', 'api-user-agent': API_USER_AGENT },
    })
  } catch (error) {
    if (error instanceof ValetError) throw error
    throw new ValetError('tool-run', 'unavailable')
  }
  if (response.status === 404) return null
  if (response.status === 429) throw new ValetError('tool-run', 'rate-limited')
  if (response.status === 403) throw new ValetError('tool-run', 'blocked-by-site')
  if (response.status < 200 || response.status >= 300) throw new ValetError('tool-run', 'unavailable')
  const isJson = (response.contentType ?? '').toLowerCase().includes('json')
  if (!isJson || typeof response.body !== 'object' || response.body === null) {
    throw new ValetError('tool-run', 'unexpected-shape')
  }
  return response.body
}

export function field(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined
}

export function str(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** Text from an HTML snippet (search excerpts): tags dropped, the common entities decoded. */
export function plain(value: unknown): string | null {
  const raw = str(value)
  if (raw === null) return null
  return str(
    raw
      .replace(/<[^>]*>/g, '')
      .replace(/&quot;/g, '"')
      .replace(/&#0?39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' '),
  )
}

/** The article's link on the site, from its title. */
export function articleUrl(ctx: ToolContext, title: string): string {
  return siteUrl(ctx, `/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`)
}
