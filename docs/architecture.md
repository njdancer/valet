# Architecture

Draft. The security rules this has to satisfy are in [security-model.md](security-model.md).
Much of this comes from an earlier private app, which already drives
a bank's site from Electron. Where we copy it or deliberately depart from it, this doc says so.

## Shape

- **The app is an Electron menu-bar app.** No dock icon (`LSUIElement`), a `Tray`, and
  `window-all-closed` doesn't quit. The tray menu is rebuilt on each click with
  `popUpContextMenu`. This is from the earlier app: `setContextMenu` shows a stale menu on macOS.
- **The runtime lives in the main process.** It owns the browser sessions, the credential
  provider, the audit log and the MCP endpoint.
- **Only two modules may import `electron`:** the app entry and the browser driver. An AST test
  enforces it, as in the earlier app. Everything else is plain TypeScript, tested in plain Node with
  fakes.
- **Adapter tool code runs in a `utilityProcess`.** It reaches the runtime only through the
  capability API over a message port. In v0 that's for structure, not security; the sandbox
  comes before third-party adapters.
- **The control panel (later)** is a renderer window: adapter list, run history, the audit log,
  and an IDE with an embedded `WebContentsView` for authoring.

## Browser driver

These come from what the earlier app learned against its bank:

- **Hidden but headed.** A `BrowserWindow({ show: false })` per run, never headless. Headless
  got fingerprinted; a hidden window didn't. For `needsUser`, the same window is shown.
- **One persistent partition per site and role:** `persist:auth:<site>` and
  `persist:tool:<site>`.
- **Primitives:** `navigate`, `evaluate`, `type` and `close`.
  - `evaluate` runs scripts with `executeJavaScriptInIsolatedWorld`. Only tool code may supply
    its own scripts.
  - `type` sends one `sendInputEvent({ type: 'char' })` per character with a gap, because sites
    time keystrokes.
  - `close` uses `destroy()`, so a page's `beforeunload` can't keep the window alive.
- **Tolerant navigation.** An `ERR_ABORTED` from `loadURL` (the page navigating itself again)
  waits for `did-stop-loading` instead of failing.
- **Timeouts and waits.** Every primitive is wrapped in a step timeout. Waits run in Node, never
  in the page, because navigation kills in-page timers.
- **User agent.** The earlier app never overrode Electron's UA, and the bank didn't object. Woolworths
  sits behind Akamai Bot Manager, so spike 1 tests both the default UA and a clean Chrome UA
  with matching client hints.

## Site API calls

Most tools should call the site's own JSON endpoints with `fetch(..., { credentials:
'same-origin' })` from inside a page in the tool partition. Cookies never leave the browser, and
Akamai's cookies stay with the client that earned them. This is how the earlier app searches the bank's
transactions and how `amasolov/woolworths-mcp` gets past Akamai.

For Woolworths:

| Purpose | Request |
|---|---|
| Read cart | `GET /apis/ui/Trolley` |
| Add, set or remove (quantity `0`) | `POST /api/v3/ui/trolley/update`, `{ items: [{ stockcode, quantity, … }] }` |
| Search | `/apis/ui/Search/products` |
| Product detail | `/apis/ui/product/detail/<stockcode>` |

These are from community code and still to be confirmed.

## Request surface

This comes from the earlier app's connector guard, generalised. A manifest declares:

- **hosts**: the egress allowlist for the tool partition, enforced in `webRequest`;
- **requests**: `{ method, path pattern, purpose: read | write | irreversible }` for the site's
  API. An in-page `fetch` from tool code that matches no entry is cancelled before it leaves.
  Runtime-wide deny patterns cover checkout, payment and payee paths. Unlocking one takes an
  `irreversible` declaration plus the person's confirmation;
- **a per-run ceiling** on requests.

## Credentials

The adapter only ever names a `secretRef`. The privileged filler in the runtime resolves it.
This is where we depart from the earlier app, whose connector code holds the plaintext password.

Credential providers, preferred first:

1. **A 1Password service account scoped to a dedicated vault**, e.g. "siteadapter".
   - It works unattended, which matters when an agent calls a tool while the Mac is locked.
   - It's scoped to one vault and revocable, and 1Password keeps its own usage log.
   - The token lives in the Keychain under a designated requirement pinned to the Team ID. This
     is the earlier app's signing trick, which keeps "Always Allow" grants across rebuilds.
   - Service accounts can't read personal vaults, so login items are moved or copied into that
     vault.
2. **`op read` at the moment of use**, through the 1Password desktop app's CLI integration.
   - No setup, but it needs 1Password unlocked plus Touch ID. When that isn't available, the
     run returns `needsUser`.
3. **Not:** copying secrets into the Keychain ahead of time, as the earlier app does. That's a
   second copy with its own lifecycle.

The Keychain is read asynchronously, with a bound on approval prompts. A hung Keychain approval
once froze the earlier app's main process for hours.

## Run hygiene

From the earlier app:

- **Pessimistic login classification:** `blocked` → `accepted` → `refused`, otherwise
  `ambiguous`. `ambiguous` counts against any lockout budget.
- **A durable attempt marker** for sites that lock out. It's written and fsynced before the
  submit, and cleared only once the outcome is classified, so a crash mid-login stops further
  attempts until the person clears it.
- **Errors carry a stage plus an allowlisted error class, never free text.** Page text can hold
  secrets or personal data.
- **One lock per adapter**, so two tool calls never drive the same session at once.

## MCP endpoint

- **Local:** Streamable HTTP on `127.0.0.1` with a bearer token, plus a bundled stdio bridge for
  clients that only speak stdio.
- **Remote access (later):** a relay connects to that same endpoint. In the meantime, document
  cloudflared and Tailscale.

## Packaging and updates

- **Build:** electron-builder, hardened runtime, Developer ID signing, and a designated
  requirement pinned to the Team ID.
- **Updates:** notarise, and auto-update with `electron-updater` from GitHub Releases. Squirrel.Mac
  requires a signed app.
- The earlier app never built its updater, so there's nothing to reuse.

## Testing

The earlier app's style:

- Vitest in plain Node, with no native addons.
- A fake page whose handlers answer `evaluate`.
- Real `node:http` fake servers on port 0 that record every request.
- An injected clock and `sleep`.

**Canary egress tests:**

- Seed unique canary secrets, run the real login and tool flow against a local fake site, and
  assert the canaries reach only the fake site's login POST. They must never reach tool output,
  traces, the audit log or any other host.
- Assert that the canaries were actually typed, so the test can't pass vacuously.

## Spikes before the framework

1. **Electron vs Woolworths.**
   - In a hidden-but-headed window in `persist:auth:woolworths`, the person logs in by hand.
     This is the `needsUser` path; the spike doesn't automate the real login.
   - Copy the cookies to `persist:tool:woolworths`. Then, from a page there, call
     `GET /apis/ui/Trolley` with an in-page `fetch`.
   - Try it with the default UA and with a clean Chrome UA. Record whether Akamai objects, and
     whether `_abck` survives the copy.
2. **Isolation of secret fills, against a local fake site.**
   - Tool code tries everything it can in the tool partition: a service worker, planted
     `localStorage`, input listeners, and a script that tries to exfiltrate to another host.
   - The declarative login then fills a canary from a fake provider.
   - Assert that the canary appears only in the fake site's login POST.

   This becomes the permanent egress test.
