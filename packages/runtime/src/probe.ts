// The login probe: is the tool partition's session logged in? It runs in the tool page, as the
// runtime rather than as tool code, so it skips the request surface and the per-run ceiling. It
// still obeys the site's rate budget and circuit breaker, since the site can't tell the difference.

import { type AdapterManifest, hostAllowed, SiteAdapterError, type ToolPage } from '@siteadapter/core'
import { blockedBySite, isHtml, looksBlocked, type SiteGuards } from './site-protection'

export interface ProbeOptions {
  readonly manifest: AdapterManifest
  readonly page: ToolPage
  readonly site: SiteGuards
  readonly signal: AbortSignal
  /** Called for probe kinds the runtime can't run yet. */
  readonly onUnsupported: (kind: 'cookie') => void
}

/**
 * Resolves true when logged in and false when the site says logged out: the expected status with
 * the wrong value, or a 401. Throws blocked-by-site for a block (a 429 included), and
 * SiteAdapterError('probe', 'unavailable') for any other answer, which must not start a login.
 */
export async function probeLoggedIn(options: ProbeOptions): Promise<boolean> {
  const { manifest, page, site, signal } = options
  const probe = manifest.session.probe
  if (probe.kind === 'cookie') {
    // Cookie probes need the driver to expose cookie names, which SessionDriver does not yet.
    // Answering "logged out" would log in on every ensure(), so the probe fails instead.
    options.onUnsupported('cookie')
    throw new SiteAdapterError('probe', 'unavailable')
  }
  // The schema only requires a leading "/", which "//other.host/" also has.
  const url = new URL(probe.path, manifest.home)
  if (url.protocol !== 'https:' || !hostAllowed(url.hostname, manifest.egress)) {
    throw new SiteAdapterError('probe', 'host-not-allowed')
  }
  if (site.breaker.isOpen()) throw blockedBySite()
  await site.budget.acquire(signal)
  const result = await page.fetch(url.href, { method: 'GET', headers: { accept: 'application/json' } })
  if (looksBlocked(result)) {
    site.breaker.trip()
    throw blockedBySite()
  }
  site.breaker.recordSuccess()
  if (result.status !== probe.expectStatus) {
    // Only an answer that says "not logged in" may start a login. An outage, a rate limit or a
    // moved endpoint turning every tool call into a full login is how accounts get locked.
    if (LOGGED_OUT_STATUSES.includes(result.status)) return false
    throw new SiteAdapterError('probe', 'unavailable')
  }
  if (probe.jsonPath === undefined) return true
  // HTML where the probe expected JSON is an error or interstitial page, not an answer.
  if (isHtml(result)) throw new SiteAdapterError('probe', 'unavailable')
  const value = readJsonPath(result.body, probe.jsonPath)
  return probe.equals === undefined ? Boolean(value) : value === probe.equals
}

/** Statuses that mean logged out whatever the probe expects. See coreChangeRequests for more. */
const LOGGED_OUT_STATUSES: readonly number[] = [401]

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
