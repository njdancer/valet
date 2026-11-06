# @siteadapter/desktop

The menu-bar app: the Electron main process that wires every package together, the preload that
exposes [`src/shared/api.ts`](src/shared/api.ts) as `window.siteadapter`, and the renderer (the
control panel, the tray popover, the confirmation panel and the login hand-off banner, in React 19
and plain CSS built from [docs/mockups](../../docs/mockups)).

```
src/shared/api.ts          the window.siteadapter contract (types only)
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
    caller.ts              the MCP endpoint's ToolCaller over ToolHost
    adapter-gate.ts        keeps the person's login work and tool calls on an adapter apart
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
mise exec -- pnpm --filter @siteadapter/desktop demo        # a demo build, launched against the local fake
mise exec -- pnpm --filter @siteadapter/desktop dev         # electron-vite dev (demo mode available)
mise exec -- pnpm --filter @siteadapter/desktop build       # main, preload and renderer to out/, no demo mode
mise exec -- pnpm --filter @siteadapter/desktop start       # launch what build made
mise exec -- pnpm --filter @siteadapter/desktop test:smoke  # a demo build, then the Playwright smoke test
mise exec -- pnpm --filter @siteadapter/desktop test:e2e    # a demo build, then the end-to-end suite (e2e/)
mise exec -- pnpm --filter @siteadapter/desktop screens:live # a demo build, then screens/live/ from the real app
mise exec -- pnpm --filter @siteadapter/desktop package     # a plain build, then dist/: siteadapter-dev.app and its zip
mise exec -- pnpm --filter @siteadapter/desktop package:smoke # a plain build, packaged and launched (see Packaging)
mise exec -- pnpm --filter @siteadapter/desktop exec vite   # the renderer alone, on the fake API
mise exec -- node apps/desktop/src/renderer/dev/screenshot.mjs      # every screen to screens/
mise exec -- pnpm exec tsc --noEmit -p apps/desktop                    # renderer (DOM), tests
mise exec -- pnpm exec tsc --noEmit -p apps/desktop/tsconfig.node.json # main and preload (Node)
mise exec -- pnpm vitest run --project desktop --coverage.enabled --coverage.include='src/**'
```

`vite` and `electron-vite` are dependencies of this package only, so they run through `--filter` (or
from `apps/desktop`). Electron's binary must be in `node_modules/electron/dist`; after an offline
install run `node install.js` in the electron package once (it is cached in `~/Library/Caches/electron`).

### Demo mode

`SITEADAPTER_DEMO=1` (or `--demo`) runs the whole app against `fakes/woolworths-site`, with no real
account anywhere. Only a development build has it: `electron-vite dev`, or `electron-vite build
--mode demo` (what the `demo` and `test:smoke` scripts run). A plain `build`, which packaging uses,
sets `__SITEADAPTER_DEMO_BUILD__` to false (`src/main/build-flags.d.ts`), so the demo chunk, the fake
site, its certificate generator, its fixtures and the test account aren't in `out/main` at all; and a
packaged app ignores both switches whatever the build. In demo mode:

- its own userData, `~/Library/Application Support/siteadapter-demo`; `SITEADAPTER_USER_DATA` can
  move it, but never to the real `siteadapter` folder or anything inside it;
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
- the adapter's two partitions emptied at every launch: the fake keeps its visitors, Akamai sensor
  cookies and Auth0 sessions in memory for one launch, so a stale `_abck` from the last one was
  refused as a bot and the breaker paused the site for ten minutes. Every demo launch logs in again.

