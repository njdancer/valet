# Security model

Draft, updated for core contracts v2. Records what has been decided, what code enforces today,
and what is still open.

## How to read the status marks

Each guarantee below carries one of these:

- **Enforced:** built and tested in the round-1 packages merged on `main`, against fakes and,
  for the browser driver, in the Electron end-to-end suite.
- **Contract:** in `packages/core` as of core v2. The other packages are adopting it in round 2,
  so on `main` the behaviour may be partly there under another name, or missing.
- **Designed:** decided here, not built.
- **Open:** not decided. The decisions live in [plan.md](plan.md#decisions).

Nothing is wired end to end yet. Each package is tested on its own against `core` and fakes; the
desktop app that connects the runtime, the auth flow, the credential providers, the browser
driver and the MCP endpoint doesn't exist. "Enforced" means the module that owns the guarantee
enforces it, not that a shipped app does.

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

**v0 caveat.** Tool code is imported into the main process today. It has no sandbox, not even a
separate process, so a hostile adapter's tool code could import `node:fs` or open a socket and
step around everything in this document. The guarantees hold against tool code that only uses
its capability object. That is why no third-party adapter installs before the sandbox (M7,
[D12](plan.md#d12-sandbox-technology)). The guards are built now so that the sandbox only has to
take away ambient authority, not add checks.

## Two kinds of action

An adapter defines two kinds of action, and they never share a browser session.

|                                 | Auth action                            | Tool action                                 |
| ------------------------------- | -------------------------------------- | ------------------------------------------- |
| Purpose                         | Establish a logged-in session          | Search, read an account, change the cart, … |
| Form                            | Declarative steps only                 | TypeScript code (declarative form later)    |
| Secrets                         | May fill secrets                       | Never                                       |
| Adapter-authored JS in the page | Never                                  | Allowed, in its own isolated world          |
| Browser session                 | `persist:auth:<adapter>` partition     | `persist:tool:<adapter>` partition          |
| Exposed over MCP                | No. It runs only on demand from a tool | Yes                                         |

### Why pages aren't enough: separate partitions

Blocking code only after a secret has been filled isn't enough. Code that runs earlier in the
same document can attach listeners to the input. Code that runs anywhere on the same origin in
the same session can also:

- register a service worker that intercepts the login POST;
- poison the Cache API;
- plant `localStorage` values that the site's own scripts read later.

So the boundary is the Electron session partition, not the page (**Enforced**):

- **`auth`** is persistent, so it keeps "remember this device" cookies and avoids repeated 2FA.
  Only the runtime's declarative interpreter ever drives it. The scripts it runs are the
  driver's own fixed functions, with selectors passed in as JSON data. It never evaluates an
  adapter-supplied script.
- **`tool`** is where adapter code runs. `evaluate()` source runs in isolated world 1001; the
  driver's own fetch, extract and storage scripts run in world 1000, so adapter code can't patch
  the `fetch`, `JSON` or `Storage` they use.

After a successful login, cookies for the manifest's `session.cookieDomains` are copied from
`auth` to `tool`, and so are the values of any web-storage keys the manifest names. Copying only
ever goes that way. Nothing flows from `tool` to `auth`, so storage, workers and listeners from
tool pages can't reach a page where a secret is typed.

The identity provider's own session stays in `auth`. For Woolworths, login is Auth0 on
`https://auth.woolworths.com.au` and `cookieDomains` covers www only, so the Auth0 cookie never
reaches the tool partition, and the tool partition's egress doesn't include the auth host. That
Auth0 session is also what makes a silent re-login possible: when only the www session has
expired, Auth0 redirects straight back and no secret is filled.

## Auth action

### The steps

The step vocabulary is closed. No step evaluates script. (**Enforced**, with the v2 names a
**Contract**.)

- `goto(url)`: https, and on the manifest's `navigation` list.
- `waitFor(condition, timeoutMs)`.
- `click(selector)`.
- `fill(selector, literal | secretRef)`.
- `otp(selector, source)`: the source is a 1Password one-time-password field, or a Messages
  sender plus a pattern.
- `pause(ms)`, at most 30 s.
- `when(condition) { steps } otherwise { steps }`: bounded branching for "remember this
  device?" prompts, consent walls and the like. There are no loops, only a bounded
  `retry(times)` (1 to 5).
- `assertLoggedIn`: runs the manifest's probe against the auth partition, before any handoff.
- `needsUser { reason, note? }` and `fail { errorClass, note? }`.

Conditions are `visible(selector)`, `textPresent(text)`, `urlContains(text)`, `urlRegex(pattern)`,
and `not`, `any` and `all` over them. Both URL conditions look at the path and query only, never
the host: the host is the navigation guard's job.

Every flow ends in one of four outcomes:

- `ok`;
- `needsUser(reason)`: the app shows the auth window to the person. We never solve challenges
  automatically;
- `failed(stage, errorClass)`;
- `blocked`: the site refused us, which opens the site's circuit breaker.

### Reason codes, not text

Anything that crosses to an MCP client is a code from a fixed vocabulary (**Contract**):

- `needsUser` reasons: `login-required`, `otp-required`, `captcha`, `account-locked`,
  `terms-update`, `site-changed`, `login-attempt-pending`, `other`.
- A `fail` step may only end with `auth-failed`, `blocked-by-site`, `not-logged-in` or
  `unexpected-shape`.
- Tool code that gets `needsUser` back from `session.ensure()` throws `NeedsUserError(reason)`,
  so the run ends as `needsUser` rather than borrowing an error class.

A step's `note` (up to 200 characters) is manifest text the person approved. It is shown in the
app's hand-off banner only, and never sent to the MCP client, where an adapter could use it as an
injection channel. Errors otherwise leave as `SiteAdapterError(stage, errorClass)`, never as page
text, URLs with query strings or exception messages (**Enforced**).

### Adapter-supplied regular expressions

`urlRegex` conditions and Messages OTP patterns are regular expressions that run in the main
process. Each is screened when the manifest is parsed (`isScreenedPattern`, **Contract**; the
same screen was **Enforced** for OTP patterns in round 1): it must compile, and it must not have a
repeated group that itself repeats or alternates, as in `(a+)+` or `(a|ab)*`, or a
backreference. That stops the exponential shapes. Polynomial ones such as `\d*\d*\d*x` pass the
screen, so inputs are bounded too: a URL regex never runs on a path and query over 2,048
characters, and OTP matching runs on at most 2,000 characters of each message, in a worker
thread under a deadline (**Enforced**).

### Navigation and frames

- Every committed main-frame navigation in the auth partition must be on `navigation`. A
  prevented or off-list navigation, including a redirect, poisons the page: every later
  primitive fails with `navigate/navigation-escaped`, and the flow ends (**Enforced**).
- Subframes of an auth page may load only `navigation` origins plus the manifest's
  `auth.frameOrigins` (default empty), for a CAPTCHA or bot-check frame the site embeds
  (**Contract**). Secrets are never typed into a `frameOrigins` frame unless that origin is also
  a granted secret origin. The round-1 driver let subframes load any https origin and relied on
  the secret-fill binding below; core v2 settles that in favour of the list.

### Before a secret fill

The interpreter checks all of these, in this order, and aborts the action if any fails
(**Enforced**, `inputReachable` a **Contract**):

1. A grant exists for this adapter, this exact content hash and this secret.
2. The manifest's secret request includes the field.
3. Every URL the page has committed to is on `navigation`, and the page isn't a block page.
4. The element is visible.
5. The element's frame origin, and the page's origin, are in the grant's origins intersected
   with the manifest's requested origins. HTTPS only, exact match.
6. Trusted input can reach the element (`ElementInfo.inputReachable`). It can't inside an
   out-of-process, cross-site frame; see below.
7. The element suits the field: `password` for passwords; `one-time-code`, `inputmode=numeric`
   or a text field for codes; email, text or tel for usernames.
8. For a password, the owning form's action resolves to an origin in the same granted set, and
   the element has a form at all. This stops a password being typed into, say, the site's search
   box, where it would land in URLs, history and analytics.
9. The secret is resolved from the provider, then checks 3, 4 and 5 run again, since resolving
   can take a Touch ID prompt's worth of time.
10. `secret-used` is audited (secret, field, origin, adapter hash, the call that triggered it).
    If the audit append fails, nothing is typed.

### How a secret is typed

- The value is fetched just in time, in the main process, and travels as a `SecretValue`: it
  never stringifies, serialises or inspects to its contents, and its buffer is zeroed on
  `dispose()` (**Enforced**).
- `AuthPage.type()` types only into the element the last `focus(selector)` targeted, in the
  frame the last `inspect(selector)` reported. For a `SecretValue` the caller must pass
  `allowedOrigins`, and the driver checks the focused frame's origin against them immediately
  before every keystroke. If the frame navigates, or focus moves, it stops and throws
  `secret-fill/origin-mismatch` (**Contract**; the round-1 driver already binds typing to the
  focused frame, checks focus in the renderer and in the browser process before typing, and
  stops on any commit or focus change between characters, **Enforced**).
- Characters come from `SecretValue.revealEach()`, one Unicode code point at a time, so the
  whole plaintext never becomes one JavaScript string (**Contract**; the round-1 driver decodes
  the secret once per fill inside `reveal()`).
- Keystrokes are paced `sendInputEvent` events, which are trusted input. They're paced because
  sites time keystrokes; the earlier app found its bank does. Whether to send `keyDown`/`char`/`keyUp`
  rather than `char` alone is [D38](plan.md#d38-keystroke-events).
- Secrets are never logged. Traces, when they exist, record
  `fill(#password, secret:woolworths.login.password)`.

**Cross-origin iframe logins.** With site isolation on, which Electron enables by default, a
cross-site iframe runs in its own renderer process and `sendInputEvent` never reaches it. The
round-1 e2e suite confirmed it: the click lands on the `<iframe>` element and keystrokes go
nowhere. So the driver refuses to focus or click there rather than type blind, and the flow ends
in `needsUser`. Turning site isolation off, or typing over CDP `Input.dispatch*`, are the
alternatives ([D37](plan.md#d37-cross-origin-iframe-logins)).

**Zeroing is best effort.** `SecretValue` zeroes its own buffer, and `op` output goes straight
from stdout into one. But the 1Password SDK returns the secret as a JavaScript string, and
JavaScript strings can't be zeroed, so that copy lives in the V8 heap until garbage collection, as
do the single-character strings `revealEach()` yields. That is acceptable only because the main
process is the trusted computing base. It isn't a property to advertise.

### One-time codes

- **From 1Password:** an `otp` step with `{ secret: <name> }` reads the TOTP field of that
  secret's granted item. Nothing extra to grant (**Enforced**).
- **From Messages:** an `otp` step with `{ messages: { sender, pattern, maxAgeSeconds } }`
  (**Enforced** in round 1 through a stand-in grant; the grant shape below is a **Contract**):
  - The sender is required. It is matched to one exact Messages handle (an E.164 number, a short
    code, an alphanumeric sender ID or an email), never a substring, so
    `fake.woolworths@icloud.com` doesn't pass for `Woolworths`.
  - It needs its own grant: provider `messages`, secret `messages` (a name manifests may not use
    for their own secrets), `itemRef` the sender handle the person approved, and `origins` where
    the code may be typed. `messagesSourcesIn()` lists what a manifest asks for, so the grant
    picker can show it.
  - Only codes newer than the start of this login are accepted, and only a capture that looks
    like a code is returned.
  - The reader opens `~/Library/Messages/chat.db` in place, read-only, for each lookup, with a
    bounded query on that handle, and closes it. It never copies the database: a copy would be a
    new plaintext store of the person's whole message history outside Messages' protected
    container, which the password grep in AC16 wouldn't notice.
- **Full Disk Access.** Reading `chat.db` needs it, and it's the broadest permission the app asks
  for: it also covers Mail, Safari history and every process that inherits it, including v0 tool
  code. For personal use (M3) the whole app holds it. Before third-party adapters, a small signed
  helper holds it instead and answers only "latest code from this sender matching this pattern
  since this time" (**Designed**, [D8](plan.md#d8-full-disk-access-for-messages)).

### Grants are separate from manifests

A manifest _requests_, for example "secret `login`, fields username and password, for origins
`https://auth.woolworths.com.au`". The person _grants_ it by binding a credential item to the
request, for one adapter content hash, narrowing the origins if they like but never widening
them. A manifest can't name a 1Password item. If an adapter changes, it doesn't inherit a grant
(**Enforced**). Whether an update may offer a one-click re-bind is
[D47](plan.md#d47-grant-re-bind-on-update).

`grant-made` is audited with the adapter hash and the granted origins (**Contract**).

The grant store is one JSON file, mode 0600, read through a single `O_NOFOLLOW` handle,
refusing a group- or world-writable directory, validated on every read and replaced atomically
(**Enforced**). It is not integrity-protected against other processes running as the person,
which in v0 includes tool code. Before the sandbox, grants and approvals should carry a MAC keyed
from the Keychain (**Designed**, [D45](plan.md#d45-grant-file-location)).

## Tool actions

### The capability object

Tool code gets:

- `page.goto/click/fill/extract/evaluate`;
- `page.fetch`, made from inside the logged-in page with same-origin credentials, for the site's
  internal APIs;
- `confirm()`;
- `session.ensure()`;
- an `AbortSignal`.

It gets no filesystem, no raw network and no secrets (subject to the v0 caveat above).
Capabilities die when the call returns, and a guard violation is sticky: once one fires, every
capability refuses for the rest of the call, even if tool code catches the error (**Enforced**).

### `session.ensure()`

- The runtime runs the manifest's probe in the tool partition. A `fetch` probe's path must start
  with a single `/` (no `//`, no backslash). The runtime logs in only on an explicit logged-out
  answer: the expected status with the wrong value, or one of `loggedOutStatuses` (default
  `[401]`). Anything else is `probe/unavailable`, never a login (**Enforced**;
  `loggedOutStatuses` a **Contract**).
- At most one login per tool call. Before the auth action runs, a durable attempt marker is
  written and fsynced; a crash or abort leaves it set, and every later login returns `needsUser`
  (`login-attempt-pending`) until the person clears it. `auth-failed`, or a login after which the
  probe still says logged out, holds until the person clears it; other failures back off from
  5 minutes, doubling to 6 hours (**Enforced**).
- Tool code sees only `ok`, `needsUser(reason)` or `failed(stage, errorClass)`.
- If the site asks for a password partway through a tool, the tool fails. Secrets are never
  filled in the tool partition, whatever the site asks. Re-running the auth action and retrying
  the tool once is **Designed**; it must never retry a write whose request may have reached the
  site ([D32](plan.md#d32-which-failures-retry)).

### The run's network policy

Tool code can reach the network without `page.fetch`: `evaluate()` can call the page's own
`fetch`, a click can submit a form, and `location.href` can navigate. The site's own scripts make
requests too. `webRequest` can't tell which of these is which. So the policy applies at the
network layer to **every** request in the tool partition, whoever made it.

The runtime calls `beginRun(policy, onBlocked)` before tool code runs and `endRun()` after
(**Contract**). The policy is the manifest's egress hosts, its request declarations, the tool's
declared side effect as `maxPurpose`, and a ceiling. For every request:

1. **Hosts.** The URL must be https on an egress host. Everything else is cancelled.
2. **Ambiguous paths.** A path with an encoded slash, backslash or NUL in a segment
   (`%2F`, `%5C`, `%00`), a literal backslash, or a segment that decodes to `.` or `..` is
   refused (`ambiguous-path`). Servers and proxies disagree about such paths, so our matcher
   could route them one way and the site another.
3. **Deny segments.** A path with a segment such as `checkout`, `payment`, `payee` or
   `placeorder`, also after percent-decoding and with `;matrix` parameters dropped, is refused
   for every kind of request, navigations and form posts included, unless it matches an
   `irreversible` declaration that has been unlocked.
4. **Declarations.** Every API call (fetch and XHR, any non-GET, beacons, sockets, unknown
   types) must match a declared `{ method, path }`, and the declaration's purpose may not exceed
   `maxPurpose`. So a `read` tool can't call a `write` endpoint, whether through `page.fetch`,
   `evaluate()` or the site's own button.
5. **Ceiling.** Navigations and API calls count against the run's ceiling
   (`limits.requestsPerRun`); scripts, styles, images and fonts don't.

Each refused request is reported as `{ method, target, reason, initiator }`, where the target is
origin and path only and the initiator is `tool` or `page`, and audited as `request-blocked`.
Reports are untrusted: a hostname can carry data, so they pass output redaction before they reach
the audit log.

Where this is today: the round-1 driver enforces 1 to 5 in the tool partition's `webRequest`
filter (with its own `beginRun(sideEffect)`), and the runtime's guarded page enforces them again
for `page.fetch` and `goto` (**Enforced**). The runtime doesn't call the driver's `beginRun` yet;
core v2's `beginRun(policy, onBlocked)` is the contract both are adopting.

Sockets that `webRequest` never sees are closed too (**Enforced**): the tool partition sends every
connection, loopback included, through a local CONNECT proxy that allows only egress hosts on
port 443 and never resolves a refused hostname. With WebRTC limited to proxied traffic and no
UDP-capable proxy, WebRTC's TURN-over-TCP and WebTransport's QUIC can't get out; the e2e suite
showed both reaching an undeclared host before the proxy. DNS prefetching is off process-wide,
and the tool partition sends `X-DNS-Prefetch-Control: off` on every response.

What the labels mean, honestly:

- Egress hosts, ambiguous-path refusal, deny segments and the ceiling are partition-wide.
- Declarations and purpose bind every API call, whoever made it. **The site's own background
  calls are held to them too**, so a manifest must declare the calls the site makes on load
  (Woolworths makes several, including Akamai's sensor POSTs), or they are cancelled.
- A `read` label is not enforced against a top-level navigation to a page that changes state
  when loaded, against a site that writes through a GET API call the adapter declared as `read`,
  or against any declaration whose purpose the adapter got wrong. The person approves the
  declarations, and the approval screen shows them, but the runtime can't check that a declared
  `read` is really a read.

### Irreversible actions

Every tool is declared `read`, `write` or `irreversible`. For an `irreversible` tool:

- The person confirms in the app, never through the MCP client. The prompt shows the calling
  client (**Enforced**), and the confirmation is audited with the client (**Contract**).
- The runtime asks before the tool's `run()` starts. Declined, timed out, or not auditable: the
  call ends `declined` and no tool code runs (**Enforced**; the `declined` outcome a
  **Contract**).
- Only after the person approves does the runtime call `unlockIrreversible()`. From then until
  `endRun()`, and only for that run, the run's `irreversible` declarations are usable. Before it,
  or for a run whose `maxPurpose` isn't `irreversible`, it does nothing (**Contract**).
- Still open: `confirm(message)` shows adapter-authored text. The dialog should be rendered by the
  runtime from structured data, with the adapter's text as an attributed note (change request C4).
  Whether to require Touch ID is [D46](plan.md#d46-touch-id-on-irreversible-confirmations).

No shipped adapter has an `irreversible` tool in v1 ([D18](plan.md#d18-irreversible-tools-in-shipped-adapters)).

### Rate budget and circuit breaker

The live probe showed that a handful of scripted calls gets a session blocked by Akamai within
minutes ([finding](findings/2026-11-07-woolworths-live-probe.md)). So the runtime, not each
adapter, protects the site and our standing with it (**Enforced**, the manifest fields a
**Contract**):

- **Per site host**, shared by every adapter and call for that host, a rate budget spaces
  requests at least `limits.minGapMs` apart (default 2 s).
- **A circuit breaker** opens on a block signature only: a 429, a 403 HTML page, or Akamai's
  "Access Denied … Reference #" page. It stays open for `limits.cooldownSeconds` (default
  10 minutes), doubling on each block in a row up to `limits.maxCooldownSeconds` (default 2
  hours). While it's open, calls fail fast as `blocked` with a retry time and nothing reaches the
  site. `breaker-opened { host, cause, retryAt, callId }` and `breaker-closed` are audited.
- A block surfaces as `blocked` / `blocked-by-site`, never as a generic failure; a 429 or our own
  refusal is `rate-limited`.
- Not yet: the breaker lives in memory, so a restart closes it; and the Woolworths defaults in
  [D28](plan.md#d28-rate-budget-defaults) are stricter than the code's (**Designed**,
  [D33](plan.md#d33-breaker-defaults-and-persistence)).

### Output redaction

Before a tool result leaves the process, the runtime replaces every string that contains a
sensitive value (**Enforced**, the inputs marked are a **Contract**):

- **What is sensitive:** every secret resolved for this run; the tool partition's cookie values
  on `cookieDomains`; and the values of handed-off storage keys (`sessionSecrets()`,
  **Contract**). Cookie values shorter than 8 characters are flags like `1` or `en-AU`, not
  credentials, and are ignored.
- **Run-scoped clones.** The filler disposes each secret as soon as it has typed it, which zeroes
  it, and a zeroed secret can't be matched. So the runtime keeps a `SecretValue.clone()` of each
  for the length of the run and disposes the clones when the run ends (**Contract**). In round 1
  the redaction set lost each secret when the filler disposed it, so a password the site echoed
  back into a page after login could have reached tool output.
- **How:** the output is first converted to plain JSON in one serialisation (so getters and
  `toJSON` run once, and binary data is refused); then each string, object keys included, that
  contains a sensitive value is replaced whole with `[redacted]`; then the serialised whole is
  checked once more, and the call fails as `tool-output/internal` if anything is left.
- **Not caught:** encoded or transformed copies (base64, URL-encoded, split across fields).
  Woolworths' auth cookies are `httpOnly`, so tool code can't read them in the first place;
  output schemas drop undeclared keys. Adapters that copy web-storage tokens deserve closer
  review. Whole-string versus substring replacement is [D36](plan.md#d36-redaction-whole-string-or-substring).

### Results reach the client as data

Tool output is parsed with the tool's zod schema, and only the parsed value is sent, so keys the
schema doesn't declare are dropped. Every non-`ok` outcome reaches the MCP client as fixed text:
a stage and error class from core's vocabulary, or a `needsUser` reason code (**Enforced**).
Product names and descriptions are still site-controlled text that reaches the model; that risk
is R6 in the plan.

### Sandbox

In v0, tool code runs in the main process with no boundary (see the caveat at the top). The plan
moves it to a `utilityProcess` with the capability API over a message port, for structure, and
then into a real sandbox before third-party adapters exist (QuickJS-wasm, `isolated-vm`, or a
sandboxed hidden renderer; [D12](plan.md#d12-sandbox-technology)). Node's `vm` module is not a
boundary.

## Approval and audit

- An adapter is a content-hashed bundle. Approvals and grants are keyed by that hash
  (**Enforced**). The approvals file fails closed: if it can't be read or parsed, nothing is
  approved.
- Any change, including an AI repair, creates a new hash and needs re-approval with a diff
  (**Designed**; the screen is mocked in `docs/mockups/approve-adapter.html`). Every
  permission-expanding change is highlighted, each with its own test: new `navigation` origins;
  new `egress` hosts; new `auth.frameOrigins`; new secrets, new fields on a secret, and new
  origins for a secret; new Messages senders; new `requests` declarations, grouped by purpose; a
  tool whose `sideEffect` goes up; new `cookieDomains` or storage keys; and any loosening of
  `limits`.
- The audit log is append-only, hash-chained JSONL, fsynced per record. A failed append is cut
  back off and the chain re-verified before the next one (**Enforced**). It records approvals
  (with version and the hash replaced) and rejections; grants made (with origins) and revoked;
  tool calls with the MCP client and their outcome (`ok`, `needsUser` with its reason, `failed`,
  `blocked`, `declined`); logins; every secret use; blocked requests with their initiator;
  breaker openings and closings; and confirmations with the client (event shapes a
  **Contract**).
- The client name is the self-reported name from MCP `initialize`, stripped of control and
  format characters and cut to 100 characters (**Enforced**). It is a label, not an identity.
  Identity from a per-client bearer token is **Designed**
  ([D42](plan.md#d42-per-client-tool-scopes)).

## The MCP endpoint

**Enforced**, in `packages/mcp-server`:

- Streamable HTTP on `127.0.0.1` only. The `Host` header must be `127.0.0.1:<port>`, and any
  `Origin` must be a localhost origin (DNS-rebinding protection). `localhost` URLs are refused,
  because Node resolves `localhost` to `::1` first, where another local account could be
  listening and would be handed the token.
- A bearer token on every request, 32 random bytes, compared in constant time. Bodies over 1 MiB
  are refused; at most 32 sessions are kept.
- The stdio bridge reads the endpoint URL and token from a config file that must be mode 0600,
  owned by the person, and name `http://127.0.0.1:<port>/mcp`, so an edited file can't send the
  token elsewhere.
- Tool names are `<adapter id>_<tool>`. If two tools map to one name both are withheld, so one
  adapter can't shadow another's tool.

Where the token lives and when it rotates is [D41](plan.md#d41-stable-mcp-port-and-token-rotation).

## Remote access

Today there is none: the endpoint listens on `127.0.0.1` and refuses any other `Host`. Clients
that can't reach the Mac (claude.ai on the web or a phone, cloud agents) can't use it.

Whatever transport is added later, these must still hold (**Designed**; the full design is in
[relay.md](relay.md)):

- **Secrets never leave the Mac.** Passwords, one-time codes, the 1Password token and session
  cookies are not in tool results today, and remote access adds no path for them.
- **The Mac decides.** Which tools are callable remotely, rate budgets, the breaker and
  confirmations are enforced in the app. A relay or tunnel is never the authority.
- **Confirmations stay on the Mac.** An `irreversible` call from a remote client still waits for
  the person in the app, and times out as declined if they're away.
- **Remote is a separate listener.** The local listener and its token never face the internet.
  Remote calls arrive on their own listener with OAuth tokens issued by the app, after consent
  given on the Mac. Remote tools are off by default, per tool; `tools/list` shows a remote client
  only what is enabled for it; and a tray switch turns remote access off and revokes every remote
  grant at once.
- **Every remote call is attributable** in the audit log.

Until that exists, **don't put the local endpoint behind a tunnel** (cloudflared, Tailscale
Funnel, ngrok). Its `Host` check refuses tunnelled requests unless the tunnel rewrites the
header, and making it pass would put one long-lived token, which can call every tool, in front of
the internet. A tunnel belongs in front of the separate remote listener, once it exists.

## Bot detection

The browser presents itself as the person's own browser would, and no more
([D24](plan.md#d24-bot-detection-posture)):

- **Allowed:** what the person's own Chrome sends. A clean Chrome user agent naming the bundled
  Chromium's real major version (`… Chrome/<major>.0.0.0 Safari/537.36`), the person's language
  (`en-AU`), their real IP and machine, and a real, headed (if hidden) browser window.
- **Not allowed:** stealth plugins; patching `navigator` or anything else to hide automation;
  CAPTCHA solving, by code or by a service; proxies; randomised, rotated or invented
  fingerprints; claiming a browser, OS or device other than the one running.
- **When a site objects:** a challenge hands the window to the person (`needsUser`); a block
  ends the call as `blocked` and opens the breaker. Nothing retries around it.

The clean Chrome UA is decided ([D9](plan.md#d9-user-agent)): run 4 of the live probe showed
Electron's default UA blocked from Nick's IP and the clean one not. The round-1 driver still
defaults to Electron's UA, with the clean one an option, and doesn't set `Accept-Language`;
making both the default is round-2 work. Client-hint brands still say `Chromium`
([D24a](plan.md#d24a-client-hint-brands)).

## The service-account token

The 1Password service-account token unlocks every item in the siteadapter vault, so it is the
most valuable secret the app holds.

- **Where it is revealed.** Only once per client, in `sdkClientFactory`, which passes it straight
  to `@1password/sdk`. That is the one `reveal()` outside the privileged filler (see
  CONTRIBUTING.md), pinned by a test.
- **Where it lives.** The design is a Keychain item whose ACL names the signed app's designated
  requirement, pinned to the Team ID, so only siteadapter can read it without a prompt.
- **How `op` runs.** The CLI fallback and `security` run with a minimal environment, without
  inherited `OP_*` variables, and the secret is read from stdout into a buffer, never argv or an
  error (**Enforced**). Which `op` binary runs is [D44](plan.md#d44-op-install-path).

**v0 gap: the designated-requirement property does not hold yet.** `KeychainTokenSource` reads
the item by running `/usr/bin/security`. The Keychain checks its ACL against the calling binary,
which is Apple's `security` tool, not siteadapter. So:

- every read prompts, and the prompt names `security` rather than siteadapter;
- **never click "Always Allow" on that prompt.** It adds `/usr/bin/security` to the item's ACL.
  After that, any process running as the person, including v0 adapter tool code (which has no
  sandbox), can read the token silently with `security find-generic-password -w`.

Before the token source is used outside development, and at the latest before third-party
adapters exist, the read moves in process: a native addon calling `SecItemCopyMatching`, or a
small helper bundled with the app and signed with its Team ID, whose own requirement is the one on
the ACL. The `TokenSource` interface (now in `core`) and its bounded wait stay the same.

## Personal Chrome profile mode (later)

This mode attaches to the person's real Chrome through a companion extension. Chrome 136 and
later refuse remote debugging on the default profile. In this mode there is one shared profile,
so the partition model can't hold. Secret fills are therefore unavailable in this mode. Adapters
can only reuse sessions the person already has.

## Open questions

- Side channels from the tool partition beyond those closed above. DNS prefetch is off, and
  `sendBeacon` is a `ping` request the policy sees. In the e2e suite Electron 44 opened no
  connection for `preconnect` hints even without the hardening, so the suite can't yet show the
  hardening is what stops them.
- Whether bot-protection cookies (Akamai `_abck`) stay valid after copying from `auth` to `tool`.
  Both partitions have the same engine and UA, so they should, but spike 1 hasn't run.
- Step-up auth flows that only exist inside a page, with no separate login URL.
- The decisions round 1 raised, each with options and a recommendation in
  [plan.md](plan.md#decisions), D31 to D54.
