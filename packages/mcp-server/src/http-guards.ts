// Request checks for the local HTTP endpoint. Binding to 127.0.0.1 keeps other machines out; these
// keep out web pages in the person's own browser. A page can't read the token, but DNS rebinding
// could point a hostile name at 127.0.0.1, so the Host and Origin headers must both say localhost.

import { tokensEqual } from './token'

const LOOPBACK_NAMES = ['127.0.0.1', 'localhost']
const LOCAL_ORIGIN_HOSTS = ['127.0.0.1', 'localhost', '[::1]']

/** True when the Host header names this server by a loopback name and its exact port. */
export function hostAllowed(host: string | undefined, port: number): boolean {
  if (host === undefined) return false
  const lower = host.toLowerCase()
  return LOOPBACK_NAMES.some((name) => lower === `${name}:${port}`)
}

/**
 * True when there is no Origin header (a non-browser client) or it is a localhost origin on any
 * port. "null", other schemes and anything with a path are refused.
 */
export function originAllowed(origin: string | undefined): boolean {
  if (origin === undefined) return true
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  if (parsed.origin !== origin.toLowerCase()) return false
  return LOCAL_ORIGIN_HOSTS.includes(parsed.hostname)
}

/** True when the Authorization header carries exactly `Bearer <expected>`. */
export function bearerAuthorized(authorization: string | undefined, expected: string): boolean {
  const match = /^Bearer ([^\s]+)$/i.exec(authorization ?? '')
  // Compare even when the header is malformed, so its shape isn't visible in the timing either.
  const presented = match?.[1] ?? ''
  return tokensEqual(presented, expected) && match !== null
}
