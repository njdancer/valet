# Security model

Draft. Records what has been decided and what is still open.

## What we protect against

Adapter code is untrusted where secrets are concerned. Whether a person, an AI agent or a
marketplace author wrote it, the runtime must guarantee two things:

1. Adapter code never obtains a secret's value (password, one-time code).
2. Adapter code can't cause a secret, or a session that a secret produced, to reach anything
   outside the hosts its manifest declares.

Out of scope:

- The site itself, and the third-party scripts it loads. They see the password by design.
- The siteadapter host process. The main process is the trusted computing base.
- Malware already on the machine.

## Two kinds of action

An adapter defines two kinds of action, and they never share a browser session.

| | Auth action | Tool action |
|---|---|---|
| Purpose | Establish a logged-in session | Search, read an account, change the cart, … |
| Form | Declarative steps only | Declarative steps, or TypeScript code |
| Secrets | May fill secrets | Never |
| Adapter-authored JS in the page | Never | Allowed |
| Browser session | `auth:<site>` partition | `tool:<site>` partition |
| Exposed over MCP | No. It runs only on demand from a tool | Yes |

### Why pages aren't enough: separate partitions

Blocking code only after a secret has been filled isn't enough. Code that runs earlier in the
same document can attach listeners to the input. Code that runs anywhere on the same origin in
the same session can also:

- register a service worker that intercepts the login POST;
- poison the Cache API;
- plant `localStorage` values that the site's own scripts read later.

So the boundary is the Electron session partition, not the page:

- **`auth:<site>`** is persistent, so it keeps "remember this device" cookies and avoids
  repeated 2FA. Only the runtime's declarative interpreter ever drives it. The scripts it runs
  are its own, executed in an isolated world, with selectors passed in as JSON data. It never
  evaluates an adapter-supplied script. Selectors are data, not code.
- **`tool:<site>`** is where adapter code runs.

After a successful login, cookies for the manifest's domains are copied from `auth` to `tool`.
Copying only ever goes that way. Some sites keep their token in web storage instead. The manifest
can name the keys that hold it, and the runtime copies their values over CDP `DOMStorage`, read
from the auth side. Nothing ever flows from `tool` to `auth`, so storage, workers and listeners
from tool pages can't reach a page where a secret is typed.

### Auth action: the steps

The step vocabulary is closed. No step evaluates script.

- `goto(url)`: the URL must be on the manifest's navigation allowlist.
- `waitFor(selector | url pattern | text)`, with a timeout.
- `click(selector)`.
- `fill(selector, literal | secretRef)`.
- `otp(selector, source)`, where the source is a 1Password TOTP field, or a Messages sender plus
  a pattern.
- `when(condition) { steps }`: bounded branching for "remember this device?" prompts, consent
  walls and the like. There are no loops, only a bounded `retry`.
- `assertLoggedIn(probe)`.
- Every flow ends in one of three outcomes:
  - `ok`;
  - `needsUser(reason)`: the app shows the auth window to the person, for example for a CAPTCHA
    or an unexpected prompt. We never solve challenges automatically;
  - `failed(reason)`.

Before a secret fill, the runtime checks all of the following, and aborts the action if any of
them fails:

- The frame's security origin is exactly one of the origins in the person's grant for this
  secret. HTTPS only.
- The element's type suits the secret: `password` for passwords; `one-time-code`,
  `inputmode=numeric` or a text field for codes; email, text or tel for usernames.
- For a password, the owning form's action resolves to an allowed origin. This stops a password
  being typed into, say, the site's search box, where it would land in URLs, history and
  analytics.
- Every committed navigation in the auth partition is on the allowlist. If an open redirect
  leaves it, the action is aborted.

How a secret is filled:

- The value is fetched from 1Password just in time, in the main process. It's held in a
  `Buffer` that is zeroed afterwards.
- It's typed as paced `sendInputEvent` char events. These are trusted input. They're paced
  because sites time keystrokes; the earlier app found its bank does.
- It's never logged. Traces record `fill(#password, secret:woolworths.password)`.

### Grants are separate from manifests

A manifest *requests*, for example "secret `login` for origins `https://www.woolworths.com.au`".
The person *grants* it by binding a 1Password item to the request, for one adapter content hash.
A manifest can't name a 1Password item. If an adapter changes, it doesn't inherit a grant.

## Tool actions

- Tool code calls `session.ensure()`. The runtime runs the auth action's `assertLoggedIn` probe.
  If that fails, the runtime runs the auth action in the auth partition, syncs cookies, and
  returns `{ ok: true }` or the failure. Tool code never sees anything else.
- If the site asks for a password partway through a tool, the tool aborts. The runtime re-runs
  the auth action and retries the tool. Secrets are never filled in the tool partition, whatever
  the site asks.
- Tool code gets a capability object:
  - `page.goto/click/fill/extract/evaluate`;
  - `page.fetch`, made from inside the logged-in page, for the site's internal APIs;
  - `confirm()`;
  - `session.ensure()`.

  It gets no filesystem, no raw network and no secrets.
- **Egress allowlist.** Every request in the tool partition goes through
  `session.webRequest.onBeforeRequest` and must match a host declared in the manifest. This
  includes the site's own CDN and analytics, which the authoring agent picks up from a
  recording. Blocked requests are logged. WebRTC is disabled in the partition. This is what
  stops tool code sending the session cookie somewhere else.
- **Request surface.** On allowed hosts, calls to the site's API must also match a declared
  `{ method, path pattern, purpose }`. Runtime-wide deny patterns cover checkout, payment and
  payee paths. A per-run ceiling caps the number of requests. See
  [architecture.md](architecture.md#request-surface).
- **Output redaction.** The runtime knows every secret value and the current session cookie
  values. Exact matches are redacted from tool results and traces before they leave the process.
- **Side effects.** Every tool is declared `read`, `write` or `irreversible`. An `irreversible`
  tool, such as checkout or payment, needs the person's confirmation in the app. The MCP client
  can't give it.
- **Sandbox.** In v0, tool code runs in a utility process with the capability API over IPC.
  Before third-party adapters exist, it moves into a real sandbox (QuickJS-wasm or
  `isolated-vm`). Node's `vm` module is not a boundary.

## Approval and audit

- An adapter is a content-hashed bundle. Grants are keyed by that hash.
- Any change, including an AI repair, creates a new hash and needs re-approval with a diff.
  Additions to permissions are highlighted: new hosts, secrets, or write or irreversible tools.
- The audit log is append-only, hash-chained JSONL. It records logins, secret uses (secret,
  origin, adapter hash, the tool call that triggered it), tool calls along with the MCP client
  that made them, blocked egress, and confirmations.

## Personal Chrome profile mode (later)

This mode attaches to the person's real Chrome through a companion extension. Chrome 136 and
later refuse remote debugging on the default profile. In this mode there is one shared profile,
so the partition model can't hold. Secret fills are therefore unavailable in this mode. Adapters
can only reuse sessions the person already has.

## Open questions

- Side channels from the tool partition that `webRequest` doesn't see, such as DNS prefetch and
  `navigator.sendBeacon` timing. We need to check which Chromium switches close them.
- Whether bot-protection cookies (Akamai `_abck`) stay valid after copying from `auth` to `tool`.
  Both partitions have the same engine and UA, so they should, but spike 1 must confirm it.
- Step-up auth flows that only exist inside a page, with no separate login URL.
