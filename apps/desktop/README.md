# @valet/desktop

The menu-bar app: the Electron main process that wires every package together, the preload that
exposes [`src/shared/api.ts`](src/shared/api.ts) as `window.valet`, and the renderer (the
control panel, the tray popover, the confirmation panel and the login hand-off banner, in React 19
and plain CSS built from [docs/mockups](../../docs/mockups)).

```
src/shared/api.ts          the window.valet contract (types only)
src/main/
  index.ts                 entry: imports electron/app.ts
  adapters.ts              built-in adapters; their sources are embedded at build time and hashed
  core/                    everything pure, unit-tested in plain Node (test/main)
    service.ts             AppService: stores, runtime, auth flow, endpoint, and the API behind IPC
    ipc.ts, channels.ts    the channel list and the zod schema of every channel's arguments
    login.ts               the AuthRunner over runAuthFlow, its probe hooks, the hand-off window
    confirmations.ts       the runtime's ConfirmationPrompt, answered in the floating panel
    credentials.ts         providers by grant.provider; the op binary checks; vault listing
    grants.ts              grant requests checked against the approved manifest
    permission-diff.ts     the review screen's diff; views.ts, audit-view.ts: the other view models
    caller.ts              the MCP endpoint's ToolCaller over ToolHost: signals, transport, refusals
    registry.ts            bundle hashes, and the last approved manifest of each adapter
    blocked.ts             the driver's refusals outside a run, redacted and audited
    app-scheme.ts          app://renderer: the scheme the built renderer is served from
    updates.ts             whether this build updates itself, and the versions it has run
    feed-defines.ts        the update feed a build compiles in, from its environment
    constants.ts           names and numbers decided once (Keychain, vault, timeouts, file paths)
    settings, clients, run-memory, files, launch, geometry, snippets, demo
  electron/                the Electron glue: app, windows, tray, ipcMain, demo site, updater
  updater/                 the update controller, the signed feed and its session guard
src/preload/               index.ts (contextBridge) over api.ts (built from the channel list)
src/renderer/
  index.html, control.tsx  control panel entry (hash routes)
  tray.html, tray.tsx      tray popover entry
  boot.tsx                 mounts a page against the preload's API (or the dev fake)
  control/                 window shell: routes and sidebar
  screens/                 one module per screen
  tray/                    the popover
  components/              shared pieces; Preview draws redacted JSON
  lib/wording.ts           the only place codes become words
  lib/permissions.ts       reading a permission diff (does it add anything?)
  lib/routes.ts            routes, pure (the main process checks routes with it); router.ts adds the hook
  dev/fake-api.ts          in-memory API with Woolworths data, for vite dev and tests
  dev/screenshot.mjs       renders every screen to screens/ for comparison with the mockups
  styles/                  tokens.css and app.css from the mockups, plus controls.css and screens.css
test/                      renderer tests (jsdom); test/main: the main process (Node); test/smoke: Playwright
test/updater/              the updater and the packaging config (Node)
scripts/                   package, package-smoke (and smoke/), make-feed
screens/                   committed screenshots, light and dark
```

## Running it

```bash
mise exec -- pnpm --filter @valet/desktop demo        # a demo build, launched against the local fake
mise exec -- pnpm --filter @valet/desktop dev         # electron-vite dev (demo mode available)
mise exec -- pnpm --filter @valet/desktop build       # main, preload and renderer to out/, no demo mode
mise exec -- pnpm --filter @valet/desktop start       # launch what build made
mise exec -- pnpm --filter @valet/desktop test:smoke  # a demo build, then the Playwright smoke test
mise exec -- pnpm --filter @valet/desktop test:e2e    # a demo build, then the end-to-end suite (e2e/)
mise exec -- pnpm --filter @valet/desktop screens:live # a demo build, then screens/live/ from the real app
mise exec -- pnpm --filter @valet/desktop package     # a plain build, then dist/: valet-dev.app and its zip
mise exec -- pnpm --filter @valet/desktop package:smoke # a smoke build, packaged and launched (see Packaging)
mise exec -- pnpm --filter @valet/desktop exec vite   # the renderer alone, on the fake API
mise exec -- node apps/desktop/src/renderer/dev/screenshot.mjs      # every screen to screens/
mise exec -- pnpm exec tsc --noEmit -p apps/desktop                    # renderer (DOM), tests
mise exec -- pnpm exec tsc --noEmit -p apps/desktop/tsconfig.node.json # main and preload (Node)
mise exec -- pnpm vitest run --project desktop --coverage.enabled --coverage.include='src/**'
```

`vite` and `electron-vite` are dependencies of this package only, so they run through `--filter` (or
from `apps/desktop`). Electron's binary must be in `node_modules/electron/dist`; after an offline
install run `node install.js` in the electron package once (it is cached in `~/Library/Caches/electron`).

### Demo mode

