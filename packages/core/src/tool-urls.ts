// URL helpers for tool code. The isolated tool process runs tool code in a context that holds only
// JavaScript's own built-ins (packages/runtime/src/isolation/worker.ts): there is no `URL` and no
// `URLSearchParams` there, so tool code that builds or reads a URL uses these instead. They cover
// what adapters need (an http(s) page's origin and path, a path on an origin, a query string) and
// nothing more; they are not a URL parser.

const ABSOLUTE = /^(https?):\/\/([^/?#\s]+)([^?#\s]*)(\?[^#\s]*)?(#\S*)?$/i

interface Parts {
  readonly origin: string
  readonly pathname: string
  readonly search: string
}

function partsOf(url: string): Parts | null {
  if (typeof url !== 'string') return null
  const match = ABSOLUTE.exec(url)
  if (match === null) return null
  const [, scheme = '', authority = '', path = '', search = ''] = match
  // Userinfo is refused: no adapter needs it, and it hides the real host.
  if (authority.includes('@')) return null
  let host = authority.toLowerCase()
  const defaultPort = scheme.toLowerCase() === 'https' ? ':443' : ':80'
  if (host.endsWith(defaultPort)) host = host.slice(0, -defaultPort.length)
  return { origin: `${scheme.toLowerCase()}://${host}`, pathname: path === '' ? '/' : path, search }
}

/** The origin of an http(s) URL, e.g. "https://example.com", or null for anything else. */
export function originOf(url: string): string | null {
  return partsOf(url)?.origin ?? null
}

/** The origin of an https URL, or null for anything else (about:blank, http, nonsense). */
export function httpsOriginOf(url: string): string | null {
  const origin = originOf(url)
  return origin?.startsWith('https://') ? origin : null
}

/** The path of an http(s) URL ("/" when it has none), or null for anything else. */
export function pathnameOf(url: string): string | null {
  return partsOf(url)?.pathname ?? null
}

/** The host of an http(s) URL, lower-cased and without a default port, or null. */
export function hostOf(url: string): string | null {
  const origin = originOf(url)
  return origin === null ? null : origin.slice(origin.indexOf('://') + 3)
}

/**
 * `path` (which must start with "/") on `origin`, with `query` appended as a query string. Values
 * are percent-encoded; keys with an undefined value are left out.
 */
export function urlOn(
  origin: string,
  path: string,
  query: Readonly<Record<string, string | number | boolean | undefined>> = {},
): string {
  if (originOf(origin) !== origin) throw new TypeError('urlOn: not a bare origin')
  if (!path.startsWith('/') || path.startsWith('//'))
    throw new TypeError('urlOn: path must start with one "/"')
  const search = queryString(query)
  return `${origin}${path}${search === '' ? '' : `${path.includes('?') ? '&' : '?'}${search}`}`
}

/** `a=1&b=x%20y`, in the given order, without a leading "?". */
export function queryString(query: Readonly<Record<string, string | number | boolean | undefined>>): string {
  return Object.entries(query)
    .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&')
}
