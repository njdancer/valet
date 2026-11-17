// The request surface: which site API calls an adapter's tool code may make. Paths are patterns:
// literal segments, ":name" for exactly one segment, and a trailing "*" for any remainder.

import { canonicalAddress, hostPort } from './addresses'
import { hostAllowed } from './origins'

export type Purpose = 'read' | 'write' | 'irreversible'

/** The methods a browser adapter may declare. */
export const BROWSER_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const
/**
 * WebDAV's methods (RFC 4918, CalDAV's MKCALENDAR, and REPORT), which CalDAV and CardDAV need. Only
 * an `http` adapter may declare them: Valet sends its requests itself, where a page could not.
 */
export const WEBDAV_METHODS = ['PROPFIND', 'REPORT', 'MKCOL', 'MKCALENDAR', 'COPY', 'MOVE'] as const
export const REQUEST_METHODS = [...BROWSER_METHODS, ...WEBDAV_METHODS] as const
export type RequestMethod = (typeof REQUEST_METHODS)[number]
/** WebDAV methods that only read, and so may be declared `read`. The rest change something. */
export const READ_ONLY_WEBDAV: readonly string[] = ['PROPFIND', 'REPORT']

/** A private host as the request surface needs it (the manifest's `privateHosts` entry). */
export interface PrivateHostRef {
  readonly address: string
  readonly port: number
  /** Default https. */
  readonly scheme?: 'https' | 'http'
}

/** A private host's key, as a request declaration's `host` names it: `address:port`, IPv6 bracketed. */
export function privateHostKey(host: PrivateHostRef): string {
  return hostPort(host.address, host.port)
}

export interface RequestDeclaration {
  readonly method: string
  /**
   * The one egress host this request goes to, lower-case, or a private host's key. Left out, the
   * declaration applies on every egress host (a browser adapter only).
   */
  readonly host?: string
  readonly path: string
  readonly purpose: Purpose
  /** An `http` adapter's WebSocket: a GET that may only be opened as a socket, never fetched. */
  readonly websocket?: true
}

/**
 * Whether a declaration applies to requests sent to `hostname`: a public host's name, or a private
 * host's key (privateHostKey).
 */
export function declarationOnHost(declaration: { readonly host?: string }, hostname: string): boolean {
  return declaration.host === undefined || declaration.host.toLowerCase() === hostname.toLowerCase()
}

/** A declaration as people and agents read it: `GET /path`, or `GET api.example.com/path`. */
export function describeDeclaration(declaration: {
  readonly method: string
  readonly host?: string
  readonly path: string
}): string {
  return `${declaration.method} ${declaration.host ?? ''}${declaration.path}`
}

/**
 * Paths no adapter may call unless the matching declaration is `irreversible`. These are the ones
 * that move money or commit an order. Matching is on lower-cased path segments.
 */
export const DENY_SEGMENTS: readonly string[] = [
  'checkout',
  'payment',
  'payments',
  'pay',
  'transfer',
  'transfers',
  'payee',
  'payees',
  'placeorder',
  'place-order',
  'submitorder',
]

export function pathMatches(pattern: string, path: string): boolean {
  const patternSegments = splitPath(pattern)
  const pathSegments = splitPath(path)
  for (let i = 0; i < patternSegments.length; i++) {
    const want = patternSegments[i]
    if (want === '*' && i === patternSegments.length - 1) return true
    const got = pathSegments[i]
    if (got === undefined) return false
    if (want?.startsWith(':')) {
      if (got.length === 0) return false
      continue
    }
    if (want?.toLowerCase() !== got.toLowerCase()) return false
  }
  return patternSegments.length === pathSegments.length
}

/**
 * True when any segment of `path` is a deny segment, as written or once percent-decoded with ";"
 * matrix parameters dropped, so "/api/check%6Fut" and "/api/checkout;x=1" are both caught.
 */
export function touchesDeniedSegment(path: string): boolean {
  return splitPath(path).some((segment) => {
    const decoded = decodeSegment(segment).toLowerCase()
    return (
      DENY_SEGMENTS.includes(segment.toLowerCase()) ||
      decoded.split(/[/\\]/).some((part) => DENY_SEGMENTS.includes(part))
    )
  })
}

/**
 * Segments that servers and proxies disagree about. An encoded slash or backslash inside one
 * segment (for example "..%2F..%2Fcart%2Fadd" through a ":id" param), a NUL, a literal backslash, or
 * a segment that decodes to "." or ".." is routed one way by our matcher and possibly another by the
 * site, so a request with any of them is never allowed.
 */
