// The request surface: which site API calls an adapter's tool code may make. Paths are patterns:
// literal segments, ":name" for exactly one segment, and a trailing "*" for any remainder.

import { hostAllowed } from './origins'

export type Purpose = 'read' | 'write' | 'irreversible'

export interface RequestDeclaration {
  readonly method: string
  readonly path: string
  readonly purpose: Purpose
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
  | { readonly allowed: true; readonly declaration: RequestDeclaration }
  | {
      readonly allowed: false
      readonly reason: 'host-not-allowed' | 'undeclared' | 'denied-path' | 'ambiguous-path' | 'bad-url'
    }

/**
 * Decides whether tool code may make a request. `hosts` is the manifest's egress allowlist;
 * `declarations` its request surface. Only requests on allowed hosts are checked against
 * declarations; the browser driver separately blocks everything else at the network layer.
 */
export function decideRequest(
  method: string,
  url: string,
  hosts: readonly string[],
  declarations: readonly RequestDeclaration[],
): SurfaceDecision {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { allowed: false, reason: 'bad-url' }
  }
  if (parsed.protocol !== 'https:' || !hostAllowed(parsed.hostname, hosts)) {
    return { allowed: false, reason: 'host-not-allowed' }
  }
  if (ambiguousPath(parsed.pathname)) return { allowed: false, reason: 'ambiguous-path' }
  const declaration = declarations.find(
    (d) => d.method.toUpperCase() === method.toUpperCase() && pathMatches(d.path, parsed.pathname),
  )
  if (declaration === undefined) return { allowed: false, reason: 'undeclared' }
  if (touchesDeniedSegment(parsed.pathname) && declaration.purpose !== 'irreversible') {
    return { allowed: false, reason: 'denied-path' }
  }
  return { allowed: true, declaration }
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
