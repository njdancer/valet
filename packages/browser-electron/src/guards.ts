// The network guards' decisions, kept free of Electron so that each can be attacked in a test.
//
// - Auth partition: the main frame may only be on one of the manifest's navigation origins, and a
//   subframe only on those or the manifest's auth.frameOrigins (a CAPTCHA, say). Everything else is
//   refused.
// - Tool partition: one ToolRunPolicy holds every request, whoever made it: tool code through the
//   capability API, adapter code in evaluate(), a click on the site's own button, or the site's
//   own scripts. The host must be on the egress list; on those hosts, an API call must pass core's
//   decideRequest and its declaration's purpose must be within the run's; denied paths are refused
//   for every kind of request. Page script chooses a request's resource type (new Image(),
//   <script src>, an iframe, location=), so the type alone never decides that something is not an
//   API call: a GET under the declarations' API roots is held to the surface whatever its type,
//   and every request that leaves counts toward a budget.

import {
  type BlockedRequest,
  decideRequest,
  hostAllowed,
  type Purpose,
  type RequestDeclaration,
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

/**
 * Which of the run's budgets a request it allows counts toward: the ceiling (navigations and API
 * calls), the larger budget for a page's assets, or none (local schemes, which never leave).
 */
export type Budget = 'request' | 'asset' | null

export type RequestDecision =
  | { readonly allowed: true; readonly counts: Budget }
  | { readonly allowed: false; readonly reason: BlockReason }

// A Map, not an object literal: a lookup of '__proto__' or 'constructor' finds nothing.
const PURPOSE_RANK: ReadonlyMap<string, number> = new Map<Purpose, number>([
  ['read', 0],
  ['write', 1],
  ['irreversible', 2],
])

// Requests that only fetch something to show. Everything else, including types Chromium may add
// later, is treated as an API call.
const PASSIVE_TYPES = new Set(['stylesheet', 'script', 'image', 'font', 'media'])
const NAVIGATION_TYPES = new Set(['mainFrame', 'subFrame'])

/**
 * True for a request the declarations govern by its kind alone. A GET of a page or one of its
 * assets is not; any other method is, so a form POST after a click is held to the surface like a
 * fetch() is. Beacons, sockets and unknown types are API calls too. underApiRoot() decides the
 * GETs this lets go by.
 */
export function isApiCall(request: OutgoingRequest): boolean {
  if (request.method.toUpperCase() !== 'GET') return true
  return !PASSIVE_TYPES.has(request.resourceType) && !NAVIGATION_TYPES.has(request.resourceType)
}

/**
 * The part of each declaration's path that says "this is the site's API": its segments up to and
 * including the first literal one, lower-cased. "/apis/ui/Trolley" gives ["apis"] and
 * "/:locale/api/cart" gives [":locale", "api"]. A path with no literal segment is its own root, so
 * "/*" makes every path an API path; that fails closed.
 */
export function apiRoots(declarations: readonly RequestDeclaration[]): readonly (readonly string[])[] {
  return declarations.map((declaration) => {
    const segments = splitPath(declaration.path).map((segment) => segment.toLowerCase())
    const literal = segments.findIndex((segment) => !segment.startsWith(':') && segment !== '*')
    return literal === -1 ? segments : segments.slice(0, literal + 1)
  })
}

const MAX_DECODE_ROUNDS = 3

/**
 * True when `pathname` falls under one of `roots`, read the ways a server might route it: each
 * segment percent-decoded (up to three times, for a server that decodes twice) with ";" matrix
 * parameters dropped, and the whole once more with encoded slashes split and dot segments resolved,
 * so "/static/..%2Fapis/x" is under "apis" too.
 */
export function underApiRoot(pathname: string, roots: readonly (readonly string[])[]): boolean {
  const segments = splitPath(pathname).map((segment) =>
    decodeFully(segment.split(';')[0] ?? '').toLowerCase(),
  )
  const resolved: string[] = []
  for (const part of segments.join('/').split(/[/\\]/)) {
    if (part === '' || part === '.') continue
    if (part === '..') resolved.pop()
    else resolved.push(part)
  }
  return roots.some((root) => rootCovers(root, segments) || rootCovers(root, resolved))
}

function rootCovers(root: readonly string[], segments: readonly string[]): boolean {
  if (root.length === 0) return segments.length === 0
  for (const [index, want] of root.entries()) {
    if (want === '*') return true
    const got = segments[index]
    if (got === undefined || got.length === 0) return false
    if (!want.startsWith(':') && want !== got) return false
  }
  return true
}

function decodeFully(segment: string): string {
  let current = segment
  for (let round = 0; round < MAX_DECODE_ROUNDS; round++) {
    let next: string
    try {
      next = decodeURIComponent(current)
    } catch {
      return current
    }
    if (next === current) return current
    current = next
  }
  return current
}

function splitPath(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0)
}

/**
 * Whether a declaration of `purpose` is usable in a run that allows up to `max`. Anything outside
 * the vocabulary allows nothing, including names on Object.prototype such as 'toString'.
 */
export function purposeAllowed(purpose: Purpose, max: Purpose, irreversibleUnlocked: boolean): boolean {
  const rank = PURPOSE_RANK.get(purpose)
  const maxRank = PURPOSE_RANK.get(max)
  if (rank === undefined || maxRank === undefined || rank > maxRank) return false
  return purpose !== 'irreversible' || irreversibleUnlocked
}

/**
 * The tool partition's decision for one request, before the budgets. `egress` is the driver's own
 * egress list: a run's policy can narrow it, never widen it. `declared` is the manifest's whole
 * request surface, whatever this run may use, so that the API roots don't shrink between runs or
 * in a read run. Tool code can reach the network without the capability API (evaluate() can call
 * the page's own fetch, submit a form, add an image or set location), and the site's own scripts
 * make calls nobody declared, so this, not a wrapper around ToolPage, is where the request surface
 * holds.
 */
export function decideToolRequest(
  request: OutgoingRequest,
  policy: ToolRunPolicy,
  egress: readonly string[],
  irreversibleUnlocked: boolean,
  declared: readonly RequestDeclaration[] = [],
): RequestDecision {
  const parsed = parse(request.url)
  if (parsed === null) return { allowed: false, reason: 'bad-url' }
  if (LOCAL_SCHEMES.has(parsed.protocol)) return { allowed: true, counts: null }
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
  const byKind = isApiCall(request)
  // Checkout, payment and payee pages are refused as navigations and assets too, unless an
  // irreversible declaration covers them and the person unlocked this run.
  if (!byKind && touchesDeniedSegment(parsed.pathname)) {
    const unlocked = usable && surface.declaration.purpose === 'irreversible'
    if (!unlocked) return { allowed: false, reason: 'denied-path' }
  }
  if (byKind || underApiRoot(parsed.pathname, apiRoots([...declared, ...policy.requests]))) {
    if (!surface.allowed) return { allowed: false, reason: surface.reason }
    return usable ? { allowed: true, counts: 'request' } : { allowed: false, reason: 'purpose-exceeded' }
  }
  return { allowed: true, counts: NAVIGATION_TYPES.has(request.resourceType) ? 'request' : 'asset' }
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
