# Architecture

Draft, updated after round 1. The security rules this has to satisfy are in
[security-model.md](security-model.md); this doc says which package does what and how they fit.
Much of it comes from an earlier private app, which already drives a bank's site
from Electron. Where we copy it or deliberately depart from it, this doc says so.

## Shape

- **The app is an Electron menu-bar app.** No dock icon (`LSUIElement`), a `Tray`, and
  `window-all-closed` doesn't quit. The tray menu is rebuilt on each click with
  `popUpContextMenu`. This is from the earlier app: `setContextMenu` shows a stale menu on macOS.
  (Planned: `apps/desktop` has dependencies but no source yet.)
- **Only the browser driver's Electron layer and the desktop app import `electron`.** Everything
  else is plain TypeScript, tested in plain Node with fakes. A test in `browser-electron` scans
  every source file in the repo and fails on any other importer.
- **Packages export TypeScript source** and depend on `@valet/core` for every contract they
  share. No package imports another's implementation; the app wires them together. In particular
  the runtime doesn't import `auth-flow` (the login comes in as an injected `AuthRunner`), and the
  MCP server doesn't import the runtime (it calls a `ToolCaller` interface).

## Packages

- **`packages/core`**: contracts only. The manifest schema and auth step vocabulary, the request
  surface (`decideRequest`, deny segments, ambiguous paths), origin and host matching,
  `SecretValue`, the page and session-driver interfaces, credential, grant and OTP contracts,
  audit events, the error and `needsUser` vocabularies, the regex screen, content hashing.
- **`packages/runtime`**: `ToolHost`. It registers adapters, lists approved tools, and runs a call:
  approval, input parse, lock, breaker, confirmation, the guarded tool page, `session.ensure()`,
  output parse and redaction, audit. Also the approval store, the hash-chained audit log, the
  login attempt marker, and the per-site rate budget and circuit breaker.
- **`packages/auth-flow`**: `runAuthFlow(input)`, the declarative interpreter and the privileged
  secret filler. It never throws; it returns `ok`, `needsUser`, `failed` or `blocked`. The only
  package that reveals site secrets.
- **`packages/credentials`**: the credential providers (1Password service account over the SDK,
  the `op` CLI, a fake), the `CredentialResolver` that dispatches a grant to its provider, the
  file grant store, the Keychain token source, and the Messages OTP reader with its sender parser
  and pattern worker.
- **`packages/browser-electron`**: `ElectronSessionDriver`, which implements `SessionDriver`,
  `AuthPage` and `ToolPage` over Electron, with the tool partition's request filter and CONNECT
  egress proxy, cookie and storage handoff, and the process-wide Chromium switches.
- **`packages/mcp-server`**: the Streamable HTTP endpoint on `127.0.0.1` with its bearer token,
  tool naming and annotations, result shaping, and the stdio bridge for clients that only launch a
  command.
- **`adapters/woolworths`**: the first adapter. A manifest, auth steps, and six tools
  (`search_products`, `get_product`, `get_cart`, `add_to_cart`, `set_cart_quantity`,
  `remove_from_cart`). `createAdapter({ origin })` points the same code at the fake site.
- **`fakes/woolworths-site`**: a local stand-in for woolworths.com.au on real `node:http(s)`. It
  records every request, has an Akamai-like rate limiter and a hostile variant for each guard,
  and comes with an exfil sink and a test certificate generator.
- **`apps/desktop`**: the menu-bar app, its wiring, windows and packaging. Not written yet.
- **`spikes/*`**: throwaway experiments run by hand: spike 1 (manual login and handoff, not yet
  run) and the live probe (`02-woolworths-shapes`).

Core changed in v2 after the round-1 reviews (`needsUser` codes, `urlContains`/`urlRegex`,
`messages` grants, origin-bound typing, `beginRun(policy)`, run-scoped secret clones and more;
see security-model.md). The packages are adopting it in round 2, so on `main` some of them still
use the round-1 names.

## How a tool call flows

1. An MCP client calls `woolworths_get_cart` over HTTP, or through the stdio bridge.
2. `mcp-server` checks `Host`, `Origin` and the bearer token, maps the name back to
   `{ adapterId, tool }`, and calls the `ToolCaller` with the client's name and a fresh call id.
3. `runtime`'s `ToolHost.call()` audits `tool-called`, checks the exact bundle hash is approved,
   parses the input, takes the adapter's lock, and checks the site's circuit breaker. For an
   `irreversible` tool it asks the person in the app before any tool code runs.
