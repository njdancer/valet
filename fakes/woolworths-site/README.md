# Fake Woolworths

A local stand-in for woolworths.com.au, shared by the adapter, runtime and browser driver tests
and by end-to-end tests. Real `node:http` or `node:https` on 127.0.0.1, so a real browser can
drive it. It never contacts the real site. Where its responses come from, and what is assumed
rather than captured, is in [fixtures/README.md](fixtures/README.md).

It is two servers, because the real site is two origins: **www** (the shop, its API, and the Akamai
simulation) and **auth** (Auth0 Universal Login, where the password is typed). The live probe found
the login on `https://auth.woolworths.com.au`
([findings](../../docs/findings/2026-11-07-woolworths-live-probe.md), run 3).

## Use

```ts
import {
  generateTestCertificate,
  startExfilSink,
  startFakeWoolworths,
} from '@siteadapter/fake-woolworths-site'

const tls = await generateTestCertificate(['www.woolworths.test', 'auth.woolworths.test', 'evil.test'])
const site = await startFakeWoolworths({
  tls,
  // The caller maps both names to 127.0.0.1, e.g. with a host resolver rule.
  hostname: 'www.woolworths.test', // authHostname defaults to auth.woolworths.test
  accounts: [{ username: 'canary@example.test', password: 'canary-pw', otpCode: '135790', mfa: 'sms' }],
  rateLimit: { maxRequests: 20, windowMs: 60_000, cooldownMs: 60_000 },
})
site.origin // https://www.woolworths.test:<port>
site.authOrigin // https://auth.woolworths.test:<authPort>
const sink = await startExfilSink({ tls, hostname: 'evil.test' })
// ... run the flow under test ...
expect(sink.requests).toEqual([])
expect(site.trolleyFor('canary@example.test')).toEqual([{ stockcode: 88436, quantity: 2 }])
await site.close() // both servers
await sink.close()
```

`site.requests` (www), `site.authRequests` (auth) and `sink.requests` record every request,
blocked ones included, as `{ method, host, target, path, query, headers, rawHeaders, body, at }`.
`target` is the request target exactly as sent and `rawHeaders` every header line as received.
`path`, `query` and `headers` are convenience views that lose data (a repeated query key keeps its
last value; Node keeps only the first of a duplicated `authorization`, `referer`, `user-agent` and
others). To assert a secret never arrived, search the whole record, e.g.
`expect(JSON.stringify(sink.requests)).not.toContain(canary)`, not just `path` or `query`.

`site.outbox` lists the MFA codes the fake "sent" by SMS or email,
`{ channel, username, text, at }`, so a test's stand-in for the Messages reader can find them.

Without `hostname`, both servers report `127.0.0.1` on their own ports. A browser shares cookies
across ports on one host, so use hostnames when cookie separation between the origins matters.

Run it by hand with `mise exec -- pnpm --filter @siteadapter/fake-woolworths-site start` (plain
HTTP on port 8417, auth on 8418; `-- --port 0` for any free ports). It prints both origins and two
test accounts.

## The login

| Origin | Request                                       | Behaviour                                                                                                                                                                     |
| ------ | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| www    | `GET /shop/securelogin`                       | "Oops! You're not logged in" and a link to `/auth/login`, no form (as live)                                                                                                   |
| www    | `GET /auth/login?redirect_uri=…&path=…`       | Starts a login with a fresh `state` tied to this browser's `wow-auth-token`; 302 to auth `/authorize`                                                                         |
| auth   | `GET /authorize`                              | Refuses a `redirect_uri` other than www's callback. With a live Auth0 session: straight to the callback (silent re-login). Otherwise a new transaction, 302 to the identifier |
| auth   | `GET/POST /u/login/identifier?state=T`        | `input#username[name=username][type=email]`, primary `button[name=action][value=default]`, plus passkey and Everyday buttons in other forms. Any username moves on            |
| auth   | `GET/POST /u/login/password?state=T`          | `input#password[name=password][type=password]`. Wrong: 400 with `#error-element-password[data-error-code=wrong-credentials]`; blocked account: `user-blocked`                 |
| auth   | `GET/POST /u/mfa-{sms,email,otp}-challenge?…` | For accounts with `otpCode`, by `mfa` channel: `input#code` (one-time-code), `input[name=rememberBrowser]` checkbox. Three wrong codes end the transaction                    |
| www    | `GET /auth/callback?code=…&state=…`           | Logs in only if the state is pending for this browser and the code was issued for it; both single use; then 302 to the login's `path` (on www only)                           |
| www    | `GET /auth/logout`                            | New anonymous session, 302 to `/`                                                                                                                                             |

- **Codes and states.** The callback's `state` lives 10 minutes and the code 60 seconds
  (`PENDING_LOGIN_TTL_MS`, `CODE_TTL_MS`, on the injected clock). Any attempt spends both, right
  or wrong, so a code delivered to another browser is refused and then dead for everyone.
- **Auth0's cookies** are on the auth origin only: `auth0` (the session) and `auth0-mf`
  ("remember this device", 30 days, skips MFA for that account only). www's cookies are on www
  only. Copying the www cookie domains to a tool partition therefore never copies Auth0's session.
- An SMS or email challenge appends `Your Woolworths verification code is <code>…` to `outbox`
  when the password is accepted, and again on "Resend code". An `otp` (authenticator app)
  challenge sends nothing.
- The password page does not echo the username back, unlike real Auth0, so a canary username
  never appears in a response.

## The shop

