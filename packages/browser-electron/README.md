# @valet/browser-electron

The Electron browser driver: `ElectronSessionDriver` implements `SessionDriver` from
`@valet/core`, and hands out the `AuthPage` and `ToolPage` the runtime drives. The security
rules it serves are in [docs/security-model.md](../../docs/security-model.md).

## Layout

- `src/*.ts` is plain TypeScript, unit-tested in Node. It is written against `BrowserPlatform`
  (`src/platform.ts`), a narrow interface over the slice of Electron the driver uses.
- `src/electron/platform.ts` implements `BrowserPlatform` over `BrowserWindow` and `session`. It
  is the only file here that imports `electron`, holds no decisions, and is covered by the e2e
  suite instead of unit tests. `pnpm check` does not run that suite, so **a change under
  `src/electron/` (or to anything the e2e suite exercises) needs `check:e2e` to pass too.**
- `src/index.ts` loads Electron lazily, in `createElectronSessionDriver()`, so the package can be
  imported from plain Node.
- `src/scripts.ts` holds every script the driver runs in a page. Each is a fixed function whose
  data goes in as a JSON literal argument; the only adapter-supplied source is `evaluateScript`,
  which only the tool page uses.

| Module                 | What it decides                                                   |
| ---------------------- | ----------------------------------------------------------------- |
| `guards.ts`            | Auth navigation, tool egress, a run's policy, report targets      |
| `egress-proxy.ts`      | The tool partition's CONNECT proxy, for sockets webRequest misses |
| `cookies.ts`           | Which cookies hand off, and how to recreate them exactly          |
| `page-core.ts`         | Tolerant loads, step timeouts, frame lookup, trusted click/typing |
| `auth-page.ts`         | `AuthPage`: navigation poisoning, origin-bound secret typing      |
| `session-fetch.ts`     | The auth probe: origins every hop, the page's headers, parsing    |
| `tool-page.ts`         | `ToolPage`: goto, click, fill, extract, evaluate, fetch           |
| `driver.ts`            | Partitions, runs, the request filter, the handoff, redaction data |
| `session-values.ts`    | Every value session cookies and storage keys held, for redaction  |
| `user-agent.ts`        | The clean Chrome UA, en-AU, and the client hints restated         |
| `needs-user.ts`        | The hand-off window's title for each `NeedsUserReason`            |
| `process-hardening.ts` | Chromium switches the desktop app appends before `ready`          |

## Running

```bash
mise exec -- pnpm check                                          # from the repo root
mise exec -- pnpm --filter @valet/browser-electron check:e2e   # typecheck:e2e + test:e2e
```

The e2e suite needs a GUI session, `openssl`, and Electron's binary in
`node_modules/electron/dist`. An offline install can leave that missing; fetch it once with
`mise exec -- pnpm --filter @valet/browser-electron exec node node_modules/electron/install.js`.

The e2e suite launches the real Electron through Playwright. `e2e/harness/` is the Electron main
process: it makes a self-signed certificate with `openssl`, serves a small HTTPS site on
`127.0.0.1`, maps every `*.test` host to it with `--host-resolver-rules`, and trusts only that
certificate's fingerprint. Nothing leaves the machine. `e2e/site-isolation-off.spec.ts`,
`e2e/hints.spec.ts` and `e2e/client-hints.spec.ts` relaunch the harness with a switch changed,
to measure a decision or an opt-in rather than to test the default.

## Behaviour worth knowing

