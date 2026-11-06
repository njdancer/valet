// How the fake decides which route a path names. The real backend is ASP.NET behind IIS and Akamai,
// which (we assume; see fixtures/README.md) is lenient about spelling. The fake must be at least as
// lenient: if it were stricter, a runtime deny rule bypassed by `/%63heckout` or a trailing slash
// would look safe here ("checkout never reached") while working against the real site.

const ENCODED_UNRESERVED = /%(4[1-9A-F]|5[0-9A]|6[1-9A-F]|7[0-9A]|3[0-9]|2D|2E|5F|7E)/gi

/**
 * The route key for a path from `parseTarget` (so starting with `/`, dot segments resolved): unreserved characters
 * percent-decoded, repeated slashes collapsed, dot segments resolved again (decoding and collapsing
 * can make new ones), one trailing slash dropped, lower-cased.
 */
export function routePath(path: string): string {
  const decoded = path.replace(ENCODED_UNRESERVED, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  )
  const collapsed = decoded.replace(/\/{2,}/g, '/')
  const resolved = new URL(`http://fake.invalid${collapsed}`).pathname
  const trimmed = resolved.length > 1 && resolved.endsWith('/') ? resolved.slice(0, -1) : resolved
  return trimmed.toLowerCase()
}
