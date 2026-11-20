// Calls to claude.ai's API from the tool page, which is on the site, so they are same-origin and
// carry the signed-in session's cookie. The tool process has no URL or URLSearchParams: urlOn builds
// every address.

import {
  type FetchInit,
  type FetchResult,
  httpsOriginOf,
  NEEDS_USER_REASONS,
  NeedsUserError,
  type NeedsUserReason,
  type ToolContext,
  urlOn,
  ValetError,
} from '@valet/core'

export const REAL_ORIGIN = 'https://claude.ai'

/** claude.ai's /v1/ API refuses a request without it (400, "anthropic-version: header is required"). */
const API_VERSION = '2023-06-01'

/** `path` on the tool page's origin, or the real site's before the page has loaded. */
export function siteUrl(
  ctx: ToolContext,
  path: string,
  query: Readonly<Record<string, string | number | boolean | undefined>> = {},
): string {
  return urlOn(httpsOriginOf(ctx.page.currentUrl()) ?? REAL_ORIGIN, path, query)
}

/** Makes sure the session is signed in, or ends the call for the person to sign in. */
export async function requireLogin(ctx: ToolContext): Promise<void> {
  const result = await ctx.session.ensure()
  if (result.status === 'ok') return
  if (result.status === 'needsUser') {
    const reason = (NEEDS_USER_REASONS as readonly string[]).includes(result.reason)
      ? (result.reason as NeedsUserReason)
      : 'other'
    throw new NeedsUserError(reason)
  }
  throw new ValetError('auth-step', 'auth-failed')
}

/** The JSON body of a call to claude.ai's API, or null for a 404. Other failures throw a ValetError. */
export async function api(
  ctx: ToolContext,
  path: string,
  query: Readonly<Record<string, string | number | boolean | undefined>> = {},
  init: { readonly method?: 'GET' | 'POST'; readonly json?: unknown } = {},
): Promise<unknown> {
  if (ctx.signal.aborted) throw new ValetError('tool-run', 'aborted')
  const request: FetchInit = {
    method: init.method ?? 'GET',
    headers: { accept: 'application/json', 'anthropic-version': API_VERSION },
    ...(init.json === undefined ? {} : { json: init.json }),
  }
  let response: FetchResult
  try {
    response = await ctx.page.fetch(siteUrl(ctx, path, query), request)
  } catch (error) {
    if (error instanceof ValetError) throw error
    throw new ValetError('tool-run', 'unavailable')
  }
  if (response.status === 404) return null
  if (response.status === 401) throw new ValetError('tool-run', 'not-logged-in')
  if (response.status === 429) throw new ValetError('tool-run', 'rate-limited')
  if (response.status === 403) throw new ValetError('tool-run', 'blocked-by-site')
  if (response.status === 400) throw new ValetError('tool-run', 'invalid')
  if (response.status < 200 || response.status >= 300) throw new ValetError('tool-run', 'unavailable')
  const isJson = (response.contentType ?? '').toLowerCase().includes('json')
  if (!isJson || typeof response.body !== 'object' || response.body === null) {
    throw new ValetError('tool-run', 'unexpected-shape')
  }
  return response.body
}

/**
 * Runs `call` signed in. If the site answers 401 partway (the session ended after the probe), it
 * signs in once more and runs `call` again; a second 401 is thrown.
 */
export async function withLogin<T>(ctx: ToolContext, call: () => Promise<T>): Promise<T> {
  await requireLogin(ctx)
  try {
    return await call()
  } catch (error) {
    if (!(error instanceof ValetError && error.errorClass === 'not-logged-in')) throw error
  }
  await requireLogin(ctx)
  return call()
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

export function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** An id as claude.ai writes one: a prefix, an underscore, then letters and digits. */
export const idPattern = (prefix: string): RegExp => new RegExp(`^${prefix}_[A-Za-z0-9]{10,80}$`)
