# Fake Woolworths

A local stand-in for woolworths.com.au, shared by the adapter, runtime and browser driver tests
and by end-to-end tests. Real `node:http` or `node:https` on 127.0.0.1, so a real browser can
drive it. It never contacts the real site. Where its responses come from, and what is assumed
rather than captured, is in [fixtures/README.md](fixtures/README.md).

## Use

```ts
import {
  generateTestCertificate,
  startExfilSink,
  startFakeWoolworths,
} from '@siteadapter/fake-woolworths-site'

const tls = await generateTestCertificate(['www.woolworths.test', 'evil.test'])
const site = await startFakeWoolworths({
  tls,
  hostname: 'www.woolworths.test', // the caller maps it to 127.0.0.1, e.g. with a host resolver rule
  accounts: [{ username: 'canary@example.test', password: 'canary-pw', otpCode: '135790' }],
  rateLimit: { maxRequests: 20, windowMs: 60_000, cooldownMs: 60_000 },
})
const sink = await startExfilSink({ tls, hostname: 'evil.test' })
// ... run the flow under test ...
expect(sink.requests).toEqual([])
expect(site.trolleyFor('canary@example.test')).toEqual([{ stockcode: 88436, quantity: 2 }])
await site.close()
await sink.close()
```

`site.requests` and `sink.requests` record every request, blocked ones included, as
`{ method, host, target, path, query, headers, rawHeaders, body, at }`. `target` is the request
target exactly as sent and `rawHeaders` every header line as received. `path`, `query` and
`headers` are convenience views that lose data (a repeated query key keeps its last value; Node
keeps only the first of a duplicated `authorization`, `referer`, `user-agent` and others). To
assert a secret never arrived, search the whole record, e.g.
`expect(JSON.stringify(sink.requests)).not.toContain(canary)`, not just `path` or `query`.

Run it by hand with `mise exec -- pnpm --filter @siteadapter/fake-woolworths-site start` (plain
HTTP on port 8417; `-- --port 0` for any free port). It prints the origin and two test accounts.

## What it does

| Request                                   | Behaviour                                                                                                                           |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Any page                                  | An inline "sensor" script sets a script-readable `_abck` cookie if there is none                                                    |
| Any `/api/…` or `/apis/…`                 | Without an `_abck` the site issued: 403 with Akamai's "Access Denied" page                                                          |
| `GET /shop/securelogin`                   | `#loginForm` posting to `/auth/login`: `#loginForm-Email`, `#loginForm-Password`, `#loginForm-Submit`                               |
| `POST /auth/login`                        | Wrong: page again with `.login-error`. Right: new httpOnly `wow-auth-token`, 302 to `/shop/myaccount`, or to `/auth/verify` for 2FA |
| `GET/POST /auth/verify`                   | `#verify-Code` (one-time-code) and `#verify-RememberDevice`; three wrong codes abandon the login                                    |
| `GET /auth/logout`                        | New anonymous session, 302 to `/`                                                                                                   |
| `GET /shop/search/products?searchTerm=`   | HTML results, `.product-tile[data-stockcode]`                                                                                       |
| `GET /api/ui/v2/bootstrap`                | `{ ShopperDetails: { IsLoggedIn, FirstName } }`                                                                                     |
| `GET` or `POST /apis/ui/Search/products`  | Search over a 30-product catalogue, in the real response shape                                                                      |
| `GET /apis/ui/product/detail/<stockcode>` | Detail envelope, or 404 with every field null                                                                                       |
| `GET /apis/ui/Trolley`                    | The visitor's trolley (the account's when logged in)                                                                                |
| `POST /api/v3/ui/trolley/update`          | Sets quantities (0 removes, capped at 36); rejects the whole update if any item is invalid                                          |
| `POST /api/v3/ui/checkout/order`          | 200 `{ OrderId }` and empties the trolley. It exists so tests can prove the runtime never reaches it                                |

Every visitor gets an httpOnly `wow-auth-token` whether logged in or not, as on the live site, so
a token cookie is not a login probe. The token is replaced on every login state change.

Routing is deliberately lenient, as the real ASP.NET/IIS backend probably is: paths are
case-insensitive, percent-encoded unreserved characters are decoded (`/%63heckout`), repeated
slashes collapse (`//api/…` is an API path, bot check included), dot segments resolve, and one
trailing slash is ignored. An encoded slash (`%2F`) is not a separator. So a runtime deny rule
that one of these spellings slips past shows up here as a placed order. The remember-device cookie (`wow-remembered-device`, 90 days) skips
2FA for that account only.

## Controls

- `setRateLimit(limit | null)`: more than `maxRequests` API calls in `windowMs` from one `_abck`
  or one `wow-auth-token` blocks that client, pages included, for `cooldownMs`. Both cookies are
  blocked together, and a cookie presented alongside a blocked one is blocked with it, so deleting
  the script-readable `_abck` and loading a page for a new one doesn't get out (the httpOnly token
  is still sent). Dropping both cookies does, as a brand-new client; the fake has no per-IP key
  apart from `blockAll`. Changing the limit lifts current blocks.
- `blockAll(on)`: every request gets the Access Denied page, as if the IP were blocked.
- `expireSessions()`: logs everyone out; remembered devices survive.
- `now`: an injected clock for the rate limit and request timestamps.
- `hostile.loginFormAction`: the login form posts there instead, for the form-action guard.
- `hostile.openRedirectAfterLogin`: a correct password (or, for 2FA accounts, a correct code;
  `returnUrl` is carried through `/auth/verify`) redirects to the `returnUrl` query parameter
  unchecked, for the navigation guard.
- `hostile.loginInFrame`: a hostname. `/shop/securelogin` holds only `iframe#loginFrame`, whose
  `src` is `/shop/securelogin/frame` on that hostname and the site's port, so the form is in a
  cross-origin frame, for the frame-origin guard. The same server answers for the frame; the
  caller maps the hostname to 127.0.0.1.
- `hostile.passwordInputType` and `hostile.codeInputType`: the `type` of `#loginForm-Password`
  and `#verify-Code` (normally `password` and `text`), for the element-type guard.

The exfil sink answers every request with 200 and permissive CORS, preflights included, so a leak
shows up as a success rather than an error. It also records WebSocket upgrade attempts.

`generateTestCertificate(hosts, { spawn?, tempRoot?, days? })` runs `openssl req` without a shell
in a temp directory it then deletes. It returns `{ key, cert, fingerprint, chromiumFingerprint }`.
Hosts are validated strictly, because they go into an openssl argument.