To try it: approve Woolworths in the control panel, grant `login` from “Woolworths (demo account)”
and Messages codes from `Woolworths`, then add the client from the snippet in Settings (it names the
server `siteadapter-demo` and points at the demo's `bridge.json`). `search_products` needs no login;
the first cart tool logs in (email, password, SMS code) in the hidden auth window.

### For the end-to-end suite

- `SITEADAPTER_USER_DATA=/abs/dir` uses that directory as userData (a relative path is ignored). A
  packaged app ignores it.
- `SITEADAPTER_E2E=1` only makes window titles deterministic, and sets the same text as the document
  title: `siteadapter (demo) [control]`, `siteadapter menu [tray]`, `siteadapter: confirm
  [<confirmation id>]`, `siteadapter: sign in [<adapter id>]`. Outside a demo launch it exposes
  nothing else; in one, see the e2e-only switches below.
- The control panel opens at launch on first run (something waits for review), in demo mode and in
  e2e mode.
- **E2e-only, and only in a demo build** (the demo chunk, which a production build doesn't carry):
  in an e2e launch, `evil.test` is mapped to 127.0.0.1 alongside the demo hosts (the egress canary
  runs the fake's exfil sink there, so a request the app let out would arrive rather than fail to
  resolve), and the main process's global `__siteadapterE2e` holds two calls on the fake site for
  Playwright's `app.evaluate`: `blockAll(on)` and `trolley()` (the demo account's lines). No renderer
  can reach the main process's globals.

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
- `egress.spec.ts`: the canary (proven live first, through Chromium's own stack), then a hostile
  page script in the tool partition beaconing the page's cookies to `evil.test` every 200 ms by
  beacon, fetch, image and WebSocket: nothing connects, and every attempt is audited
  `request-blocked`, initiator `page`, partition `tool`, origin only: those during a run with its
  call id (the runtime's), those between runs with none (the app's).
- `update.spec.ts`: a copy of the build with a changed Woolworths bundle (`remove_from_cart` made
  irreversible, in the compiled manifest and the embedded source alike: `changedAdapterBuild()` in
  `e2e/harness.ts`). A plain restart keeps approval and grants; the changed one waits for review with
  a diff, its tools off MCP and no grants; approved and granted again it works, and the confirmation
  panel's Decline reaches the client as `declined`, its Approve (only from that panel) runs the tool.
- `screens.spec.ts`: `screens/live/`, light, 1440x900 at scale 2. Skipped unless
  `SITEADAPTER_E2E_SCREENS=1` (the `screens:live` script), since it rewrites committed files.

The MCP SDK is a devDependency here, for the harness's client. Every spec closes its app, and a
global teardown kills any process still running this worktree's Electron binary, never another
app's.

In a plain browser there is no preload, so `boot.tsx` loads the fake API. The import sits behind
`import.meta.env.DEV` at the import site, so a production build drops it: `test/build.test.ts` builds
the renderer and checks no fake chunk or fixture data is emitted. Without a preload a production
page shows an error.

`ELECTRON_RENDERER_URL` (the dev server) is trusted only by a bundle `electron-vite dev` built
(`__SITEADAPTER_DEV_SERVER__`), never packaged, and only as an `http://localhost` or
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
`CSC_IDENTITY_AUTO_DISCOVERY=false` and none of the caller's `CSC_*`, `APPLE_*` or `SITEADAPTER_*`
variables but `SITEADAPTER_UPDATE_URL`; the fuse flip re-signs the bundle ad hoc. Electron comes
from the installed copy, cloned without `default_app.asar`. Release builds are the release
script's job ([docs/release-and-updates.md](../../docs/release-and-updates.md)).

What the package carries (`files` in the config): `out/main`, `out/preload`, `out/renderer`,
`package.json` (its `main` is `out/main/index.js`), and from `node_modules` only what the main
bundle keeps external, `@1password/sdk` and `@1password/sdk-core` (`PACKAGED_NODE_MODULES`). Every
workspace package and npm dependency is bundled into `out/main`. No source maps. The main and
preload builds empty their output first, so a demo build's chunk and fixtures never reach a plain
one.

`package:smoke` runs a plain build, then `scripts/package-smoke.mjs`, which packages twice in a
temporary directory and deletes everything afterwards (`--keep` keeps it):

1. A placeholder app (`scripts/smoke/main.cjs`), for the checks that need code of its own: the fuse
   wire, the asar and Info.plist, `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` and `--inspect` refused, a
   tampered asar and an `app/` folder refused, the renderer's module script running from `app://`
   but not from `loadFile`, and a launch under a temporary `HOME` that must move
   `app.getPath('appData')` and `userData` under it.
2. The real app from the real `out/` (`scripts/smoke/real-app.mjs`): Info.plist, the fuse wire, and
   an asar holding only the build and the SDK (no demo chunk, fixtures or maps). Then it is launched
   under a temporary `HOME` (and `CFFIXED_USER_HOME`), with Chromium's mock keychain, a host
   resolver that resolves nothing but loopback, and `--remote-debugging-port=0`. Over the DevTools
   protocol it must show the control panel on `app://renderer/index.html` with Woolworths waiting
   for review, the preload's API and no Node. Then it quits through its own quit path, its data
   must be under the temporary `HOME`, and the real `~/Library/Application Support/siteadapter`
   and `siteadapter-dev` must be as they were. It doesn't launch at all unless step 1 showed the
   temporary `HOME` moving the data. Playwright can't drive it: its Electron launcher needs
   `--inspect`, which the fuses turn off.

## The main process

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
- **IPC.** One `invoke` channel per API method, `siteadapter:<method>`, and one event channel,
  `siteadapter:event`. Every request must come from the main frame of one of the app's windows (by
  the role the main process gave the window when it opened it), on one of the app's pages, and its
  arguments must parse with the channel's zod schema: strict objects (so `__proto__`, `constructor`
  or any extra key is refused), bounded strings, exact ids and hashes, no extra arguments. Anything
  refused or failed rejects with one fixed message. Events cross as `{ type }` (and `seq`) only.
