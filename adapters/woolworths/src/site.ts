// Calls to the site's own JSON API, made through the page so the session's cookies never leave the
// browser. Every failure leaves as a SiteAdapterError: response bodies and exception messages can
// carry page text, so none of it is passed on.

import { type FetchInit, SiteAdapterError, type ToolContext } from '@siteadapter/core'
import type { z } from 'zod'

export const PATHS = {
  search: '/apis/ui/Search/products',
  productDetail: (stockcode: number) => `/apis/ui/product/detail/${stockcode}`,
  trolley: '/apis/ui/Trolley',
  trolleyUpdate: '/api/v3/ui/trolley/update',
} as const

export async function getJson<Schema extends z.ZodType>(
  ctx: ToolContext,
  path: string,
  schema: Schema,
): Promise<z.infer<Schema>> {
  return call(ctx, path, { method: 'GET' }, schema)
}

export async function postJson<Schema extends z.ZodType>(
  ctx: ToolContext,
  path: string,
  json: unknown,
  schema: Schema,
): Promise<z.infer<Schema>> {
  return call(ctx, path, { method: 'POST', json }, schema)
}

async function call<Schema extends z.ZodType>(
  ctx: ToolContext,
  path: string,
  init: FetchInit,
  schema: Schema,
): Promise<z.infer<Schema>> {
  // Checked before every call so that a cancelled add_to_cart never reaches its write.
  if (ctx.signal.aborted) throw new SiteAdapterError('tool-run', 'aborted')
  let response: Awaited<ReturnType<ToolContext['page']['fetch']>>
  try {
    response = await ctx.page.fetch(path, init)
  } catch (error) {
    // The runtime's own guards throw SiteAdapterError; keep their stage and class.
    if (error instanceof SiteAdapterError) throw error
    throw new SiteAdapterError('tool-run', 'unavailable')
  }
  throwForStatus(response.status)
  const parsed = schema.safeParse(response.body)
  if (!parsed.success) throw new SiteAdapterError('tool-run', 'invalid')
  return parsed.data
}

function throwForStatus(status: number): void {
  if (status >= 200 && status < 300) return
  if (status === 401) throw new SiteAdapterError('tool-run', 'not-logged-in')
  // Akamai answers a flagged session with a 403 "Access Denied" page (live probe, run 2).
  if (status === 403 || status === 429) throw new SiteAdapterError('tool-run', 'blocked-by-site')
  if (status === 404) throw new SiteAdapterError('tool-run', 'not-found')
  throw new SiteAdapterError('tool-run', 'unavailable')
}
