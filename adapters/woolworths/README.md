# Woolworths adapter

Searches woolworths.com.au and manages the online cart. It never checks out: no declared request
touches a checkout or payment path, and no tool is `irreversible`.

```ts
import adapter, { createAdapter } from '@siteadapter/adapter-woolworths'

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
  (`tool-run` / `unexpected-shape`).
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

| Situation                                   | Thrown                                                                                                                  |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `ensure()` says `needsUser`                 | `NeedsUserError(reason)`, the reason if it is in core's vocabulary, else `other`                                        |
| `ensure()` failed                           | `SiteAdapterError` with its own stage and class, if both are in the core vocabularies, else `auth-step` / `auth-failed` |
| HTTP 401 on a cart call                     | one more `ensure()` and a retry from the start of the tool; a second 401 is `tool-run` / `not-logged-in`                |
| HTTP 401 on a product call                  | `tool-run` / `not-logged-in`                                                                                            |
| HTTP 403 (Akamai)                           | `tool-run` / `blocked-by-site`                                                                                          |
| HTTP 429                                    | `tool-run` / `rate-limited`                                                                                             |
| 2xx that is HTML (block page or login page) | `tool-run` / `blocked-by-site`                                                                                          |
| 2xx that is neither JSON nor HTML           | `tool-run` / `unavailable`                                                                                              |
| HTTP 404, or detail with no `Product`       | `tool-run` / `not-found`                                                                                                |
| Other non-2xx, or `fetch` threw             | `tool-run` / `unavailable`                                                                                              |
| JSON not in the expected shape              | `tool-run` / `unexpected-shape`                                                                                         |
| Signal aborted before a call                | `tool-run` / `aborted`                                                                                                  |
| `add_to_cart` would exceed 50               | `tool-input` / `invalid`                                                                                                |
| `add_to_cart` read an incomplete trolley    | `tool-run` / `unexpected-shape`                                                                                         |
| Update reply says the site refused          | `tool-run` / `invalid`                                                                                                  |

Cart tools throw rather than returning a "please log in" result so the runtime records a failed
call. `NeedsUserError` ends the run as `needsUser` with a reason code (`captcha`, `otp-required`,
`account-locked`, `login-required`, `other`), and the app shows the person the login window. The
auth steps' notes, which say what happened in words, are shown only in the app; nothing but the
code reaches the MCP client.

Every cart tool calls `ensure()` before its first site call, because the anonymous trolley also
answers 200: without it, a logged-out `add_to_cart` would fill a trolley nobody sees. If the
session expires between the probe and the call, the site answers 401; the tool then runs
`ensure()` once more and starts again from the top. Retrying is safe because the refused request
changed nothing, and `add_to_cart` re-reads the trolley before writing, so it never adds twice.

An HTML 2xx can be Akamai's challenge or the login page served to an expired session; nothing in
the response tells them apart. It is reported as `blocked-by-site`, as the runtime's own block
detection does, so the runtime backs off; its next `ensure()` probe then finds an expired session.

A `SiteAdapterError` thrown by the runtime's own guards (for example the request ceiling) passes
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
- `egress` and `session.cookieDomains` stay on www. Auth0's own cookies (its session, "remember
  this device") are host-only on the auth origin, so the hand-off never copies them, and the
  tool partition never talks to the auth origin.
- The probe stays `GET /api/ui/v2/bootstrap` → `ShopperDetails.IsLoggedIn === true`, with 401 as
  the logged-out status. Anonymous visitors get `wow-auth-token` cookies, so a cookie probe would
  lie; an anonymous bootstrap answers 200 with `IsLoggedIn: false`.

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

- the auth flow's `flowTimeoutMs` is at least 40 s plus the time an SMS takes to arrive (about
  60 s is enough: **90 s** is the setting this adapter expects), and
- the runtime's tool timeout is longer than `flowTimeoutMs` plus the tool's own calls, which are
  paced at 2.5 s (`limits.minGapMs`) and come to at most eight in the 401-retry path below: the
  default 120 s (`DEFAULT_TOOL_TIMEOUT_MS`) is just enough for a 90 s flow.

Otherwise a slow but legitimate login ends as `timeout` / `timed-out` instead of the `needsUser`
the security model wants. Core has no way to declare these per adapter (core change requests).

The request surface lists exactly the calls the tools make, and a test fails if a declaration goes
unused. The login probe is not on it: the runtime makes the probe itself, outside the tool-code
surface guard, so tool code can't read the shopper details that endpoint probably returns once
logged in.

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

## Tests

`test/fake-context.ts` is a `ToolContext` whose `page.fetch` serves fixtures and, like the runtime,
refuses any request `decideRequest` would refuse for the manifest. `request-surface.test.ts` runs
every tool against both the real and the fake manifest and checks each call's purpose against the
tool's side effect. `auth-steps.test.ts` walks the auth steps against scripted Auth0 pages, every
combination included, and checks that the flow never runs off the end and types each secret at
most once.

`e2e.test.ts` runs the adapter against `@siteadapter/fake-woolworths-site` over real HTTPS
(a test certificate from `openssl`; skipped without it), through `test/e2e/`: a stand-in for the
runtime and the Electron driver, with a cookie jar per partition, a minimal DOM, the secret-fill
guards, `ensure()` with the probe and hand-off, and each tool run held to the request surface,
side effect and ceiling. It interprets only the steps this manifest uses, and resolves only the
test hostnames, to 127.0.0.1. It proves the login through both origins (SMS and authenticator
MFA, remember-device, silent re-login), each `needsUser` exit, the hostile form-action and
field-type variants, every cart tool on the handed-off session, and that checkout is refused
however it is spelled.

Fixtures in `test/fixtures` were trimmed from the captured responses in
`spikes/02-woolworths-shapes/results/shapes.json` (gitignored): `Aggregations` cut to one entry and
each product's `AdditionalAttributes` cut to a few keys. No cookies. `search-milk.json`,
`product-detail-88436.json` and `trolley-empty.json` are real responses; `trolley-two-items.json`
is synthesised as described above. Edge cases are made in each test by copying a fixture and
changing one field.

## Core change requests

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
