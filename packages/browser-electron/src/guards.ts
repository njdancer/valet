// The network guards' decisions, kept free of Electron so that each can be attacked in a test.
//
// - Auth partition: the main frame may only be on one of the manifest's navigation origins.
//   Subframes may load any https page by default, because login pages embed bot-protection and
//   CAPTCHA frames from other origins; a driver can instead pin them to a list. Either way a secret
//   fill separately requires the frame it types into to be the one whose origin was checked.
// - Tool partition: every request must go to a host on the manifest's egress list, and on those
//   hosts the request surface applies: denied paths are refused for every kind of request, and an
//   API call (anything that isn't a page or one of its assets) must match a declaration whose
//   purpose the running tool may use.

import {
  hostAllowed,
  type Purpose,
  pathMatches,
  type RequestDeclaration,
  sha256Hex,
  touchesDeniedSegment,
  urlOriginAllowed,
} from '@siteadapter/core'
import type { OutgoingRequest, PendingNavigation } from './platform'

const LOCAL_SUBFRAME_URLS = new Set(['about:blank', 'about:srcdoc'])

/** Which subframes an auth page may load: any https page, or only these origins (plus navigation's). */
export type FrameRule = 'any-https' | readonly string[]

export function authNavigationAllowed(
  navigation: PendingNavigation,
  origins: readonly string[],
  frames: FrameRule = 'any-https',
): boolean {
  if (navigation.isMainFrame) return urlOriginAllowed(navigation.url, origins)
  if (LOCAL_SUBFRAME_URLS.has(navigation.url)) return true
  if (frames === 'any-https') return parse(navigation.url)?.protocol === 'https:'
  return urlOriginAllowed(navigation.url, [...origins, ...frames])
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

/** Why the tool partition cancelled a request. The values are core error classes. */
export type BlockReason = 'host-not-allowed' | 'undeclared-request' | 'denied-path' | 'request-ceiling'

export interface SurfacePolicy {
  readonly egress: readonly string[]
  readonly requests: readonly RequestDeclaration[]
  /** The running tool's side effect: what a declaration's purpose may be at most. */
  readonly sideEffect: Purpose
}

export type RequestDecision =
  | {
      readonly allowed: true /** True when it counts toward the per-run ceiling. */
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
 * other method is, so a form POST after a click is held to the surface like a fetch() is.
 */
export function isApiCall(request: OutgoingRequest): boolean {
  if (request.method.toUpperCase() !== 'GET') return true
  return !PASSIVE_TYPES.has(request.resourceType) && !NAVIGATION_TYPES.has(request.resourceType)
}

/**
 * The tool partition's decision for one request, before the ceiling. Tool code can reach the
 * network without the capability API (evaluate() can call the page's own fetch, submit a form, or
 * set location), so this, not a wrapper around ToolPage, is where the request surface holds.
 */
export function decideToolRequest(request: OutgoingRequest, policy: SurfacePolicy): RequestDecision {
  const parsed = parse(request.url)
  if (parsed === null) return { allowed: false, reason: 'host-not-allowed' }
  if (LOCAL_SCHEMES.has(parsed.protocol)) return { allowed: true, counts: false }
  if (!NETWORK_SCHEMES.has(parsed.protocol) || !hostAllowed(parsed.hostname, policy.egress)) {
    return { allowed: false, reason: 'host-not-allowed' }
  }
  const method = request.method.toUpperCase()
  const path = parsed.pathname
  const declaration = ambiguousPath(path)
    ? undefined
    : policy.requests.find((d) => d.method.toUpperCase() === method && pathMatches(d.path, path))
  // Checkout, payment and payee paths are refused for every kind of request, navigations and form
  // posts included, unless an irreversible declaration covers them and an irreversible tool runs.
  if (deniedPath(path)) {
    const unlocked = declaration?.purpose === 'irreversible' && policy.sideEffect === 'irreversible'
    return unlocked
      ? { allowed: true, counts: isApiCall(request) }
      : { allowed: false, reason: 'denied-path' }
  }
  if (!isApiCall(request)) return { allowed: true, counts: false }
  if (declaration === undefined) return { allowed: false, reason: 'undeclared-request' }
  if (PURPOSE_RANK[declaration.purpose] > PURPOSE_RANK[policy.sideEffect]) {
    return { allowed: false, reason: 'denied-path' }
  }
  return { allowed: true, counts: true }
}

/**
 * Core's deny list matches raw segments. Servers decode percent-escapes and often drop ";matrix"
 * parameters before routing, so "check%6Fut" or "checkout;x=1" must count as checkout, and many
 * treat a decoded backslash as a separator, so "a%5Ccheckout" must too.
 */
export function deniedPath(pathname: string): boolean {
  if (touchesDeniedSegment(pathname)) return true
  const normalised = pathname
    .split('/')
    .map((segment) => decodeSegment(segment).replaceAll('\\', '/'))
    .join('/')
  return touchesDeniedSegment(normalised)
}

/**
 * Segments our matcher and the site's router may read differently: an encoded slash, backslash or
 * NUL inside one segment, or one that only decodes to "." or "..". A path holding one matches no
 * declaration.
 */
export function ambiguousPath(pathname: string): boolean {
  return pathname.split('/').some((segment) => {
    if (/%(2f|5c|00)|\\/i.test(segment)) return true
    const decoded = decodeSegment(segment)
    return decoded === '.' || decoded === '..'
  })
}

function decodeSegment(segment: string): string {
  const bare = segment.split(';')[0] ?? ''
  try {
    return decodeURIComponent(bare)
  } catch {
    return bare
  }
}

/**
 * Where a blocked request was going, for reports: the origin only. Tool code chooses the whole URL
 * of a request it wants blocked, so a path (or query) can carry a session token straight into the
 * audit log. The hostname can too (`https://<token>.evil.example/`), so even this is untrusted and
 * must go through output redaction before it is written anywhere.
 */
export function requestTarget(url: string): string {
  const parsed = parse(url)
  if (parsed === null) return 'invalid-url'
  if (parsed.origin === 'null') return parsed.protocol
  return parsed.origin
}

/** A short digest of the path, so that reports can tell paths apart without carrying them. */
export function pathDigest(url: string): string | null {
  const parsed = parse(url)
  if (parsed === null || parsed.origin === 'null') return null
  return sha256Hex(parsed.pathname).slice(0, 16)
}

function parse(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}
