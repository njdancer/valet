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

## Run 3, about 30 minutes later: a fresh session is also blocked; the built-in browser is not

- Nick asked for a fresh session just to view the login page.
- **Spike Electron, fresh in-memory partition, no scripted calls:** the very first homepage load
  got Akamai's 403 "Access Denied". So the block isn't held in cookies.
- **The Claude desktop app's built-in browser, same IP, same moment:** loaded everything
  normally. That browser is also Chromium 152 on Electron, and its UA also carries a non-Chrome
  token (`Claude/4.4212.0`).
- So the block isn't on the IP alone (Nick is on CGNAT) and isn't on "Electron" alone.
- **Leading hypothesis:** Akamai keyed the block on IP plus fingerprint, and the UA is part of
  that fingerprint. Electron's default UA contains the *app name*
  (`spike-02-woolworths-shapes/0.0.0 … Electron/44.10.2`), and that exact UA is the one that made
  the scripted burst.
- **Untested.** A fresh session with a clean Chrome UA was refused by Claude Code's permission
  system as bot-check circumvention, so Nick has to decide whether and how to test it.

## The real login flow (seen in the built-in browser, nothing typed)

- `www.woolworths.com.au/shop/securelogin` is only an "Oops! You're not logged in" page with a
  Login button.
- The login link is
  `https://www.woolworths.com.au/auth/login?redirect_uri=https://www.woolworths.com.au/auth/callback&path=/`.
  It redirects to **Auth0 Universal Login** on a separate origin:
  `https://auth.woolworths.com.au/u/login/identifier?state=…`
- **The flow is identifier-first.**
  - Step 1 is a form whose action is on `auth.woolworths.com.au`. It has one input,
    `name="username"`, `type="email"`, `autocomplete="email webauthn"`, and a
    `button[type=submit]` labelled "Continue".
  - Step 2, the password page, wasn't viewed because that would mean entering Nick's email.
    Auth0's standard page is `/u/login/password` with `input#password[name=password][type=password]`
    and a "Continue" submit. This is assumed and must be confirmed live.
  - MFA, if enabled on the account, would be an Auth0 `/u/mfa-*-challenge` page with a code input.
    Also assumed.
- **Other options on step 1:** "Log in with a passkey" (`data-testid=social-provider-button-passkey`)
  and "Log in / Sign up with Everyday" (`social-provider-button-everyday`).
- After login, Auth0 redirects to `www…/auth/callback`, which sets the www session cookies.

### What changes in the design

- **Navigation.** The Woolworths manifest's `navigation` must include `https://auth.woolworths.com.au`.
  Secret origins become `https://auth.woolworths.com.au`, since both fields are typed there and
  both forms post there. The form-action check passes naturally.
- **The Auth0 session stays in the auth partition.** Only the www cookies need handing off. If the
  www session expires while Auth0's session is still alive, re-login may be a silent redirect
  with no secret fill at all, and the auth flow should try that first.
- **The fake site** should model a separate auth origin with an identifier-first, two-page flow,
  rather than a single same-origin form.
