// Calls to the site's own JSON API, made through the page so the session's cookies never leave the
// browser. Every failure leaves as a ValetError: response bodies and exception messages can
// carry page text, so none of it is passed on.

import { type FetchInit, type FetchResult, type ToolContext, ValetError } from '@valet/core'
import type { z } from 'zod'

/**
 * The site's trolley page, where the person checks out in their own browser (Valet never places
 * orders). Assumed from the site's links, not yet opened live.
 */
export const CART_PAGE = '/shop/cart'

export const PATHS = {
  search: '/apis/ui/Search/products',
  productDetail: (stockcode: number) => `/apis/ui/product/detail/${stockcode}`,
  trolley: '/apis/ui/Trolley',
  trolleyUpdate: '/api/v3/ui/trolley/update',
  /** Assumed, never seen live: see stores.ts. */
  pickupStores: '/api/v3/ui/fulfilment/stores',
  fulfilment: '/apis/ui/Fulfilment',
  /** A store's pick-up times, by its AreaId (live, anonymous, 2026-11-28). */
  pickupWindows: '/api/v3/ui/fulfilment/windows',
} as const

/**
 * A GET the runtime may answer from its session read cache, where the manifest lets it keep that
 * request (`cacheSeconds`). `fresh` always asks the site.
 */
export async function getJson<Schema extends z.ZodType>(
  ctx: ToolContext,
  path: string,
  schema: Schema,
  options: { readonly fresh?: boolean } = {},
): Promise<z.infer<Schema>> {
  const init: FetchInit = options.fresh === true ? { method: 'GET', cache: 'reload' } : { method: 'GET' }
  return (await call(ctx, path, init, schema)).data
}

/**
 * Like getJson, and says whether the answer came from the runtime's cache. Null when a cached
 * answer can't be read with `schema`: the cache then holds something else (a write's reply that
 * wasn't what the manifest said it would be), and the caller asks the site with `fresh`.
 */
export async function getHeldJson<Schema extends z.ZodType>(
  ctx: ToolContext,
  path: string,
  schema: Schema,
): Promise<{ readonly data: z.infer<Schema>; readonly fromCache: boolean } | null> {
  return call(ctx, path, { method: 'GET' }, schema, true)
}

export interface PostOptions {
  /**
   * What to throw when the site answers 400, the site's "The request is invalid." Without it a 400
   * is unavailable, like any other answer the adapter can't use.
   */
  readonly badRequest?: ValetError
}

export async function postJson<Schema extends z.ZodType>(
  ctx: ToolContext,
  path: string,
  json: unknown,
  schema: Schema,
  options: PostOptions = {},
): Promise<z.infer<Schema>> {
  return (await call(ctx, path, { method: 'POST', json }, schema, false, options.badRequest)).data
}

/**
 * Like postJson, for a write the site may answer with a 2xx and no body at all: null then. Signed in,
 * Woolworths answers choosing a store with a 200 that has no body and no content type (live,
 * 2026-11-27); its own scripts read { IsSuccessful, ... } only when one comes.
 */
export async function postJsonOrEmpty<Schema extends z.ZodType>(
  ctx: ToolContext,
  path: string,
  json: unknown,
  schema: Schema,
): Promise<z.infer<Schema> | null> {
  const answer = await call(ctx, path, { method: 'POST', json }, schema, false, undefined, true)
  return answer === null ? null : answer.data
}

interface Answer<T> {
  readonly data: T
  readonly fromCache: boolean
}

async function call<Schema extends z.ZodType>(
  ctx: ToolContext,
  path: string,
  init: FetchInit,
  schema: Schema,
  unreadableCacheIsNull?: false,
  badRequest?: ValetError,
): Promise<Answer<z.infer<Schema>>>
async function call<Schema extends z.ZodType>(
  ctx: ToolContext,
  path: string,
  init: FetchInit,
  schema: Schema,
  unreadableCacheIsNull: false,
  badRequest: ValetError | undefined,
  emptyIsNull: true,
): Promise<Answer<z.infer<Schema>> | null>
async function call<Schema extends z.ZodType>(
  ctx: ToolContext,
  path: string,
  init: FetchInit,
  schema: Schema,
  unreadableCacheIsNull: true,
): Promise<Answer<z.infer<Schema>> | null>
async function call<Schema extends z.ZodType>(
  ctx: ToolContext,
  path: string,
  init: FetchInit,
  schema: Schema,
  unreadableCacheIsNull = false,
  badRequest?: ValetError,
  emptyIsNull = false,
): Promise<Answer<z.infer<Schema>> | null> {
  // Checked before every call so that a cancelled add_to_cart never reaches its write.
  if (ctx.signal.aborted) throw new ValetError('tool-run', 'aborted')
  let response: FetchResult
  try {
    response = await ctx.page.fetch(path, init)
  } catch (error) {
    // The runtime's own guards throw ValetError; keep their stage and class.
    if (error instanceof ValetError) throw error
    throw new ValetError('tool-run', 'unavailable')
  }
  if (response.status === 400 && badRequest !== undefined) throw badRequest
  throwForStatus(response.status)
  if (emptyIsNull && isEmpty(response)) return null
  throwForContentType(response)
  const parsed = schema.safeParse(response.body)
  // JSON the adapter can't read means the site changed, not that the input was bad. Which field
  // changed is left to drift detection (drift.ts), which can say so without copying a value.
  const fromCache = response.fromCache === true
  if (!parsed.success) {
    if (fromCache && unreadableCacheIsNull) return null
    throw new ValetError('tool-run', 'site-changed')
  }
  return { data: parsed.data, fromCache }
}

/**
 * A 2xx that isn't JSON is never the API's answer. HTML is either Akamai's challenge page or the
 * login page served to an expired session, and the two can't be told apart from here. Both are
 * reported as blocked-by-site, as the runtime's own block detection does: the runtime backs off,
 * and its next ensure() finds an expired session. Reporting not-logged-in instead would send a
 * flagged session straight back to the scripted login. JSON of the wrong shape is site-changed.
 */
function throwForContentType(response: FetchResult): void {
  const type = response.contentType?.toLowerCase() ?? ''
  if (type.includes('json')) return
  if (type.includes('html') || (typeof response.body === 'string' && /^\s*</.test(response.body))) {
    throw new ValetError('tool-run', 'blocked-by-site')
  }
  throw new ValetError('tool-run', 'unavailable')
}

/** An answer with nothing in it: no body, or only whitespace, and no type saying otherwise. */
function isEmpty(response: FetchResult): boolean {
  const type = response.contentType?.toLowerCase() ?? ''
  if (type.includes('json') || type.includes('html')) return false
  const body = response.body
  return body === null || body === undefined || (typeof body === 'string' && body.trim() === '')
}

function throwForStatus(status: number): void {
  if (status >= 200 && status < 300) return
  if (status === 401) throw new ValetError('tool-run', 'not-logged-in')
  // Akamai answers a flagged session with a 403 "Access Denied" page (live probe, run 2). A 429 is
  // the site asking for less, which the runtime's breaker treats differently from a block.
  if (status === 403) throw new ValetError('tool-run', 'blocked-by-site')
  if (status === 429) throw new ValetError('tool-run', 'rate-limited')
  if (status === 404) throw new ValetError('tool-run', 'not-found')
  throw new ValetError('tool-run', 'unavailable')
}