`VALET_DEMO=1` (or `--demo`) runs the whole app against `fakes/woolworths-site`, with no real
account anywhere. Only a development build has it: `electron-vite dev`, or `electron-vite build
--mode demo` (what the `demo` and `test:smoke` scripts run). A plain `build`, which packaging uses,
sets `__VALET_DEMO_BUILD__` to false (`src/main/build-flags.d.ts`), so the demo chunk, the fake
site, its certificate generator, its fixtures and the test account aren't in `out/main` at all; and a
packaged app ignores both switches whatever the build. In demo mode:

- its own userData, `~/Library/Application Support/valet-demo`; `VALET_USER_DATA` can
  move it, but never to the real `valet` folder or anything inside it;
- the fake site in-process over TLS on `www.woolworths.test` and `auth.woolworths.test` (a fresh
  certificate from `openssl` each launch), mapped to 127.0.0.1 by a host resolver rule appended
  before ready. That certificate is trusted for exactly those two hosts, on exactly the adapter's two
  partitions; everything else keeps Chromium's own verification;
- the adapter built with `createManifest({ origin, authOrigin })` for the fake's origins, which gives
  it a hash of its own, so a demo approval never stands for the real site;
- the test credential provider holding the fake's two-factor account (`twofactor@example.test`) as
  the item “Woolworths (demo account)”, and SMS codes read from the fake's outbox in place of
  Messages. Real 1Password and Messages are off;
- a DEMO badge: the tray's menu-bar title, the popover and the control panel's sidebar;
- no updates: a demo build compiles in no feed, so Settings says updates are off (`disabled`,
  `not-configured`), and a demo launch of any build is `development`;
- the fake on the ports the last demo launch used (`demo-site.json` in userData), since the ports
  are in the adapter's origins and so in its hash: on new ports every launch, a restart was a new
  bundle waiting for review with no grants. Taken ports get new ones, and the adapter waits again;
- the adapter's two partitions kept across launches. The fake keeps its visitors, Akamai sensor
  cookies and Auth0 sessions in memory for one launch only, so after a restart the partitions hold
  cookies it never issued. It replaces an `_abck` it doesn't know (its `unknownSensor: 'reissue'`
  default) and starts a new visitor for an unknown session cookie, so the first call just logs in
  again. The demo used to empty both partitions at launch for this; it no longer needs to. The
  update suite's restart covers it: `get_cart` after a restart logs in and works;
- the fake's fixtures bundled into the demo chunk: the fake imports them as JSON modules, so
  nothing is copied into `out/main`.

