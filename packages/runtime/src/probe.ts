// The login probe: is the tool partition's session logged in? It runs in the tool page, as the
// runtime rather than as tool code, so it skips the request surface and the per-run ceiling. It
// still obeys the site's rate budget and circuit breaker, since the site can't tell the difference.

import { type AdapterManifest, hostAllowed, SiteAdapterError, type ToolPage } from '@siteadapter/core'
import { blockedBySite, looksBlocked, type SiteGuards } from './site-protection'

export interface ProbeOptions {
  readonly manifest: AdapterManifest
  readonly page: ToolPage
  readonly site: SiteGuards
  readonly signal: AbortSignal
  /** Called for probe kinds the runtime can't run yet. */
  readonly onUnsupported: (kind: 'cookie') => void
}

/** Resolves true when logged in. Throws blocked-by-site, or SiteAdapterError('probe', …). */
export async function probeLoggedIn(options: ProbeOptions): Promise<boolean> {
  const { manifest, page, site, signal } = options
  const probe = manifest.session.probe
  if (probe.kind === 'cookie') {
    // Cookie probes need the driver to expose cookie names, which SessionDriver does not yet.
    // Treating the session as logged out errs towards logging in again, never towards acting
    // without a session.
    options.onUnsupported('cookie')
    return false
  }
  // The schema only requires a leading "/", which "//other.host/" also has.
  const url = new URL(probe.path, manifest.home)
  if (url.protocol !== 'https:' || !hostAllowed(url.hostname, manifest.egress)) {
    throw new SiteAdapterError('probe', 'host-not-allowed')
  }
  if (site.breaker.isOpen()) throw blockedBySite()
  await site.budget.acquire(signal)
  const result = await page.fetch(url.href, { method: 'GET', headers: { accept: 'application/json' } })
  if (looksBlocked(result, probe.jsonPath !== undefined)) {
    site.breaker.trip()
    throw blockedBySite()
  }
  site.breaker.recordSuccess()
  if (result.status !== probe.expectStatus) return false
  if (probe.jsonPath === undefined) return true
  const value = readJsonPath(result.body, probe.jsonPath)
  return probe.equals === undefined ? Boolean(value) : value === probe.equals
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
