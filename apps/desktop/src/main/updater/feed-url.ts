// The update feed's base URL, checked in one place: electron-builder.config.ts checks
// SITEADAPTER_UPDATE_URL with it before writing app-update.yml, and createUpdater checks a feed URL
// passed to it. The feed is a static directory (latest-mac.yml, beta-mac.yml and the zips), so a
// URL that needs anything more than a host and a path is a mistake or a token, and is refused.

export const MAX_FEED_URL_LENGTH = 2048

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost'])

export interface FeedUrlOptions {
  /**
   * Accept plain http to a loopback host: the local fake update server in tests, and the updater
   * end-to-end build. Never for a release build.
   */
  readonly allowLoopbackHttp?: boolean
}

/**
 * Returns the URL if it is an acceptable feed base, else null. Acceptable means: https (or http to
 * loopback when allowed), no credentials, no query string or fragment (where a token would go, and
 * which would end up in logs), a path ending in "/", and already in the canonical form the URL parser
 * would produce, so what was reviewed is exactly what is fetched.
 */
export function validateFeedUrl(text: unknown, options: FeedUrlOptions = {}): string | null {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_FEED_URL_LENGTH) return null
  // The URL parser silently drops tabs and newlines, so check the raw text first.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses
  if (/[\s\u0000-\u001f\u007f]/.test(text)) return null
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }
  if (url.href !== text) return null
  if (url.username !== '' || url.password !== '') return null
  if (url.search !== '' || url.hash !== '' || text.includes('?') || text.includes('#')) return null
  if (!url.pathname.endsWith('/')) return null
  if (url.protocol === 'https:') return url.href
  if (url.protocol === 'http:' && options.allowLoopbackHttp === true && LOOPBACK_HOSTS.has(url.hostname)) {
    return url.href
  }
  return null
}
