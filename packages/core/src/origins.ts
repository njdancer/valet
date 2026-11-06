// Origin and host matching shared by every guard. Matching is exact and case-insensitive on hosts;
// the only pattern form is a leading "*." on a host, which matches strict subdomains.

/** Returns the origin of an absolute https URL, or null for anything else. */
export function httpsOrigin(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:') return null
  return parsed.origin
}

/** True when `origin` is exactly one of `allowed`. Both sides must be https origins. */
export function originAllowed(origin: string, allowed: readonly string[]): boolean {
  const normalised = httpsOrigin(origin)
  if (normalised === null) return false
  return allowed.some((candidate) => httpsOrigin(candidate) === normalised && isBareOrigin(candidate))
}

/** True when a URL's origin is exactly one of `allowed`. */
export function urlOriginAllowed(url: string, allowed: readonly string[]): boolean {
  const origin = httpsOrigin(url)
  return origin !== null && originAllowed(origin, allowed)
}

/**
 * True when `host` matches one of `patterns`. A pattern is either an exact host or "*.example.com",
 * which matches any strict subdomain of example.com but not example.com itself.
 */
export function hostAllowed(host: string, patterns: readonly string[]): boolean {
  const target = host.toLowerCase()
  return patterns.some((raw) => {
    const pattern = raw.toLowerCase()
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1)
      return target.endsWith(suffix) && target.length > suffix.length
    }
    return target === pattern
  })
}

/**
 * True for a string that is an https origin with no path, query or fragment, whose host is a plain
 * DNS name (a port is allowed). The URL parser accepts "*" and IP literals in hosts; neither is a
 * site anyone can grant.
 */
export function isBareOrigin(value: string): boolean {
  const origin = httpsOrigin(value)
  if (origin === null || (value !== origin && value !== `${origin}/`)) return false
  return isHostname(new URL(origin).hostname)
}

/** True for a host pattern accepted by `hostAllowed`: a hostname, optionally prefixed with "*.". */
export function isHostPattern(value: string): boolean {
  return isHostname(value.startsWith('*.') ? value.slice(2) : value)
}

/** A DNS name with at least two labels and a non-numeric last label, so never an IPv4 literal. */
function isHostname(host: string): boolean {
  const shape = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i
  return shape.test(host) && !/^\d+$/.test(host.slice(host.lastIndexOf('.') + 1))
}