- **Data**, owner-only under userData: `grants.json` (credentials' FileGrantStore),
  `grant-items.json` (item titles to show), `approvals.json`, `approved-manifests.json` (what was
  last approved, for diffs), `audit.jsonl`, `breakers.json`, `settings.json`, `clients.json`,
  `endpoint.json` (when the token was last rotated), `bridge.json` (port and token, 0600),
  `versions.json` (the last and highest versions run) and `login-markers/`. userData is
  `~/Library/Application Support/<app name>`: `siteadapter` for a release and for an unpackaged run,
  `siteadapter-dev` for a development package, so the two never share data.
- **Adapters.** Built-in only. A hash is `bundleHash` over the adapter's source files, embedded by
  the bundler from the same files it compiles, plus the effective manifest. A hash nobody approved
  waits for review and runs nothing; `approvals.approve` refuses any hash but the installed one. A
  changed hash is reviewed as a diff against the last approved manifest and source, and has no
  grants until they are made again.
- **Credentials**, by `grant.provider`: the service account (`KeychainTokenSource`; service
  `siteadapter`, account `onepassword-service-account`, vault `siteadapter`, in `core/constants.ts`,
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
  - **The service account shows as not installed** (`unavailableReason: 'not-installed'`, without
    asking the Keychain), because the app can't list the vault's items through the SDK yet, so
    `checkGrantRequest` would refuse every grant (`SERVICE_ACCOUNT_LISTS_ITEMS`, false). The SDK
    itself now resolves: `@1password/sdk` is a dependency of this package, external to the main
    bundle, so `out/main` finds it in `node_modules`, and the package ships it (with
    `@1password/sdk-core` and its wasm) in `app.asar`.
- **Grants** are checked against the installed hash's manifest (`core/grants.ts`): exact hash, an
  available provider, a requested secret or a declared Messages sender character for character,
  origins a non-empty subset of the request, and an item the provider lists now (stored by id, as
  `op://siteadapter/<id>`). `grant-made` and `grant-revoked` are audited before the store changes.
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
  clones, as the runtime does); if the session values can't be read the target is `[redacted]`.
  During a run the runtime audits the tool partition's refusals itself.
  On `needsUser` the auth window stays open with the banner above it and the call returns at once
  (D50); the window closes after 15 minutes. `finishLogin` probes the auth partition and hands off
  only if that passes, then clears the login hold.
- **The person's own login work** (`openLoginWindow`, `finishLogin`) is refused while the site's
  circuit breaker is open (`health.sites()`), and runs through `AdapterGate`: it waits, up to 30
  seconds, until no tool call is in flight and no run is open on the driver (the runtime gets a
  tracked driver, so a run the runtime keeps open after its call returned counts too), and calls
  that arrive meanwhile wait for it. So a hand-off never copies the session into the tool partition
  in the middle of another call's run. A login window the person opens themselves
  (`NeedsUserItem.startedBy: 'person'`) leaves the session's state alone if they give up, and the
  banner says they opened it rather than blaming the granted secrets.
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
  runtime's async listing and refreshes it when approvals change. The app's own refusals never
  reach the runtime but are audited like a call (`tool-called`, then `tool-finished` with outcome
  `failed`): while paused, `config: unavailable` (not a rate limit: the site isn't involved); under
  a revoked client name, `config: not-granted`. The runtime never reports stage `config` for a
  call, so the log tells them apart. Snippets launch the stdio bridge from the repo with `tsx` until
  packaging bundles it.
- **Updates.** The feed is compiled in: a plain `electron-vite build` whose environment names both
  `SITEADAPTER_UPDATE_URL` (https, a public host, a directory) and `SITEADAPTER_FEED_PUBLIC_KEY_FILE`
  (the feed key's SPKI PEM) defines `__SITEADAPTER_FEED_BASE_URL__` and
  `__SITEADAPTER_FEED_PUBLIC_KEY__` (`core/feed-defines.ts`); one without the other, or a feed that
  isn't public https, fails the build. Dev and demo builds never have one. At launch, before any
  adapter, credential or endpoint, the service records the version in `versions.json` (writing
  `update-installed` `{ from, to }` on the first launch of a newer version) and builds the updates
  (`core/updates.ts`, `electron/updates.ts`). The updater is on only for a packaged, non-demo build
  with a feed and a Developer ID signature (`codesign -dv` on the running bundle); otherwise
  `updates.status` is `disabled` with the reason (`not-configured`, `development`, `unsigned`) and
  nothing contacts a feed. When on: `confineUpdaterSession` on the `electron-updater` partition,
  `createUpdater` with the signed feed, the channel and install-on-quit read from the settings at
  every check, the highest version run as the floor, and a check at launch and every six hours.
  `update-downloaded` `{ from, to }` is audited once per verified download. PATH is set to the
  system default first (electron-updater runs `uname` and `sysctl` by name).

### Where the main process departs from the contract below

- `settings.set` with a key outside `SettingsPatch`, `opPath` included, is refused as a whole rather
  than the key dropped: every channel refuses unknown keys.
- `clients.revoke` refuses calls made under that reported name. Every client shares one token, so
  this stops an honest client only; rotating the token is the real control.
- `ClientInfo.transport` and `ConfirmationItem.clientTransport` are always `http`: the bridge
  reaches the endpoint over HTTP too, and the endpoint doesn't say which sessions are bridged.
- `EndpointStatus.connectedClients` counts clients that called in the last ten minutes; the
  endpoint doesn't report live sessions.
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
  when the app quits. Settings have no switch for automatic checks.
- `AppStatus.demo` is new: it drives the DEMO badge.
- `NeedsUserItem.startedBy` is new: `'person'` for a login window opened from the app.

## The contract for the main process and preload

The preload exposes one object as `window.siteadapter`, typed `SiteAdapterApi`. Every method is
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
- **Adapter text is attributed.** Manifest descriptions and notes, and the `confirm()` message
  (`ConfirmationItem.adapterNote`), are shown as plain React text, quoted, labelled "From the
  manifest" or "Shown by the … adapter", and cut to a fixed length. Everything else on the
  confirmation panel must come from the runtime's own knowledge.
- **Client names are claims.** Every client shares one token, so `client`/`reportedName` is only what
  a client said in MCP initialize. Screens word it as "a client calling itself “Claude Code”" (or
  quote it with an "unverified" title), strip control and bidi characters, and cut unknown names to
  40 characters. `ConfirmationItem.clientTransport` is the transport the runtime itself saw.
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
