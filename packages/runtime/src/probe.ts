// The login probe: is the tool partition's session logged in? It runs as the runtime rather than as
// tool code, so it skips the guarded page's request surface and per-run ceiling (the driver's run
// policy still applies; see probeDeclaration). A fetch probe still obeys the site's rate budget and
// circuit breaker, since the site can't tell the difference. A cookie probe asks the driver for
// cookie names and never touches the site.

import {
  type AdapterManifest,
  hostAllowed,
  type RequestDeclaration,
  type SessionDriver,
  SiteAdapterError,
  type ToolPage,
} from '@siteadapter/core'
import { blockCause, breakerRefusal, isHtml, type SiteGuards, siteRefusal } from './site-protection'

export interface ProbeOptions {
  readonly manifest: AdapterManifest
  readonly page: ToolPage
  readonly driver: SessionDriver
  readonly site: SiteGuards
  readonly signal: AbortSignal
  /** The call the probe runs for, for the breaker-opened audit event. */
  readonly callId: string
}

/**
 * Resolves true when logged in and false when the site says logged out: for a fetch probe, the
 * expected status with the wrong value, or one of the probe's loggedOutStatuses; for a cookie probe,
 * the cookie being absent. Throws blocked-by-site or rate-limited for a block (a 429 included) or an
 * open breaker, and SiteAdapterError('probe', 'unavailable') for any other answer, which must not
 * start a login.
 */
export async function probeLoggedIn(options: ProbeOptions): Promise<boolean> {
  const { manifest, page, driver, site, signal, callId } = options
  const probe = manifest.session.probe
  if (probe.kind === 'cookie') {
    const names = await driver.cookieNames(manifest.session.cookieDomains)
    return names.includes(probe.name)
  }
  // The schema refuses "//" and backslashes, but a hand-built manifest might not have been parsed.
  const url = new URL(probe.path, manifest.home)
  if (url.protocol !== 'https:' || !hostAllowed(url.hostname, manifest.egress)) {
    throw new SiteAdapterError('probe', 'host-not-allowed')
  }
  if (site.breaker.isOpen()) throw breakerRefusal()
  await site.budget.acquire(signal)
  // The breaker can open while we wait our turn.
  if (site.breaker.isOpen()) throw breakerRefusal()
  const result = await page.fetch(url.href, { method: 'GET', headers: { accept: 'application/json' } })
  const cause = blockCause(result)
  if (cause !== null) {
    site.breaker.trip(cause, callId)
    throw siteRefusal(cause)
  }
  site.breaker.recordSuccess()
  if (result.status !== probe.expectStatus) {
    // Only an answer that says "not logged in" may start a login. An outage, a rate limit or a
    // moved endpoint turning every tool call into a full login is how accounts get locked.
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
 * The probe's request, as a declaration for the driver's run policy, which otherwise only lets
 * through what the manifest's request surface declares. Only a literal path qualifies: a ":param" or
 * "*" segment would declare far more than the one request the probe makes.
 */
export function probeDeclaration(manifest: AdapterManifest): RequestDeclaration[] {
  const probe = manifest.session.probe
  if (probe.kind !== 'fetch') return []
  const path = probe.path.split('?')[0] ?? ''
  const literal = path.split('/').every((segment) => !segment.startsWith(':') && segment !== '*')
  return literal ? [{ method: 'GET', path, purpose: 'read' }] : []
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
