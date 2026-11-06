# @siteadapter/browser-electron

The Electron browser driver: `ElectronSessionDriver` implements `SessionDriver` from
`@siteadapter/core`, and hands out the `AuthPage` and `ToolPage` the runtime drives. The security
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
| `tool-page.ts`         | `ToolPage`: goto, click, fill, extract, evaluate, fetch           |
| `driver.ts`            | Partitions, runs, the request filter, the handoff, redaction data |
| `user-agent.ts`        | The clean Chrome UA, en-AU, and the client hints restated         |
| `needs-user.ts`        | The hand-off window's title for each `NeedsUserReason`            |
| `process-hardening.ts` | Chromium switches the desktop app appends before `ready`          |

## Running

```bash
mise exec -- pnpm check                                          # from the repo root
mise exec -- pnpm --filter @siteadapter/browser-electron check:e2e   # typecheck:e2e + test:e2e
```

The e2e suite needs a GUI session, `openssl`, and Electron's binary in
`node_modules/electron/dist`. An offline install can leave that missing; fetch it once with
`mise exec -- pnpm --filter @siteadapter/browser-electron exec node node_modules/electron/install.js`.

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
    path an API path: that fails closed, and such a manifest must declare its pages;
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
- **The clean Chrome UA and en-AU are the default, on both partitions.** Each partition gets
  `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)
  Chrome/<real major>.0.0.0 Safari/537.36` and the languages `en-AU,en` (sent as
  `en-AU,en;q=0.9`). The session setting doesn't reach `navigator.language`, which follows the
  Mac's language list, and `--lang` doesn't change that on macOS. So each page also gets a
  DevTools `Emulation.setUserAgentOverride` before its first load (after `about:blank`, since a
  never-loaded page has no renderer to answer). That override has to restate the client hints, or
  `navigator.userAgentData` comes back empty; by default it restates exactly what the engine
  reports, which the e2e suite checks against a window with no override. `clientHints: 'chrome'`
  also names Google Chrome (D24a, open). **Electron sends no `Sec-CH-UA` header at all**, with or
  without the override, unlike Chrome; the brands only reach scripts. `userAgent: 'electron'`
  leaves Electron's own UA, languages and hints alone.
- **Redaction data.** `sessionSecrets()` returns the tool partition's cookie values on the
  domains, the storage values this driver handed off, and those keys' current values in an open
  tool page on the origin. It opens no page to look. `cookieNames()` returns names only.
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
