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

export function touchesDeniedSegment(path: string): boolean {
  return splitPath(path).some((segment) => DENY_SEGMENTS.includes(segment.toLowerCase()))
}

export type SurfaceDecision =
  | { readonly allowed: true; readonly declaration: RequestDeclaration }
  | {
      readonly allowed: false
      readonly reason: 'host-not-allowed' | 'undeclared' | 'denied-path' | 'bad-url'
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
  const declaration = declarations.find(
    (d) => d.method.toUpperCase() === method.toUpperCase() && pathMatches(d.path, parsed.pathname),
  )
  if (declaration === undefined) return { allowed: false, reason: 'undeclared' }
  if (touchesDeniedSegment(parsed.pathname) && declaration.purpose !== 'irreversible') {
    return { allowed: false, reason: 'denied-path' }
  }
  return { allowed: true, declaration }
}

function splitPath(path: string): string[] {
  return (
    path
      .split('?')[0]
      ?.split('/')
      .filter((segment) => segment.length > 0) ?? []
  )
}
