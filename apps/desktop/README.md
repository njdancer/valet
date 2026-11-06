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
    registry.ts            bundle hashes, and the last approved manifest of each adapter
    constants.ts           names and numbers decided once (Keychain, vault, timeouts, file paths)
    settings, clients, run-memory, files, launch, geometry, snippets, demo, zod
  electron/                the Electron glue: app, windows, tray, ipcMain, demo site, probe fallback
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
screens/                   committed screenshots, light and dark
```

## Running it

```bash
mise exec -- pnpm --filter @siteadapter/desktop demo        # build, then launch against the local fake
mise exec -- pnpm --filter @siteadapter/desktop dev         # electron-vite dev
mise exec -- pnpm --filter @siteadapter/desktop build       # main, preload and renderer to out/
mise exec -- pnpm --filter @siteadapter/desktop start       # launch what build made
mise exec -- pnpm --filter @siteadapter/desktop test:smoke  # build, then the Playwright smoke test
mise exec -- pnpm --filter @siteadapter/desktop exec vite   # the renderer alone, on the fake API
mise exec -- node apps/desktop/src/renderer/dev/screenshot.mjs      # every screen to screens/
mise exec -- pnpm exec tsc --noEmit -p apps/desktop
mise exec -- pnpm vitest run --project desktop --coverage.enabled --coverage.include='src/**'
```

`vite` and `electron-vite` are dependencies of this package only, so they run through `--filter` (or
from `apps/desktop`). Electron's binary must be in `node_modules/electron/dist`; after an offline
install run `node install.js` in the electron package once (it is cached in `~/Library/Caches/electron`).

### Demo mode

`SITEADAPTER_DEMO=1` (or `--demo`) runs the whole app against `fakes/woolworths-site`, with no real
account anywhere:

- its own userData, `~/Library/Application Support/siteadapter-demo`;
- the fake site in-process over TLS on `www.woolworths.test` and `auth.woolworths.test` (a fresh
  certificate from `openssl` each launch), mapped to 127.0.0.1 by a host resolver rule appended
  before ready. That certificate is trusted for exactly those two hosts, on exactly the adapter's two
  partitions; everything else keeps Chromium's own verification;
- the adapter built with `createManifest({ origin, authOrigin })` for the fake's origins, which gives
  it a hash of its own, so a demo approval never stands for the real site;
- the test credential provider holding the fake's two-factor account (`twofactor@example.test`) as
  the item “Woolworths (demo account)”, and SMS codes read from the fake's outbox in place of
  Messages. Real 1Password and Messages are off;
- a DEMO badge: the tray's menu-bar title, the popover and the control panel's sidebar.

To try it: approve Woolworths in the control panel, grant `login` from “Woolworths (demo account)”
and Messages codes from `Woolworths`, then add the client from the snippet in Settings (it names the
server `siteadapter-demo` and points at the demo's `bridge.json`). `search_products` needs no login;
the first cart tool logs in (email, password, SMS code) in the hidden auth window.

### For the end-to-end suite

- `SITEADAPTER_USER_DATA=/abs/dir` uses that directory as userData (a relative path is ignored).
- `SITEADAPTER_E2E=1` only makes window titles deterministic, and sets the same text as the document
  title: `siteadapter (demo) [control]`, `siteadapter menu [tray]`, `siteadapter: confirm
  [<confirmation id>]`, `siteadapter: sign in [<adapter id>]`. It exposes nothing else.
- The control panel opens at launch on first run (something waits for review), in demo mode and in
  e2e mode.

In a plain browser there is no preload, so `boot.tsx` loads the fake API. The import sits behind
`import.meta.env.DEV` at the import site, so a production build drops it: `test/build.test.ts` builds
the renderer and checks no fake chunk or fixture data is emitted. Without a preload a production
page shows an error.

The whole app typechecks through `apps/desktop/tsconfig.json` (DOM and JSX for the renderer, Node
and Electron types for the rest); the root tsconfig stays Node-only. `zod` isn't a dependency of this
package yet, so `tsconfig.json`, `vitest.config.ts` and `electron.vite.config.ts` alias it to core's
copy (`src/main/core/zod.ts` says why); the aliases go when it is added.

Vitest 5 resolves `--coverage.include` against the project's root (`apps/desktop`), so the include
is `src/**`, not `apps/desktop/src/**`. `src/renderer/dev/**` (the fake) is excluded from coverage,
and `src/main/electron/**` and the two entry files carry `v8 ignore`: they are Electron glue, covered
by the smoke test and the e2e suite. The main-process tests start with `@vitest-environment node`.

## The main process

- **Process model.** Main owns everything privileged; renderer windows are views. Each is sandboxed,
  with context isolation, no Node, the preload only and devtools only unpackaged, and may show only
  `index.html` or `tray.html` of the app's own renderer (the build's files, or the dev server):
  navigation, redirects, webviews and `window.open` are refused, and the default session (which only
  our windows use) cancels every request outside the renderer and grants no permission.
- **IPC.** One `invoke` channel per API method, `siteadapter:<method>`, and one event channel,
  `siteadapter:event`. Every request must come from the main frame of one of the app's windows (by
  the role the main process gave the window when it opened it), on one of the app's pages, and its
  arguments must parse with the channel's zod schema: strict objects (so `__proto__`, `constructor`
  or any extra key is refused), bounded strings, exact ids and hashes, no extra arguments. Anything
  refused or failed rejects with one fixed message. Events cross as `{ type }` (and `seq`) only.
- **Data**, owner-only under userData: `grants.json` (credentials' FileGrantStore),
  `grant-items.json` (item titles to show), `approvals.json`, `approved-manifests.json` (what was
  last approved, for diffs), `audit.jsonl`, `breakers.json`, `settings.json`, `clients.json`,
  `endpoint.json` (when the token was last rotated), `bridge.json` (port and token, 0600) and
  `login-markers/`.
- **Adapters.** Built-in only. A hash is `bundleHash` over the adapter's source files, embedded by
  the bundler from the same files it compiles, plus the effective manifest. A hash nobody approved
  waits for review and runs nothing; `approvals.approve` refuses any hash but the installed one. A
  changed hash is reviewed as a diff against the last approved manifest and source, and has no
  grants until they are made again.
- **Credentials**, by `grant.provider`: the service account (`KeychainTokenSource`; service
  `siteadapter`, account `onepassword-service-account`, vault `siteadapter`, in `core/constants.ts`,
  pending D6/D43); `op`, only at a path that passed the checks; Messages, only while its setting is
  on; the test provider in demo mode only. The op checks: absolute; the file (after symlinks) and
  every directory above it, and above the link, owned by root or the person and not writable by
  group or others; and `codesign --verify` against 1Password's Team ID. A chosen path that fails is
  refused and the old one kept; with none chosen, the usual places get the same checks. Never PATH.
- **Grants** are checked against the installed hash's manifest (`core/grants.ts`): exact hash, an
  available provider, a requested secret or a declared Messages sender character for character,
  origins a non-empty subset of the request, and an item the provider lists now (stored by id, as
  `op://siteadapter/<id>`). `grant-made` and `grant-revoked` are audited before the store changes.
- **Runtime.** One `ToolHost` with each adapter on its own `createElectronSessionDriver`. The
  `AuthRunner` runs `runAuthFlow` on the driver's auth page with the grant store, the providers, the
  OTP reader, probe hooks over `AuthPage.fetch`/`cookieNames`, `rememberSecret` wired to the
  runtime's `registerForRedaction`, and Akamai's page as `isBlockedPage`; it writes no login events.
  On `needsUser` the auth window stays open with the banner above it and the call returns at once
  (D50); the window closes after 15 minutes. `finishLogin` probes the auth partition and hands off
  only if that passes, then clears the login hold.
- **Confirmations.** `ctx.confirm()`, and the runtime's own question before an irreversible tool,
  open a floating, always-on-top panel, shown inactive with `acceptFirstMouse: false`. An approval
  counts only from that window, at least `CONFIRM_ARM_MS` after it was last shown or focused, and
  before it expires; a decline is taken from any app window. Unanswered, it declines itself after two
  minutes (D50), the runtime's deadline too.
- **MCP.** `startEndpoint` with a stable port and a token kept until reset (D41), over a
  `ToolCaller` that caches the runtime's async listing and refreshes it when approvals change. Paused
  calls are `blocked` before they reach the runtime. Snippets launch the stdio bridge from the repo
  with `tsx` until packaging bundles it.
- **Updates.** `startUpdates()` in `electron/app.ts` is the one call site, a no-op until
  `src/main/updater` (another unit) is wired in.

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
- `AdapterDetail.handedOver` is always null: the driver doesn't report hand-off counts.
- `RunTrace` has no probe or allowed-request steps (the runtime doesn't audit them), and input and
  output previews are kept in memory for the last 200 calls only.
- `AppStatus.demo` is new: it drives the DEMO badge.

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
