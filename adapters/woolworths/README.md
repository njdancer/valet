# Woolworths adapter

Searches woolworths.com.au and manages the online cart. It never checks out: no declared request
touches a checkout or payment path, and no tool is `irreversible`.

> **Woolworths' terms prohibit automated access.** Clause 1.4(b)(viii) of the site's terms of use
> bars "any robot, spider, site search and retrieval application or other mechanism to retrieve or
> index any portion of the Site", with no exception for personal use
> ([what we read](../../docs/findings/2026-11-07-woolworths-terms.md)). Whether to use this adapter
> with your own account is your call and your responsibility. It is not affiliated with or endorsed
> by Woolworths.

```ts
import adapter, { createAdapter } from '@valet/adapter-woolworths'

adapter // the real site: www.woolworths.com.au, signing in on auth.woolworths.com.au
createAdapter({ origin: site.origin, authOrigin: site.authOrigin }) // the fake site, for tests and e2e
createAdapter({ totp: true }) // also fill Auth0's authenticator-app challenge from 1Password
```

`createManifest(options)` does the same for the manifest alone. Without `authOrigin`, a fake
origin's auth origin is the same host with `www.` swapped for `auth.` (port kept). With a fake
origin, egress is that www host only, so an e2e run can't reach the live site even by mistake.

## Tools

All site calls are in-page `fetch`es with paths relative to the page, so cookies stay in the
browser and the same code serves both origins. Output is reshaped into plain fields; raw
Woolworths JSON never reaches the client.

| Tool                | Side effect | Login  | Site calls                                    |
| ------------------- | ----------- | ------ | --------------------------------------------- |
| `search_products`   | read        | no     | `POST /apis/ui/Search/products`               |
| `get_product`       | read        | no     | `GET /apis/ui/product/detail/:stockcode`      |
| `get_cart`          | read        | ensure | `GET /apis/ui/Trolley`                        |
| `add_to_cart`       | write       | ensure | `GET /apis/ui/Trolley`, then `POST …/update`  |
| `set_cart_quantity` | write       | ensure | `POST /api/v3/ui/trolley/update`              |
| `remove_from_cart`  | write       | ensure | `POST /api/v3/ui/trolley/update` (quantity 0) |

- **`search_products { query, page = 1, pageSize = 12 (≤ 36), specialsOnly = false }`** returns
  `{ total, suggestedQuery, products: [{ stockcode, name, brand, size, price, cupPrice, wasPrice,
onSpecial, available, imageUrl }] }`. `wasPrice` is set only for specials whose was-price is above
  the price. `imageUrl` is null unless it is https. The query goes in the POST body, never the URL.
