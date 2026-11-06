# @siteadapter/desktop

The menu-bar app. This round has the renderer only: the control panel window, the tray popover,
the confirmation panel and the login hand-off banner, in React 19 and plain CSS built from
[docs/mockups](../../docs/mockups). The Electron main process and preload come next; they
implement the contract in [`src/shared/api.ts`](src/shared/api.ts).

```
src/shared/api.ts          the window.siteadapter contract (types only)
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
  lib/router.ts            routes, including the ones the main process opens
  dev/fake-api.ts          in-memory API with Woolworths data, for vite dev and tests
  dev/screenshot.mjs       renders every screen to screens/ for comparison with the mockups
  styles/                  tokens.css and app.css from the mockups, plus controls.css and screens.css
screens/                   committed screenshots, light and dark
```

## Running it

```bash
mise exec -- pnpm --filter @siteadapter/desktop exec vite        # http://127.0.0.1:5194/
mise exec -- node apps/desktop/src/renderer/dev/screenshot.mjs      # every screen to screens/
mise exec -- pnpm exec tsc --noEmit -p apps/desktop                 # the renderer's own typecheck
mise exec -- pnpm vitest run --project desktop --coverage.enabled --coverage.include='src/**'
```

`vite` is a dependency of this package only, so it runs through `--filter` (or from `apps/desktop`).

In a plain browser there is no preload, so `boot.tsx` loads the fake API. The import sits behind
`import.meta.env.DEV` at the import site, so a production build drops it: `test/build.test.ts` builds
the renderer and checks no fake chunk or fixture data is emitted. Without a preload a production
page shows an error.

The renderer typechecks with DOM and JSX through `apps/desktop/tsconfig.json`; the root tsconfig
stays Node-only, so the root `typecheck` script doesn't cover the renderer yet (it needs
`tsc --noEmit -p apps/desktop` added).

Vitest 5 resolves `--coverage.include` against the project's root (`apps/desktop`), so the include
is `src/**`, not `apps/desktop/src/**`. `src/renderer/dev/**` (the fake) is excluded from coverage.

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