To try it: approve Woolworths in the control panel, grant `login` from “Woolworths (demo account)”
and Messages codes from `Woolworths`, then add the client from the snippet in Settings (it names the
server `valet-demo` and points at the demo's `bridge.json`). `search_products` needs no login;
the first cart tool logs in (email, password, SMS code) in the hidden auth window.

### For the end-to-end suite

- `VALET_USER_DATA=/abs/dir` uses that directory as userData (a relative path is ignored). A
  packaged app ignores it.
- `VALET_E2E=1` only makes window titles deterministic, and sets the same text as the document
  title: `valet (demo) [control]`, `valet menu [tray]`, `valet: confirm
  [<confirmation id>]`, `valet: sign in [<adapter id>]`. Outside a demo launch it exposes
  nothing else; in one, see the e2e-only switches below.
- Until first-run setup is finished or skipped (`setup.json` in userData), every launch opens the
  control panel at `#/setup`. In e2e mode setup stays closed unless `VALET_E2E_SETUP=1`, so the
  other specs start on the adapters page; `e2e/setup.spec.ts` sets it. Otherwise the control panel
  opens at launch when something waits for the person, in demo mode and in e2e mode.
- **E2e-only, and only in a demo build** (the demo chunk, which a production build doesn't carry):
  in an e2e launch, `evil.test` is mapped to 127.0.0.1 alongside the demo hosts (the egress canary
  runs the fake's exfil sink there, so a request the app let out would arrive rather than fail to
  resolve), and the main process's global `__valetE2e` holds three calls on the fake site for
  Playwright's `app.evaluate`: `blockAll(on)`, `trolley()` (the demo account's lines) and
  `pageBeacon(target | null)` (the fake's hostile page script, `setPageBeacon`). No renderer can
  reach the main process's globals.

The suite (`e2e/`, Playwright's `_electron`, one app per spec on a temporary userData) drives the
built app where the person acts and a real MCP client (the SDK's, over Streamable HTTP with the
token from `bridge.json`) where an agent does:

- `journey.spec.ts`: first launch (pending, no tools on MCP), approve in the review screen, grant
  `login` and Messages in the grant sheet (only the manifest's origins offered; a widened origin
  refused by the main process), search, add (the login: email, password, SMS code on the fake's
  Auth0), get, set and remove, the trace, the secret scan (the demo password, the SMS code and the
  endpoint token in no MCP result, audit line, window DOM or log line), the breaker (the fake blocks
  everything: `blocked` with a wait, the adapter shown blocked with its retry time), and the audit
  chain (verified, then broken by an edit on disk).
- `egress.spec.ts`: the canary (proven live first, through Chromium's own stack), then the fake's
  page beacon: the site's own script on every www page, sending the page's cookies to `evil.test`
  every 200 ms by beacon, fetch, image and WebSocket. The tool page is closed so the next run opens
  a fresh one with the script, and the test waits until the page has counted two rounds
  (`data-beacon-rounds`, read from an isolated world). Nothing connects, and every attempt is
  audited `request-blocked`, initiator `page`, partition `tool`, origin only: those during a run
  with its call id (the runtime's), those between runs with none (the app's).
- `update.spec.ts`: a copy of the build with a changed Woolworths bundle (`remove_from_cart` made
  irreversible, in the compiled manifest and the embedded source alike: `changedAdapterBuild()` in
  `e2e/harness.ts`). A plain restart keeps approval and grants; the changed one waits for review with
  a diff, its tools off MCP and no grants; approved and granted again it works, and the confirmation
  panel's Decline reaches the client as `declined`, its Approve (only from that panel) runs the tool.
  A client that cancels while the panel waits closes the panel: the answer is audited as declined,
  the call as `failed tool-run/aborted`, and the line stays in the trolley.
- `screens.spec.ts`: `screens/live/`, light, 1440x900 at scale 2. Skipped unless
  `VALET_E2E_SCREENS=1` (the `screens:live` script), since it rewrites committed files.

The MCP SDK is a devDependency here, for the harness's client. Every spec closes its app, and a
global teardown kills any process still running this worktree's Electron binary, never another
app's.

In a plain browser there is no preload, so `boot.tsx` loads the fake API. The import sits behind
`import.meta.env.DEV` at the import site, so a production build drops it: `test/build.test.ts` builds
the renderer and checks no fake chunk or fixture data is emitted. Without a preload a production
page shows an error.

`ELECTRON_RENDERER_URL` (the dev server) is trusted only by a bundle `electron-vite dev` built
(`__VALET_DEV_SERVER__`), never packaged, and only as an `http://localhost` or
`http://127.0.0.1` origin with a port: every page on that origin gets the preload and the app's IPC
trust, so a value left over in a shell must not make another origin the app's.

Two projects typecheck the app, and the root `typecheck` runs both. `tsconfig.json` has DOM and JSX,
for the renderer and the tests. `tsconfig.node.json` has no DOM, for the main process, the preload,
the shared contract and `electron-builder.config.ts`, so main-process code can't lean on a browser
global. The root tsconfig stays Node-only.

Vitest 5 resolves `--coverage.include` against the project's root (`apps/desktop`), so the include
is `src/**`, not `apps/desktop/src/**`. The root config excludes `src/renderer/dev/**` (the fake),
every `index.ts`, and `src/main/electron/**`: that is Electron glue, covered by the smoke test and
the e2e suite instead, as `packages/browser-electron/src/electron/**` is. The main-process tests
start with `@vitest-environment node`.

## Packaging

`package` runs a plain `electron-vite build`, then `scripts/package.mjs`: electron-builder with
`electron-builder.config.ts` as a development build for this Mac's architecture, `dir` and `zip`,
into `dist/`. It is never signed with an identity and never notarised. The child gets
`CSC_IDENTITY_AUTO_DISCOVERY=false` and none of the caller's `CSC_*`, `APPLE_*` or `VALET_*`
variables but `VALET_UPDATE_URL`; the fuse flip re-signs the bundle ad hoc. Electron comes
from the installed copy, cloned without `default_app.asar`. Release builds are the release
script's job ([docs/release-and-updates.md](../../docs/release-and-updates.md)).

What the package carries (`files` in the config): `out/main`, `out/preload`, `out/renderer`,
`package.json` (its `main` is `out/main/index.js`), and from `node_modules` only what the main
bundle keeps external, `@1password/sdk` and `@1password/sdk-core` (`PACKAGED_NODE_MODULES`). Every
workspace package and npm dependency is bundled into `out/main`. No source maps. The main and
preload builds empty their output first, so a demo build's chunk and fixtures never reach a plain
one.

A release packages whatever `out/` holds, so `electron-builder.config.ts` checks it first: for
`VALET_RELEASE=1` it refuses an `out/main` that doesn't hold the same `VALET_UPDATE_URL`
and a feed public key, or that is a smoke build (`checkReleaseBundle`). The vite step itself refuses
a release without a feed, or one that isn't a plain build (`core/feed-defines.ts`).

`package:smoke` runs a smoke build (`electron-vite build --mode smoke`), then
`scripts/package-smoke.mjs`, which packages twice in a temporary directory and deletes everything
afterwards (`--keep` keeps it). A smoke build is a plain build plus two things behind
`__VALET_SMOKE_BUILD__` (`core/smoke.ts`): it also accepts the smoke's own argv, and once up it
writes a self-check to `userData/smoke-report.json`. A plain build has neither.

1. A placeholder app (`scripts/smoke/main.cjs`), for the checks that need code of its own: the fuse
   wire, the asar and Info.plist, `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` and `--inspect` refused, a
   tampered asar and an `app/` folder refused, the renderer's module script running from `app://`
   but not from `loadFile`, and a launch under a temporary `HOME` that must move
   `app.getPath('appData')` and `userData` under it.
2. The real app from the real `out/` (`scripts/smoke/real-app.mjs`): Info.plist, the fuse wire, and
   an asar holding only the build and the SDK (no demo chunk, fixtures or maps). Then it is launched
   under a temporary `HOME` (and `CFFIXED_USER_HOME`), with no `ELECTRON_*` or `NODE_*` variables
   and exactly the smoke argv: Chromium's mock keychain, `--remote-debugging-port=0`, and a host
   resolver that resolves nothing but loopback. Over the DevTools protocol it must show the control
   panel on `app://renderer/index.html` with Woolworths waiting for review, the preload's API and no
   Node. The self-check must say the 1Password SDK resolved from `app.asar` and imported (its wasm
   included), and that the bundled electron-updater imported. Then it quits through its own quit
   path, and its data must be under the temporary `HOME`. Next it is launched with argv and
   variables it must refuse, each under a fresh `HOME`: a DevTools port alone, a single-dash one,
   the smoke argv with one more switch or reordered, a host resolver rule, a relative bridge config,
   `ELECTRON_ENABLE_LOGGING` and `NODE_TLS_REJECT_UNAUTHORIZED`. Each must exit with status 64 and
   write none of the app's data. Last, every entry under the real
   `~/Library/Application Support/valet` and `valet-dev` (path, size, mtime) must be as it
   was. It doesn't launch at all unless step 1 showed the temporary `HOME` moving the data.
   Playwright can't drive it: its Electron launcher needs `--inspect`, which the fuses turn off.

## The main process

- **The command line is checked first** (`electron/guard.ts`, `core/argv.ts`). `src/main/index.ts`
  imports the guard before anything else, so it runs before ready, the single-instance lock, any
  window or any secret. A packaged app takes only two argv shapes: the executable alone (or with
  macOS's `-psn_…` argument, not verified to still be passed), and `--mcp-bridge <absolute path>`.
  Bridge mode isn't built yet, so it is refused too, with its own message. A smoke build also takes
  exactly the smoke's argv. Any `ELECTRON_*` or `NODE_*` variable but `NODE_USE_SYSTEM_CA` is
  refused. A refused launch writes one fixed line and exits with status 64; `electron/app.ts` starts
  nothing then. Chromium parses its switches before main runs, so this is detection and early exit:
  in the package smoke a refused launch exits in about 200 ms and no DevTools listener came up
  first. Electron 44 removes `NODE_OPTIONS` and `NODE_EXTRA_CA_CERTS` from the environment itself
  with the NodeOptions fuse off. Unpackaged runs aren't checked: Playwright launches them with its
  own switches.
- **Process model.** Main owns everything privileged; renderer windows are views. Each is sandboxed,
  with context isolation, no Node, the preload only and devtools only unpackaged, and may show only
  `index.html` or `tray.html` of the app's own renderer: navigation, redirects, webviews and
  `window.open` are refused, and the default session (which only our windows use) cancels every
  request outside the renderer and grants no permission.
- **The renderer is served from `app://renderer`, never `file://`.** The packaged app has the
  `grantFileProtocolExtraPrivileges` fuse off, and with it off a `file://` page can't run Vite's
  module scripts. So `app` is registered as a privileged (standard, secure) scheme before ready, and
  `protocol.handle` serves `out/renderer` (inside `app.asar` when packaged) on the default session
  only (`core/app-scheme.ts`: GET and HEAD, files under the root with a type the build emits, 404
  for anything else). Every build that loads its own files uses it, demo and e2e included. Windows
  load `appPageUrl(page, hash)`, and `isAppPage` (the IPC sender check and the navigation lock) and
  the default session's request filter compare against `app://renderer`. Only `electron-vite dev`
  loads from its dev server (an `http://localhost` origin), as before.
- **IPC.** One `invoke` channel per API method, `valet:<method>`, and one event channel,
  `valet:event`. Every request must come from the main frame of one of the app's windows (by
  the role the main process gave the window when it opened it), on one of the app's pages, and its
  arguments must parse with the channel's zod schema: strict objects (so `__proto__`, `constructor`
  or any extra key is refused), bounded strings, exact ids and hashes, no extra arguments. Anything
  refused or failed rejects with one fixed message. Events cross as `{ type }` (and `seq`) only.
- **Data**, owner-only under userData: `grants.json` (credentials' FileGrantStore),
  `grant-items.json` (item titles to show), `approvals.json`, `approved-manifests.json` (what was
  last approved, for diffs), `audit.jsonl`, `breakers.json` (the runtime's own; the app never reads
  it), `settings.json`, `clients.json`,
  `endpoint.json` (when the token was last rotated), `bridge.json` (port and token, 0600),
  `versions.json` (the last and highest versions run) and `login-markers/`. userData is
  `~/Library/Application Support/<app name>`: `valet` for a release, `valet-dev` for a
  development package and for every unpackaged run (`pnpm start`, `electron .`). So no development
  code writes the release folder: it can't raise the release's version floor or audit an
  `update-installed` that never happened.
- **Diagnostics**, in `logs/valet.log` under userData (`core/diagnostics-log.ts`), owner-only,
  at most two files of 1 MiB. It is where the app says what a menu-bar app has no terminal for:
  that it started and stopped, the updater's states, refused IPC, a runtime diagnostic (an audit
  write that failed, say), a renderer or child process that died by itself, an unhandled
  rejection, and an exception nothing caught. Every line is fixed text and codes. An error is its
  name, its code and its stack frames, never its message, which could quote a page. After an
  uncaught exception the app doesn't carry on: a packaged app that had been up for a minute
  restarts once (the attempt marker, the breaker and the audit chain are on disk, so that is safe
  at any point in a run); otherwise it exits, so a crash at start can't loop.
- **Adapters.** Built-in only. A hash is `bundleHash` over the adapter's source files, embedded by
  the bundler from the same files it compiles, plus the effective manifest. A hash nobody approved
  waits for review and runs nothing; `approvals.approve` refuses any hash but the installed one. A
  changed hash is reviewed as a diff against the last approved manifest and source, and has no
  grants until they are made again.
- **Credentials**, by `grant.provider`: the service account (`KeychainTokenSource`; service
  `valet`, account `onepassword-service-account`, vault `valet`, in `core/constants.ts`,
  pending D6/D43); `op`, only at a path that passed the checks; Messages, only while its setting is
  on; the test provider in demo mode only. The op checks: absolute; the file (after symlinks) and
  every directory above it, and above the link, owned by root or the person, never writable by
  others, and writable by the group only when the group is admin (gid 80) and the person is in it;
  and `codesign --verify` against 1Password's Team ID. A chosen path that fails is refused and the
  old one kept; with none chosen, the usual places get the same checks. Never PATH.
  - **D44, decided here: admin-writable counts as the person's.** Homebrew makes `/opt/homebrew/bin`
    and `Caskroom` `drwxrwxr-x`, group admin, so `brew install 1password-cli` could never pass a
    no-group-write rule; only the `.pkg` in root-owned `/usr/local/bin` could. Every admin can
    become root with `sudo`, so a directory admin can write adds no one who couldn't already
    replace a root-owned binary; on a one-person Mac, admin is the person. Any other group, and
    world-writable, are still refused.
  - **The vault is listed by the provider the grant uses.** Both 1Password providers implement
    credentials' `listItems(vault)`: the CLI runs `op item list` with the checked binary, and the
    service account asks the SDK through the same cached client it resolves with, so the token
    still goes only to `sdkClientFactory`. Only ids and titles come back. A failure is a
    `CredentialError` (`not-found`, `locked` or `unavailable`) and the grant sheet says it couldn't
    load the items. The service account is offered once `@1password/sdk` resolves from the app
    (`serviceAccountReady`; `SERVICE_ACCOUNT_LISTS_ITEMS` is true) and its token is in the Keychain
    (asked without `-w`, so no prompt). Listing reads the token, which prompts as described in
    docs/security-model.md. The SDK is a dependency of this package, external to the main bundle,
    so `out/main` finds it in `node_modules`, and the package ships it (with `@1password/sdk-core`
    and its wasm) in `app.asar`.
- **Grants** are checked against the installed hash's manifest (`core/grants.ts`): exact hash, an
  available provider, a requested secret or a declared Messages sender character for character,
  origins a non-empty subset of the request, and an item the provider lists now (stored by id, as
  `op://valet/<id>`). `grant-made` and `grant-revoked` are audited before the store changes.
- **Runtime.** One `ToolHost` with each adapter on its own `createElectronSessionDriver`. The
  `AuthRunner` runs `runAuthFlow` on the driver's auth page with the grant store, the providers, the
  OTP reader, probe hooks over the page's own `AuthPage.fetch` and `cookieNames` (and only to home's
  origin), `rememberSecret` wired to the runtime's `registerForRedaction`, and Akamai's page as
  `isBlockedPage`; it writes no login events.
- **Refusals outside a run are audited** (`core/blocked.ts`), as `request-blocked`. Every login page
  the app opens, the automated login's and the person's own window, is opened with
  `openAuthPage({ onBlocked, onReportsDropped })`: its refusals are written with partition `auth`
  and the call that needed the login (null for the person's window). `DriverOptions.onAuthBlocked`
  takes the auth partition's refusals no page took. `DriverOptions.onBlocked` takes the tool
  partition's between runs: partition `tool`, call id null, at most 50 per adapter every ten
  minutes (then one `request-blocked-capped` diagnostic). Each target goes through the runtime's
  redaction for targets first (`sensitiveMatcher`, session values case-insensitively) against the
  tool partition's session values and the secrets each login registered (the app keeps its own
  clones, as the runtime does; the latest successful login's set is never evicted for pending
  ones); if the session values can't be read the target is `[redacted]`. The values are read when
  the refusal is reported, and every value read is kept (at most 256 per adapter), so a cookie that
  rotated before the write still matches. A refusal for an adapter with no driver yet is not
  written; it is reported as a `request-blocked-unattributed` diagnostic.
  During a run the runtime audits the tool partition's refusals itself.
  On `needsUser` the auth window stays open with the banner above it and the call returns at once
  (D50); the window closes after 15 minutes. `finishLogin` probes the auth partition and hands off
  only if that passes, then clears the login hold.
- **The person's own login work** (`openLoginWindow`, `finishLogin`) runs as the runtime's login
  steps (`ToolHost.runLoginStep`, waiting at most `LOGIN_WAIT_MS`). So it needs the installed hash
  approved, takes the adapter's lock in turn behind calls (and the settling of work a call started),
  and calls that arrive meanwhile wait for it: a hand-off never copies the session into the tool
  partition in the middle of another call's run. It is refused while the site's breaker is open,
  persisted state included (`login/rate-limited`), and each step takes a slot of the site's rate
  budget. Opening the window loads the first `goto` of the auth steps; if that is Akamai's block
  page, the step opens the site's breaker (`reportBlocked`), closes the page and fails
  `login/blocked-by-site`. Finishing probes through `steppedProbe`, which does the same on a 429 or
  a block page, and paces again before a storage hand-off, which loads pages. A login window the
  person opens themselves (`NeedsUserItem.startedBy: 'person'`) leaves the session's state alone if
  they give up, and the banner says they opened it rather than blaming the granted secrets.
- **The banner never covers the auth window.** It is frameless and on top, so over the window it
  would hide the title bar and the top of the login page. It goes directly above the window; when
  there's no room (the usual case for the 900 px auth window), the window is moved down, and
  shortened if need be, to make room, and the banner follows the window as it is moved or resized
  (`core/geometry.ts`).
- **Confirmations.** `ctx.confirm()`, and the runtime's own question before an irreversible tool,
  open a floating, always-on-top panel, shown inactive with `acceptFirstMouse: false`. An approval
  counts only from the window opened for that confirmation (the main process records which id each
  panel shows; panel A can't approve B), at least `CONFIRM_ARM_MS` after it was last shown or focused, and
  before it expires; a decline is taken from any app window. Unanswered, it declines itself after two
  minutes (D50), the runtime's deadline too.
- **MCP.** `startEndpoint` with the package defaults, D41's recommendation: a port kept across
  launches and a new token every launch. The bridge reads both from `bridge.json` and follows on its
  own; a token collected by whatever held the saved port while the app was down dies at the next
  start. `'on-reset'` waits for an HTTP-client setup that shows the token and states that risk; the
  app has none (snippets are bridge-only, and no API returns the token). The `ToolCaller` caches the
  runtime's async listing and refreshes it when approvals change. Each call passes the client's
  `signal` and the endpoint's `transport` label to `host.call`. A client that cancels, or goes
  away, aborts the call (`failed tool-run/aborted`); during a confirmation the panel closes and the
  answer is audited as declined. Quitting cancels every call still running the same way. A call's
  login that is aborted runs on to its own deadline (auth-flow takes no signal) and, if it stops
  part-way, leaves the login marker set until the person clears it. `endpoint.status` counts the
  endpoint's live sessions (`sessions().total`), and every change to them (`onSessionsChanged`)
  tells the windows. A client's transport in the clients list, and on the confirmation panel, is
  the endpoint's label for its session. The app's own refusals never
  reach the runtime but are audited like a call (`tool-called`, then `tool-finished` with outcome
  `failed`): while paused, `config: unavailable` (not a rate limit: the site isn't involved); under
  a revoked client name, `config: not-granted`. The runtime never reports stage `config` for a
  call, so the log tells them apart. Snippets launch the stdio bridge from the repo with `tsx` until
  packaging bundles it.
- **Updates.** The feed is compiled in: a plain `electron-vite build` whose environment names both
  `VALET_UPDATE_URL` (https, a public host, a directory) and `VALET_FEED_PUBLIC_KEY_FILE`
  (the feed key's SPKI PEM) defines `__VALET_FEED_BASE_URL__` and
  `__VALET_FEED_PUBLIC_KEY__` (`core/feed-defines.ts`); one without the other fails the
  build. The URL rule is electron-builder's: with `VALET_RELEASE=1` the feed is required and
  must be https on a public host; otherwise https to any host or http on loopback is taken, for the
  updater end-to-end build, and the updater then accepts that loopback feed. Dev, demo and smoke
  builds never have one. At launch, before any
  adapter, credential or endpoint, the service records the version in `versions.json` (writing
  `update-installed` `{ from, to }` on the first launch of a newer version) and builds the updates
  (`core/updates.ts`, `electron/updates.ts`). The updater is on only for a packaged, non-demo build
  with a feed and a Developer ID signature (`codesign -dv` on the running bundle); otherwise
  `updates.status` is `disabled` with the reason (`not-configured`, `development`, `unsigned`) and
  nothing contacts a feed. When on: `confineUpdaterSession` on the `electron-updater` partition,
  `createUpdater` with the signed feed, the channel and install-on-quit read from the settings at
  every check, the highest version run as the floor, and a check at launch and every six hours.
  Before it installs, it waits for every adapter to be idle: an empty login step per adapter, which
  takes the lock behind any call (and a slot of the site's budget). An unapproved adapter, or a site
  whose breaker is open, counts as idle.
  `update-downloaded` `{ from, to }` is audited once per verified download. PATH is set to the
  system default first, for the whole main process: electron-updater runs `uname` and `sysctl` by
  name inside its own download path. Everything else main runs is by absolute path.

### Where the main process departs from the contract below

- `settings.set` with a key outside `SettingsPatch`, `opPath` included, is refused as a whole rather
  than the key dropped: every channel refuses unknown keys.
- `clients.revoke` refuses calls made under that reported name. Every client shares one token, so
  this stops an honest client only; rotating the token is the real control.
- `ClientInfo.transport` and `ConfirmationItem.clientTransport` are the endpoint's label for the
  session: `stdio` for a session the bridge opened (it sends `x-valet-transport:
  stdio-bridge`), `http` otherwise. Any local client with the token can send that header, so it is
  a label like the name, never a permission.
- `EndpointStatus.connectedClients` is the number of MCP sessions open now, not of distinct clients:
  a client may hold more than one, and a session stays open until it closes or is evicted.
- `PendingReview.source` is `import` for a built-in bundle, and `submittedAt` the launch time.
- `AdapterDetail.handedOver` is always null: the driver doesn't report hand-off counts. The adapter
  page shows no "Handed over" row then.
- `RunTrace` has no probe or allowed-request steps (the runtime doesn't audit them), so
  `requests.sent` and `requests.probes` are null and the trace shows the blocked count alone. Input
  and output previews are kept in memory for the last 200 calls only.
- `ProviderStatus.grantCount` counts only grants for an adapter's installed hash while that hash is
  approved: a grant for an older bundle can't be used.
- `UpdateStatus` has two new states, `disabled` (with `disabledReason`) and `not-checked`, so a build
  that doesn't update, or hasn't checked yet, is never shown as up to date. There is no install
  action in the contract: with "Install updates automatically" on, a downloaded update installs
  when the app quits. So a `ready` update shows as downloaded, with a line saying it installs on
  quit, or that automatic installs must be turned on to apply it. Settings have no switch for
  automatic checks.
- `AppStatus.demo` is new: it drives the DEMO badge.
- `NeedsUserItem.startedBy` is new: `'person'` for a login window opened from the app.

## The contract for the main process and preload

The preload exposes one object as `window.valet`, typed `ValetApi`. Every method is
async and takes and returns plain JSON. `onEvent(listener)` returns an unsubscribe; events carry no
data, only which part changed, and the renderer refetches.

What the main process must hold to, because the renderer relies on it:

- **No secret ever crosses.** No secret value, `op://` reference or item field, session cookie or
  storage value, or endpoint token. What does cross for an item is an opaque id (`VaultItem.id`,
  sent back as `GrantRequest.itemRef` and returned as `GrantInfo.itemId`) and its title; tool input
  and output come as `PreviewPart[]`, already redacted, with markers where values were removed. Client setup snippets point at the bridge, which reads the token from its
  own 0600 file. Copying goes through the main process (`endpoint.copyUrl`,
  `endpoint.copyClientConfig`, `app.copyText`), so the renderer never needs the clipboard or the
  token. A test feeds every screen an API that leaks extra fields (audit records included: the
  inspector and Copy record show only the fields core's `AuditEvent` defines per type) and checks
  none reach the DOM. A secret inside a field a screen does render would still show, so the
  guarantee is the main process's.
- **Codes, not text.** Reasons, stages and error classes are core's codes; the renderer words them
  in `lib/wording.ts` and never shows an unknown code's text. A rejected promise's message is never
  shown either: every failure reads "Couldn’t … Try again.".
- **Adapter text is attributed.** Manifest descriptions and notes, and the optional `confirm()` note
  (`ConfirmationItem.adapterNote`), are shown as plain React text, quoted, labelled "From the
  manifest" or "Shown by the … adapter", and cut to a fixed length. Everything else on the
  confirmation panel must come from the runtime's own knowledge.
- **Client names are claims.** Every client shares one token, so `client`/`reportedName` is only what
  a client said in MCP initialize. Screens word it as "a client calling itself “Claude Code”" (or
  quote it with an "unverified" title), strip control and bidi characters, and cut unknown names to
  40 characters. `ConfirmationItem.clientTransport` is the endpoint's label for the session, passed
  through the runtime: a claim as well.
- **Login changes are in the diff.** `PermissionDiff.authSteps` lists every auth step other than
  `fill` (which `secretFills` covers) and `probe` has the login check before and after. The runtime
  renders each step's `detail` from the manifest's structured fields, never from page text or a
  step's note. An added step, a removed `needsUser`/`fail`/`assertLoggedIn`, or any probe change
  needs the acknowledgement tick, as a new permission does.
- **Messages grants.** Core keeps one `messages` grant per adapter hash, keyed by the sender handle in
  `itemRef`. `MessagesSourceInfo.grant` must be non-null only for the source whose `sender` equals
  `grant.itemId`, so a second declared sender never shows as granted.
- **Re-check every action.** The renderer only offers what it should; the main process enforces it.
  `approvals.approve(adapterId, hash)` must refuse if that hash is no longer the pending one.
  `grants.make` must refuse origins outside the manifest's request for that exact hash (for
  `messages`, the manifest's navigation origins) and an `itemRef` that isn't a vault item id or the
  declared sender. `answerConfirmation` must refuse an id that has expired or been answered.
- **The confirmation window can't be clicked through.** Open it with `showInactive()` (don't steal
  focus from what the person is typing into) and `acceptFirstMouse: false`, so the click that
  brings it forward isn't delivered. The renderer focuses Decline (Return and Escape decline) and
  keeps Approve disabled for `CONFIRM_ARM_MS` (800 ms) after it mounts and again after the window
  regains focus or visibility; the main process must also refuse an approval that arrives within
  `CONFIRM_ARM_MS` of the window showing or being focused.
- **Nothing the renderer sends names a binary or a URL.** `settings.set` takes a `SettingsPatch`
  without `opPath`, and the main process drops unknown keys. The 1Password CLI path changes only
  through `settings.chooseOpPath()`: a native open dialog in the main process, then checks that the
  path is absolute, neither the file nor its directories are writable by group or others, and it
  carries 1Password's code signature, before saving. `app.openControlPanel(route)` takes a
  `HashRoute`; the main process accepts only a hash `parseRoute` reads as a page (not-found is
  refused), sets it as the hash of its own `index.html`, and never passes it to `loadURL`.
- **Windows.** Every renderer window: `contextIsolation: true`, `sandbox: true`,
  `nodeIntegration: false`, and the CSP `vite.config.ts` writes into built pages
  (`default-src 'none'; script-src 'self'; style-src 'self'; …`, no `'unsafe-inline'`). The title
  bar is hidden-inset; the sidebar and title bar are drag regions.

Routes the main process opens (`lib/router.ts`):

| Route                       | Where                                                                        |
| --------------------------- | ---------------------------------------------------------------------------- |
| `#/adapters`, `#/activity`… | The control panel window, `index.html`                                       |
| `#/adapters/<id>/review`    | Review of a pending bundle, full window (no sidebar)                         |
| `#/adapters/<id>/grant/<s>` | Grant sheet over the adapter page; `<s>` = `messages` for SMS codes          |
| `#/confirm/<id>`            | Its own small window, shown inactive (see above), for a pending confirmation |
| `#/needs-user/<adapterId>`  | A view above the auth window's web view: the hand-off banner and status bar  |
| `#/setup`, `#/setup/<step>` | First-run setup, full window; no step resumes at the first one not done      |
| `#/setup/approve/review`    | The bundled adapter's review, opened from setup and returning to it          |
| `#/setup/grant/<s>`         | The grant sheet over setup's grant step, closing back to it                  |
| `tray.html`                 | The tray popover window (400 px wide, transparent background)                |

## What differs from the mockups, and why

- No fake system menu bar, wallpaper or traffic lights: macOS draws the real ones.
- Rate budgets per hour aren't in core (only `minGapMs` and cool-downs), so the home page shows
  today's calls, logins and blocked requests instead.
- Tools show their description, not "typically calls": core doesn't bind requests to tools.
- Vault items show their title only, not a masked username: the renderer never sees fields.
- Clients are shown as what they say they are, worded as claims, with one shared endpoint token, as
  core has it today; per-client tokens and scopes, remote access, Touch ID on confirmations and the
  IDE are not built. So the irreversible Approve button has no Touch ID glyph: it would promise a
  second factor that nothing enforces.
- The 1Password CLI path is chosen with a file dialog, not typed: the renderer never names a binary.
- The grant sheet's item list is a native radio group (arrow keys move the choice) rather than the
  mockup's listbox; the window behind the sheet is `inert` while it is open. There are no automated
  axe checks: no axe package is installed.
- The Woolworths example follows the live probe: login on Auth0 at `auth.woolworths.com.au`, six
  write/read tools and no irreversible tool (D18), so the confirmation shown is a `confirm()` from
  `remove_from_cart`.
- First-run setup puts 1Password before the clients and drops the mockup's Messages step: the
  order is AC2's (where logins come from, approve, grant) and then AC3's (connect Claude). Its
  approval and grant are the app's own review screen and grant sheet, opened from setup and
  returning to it, so setup can approve or grant nothing those screens wouldn't. Messages codes
  stay on the adapter's page. The mockup's 1Password pane describes a service account; Nick chose
  a Keychain copy of the item instead (D6), so that pane takes the 1Password account the Keychain
  copy reads from (the same field as in Settings) and lists any other provider this launch can use. Claude Code is set up through the
  bridge, like Claude Desktop, rather than over HTTP with a token on screen: tokens never reach the
  renderer (D42).
