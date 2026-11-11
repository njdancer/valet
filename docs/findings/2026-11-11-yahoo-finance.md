# Yahoo Finance and Wikipedia from a macOS runner, 2026-11-11 (anonymous)

Nick couldn't reach his Mac for the live Woolworths sessions, and asked for real sites Valet can
be proven on with no login: Wikipedia, and Yahoo Finance, which is useful in its own right because
a Claude chat has no stock data otherwise. These probes were small, paced 3 to 4 s apart, and
anonymous, from a GitHub `macos-latest` runner (the cloud container's proxy reaches none of these
hosts).

## Yahoo Finance

- **Quote pages work.** `GET finance.yahoo.com/quote/<symbol>/` answered 200 for AAPL, BHP.AX,
  ^GSPC (as `%5EGSPC`) and AUDUSD=X (as `AUDUSD%3DX`), about 1 MB each. An unknown symbol answers
  404 with a page whose inline script sends the browser to `/?err=404`.
- **The data is in the HTML.** The page is server-rendered SvelteKit. Each API response its server
  fetched is embedded as `<script type="application/json" data-sveltekit-fetched data-url="…">`
  holding `{ status, statusText, headers, body }`, with the API's JSON as a string in `body`. The
  quote page embeds, among others, `v7/finance/quote` for the symbol (the main one's `fields`
  start with `fiftyTwoWeekHigh`), `v10/finance/quoteSummary/<symbol>` (summaryDetail,
  financialData, defaultKeyStatistics, summaryProfile, recommendationTrend and more; an index or
  currency gets only price and summaryDetail), and a 24-hour `v7/finance/spark`.
- **The JSON API refused curl.** Every `query1.finance.yahoo.com` call (search, chart, quote,
  quoteSummary) answered `429 Too Many Requests` with a 19-byte text body, from the first request,
  with or without a cookie jar. Yahoo set no cookies on the quote page for curl. Node's built-in
  fetch failed outright on the quote page: its headers are larger than undici accepts.
- **The history page doesn't render its table on the server.** `/quote/AAPL/history/` has an empty
  table; the browser fills it from the chart API.

So `get_quote` reads the quote page and makes no API call. `search_symbols` and
`get_price_history` call the API from the quote page's origin, as the site's own scripts do; the
recorded live run is what shows whether a real browser gets answers there.

## Wikipedia

The REST search (`/w/rest.php/v1/search/page`), the page summary
(`/api/rest_v1/page/summary/<title>`) and the action API's plain-text extract (`/w/api.php`,
`action=query&prop=extracts&explaintext=1`) all answered 200 JSON, with
`access-control-allow-origin: *`. A missing summary answers 404 JSON. The fixtures in
`adapters/wikipedia/test/fixtures/` are these captures, unchanged.

Wikipedia's login (not used) is the closest analogue to Woolworths' found so far:
`en.wikipedia.org/wiki/Special:UserLogin` 302s to `auth.wikimedia.org`, which sets the session on
the wiki through central-login redirects.
