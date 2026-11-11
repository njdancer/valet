// The real site's origins. Tool code derives the API's from the page it is on, so the same code
// serves a fake: the API is the page's host with "query1." in front.

export const REAL_ORIGIN = 'https://finance.yahoo.com'
export const REAL_API_ORIGIN = 'https://query1.finance.yahoo.com'

export function apiOriginFor(origin: string): string {
  if (origin === REAL_ORIGIN) return REAL_API_ORIGIN
  const url = new URL(origin)
  url.hostname = `query1.${url.hostname}`
  return url.origin
}
