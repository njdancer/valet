// The manifest's session probe, as the auth flow runs it: against the auth partition, before
// anything has been handed to the tool partition. The AuthProbe hook only fetches the evidence;
// deciding what it means happens here, so that every caller reads a probe the same way.

import { type FetchResult, httpsOrigin, SiteAdapterError, urlOriginAllowed } from '@siteadapter/core'
import { type FlowContext, guarded } from './context'

/**
 * Resolves true when logged in and false when the site says logged out: a cookie that isn't
 * there, one of the probe's loggedOutStatuses, or the expected status with the wrong value.
 * Throws probe: unavailable for any other answer. Only an answer that says "not logged in" may
 * count against a login: an outage or a moved endpoint is not a wrong password.
 */
export async function probeLoggedIn(ctx: FlowContext): Promise<boolean> {
  const { manifest, probe: hook } = ctx.input
  const probe = manifest.session.probe
  if (probe.kind === 'cookie') {
    const names = await guarded('probe', () => hook.cookieNames(manifest.session.cookieDomains))
    if (!Array.isArray(names)) throw new SiteAdapterError('probe', 'internal')
    return names.includes(probe.name)
  }
  const url = probeUrl(probe.path, manifest.home, manifest.navigation)
  const result: FetchResult = await guarded('probe', () => hook.fetch(url))
  if (result === null || typeof result !== 'object' || !Number.isInteger(result.status)) {
    throw new SiteAdapterError('probe', 'internal')
  }
  if (result.status !== probe.expectStatus) {
    if (probe.loggedOutStatuses.includes(result.status)) return false
    throw new SiteAdapterError('probe', 'unavailable')
  }
  if (probe.jsonPath === undefined) return true
  // HTML where the probe expected JSON is an error or interstitial page, not an answer.
  if (isHtml(result)) throw new SiteAdapterError('probe', 'unavailable')
  const value = readJsonPath(result.body, probe.jsonPath)
  return probe.equals === undefined ? Boolean(value) : value === probe.equals
}

/**
 * The probe's absolute URL: its path on the home page's origin, which must also be somewhere the
 * auth partition may go. The schema already refuses "//host" and backslashes in the path; this
 * checks the resolved origin anyway, since it can't know its manifest was parsed.
 */
function probeUrl(path: string, home: string, navigation: readonly string[]): string {
  const homeOrigin = httpsOrigin(home)
  let url: URL
  try {
    url = new URL(path, home)
  } catch {
    throw new SiteAdapterError('probe', 'host-not-allowed')
  }
  if (homeOrigin === null || url.origin !== homeOrigin || !urlOriginAllowed(url.href, navigation)) {
    throw new SiteAdapterError('probe', 'host-not-allowed')
  }
  return url.href
}

function isHtml(result: FetchResult): boolean {
  if (result.contentType?.toLowerCase().includes('html')) return true
  return (
    typeof result.body === 'string' && /^\s*</.test(result.body) && !/json/i.test(result.contentType ?? '')
  )
}

/** Follows a dot path through own properties only, so "constructor" or "__proto__" find nothing. */
export function readJsonPath(body: unknown, path: string): unknown {
  let current: unknown = body
  if (typeof current === 'string') {
    try {
      current = JSON.parse(current)
    } catch {
      return undefined
    }
  }
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, segment)) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}
