// The network guards' decisions, kept free of Electron so that each can be attacked in a test.
//
// - Auth partition: the main frame may only be on one of the manifest's navigation origins, and a
//   subframe only on those or the manifest's auth.frameOrigins (a CAPTCHA, say). Everything else is
//   refused.
// - Tool partition: one ToolRunPolicy holds every request, whoever made it: tool code through the
//   capability API, adapter code in evaluate(), a click on the site's own button, or the site's
//   own scripts. The host must be on the egress list; on those hosts, an API call (anything that
//   isn't a page or one of its assets) must pass core's decideRequest and its declaration's
//   purpose must be within the run's; denied paths are refused for every kind of request.

import {
  type BlockedRequest,
  decideRequest,
  hostAllowed,
  type Purpose,
  type ToolRunPolicy,
  touchesDeniedSegment,
  urlOriginAllowed,
} from '@siteadapter/core'
import type { OutgoingRequest, PendingNavigation } from './platform'

const LOCAL_SUBFRAME_URLS = new Set(['about:blank', 'about:srcdoc'])

/**
 * The auth partition's navigation rule. `frameOrigins` are the manifest's auth.frameOrigins: the
 * only origins besides `origins` that a subframe may load.
 */
export function authNavigationAllowed(
  navigation: PendingNavigation,
  origins: readonly string[],
  frameOrigins: readonly string[],
): boolean {
  if (navigation.isMainFrame) return urlOriginAllowed(navigation.url, origins)
  if (LOCAL_SUBFRAME_URLS.has(navigation.url)) return true
  return urlOriginAllowed(navigation.url, [...origins, ...frameOrigins])
}

// Schemes that never leave the machine. Chromium rarely shows them to webRequest at all.
const LOCAL_SCHEMES = new Set(['data:', 'blob:', 'about:'])
const NETWORK_SCHEMES = new Set(['https:', 'wss:'])

export function egressAllowed(url: string, egress: readonly string[]): boolean {
  const parsed = parse(url)
  if (parsed === null) return false
  if (LOCAL_SCHEMES.has(parsed.protocol)) return true
  return NETWORK_SCHEMES.has(parsed.protocol) && hostAllowed(parsed.hostname, egress)
}

export type BlockReason = BlockedRequest['reason']

export type RequestDecision =
  | {
      readonly allowed: true
      /** True when it counts toward the run's ceiling: navigations and API calls. */
      readonly counts: boolean
    }
  | { readonly allowed: false; readonly reason: BlockReason }

const PURPOSE_RANK: Readonly<Record<Purpose, number>> = { read: 0, write: 1, irreversible: 2 }

// Requests that only fetch something to show. Everything else, including types Chromium may add
// later, is treated as an API call.
const PASSIVE_TYPES = new Set(['stylesheet', 'script', 'image', 'font', 'media'])
const NAVIGATION_TYPES = new Set(['mainFrame', 'subFrame'])

/**
 * True for a request the declarations govern. A GET of a page or one of its assets is not; any
 * other method is, so a form POST after a click is held to the surface like a fetch() is. Beacons,
 * sockets and unknown types are API calls too.
 */
export function isApiCall(request: OutgoingRequest): boolean {
  if (request.method.toUpperCase() !== 'GET') return true
  return !PASSIVE_TYPES.has(request.resourceType) && !NAVIGATION_TYPES.has(request.resourceType)
}

/** Whether a declaration of `purpose` is usable in a run that allows up to `max`. */
export function purposeAllowed(purpose: Purpose, max: Purpose, irreversibleUnlocked: boolean): boolean {
  if ((PURPOSE_RANK[purpose] ?? Number.POSITIVE_INFINITY) > (PURPOSE_RANK[max] ?? -1)) return false
  return purpose !== 'irreversible' || irreversibleUnlocked
}

/**
 * The tool partition's decision for one request, before the ceiling. `egress` is the driver's own
 * egress list: a run's policy can narrow it, never widen it. Tool code can reach the network
 * without the capability API (evaluate() can call the page's own fetch, submit a form, or set
 * location), and the site's own scripts make calls nobody declared, so this, not a wrapper around
 * ToolPage, is where the request surface holds.
 */
export function decideToolRequest(
  request: OutgoingRequest,
  policy: ToolRunPolicy,
  egress: readonly string[],
  irreversibleUnlocked: boolean,
): RequestDecision {
  const parsed = parse(request.url)
  if (parsed === null) return { allowed: false, reason: 'bad-url' }
  if (LOCAL_SCHEMES.has(parsed.protocol)) return { allowed: true, counts: false }
  if (
    !NETWORK_SCHEMES.has(parsed.protocol) ||
    !hostAllowed(parsed.hostname, egress) ||
    !hostAllowed(parsed.hostname, policy.egress)
  ) {
    return { allowed: false, reason: 'host-not-allowed' }
  }
  // decideRequest wants https; a WebSocket's wss URL is matched as the same path over https.
  const https = new URL(parsed.href)
  if (https.protocol === 'wss:') https.protocol = 'https:'
  const method = request.method.toUpperCase()
  const surface = decideRequest(method, https.href, policy.egress, policy.requests)
  const usable =
    surface.allowed && purposeAllowed(surface.declaration.purpose, policy.maxPurpose, irreversibleUnlocked)
  if (isApiCall(request)) {
    if (!surface.allowed) return { allowed: false, reason: surface.reason }
    return usable ? { allowed: true, counts: true } : { allowed: false, reason: 'purpose-exceeded' }
  }
  // Checkout, payment and payee pages are refused as navigations and assets too, unless an
  // irreversible declaration covers them and the person unlocked this run.
  if (touchesDeniedSegment(parsed.pathname)) {
    const unlocked = usable && surface.declaration.purpose === 'irreversible'
    if (!unlocked) return { allowed: false, reason: 'denied-path' }
  }
  return { allowed: true, counts: NAVIGATION_TYPES.has(request.resourceType) }
}

const MAX_REPORTED_PATH = 300

/**
 * Where a blocked request was going, for reports: never the query or fragment. On an egress host,
 * the origin and path, so the person can see which of the site's calls to declare; anywhere else,
 * the origin only, since a path to a host nobody declared is tool code's choice entirely. Even so
 * the path (and a hostname, `https://<token>.evil.example/`) can carry data, so the runtime must
 * redact a report before writing it anywhere.
 */
export function requestTarget(url: string, withPath: boolean): string {
  const parsed = parse(url)
  if (parsed === null) return 'invalid-url'
  if (parsed.origin === 'null') return parsed.protocol
  if (!withPath) return parsed.origin
  const path =
    parsed.pathname.length > MAX_REPORTED_PATH
      ? `${parsed.pathname.slice(0, MAX_REPORTED_PATH)}…`
      : parsed.pathname
  return `${parsed.origin}${path}`
}

function parse(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}
