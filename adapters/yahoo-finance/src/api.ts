// Calls to the site's JSON API on its query1 host, from the tool page (which is on the site), so
// the browser sends them as the site's own pages do. Every failure leaves as a ValetError with no
// page text in it.

import { type FetchResult, httpsOriginOf, type ToolContext, urlOn, ValetError } from '@valet/core'
import { apiOriginFor, REAL_ORIGIN } from './origins'
import { siteUrl } from './quote'

export async function getApi(
  ctx: ToolContext,
  path: string,
  query: Record<string, string>,
): Promise<unknown> {
  if (ctx.signal.aborted) throw new ValetError('tool-run', 'aborted')
  const url = urlOn(apiOriginFor(httpsOriginOf(siteUrl(ctx, '/')) ?? REAL_ORIGIN), path, query)
  let response: FetchResult
  try {
    response = await ctx.page.fetch(url, { headers: { accept: 'application/json' } })
  } catch (error) {
    if (error instanceof ValetError) throw error
    throw new ValetError('tool-run', 'unavailable')
  }
  const isJson = (response.contentType ?? '').toLowerCase().includes('json')
  if (response.status === 429) throw new ValetError('tool-run', 'rate-limited')
  if (response.status === 403) throw new ValetError('tool-run', 'blocked-by-site')
  // The chart API answers an unknown symbol 404 with JSON that says so.
  if (response.status === 404) throw new ValetError('tool-run', 'not-found')
  if (response.status < 200 || response.status >= 300) throw new ValetError('tool-run', 'unavailable')
  if (!isJson || typeof response.body !== 'object' || response.body === null) {
    throw new ValetError('tool-run', 'unexpected-shape')
  }
  return response.body
}
