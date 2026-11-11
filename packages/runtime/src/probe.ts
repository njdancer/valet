// The login probe: is the tool partition's session logged in? It runs as the runtime rather than as
// tool code, so it skips the guarded page's request surface and per-run ceiling (the driver's run
// policy still applies; see probeDeclaration). A fetch probe still obeys the site's rate budget and
// circuit breaker, since the site can't tell the difference. A cookie probe asks the driver for
// cookie names and never touches the site.
//
// The page's fetch sends cookies same-origin only, from wherever the page is. Tool code may have
// left it on another egress host (an api. or assets. subdomain), where the probe would go out
// without cookies, come back 401 and start a login nobody needed. So a fetch probe first takes the
// page home whenever it is on another origin.

import {
  type AdapterManifest,
  hostAllowed,
  type RequestDeclaration,
  type SessionDriver,
  type ToolPage,
  ValetError,
} from '@valet/core'
import {
  blockCause,
  breakerRefusal,
  isHtml,
  navigationBlocked,
  type SiteGuards,
  siteRefusal,
} from './site-protection'

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
 * open breaker, and ValetError('probe', 'unavailable') for any other answer, which must not
 * start a login.
 */
export async function probeLoggedIn(options: ProbeOptions): Promise<boolean> {
  const { manifest, page, driver, site, signal, callId } = options
  const probe = manifest.session.probe
  if (probe.kind === 'none') return false
  if (probe.kind === 'cookie') {
    const names = await driver.cookieNames(manifest.session.cookieDomains)
    return names.includes(probe.name)
  }
  // The schema refuses "//" and backslashes, but a hand-built manifest might not have been parsed.
  const url = new URL(probe.path, manifest.home)
  if (url.protocol !== 'https:' || !hostAllowed(url.hostname, manifest.egress)) {
    throw new ValetError('probe', 'host-not-allowed')
  }
  if (!sameOrigin(page, url)) {
    const admitted = await pace(site, signal)
    await page.goto(new URL(manifest.home).href)
    const cause = await navigationBlocked(page)
    if (cause !== null) {
      site.breaker.trip(cause, callId)
      throw siteRefusal(cause)
    }
    site.breaker.recordSuccess(admitted)
    // Redirected elsewhere: a probe from here would say nothing about the session.
    if (!sameOrigin(page, url)) throw new ValetError('probe', 'unavailable')
  }
  const admitted = await pace(site, signal)
  const result = await page.fetch(url.href, { method: 'GET', headers: { accept: 'application/json' } })
  const cause = blockCause(result)
  if (cause !== null) {
    site.breaker.trip(cause, callId)
    throw siteRefusal(cause)
  }
  site.breaker.recordSuccess(admitted)
  if (result.status !== probe.expectStatus) {
    // Only an answer that says "not logged in" may start a login. An outage, a rate limit or a
    // moved endpoint turning every tool call into a full login is how accounts get locked.
    if (probe.loggedOutStatuses.includes(result.status)) return false
    throw new ValetError('probe', 'unavailable')
  }
  if (probe.jsonPath === undefined) return true
  // HTML where the probe expected JSON is an error or interstitial page, not an answer.
  if (isHtml(result)) throw new ValetError('probe', 'unavailable')
  const value = readJsonPath(result.body, probe.jsonPath)
  return probe.equals === undefined ? Boolean(value) : value === probe.equals
}

/** Waits for the site's rate budget, refusing while its breaker is open; returns the admission token. */
async function pace(site: SiteGuards, signal: AbortSignal): Promise<number> {
  if (site.breaker.isOpen()) throw breakerRefusal()
  await site.budget.acquire(signal)
  // The breaker can open while we wait our turn.
  if (site.breaker.isOpen()) throw breakerRefusal()
  return site.breaker.admit()
}

/**
 * Whether the page is where a fetch probe would be made from: on the probe's origin, so the page's
 * own requests carry the session's cookies.
 */
export function onProbeOrigin(manifest: AdapterManifest, page: ToolPage): boolean {
  const probe = manifest.session.probe
  if (probe.kind !== 'fetch') return false
  try {
    return sameOrigin(page, new URL(probe.path, manifest.home))
  } catch {
    return false
  }
}

/** Whether the page is on `url`'s origin. A page whose URL can't be read or parsed isn't. */
function sameOrigin(page: ToolPage, url: URL): boolean {
  try {
    return new URL(page.currentUrl()).origin === url.origin
  } catch {
    return false
  }
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
