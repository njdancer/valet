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
| `guards.ts`            | Auth navigation, tool egress, the request surface, report targets |
| `egress-proxy.ts`      | The tool partition's CONNECT proxy, for sockets webRequest misses |
| `cookies.ts`           | Which cookies hand off, and how to recreate them exactly          |
| `page-core.ts`         | Tolerant loads, step timeouts, frame lookup, trusted click/typing |
| `auth-page.ts`         | `AuthPage`: navigation poisoning, focus-bound secret typing       |
| `tool-page.ts`         | `ToolPage`: goto, click, fill, extract, evaluate, fetch           |
| `driver.ts`            | Partitions, hardening, the request filter, runs, the handoff      |
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
certificate's fingerprint. Nothing leaves the machine. `e2e/site-isolation-off.spec.ts` and
`e2e/hints.spec.ts` relaunch the harness with a process-wide switch changed, to measure a
decision rather than to test the default.

## Behaviour worth knowing

- **The tool partition enforces the request surface itself.** Tool code can reach the network
  without the capability API: `evaluate()` can call the page's own `fetch`, a click can submit a
  form, and `location.href` can navigate. So the partition's `webRequest` filter applies, to every
  request: the egress hosts; the deny segments (checkout, payment, payee, …, also when encoded)
  to every kind of request, navigations and form POSTs included; declared `{ method, path }` and
  purpose to every API call (any non-GET, and fetch/XHR, beacons, sockets and unknown types); and
  the per-run ceiling to those API calls. `beginRun(sideEffect)` and `endRun()` mark a run; between
  runs the allowance is a read tool's. **The site's own background calls are held to the surface
  too**, so a manifest must declare them (Woolworths makes several on load, including Akamai's
  sensor POSTs), or they are cancelled.
- **The tool partition goes through a local CONNECT proxy.** WebRTC's TCP sockets (TURN over TCP
  or TLS) and WebTransport's QUIC never pass through `webRequest`. In the e2e suite both reached an
  undeclared host with only the old measures in place. The partition now sends every connection,
  loopback included, through `egress-proxy.ts`, which allows only egress hosts on 443 and never
  resolves a refused hostname; with WebRTC limited to proxied traffic and no UDP-capable proxy,
  neither gets out.
- **Block reports are untrusted.** A `BlockedRequest` carries the origin and a digest of the
  path, never the path or query, which tool code can fill with a cookie. The hostname can still
  carry one, so reports must pass output redaction before they reach the audit log.
- **Adapter code runs in its own world.** `evaluate()` source runs in isolated world 1001; the
  runtime's own scripts (fetch, extract, storage handoff) in 1000, so adapter code can't patch
  the `fetch`, `JSON` or `Storage` they use.
- **Secrets are typed only into the element `focus()` targeted, in the frame `inspect()`
  reported.** `focus(selector)` must land in the same frame, at the same origin, as the last
  `inspect(selector)`, so the frame the interpreter checked against the grant is the frame that
  gets the secret. A secret needs that `inspect()`, and its frame must be https (and on
  `allowedOrigins`, when passed to `type`). Before typing, the page checks that the element still
  has focus in that frame and that the browser process (`webContents.focusedFrame`) agrees; before
  every character, that focus hasn't left the frame and no frame has committed a navigation. A
  main-frame commit forgets every inspection and the focus target.
- **A primitive that timed out does nothing more.** Every primitive checks its step's abort
  signal before each script and before it clicks or focuses, and `focus()` leaves no target once
  its step has been given up on.
- **A secret is decoded once per fill**, inside its reveal callback, which the typing runs within.
  JavaScript strings can't be zeroed, so that one decoded copy lives until it is collected.
- **Cross-origin iframes: inspect works, input doesn't.** With site isolation, which Electron
  enables by default, a cross-origin iframe runs in its own renderer process, and
  `sendInputEvent` never reaches it: the click lands on the `<iframe>` element in the parent and
  keystrokes go nowhere. The driver therefore refuses `click` and `focus` on an element in an
  out-of-process frame (`element-unsuitable`) instead of typing blind. Switching site isolation
  off makes it work (see `e2e/site-isolation-off.spec.ts`); CDP `Input.dispatch*` would be the
  other route. Neither is done here: it's a decision for the app.
- **Leaving the navigation origins poisons an auth page.** A prevented main-frame navigation, a
  prevented redirect, or an off-list commit all make every later primitive fail with
  `navigate/navigation-escaped`. By default subframes may load any https origin, because login
  pages embed CAPTCHA and bot-check frames, and the secret-fill binding above is the control;
  `frameOrigins` pins them to a list instead. **This departs from docs/security-model.md, which
  says every committed navigation must be on the allowlist; which way to go is open.**
- **Storage handoff needs a document on the origin.** Keys are read in an auth-partition page and
  written in a tool-partition page on that origin. An open page is reused; otherwise a short-lived
  hidden page loads `/robots.txt` (configurable) on that origin and is destroyed afterwards.
- **`handToUser` intercepts one close.** Closing the shown window hides it and resolves; after
  that, closing it (or quitting the app) closes it.
- **Resource hints.** `hardenProcess()` turns off Blink's DNS prefetching, and the tool partition
  sends `X-DNS-Prefetch-Control: off` on every response. In the e2e suite Electron 44 opened no
  connection for `dns-prefetch` or `preconnect` hints even without either, so the suite can't yet
  show that the hardening is what stops them.