- **Each run's policy holds the whole tool partition.** Tool code can reach the network without
  the capability API: `evaluate()` can call the page's own `fetch`, a click can submit a form, and
  `location.href` can navigate. So `beginRun(policy, onBlocked)` installs core's `ToolRunPolicy`
  in the partition's `webRequest` filter, and it applies to every request, whoever made it, until
  `endRun()`:
  - the host must be on the driver's egress list and the run's (a run can narrow it, never widen
    it);
  - an API call must pass core's `decideRequest` (declared method and path, deny segments,
    ambiguous paths), and its declaration's purpose must be at most `maxPurpose`
    (`purpose-exceeded` otherwise). An API call is any non-GET; a GET fetch/XHR, beacon, socket or
    unknown type; and **a GET of any type under an API root**. Page script picks the resource type
    (`new Image()`, `<script src>`, an iframe, `location=`), so the type can't be what lets a GET
    off. A declaration's API root is its path up to and including its first literal segment
    (`/apis/ui/Trolley` gives `/apis`, `/:locale/api/cart` gives `/:locale/api`), taken from every
    declaration in the manifest, whatever the run may use. A path is under a root when it is as
    written, or once each segment is percent-decoded (up to three times) with `;` parameters
    dropped, or once encoded slashes are split and dot segments resolved
    (`/static/..%2Fapis/x`). A declaration with no literal segment (`/*`, `/:id`) makes every
    path an API path: that fails closed, and such a manifest must declare its pages. A GET with
    a side effect on a path outside every root (a page at `/shop/cart/add?id=1`, say) is still
    reachable as a page or an asset: nothing in the manifest says it is an API, so only the asset
    budget limits it;
  - an `irreversible` declaration stays refused until `unlockIrreversible()`, which only works in
    a run whose `maxPurpose` is `irreversible`, and only until that run ends;
  - deny segments (checkout, payment, payee, …, also when encoded) are refused for navigations and
    assets too, unless an unlocked irreversible declaration covers them;
  - the ceiling counts navigations (`mainFrame`, `subFrame`) and API calls. Every other request
    that leaves (scripts, styles, images, fonts and media) counts toward a looser asset budget,
    `assetsPerRun`: by default 100 for each request the ceiling allows, and never fewer than 1000.
    Past either, requests are refused as `request-ceiling`. Both counts start again at
    `beginRun()` and `endRun()`.

  Between runs the policy is the manifest's egress, its `read` declarations only, and
  `requestsPerRun`, counted from the last `endRun()`; blocks then go to `DriverOptions.onBlocked`.
  **The site's own background calls are held to the surface too**, so a manifest must declare
  them (Woolworths makes several on load, including Akamai's sensor POSTs), or they are cancelled
  and reported with initiator `page`.
- **Who asked is a best guess.** `webRequest` can't tell a request from `evaluate()`d code or a
  clicked button from the site's own. A blocked request is reported with initiator `tool` only
  when it is exactly (method and URL) one that `page.fetch` or `page.goto` was making at the
  time; everything else, sockets included, is `page`.
- **Block reports are untrusted.** A `BlockedRequest` target is the origin and path on an egress
  host (so the person can see which of the site's calls to declare) and the origin alone
  anywhere else; never the query. Tool code chooses paths and hostnames, and can put a cookie in
  either, so reports must pass output redaction before they reach the audit log.
- **The tool partition goes through a local CONNECT proxy.** WebRTC's TCP sockets (TURN over TCP
  or TLS) and WebTransport's QUIC never pass through `webRequest`. In the e2e suite both reached an
  undeclared host with only the old measures in place. The partition now sends every connection,
  loopback included, through `egress-proxy.ts`, which allows only egress hosts (the run's too) on
  443 and never resolves a refused hostname; with WebRTC limited to proxied traffic and no
  UDP-capable proxy, neither gets out.
- **Adapter code runs in its own world.** `evaluate()` source runs in isolated world 1001; the
  runtime's own scripts (fetch, extract, storage handoff) in 1000, so adapter code can't patch
  the `fetch`, `JSON` or `Storage` they use.
- **A tool's `fetch` is held to the page's own policy too.** It runs in the tool page, so the
  site's Content-Security-Policy and CORS apply on top of ours. The fetch script watches for a
  `securitypolicyviolation` (`connect-src` or `default-src`, the request's origin) and answers
  `page-policy` for one, which `SurfaceToolPage` throws as `egress/page-policy` and reports as
  blocked, `initiator: tool`. Chromium fires the event just after the fetch rejects, so a failed
  fetch waits 50 ms for it. A CORS failure has no event and stays `tool-run/unavailable`.
- **Secrets are typed only into the element `focus()` targeted, in the frame `inspect()`
  reported, on the grant's origins.** `type(secret)` without `allowedOrigins` is refused
  (`secret-fill/origin-mismatch`). `focus(selector)` must land in the same frame, at the same
  origin, as the last `inspect(selector)`, so the frame the interpreter checked against the grant
  is the frame that gets the secret, and that frame must be https and on `allowedOrigins`. Before
  every keystroke the page checks that neither that frame nor any of its ancestors has committed
  a navigation (by frame tree node, so an analytics or CAPTCHA iframe elsewhere on the page that
  reloads mid-type doesn't stop it; a commit the browser can't place counts), that the browser
  process (`webContents.focusedFrame`) still has focus in that frame, that the frame is still on
  its origin and on `allowedOrigins`, and that the element itself still has focus. If any of that
  changes partway, typing stops with `secret-fill/origin-mismatch` (literal text: `aborted`). A
  main-frame commit forgets every inspection and the focus target.
- **A secret never exists as one string.** It is typed through `SecretValue.revealEach`, one code
  point per callback, and each keystroke is a step of its own (with the step timeout), since the
  length is never known up front.
- **Typing sends char events alone by default.** `keyEvents: 'full'` sends keyDown, char and
  keyUp per character instead, as a keyboard does (characters outside printable ASCII still go
  as a char event alone). Which one sites prefer is Nick's call; the default stays char-only
  until then.
- **A primitive that timed out does nothing more.** Every primitive checks its step's abort
  signal before each script and before it clicks or focuses, and `focus()` leaves no target once
  its step has been given up on.
- **Cross-origin iframes: inspect works, input doesn't.** With site isolation, which Electron
  enables by default, a cross-origin iframe runs in its own renderer process, and
  `sendInputEvent` never reaches it: the click lands on the `<iframe>` element in the parent and
  keystrokes go nowhere. `inspect()` says so with `inputReachable: false`, and the driver refuses
  `click` and `focus` on such an element (`element-unsuitable`) instead of typing blind. Switching
  site isolation off makes it work (see `e2e/site-isolation-off.spec.ts`); CDP `Input.dispatch*`
  would be the other route. Neither is done here: it's a decision for the app.
- **Leaving the navigation origins poisons an auth page.** A prevented main-frame navigation, a
  prevented redirect, or an off-list commit all make every later primitive fail with
  `navigate/navigation-escaped`. **Subframes** may load only the navigation origins and the
  manifest's `auth.frameOrigins`; anything else is refused, both by the frame navigation guard and
  by the auth partition's `webRequest` filter (which sees an iframe's first load too), without
  poisoning the page. The auth partition's other requests are not filtered: the site's own
  scripts are out of scope there.
- **The auth partition's refusals are reported, as the page's.** Each refused main-frame
  navigation (an escape, which also poisons the page, including an off-list commit that slipped
  past the guard), and each refused subframe, goes to a reporter as a core `BlockedRequest` with
  initiator `page`, method `GET` (the guard can't see a form's method), the origin alone as the
  target, and `host-not-allowed` (or `bad-url` for a URL with no network origin). A page's own
  refusals go to `openAuthPage({ onBlocked })`'s reporter, or to `DriverOptions.onAuthBlocked`
  when it was opened without one. The request filter can't tell which page asked, so its
  refusals go to the newest open auth page that has a reporter, and otherwise to
  `onAuthBlocked`. A storage-handoff helper page never takes them: its own refusals are routed
  the same way. Never the tool partition's reporters. Each distinct refusal is reported once per
  reporter (a main-frame navigation reaches the guard twice, `will-frame-navigate` and
  `will-navigate`, and pages retry), up to 200 subframe refusals and, counted apart so that no
  number of refused widgets can keep an escape out of the audit, 50 escapes. Past a budget the
  refusal still holds; the first one dropped calls `onReportsDropped` (or
  `DriverOptions.onAuthReportsDropped` for `onAuthBlocked`'s budget) once, and
  `driver.droppedAuthReports()` counts them all. Like the tool partition's, these reports must
  pass output redaction before the audit log. **Gap:** core's `SessionDriver.openAuthPage()`
  takes no reporter and `BlockedRequest` carries no partition, so a runtime written against the
  core contract gets none of these unless it passes `onAuthBlocked`, and can't tell them from
  the tool partition's page-initiated blocks once it does (a core change; the runtime's wiring
  isn't done).
- **The session probe is a GET from the main process, not from the page.** `AuthPage.fetch(url)`
  goes through Electron's `net.request` on the auth partition's session, with its cookies
  (`credentials: 'include'`, so what the answer sets is kept in the auth partition too, a
  redirect's included) and `cache: 'no-store'` (a cached answer from before a login or logout
  would make the probe lie). No script runs, so the site can't see or shape it. It may go only to
  the manifest's navigation origins, over https, with no credentials in the URL
  (`probe/host-not-allowed`, or `probe/invalid` for `user:pass@`), and the fragment is dropped.
  Redirects are taken one hop at a time: each comes back unfollowed, is put to the main frame's
  navigation rule before anything is sent there, so one that leaves the navigation origins (or
  drops to http) is refused (`probe/host-not-allowed`), and more than 5 hops is
  `probe/unavailable`. It runs under the step timeout (`timeout/timed-out`, and the request is
  aborted), is cancelled when its page closes or the driver does (`probe/aborted`, never an
  answer for a page that is gone), reads at most 1 MiB (`probe/unexpected-shape` past that), and
  answers per core's `FetchResult`: the body parsed as JSON when the content type is JSON
  (`application/json`, `+json`, `text/json`) and it parses, otherwise the text, or `null` when
  empty. Error statuses and block pages come back as answers, for the interpreter to classify. A
  poisoned page refuses it like every other primitive. `AuthPage.cookieNames(domains)` returns the
  auth partition's cookie names on those domains (the handoff's matching), never values.
- **The probe presents as the page's own `fetch(url, { credentials: 'include' })`.** Electron's
  `net` has no `mode`, but `setHeader` sends names, case, order and values as given, and the
  network stack adds the Referer, `Accept-Encoding` and the cookies after them, as Chrome does. So
  each hop restates, in Chrome's order: `sec-ch-ua-platform`, `User-Agent`, `sec-ch-ua`,
  `Accept-Language`, `sec-ch-ua-mobile` (the page's override: clean UA, en-AU, the same brands),
  `Accept: */*`, `Origin` once the request has gone cross-origin (`null` after a tainting
  redirect, per the fetch spec), `Sec-Fetch-Site`, `Sec-Fetch-Mode: cors`, `Sec-Fetch-Dest:
  empty`, and the Referer strict-origin-when-cross-origin gives from the auth page's URL: the URL
  itself to its own origin, its origin elsewhere. The request is made on behalf of the page's
  origin (`net`'s `origin`), and Chromium overwrites `Sec-Fetch-Site` from that with its own
  reckoning, public suffix list and all; before any page is on the navigation origins, it goes as
  if from the target's own origin, with no Referer. The e2e suite diffs it on the wire against the
  page's own `fetch()` to the same route in the same partition, same-origin and after a redirect:
  identical but for the cookies. **Gaps:** cross-site (navigation origins on different sites), the
  page's `fetch()` also sends `Sec-Fetch-Storage-Access: active`, which Chromium strips from a
  main-process request, so a site can tell the two apart there (the e2e diff records it; it is
  a cross-site header, so same-site origins such as Woolworths' shouldn't carry it, though only
  the cross-site case is measured). After a redirect chain that left the
  page's site and came back, Chrome says `cross-site` for the whole chain, and the probe's
  per-hop request says what that hop is. High-entropy client hints a site asks for with
  `Accept-CH` reach the page's requests but not the probe's. With `userAgent: 'electron'` the UA
  and hints are left to the network stack, and the probe doesn't match the page's order.
  Whether the auth partition's `webRequest` filter sees the probe doesn't matter: the filter only
  judges subframes, and the probe holds itself to the navigation origins every hop, in the main
  process.
- **The clean Chrome UA and en-AU are the default, on both partitions.** Each partition gets
  `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)
  Chrome/<real major>.0.0.0 Safari/537.36` and the languages `en-AU,en` (sent as
  `en-AU,en;q=0.9`). The session setting doesn't reach `navigator.language`, which follows the
  Mac's language list, and `--lang` doesn't change that on macOS. So each page also gets a
  DevTools `Emulation.setUserAgentOverride` before its first load (after `about:blank`, since a
  never-loaded page has no renderer to answer). **That override reaches only the page's own
  target.** A dedicated worker kept the Mac's languages, and a cross-site (out-of-process) iframe,
  a service worker and a shared worker showed Electron's own UA (`… Electron/44.10.2 …`) and
  languages, which is exactly where bot managers compare. So each page also auto-attaches its
  children (`Target.setAutoAttach`, flattened, paused on start): an out-of-process frame gets the
  same `Emulation` override and a worker `Network.setUserAgentOverride` (which sets a worker's
  navigator too) before it is resumed, and each attaches its own children the same way. A paused
  service worker answers nothing and is stopped once its start times out, so it is resumed first
  and overridden as soon as it runs; shared workers aren't a page's children, so they are found by
  target discovery in the same partition and attached once running. Neither UA reaches those two
  in time by DevTools, so the driver also sets the clean UA as the process default
  (`app.userAgentFallback`), which is process-wide. **Residual gap:** a service worker's or
  shared worker's top-level script, run as it starts, still sees the Mac's languages (and the
  engine's own brands) until the override lands a moment later; anything it reads afterwards is
  overridden. The e2e suite checks the main frame, a dedicated worker, a service worker, a shared
  worker, a cross-site iframe and a worker inside it, in both partitions, and the request headers
  they send. That override has to restate the client hints, or
  `navigator.userAgentData` comes back empty; by default it restates exactly what the engine
  reports, which the e2e suite checks against a window with no override. `clientHints: 'chrome'`
  also names Google Chrome (D24a, open). **Electron sends no `Sec-CH-UA` header at all**, with or
  without the override, unlike Chrome; the brands only reach scripts. `userAgent: 'electron'`
  leaves Electron's own UA, languages and hints alone.
- **Redaction data is a history, not a snapshot.** Tool code can read a session value
  (`document.cookie`, `localStorage`) and then overwrite or expire it before the runtime asks, and
  the site can rotate one mid-run. So `sessionSecrets()` returns, besides the tool partition's
  cookie values on the domains now: every value the handoff copied; every value seen in the tool
  partition's cookie `changed` events (a removal or overwrite carries the old value); every value
  written to a handed-off (or previously asked-for) storage key in a tool page, from DevTools
  `DOMStorage` events, which each tool page enables before its first load; those keys' values read
  at `beginRun()` and `endRun()`; and their current values in an open tool page on the origin,
  once pending storage events have arrived. Each cookie and key keeps its 16 most recent values
  (and at most 2000 cookie names), so the history is bounded. It opens no page to look.
  `cookieNames()` returns names only.
- **Storage handoff needs a document on the origin.** Keys are read in an auth-partition page and
  written in a tool-partition page on that origin. An open page is reused; otherwise a short-lived
  hidden page loads `/robots.txt` (configurable) on that origin and is destroyed afterwards.
- **`handToUser(reason)` titles the window in the app's words.** The reason is a core
  `NeedsUserReason`; the title names the manifest's site and says what to do (`needs-user.ts`).
  Nothing an adapter wrote reaches it. It intercepts one close: closing the shown window hides it
  and resolves; after that, closing it (or quitting the app) closes it.
- **Resource hints.** `hardenProcess()` turns off Blink's DNS prefetching, and the tool partition
  sends `X-DNS-Prefetch-Control: off` on every response. In the e2e suite Electron 44 opened no
  connection for `dns-prefetch` or `preconnect` hints even without either, so the suite can't yet
  show that the hardening is what stops them.