4. Tool code runs with a guarded `ToolContext`. Every `page.fetch` and `goto` is checked against
   the request surface and waits for the site's rate budget; the driver holds every request in the
   tool partition to the same request policy at the network layer. The rate budget and breaker
   see only `page.fetch`, `goto` and the probe: requests the page or `evaluate()` code makes, and
   the login, are not paced or watched for block pages yet
   ([D55](plan.md#d55-driver-level-budget-and-block-detection)).
5. `ctx.session.ensure()` runs the probe in the tool partition. If it says logged out, the runtime
   writes the attempt marker and calls the injected `AuthRunner`, which the app implements with
   `runAuthFlow` against `driver.openAuthPage()`, the grant store, the credential resolver and the
   OTP reader. After `ok`, the runtime has the driver hand the session off and probes again.
6. Output is parsed with the tool's schema, converted to plain JSON, redacted, and returned.
   `tool-finished` is audited with the outcome.

No test runs this whole path yet: each package is tested against `core` and fakes on its own.
Wiring it, first in plain Node and then in the app, is the next job
([plan M1](plan.md#m1-vertical-slice-against-fakes)).

## Desktop app process layout (planned)

- **The main process owns everything with authority:** the `ToolHost`, one
  `ElectronSessionDriver` per adapter, the credential providers and the Keychain token source,
  the grant and approval stores, the audit log, the MCP endpoint, and the tray. It calls
  `hardenProcess(app)` before `ready`.
- **Renderer windows are views.** The control panel, onboarding, adapter approval, grant picker,
  confirmation dialog, audit viewer and the hand-off banner run with `contextIsolation`,
  `sandbox: true`, no Node integration and a strict CSP. Each sees only the `window.valet`
  API that a preload script exposes, typed in `apps/desktop/src/shared/api.ts` (being written in
  round 2). The renderer never receives a `SecretValue`, a credential item's contents, the
  endpoint token or a session cookie; it receives display data and sends intents ("approve
  adapter X at hash H", "grant secret S from item I"), and the main process validates every one
  as if it came from an untrusted page. Renderers show site-derived text (product names, adapter
  descriptions), so they are less trusted than the main process.
- **Site windows are separate.** Auth and tool pages are hidden `BrowserWindow`s owned by the
  driver. A hand-off shows the auth window itself, with the app's banner in a separate renderer.
- **Tool code** runs in the main process in v0 (see the caveat in security-model.md), moves to a
  `utilityProcess` with the capability API over a message port, and then into the sandbox chosen
  in [D12](plan.md#d12-sandbox-technology) before third-party adapters.
- **Data files** live under `~/Library/Application Support/valet/` (the final name waits on
  [D1](plan.md#d1-product-name)): `approvals.json`, `grants.json`, `audit.jsonl`,
  `login-markers/`, the endpoint token and `bridge.json`, all owner-only
  ([D45](plan.md#d45-grant-file-location)).

## Browser driver

`packages/browser-electron`. Its decisions are in plain TypeScript written against
`BrowserPlatform`, a narrow interface over the slice of Electron it uses; `src/electron/platform.ts`
implements that interface, holds no decisions, and is covered by the Electron e2e suite.

From the earlier app's experience against its bank:

- **Hidden but headed.** A `BrowserWindow({ show: false })`, never headless, with
  `backgroundThrottling: false`. Headless got fingerprinted; a hidden window didn't. For
  `needsUser`, the same window is shown.
- **One persistent partition per adapter and role:** `persist:auth:<adapter id>` and
  `persist:tool:<adapter id>`.
- **Tolerant navigation.** An `ERR_ABORTED` from `loadURL` (the page navigating itself again)
  waits for `did-stop-loading` instead of failing.
- **Timeouts and waits.** Every primitive runs under a step timeout and checks its abort signal
  before each script, click or focus, so a primitive that timed out does nothing more. Waits run
  in Node, never in the page, because navigation kills in-page timers.
- **`close` uses `destroy()`**, so a page's `beforeunload` can't keep the window alive.

What the driver adds beyond the earlier app:

- **Scripts are fixed functions.** Every script the driver runs is a function in `src/scripts.ts`
  whose data goes in as a JSON literal. The only adapter-supplied source is `evaluate()`, in
  isolated world 1001; the driver's own scripts use world 1000.
- **Typing is bound to the focused frame.** `focus(selector)` must land in the frame the last
  `inspect(selector)` reported; typing checks focus in the renderer and in the browser process,
  and stops on any commit or focus change between characters. Elements in out-of-process
  (cross-site) frames are refused, because `sendInputEvent` can't reach them
  ([D37](plan.md#d37-cross-origin-iframe-logins)).
- **The tool partition's request filter** applies egress, deny segments, declarations and
  purpose to every request, whoever made it. Not yet as core v2 specifies: an ambiguous path only
  stops a declaration matching, the ceiling counts API calls but not navigations, and blocks
  aren't audited (security-model.md, "The run's network policy").
- **The tool partition's CONNECT proxy** (`egress-proxy.ts`) carries every connection, so
  sockets `webRequest` never sees (WebRTC over TCP, WebTransport) can only reach egress hosts on
  443. WebRTC is limited to proxied traffic.
- **Cookie handoff** recreates each cookie exactly (domain or host-only, path, `Secure`,
  `HttpOnly`, `SameSite`, expiry) for `cookieDomains` only. **Storage handoff** reads named keys
  in an auth-partition page and writes them in a tool-partition page on the same origin, reusing
  an open page or loading `/robots.txt` in a short-lived hidden one
  ([D40](plan.md#d40-storage-handoff-document)).
- **`hardenProcess()`** appends the Chromium switches that have no per-session API (DNS
  prefetching off) before `ready`.

### User agent

The earlier app never overrode Electron's UA, and the bank didn't object. Woolworths sits behind
Akamai Bot Manager. Run 4 of the live probe showed Electron's default UA (which carries the app
name and `Electron/44.10.2`) blocked from Nick's IP while a clean Chrome UA loaded normally
([finding](findings/2026-11-07-woolworths-live-probe.md)).

**Decided:** every partition gets a clean Chrome UA,
`Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/<major>.0.0.0 Safari/537.36`,
with `<major>` read from the bundled Chromium (`process.versions.chrome`), and
`Accept-Language: en-AU`, set before the first request. That is what Nick's own Chrome sends, and
it is the limit: the driver matches the person's own browser and never goes further
([D24](plan.md#d24-bot-detection-posture)). Client-hint brands stay `Chromium`
([D24a](plan.md#d24a-client-hint-brands)).

**On `main`:** `cleanChromeUserAgent()` exists, but `DriverOptions.userAgent` defaults to
Electron's own UA and nothing sets `Accept-Language`. Making the clean UA and `en-AU` the default
is round-2 work in `browser-electron`.

## Woolworths

### Login: Auth0 on a separate origin

From the live probe (nothing typed):

- `www.woolworths.com.au/auth/login?…` redirects to Auth0 Universal Login on
  `https://auth.woolworths.com.au/u/login/identifier`.
- The flow is identifier-first: an email page (`input[name=username][type=email]`, "Continue"),
  then a password page (assumed to be Auth0's standard `/u/login/password` with
  `input#password`), then possibly an Auth0 MFA page (`/u/mfa-*-challenge`, assumed). Both forms
  post to the auth origin. The first page also offers passkey and "Everyday" buttons, which the
  auth flow must never click.
- Auth0 redirects back to `www…/auth/callback`, which sets the www session cookies.

So the manifest's `navigation` is `https://www.woolworths.com.au` and
`https://auth.woolworths.com.au`; the `login` secret's origins are the auth origin only; and
`cookieDomains` names www and the bare domain. Cookies are matched exactly against their domain,
so a host-only Auth0 cookie stays in the auth partition; one set on `.woolworths.com.au` would
not, which M2 checks. The auth steps go to `www…/auth/login` first: if Auth0 still has a session
it redirects straight back, the probe passes, and no secret is resolved at all. Only when the
identifier page appears does the flow fill.

**On `main`:** the round-1 adapter and fake site still model a same-origin login on www
(`/shop/securelogin`, `#loginForm-*`), with the fake's selectors. Moving both to the Auth0 shape
(two origins, identifier-first, silent redirect, the decoy buttons) is round-2 work. The real
password page, MFA factor and probe are confirmed live in [M2](plan.md#m2-electron-driver-and-live-woolworths).

### Site API calls

Tools call the site's own JSON endpoints with an in-page `fetch` (same-origin credentials) from
the tool partition. Cookies never leave the browser, and Akamai's cookies stay with the client
that earned them. This is how the earlier app searches the bank's transactions.

| Purpose                           | Request                                   | Status                                     |
| --------------------------------- | ----------------------------------------- | ------------------------------------------ |
| Search                            | `POST /apis/ui/Search/products`           | Verified anonymously                       |
| Product detail                    | `GET /apis/ui/product/detail/<stockcode>` | Verified anonymously                       |
| Read cart                         | `GET /apis/ui/Trolley`                    | Verified anonymously (empty trolley)       |
| Add, set or remove (quantity `0`) | `POST /api/v3/ui/trolley/update`          | Assumed from community code                |
| Login probe                       | `GET /api/ui/v2/bootstrap`                | Endpoint verified; logged-in field assumed |

Egress for the tool partition is www, `cdn0.woolworths.media` and `acs.woolworths.com.au`; not
the auth host. Whether the site works with its ~40 analytics hosts blocked is untested
([D10](plan.md#d10-analytics-hosts)).

## Request surface

From the earlier app's connector guard, generalised. A manifest declares:

- **egress**: the hosts the tool partition may contact;
- **requests**: `{ method, path pattern, purpose: read | write | irreversible }`. Path patterns
  are literal segments, `:name` for one segment, and a trailing `*`;
- **limits**: `requestsPerRun` (the per-run ceiling), `minGapMs`, `cooldownSeconds` and
  `maxCooldownSeconds`.

Runtime-wide deny segments cover checkout, payment and payee paths; unlocking one takes an
`irreversible` declaration plus the person's confirmation for that run. How each of these is
enforced, and how far, is in security-model.md.

## Credentials

The adapter only ever names a `secretRef`. The privileged filler in `auth-flow` resolves it
through the grant. This is where we depart from the earlier app, whose connector code holds the
plaintext password.

Providers in `packages/credentials`, preferred first:

1. **A 1Password service account scoped to a dedicated vault** (`OnePasswordSdkProvider`, kind
   `onepassword-service-account`). It works unattended, which matters when an agent calls a tool
   while the Mac is locked; it's scoped to one vault and revocable; 1Password keeps its own usage
   log. The token comes from a `TokenSource`: in v0, `KeychainTokenSource` runs
   `/usr/bin/security` with a bounded wait, which has the ACL gap described in the security model.
   Service accounts can't read personal vaults, so login items are moved into that vault
   ([D6](plan.md#d6-1password-setup)).
2. **`op read` through the 1Password desktop app's CLI integration** (`OnePasswordCliProvider`,
   kind `onepassword-cli`). No setup, but it needs 1Password unlocked plus Touch ID; when that
   isn't available the provider reports `locked` and the login ends in `needsUser`. The SDK's
   `DesktopAuth` may replace it ([D7](plan.md#d7-1password-fallback)).
3. **Not:** copying secrets into the Keychain ahead of time, as the earlier app does. That's a second
   copy with its own lifecycle.

Also here:

- **`CredentialResolver`** dispatches a grant to the provider its `provider` field names, and
  turns anything a provider throws into `ValetError('credential', …)`.
- **`FileGrantStore`**: grants keyed by adapter id, exact hash and secret name.
- **`MessagesOtpReader`**: SMS codes from `chat.db`, opened read-only in place per lookup, from
  one exact sender handle, matched by a screened pattern in a worker under a deadline. Granted as
  provider `messages` with the sender as `itemRef` (core v2).
- **`FakeProvider`** for tests.

Every external process (`op`, `security`) runs with a minimal environment and an injected
spawner, so tests never touch 1Password or the Keychain. The Keychain is read asynchronously,
with a bound on approval prompts: a hung Keychain approval once froze the earlier app's main process
for hours.

## Run hygiene

From the earlier app, all in `runtime` and `auth-flow`:

- **Pessimistic login classification:** a block page is `blocked`, only a probe that passes is
  `ok`, and everything else is `needsUser` or a failure. A login that ends `auth-failed`, or after
  which the probe still says logged out, holds further attempts until the person clears it.
- **A durable attempt marker** for sites that lock out. It's written and fsynced before the auth
  action runs, and cleared only once the outcome is classified, so a crash mid-login stops further
  attempts until the person clears it. Other failures back off from 5 minutes to 6 hours.
- **Errors carry a stage plus an allowlisted error class, never free text.** Page text can hold
  secrets or personal data.
- **One FIFO lock per adapter**, so two tool calls never drive the same session at once. The lock
  stays held until the work a call started has settled (up to 30 s), so a timed-out call can't
  keep driving the session under the next one.
- **Deadlines everywhere:** input and output parsing (10 s), the tool run (2 min), the
  confirmation (5 min), and the auth flow's own timeout.
- **Per-site protection:** a rate budget and circuit breaker per host, shared by every adapter
  for that host, applying the strictest limits of the approved adapters that declare it
  ([D33](plan.md#d33-breaker-defaults-and-persistence), recommended). Today they cover only
  `page.fetch`, `goto` and the probe ([D55](plan.md#d55-driver-level-budget-and-block-detection)).

## MCP endpoint

`packages/mcp-server`:

- **Local:** Streamable HTTP on `127.0.0.1` with a bearer token, on a free port each launch, plus
  the stdio bridge, which re-reads its 0600 config file if the app restarts under a running
  client. Whether to keep a stable port is [D41](plan.md#d41-stable-mcp-port-and-token-rotation).
- **Tools** are named `<adapter id>_<tool>` (hyphens become underscores), with input and output
  JSON Schemas from the zod schemas and annotations derived from the side effect:
  `readOnlyHint` for `read`; `destructiveHint` and `idempotentHint: false` for `write` and
  `irreversible`; `openWorldHint` always.
- **Remote access (later):** a separate listener with OAuth and consent on the Mac, behind a
  tunnel or a relay; see [relay.md](relay.md) (a draft on the unmerged branch `wip/docs-platform`)
  and the security model. Until then, nothing remote.

## Packaging and updates

- **Build:** electron-vite and electron-builder, hardened runtime, Developer ID signing, and a
  designated requirement pinned to the Team ID.
- **Updates:** notarise, and auto-update with `electron-updater` ([D23](plan.md#d23-update-feed-host)).
  Squirrel.Mac requires a signed app.
- **Helpers:** the stdio bridge (and the Messages helper, if [D8](plan.md#d8-full-disk-access-for-messages)
  chooses one) ship as signed helpers inside the bundle. Until then the bridge runs from the repo
  with `tsx`.
- The earlier app never built its updater, so there's nothing to reuse. None of this exists yet.

## Testing

As built in round 1 (about 1,800 unit tests, about 99% line coverage):

- Vitest in plain Node, with no native addons, an injected clock and `sleep`, injected spawners
  and file systems.
- Scriptable fake pages: `auth-flow`'s `FakeAuthPage` (states keyed by URL, frames, forms,
  redirects, block pages, a record of everything typed and whether it was a `SecretValue`), and
  the adapter's fake `ToolContext`.
- `fakes/woolworths-site`: real HTTP(S) servers on port 0 that record every request, with an
  Akamai-like limiter and hostile variants (a form posting elsewhere, an open redirect, a login in
  a cross-origin frame, wrong input types), plus an exfil sink that answers everything with 200.
- **Canary tests** in `auth-flow` and `credentials`: unique secrets seeded and searched for in
  every outcome, audit event, error, log and stdio stream, with an assertion that they were
  actually typed.
- **Electron e2e** in `browser-electron` (`check:e2e`): Playwright drives the real Electron
  against a local HTTPS site with a per-run certificate and `*.test` hosts mapped to 127.0.0.1.
  It covers the request surface, WebRTC and WebTransport egress, adapter worlds, focus-bound
  typing, and measures the two process-wide switches (site isolation, resource hints). It needs a
  GUI session and isn't part of `pnpm check`.

Still to build: the canary egress and hostile-adapter suites run through the whole path (runtime,
auth flow, real driver, fake site), not package by package.

## Spikes

1. **Electron vs Woolworths** (`spikes/01-woolworths-electron`, not run). Nick logs in by hand in
   a hidden-but-headed window in the auth partition; the spike copies the cookies to the tool
   partition and calls `GET /apis/ui/Trolley` from there. It answers whether the clean Chrome UA
   holds while logged in, whether `_abck` survives the copy, and whether an isolated-world
   `fetch` carries same-origin credentials. Its UA comparison is settled by run 4, so it uses the
   clean UA only.
2. **Isolation of secret fills** was never run as a spike. The canary and hostile-variant tests
   above are the same test made permanent, and the whole-path suites finish it. The live probe in
   `spikes/02-woolworths-shapes` is not this spike, despite the directory number.