export function ambiguousPath(path: string): boolean {
  return splitPath(path).some((segment) => {
    if (/%(2f|5c|00)|\\/i.test(segment)) return true
    const decoded = decodeSegment(segment)
    return decoded === '.' || decoded === '..'
  })
}

export type SurfaceDecision =
  | {
      readonly allowed: true
      readonly declaration: RequestDeclaration
      /** Where it goes: the public host name, or the private host's key. */
      readonly host: string
      /** The private host it goes to, when it does. */
      readonly privateHost?: PrivateHostRef
    }
  | {
      readonly allowed: false
      readonly reason: 'host-not-allowed' | 'undeclared' | 'denied-path' | 'ambiguous-path' | 'bad-url'
    }

export interface SurfaceOptions {
  /**
   * The manifest's private hosts (an `http` adapter's): `http(s)://address:port` URLs to these are
   * allowed with their own scheme, and matched against declarations by privateHostKey.
   */
  readonly privateHosts?: readonly PrivateHostRef[]
  /**
   * A public host only on its default port, 443. The broker sets it: an `http` adapter's endpoint is
   * an exact host and port. The browser path leaves it off, as before.
   */
  readonly exactPort?: boolean
  /**
   * The request opens a WebSocket: only `websocket` declarations match it. Otherwise they never
   * do, so a socket's declaration can't be fetched and a fetch's can't be upgraded.
   */
  readonly websocket?: boolean
}

/**
 * Where a URL goes, if anywhere this manifest allows: an https egress host, or one of the private
 * hosts with its own scheme and port. Null for anything else. Userinfo in the URL is refused.
 */
export function endpointOf(
  parsed: URL,
  hosts: readonly string[],
  options: SurfaceOptions = {},
): { readonly host: string; readonly privateHost?: PrivateHostRef } | null {
  if (parsed.username !== '' || parsed.password !== '') return null
  const bare = parsed.hostname.replace(/^\[|\]$/g, '')
  const literal = canonicalAddress(bare)
  if (literal !== null) {
    // An IP literal is only ever a declared private host, written exactly as declared.
    if (literal !== bare) return null
    for (const host of options.privateHosts ?? []) {
      const scheme = host.scheme ?? 'https'
      const port = parsed.port === '' ? (scheme === 'https' ? 443 : 80) : Number(parsed.port)
      if (parsed.protocol === `${scheme}:` && host.address === bare && host.port === port)
        return { host: privateHostKey(host), privateHost: host }
    }
    return null
  }
  if (parsed.protocol !== 'https:' || !hostAllowed(parsed.hostname, hosts)) return null
  if (options.exactPort === true && parsed.port !== '') return null
  return { host: parsed.hostname.toLowerCase() }
}

/**
 * Decides whether tool code may make a request. `hosts` is the manifest's egress allowlist;
 * `declarations` its request surface. Only requests on allowed hosts are checked against
 * declarations; the browser driver separately blocks everything else at the network layer, and the
 * egress broker does for an `http` adapter.
 */
export function decideRequest(
  method: string,
  url: string,
  hosts: readonly string[],
  declarations: readonly RequestDeclaration[],
  options: SurfaceOptions = {},
): SurfaceDecision {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { allowed: false, reason: 'bad-url' }
  }
  const endpoint = endpointOf(parsed, hosts, options)
  if (endpoint === null) return { allowed: false, reason: 'host-not-allowed' }
  if (ambiguousPath(parsed.pathname)) return { allowed: false, reason: 'ambiguous-path' }
  const declaration = declarations.find(
    (d) =>
      d.method.toUpperCase() === method.toUpperCase() &&
      (d.websocket === true) === (options.websocket === true) &&
      declarationOnHost(d, endpoint.host) &&
      pathMatches(d.path, parsed.pathname),
  )
  if (declaration === undefined) return { allowed: false, reason: 'undeclared' }
  if (touchesDeniedSegment(parsed.pathname) && declaration.purpose !== 'irreversible') {
    return { allowed: false, reason: 'denied-path' }
  }
  return { allowed: true, declaration, ...endpoint }
}

function decodeSegment(segment: string): string {
  const bare = segment.split(';')[0] ?? ''
  try {
    return decodeURIComponent(bare)
  } catch {
    return bare
  }
}

function splitPath(path: string): string[] {
  return (
    path
      .split('?')[0]
      ?.split('/')
      .filter((segment) => segment.length > 0) ?? []
  )
}
