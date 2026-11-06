// Keeps every request electron-updater makes under the feed base. Its Electron executor follows
// redirects with no check on scheme or host (builder-util-runtime's prepareRedirectUrlOptions only
// strips a few headers on a cross-origin hop), so one 30x from the feed host or a CDN to http://…
// would put the channel file and the zip within reach of anyone on the network. electron-updater
// makes all its requests in the "electron-updater" session partition, and each redirect hop is a new
// request there, so a webRequest filter on that partition sees every URL before it is fetched.
//
// Main wires it once, before the first check:
//
//   const guard = confineUpdaterSession(session.fromPartition(UPDATER_PARTITION, { cache: false }), FEED_BASE_URL)
//   createUpdater({ …, requestGuard: guard })

/** electron-updater's NET_SESSION_NAME. */
export const UPDATER_PARTITION = 'electron-updater'

/** The part of Electron's Session the guard uses. */
export interface SessionLike {
  readonly webRequest: {
    onBeforeRequest(
      listener: (
        details: { readonly url: string; readonly method?: string },
        callback: (response: { cancel: boolean }) => void,
      ) => void,
    ): void
  }
}

export interface FeedRequestGuard {
  /** How many requests have been cancelled so far. The updater compares it across a check. */
  refusals(): number
}

/**
 * True if `url` is a GET-able resource under `base`: the same scheme, host and port, no credentials,
 * and a path that starts with the base's path once the URL parser has resolved dot segments. A query
 * is allowed (electron-updater may add a cache-busting one); a fragment is never sent anyway.
 */
export function isUnderFeedBase(url: string, base: string): boolean {
  let parsed: URL
  let feed: URL
  try {
    parsed = new URL(url)
    feed = new URL(base)
  } catch {
    return false
  }
  if (!feed.pathname.endsWith('/')) return false
  if (parsed.protocol !== feed.protocol || parsed.host !== feed.host) return false
  if (parsed.username !== '' || parsed.password !== '') return false
  // Encoded slashes or backslashes could be read as separators by something downstream.
  if (/%2f|%5c|\\/i.test(parsed.pathname)) return false
  return parsed.pathname.startsWith(feed.pathname) && parsed.pathname.length > feed.pathname.length
}

/** Cancels every request in the session that isn't a GET under `base`, redirect hops included. */
export function confineUpdaterSession(session: SessionLike, base: string): FeedRequestGuard {
  let refused = 0
  session.webRequest.onBeforeRequest((details, callback) => {
    const method = details.method ?? 'GET'
    const allowed = (method === 'GET' || method === 'HEAD') && isUnderFeedBase(details.url, base)
    if (!allowed) refused++
    callback({ cancel: !allowed })
  })
  return { refusals: () => refused }
}
