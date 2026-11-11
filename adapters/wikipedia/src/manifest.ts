// The Wikipedia manifest. No login: reading and searching are public. English Wikipedia only for
// now; another language is another origin, and so another review.
//
// Every call is a GET to Wikipedia's own APIs, the ones its pages and apps use: REST search, the
// page summary, and the action API's plain-text extract. MediaWiki's action API (api.php) writes
// only by POST with a token, and no POST is declared, so nothing here can edit.

import { type AdapterManifest, parseManifest } from '@valet/core'
import { REAL_ORIGIN } from './site'

export { REAL_ORIGIN } from './site'

export interface ManifestOptions {
  readonly origin?: string
}

/** Articles change, but not by the minute. */
export const CACHE_SECONDS = 3600

export function createManifest({ origin = REAL_ORIGIN }: ManifestOptions = {}): AdapterManifest {
  return parseManifest({
    schemaVersion: 1,
    id: 'wikipedia',
    name: 'Wikipedia',
    version: '0.1.0',
    description:
      'Search English Wikipedia and read its articles, as summaries or full plain text. No account needed.',
    home: `${origin}/`,
    navigation: [origin],
    egress: [new URL(origin).hostname],
    requests: [
      { method: 'GET', path: '/w/rest.php/v1/search/page', purpose: 'read', cacheSeconds: CACHE_SECONDS },
      {
        method: 'GET',
        path: '/api/rest_v1/page/summary/:title',
        purpose: 'read',
        cacheSeconds: CACHE_SECONDS,
      },
      { method: 'GET', path: '/w/api.php', purpose: 'read', cacheSeconds: CACHE_SECONDS },
    ],
    tools: [
      {
        name: 'search_articles',
        title: 'Search articles',
        description:
          'Searches English Wikipedia. Returns article titles with a one-line description and a short excerpt.',
        sideEffect: 'read',
      },
      {
        name: 'get_summary',
        title: 'Get article summary',
        description:
          'The lead of one article in plain text, with its description and link. Follows redirects.',
        sideEffect: 'read',
      },
      {
        name: 'get_article',
        title: 'Get article',
        description:
          'The whole text of one article in plain text, with its section headings, up to maxChars characters (truncated says if it was cut). Follows redirects.',
        sideEffect: 'read',
      },
    ],
    // Wikimedia asks API clients to keep to one request at a time; a second apart is gentler still.
    limits: { requestsPerRun: 3, minGapMs: 1000, requestsPerMinute: 30, requestsPerHour: 600 },
  })
}

export default createManifest()
