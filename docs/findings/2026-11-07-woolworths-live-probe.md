# Woolworths live probe, 2026-11-07 (anonymous)

The probe ran from an Electron 44 hidden window with Electron's default user agent and no login.
Raw output is in `spikes/02-woolworths-shapes/results/` (gitignored); the scrubbed fixtures are in
`fakes/woolworths-site/fixtures/`.

## Run 1: worked

- **Homepage.** It loaded, and Akamai set its cookies (`_abck`, `bm_sz`, `bm_s`, `bm_so`, `bm_sv`,
  `ak_bmsc`). The default Electron UA was not refused.
- **In-page `fetch` with same-origin credentials** returned 200 JSON from three endpoints:
  - `POST /apis/ui/Search/products`, with JSON body keys `SearchTerm`, `PageSize`, `PageNumber` and
    `SortType`. Response keys: `Products`, `SearchResultsCount`, `Corrections`, `SuggestedTerm`,
    `Aggregations` and others.
  - `GET /apis/ui/Search/products?searchTerm=…` gives the same response shape.
  - `GET /apis/ui/Trolley` (anonymous). Response keys: `AvailableItems`, `UnavailableItems`,
    `Totals`, `TotalTrolleyItemQuantity`, `TrolleyItemCount` and others.
- `GET /apis/ui/product/detail/<stockcode>` returned keys `Product`, `Nutrition`, `PrimaryCategory`,
  `AdditionalAttributes` and others.
- **Anonymous visitors already get auth cookies:** `wow-auth-token` and `prodwow-auth-token`, both
  httpOnly. The presence of a token cookie is therefore **not** a login probe.
- **The site's own calls on load:** `GET /api/ui/v2/bootstrap`, `GET /apis/ui/settings`,
  `GET /auth/heartbeat`, `POST acs.woolworths.com.au/rest/v1/delivery`, and Akamai sensor POSTs
  to obfuscated paths on www.
- **Third-party hosts.** The homepage contacts about 45 hosts (Tealium, Adobe, DoubleClick,
  TikTok, Bing, Facebook, Dynatrace, mPulse and others). Most are analytics. A strict egress
  allowlist must at least allow www, `cdn0.woolworths.media`, `acs.woolworths.com.au` and
  Akamai's paths on www. Whether the site still works with the analytics hosts blocked is
  untested.

## Run 2, about 3 minutes later: blocked

- Every request from the same persistent partition got Akamai's "Access Denied" HTML with a 403.
  That included the homepage (`GET /`), `/api/ui/v2/bootstrap`, `/auth/heartbeat` and
  `/shop/securelogin`.
- Run 1 made 4 scripted fetches about 2.5 s apart, straight after the homepage. That was enough to
  flag the session, the IP, or both.
- We did not retry or try to evade it. No more live requests were made overnight.

## What this means

1. **Validation.** Electron's bundled Chromium is acceptable to Akamai _as a browser_. Scripted
   API traffic with no human-like page activity gets flagged fast. The amasolov server's pacing
   (at most 2 concurrent, ≥250 ms apart, heavy caching, 1-minute backoff) is consistent with this.
2. **Adapter design implications:**
   - Prefer the requests the page makes itself (navigate to the search page and read results)
     for reads where possible, or keep API calls sparse, cached, and interleaved with real
     navigation.
   - A per-site **rate budget** and a **backoff circuit breaker** belong in the runtime, not each
     adapter. They are added to the plan.
   - A block must surface as `blocked-by-site`, not `failed`, and must stop further calls for a
     cool-down.
3. **Open, needs Nick:**
   - The login page structure. The form was not captured before the block. The real auth
     flow's selectors have to be recorded in a logged-in session with Nick present.
   - A login probe. `/api/ui/v2/bootstrap` is the likely candidate; it's unconfirmed.
   - Whether the block affected Nick's normal browsing from this IP. Akamai blocks are usually
     short-lived and per-session.