| Request                                   | Behaviour                                                                                            |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Any www page                              | An inline "sensor" script sets a script-readable `_abck` cookie if there is none                     |
| Any `/api/…` or `/apis/…`                 | Without an `_abck` the site issued: 403 with Akamai's "Access Denied" page                           |
| `GET /shop/search/products?searchTerm=`   | HTML results, `.product-tile[data-stockcode]`                                                        |
| `GET /api/ui/v2/bootstrap`                | `{ ShopperDetails: { IsLoggedIn, FirstName } }`; 200 with `IsLoggedIn: false` when anonymous         |
| `GET` or `POST /apis/ui/Search/products`  | Search over a 30-product catalogue, in the real response shape                                       |
| `GET /apis/ui/product/detail/<stockcode>` | Detail envelope, or 404 with every field null                                                        |
| `GET /apis/ui/Trolley`                    | The visitor's trolley (the account's when logged in)                                                 |
| `POST /api/v3/ui/trolley/update`          | Sets quantities (0 removes, capped at 36); rejects the whole update if any item is invalid           |
| `POST /api/v3/ui/checkout/order`          | 200 `{ OrderId }` and empties the trolley. It exists so tests can prove the runtime never reaches it |

Every www visitor gets an httpOnly `wow-auth-token` whether logged in or not, as on the live site,
so a token cookie is not a login probe. The token is replaced on every login state change.

Routing on www is deliberately lenient, as the real ASP.NET/IIS backend probably is: paths are
case-insensitive, percent-encoded unreserved characters are decoded (`/%63heckout`), repeated
slashes collapse (`//api/…` is an API path, bot check included), dot segments resolve, and one
trailing slash is ignored. An encoded slash (`%2F`) is not a separator. So a runtime deny rule
that one of these spellings slips past shows up here as a placed order. The auth origin routes
exactly, as Auth0 does.

## Controls

- `setRateLimit(limit | null)`: more than `maxRequests` API calls in `windowMs` from one `_abck`
  or one `wow-auth-token` blocks that client, pages included, for `cooldownMs`. Both cookies are
  blocked together, and a cookie presented alongside a blocked one is blocked with it, so deleting
  the script-readable `_abck` and loading a page for a new one doesn't get out (the httpOnly token
  is still sent). Dropping both cookies does, as a brand-new client; the fake has no per-IP key
  apart from `blockAll`. Changing the limit lifts current blocks. www only.
- `blockAll(on)`: every www request gets the Access Denied page, as if the IP were blocked. The
  auth origin is not behind Akamai.
- `expireSessions()`: logs every www visitor out. Auth0 sessions survive, so the next login is a
  silent re-login. A cart call (`GET /apis/ui/Trolley`, `POST /api/v3/ui/trolley/update`) that
  still carries an expired logged-in token gets a 401 with no cookies, as the live site is assumed
  to answer an expired login, rather than a new anonymous trolley; every other path, bootstrap
  included, starts a new anonymous visitor for it as before.
- `expireAuthSessions()`: ends every Auth0 session, so the next login asks for the identifier and
  password. Remembered devices survive.
- `captcha` / `setCaptcha(on)`: Auth0's bot detection shows `.ulp-captcha-container` on the
  identifier and password pages and refuses every submit with `invalid-captcha`. The container
  holds `iframe.ulp-captcha-frame` from `captchaFrameOrigin` (`captchaFrameHostname`, default
  `challenges.captcha.test`, on the auth port; `/captcha/frame`), because real challenges
  (Turnstile, reCAPTCHA, hCaptcha, Arkose) render in a third-party frame. The caller maps the
  hostname to 127.0.0.1.
- Cookies for the whole domain: when `hostname` starts with `www.`, a new www visitor also gets
  Akamai's `bm_sz` and `/authorize` sets an analytics `_ga`, both with `Domain=` the rest of the
  hostname (`woolworths.test`), so a browser sends them to both origins. Every other cookie is
  host-only.
- `now`: an injected clock for the rate limit, login expiry and request timestamps.
- `hostile.loginFormAction`: the password form posts there instead, for the form-action guard.
  The identifier form is untouched.
- `hostile.openRedirectAfterLogin`: `/authorize` accepts any http(s) `redirect_uri` and sends the
  code there, and www's callback redirects to the login's `path` unchecked (e.g.
  `/auth/login?path=https://evil.test/landed`), for the navigation guard.
- `hostile.redirectAfterLogin: { from, to }`: once the login is done, the site sends the browser
  to `to` on its own, whatever the request asked for: from Auth0 in place of www's callback,
  carrying the code (`from: 'auth'`, the silent re-login included), or from www's callback once it
  has set the session (`from: 'callback'`), for the navigation guard.
- `hostile.wwwRedirect: { path, to }`: www answers every request for `path` (any method and case,
  after Akamai) with a 302 to `to`, for the tool partition's redirect guard.
- `hostile.loginInFrame`: a hostname. The identifier and password pages hold only
  `iframe#loginFrame`, whose `src` is the same page plus `/frame` on that hostname and the auth
  port, so the form is in a cross-origin frame, for the frame-origin guard. The auth server
  answers for the frame; the caller maps the hostname to 127.0.0.1.
- `hostile.passwordInputType` and `hostile.codeInputType`: the `type` of `#password` and `#code`
  (normally `password` and `text`), for the element-type guard.

The exfil sink answers every request with 200 and permissive CORS, preflights included, so a leak
shows up as a success rather than an error. It also records WebSocket upgrade attempts.

`generateTestCertificate(hosts, { spawn?, tempRoot?, days? })` runs `openssl req` without a shell
in a temp directory it then deletes. It returns `{ key, cert, fingerprint, chromiumFingerprint }`.
Hosts are validated strictly, because they go into an openssl argument.
