// The real site's origins. Tool code derives the API's from the page it is on, so the same code
// serves a fake: the API is the page's host with "query1." in front.

import { httpsOriginOf, originOf, type ToolContext, urlOn } from '@valet/core'

export const REAL_ORIGIN = 'https://finance.yahoo.com'
export const REAL_API_ORIGIN = 'https://query1.finance.yahoo.com'

export function apiOriginFor(origin: string): string {
  if (origin === REAL_ORIGIN) return REAL_API_ORIGIN
  const bare = originOf(origin)
  if (bare === null) throw new TypeError('not an http(s) origin')
  const at = bare.indexOf('://') + 3
  return `${bare.slice(0, at)}query1.${bare.slice(at)}`
}

/**
 * `path` on the tool page's own origin, so the same code serves the real site and a fake. Before
 * the page has loaded anything (about:blank), the real site.
 */
export function siteUrl(ctx: ToolContext, path: string): string {
  return urlOn(httpsOriginOf(ctx.page.currentUrl()) ?? REAL_ORIGIN, path)
}
