# Woolworths adapter

Searches woolworths.com.au and manages the online cart. It never checks out: no declared request
touches a checkout or payment path, and no tool is `irreversible`.

```ts
import adapter, { createAdapter } from '@siteadapter/adapter-woolworths'

adapter // the real site
createAdapter({ origin: 'https://www.woolworths.test' }) // the fake site, for tests and e2e
```

`createManifest({ origin })` does the same for the manifest alone. With a fake origin, egress is
that host only, so an e2e run can't reach the live site even by mistake.

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
notices }`. Each item is `{ stockcode, name, quantity, price, lineTotal, available }`. `itemCount`
  is distinct products; `totalQuantity` is units. `notices` are the site's own cart messages, such
  as a minimum spend.
- **`add_to_cart { stockcode, quantity = 1 }`** reads the current quantity and sets
  current + quantity, because the update endpoint sets absolute quantities. It refuses to go over
  50 on one line, and makes no write if the call is cancelled after the read.
- **`set_cart_quantity { stockcode, quantity 0..50 }`** and **`remove_from_cart { stockcode }`**
  make one write each.

The write tools return the cart the update sent back as `cart`, or `cart: null` when the response
isn't trolley-shaped. They don't spend another request fetching it; call `get_cart` instead.

### Failures

Tools throw `SiteAdapterError`, never a raw error or a result that describes the failure:

| Situation                             | Stage / class                                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `ensure()` says `needsUser`           | `tool-run` / `not-logged-in`                                                                     |
| `ensure()` failed                     | its own stage and class, if both are in the core vocabularies, else `tool-run` / `not-logged-in` |
| HTTP 401                              | `tool-run` / `not-logged-in`                                                                     |
| HTTP 403 or 429 (Akamai)              | `tool-run` / `blocked-by-site`                                                                   |
| HTTP 404, or detail with no `Product` | `tool-run` / `not-found`                                                                         |
| Other non-2xx, or `fetch` threw       | `tool-run` / `unavailable`                                                                       |
| Response not in the expected shape    | `tool-run` / `invalid`                                                                           |
| Signal aborted before a call          | `tool-run` / `aborted`                                                                           |
| `add_to_cart` would exceed 50         | `tool-input` / `invalid`                                                                         |

Cart tools throw rather than returning a "please log in" result so the runtime records a failed
call and can re-run the auth action or show the login window. The `needsUser` reason is free text
and is never passed on. A `SiteAdapterError` thrown by the runtime's own guards (for example the
request ceiling) passes through unchanged.

## Verified live and assumed

From the anonymous probe of 2026-11-07
([findings](../../docs/findings/2026-11-07-woolworths-live-probe.md)):

| Item                                                                                                                  | Status                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Search POST body keys `SearchTerm`, `PageSize`, `PageNumber`, `SortType`, and the response shape                      | Verified                                                                                                                                                                                   |
| Product detail path and response shape                                                                                | Verified                                                                                                                                                                                   |
| Empty trolley response shape (`AvailableItems`, `Totals`, `Errors`, …)                                                | Verified                                                                                                                                                                                   |
| Egress hosts: www, `cdn0.woolworths.media`, `acs.woolworths.com.au`                                                   | Verified as needed; whether the site works with analytics hosts blocked is untested                                                                                                        |
| Search `IsSpecial` flag                                                                                               | **Assumed.** The tool also filters to specials locally, so results are right either way, but `total` is then the site's count                                                              |
| Trolley item shape: product tiles with `QuantityInTrolley`                                                            | **Assumed.** The anonymous trolley was empty, so `trolley-two-items.json` is synthesised from real search tiles                                                                            |
| Update body `{ items: [{ stockcode, quantity }] }`, absolute quantities, quantity 0 removes                           | **Assumed** from community code. Real clients may send more fields (`source`, `diagnostics`, …)                                                                                            |
| Update response is the updated trolley                                                                                | **Assumed.** Handled either way (`cart: null`)                                                                                                                                             |
| Login selectors `#loginForm-Email`, `#loginForm-Password`, `#loginForm-Submit`, `input[autocomplete="one-time-code"]` | **Assumed.** These are the fake site's. The real login page was behind Akamai's block during the probe; the real selectors must be recorded live, in a logged-in session with Nick present |
| OTP step: a code input appears after submit, filled from the `login` item, and the page moves on by itself            | **Assumed.** Woolworths may send codes by SMS or email instead, which would need a `messages` OTP source, and may need a separate submit click                                             |
| Login stays on www (no redirect to a separate identity host)                                                          | **Assumed.** A redirect elsewhere would abort the auth action until `navigation` lists it                                                                                                  |
| Login probe `GET /api/ui/v2/bootstrap` → `ShopperDetails.IsLoggedIn === true`                                         | **Assumed.** The endpoint exists and returned 200 anonymously; the field path is unconfirmed. A token cookie is not a usable probe: anonymous visitors get `wow-auth-token` too            |

The live site flagged four scripted calls in ten seconds (run 2 of the probe). Each tool makes at
most two calls and the manifest caps a run at six, but pacing, caching and a backoff circuit
breaker belong in the runtime.

## Tests

`test/fake-context.ts` is a `ToolContext` whose `page.fetch` serves fixtures and, like the runtime,
refuses any request `decideRequest` would refuse for the manifest. `request-surface.test.ts` runs
every tool against both the real and the fake manifest and checks each call's purpose against the
tool's side effect.

Fixtures in `test/fixtures` were trimmed from the captured responses in
`spikes/02-woolworths-shapes/results/shapes.json` (gitignored): `Aggregations` cut to one entry and
each product's `AdditionalAttributes` cut to a few keys. No cookies. `search-milk.json`,
`product-detail-88436.json` and `trolley-empty.json` are real responses; `trolley-two-items.json`
is synthesised as described above. Edge cases are made in each test by copying a fixture and
changing one field.
