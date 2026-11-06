# @siteadapter/browser-electron

The Electron browser driver: `ElectronSessionDriver` implements `SessionDriver` from
`@siteadapter/core`, and hands out the `AuthPage` and `ToolPage` the runtime drives. The security
rules it serves are in [docs/security-model.md](../../docs/security-model.md).

## Layout

- `src/*.ts` is plain TypeScript, unit-tested in Node. It is written against `BrowserPlatform`
  (`src/platform.ts`), a narrow interface over the slice of Electron the driver uses.
- `src/electron/platform.ts` implements `BrowserPlatform` over `BrowserWindow` and `session`. It
  is the only file here that imports `electron`, holds no decisions, and is covered by the e2e
  suite instead of unit tests.
- `src/index.ts` loads Electron lazily, in `createElectronSessionDriver()`, so the package can be
  imported from plain Node.
- `src/scripts.ts` holds every script the driver runs in a page. Each is a fixed function whose
  data goes in as a JSON literal argument; the only adapter-supplied source is `evaluateScript`,
  which only the tool page uses.

| Module                 | What it decides                                                   |
| ---------------------- | ----------------------------------------------------------------- |
| `guards.ts`            | Auth-partition navigation, tool-partition egress, report targets  |
| `cookies.ts`           | Which cookies hand off, and how to recreate them exactly          |
| `page-core.ts`         | Tolerant loads, step timeouts, frame lookup, trusted click/typing |
| `auth-page.ts`         | `AuthPage`: navigation poisoning, focus-bound secret typing       |
| `tool-page.ts`         | `ToolPage`: goto, click, fill, extract, evaluate, fetch           |
| `driver.ts`            | Partitions, hardening, the egress filter, the one-way handoff     |
| `process-hardening.ts` | Chromium switches the desktop app appends before `ready`          |

## Running

```bash
mise exec -- pnpm check                                          # from the repo root
mise exec -- pnpm --filter @siteadapter/browser-electron test:e2e
mise exec -- pnpm --filter @siteadapter/browser-electron typecheck:e2e
```

The e2e suite launches the real Electron through Playwright. `e2e/harness/` is the Electron main
process: it makes a self-signed certificate with `openssl`, serves a small HTTPS site on
`127.0.0.1`, maps every `*.test` host to it with `--host-resolver-rules`, and trusts only that
certificate's fingerprint. Nothing leaves the machine. `e2e/site-isolation-off.spec.ts` and
`e2e/hints.spec.ts` relaunch the harness with a process-wide switch changed, to measure a
decision rather than to test the default.

## Behaviour worth knowing

- **Secrets are typed only into the element `focus()` targeted.** Before typing, the page checks
  that the element still has focus in the same frame and origin, and that the browser process
  (`webContents.focusedFrame`) agrees. Before every character it checks that focus hasn't left
  that frame and that no frame has committed a navigation. A secret typed without a `focus()`
  first is refused.
- **Cross-origin iframes: inspect works, input doesn't.** With site isolation, which Electron
  enables by default, a cross-origin iframe runs in its own renderer process, and
  `sendInputEvent` never reaches it: the click lands on the `<iframe>` element in the parent and
  keystrokes go nowhere. The driver therefore refuses `click` and `focus` on an element in an
  out-of-process frame (`element-unsuitable`) instead of typing blind. Switching site isolation
  off makes it work (see `e2e/site-isolation-off.spec.ts`); CDP `Input.dispatch*` would be the
  other route. Neither is done here: it's a decision for the app.
- **Leaving the navigation origins poisons an auth page.** A prevented main-frame navigation, a
  prevented redirect, or an off-list commit all make every later primitive fail with
  `navigate/navigation-escaped`. Subframes may load any https origin, because login pages embed
  CAPTCHA and bot-check frames; secret fills check the frame's origin separately.
- **Storage handoff needs a document on the origin.** Keys are read in an auth-partition page and
  written in a tool-partition page on that origin. An open page is reused; otherwise a short-lived
  hidden page loads `/robots.txt` (configurable) on that origin and is destroyed afterwards.
- **Resource hints.** `hardenProcess()` turns off Blink's DNS prefetching, and the tool partition
  sends `X-DNS-Prefetch-Control: off` on every response. In the e2e suite Electron 44 opened no
  connection for `dns-prefetch` or `preconnect` hints even without either, so the suite can't yet
  show that the hardening is what stops them.
