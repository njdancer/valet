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
`{ method, host, path, query, headers, body, at }`.

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

Paths are case-insensitive. The remember-device cookie (`wow-remembered-device`, 90 days) skips
2FA for that account only.

## Controls

- `setRateLimit(limit | null)`: more than `maxRequests` API calls in `windowMs` from one `_abck`
  blocks that session, pages included, for `cooldownMs`. Changing the limit lifts current blocks.
- `blockAll(on)`: every request gets the Access Denied page, as if the IP were blocked.
- `expireSessions()`: logs everyone out; remembered devices survive.
- `now`: an injected clock for the rate limit and request timestamps.
- `hostile.loginFormAction`: the login form posts there instead, for the form-action guard.
- `hostile.openRedirectAfterLogin`: a correct password redirects to the `returnUrl` query
  parameter unchecked, for the navigation guard.

The exfil sink answers every request with 200 and permissive CORS, preflights included, so a leak
shows up as a success rather than an error. It also records WebSocket upgrade attempts.

`generateTestCertificate(hosts, { spawn?, tempRoot?, days? })` runs `openssl req` without a shell
in a temp directory it then deletes. It returns `{ key, cert, fingerprint, chromiumFingerprint }`.
Hosts are validated strictly, because they go into an openssl argument.