- **`get_product { stockcode }`** returns the summary fields plus `description` (HTML turned into
  plain text), `ingredients`, `allergens { contains, mayBePresent, statement }`, `dietary`,
  `healthStarRating`, `countryOfOrigin`, `category { department, aisle }` and `nutrition
{ servingSize, servingsPerPack, per100: [{ nutrient, amount }] }` (null when there's no panel).
- **`get_cart {}`** returns `{ items, unavailable, subtotal, savings, itemCount, totalQuantity,
notices }`. Each item is `{ stockcode, name, quantity, price, lineTotal, available }`; an
  unavailable one adds a `reason` for the trolley bucket it came from (`unavailable`,
  `over-supply-limit`, `over-stock-limit`, `conflicted`, `restricted`, `needs-id-verification`, …).
  `itemCount` is distinct products and `totalQuantity` units, both as the site counts them.
  `notices` are the site's own cart messages, such as a minimum spend, then the adapter's.
- **`add_to_cart { stockcode, quantity = 1 }`** reads the current quantity and sets
  current + quantity, because the update endpoint sets absolute quantities. It refuses to go over
  50 on one line, makes no write if the call is cancelled after the read, and makes no write if
  the trolley it read isn't complete (below), since the write could shrink a line it can't see
  (`tool-run` / `site-changed`).
- **`set_cart_quantity { stockcode, quantity 0..50 }`** and **`remove_from_cart { stockcode }`**
  make one write each.

### What the write tools report

Every write returns `{ stockcode, quantity, confirmed, cart, notices }`, plus `requestedQuantity`
(and `previousQuantity` for `add_to_cart`), or `removed` for `remove_from_cart`:

- When the reply is a trolley, `quantity` is the line's quantity **in that trolley**, not the one
  asked for, and `confirmed` is true. The site clamps to its own supply limits (often 36), so
  `set_cart_quantity { quantity: 50 }` can return `quantity: 36`; a notice then says the two
  differ. A line missing from a complete reply counts as 0. `removed` is `quantity === 0`.
- When the reply isn't a trolley, `quantity`, `cart` and `removed` are null, `confirmed` is false,
  and a notice says to call `get_cart`. The write may or may not have happened. The tools don't
  spend another request finding out.
- When the reply is a trolley the adapter can't fully read and the line isn't in the part it
  can, `quantity` is null and `confirmed` false.
- A 2xx reply with `Success: false`, or a non-trolley reply with a non-empty `Errors`, throws
  `tool-run` / `invalid`: the site refused the change.

A trolley is **complete** when every item in every bucket parses, no product sits in two buckets,
and the products read add up to the site's `TrolleyItemCount`. The buckets beyond `AvailableItems`
were all empty in the captured trolley, so their item shape is assumed; `BundleItems` is never
read. An incomplete trolley gets a fixed notice in `get_cart`, and `add_to_cart` refuses it.

**Parallel writes.** `add_to_cart` is a read-modify-write, and nothing in the adapter serialises
it. Two parallel `add_to_cart(88436, 1)` calls can both read 2 and both write 3, and both see 3
in the reply, so the lost addition goes unnoticed. A runtime retry after the POST reached the site
would instead add twice; that one shows up as a "stored more than asked for" notice. The runtime
must run a site's write tools one at a time and must not retry a write whose request may have been
sent (core change requests below).

### Failures

Tools throw, never a raw error or a result that describes the failure:

| Situation                                   | Thrown                                                                                                            |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `ensure()` says `needsUser`                 | `NeedsUserError(reason)`, the reason if it is in core's vocabulary, else `other`                                  |
| `ensure()` failed                           | `ValetError` with its own stage and class, if both are in the core vocabularies, else `auth-step` / `auth-failed` |
| HTTP 401 on a cart call                     | one more `ensure()` and a retry from the start of the tool; a second 401 is `tool-run` / `not-logged-in`          |
| HTTP 401 on a product call                  | `tool-run` / `not-logged-in`                                                                                      |
| HTTP 403 (Akamai)                           | `tool-run` / `blocked-by-site`                                                                                    |
| HTTP 429                                    | `tool-run` / `rate-limited`                                                                                       |
| 2xx that is HTML (block page or login page) | `tool-run` / `blocked-by-site`                                                                                    |
| 2xx that is neither JSON nor HTML           | `tool-run` / `unavailable`                                                                                        |
| HTTP 404, or detail with no `Product`       | `tool-run` / `not-found`                                                                                          |
| Other non-2xx, or `fetch` threw             | `tool-run` / `unavailable`                                                                                        |
| JSON not in the expected shape              | `tool-run` / `site-changed` (see [Drift detection](#drift-detection))                                             |
| Signal aborted before a call                | `tool-run` / `aborted`                                                                                            |
| `add_to_cart` would exceed 50               | `tool-input` / `invalid`                                                                                          |
| `add_to_cart` read an incomplete trolley    | `tool-run` / `site-changed`                                                                                       |
| Update reply says the site refused          | `tool-run` / `invalid`                                                                                            |

Cart tools throw rather than returning a "please log in" result so the runtime records a failed
call. `NeedsUserError` ends the run as `needsUser` with a reason code (`captcha`, `otp-required`,
`account-locked`, `login-required`, `terms-update`, `site-changed`), and the app shows the person
the login window. The
auth steps' notes, which say what happened in words, are shown only in the app; nothing but the
code reaches the MCP client.

Every cart tool calls `ensure()` before its first site call, because the anonymous trolley also
answers 200: without it, a logged-out `add_to_cart` would fill a trolley nobody sees. If the
session expires between the probe and the call, the site answers 401; the tool then runs
`ensure()` once more and starts again from the top. Retrying is safe because the refused request
changed nothing, and `add_to_cart` re-reads the trolley before writing, so it never adds twice.

Three numbers shape a run of cart calls, all declared in the manifest and all assumptions
Nick hasn't been asked about ([benchmark](../../docs/findings/2026-11-10-shop-benchmark.md)):

- **The probe is trusted for 60 s, by write tools only** (`session.probe.trustSeconds`). An
  `add_to_cart`, `set_cart_quantity` or `remove_from_cart` within a minute of a "logged in" probe
  skips its own. `get_cart` always probes and always reads the site's own trolley, so it is the
  check to end a shop with. The risk taken: a session that ends inside that minute sends the
  writes of that minute to an anonymous trolley, reported as successes, until the next probe logs
  in again. Set `PROBE_TRUST_SECONDS` to 0 in `manifest.ts` to take it back.
- **At most 100 requests an hour** (`limits.requestsPerHour`). D28 said 60, which a thirty-item
  shop can't fit. A call that would start past the cap is refused with a time to try again.
- **The runtime's read cache** (D28). Search and product answers are reused for 15 minutes. The
  trolley is reused for 2 minutes and only as the starting point of an `add_to_cart`; a cart
  write's reply replaces it. So a run of adds reads the trolley once. An add that starts from a
  cached trolley the person has since changed in their own browser overwrites that one line's
  quantity, as it would have within the 10 s between its read and its write before. A cached
  trolley the adapter can't fully read is never used: the site is asked.

An HTML 2xx can be Akamai's challenge or the login page served to an expired session; nothing in
the response tells them apart. It is reported as `blocked-by-site`, as the runtime's own block
detection does, so the runtime backs off; its next `ensure()` probe then finds an expired session.

A `ValetError` thrown by the runtime's own guards (for example the request ceiling) passes
through unchanged.

## Login

The live probe found the login on a separate origin
([findings](../../docs/findings/2026-11-07-woolworths-live-probe.md), runs 3–4): www's
`/auth/login?redirect_uri=…/auth/callback&path=/` redirects to Auth0 Universal Login on
`https://auth.woolworths.com.au`, which asks for the email on one page and the password on the
next, then sends the browser back to www's `/auth/callback`, which sets the www session cookies.
So:

- `navigation` is `[www, auth]`. The `login` secret (`username`, `password`) is requested for the
  auth origin only, where both are typed and both forms post.
- `egress` and `session.cookieDomains` stay on www, and the tool partition never talks to the
  auth origin. `cookieDomains` is `[woolworths.com.au, www.woolworths.com.au]`: the bare-host
  entry is what matches a cookie set with `Domain=.woolworths.com.au`, from either origin. Auth0's
  own cookies (its session, "remember this device") are assumed host-only on the auth origin, so
  the hand-off never copies them; a cookie the login pages set for the whole domain (analytics,
  say) _is_ copied, which shows the tool partition nothing a browser wouldn't already send to
  www. If Auth0's session cookie turned out to be domain-wide, it would cross too: a live check.
- The probe stays `GET /api/ui/v2/bootstrap` → `ShopperDetails.IsLoggedIn === true`, with 401 as
  the logged-out status. Anonymous visitors get `wow-auth-token` cookies, so a cookie probe would
  lie; an anonymous bootstrap answers 200 with `IsLoggedIn: false`.
- **The probe depends on a core change.** The runtime makes it in the tool page, inside the
  tool's run, and core v2's driver holds every request there to the request surface and the
  ceiling. Bootstrap is deliberately not declared, so that tool code can't read the shopper
  details it probably returns once logged in. Under core v2 as it is, every cart tool's
  `ensure()` is therefore refused at the probe (`request-surface` / `undeclared-request`), and
  only `search_products` and `get_product` work. The e2e shows both (core change requests).

The steps go to the login link, then handle each page only if it is the page expected, by its path
and its field together:

1. **Identifier** (`/u/login/identifier`, `input[name="username"]`): fill the email, click the
   primary button (`button[type="submit"][name="action"][value="default"]`, never the passkey or
   Everyday ones). Skipped when Auth0 goes straight to the password.
2. **Password** (`/u/login/password`, `input#password`): fill it and submit. Typed once per run.
3. **MFA**, if Auth0 asks: on `/u/mfa-sms-challenge`, the code from Messages (sender
   `Woolworths`, pattern `\b(\d{6})\b`, at most 5 minutes old); on `/u/mfa-otp-challenge`, the
   `otp` field of the `login` 1Password item, but only with `createManifest({ totp: true })`;
   otherwise (email, or an authenticator without `totp`) `needsUser`. Then tick "Remember this
   device" if it is unticked (`input[name="rememberBrowser"]:not(:checked)`) and submit.
4. If the page is off every login path but still shows Auth0's container (`main._widget`), such
   as a tenant error page, `needsUser` (`site-changed`): conditions can't see the host, so this
   is what keeps an Auth0 page from reaching the probe as "logged in?". Otherwise `assertLoggedIn`.

**Silent re-login.** When the www session has expired but Auth0's session (in the persistent auth
partition) hasn't, `/auth/login` comes straight back to www with no page in between. The same
steps then find themselves off the login pages after the `goto`, skip every page, type nothing,
and assert the login. A remembered device skips step 3 the same way.

Conditions only ever see a URL's path and query, never its host, so "off the login pages" is a
path test: not under Auth0's `/u/`, `/authorize`, `/login` or `/continue`, nor www's `/auth/` or
`/shop/securelogin`. They use `urlContains` and core-screened `urlRegex`.

Each wait for the page to change is a `settle`: nested `when`s with pauses between looks (10 s in
all), which return as soon as the page moves on and never fail. There is no `waitFor`, because
its timeout ends the flow as `condition-timeout`, and the security model sends challenges and
unexpected prompts to the person instead. Every way the flow can stop is a `needsUser` with a
reason code and a fixed in-app note (`NOTES` in `src/manifest.ts`):

| Where                                                    | Reason           |
| -------------------------------------------------------- | ---------------- |
| A CAPTCHA on any page, before typing there               | `captcha`        |
| Still on the identifier page after Continue              | `login-required` |
| Still on the password page: account blocked              | `account-locked` |
| Still on the password page: anything else                | `login-required` |
| An email code, or an authenticator without TOTP          | `otp-required`   |
| Still on the challenge page after the code               | `otp-required`   |
| Auth0's terms or consent page (`/u/terms`, `/u/consent`) | `terms-update`   |
| Another Auth0 page (phone enrolment, an error page, …)   | `site-changed`   |
| No login page appeared at all                            | `site-changed`   |

`site-changed` and `terms-update` tell an MCP client to stop retrying; the note says the rest.

### Timing

The worst case is 40 s of pauses (four settles of 10 s: after the goto, the email, the password
and the code), plus the wait for the SMS, which the auth flow polls for until its own deadline.
So the stall exits stay typed `needsUser`s only if:

- the auth flow's `flowTimeoutMs` is at least 40 s plus the time an SMS takes to arrive: **90 s**
  is the setting this adapter expects, and
- the runtime's tool timeout is longer than `flowTimeoutMs` plus everything else in the run. The
  worst run is `add_to_cart`'s 401 retry: eight tool-partition requests (the tool page's first
  navigation, four probes, two reads and the write), paced 2.5 s apart (`limits.minGapMs`), so
  about 20 s, plus a second, silent login of a few seconds. The default 120 s
  (`DEFAULT_TOOL_TIMEOUT_MS`) covers a 90 s flow with little to spare; a longer flow timeout
  needs a longer tool timeout.

Otherwise a slow but legitimate login ends as `timeout` / `timed-out` instead of the `needsUser`
the security model wants. Core has no way to declare these per adapter (core change requests).

The request surface lists exactly the calls the tools make, and a test fails if a declaration goes
unused. The login probe is not on it, so tool code can't read the shopper details that endpoint
probably returns once logged in; see above for what that costs until core allows the runtime's
probe.

### The CAPTCHA's frame

Auth0's bot detection renders its challenge in a third-party iframe: Auth Challenge uses
Cloudflare Turnstile, and the alternatives are reCAPTCHA, hCaptcha and Arkose. Core v2's driver
lets an auth page's subframes load only from `navigation` plus `auth.frameOrigins`, and the
manifest leaves `frameOrigins` empty until the provider is confirmed live. Until then the
`captcha` exit hands the person a window whose challenge frame was refused, so they can't solve it
there (the e2e shows it). `createManifest({ captchaFrameOrigins })` declares the origin once it
is known; a frame origin is never a secret origin, so nothing is typed into it.

## Verified live and assumed

From the probe of 2026-11-07 ([findings](../../docs/findings/2026-11-07-woolworths-live-probe.md)):

| Item                                                                                                                     | Status                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Search POST body keys `SearchTerm`, `PageSize`, `PageNumber`, `SortType`, and the response shape                         | Verified                                                                                                                                                  |
| Product detail path and response shape                                                                                   | Verified                                                                                                                                                  |
| Empty trolley response shape (`AvailableItems`, `Totals`, `Errors`, …)                                                   | Verified                                                                                                                                                  |
| Egress hosts: www, `cdn0.woolworths.media`, `acs.woolworths.com.au`                                                      | Verified as needed; whether the site works with analytics hosts blocked is untested                                                                       |
| Login link `/auth/login?redirect_uri=…&path=/` redirecting to Auth0 on `auth.woolworths.com.au`                          | Verified (run 3, nothing typed)                                                                                                                           |
| Identifier page: `input[name=username]`, `type=email`, a submit labelled Continue, separate passkey and Everyday options | Verified                                                                                                                                                  |
| The Continue button's `name="action" value="default"`                                                                    | **Assumed** (Auth0's standard markup); the probe recorded only `type=submit`. If wrong, the click fails as `element-missing` before the password is typed |
| Password page `/u/login/password`, `input#password[name=password]`                                                       | **Assumed** (Auth0 standard; not viewed, as that meant entering Nick's email)                                                                             |
| Errors as `.ulp-input-error-message`, blocked account as `[data-error-code="user-blocked"]`                              | **Assumed** (Auth0 standard)                                                                                                                              |
| CAPTCHA as `.ulp-captcha-container`                                                                                      | **Assumed** (Auth0 bot detection)                                                                                                                         |
| The CAPTCHA provider and the origin its iframe loads from                                                                | **To be confirmed** live (Turnstile would be `https://challenges.cloudflare.com`). Until then `auth.frameOrigins` is empty and the challenge can't show   |
| Every Universal Login page, error pages included, renders in `main._widget`                                              | **Assumed** (Auth0 standard). If wrong, an Auth0 page off the login paths reaches `assertLoggedIn` and ends as `probe` / `not-logged-in`                  |
| New terms and consent prompts at `/u/terms` and `/u/consent`                                                             | **Assumed** (Auth0 standard). Elsewhere they end as `site-changed`                                                                                        |
| A cart call on an expired login answers 401, not an anonymous trolley                                                    | **Assumed.** If the site serves an anonymous trolley instead, the 401 retry never fires and the next call's probe finds the expired session               |
| MFA pages `/u/mfa-{sms,email,otp}-challenge`, `input#code`, `input[name=rememberBrowser]`                                | **Assumed** (Auth0 standard). Whether Nick's account has MFA, and which factor, is decision D4                                                            |
| Messages sender `Woolworths` and a six-digit code                                                                        | **To be confirmed** when Nick next gets a code. The person approves the real sender when granting Messages access                                         |
| The remember-device checkbox is visible to a click                                                                       | **Assumed.** If Auth0 styles the real input invisible, the tick is skipped and MFA is asked every login                                                   |
| Silent re-login while Auth0's session lives                                                                              | **Assumed** (standard Auth0)                                                                                                                              |
| After the callback, www's session cookies are on www or the bare domain, not the auth host                               | **Assumed.** The hand-off copies only `woolworths.com.au` and `www.woolworths.com.au`                                                                     |
| Login probe `GET /api/ui/v2/bootstrap` → `ShopperDetails.IsLoggedIn === true`, 401 when logged out                       | **Assumed.** The endpoint exists and returned 200 anonymously; the field path is unconfirmed                                                              |
| Search `IsSpecial` flag                                                                                                  | **Assumed.** The tool also filters to specials locally, so results are right either way, but `total` is then the site's count                             |
| Trolley item shape: product tiles with `QuantityInTrolley`                                                               | **Assumed.** The anonymous trolley was empty, so `trolley-two-items.json` is synthesised from real search tiles                                           |
| Update body `{ items: [{ stockcode, quantity }] }`, absolute quantities, quantity 0 removes                              | **Assumed** from community code. Real clients may send more fields (`source`, `diagnostics`, …)                                                           |
| Update response is the updated trolley                                                                                   | **Assumed.** Otherwise the write is reported unconfirmed                                                                                                  |
| Other trolley buckets hold product tiles; `ExceededSupplyLimitGroups` holds `{ Items }` groups                           | **Assumed.** Captured empty. An item that doesn't parse makes the trolley incomplete, so `add_to_cart` refuses it                                         |
| A refused update replies 2xx with `Success: false` or a non-empty `Errors`                                               | **Assumed** from other Woolworths endpoints. A refusal in some other shape is reported unconfirmed, not as success                                        |

The live site flagged four scripted calls in ten seconds (run 2 of the probe). Each tool makes at
most two calls, the manifest caps a run at six requests and asks for at least 2.5 s between
requests (`limits.minGapMs`); the rest of the pacing and the circuit breaker are the runtime's.

## Drift detection

The site will change what it sends one day. When it does, the tools fail rather than return wrong
data, and drift detection says which field changed, without ever copying a value.

- **In the tools.** Every response is parsed with the zod schemas in `src/wire.ts`. JSON that
  fails is `tool-run` / `site-changed`: retrying won't help, the adapter needs an update.
  (`unexpected-shape` stays for answers of the wrong kind, such as HTML where JSON was asked for.)
- **The checks.** `checkResponse(endpoint, body)` in `src/drift.ts` runs the tool's own schema,
  reads the trolley's unconfirmed buckets item by item as `get_cart` does, and also lists declared
  fields the body didn't carry. Most fields are nullish, so a renamed field still parses (the
  tool would show no price, say); the absent list is where that shows up. Reports hold paths,
  zod codes and JSON type names only (core's `checkShape` and `describeShape`).
- **Against fixtures** (`test/drift.test.ts`). Every recorded fixture, here and in the fake site,
  must pass with nothing absent, and a new fixture file fails the test until it's listed. So must
  every response the fake builds: searches, every catalogue product's detail, the not-found body,
  and empty and full trolleys. The fake's `setShapeDrift('renamed-field' | 'changed-type')` makes
  it drift, and the e2e suite checks every tool then fails with `site-changed` and writes nothing.
- **The smoke test** (`smoke/`, `pnpm test:smoke`). The three reads (a 3-product search, that
  product's detail, the trolley) through the real `ElectronSessionDriver` with this manifest's
  egress and request surface at purpose `read`, in a fresh temporary profile. It stops at the
  first 403, 429 or HTML answer. The dry run against the fake runs in CI, once clean and once
  with each drift. The live run skips unless `VALET_LIVE_SMOKE=1`: anonymous, 8 s for the home
  page to settle, then 10 s between reads, at most once a day, run by Nick by hand
  (`VALET_LIVE_SMOKE=1 pnpm --filter @valet/adapter-woolworths test:smoke`). Each run writes its
  report, with every response's keys and types, to `out/smoke/`.
- **Not covered yet.** The login probe's `/api/ui/v2/bootstrap` (it goes through the driver's
  probe, not a tool), the update endpoint's reply, and a logged-in trolley with items, whose shape
  is still assumed. Those wait for M2's sessions with Nick.

## Tests

`test/fake-context.ts` is a `ToolContext` whose `page.fetch` serves fixtures and, like the runtime,
refuses any request `decideRequest` would refuse for the manifest. `request-surface.test.ts` runs
every tool against both the real and the fake manifest and checks each call's purpose against the
tool's side effect. `auth-steps.test.ts` walks the auth steps against scripted Auth0 pages, every
combination included, and checks that the flow never runs off the end and types each secret at
most once.

`e2e.test.ts` runs the adapter against `@valet/fake-woolworths-site` over real HTTPS, with
a test certificate from `openssl`. Without openssl the suite fails; `VALET_SKIP_E2E=1`
skips it on purpose. It runs through `test/e2e/`, a stand-in for the runtime and the Electron
driver: a cookie jar per partition that honours `Domain=`, a minimal DOM with one level of
iframes (loaded only from the origins core v2 allows), the secret-fill guards, `ensure()` as the
runtime runs it (probe in the tool page under the run's policy, login, hand-off, probe again),
every hop of a tool-partition navigation or fetch held to the run's egress, surface, side effect
and ceiling, and output redaction. It interprets only the steps this manifest uses, and resolves
only the test hostnames, to 127.0.0.1.

It proves the login through both origins (SMS and authenticator MFA, remember-device, silent
re-login), each `needsUser` exit, every cart tool on the handed-off session, and that checkout is
refused however it is spelled. Against a hostile site: a password form posting elsewhere, fields
of the wrong type (password and code), a login form in a frame from an undeclared origin and from
a declared non-secret one, Auth0 or www's callback redirecting off-site after the login, a www
redirect off the egress list from a tool's fetch and from its navigation, and a stale SMS code.

`HarnessDriver`'s `probeAllowance` models the probe: `'none'` is core v2 as it is (the e2e shows
every cart tool refused), `'uncounted'` (the default) is the allowance requested below, and
`'counted'` the same allowance counted against the ceiling, which the 401-retry test shows
overflowing it.

Fixtures in `test/fixtures` were trimmed from the captured responses in
`spikes/02-woolworths-shapes/results/shapes.json` (gitignored): `Aggregations` cut to one entry and
each product's `AdditionalAttributes` cut to a few keys. No cookies. `search-milk.json`,
`product-detail-88436.json` and `trolley-empty.json` are real responses; `trolley-two-items.json`
is synthesised as described above. Edge cases are made in each test by copying a fixture and
changing one field.

## Open questions for Nick

- **Which CAPTCHA does Auth0 show on auth.woolworths.com.au, and from which origin does its frame
  load?** Next time a challenge appears in a normal browser, the frame's `src` in the inspector is
  enough. That origin then goes in `auth.frameOrigins`.
- Is the Messages sender for the SMS code shown as `Woolworths`, and is the code six digits?
- Does the account have MFA, and by SMS, email or an authenticator app (decision D4)?

## Core change requests

- **A runtime-probe allowance in the tool partition.** Core v2's driver holds every request in
  the run to the request surface and the ceiling, the runtime's own `session.probe` included, so a
  fetch probe on an undeclared path is refused and every login-needing tool fails before it can
  log in. Declaring the probe path would hand it to tool code. Requested: the driver admits
  exactly `GET <home origin><session.probe.path>` (no query) when the runtime makes it, through a
  handle tool code never holds, still held to egress, the breaker and the rate budget, and either
  not counted against `requestsPerRun` or counted separately. Counted, `add_to_cart`'s 401-retry
  path costs eight requests (navigation, four probes, two reads, the write) against a ceiling of
  six; counted apart, the tool's own share is four.
- **Timeouts that end as needsUser, and timing per adapter.** A `waitFor` with an `onTimeout`
  (a needsUser reason) would replace the nested-`when` settles. The flow also needs a
  `flowTimeoutMs` long enough for four 10 s settles plus an SMS (90 s here), and a tool timeout
  longer than that plus the run's paced requests (about 20 s in the worst run); today both are
  runtime-wide constants (`DEFAULT_TOOL_TIMEOUT_MS` 120 s), so a manifest can't say what it needs.
- **An origin-aware condition.** Conditions see only path and query, so "off the login pages" is
  a path test, and an Auth0 page outside the known prefixes is told apart from www by Auth0's
  `main._widget` container. `{ urlOrigin: … }` would make both exact.

- **Serialise a site's write tools.** `add_to_cart` reads then writes an absolute quantity, so
  two parallel calls lose an addition. The runtime should queue `write` and `irreversible` tool
  runs per adapter (reads can stay parallel), and should not retry a write tool after its request
  may have reached the site.
- **Page-initiated requests and the request surface.** Core v2 has the driver hold every request
  in the tool partition, the site's own scripts' included, to the request surface and the ceiling.
  The live homepage makes its own API calls on load (`/api/ui/v2/bootstrap`, `/apis/ui/settings`,
  `/auth/heartbeat`, `acs.woolworths.com.au/rest/v1/delivery`, Akamai sensor POSTs to random
  paths). Declaring them would let tool code read bootstrap's shopper details, and the sensor
  paths can't be declared at all; refusing them may break the page and look odd to Akamai.
  Page-initiated calls probably need their own allowance (egress only, or a separate list that
  tool code can't use), and a ceiling that counts them separately from the tool's.
