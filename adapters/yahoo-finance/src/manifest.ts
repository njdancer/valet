// The Yahoo Finance manifest. No login: quotes, search and price history are all public.
//
// Seen from a macOS runner (2026-11-11, docs/findings/2026-11-11-yahoo-finance.md): a quote page,
// /quote/<symbol>/, is server-rendered with the data it shows embedded as JSON (the quote, the
// quote summary and a 24-hour spark), so get_quote reads the page and calls no API. The JSON API
// on query1 answered 429 to curl; whether it answers a real browser on the quote page is what the
// live run checks. Search and history use it.

import { type AdapterManifest, parseManifest } from '@valet/core'
import { apiOriginFor, REAL_ORIGIN } from './origins'

export { REAL_API_ORIGIN, REAL_ORIGIN } from './origins'

export interface ManifestOptions {
  /** Defaults to the real site. Tests point it at a fake. */
  readonly origin?: string
  /** Defaults to the real API host for the real site, else `origin` with "query1." in front. */
  readonly apiOrigin?: string
}

/** Quotes are delayed 15 to 20 minutes anyway; a minute's reuse costs nothing. */
export const QUOTE_CACHE_SECONDS = 60
export const SEARCH_CACHE_SECONDS = 3600
export const HISTORY_CACHE_SECONDS = 300

export function createManifest({
  origin = REAL_ORIGIN,
  apiOrigin = apiOriginFor(origin),
}: ManifestOptions = {}): AdapterManifest {
  return parseManifest({
    schemaVersion: 1,
    id: 'yahoo-finance',
    name: 'Yahoo Finance',
    version: '0.1.0',
    description:
      'Stock, index, currency and crypto quotes from Yahoo Finance: prices, key statistics, symbol search and price history. No account needed.',
    home: `${origin}/`,
    navigation: [origin],
    // The site's own scripts, styles and images (s.yimg.com and dozens of ad hosts) stay blocked:
    // the quote page's data is in its HTML, and nothing here needs the page to run.
    egress: [new URL(origin).hostname, new URL(apiOrigin).hostname],
    requests: [
      { method: 'GET', path: '/v1/finance/search', purpose: 'read', cacheSeconds: SEARCH_CACHE_SECONDS },
      {
        method: 'GET',
        path: '/v8/finance/chart/:symbol',
        purpose: 'read',
        cacheSeconds: HISTORY_CACHE_SECONDS,
      },
    ],
    tools: [
      {
        name: 'get_quote',
        title: 'Get quote',
        description:
          'The latest quote for one symbol (e.g. AAPL, BHP.AX, ^GSPC, AUDUSD=X, BTC-USD): price, change, day and 52-week range, volume, market cap, valuation and dividend figures, analyst targets, and pre- or post-market prices where there are any. Prices are delayed as the exchange requires (delayedMinutes).',
        sideEffect: 'read',
      },
      {
        name: 'search_symbols',
        title: 'Search symbols',
        description:
          'Finds ticker symbols by company, fund or index name (e.g. "commonwealth bank", "nasdaq"). Use it to get the symbol get_quote needs.',
        sideEffect: 'read',
      },
      {
        name: 'get_price_history',
        title: 'Get price history',
        description:
          'Open, high, low, close and volume for one symbol over a range (1d to max) at an interval (5m to 1mo).',
        sideEffect: 'read',
      },
    ],
    // Every tool makes at most two requests: a navigation (the tool page's first, to the home page)
    // and one page load or API call. The gap is short of Woolworths' 10 s because Yahoo is built
    // for heavy anonymous traffic, but it still paces: the API answered curl with 429 at once.
    limits: {
      requestsPerRun: 3,
      minGapMs: 3000,
      gapJitterPercent: 50,
      requestsPerMinute: 12,
      requestsPerHour: 240,
    },
  })
}

export default createManifest()
