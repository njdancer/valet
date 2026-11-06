# Fixtures

Scrubbed response bodies from woolworths.com.au, used to build the fake site's responses. The
source is spike 2's anonymous probe on 2026-11-06 (Electron 44, default user agent, no login):
`spikes/02-woolworths-shapes/results/shapes.json`, which is gitignored. See
[the findings](../../../docs/findings/2026-11-07-woolworths-live-probe.md).

## Files

| File                   | Source                                           | What was changed                                                                                                                 |
| ---------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `product-special.json` | `steps.search`, product 88436 (Dairy Farmers 2L) | `AdditionalAttributes.description` shortened, `.nutritionalinformation` nulled, `AdID` replaced with `display_fake`              |
| `product-regular.json` | `steps.search`, product 888137 (Woolworths 2L)   | Same trims as above                                                                                                              |
| `search-response.json` | `steps.search` (`POST /apis/ui/Search/products`) | `Products` cut to one group; each `Aggregations` entry cut to 2 `Results` and 2 `ResultsGrouped`; long `Statement` HTML replaced |
| `trolley-empty.json`   | `steps.trolley` (`GET /apis/ui/Trolley`)         | Unchanged: it was already small and anonymous                                                                                    |
| `product-detail.json`  | `steps.productDetail` (product 88436)            | Same product trims; `RichDescription` shortened; `DetailsImagePaths` cut to 2                                                    |
| `catalogue.json`       | Synthetic                                        | See below                                                                                                                        |

Every field name, nesting and value type is as captured. Nothing here came from a cookie, and no
cookie names or values appear in any file; `test/fixtures.test.ts` checks that.

## The catalogue

The probe saw only five products, all milk. `catalogue.json` keeps those five with their real
names and prices, and adds 25 invented rows (stockcodes `9001xx`–`9008xx`) covering milk, bread,
eggs, bananas, cheese, coffee and a few pantry items. Ten are on special and one (900303, Sunny
Queen eggs) is unavailable.

A row holds only what varies between products. `src/catalogue.ts` builds each product by cloning a
real product object (`product-special.json` when `wasPrice > price`, else `product-regular.json`)
and replacing the varying fields: stockcode, names, brand, variety, prices, cup price and
`CupString`, package size, specials flags and tags, availability flags, image URLs and a few
`AdditionalAttributes`. Everything else, such as `Rating`, `SupplyLimit` and the remaining
attributes, is the template's.

## Captured vs assumed

Captured from the live site:

- The search, trolley and product detail envelopes, and the product object.
- The anonymous empty trolley, including its "$50 minimum spend" error.
- The Akamai "Access Denied" page (first 300 characters, in `results/login.json`), reproduced in
  `src/akamai.ts`.
- **The login's shape** (seen in the built-in browser, run 3, nothing typed):
  `www/shop/securelogin` is a "not logged in" page with a link; the link,
  `/auth/login?redirect_uri=<www>/auth/callback&path=/`, redirects to Auth0 Universal Login on a
  separate origin, `auth.woolworths.com.au/u/login/identifier?state=…`.
- **The identifier page**: one form posting to the auth origin, with `input[name=username]`,
  `type="email"`, `autocomplete="email webauthn"`, a `button[type=submit]` labelled "Continue", and
  separate passkey (`data-testid=social-provider-button-passkey`) and Everyday
  (`social-provider-button-everyday`) options.
- Anonymous visitors get `wow-auth-token` cookies, so a token cookie is not a login probe.

Assumed, to be confirmed in a logged-in session:

- **Trolley item shape.** Only an empty trolley was captured. The fake lists each item as the
  product object plus `Quantity`, `QuantityInTrolley` and `IsInTrolley`.
- **`GET /api/ui/v2/bootstrap`** returning `{ ShopperDetails: { IsLoggedIn, FirstName } }`, 200
  with `IsLoggedIn: false` when anonymous. The site calls it on load but its body wasn't recorded.
- **The identifier page's details.** That the Continue button is `name="action" value="default"`
  (Auth0's standard markup; the probe recorded only `type=submit`), the field's `id="username"`,
  and the `state` hidden input.
- **The password page** (not viewed live, since that meant entering Nick's email): Auth0's
  standard `/u/login/password?state=…` with `input#password[name=password][type=password]`, a
  `name=action value=default` submit, and errors as
  `#error-element-password[data-error-code=…]` with `wrong-credentials` and `user-blocked`.
- **MFA**: Auth0's standard `/u/mfa-sms-challenge`, `/u/mfa-email-challenge` and
  `/u/mfa-otp-challenge` pages, `input#code[name=code]` with `autocomplete=one-time-code`, the
  `rememberBrowser` checkbox, `invalid-code` and `too-many-failures` errors. Whether Nick's account
  has MFA at all, and which factor, is decision D4. The SMS wording in `outbox` is invented.
- **The CAPTCHA**: Auth0's bot detection as `.ulp-captcha-container` on the identifier and password
  pages.
- **The hand-back**: `/authorize` on the auth origin, the callback's `code` and `state`, their
  lifetimes (10 minutes, 60 seconds), and Auth0's cookie names (`auth0`, `auth0-mf`). After the
  callback, www sets its session cookies and redirects to `path`, as the probe's findings describe.
- **Silent re-login**: while Auth0's own session lives, a new `/auth/login` returns straight to the
  callback with no page. Standard Auth0 behaviour; not seen live.
- **Error bodies.** Bad requests get `{ Message: "The request is invalid." }` (ASP.NET style), and
  an unknown stockcode gets 404 with every detail envelope field set to null.
- **Quantity limits.** A quantity above `SupplyLimit` (36) is reduced to it, as
  `SupplyLimitMessage` describes. Unknown stockcodes reject the whole update.
- **Path leniency.** The fake routes `/API/…`, `/%63heckout`, `//api/…`, `/a//b`, `/x/../a` and a
  trailing slash to the same place as the plain path, assuming IIS and ASP.NET routing do too. Only
  case-insensitivity has any evidence (the site itself calls `/apis/ui/Search/products` and
  `/apis/ui/Trolley` with capitals). The point is that the fake must not be stricter than the real
  site, or a deny-rule bypass would look safe here. An encoded slash is not decoded.
- **Order placement.** `POST /api/v3/ui/checkout/order` returns `{ OrderId }` and empties the
  trolley.

## Refreshing

Re-run the spike, then regenerate the five captured files with the same trims. Keep the catalogue
rows as they are, so tests that name stockcodes keep passing.
