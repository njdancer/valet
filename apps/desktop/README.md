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
mise exec -- pnpm exec vite --config apps/desktop/vite.config.ts   # http://127.0.0.1:5194/
mise exec -- node apps/desktop/src/renderer/dev/screenshot.mjs      # every screen to screens/
mise exec -- pnpm vitest run --project desktop --coverage.enabled --coverage.include='src/**'
```

In a plain browser there is no preload, so `boot.tsx` loads the fake API (`import.meta.env.DEV`
only). A production bundle never contains the fake: without a preload it shows an error.

Vitest 5 resolves `--coverage.include` against the project's root (`apps/desktop`), so the include
is `src/**`, not `apps/desktop/src/**`.

## The contract for the main process and preload

The preload exposes one object as `window.siteadapter`, typed `SiteAdapterApi`. Every method is
async and takes and returns plain JSON. `onEvent(listener)` returns an unsubscribe; events carry no
data, only which part changed, and the renderer refetches.

What the main process must hold to, because the renderer relies on it:

- **No secret ever crosses.** No secret value, 1Password item reference or field, session cookie or
  storage value, or endpoint token. Grants come back with the item's title only; vault items as
  `{ id, title }`; tool input and output as `PreviewPart[]`, already redacted, with markers where
  values were removed. Client setup snippets point at the bridge, which reads the token from its
  own 0600 file. Copying goes through the main process (`endpoint.copyUrl`,
  `endpoint.copyClientConfig`, `app.copyText`), so the renderer never needs the clipboard or the
  token. A test feeds every screen an API that leaks extra fields and checks none reach the DOM,
  but the guarantee is the main process's.
- **Codes, not text.** Reasons, stages and error classes are core's codes; the renderer words them
  in `lib/wording.ts` and never shows an unknown code's text. A rejected promise's message is never
  shown either: every failure reads "Couldn’t … Try again.".
- **Adapter text is attributed.** Manifest descriptions and notes, and the `confirm()` message
  (`ConfirmationItem.adapterNote`), are shown as plain React text, marked as the adapter's and
  unverified. Everything else on the confirmation panel must come from the runtime's own knowledge.
- **Re-check every action.** The renderer only offers what it should; the main process enforces it.
  `approvals.approve(adapterId, hash)` must refuse if that hash is no longer the pending one.
  `grants.make` must refuse origins outside the manifest's request for that exact hash (for
  `messages`, the manifest's navigation origins) and an `itemRef` that isn't a vault item id or the
  declared sender. `answerConfirmation` must refuse an id that has expired or been answered.
- **Windows.** Every renderer window: `contextIsolation: true`, `sandbox: true`,
  `nodeIntegration: false`, and the CSP `vite.config.ts` writes into built pages
  (`default-src 'none'; script-src 'self'; …`). The title bar is hidden-inset; the sidebar and
  title bar are drag regions.

Routes the main process opens (`lib/router.ts`):

| Route                       | Where                                                                      |
| --------------------------- | -------------------------------------------------------------------------- |
| `#/adapters`, `#/activity`… | The control panel window, `index.html`                                     |
| `#/adapters/<id>/review`    | Review of a pending bundle, full window (no sidebar)                       |
| `#/adapters/<id>/grant/<s>` | Grant sheet over the adapter page; `<s>` = `messages` for SMS codes        |
| `#/confirm/<id>`            | Its own small window, in front, for a pending confirmation                 |
| `#/needs-user/<adapterId>`  | A view above the auth window's web view: the hand-off banner and status bar |
| `tray.html`                 | The tray popover window (400 px wide, transparent background)              |

## What differs from the mockups, and why

- No fake system menu bar, wallpaper or traffic lights: macOS draws the real ones.
- Rate budgets per hour aren't in core (only `minGapMs` and cool-downs), so the home page shows
  today's calls, logins and blocked requests instead.
- Tools show their description, not "typically calls": core doesn't bind requests to tools.
- Vault items show their title only, not a masked username: the renderer never sees fields.
- Clients are shown as what they say they are, with one shared endpoint token, as core has it today;
  per-client tokens and scopes, remote access, Touch ID on confirmations and the IDE are not built.
- The Woolworths example follows the live probe: login on Auth0 at `auth.woolworths.com.au`, six
  write/read tools and no irreversible tool (D18), so the confirmation shown is a `confirm()` from
  `remove_from_cart`.
