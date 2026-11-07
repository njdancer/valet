# Development plan

Draft, 2026-11-07, updated after round 4. Covers the work from here to a v1 open-source release. Nick reviews it and
answers the [decisions](#decisions). It sits on top of [security-model.md](security-model.md) and
[architecture.md](architecture.md), and doesn't repeat them. Where this plan finds a gap in either,
it says so.

The product is called Valet ([D1](#d1-product-name), decided 2026-11-07).

## Contents

1. [Where we are](#where-we-are)
2. [Goals and non-goals](#goals-and-non-goals)
3. [The MVP](#the-mvp)
4. [Milestones](#milestones)
5. [Workstreams](#workstreams)
6. [Testing strategy](#testing-strategy)
7. [Risk register](#risk-register)
8. [Gaps found in the current design](#gaps-found-in-the-current-design)
9. [Decisions](#decisions)
10. [What Nick has to do in person](#what-nick-has-to-do-in-person)

---

## Where we are

After four overnight rounds, everything below is merged on `main`, and `pnpm check` is green. Every
package is on core v4. The app runs end to end against the fake site: an MCP client calls a
Woolworths tool, the runtime logs in on the fake Auth0, hands the session over, runs the tool and
writes the audit log. Nothing has touched the live site while logged in, and nothing is signed.

| Area                                       | State                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core`                            | Contracts v4: v3 plus the `update` error stage, `update-downloaded`/`update-installed` audit events, which partition refused a request, and `openAuthPage({ onBlocked })`.                                                                                                                                                                                                                                                                                |
| `packages/runtime`                         | `ToolHost` with approval, the adapter lock, deadlines, confirmations (with the client's transport), cancel through an `AbortSignal`, the run-scoped network policy, redaction, the hash-chained audit log, the attempt marker, and the per-site budget and breaker, persisted. New in round 4: `runLoginStep` (the app's own login work under the lock, breaker and budget) and `siteHealth()`.                                                           |
| `packages/auth-flow`                       | `runAuthFlow` on the Auth0 identifier-first shape, the secret filler with every pre-fill check, one password submit per login, Messages OTP behind a grant, canary tests.                                                                                                                                                                                                                                                                                 |
| `packages/credentials`                     | 1Password service account (SDK) and `op` providers, both able to list the vault's items; the resolver, the grant store, the Keychain token source (v0 ACL gap), the Messages OTP reader. No test touches the real 1Password, Keychain or Messages.                                                                                                                                                                                                        |
| `packages/browser-electron`                | The Electron `SessionDriver`: clean Chrome UA, `keyDown`/`char`/`keyUp` typing bound to the focused field, the request filter on both partitions with refusals reported, the egress proxy, one-way cookie and storage hand-off. 37 Electron e2e tests.                                                                                                                                                                                                    |
| `packages/mcp-server`                      | Streamable HTTP on `127.0.0.1` with a bearer token and Host/Origin checks, the stdio bridge, live session counts. Session ids never leave it.                                                                                                                                                                                                                                                                                                             |
| `adapters/woolworths`                      | Six tools (search, product, cart, add, set quantity, remove) and an Auth0 login with an optional TOTP or SMS step, against the fake. Site calls are 10 s apart ([D28](#d28-rate-budget-defaults)). 40 e2e tests.                                                                                                                                                                                                                                          |
| `fakes/woolworths-site`                    | www and auth origins over local TLS, the identifier-first flow with MFA variants, an Akamai-like limiter that reissues `_abck`, hostile variants including a page beacon that tries five exfiltration routes, an exfil sink, a recorder.                                                                                                                                                                                                                  |
| `apps/desktop`                             | The menu-bar app: tray, control panel (adapters, approval and update review, grants, credentials, clients, run traces, audit log, settings), the login window and hand-off, the confirmation panel, demo mode (`pnpm demo`). Served from `app://renderer`. Updater wired to an Ed25519-signed feed, off unless the build is packaged, Developer ID signed and has a feed compiled in. Refuses unexpected argv and `ELECTRON_*`/`NODE_*` variables.        |
| Packaging                                  | `pnpm package:smoke` builds an unsigned, ad-hoc signed `.app`, checks the fuses, Info.plist and asar contents, makes eight launches that must be refused, then launches it under a temporary HOME and checks the control panel over DevTools. The release path (Developer ID, notarisation) is written and refuses to run without its feed, but has never run ([D60](#d60-the-stdio-bridge-in-a-packaged-app), [D61](#d61-the-update-feeds-signing-key)). |
| Tests                                      | 3,356 unit and integration tests, coverage 98.6 / 94.9 / 97.9 / 99.3 (statements, branches, functions, lines; thresholds 90/85/90/90). Electron e2e: 24 desktop (6 screenshot specs skip by design), 37 browser-electron. Lint and both typecheck projects clean.                                                                                                                                                                                         |
| Spike 1 (`spikes/01-woolworths-electron`)  | Code written. **Not run.** It needs Nick to log in by hand.                                                                                                                                                                                                                                                                                                                                                                                               |
| Live probe (`spikes/02-woolworths-shapes`) | Run four times, anonymous only. See [the finding](findings/2026-11-07-woolworths-live-probe.md) and the summary below.                                                                                                                                                                                                                                                                                                                                    |
| CI, releases                               | None. The repo is local-only.                                                                                                                                                                                                                                                                                                                                                                                                                             |

So [M1](#m1-vertical-slice-against-fakes)'s exit is met, and more: the desktop e2e suite drives a real MCP client through the packaged-style app, not only plain Node. [M2](#m2-electron-driver-and-live-woolworths)'s code is in place; what's left of M2 is live work with Nick.

Still not done, or done differently from the docs:

- **Anything live while logged in.** Spike 1, the rest of the Auth0 flow (password page, MFA,
  silent re-login), the login probe (`/api/ui/v2/bootstrap` is still a guess), the checkout paths
  and the site's own traffic counts all need Nick ([What Nick has to do](#what-nick-has-to-do-in-person)).
- **Pacing inside the login.** The app's own login steps are paced and watched for block pages.
  The automated login inside a call, and the person's own navigation in the login window, are not
  ([D55](#d55-driver-level-budget-and-block-detection)).
- **Cancelling a login.** The auth flow takes no `AbortSignal`, so a cancelled call's automatic
  login runs on to its own deadline. If it stops part-way, the attempt marker stays set until the
  person clears it. A clean stop needs a core change: the auth runner would report whether any
  secret was filled yet.
- **The stdio bridge in a packaged build.** Refused by the argv check until
  [D60](#d60-the-stdio-bridge-in-a-packaged-app) is decided; clients use Streamable HTTP for now.
- **Tool code isn't in a separate process.** It runs in the main process, behind the guarded
  page. Planned for M3, with the sandbox in M7.
- **Never exercised for real:** the 1Password service account and `op` (the Keychain prompt
  included), Full Disk Access for Messages, a Developer ID signature, notarisation, an x64 build.
- **Small things in the UI.** The tray says "N clients connected" but counts open MCP sessions;
  the tray icon is generic; the run trace shows only the blocked count, because the main process
  can't count what was sent.

What the live probe established (all on 2026-11-07, from Nick's IP):

- **Akamai flags scripted bursts fast.** Run 1 loaded the homepage and then made 4 scripted
  `fetch` calls about 2.5 s apart. Three minutes later, run 2 got a 403 on everything. That pacing
  is the **known-bad baseline**: no default in this plan may be as aggressive
  ([D28](#d28-rate-budget-defaults)).
- **The block attached to the user agent, not the cookies or the IP alone.** A fresh partition
  with Electron's default UA (which carries the app name and `Electron/44.10.2`) was refused on
  its first homepage load. The same build with a clean Chrome UA loaded normally. So the clean
  Chrome UA, with the real Chromium major and `en-AU`, is the decided default
  ([D9](#d9-user-agent), resolved; the driver adopts it in round 2).
- **Login is Auth0 Universal Login on a separate origin.** `www…/auth/login` redirects to
  `https://auth.woolworths.com.au/u/login/identifier`. The flow is identifier-first: an email
  page (`input[name=username][type=email]`, "Continue"), then a password page (assumed to be
  Auth0's standard `/u/login/password`, not yet seen), then possibly an Auth0 MFA page
  (`/u/mfa-*-challenge`, assumed). The first page also offers "Log in with a passkey" and "Log in
  / Sign up with Everyday", which the auth flow must never click. Auth0 redirects back to
  `www…/auth/callback`, which sets the www session cookies.
- **Consequences.** Secret origins are `https://auth.woolworths.com.au`, since both fields are
  typed there and both forms post there. The manifest's `navigation` needs both origins. The
  Auth0 session cookie stays in the auth partition, so when the www session expires but Auth0's
  is still alive, re-login can be a **silent redirect with no secret fill**, and the auth flow
  tries that first.
- **Anonymous visitors get `wow-auth-token` cookies**, so a cookie probe is useless; the probe
  must be a `fetch` (likely `/api/ui/v2/bootstrap`, unconfirmed).

---

## Goals and non-goals

### Goals, in priority order

1. **Personal use first.** Nick's agents can log in to Woolworths and manage his trolley through
   MCP, unattended, without ever seeing his password. Claude (Claude Code and Claude Desktop) is
   the first client.
2. **Deterministic, auditable secret handling.** Every secret use is explainable after the fact
   from the audit log: which secret, which origin, which adapter hash, which tool call, which MCP
   client. The guarantees in the security model hold against adapter code that is actively
   hostile, and tests prove each one by trying to break it.
3. **A framework, not one integration.** Hybrid adapters: declarative manifests for everything a
   person approves (hosts, secrets, auth flow, request surface, side effects), TypeScript for tool
   logic. A second and third adapter must be cheap to write, or the framework claim is hollow.
4. **Exposure and experience from an open-source release.** A polished, signed, notarised,
   auto-updating macOS app; a clear security write-up; a docs site; adapters that work.
5. **Market tests, optional and later:** a hosted relay for remote MCP access, and possibly an
   adapter registry or marketplace.

### Non-goals for v1

- **Evading bot detection.** The browser should look like the person's own browser, and no
  more. Presenting a clean Chrome UA with the engine's real Chromium version and the person's
  language is allowed, because that is what the person's own Chrome sends. Stealth plugins,
  patching `navigator` to hide automation, CAPTCHA solving, proxies, and randomised or rotated
  fingerprints are not. When a site objects, the person sees the window (`needsUser`) or the
  call fails as `blocked-by-site`. This is a principle, not just a scope cut
  ([D24](#d24-bot-detection-posture)).
- **Checkout, payment or any money movement** in the Woolworths adapter. The framework supports
  `irreversible` tools; v1 adapters don't ship one ([D18](#d18-irreversible-tools-in-shipped-adapters)).
- **Windows and Linux.** The design avoids macOS lock-in where it's cheap, but Messages OTP, the
  Keychain and notarisation are macOS-only ([D20](#d20-platforms)).
- **Running adapters on a server.** The relay, if built, only carries MCP traffic to the
  person's Mac. A hosted browser running other people's logins is a different product with a
  different legal and security posture.
- **Personal Chrome profile mode.** Deferred, as the security model says.
- **Multiple accounts per site** and multiple people per install.
- **A general-purpose browser agent.** Tools are specific, declared and reviewed; there is no
  "do anything on this site" tool.

---

## The MVP

### Definition

The MVP is done when Nick uses it for his real weekly shop for two consecutive weeks, through
Claude, with the acceptance criteria below all met, and he would rather use it than the
existing browser-automation grocery skill.

### Tools

| Tool                | Side effect | What it does                                                                                  |
| ------------------- | ----------- | --------------------------------------------------------------------------------------------- |
| `search_products`   | read        | Search by term; returns stockcode, name, size, price, unit price, special flag, availability. |
| `get_product`       | read        | Details for one stockcode, including nutrition where present.                                 |
| `get_cart`          | read        | Trolley lines, quantities, totals, unavailable items.                                         |
| `set_cart_quantity` | write       | Sets the quantity of one or more stockcodes; quantity 0 removes. Returns the updated trolley. |
| `list_past_orders`  | read        | Stretch. Recent orders and their lines, for "buy the usual". Endpoint not yet discovered.     |

Naming rule, used everywhere in this plan: the manifest uses bare names (`get_cart`), and the MCP
server namespaces them by adapter id (`woolworths_get_cart`). The approval screen shows the bare
name; MCP clients and the audit log's client-facing fields show the namespaced one.

`set_cart_quantity` is destructive in MCP's sense (it lowers quantities and removes lines), so
it is advertised as such ([AC3](#acceptance-criteria)). The round-1 adapter also ships
`add_to_cart` and `remove_from_cart`; whether an additive `add_to_cart` should be advertised as
non-destructive, so clients could auto-approve it, is [D30](#d30-split-add-to-cart).

Login is not a tool. Every tool calls `session.ensure()`, which runs the auth action when the
probe says the session is logged out.

### Out of the MVP

The control panel (beyond the windows listed below), the IDE, the recorder, the authoring agent,
the sandbox, third-party adapters, the relay, Windows or Linux, and checkout.

### Acceptance criteria

Each is checked by an automated test, by a scripted manual check Nick runs, or both. "Live" means
against the real site with Nick present.

**Install and setup**

1. A signed, notarised DMG installs on Nick's Mac. The app is in the menu bar with no Dock icon,
   starts at login if he chooses, and Gatekeeper raises no warning.
2. First run walks him through: pasting a 1Password service-account token (stored in the
   Keychain, never on disk in plain text), choosing the vault, approving the bundled Woolworths
   adapter (showing its navigation origins, hosts, secrets, requests and tools), and granting the
   `login` secret by picking a 1Password item. The grant's origins are exactly
   `https://auth.woolworths.com.au`, where both the email and password pages live; a grant that
   includes `https://www.woolworths.com.au` is a bug. The grant is keyed to the adapter's content
   hash. ([Mockup](mockups/grant-secret.html).)
3. The app shows how to connect Claude Code (HTTP plus bearer token) and Claude Desktop (stdio
   bridge), with a copy button for each config. Both list the adapter's tools under their
   namespaced names (`woolworths_get_cart` and so on; six today: search, product, cart, add, set
   and remove), with MCP annotations derived from the manifest: `readOnlyHint: true` for reads;
   for `set_cart_quantity`, `readOnlyHint: false`, `destructiveHint: true` (it lowers quantities
   and removes lines) and `idempotentHint: true` (setting the same quantity twice has the same
   effect); `openWorldHint: true` on all of them. Until C9, every `write` tool is advertised
   `destructiveHint: true` and `idempotentHint: false`, `add_to_cart` included. `readOnlyHint` is
   backed by the run's network policy, not only by the adapter's label: a `read` tool's run
   allows only `read` declarations for every API call in the tool partition, whoever made it
   ([security model](security-model.md#the-runs-network-policy)).

**Behaviour, live**

4. From a logged-out state, `get_cart` logs in with no human involvement when Woolworths doesn't
   challenge, and returns the trolley. With a challenge the app can't meet (CAPTCHA, an MFA factor
   it can't read, an unknown prompt), the login window appears in front of Nick, and the tool
   returns `needsUser` within the client's timeout rather than hanging. When the www session has
   expired but the Auth0 session is alive, re-login completes through the silent redirect, and
   the audit log shows a login with **no** secret use for it.
5. If Auth0 asks for a one-time code by SMS, it's read from Messages and filled, with no human
   involvement, within 60 s of the SMS arriving. Other factors follow [D4](#d4-woolworths-2fa).
6. `set_cart_quantity` changes are visible in Nick's normal browser on woolworths.com.au after a
   refresh.
7. A realistic session (about 30 tool calls, the shape of a weekly shop) completes without an
   Akamai block on three separate days, paced by the runtime at the [D28](#d28-rate-budget-defaults)
   defaults. It takes as long as the budget makes it take; the test fails if anything bypasses
   the budget to finish faster. Today the budget covers only `page.fetch`, `goto` and the probe,
   so `evaluate()` fetches, clicks, the page's own requests and the login all bypass it; this
   criterion can't pass until [D55](#d55-driver-level-budget-and-block-detection) is built.
8. With the Mac locked and Nick away, a tool call from a scheduled agent succeeds through the
   service account.

**Failure handling**

9. An Akamai block surfaces as `blocked-by-site`, opens a cool-down, and further calls fail fast
   until it ends. No call during the cool-down reaches the site. (Automated against the fake
   site; observed live if it happens.)
10. A wrong password classifies as `auth-failed`, writes the attempt marker, and blocks further
    login attempts until Nick clears it in the app. At most one automated password submit happens
    before `needsUser`, whatever the flow's `retry` steps say. (Automated.)

**Security**

11. The canary egress suite passes: canary secrets reach only the fake site's login POST, and
    never tool output, traces, logs, the audit log, the MCP transport or any other host. The
    suite also asserts the canaries were actually typed. (Automated, in `pnpm check`.)
12. The hostile-adapter suite passes: an adapter that tries a service worker, `localStorage`
    poisoning, input listeners, exfiltration to an undeclared host, undeclared API paths and
    checkout paths gets blocked on each, and each block is audited. It includes a tool declared
    `read` that writes anyway: it calls `POST /api/v3/ui/trolley/update` through `page.evaluate`
    and through a click on the page's own "Add" button. Both are cancelled by the driver because
    a `read` run allows no `write` declaration, and audited with initiator `tool` or `page`, and
    the fake site's trolley is unchanged. (Automated.)
13. No request to a checkout or payment path leaves the tool partition, whether from
    `page.fetch`, `page.evaluate`, a click or a form submission. The test runs against the fake
    site's copy of the **real** checkout and payment paths recorded in M2, not only against
    paths the implementers chose. While an `irreversible` tool runs, only the `irreversible`
    declarations that tool lists are unlocked, and only for that call. Core v2 can't meet this
    yet: its unlock covers every `irreversible` declaration in the manifest, for page-initiated
    requests too. C15 adds the per-tool list, and must land before any irreversible tool ships
    ([D18](#d18-irreversible-tools-in-shipped-adapters) means none in v1). (Automated; see
    [gap G1](#g1-the-request-surface-only-covers-pagefetch).)
14. The audit log verifies end to end with a CLI command, and tampering with any line makes
    verification fail. (Automated.)
15. A changed adapter (any byte) loses its grants and must be re-approved, with a diff that
    highlights every permission-expanding change: new `navigation` origins; new `egress` hosts;
    new `auth.frameOrigins`; new secrets, new fields on a secret, and new origins for a secret;
    new Messages senders; new `requests` declarations, grouped by purpose; a tool whose
    `sideEffect` goes up (`read` to `write`, or anything to `irreversible`) or that becomes
    destructive; new `cookieDomains` or storage keys; and any loosening of `limits` (a higher
    `requestsPerRun`, a lower `minGapMs`, `cooldownSeconds` or `maxCooldownSeconds`). This is the
    security model's list. Each kind has its own test. ([Mockup](mockups/approve-adapter.html).)
    (Automated.)
16. `grep` over the app's logs, traces and audit log for Nick's real password finds nothing after
    a week of use. (Manual, scripted.)

**Engineering**

17. `pnpm check` passes with the coverage thresholds. The Electron end-to-end suite passes against
    the fake site.
18. A release is one command on Nick's Mac: build, sign, notarise, staple, publish to the update
    feed ([D23](#d23-update-feed-host)).

---

## Milestones

Effort is in **agent-days** (focused autonomous build time, which overnight runs compress) and
**Nick-hours** (review, decisions, live tests, anything needing his accounts, devices or presence).
Nick-hours are the real bottleneck: nothing live happens without him, and every live test risks
an Akamai block on his own IP. Estimates are rough and assume the decisions in each milestone are
answered on time.

### M0. Foundations (done)

- Scope: docs, core contracts, workspace tooling, spike 1 and the live probe's code, package
  skeletons.
- Exit: `core` tested; the live probe run; findings recorded.
- Remaining: Nick runs spike 1 (part of M2).

### M1. Vertical slice against fakes

- Status after round 4: done. The desktop e2e suite drives a real MCP client through the app,
  the runtime, the Auth0 login and the Electron driver against the two-origin fake, with the
  canary egress and hostile-page checks; `pnpm check` is green on `main`.
- Scope:
  - Review and merge the overnight branches; resolve their interface disagreements.
  - Wire the whole path in plain Node: an MCP client calls a tool over Streamable HTTP; the
    runtime takes the adapter lock, checks the rate budget, runs `session.ensure()`, runs the
    auth flow against a fake `SessionDriver` backed by the fake Woolworths site, fills canaries
    from the fake credential provider, hands off the session, runs the tool, redacts and returns
    the output, and writes the audit log.
  - The stdio bridge.
  - The canary egress suite and the hostile-adapter suite, at the `SessionDriver` level.
  - The rate budget and circuit breaker in the runtime, with a test that replays the run 1
    pattern (homepage, then 4 API calls 2.5 s apart) and asserts the budget spaces it out to the
    [D28](#d28-rate-budget-defaults) defaults.
  - The fake site on two HTTPS origins (www and auth) with the identifier-first flow, so the
    auth flow is written against the real shape from the start.
- Exit: one Node test drives a real MCP client through the full path and passes; both security
  suites pass; `pnpm check` green on `main`.
- Effort: 3–5 agent-days. Nick: 2–3 hours of review.
- Decisions needed: none blocking. [D11](#d11-adapter-package-format) and
  [D12](#d12-sandbox-technology) shape later work but not this.

### M2. Electron driver and live Woolworths

- Status after round 4: the code is in place (the clean UA, `keyDown`/`char`/`keyUp` typing, the
  hand-off window, the app, an unsigned packaged build). Not done: everything live, and
  [D55](#d55-driver-level-budget-and-block-detection)'s pacing inside the login.
- Scope:
  - Every live request in M2 runs under the [D28](#d28-rate-budget-defaults) defaults. The run 1
    pacing (4 scripted calls 2.5 s apart) is the known-bad baseline and is never repeated.
  - Run spike 1 with Nick, with the clean Chrome UA set: log in by hand, copy the session, call
    the trolley from the tool partition. Answer: does the clean Chrome UA hold while logged in;
    does `_abck` survive the copy; does an isolated-world `fetch` carry same-origin credentials.
  - Confirm the parts of the Auth0 flow that are still assumed, in a session with Nick present:
    the password page's URL and selectors, whether Auth0 MFA is enrolled on his account and which
    factor, whether a "remember this device" option exists, and the redirect chain back to
    `www…/auth/callback`. Then expire the www session (clear its cookies in the tool and auth
    partitions' www domain only) and confirm the silent Auth0 redirect logs back in with no
    secret fill. Confirm a login probe (likely `/api/ui/v2/bootstrap`).
  - Record, without submitting anything, the real checkout and payment request paths: with Nick
    driving, go from the trolley to the checkout page and stop before "Place order", capturing
    method, host and path for each API call (no bodies, no query strings). They become deny
    fixtures in the adapter's tests and routes on the fake site, so AC13 tests the real paths.
  - Measure what partition-wide deny would break ([R17](#risk-register)): log every request the
    trolley and product pages make that touches a deny segment, by resource type.
  - Measure the site's own traffic for [D58](#d58-page-initiated-traffic): per page view, how many
    navigations and API calls the page makes by itself, which non-GET calls (Akamai sensor POSTs,
    `acs.woolworths.com.au`) it sends and to which host, so the Woolworths ceilings and telemetry
    declarations are set from evidence.
  - Check which cookies Auth0 sets and on which domain: no Auth0 or session cookie may be set on
    `.woolworths.com.au`, since `cookieDomains` includes the bare domain.
  - `browser-electron`: the real `SessionDriver`, hidden-but-headed windows, the clean Chrome UA
    on every partition, tolerant navigation, paced `sendInputEvent` typing, the `webRequest`
    egress guard, partition-wide deny paths and declarations bound to every API call, WebRTC
    off, cookie and storage handoff.
  - Electron end-to-end tests with Playwright against the fake site served over local HTTPS, on
    two origins (www and auth).
  - A dev build of the app (unsigned is fine) with the MCP endpoint and no UI beyond the tray.
- Hard requirement before the first live **automated** login: the attempt marker and the
  one-password-submit limit (AC10) are implemented and tested, so a bug can cost at most one
  attempt against Nick's account ([D5](#d5-which-woolworths-account)).
- Exit: from Claude Code, Nick adds a real item to his real trolley through a dev build, with the
  login automated end to end.
- Effort: 4–6 agent-days. Nick: 4–6 hours, spread over at least two days so the live probing
  stays sparse. (One hour more than the first draft, for the checkout-path recording and the
  silent-redirect check.)
- Decisions needed: [D4](#d4-woolworths-2fa), [D5](#d5-which-woolworths-account),
  [D6](#d6-1password-setup), [D10](#d10-analytics-hosts), [D24a](#d24a-client-hint-brands),
  [D28](#d28-rate-budget-defaults).

### M3. MVP

- Scope:
  - 1Password service-account onboarding and the Keychain-stored token; the desktop-app fallback.
  - Messages OTP reader (if [D4](#d4-woolworths-2fa) needs it) and its Full Disk Access flow.
  - The minimum UI: tray menu, onboarding, adapter approval with permission summary, grant
    picker, `needsUser` window chrome, confirmation dialog, audit log viewer (read-only list).
  - Signing, notarisation, the release script.
  - Two weeks of real use; fix what breaks.
- Exit: every [acceptance criterion](#acceptance-criteria) met.
- Effort: 6–9 agent-days. Nick: 4–6 hours, plus the two weeks of using it.
- Decisions needed: [D7](#d7-1password-fallback),
  [D8](#d8-full-disk-access-for-messages), [D17](#d17-ui-stack), [D23](#d23-update-feed-host).

### M4. Daily-driver hardening

- Scope: auto-update; drift detection (live responses parsed against the adapter's zod schemas
  in a gated smoke test, with a clear "site changed" error class); local crash reports; log
  rotation and retention ([D27](#d27-retention)); the hash-chain verifier in the app; a second
  adapter that Nick actually needs, to prove the framework isn't Woolworths-shaped (a port of
  the earlier app's bank connector is the obvious candidate, read-only).
- Exit: a month of use with no manual fixes outside an update; the second adapter shipped
  without changes to `core` beyond ones already planned.
- Effort: 5–8 agent-days. Nick: 3–4 hours.
- Decisions needed: [D22](#d22-second-adapter).

### M5. Control panel, IDE and recorder

- Scope: the control panel window (adapters, runs, audit, settings); the IDE: a manifest and tool
  editor beside an embedded `WebContentsView` in a scratch partition, a network log, an element
  picker that writes selectors, a step runner for auth flows that stops at secret fills unless
  the grant exists, and a recorder that turns a person's clicks and the page's own API calls into
  a draft manifest (hosts, requests) and draft tool code.
- Exit: Nick builds a third adapter in the IDE without touching the repo.
- Effort: 10–15 agent-days. This is the largest UI piece. Nick: 4–6 hours.
- Decisions needed: [D11](#d11-adapter-package-format), [D17](#d17-ui-stack).

### M6. Authoring agent

- Scope: an agent that drafts and repairs adapters from a recording and a goal ("add a tool that
  lists past orders"), running inside the IDE's tools. Its output is a new adapter hash that goes
  through the same approval diff as any other change.
- Exit: given a recording and a goal, it produces a working tool on a fake site in a test, and on
  one real site with Nick.
- Effort: 5–8 agent-days. Nick: 2–3 hours.
- Decisions needed: [D13](#d13-authoring-agent-model-access).

### M7. Sandbox and adapter packages

- Scope: move tool code into the chosen sandbox; the adapter package format; install from a file
  or URL; signature or publisher identity on packages; the permission diff for updates; a
  hostile-adapter suite that targets the sandbox itself.
- Exit: a deliberately malicious adapter package installed from a file can't escape the
  capability API, and an external reviewer (or a dedicated agent red-team pass) finds nothing
  that breaks the security model's two guarantees.
- Effort: 6–10 agent-days. Nick: 2–3 hours.
- Decisions needed: [D11](#d11-adapter-package-format), [D12](#d12-sandbox-technology).
- **Gate:** no third-party adapter installs, and no open-source release, before M7.

### M8. Open-source v1

- Scope: licence, public repo, contributor docs, a security write-up and threat model aimed at
  outsiders, a docs site, a landing page, demo video, a support policy for adapters, issue
  templates, CI on public macOS runners (tests only; signing stays on Nick's Mac or moves to a
  locked-down workflow), GitHub Releases as the update feed.
- Exit: someone who isn't Nick installs it from the site, connects Claude, and uses an adapter
  without help.
- Effort: 5–8 agent-days. Nick: 6–10 hours (writing in his own voice, the launch itself).
- Decisions needed: [D15](#d15-telemetry),
  [D21](#d21-mcp-client-support), [D22](#d22-second-adapter), [D25](#d25-adapter-legal-posture).

### M9. Relay beta (optional)

- Scope: remote MCP access to the person's Mac for clients that can't reach `127.0.0.1` (claude.ai
  on the web and phone, cloud agents). The app dials out to the relay; the relay terminates OAuth
  for the MCP client and forwards requests over that connection. The relay never sees secrets
  and never runs a browser.
- Exit: ten outside users on the beta; Nick uses it from his phone.
- Effort: 8–12 agent-days for a Worker and Durable Object relay with OAuth. Nick: 4–6 hours,
  plus running a service.
- Decisions needed: [D14](#d14-relay), [D16](#d16-pricing).

### M10. Registry or marketplace (exploratory)

- Scope: a signed index of adapters, publisher identities, update channels, reviews or
  verification, maybe paid adapters.
- Exit: decided only after M8 shows whether anyone outside writes adapters.
- Effort: not estimated. Expect it to be bigger than everything before it, mainly in moderation
  and liability, not code.

### Order and overlap

```
M0 ─ M1 ─ M2 ─ M3 (MVP) ─ M4 ─┬─ M5 ─ M6 ─┐
                              └─ M7 ───────┴─ M8 (OSS v1) ─ M9 ─ M10
```

M5 and M7 can run in parallel. M7 must finish before M8. M9 can start any time after M3 if Nick
wants remote access for himself earlier: the app-side remote mode in [relay.md](relay.md), with
Tailscale Funnel as the transport, is most of M9 without the service. Tunnelling the local
endpoint directly is not a stopgap (see the security model's "Remote access").

Rough totals to the open-source v1, summed from M1–M8 above: **44–69 agent-days and 27–41
Nick-hours** (M1 2–3, M2 4–6, M3 4–6, M4 3–4, M5 4–6, M6 2–3, M7 2–3, M8 6–10). On top of that:

- about 2–3 Nick-hours for tomorrow's review of this plan, the mockups and the decisions;
- the two-week (M3) and one-month (M4) use periods, which dominate calendar time but aren't
  counted as hours.

Treat all of it as ±50%.

---

## Workstreams

Each workstream lists what exists, what's next, and what it depends on. "Next" is ordered.

### WS1. Runtime and security

- Exists: `core` v2 contracts and `packages/runtime`. Of the items below: 1 is built except the
  retry after a re-login ([D32](#d32-which-failures-retry)); 2 has the gap and the cool-down only,
  in memory ([D33](#d33-breaker-defaults-and-persistence)); 3 is built except the one-submit limit
  inside a login; 4 needs the Auth0 adapter, and the runtime still writes the attempt marker on the
  silent path; 5 is built; 6 has the stores but not the diff; 7 asks before `run()` but has no
  structured description (C4) and no scoped unlock until core v2; 8 is not started.
- Next:
  1. Tool-call orchestration: adapter lock, rate budget, `session.ensure()`, auth-on-demand,
     retry-once after re-login, output validation against the tool's zod output schema, output
     redaction, audit events.
  2. Rate budget and circuit breaker, per site, owned by the runtime: a minimum gap between
     direct API calls, a burst cap per page view, a per-minute ceiling, upward-only jitter, a
     session read cache, and a cool-down on `blocked-by-site`. The cool-down persists across
     restarts. The Woolworths defaults are set well below the known-bad run 1 pacing
     ([D28](#d28-rate-budget-defaults)) and only loosen with evidence.
  3. Login hygiene from the earlier app: the durable attempt marker (fsync before submit), the
     pessimistic outcome classifier, and at most one automated password submit before
     `needsUser`.
  4. Silent re-login first. The auth flow navigates to the site's login URL and, if the identity
     provider redirects straight back (Woolworths: Auth0 to `www…/auth/callback`), asserts the
     probe and hands off without resolving any secret. Only when the identifier page appears
     does it resolve the grant and fill. This is expressible with today's steps (`goto`, then
     `when urlMatches` the identifier page); the runtime's job is to resolve secrets lazily, at
     the first `fill` that needs them, so the silent path never calls 1Password, never writes an
     attempt marker and never audits a secret use.
  5. The audit writer: append-only JSONL, hash chain, fsync per record, a verifier.
  6. Grants: the store, keyed by adapter hash; revocation; the approval diff covering every
     permission-expanding change listed in AC15.
  7. The confirmation broker: the app shows the person a runtime-rendered description of an
     `irreversible` or confirm-gated action ([gap G4](#g4-confirm-takes-adapter-authored-text)),
     and on approval unlocks only the `irreversible` declarations that tool lists (C15). Core
     v2's `unlockIrreversible()` unlocks all of the manifest's, which is too wide.
  8. Output hardening against prompt injection ([R6](#risk-register)).
- Depends on: nothing outside `core`.
- Port from the earlier app: `bank-login-attempt-marker.ts`, `bank-login-outcome.ts`,
  `bank-request-ceiling.ts`, `bank-request-surface-guard.ts`,
  `connector-stage-vocabulary.ts`. Read them; don't copy their bank-specific parts.

### WS2. Browser driver

- Exists: `packages/browser-electron` with an Electron e2e suite. Of the items below: 1 is built
  except the clean UA as the default and `Accept-Language`; 2 is built, stricter than planned
  (declarations bind every API call, so no API-prefix method policy is needed), except that an
  ambiguous path only stops a declaration matching, navigations don't count toward the ceiling, and
  blocks aren't audited; auth subframes are pinned by `auth.frameOrigins` in core v2, but the
  driver's default is still any https origin; 3, 4 and 5 are built; 6 is not; 7 closed DNS prefetch
  and WebRTC and WebTransport egress, and measured `preconnect`.
- Next:
  1. `SessionDriver` for Electron: partitions, hidden-but-headed windows with
     `backgroundThrottling: false`, tolerant navigation, step timeouts, `destroy()` on close.
     Every partition gets the clean Chrome UA (`… Chrome/<real major>.0.0.0 Safari/537.36`,
     the major read from `process.versions.chrome`) and `Accept-Language: en-AU`, set before
     the first request. Client-hint brands are [D24a](#d24a-client-hint-brands).
  2. Network guard in each tool partition, under core v2's `beginRun(policy, onBlocked)`: egress
     allowlist, ambiguous-path refusal for every request, partition-wide deny paths,
     declarations and purpose for every API call, the per-run ceiling counting navigations too,
     WebRTC off, and blocked requests audited with their initiator
     ([G1](#g1-the-request-surface-only-covers-pagefetch)). Report block signatures to the
     runtime's breaker and pace main-frame navigations
     ([D55](#d55-driver-level-budget-and-block-detection)). In the auth partition: navigation
     allowlist on every committed navigation; subframes limited to `navigation` plus
     `auth.frameOrigins` (the driver's default today is any https origin); for Woolworths that
     is `https://www.woolworths.com.au` and `https://auth.woolworths.com.au`.
  3. Handoff never copies the identity provider's cookies. For Woolworths, `cookieDomains` names
     www and the bare domain (a cookie set for `.woolworths.com.au` is stored against the bare
     domain). Matching is exact, so a host-only Auth0 cookie on `auth.woolworths.com.au` stays in
     the auth partition, where it makes silent re-login possible; a cookie Auth0 set on the
     parent domain would be copied, which M2 checks for. A guard test asserts no
     `auth.woolworths.com.au` cookie ever appears in the tool partition, and the tool partition's
     egress doesn't include the auth host.
  4. Element inspection for the secret-fill checks (frame origin, input type, form action).
  5. Handoff: cookies by domain, web storage over CDP `DOMStorage`, one way only.
  6. `needsUser`: show the same window, with app chrome that says why and how to finish
     ([mockup](mockups/needs-user.html)).
  7. Check the side channels the security model lists as open (DNS prefetch, `sendBeacon`,
     speculative preconnect) and set the Chromium switches that close them.
- Depends on: spike 1 results (`_abck` across the copy, isolated-world credentials, the Chrome
  UA holding while logged in).
- Constraint: this package and `apps/desktop` are the only ones that import `electron`.

### WS3. Credentials

- Exists: `packages/credentials`. Items 1, 3, 4 and 5 below are built (the Keychain read has the
  v0 ACL gap in the security model); item 2 is the `op` CLI provider, not `DesktopAuth`
  ([D7](#d7-1password-fallback)). The Messages reader opens `chat.db` read-only in place per lookup
  and has only run against test databases, so whether the snapshot fallback is needed is unknown.
- Next:
  1. Service-account provider over the SDK, with the token from the Keychain (asynchronous,
     bounded prompts).
  2. Desktop-app provider. SDK 0.5.0 has `DesktopAuth`, which authenticates through the
     1Password app with the person's approval. That likely replaces the `op` CLI fallback
     entirely: no CLI install, no stdout parsing ([D7](#d7-1password-fallback)).
  3. TOTP from 1Password (`secret` OTP source), for sites that use it.
  4. Messages OTP reader: open `~/Library/Messages/chat.db` **in place, read-only**, with
     `node:sqlite` (`new DatabaseSync(path, { readOnly: true })`, built into Node 24; no
     dependency). One parameterised query, limited to rows newer than `notBefore` (and at most
     `maxAgeSeconds` old) from the given sender's handle, newest first, `LIMIT 5`. Decode only
     those rows' `text` or `attributedBody` (newer macOS stores the body in the blob), apply the
     pattern, and close the handle in a `finally`. **No copy of the database is ever made**: a
     file copy would put Nick's entire message history in plaintext outside Messages' protected
     container, and a raw copy taken while Messages writes can be torn. If read-only opening
     fails in practice (SQLite needs the `-shm` file to exist to read a WAL database read-only;
     it normally does while Messages runs), the fallback is the SQLite backup API
     (`node:sqlite`'s `backup()`) into a fresh `0700` directory, reading only the needed rows,
     and deleting the snapshot and its directory in a `finally`. Tests inject the path and the
     temp directory, and assert that no file outlives the call, including when the query throws
     ([G8](#g8-full-disk-access-isnt-in-the-security-model)). Needs Full Disk Access
     ([D8](#d8-full-disk-access-for-messages)).
  5. The fake provider and fake OTP reader for tests (exist in some form on the branch).
- Honest limit: both 1Password paths hand back the secret as a JS string, which can't be zeroed.
  `SecretValue` zeroes its own buffer, but a copy lives in the V8 heap until garbage collection.
  This is acceptable (the main process is the trusted computing base) but the security doc
  should say so rather than imply zeroing is complete.

### WS4. MCP

- Exists: `packages/mcp-server`. Of the items below: 1 is built with a random port and a token
  file rather than the Keychain ([D41](#d41-stable-mcp-port-and-token-rotation)); 2 is built, with
  every `write` destructive until C9; 3 runs from the repo with `tsx`, not bundled; 4 is
  [D42](#d42-per-client-tool-scopes); 5 is [D50](#d50-confirmation-and-hand-off-timeouts).
- Next:
  1. Streamable HTTP on `127.0.0.1`, random port by default with a fixed-port option, bearer
     token from the Keychain, `Origin` header checked (DNS-rebinding defence).
  2. Tools generated from manifests: bare manifest names namespaced by adapter id
     (`get_cart` becomes `woolworths_get_cart`), input and output schemas from the zod schemas,
     and annotations derived, never hand-written:

     | Manifest                      | `readOnlyHint` | `destructiveHint` | `idempotentHint` |
     | ----------------------------- | -------------- | ----------------- | ---------------- |
     | `sideEffect: read`            | true           | (omitted)         | (omitted)        |
     | `write`, `destructive: false` | false          | false             | from manifest    |
     | `write`, `destructive: true`  | false          | true              | from manifest    |
     | `irreversible`                | false          | true              | false            |

     `openWorldHint` is true for every site tool. `destructive` and `idempotent` are new manifest
     fields (change request C9); until they exist, the MCP server treats every `write` tool as
     destructive, which is the safe default.
  3. The stdio bridge: a small executable shipped in the app bundle that forwards to the HTTP
     endpoint, for Claude Desktop.
  4. Client identity in the audit log: from the bearer token (one token per client, named by
     the person), not from the self-reported `clientInfo`.
  5. Long calls: login with OTP can take a minute. Use progress notifications, and return
     `needsUser` before the client's timeout rather than after.
- Depends on: WS1.

### WS5. Desktop UI

- Exists: tokens, and static HTML mockups of the app's windows: the menu bar, adapters, adapter
  detail, update approval, grant, run trace, audit log, confirmation, login hand-off, and clients
  and settings. The index also lists IDE mockups, which aren't merged yet.
  Open [docs/mockups/index.html](mockups/index.html) in a browser (no build, no network; light
  and dark follow the system, or use the toggle). Screenshots of each, in both themes, are in
  `docs/mockups/screens/`. React and its test tools are in the desktop app's devDependencies.
- Screens, in MVP order. Each mockup is there to settle the criterion and change request named
  beside it:

  | #   | Screen                                                                                                                                                                                                                                                                                                            | Mockup                                       | Settles                                                        |
  | --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------- |
  | 1   | **Tray menu:** status per adapter (logged in, needs you, blocked until 14:20), recent calls by client, "Open control panel", "Pause all", quit.                                                                                                                                                                   | [menu bar](mockups/menubar.html)             | AC1, AC9 (cool-down visible), D29                              |
  | 2   | **Onboarding:** 1Password connection (service-account token or desktop app), vault choice, MCP client setup with copyable configs.                                                                                                                                                                                | [clients](mockups/clients-settings.html)     | AC2, AC3, D6, D7                                               |
  | 3   | **Adapter approval:** identity, version, hash, and the permissions as a person reads them: sites it navigates, hosts it contacts, secrets and the origins they're typed on, each API request with its purpose, each tool with its side-effect colour. For an update, the same screen as a diff, expansions first. | [approval](mockups/approve-adapter.html)     | AC2, AC15, G1 (the "labels are declared, not proven" note), C6 |
  | 4   | **Grant picker:** for each requested secret, choose a 1Password item; show the origins it will be typed on, narrowable but never widenable.                                                                                                                                                                       | [grant picker](mockups/grant-secret.html)    | AC2, D6                                                        |
  | 5   | **`needsUser` window chrome:** a banner over the site window: why it's showing (a reason code, C3), what to do, "Done" and "Give up".                                                                                                                                                                             | [needs user](mockups/needs-user.html)        | AC4, C3, D4                                                    |
  | 6   | **Confirmation dialog:** runtime-rendered action description, the exact request it unlocks, the calling client, approve or decline, a timeout; the adapter's own text only as an attributed note.                                                                                                                 | [confirm](mockups/confirm-irreversible.html) | C4, C2 (scoped unlock), D18, D19                               |
  | 7   | **Audit log:** filterable list, chain-verified badge, export.                                                                                                                                                                                                                                                     | [audit log](mockups/audit-log.html)          | AC14                                                           |

  The clients mockup covers MCP client setup; the 1Password half of onboarding isn't mocked yet,
  and can be once D6 and D7 are answered.
  8. (M4+) Run history with traces; settings; update prompt.
  9. (M5) The IDE: editor, embedded browser, network log, element picker, step runner,
  recorder controls, manifest diff.
- Approach: plain React and CSS against the tokens; no component library until there's a reason
  ([D17](#d17-ui-stack)). Renderer windows get `contextIsolation`, `sandbox: true`, no Node,
  a strict CSP and a typed preload bridge.

### WS6. IDE and recorder

- Starts in M5. Key design points to settle before building:
  - The IDE's embedded browser uses a **scratch partition**, never the adapter's `auth` or `tool`
    partitions, so authoring can't plant anything in a partition that later holds a real session.
  - The recorder captures the page's own network calls (method, path pattern, host) as draft
    request-surface entries and draft egress hosts. It must scrub query strings and bodies of
    personal data before anything is shown to an authoring agent.
  - Recording a login records selectors and flow, never typed values. Fields where the person
    typed are marked "secret here" and become `secretRef` fills.

### WS7. Authoring agent

- Starts in M6. Model access is the open question ([D13](#d13-authoring-agent-model-access)).
- Design: the agent's tools are the IDE's (inspect DOM, run a step, read the network log,
  propose a manifest edit, run the adapter's tests against a recording). It never holds a grant
  and never runs in a partition with a real session. Its output is a new adapter hash, so the
  approval diff is the control.
- The cleanest model-access route: expose those IDE tools **as an MCP server**, so the person's
  own Claude Code or Claude Desktop does the authoring with their own subscription. That needs
  no API key and no product-side model access at all. A built-in agent with the person's API key
  is the second option.

### WS8. Adapters

- Woolworths: `wip/adapter-woolworths` in progress against the fake site. The manifest's shape is
  known from the live probe: `navigation` is `https://www.woolworths.com.au` and
  `https://auth.woolworths.com.au`; the `login` secret's fields are `username` and `password`,
  both with origin `https://auth.woolworths.com.au`; `cookieDomains` names www and the bare
  domain, so an Auth0 cookie set on `.woolworths.com.au` would be copied (an M2 check). The auth
  steps go to `www…/auth/login`, take the silent path if Auth0 redirects straight back, and
  otherwise fill the email page, then the password page, then branch on an MFA page. The
  password page's selectors and the probe are confirmed in M2. Read tools should prefer what the
  page loads itself where that's cheap (navigate to a search URL and read the response the page
  fetched), and keep direct API calls sparse and cached, per the Akamai finding.
- Second adapter (M4): a different shape of site, to stress the framework ([D22](#d22-second-adapter)).
- Each adapter ships with: its fake site (or fixtures for a shared one), explicit tests per tool,
  scrubbed recorded shapes, and a gated live smoke test.

### WS9. Packaging and updates

- Next (M3): electron-builder config; hardened runtime; entitlements kept minimal; Developer ID
  signing; notarisation with `notarytool` (an app-specific password or API key in Nick's
  Keychain, never in the repo); stapling; a designated requirement pinned to the Team ID so
  Keychain "Always Allow" grants survive updates (the earlier app's trick).
- M4: `electron-updater` against the chosen feed ([D23](#d23-update-feed-host)). Updates are
  signed; the updater refuses an update signed by anyone else.
- Bundle the stdio bridge (and the Messages helper, if [D8](#d8-full-disk-access-for-messages)
  chooses one) as signed helpers inside the app.
- The release script refuses to run with a dirty tree or failing `pnpm check`.

### WS10. Relay

- Starts in M9 at the earliest. The first step is app-side remote mode (a separate listener, an
  OAuth server in the app, consent on the Mac, per-tool remote policy, a kill switch), with
  Tailscale Funnel or cloudflared documented as the transport in front of it, never in front of the
  local endpoint. Design: [relay.md](relay.md).
- If built: a Cloudflare Worker with a Durable Object per user, holding a WebSocket the app opens
  outwards. The Worker is the OAuth 2.1 authorisation server for MCP clients (expect claude.ai's
  remote connectors to need this). Nick has built a Cloudflare OAuth server for another project's MCP endpoint; reuse
  the lessons, not necessarily the code.
- Security: remote calls are marked as remote in the audit log; per-client tool allowlists;
  `irreversible` confirmations still happen only on the Mac; the person can kill remote access
  from the tray instantly.

### WS11. Registry and marketplace

- Exploratory, after M8. The minimum viable form is a signed JSON index in a public repo, with
  publisher keys, that the app can browse. Anything with payments or verification comes after
  evidence of demand.

### WS12. Docs and site

- In-repo docs stay the source of truth. At M8: a docs site (adapter authoring guide, manifest
  reference generated from the zod schema, security model for outsiders, FAQ on bot detection
  and ToS), a landing page, a short demo video. Write the security page as if a sceptical
  security engineer will read it first, because one will.

---

## Testing strategy

All of it runs through `mise exec -- pnpm …`. Nothing automated touches a real site, real
1Password, the real Messages database or the Keychain.

### Layers

| Layer               | Runs                       | What it covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unit                | `pnpm check`, every commit | Every module in plain Node with injected clock, sleep, spawn, fs paths and network. Explicit tests, no factories.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Guard tests         | `pnpm check`               | One adversarial test per guard: the test that tries to get past it (wrong origin, `http:`, a lookalike host, a form action elsewhere, an open redirect, a subframe, `*.` edge cases, encoded paths).                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Fake sites          | `pnpm check`               | `fakes/woolworths-site`: real `node:http` servers on port 0, recording every request. Two origins, as on the real site: a www server and a separate auth server with an Auth0-style identifier-first flow (email page, then password page, each posting to the auth origin), passkey and Everyday decoy buttons, a callback redirect that sets www cookies, and a silent-redirect mode when the auth session is alive. Switchable behaviours: MFA challenge (SMS, email or authenticator code), "remember this device", wrong password, Akamai-like blocking after fast bursts, anonymous token cookies, the real checkout and payment paths from M2, shape drift. |
| Canary egress       | `pnpm check`               | Unique canaries through the real login and tool path against the fake site. Assert they appear only in the login POST, and that they were typed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Hostile adapter     | `pnpm check`               | A fixture adapter that tries every attack in the security model, each asserted blocked and audited.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Electron end-to-end | `pnpm e2e`, before merge   | Playwright's Electron support drives the built app against the fake site over local HTTPS. Repeats the canary and hostile suites with the real driver, plus UI flows (approval, grant, confirm).                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Live smoke          | `pnpm smoke:live`, by hand | Gated on Nick ([below](#live-smoke-tests)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

### Fake sites over HTTPS

`core` only accepts `https` origins, which is right for production. The fake site therefore
serves HTTPS on `127.0.0.1` with a certificate generated per test run, and the Electron e2e
suite trusts it through `setCertificateVerifyProc` on the test partitions. That trust override
must be impossible in a production build: it lives behind a build-time flag, and a test asserts
the packaged app ignores it. The www and auth servers listen on separate ports, so they are
separate origins exactly as on the real site, and the tests check that a secret-fill on the www
origin is refused. Unit tests that don't need a browser can use the fake site's
handlers directly.

### Coverage

The thresholds (90/90/90/85) apply to `packages/*`, `adapters/*` and `fakes/*`. The Electron
glue in `browser-electron` and `apps/desktop` is hard to unit test, so keep it thin and cover it
with the e2e suite. Don't lower thresholds to get a commit through; exclude a file only with a
comment saying which e2e test covers it.

### Live smoke tests

- Run only by Nick, by hand, never in CI, never on a schedule until M4 shows the rate budget
  works.
- Read-only by default: probe, search one term, read the trolley. Write tests add one cheap item
  and set it back to its previous quantity.
- Each run records response shapes (keys and types, never values) and parses them against the
  adapter's schemas. A mismatch is a drift report, not a pass.
- At most one run per day, paced well inside the rate budget. If Akamai blocks, stop and wait.

### What tests can't tell us

Whether Akamai tolerates the real login, whether Woolworths changes its flow, how often a real
week of use trips anything. Only M3's two weeks of use answers those.

---

## Risk register

Likelihood and impact are High, Medium or Low.

| #   | Risk                                                                                                                                                                                                                                                                   | L                    | I   | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Residual                                                                                                                                                                                                                                                                                                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | **Bot detection.** Akamai blocked our second anonymous probe within minutes. Automated login, or a burst of tool calls, gets Nick's session or IP blocked, possibly affecting his normal shopping.                                                                     | H                    | H   | Headed hidden windows, Electron's real Chromium, and a clean Chrome UA with the real major version and `en-AU`, because run 4 showed the Electron UA blocked and the clean one not ([D9](#d9-user-agent)); nothing beyond matching the person's own browser ([D24](#d24-bot-detection-posture)). Runtime-owned rate budget set well below the known-bad run 1 pacing, upward-only jitter, a session read cache and a cool-down ([D28](#d28-rate-budget-defaults)). Prefer page-initiated requests for reads. `needsUser` instead of fighting. Live tests rare and paced.                                                                                                                                         | High. We won't evade, so some sites will simply not work unattended. That's a product limit to state openly.                                                                                                                                                                                                                 |
| R2  | **Site changes.** Woolworths changes its login, endpoints or response shapes.                                                                                                                                                                                          | H                    | M   | Zod output schemas; drift detection in smoke tests; `failed` with a clear class rather than wrong data; the authoring agent (M6) to repair; fixtures recorded from live.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Medium. Every site adapter is maintenance forever.                                                                                                                                                                                                                                                                           |
| R3  | **Terms of service and legal.** Woolworths' terms likely prohibit automated access. Publishing an adapter for it, or a marketplace of them, invites a takedown or worse.                                                                                               | M                    | H   | Personal use is the person automating their own account. For the release: the person runs it on their own machine with their own credentials; no hosted automation; adapters distributed separately from the framework if advice says so; no evasion. Get advice before M8 ([D25](#d25-adapter-legal-posture)).                                                                                                                                                                                                                                                                                                                                                                                                  | Medium until advised. This plan isn't legal advice.                                                                                                                                                                                                                                                                          |
| R4  | **1Password limits.** Service accounts can't read personal vaults; rate limits apply; plan eligibility unconfirmed; the desktop-app path needs an unlocked app.                                                                                                        | M                    | M   | Dedicated vault; cache nothing, but fetch only at login; desktop-app fallback; `needsUser` with a clear reason when neither works.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Low once [D6](#d6-1password-setup) is answered.                                                                                                                                                                                                                                                                              |
| R5  | **Electron footprint.** ~250 MB app, a Chromium per window, memory while idle.                                                                                                                                                                                         | H                    | L   | Close windows after each run; one hidden window at a time per site; idle with no windows. Measure in M3.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Low for personal use; a talking point for the OSS audience.                                                                                                                                                                                                                                                                  |
| R6  | **Prompt injection through tool output.** Product names, descriptions and reviews are site-controlled text that goes straight to the LLM, which may also hold write tools.                                                                                             | M                    | H   | Output is schema-validated structured data with length caps on every string; tools return fields, never page HTML; `irreversible` actions confirmed by the person in the app, never by the client; MCP descriptions note that outputs are untrusted; per-client tool allowlists (M4).                                                                                                                                                                                                                                                                                                                                                                                                                            | Medium. A `write` tool (cart) can still be misused by an injected client; the harm is bounded to the cart. A tool labelled `read` can only write through a request the adapter declared `read`, or through a non-API path ([G1](#g1-the-request-surface-only-covers-pagefetch)), so the label is a strong hint, not a proof. |
| R7  | **Sandboxing third-party adapters.** `utilityProcess` isn't a security boundary. A malicious adapter could read files or reach the network.                                                                                                                            | H (if shipped as is) | H   | No third-party adapters before M7. Sandbox choice in [D12](#d12-sandbox-technology). Hostile-adapter suite against the sandbox itself.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Low after M7, if the sandbox is real.                                                                                                                                                                                                                                                                                        |
| R8  | **The request surface doesn't bind `page.evaluate` or clicks.** See [G1](#g1-the-request-surface-only-covers-pagefetch).                                                                                                                                               | H                    | H   | The tool partition holds every request, whoever made it, to the egress hosts and deny segments, and every API call (fetch, XHR, any non-GET, beacons, sockets) to the declarations and the running tool's purpose: built in the round-1 driver. Ambiguous-path refusal for every request (the driver only stops such a path matching a declaration), navigations counting toward the ceiling (it counts API calls only), the `initiator` field and auditing the driver's blocks are core v2's `beginRun(policy, onBlocked)` contract, not built.                                                                                                                                                                 | Medium. A `read` label is still the adapter's own claim for top-level navigations to pages that change state, for GET endpoints that write, and for declarations whose purpose is wrong. The approval screen says so. This holds for first-party and agent-authored adapters too.                                            |
| R9  | **Session exfiltration through tool output.** Exact-match redaction misses an encoded cookie.                                                                                                                                                                          | L                    | M   | Woolworths' auth cookies are `httpOnly`, so tool code can't read them. Output schemas reject unexpected fields. Flag adapters whose manifests copy web-storage tokens.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Low for Woolworths; higher for storage-token sites.                                                                                                                                                                                                                                                                          |
| R10 | **Full Disk Access is broad.** Granting it to the whole app hands every adapter's host process access to Mail, Safari history and the rest.                                                                                                                            | M                    | H   | A tiny signed helper with FDA that only answers OTP queries ([D8](#d8-full-disk-access-for-messages)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Low with the helper.                                                                                                                                                                                                                                                                                                         |
| R11 | **Lockouts.** A login bug burns attempts and locks Nick's Woolworths account.                                                                                                                                                                                          | M                    | M   | Attempt marker; `ambiguous` counts as a failure; at most one automated password submit before `needsUser`, enforced by the runtime rather than the manifest, and in place before the first live automated login. The silent Auth0 redirect submits nothing, so it consumes no attempt; if it loops or lands somewhere unexpected, the flow ends in `needsUser`, not a password retry.                                                                                                                                                                                                                                                                                                                            | Low. Lockouts are the main per-account risk ([D5](#d5-which-woolworths-account)).                                                                                                                                                                                                                                            |
| R12 | **Signing and Keychain identity churn.** A bundle ID or Team ID change after launch orphans Keychain items and FDA grants.                                                                                                                                             | M                    | M   | Decide the name before the first signed build ([D1](#d1-product-name)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Low.                                                                                                                                                                                                                                                                                                                         |
| R13 | **Agent-built code nobody fully read.** Much of this is built overnight by agents in parallel.                                                                                                                                                                         | M                    | H   | Small commits; the security suites as the acceptance bar; Nick reviews `core`, the guards and the filler line by line; an independent review pass before M8.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Medium.                                                                                                                                                                                                                                                                                                                      |
| R14 | **Market.** Few people want to run a local Electron app to give agents site access; the relay doesn't sell.                                                                                                                                                            | M                    | L   | Personal use pays off regardless. Waitlist before building the relay.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Accepted.                                                                                                                                                                                                                                                                                                                    |
| R15 | **Anthropic terms for the authoring agent.** Offering claude.ai login in a third-party product isn't allowed without approval.                                                                                                                                         | M                    | M   | API keys, or the MCP-inverted route ([D13](#d13-authoring-agent-model-access)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Low.                                                                                                                                                                                                                                                                                                                         |
| R16 | **MCP and Electron churn.** Spec revisions, SDK major versions, Electron's eight-week cadence.                                                                                                                                                                         | H                    | L   | Pinned versions; a maintenance pass per Electron major; the update feed means users get fixes. The UA's Chromium major is read at runtime, so it tracks Electron upgrades without a code change.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Low.                                                                                                                                                                                                                                                                                                                         |
| R17 | **Partition-wide deny breaks normal pages.** The trolley page may preload a checkout script chunk, or call a checkout-summary API for delivery fees, and a keyword deny list cancels it. The keywords also may not match Woolworths' real order and payment endpoints. | M                    | M   | Decided here (recommendation, pending M2's measurement): apply deny only to `mainFrame`, `subFrame`, `xhr` (Electron reports `fetch` as `xhr`), `ping`, `webSocket` and `other`, never to scripts, stylesheets, images, fonts or media. Today the driver applies it to every request, scripts included, and the security model says so; both change once M2 has measured ([D58](#d58-page-initiated-traffic)). Record the real checkout and payment paths in M2 and add them as explicit deny entries. Measure in M2 what the trolley and product pages request that touches a deny segment, and add narrow, reviewed exceptions for read-only ones (for example a delivery-fee summary) as `read` declarations. | Medium until M2's measurement. A false block shows up as a broken tool, which is the safe direction.                                                                                                                                                                                                                         |

---

## Gaps found in the current design

Writing this plan turned up these. Each needs a fix in the docs or code; the ones that touch
`core` are listed as change requests for Nick to approve.

Status after round 1 and core v2: G1 is addressed, more strictly than proposed below: the driver
holds every API call in the tool partition, whoever made it, to the declarations and the tool's
purpose, so the API-prefix method policy in C8 isn't needed; what a `read` label still doesn't cover
is in security-model.md. Holding the site's own calls to the declarations raises a new problem,
though: its background traffic (Akamai's sensor POSTs among it) must now be declared, and
declarations have no host. That is C8 in reduced form, [D58](#d58-page-initiated-traffic). The
irreversible unlock is wider than G1 asked for (C15). G2 is partly addressed (C1). G3 is done (C3).
G4, G5 and G6 are open. G7 and G8 are now in the security model. G9 stands.

### G1. The request surface only covers `page.fetch`

The architecture says an in-page `fetch` from tool code that matches no declaration is cancelled.
That works for `page.fetch`, which the runtime mediates. But `page.evaluate` runs adapter code in
an isolated world, and that code can call `fetch` or `XMLHttpRequest` itself. `webRequest`
can't tell those requests from the site's own (it doesn't report the world), so it can't apply
declarations to them. Clicking a "Place order" button has the same effect through the site's own
code.

**What this means for `read` and `write` labels.** Without more, a tool declared `read` can
still `POST /api/v3/ui/trolley/update`, or any other write on an allowed host, through
`page.evaluate` or by clicking the site's own button. The `read`/`write` colours on the approval
screen and the MCP `readOnlyHint` would then be the adapter's own claim, not something the
runtime enforces. That is true for first-party and agent-authored adapters as well as
third-party ones, and it matters for R6: an injected client that calls a "read" tool is trusting
that label.

**Superseded in part.** What follows is the round-1 proposal, kept for the record. What was built
holds every API call, whoever made it, to the declarations and the tool's purpose, so layer 3
(the method policy on API prefixes) and the "honest statement" after it are replaced by
security-model.md's "The run's network policy". Still current: layer 1; layer 2's deny paths and
resource types (R17, [D58](#d58-page-initiated-traffic)); layer 2's per-declaration unlock, which
core v2 doesn't meet (C15); and the ceiling paragraph at the end, which is now D58.

Fix, in three layers, all in the tool partition's `webRequest` and applied to **every** request
whatever its initiator:

1. **Hosts.** The egress allowlist, as today.
2. **Deny.** The deny segments (checkout, payment and the rest), plus the explicit checkout and
   payment paths recorded from the real site in M2. Applied to `mainFrame`, `subFrame`, `xhr`,
   `ping`, `webSocket` and `other` requests, and to form submissions (non-GET `mainFrame`), not
   to scripts, stylesheets, images, fonts or media, so a preloaded checkout chunk doesn't break
   the trolley page ([R17](#risk-register)). They stay closed unless an `irreversible` tool is
   running **and** the person confirmed it; even then only the specific `irreversible`
   declarations (method plus path) that call was confirmed for are unlocked, and only until
   that call ends. This matches `decideRequest`, which unlocks a denied path only for a
   matching `irreversible` declaration.
3. **Method policy.** Each manifest names its site's API path prefixes (for Woolworths, `/api`
   and `/apis` on www) and a short allowlist of the site's own non-GET telemetry that pages send
   on their own (Akamai sensor POSTs, `acs.woolworths.com.au/rest/v1/delivery`), measured in
   M2. While a `read` tool runs, a non-GET `xhr`, `ping` or form submission to an API prefix is
   cancelled unless it matches a declared `read` request (Woolworths' search is a `POST` that
   reads) or the telemetry allowlist. While a `write` tool runs, it must match a declared `read`
   or `write` request. Cancelled requests are audited with the running tool's name. This needs
   change request C8.

Declared-path checks for **GET** requests stay on `page.fetch` only. The honest statement, for
the security model and the approval screen, is:

- The egress hosts, the deny list and the method policy are partition-wide guarantees.
- Declarations are a `page.fetch` guarantee, and a non-GET guarantee on API prefixes.
- A `read` label is enforced against non-GET API writes. It is **not** enforced against a site
  that writes through GET, through a path outside its API prefixes, or through a request the
  adapter declared as `read` when it isn't. The person approves those declarations, and the
  approval screen shows them, but the runtime can't check that a declared `read` is really a
  read.

`SessionDriver` has no way today to install or change that guard; see change request C2.

The ceiling needs care. Woolworths' home page alone makes far more than the default 50 requests
(scripts, images, Akamai sensors, analytics). A partition-wide ceiling should count only
`mainFrame`, `subFrame` and `xhr` requests (`webRequest` reports the resource type; Electron
reports `fetch` as `xhr`), and sit separately from the `page.fetch` count that `requestsPerRun`
was meant for. The numbers come from measuring a real session in M2.

### G2. Rate budgets aren't in the manifest

The finding adds a per-site rate budget and circuit breaker, but the manifest has only
`limits.requestsPerRun`. Change request C1.

### G3. `needsUser` reasons are free text

`EnsureResult` carries `reason: string`, and auth steps carry `needsUser.reason` and
`fail.reason` from the manifest. These cross the runtime boundary. Manifest-authored strings are
probably fine to show the person (the person approved them), but they shouldn't reach the MCP
client as free text, where an adapter could use them as an injection channel. Change request C3.

### G4. `confirm()` takes adapter-authored text

`ToolContext.confirm(message)` shows the person a message the adapter wrote. A hostile adapter
could word a confirmation to mislead ("Confirm to refresh your session"). The dialog should be
rendered by the runtime from structured data (tool name, declared side effect, the request it
unlocks, the calling client) with the adapter's text shown as a secondary, clearly attributed
note. Change request C4.

### G5. Declarative tool actions have no schema

The security model's table says tool actions can be declarative steps or code. The manifest only
has declarative auth steps. That's fine for the MVP (Woolworths tools are code), but "hybrid"
adapters, and an authoring agent that writes reviewable adapters, need a declarative tool form
(navigate, extract into a typed shape, `page.fetch` a declared request, map fields). Change
request C5, needed by M5–M6, not the MVP.

### G6. Tool input and output schemas live only in code

MCP listing and the approval screen both need each tool's schemas. Today they're on the
`ToolImplementation`, so listing tools means loading adapter code. Once tool code is sandboxed
(M7), the host should be able to list and approve tools without running adapter code. Change
request C6, needed by M7.

### G7. Zeroing is partial

See [WS3](#ws3-credentials). The security model should say "best effort" for the copy that
1Password's SDK returns.

### G8. Full Disk Access isn't in the security model

The Messages reader needs it, and it's the broadest permission the app will ask for. The
security model should cover who holds it ([D8](#d8-full-disk-access-for-messages)), and that the
reader opens `chat.db` in place, read-only, for a bounded query, and never copies the database
([WS3](#ws3-credentials)). A copy would be a new plaintext store of the person's whole message
history outside Messages' protected container, and the password grep in AC16 wouldn't notice
it.

### G9. The probe needs the tool partition, which needs a session first

The probe runs in the tool partition. On a cold start the tool partition has only anonymous
cookies (which on Woolworths include `wow-auth-token`, so a cookie probe is useless). That's
fine with a `fetch` probe, but it means every first call of the day costs a probe request plus a
home-page load. Count them in the rate budget.

### Core change requests

| #   | Change                                                                                                                                                                                                                                                                                                                                                                   | Needed by                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| C1  | `limits` gains `minGapMs`, `requestsPerMinute` and `cooldownSeconds` (with defaults), and `AuditEvent` gains `rate-limited` and `cooldown-started`.                                                                                                                                                                                                                      | M1                           |
| C2  | `SessionDriver` takes a network policy for the tool partition (hosts, deny segments and explicit deny paths, the resource types deny applies to, the method policy, the ceiling) and reports blocked requests. Unlocking is a list of specific `irreversible` declarations (method plus path), set for one confirmed call and cleared when it ends, never a single flag. | M1                           |
| C3  | `EnsureResult.needsUser` and step `needsUser`/`fail` carry a reason code from a fixed vocabulary, with optional manifest text shown only in the app.                                                                                                                                                                                                                     | M1                           |
| C4  | `confirm()` takes a structured action description; free text becomes an optional, attributed note.                                                                                                                                                                                                                                                                       | M3                           |
| C5  | A declarative tool-action schema.                                                                                                                                                                                                                                                                                                                                        | M5                           |
| C6  | Tool input and output JSON Schemas declared in the manifest (generated from zod at build time and checked to match).                                                                                                                                                                                                                                                     | M7                           |
| C7  | `ProviderKind` gains `onepassword-desktop` for the SDK's `DesktopAuth`, if [D7](#d7-1password-fallback) picks it.                                                                                                                                                                                                                                                        | M3                           |
| C8  | The manifest gains `apiPrefixes` (per host) and a `telemetry` allowlist of `{ method, host, path }` for the method policy in G1, and `AuditEvent` gains a blocked-by-method-policy reason.                                                                                                                                                                               | M2                           |
| C9  | Tool declarations gain `destructive: boolean` and `idempotent: boolean`, so MCP annotations are derived ([WS4](#ws4-mcp)) rather than hand-written.                                                                                                                                                                                                                      | M2                           |
| C10 | `limits` gains a per-minute cap and a cap on direct API calls per page view, for [D28](#d28-rate-budget-defaults) and [D33](#d33-breaker-defaults-and-persistence).                                                                                                                                                                                                      | M2                           |
| C11 | The login runner learns whether password typing started, so the attempt marker can tell a spent attempt from an interrupted page load ([D35](#d35-the-attempt-marker-after-a-timeout)).                                                                                                                                                                                  | M2                           |
| C12 | `tool-called` carries the client id a per-client token names, alongside the self-reported name ([D42](#d42-per-client-tool-scopes)).                                                                                                                                                                                                                                     | M3                           |
| C13 | `retry.times` is documented as extra attempts, and renamed `retries` at the next `schemaVersion` ([D31](#d31-retry-count-semantics)).                                                                                                                                                                                                                                    | Later                        |
| C14 | `tool-finished` gains a count of redacted strings ([D36](#d36-redaction-whole-string-or-substring)).                                                                                                                                                                                                                                                                     | M4                           |
| C15 | Tool declarations gain `unlocks: [{ method, path }]`, each naming one of the manifest's `irreversible` declarations, and `unlockIrreversible()` takes that list, so confirming a tool unlocks only what it names, for that run ([AC13](#acceptance-criteria)).                                                                                                           | Before any irreversible tool |
| C16 | The driver feeds the runtime's rate budget and breaker: it reports block signatures (403 HTML, Akamai's page, 429) on navigations and API calls in both partitions, and waits on the budget before each main-frame navigation ([D55](#d55-driver-level-budget-and-block-detection)).                                                                                     | M2                           |
| C17 | `RequestDeclaration` gains an optional `host` (default the manifest's home host) and a `telemetry` purpose for the site's own background calls, which no tool can call through `page.fetch`; `limits` splits the ceiling into tool-initiated and page-initiated counts ([D58](#d58-page-initiated-traffic)).                                                             | M2                           |
| C18 | `BlockedRequest.target` is the origin plus a path digest, as the round-1 driver reports it, not origin and path ([D57](#d57-blocked-request-target)).                                                                                                                                                                                                                    | M1                           |
| C19 | `urlRegex` runs under the OTP worker's deadline, or with a per-pattern quantifier cap and a 256-character input bound ([D56](#d56-url-regex-deadline)); and the manifest parser allows at most one Messages sender ([D59](#d59-several-messages-senders)).                                                                                                               | M2                           |
| C20 | The `minGapMs` comment in `manifest.ts` says what [D33](#d33-breaker-defaults-and-persistence) decides (per host, strictest of the approved adapters), not "across all of this adapter's runs".                                                                                                                                                                          | M2                           |

Status in core v2:

- **C1, partly.** `limits` has `minGapMs`, `cooldownSeconds` and `maxCooldownSeconds`, and the audit
  log has `breaker-opened` and `breaker-closed` with the `rate-limited` error class. No per-minute
  cap; that is C10.
- **C2, done differently, and narrower than asked.** `beginRun(policy, onBlocked)`,
  `unlockIrreversible()` and `endRun()`. The run's policy carries the manifest's whole request
  surface, and tools don't declare which requests they use, so confirming one irreversible tool
  unlocks every `irreversible` declaration in the manifest (pay, add a payee, place an order), for
  page-initiated requests too. That is not equivalent to C2's per-call list; C15 restores it.
  D18 (no irreversible tools in v1) makes it less urgent, not less wrong. The policy also has no
  rate field, so the driver can't pace or watch for blocks (C16).
- **C3, done.** `needsUser` reason codes, `fail` classes, app-only notes, `NeedsUserError`.
- **C4 to C7, open.** `ProviderKind` gained `messages`, not `onepassword-desktop`.
- **C8, not needed as written** (see the status above G1). Its host-scoped telemetry list
  returns in reduced form as C17, if [D58](#d58-page-initiated-traffic) agrees.
- **C9, open.**
- **C15 to C20, new** from the review of the round-2 docs; all open.

### Changes to the other docs

Made in the round-2 docs sync, except the `DesktopAuth` change, which waits on D7. The
security model now also marks which guarantees code enforces today.

- **security-model.md, "Tool actions":** state that egress hosts and deny segments are
  partition-wide, that declarations and purpose bind every API call whoever made it, and how far
  a `read` label is enforced beyond that ([G1](#g1-the-request-surface-only-covers-pagefetch));
  which of these the round-1 driver enforces and which are core v2's contract; that the
  irreversible unlock in core v2 covers every `irreversible` declaration in the manifest, wider
  than C2 asked (C15); that the rate budget and breaker cover only `page.fetch`, `goto` and the
  probe ([D55](#d55-driver-level-budget-and-block-detection)); and that the current Woolworths
  manifest would break under the v2 policy until [D58](#d58-page-initiated-traffic) is decided.
- **security-model.md, approval:** the list of highlighted changes and AC15's list are the same
  list.
- **security-model.md:** zeroing is best effort for the SDK's copy (G7); Full Disk Access and the
  in-place, no-copy Messages read (G8); and the bot-detection principle as reworded in
  [D24](#d24-bot-detection-posture).
- **architecture.md, "Spikes before the framework":** spike 2 (isolation) was not run as a spike;
  it is replaced by M1's canary egress and hostile-adapter suites. Spike 1 no longer compares
  UAs. The live probe in `spikes/02-woolworths-shapes` is not that spike 2, despite the
  directory number; renaming the directory would remove the confusion.
- **architecture.md, credentials:** the `op read` fallback becomes `DesktopAuth` if D7 says so.
- **This plan, if the design drafts are accepted.** Each departs from the plan as written:
  - [WS10](#ws10-relay) and [M9](#m9-relay-beta-optional): the OAuth authorisation server moves
    from the Worker into the app, with consent on the Mac ([relay.md](relay.md#summary)).
  - [D14](#d14-relay): the tunnel docs wait for the app's remote mode instead of coming at M3,
    since a tunnel can't reach the local endpoint and claude.ai can't send its bearer token.
  - [WS9](#ws9-packaging-and-updates): the stdio bridge becomes a `--mcp-bridge` mode of the app
    binary, not a signed helper, behind a strict command-line allowlist
    ([release-and-updates.md](release-and-updates.md#the-stdio-bridge)).
  - [D12](#d12-sandbox-technology): QuickJS inside the sandboxed renderer rather than the renderer
    alone ([registry-and-sandbox.md](registry-and-sandbox.md#why-not-the-renderer-alone)).

---

## Decisions

Each decision has options, a recommendation, and what it blocks. The first table lists the ones
to answer first: they block M2 or M3, or they're expensive to change later. Nick answered all of
them on 2026-11-07; each section starts with his answer. The rest get answered as they come up.

### Answer these first

| #   | Decision                                    | Recommendation                                                                                | Blocks     |
| --- | ------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------- |
| D4  | **Woolworths 2FA (Auth0 MFA)**              | Check his account's factor in M2; SMS via Messages, TOTP via 1Password, else needsUser        | M2–M3      |
| D5  | **Which Woolworths account**                | Nick's real account, with the one-attempt limit in place first                                | M2         |
| D6  | **1Password setup**                         | Service account on a new "Valet" vault; move the item                                         | M2–M3      |
| D8  | **Full Disk Access for Messages**           | Helper before release; whole app acceptable for M3                                            | M3         |
| D18 | **Irreversible tools in shipped adapters**  | None in v1                                                                                    | M3, M8     |
| D24 | **Bot-detection posture**                   | Look like the person's own browser, nothing more; stated publicly                             | Everything |
| D28 | **Rate budget defaults**                    | ≥10 s between API calls, 2 per page view, session cache                                       | M2         |
| D32 | **Which failures retry**                    | Only "page not ready"; never a second password fill; never retry a write                      | M2         |
| D35 | **The attempt marker after a timeout**      | Hold for the person only if password typing started                                           | M2         |
| D38 | **Keystroke events**                        | `keyDown`/`char`/`keyUp`, as the person's keyboard sends                                      | M2         |
| D41 | **Stable MCP port and token rotation**      | The bridge for every client; rotate on demand; a token per client                             | M3         |
| D55 | **Driver-level budget and block detection** | The driver reports block signatures to the breaker and paces navigations                      | M2         |
| D58 | **Page-initiated traffic**                  | Separate ceilings; host-scoped declarations for the site's own non-GET calls; numbers from M2 | M2         |
| D60 | **The stdio bridge in a packaged app**      | A small signed Swift proxy inside the app bundle                                              | M3         |
| D61 | **The update feed's signing key**           | 1Password, in its own vault, Touch ID from the release script                                 | M3         |

Already decided, recorded for completeness: [D1](#d1-product-name) (the name, Valet),
[D2](#d2-licence) (Apache-2.0), [D3](#d3-repository-hosting-and-going-public) (public now),
[D9](#d9-user-agent) (the clean Chrome UA, decided by run 4 of the live probe and now the
architecture's default) and [D39](#d39-auth-subframe-origins) (auth subframes pinned to a list,
decided by core v2).

D31 to D54 are the questions round 1 raised. Each has options and a recommendation; none blocks
round 2. D55 to D59 came out of the review of the round-2 docs; D55 and D58 block M2's live work.
D60 to D65 came out of round 3 (the desktop app, the auth probe, packaging); D60 and D61 block
the first signed build. D66 to D68 came out of round 4; none blocks anything yet.

### D1. Product name

- Decided 2026-11-07: **Valet**. Bundle ID `me.dncr.valet` (development builds `me.dncr.valet.dev`),
  display name "Valet" ("Valet Dev" for development builds), package scope `@valet`, environment
  variables `VALET_*`, home page `valet.dncr.me`, Homebrew cask `valet`. The valet key is the
  idea: it drives the car but can't open the glovebox. Laravel Valet (a PHP development server)
  shares the word but not the audience.
- Options: keep "siteadapter" (the working name); pick a new name now; pick one at M8.
- Considerations: the bundle ID, Keychain service names, partition names, the npm scope, the
  domain and the GitHub organisation all derive from it. Changing the bundle ID after the first
  signed build orphans Keychain grants and Full Disk Access. "siteadapter" is descriptive but
  generic and hard to search. A name should say "your agents can use your accounts, safely"
  without promising a bot.
- Recommendation: choose the final name before M3's first signed build. If undecided, use a
  neutral bundle ID that doesn't need to change (`me.dncr.<something>`) and rebrand only the
  display name later.
- Blocks: M3 (signing), M8 (launch).

### D2. Licence

- Decided 2026-11-07: **Apache-2.0** for the app, packages and adapters (`LICENSE`, `NOTICE`, and
  `"license"` in every package.json). The relay is still open.
- Options: MIT; Apache-2.0; AGPL-3.0; source-available (e.g. FSL, BSL) for the relay only.
- Considerations: Apache-2.0 adds an explicit patent grant and is common for security-relevant
  infrastructure. AGPL discourages someone hosting the relay as a competing service, but also
  discourages contributors and companies. The relay, if it's the commercial piece, can be closed
  or source-available without touching the app's licence.
- Recommendation: Apache-2.0 for the app, packages and adapters. Decide the relay's licence when
  it exists.
- Blocks: M8.

### D3. Repository hosting and going public

- Decided 2026-11-07: **public now**, before M8. The README says pre-alpha, and no adapter but
  the bundled one can be installed yet, so the M7 concern doesn't apply until that changes.
- Options: stay local until M8; private GitHub repo now, public at M8; public now.
- Recommendation: private GitHub repo now, for backup and later CI, public at M8. Public before
  the sandbox (M7) invites people to install third-party adapters the design can't contain yet.
- Blocks: M8; CI before then.

### D4. Woolworths 2FA

- Nick's answer (2026-11-07): He believes Woolworths offers SMS only; use TOTP if it turns out to be
  available, else SMS via Messages.
- Known: login is Auth0 Universal Login, so any second factor is an Auth0 MFA challenge page
  (`/u/mfa-*-challenge`) after the password page. Unknown: whether Nick's account has MFA
  enrolled, which factors the Woolworths tenant enables, and whether it challenges only new
  devices. Nick may know the answer to the first already.
- Options, by Auth0 factor:
  - **SMS code:** the Messages reader fills it (AC5).
  - **Authenticator app (TOTP):** a 1Password one-time-password field, with the `secret` OTP
    source. This is the most reliable unattended option if the tenant offers it, and needs no
    Full Disk Access.
  - **Email code:** `needsUser` until there's a reason to build a mail reader.
  - **Push (Auth0 Guardian), voice, WebAuthn or passkey:** `needsUser`. These need the person.
  - **No MFA:** nothing to do.
- **If SMS:** the Messages grant needs the exact sender handle (an alphanumeric sender ID such as
  `Woolworths`, a short code, or a number), which only a real code shows. Record it in M2 from a
  code Auth0 sends Nick, put it in the manifest's `otp` step, and the grant picker shows it for
  approval. Whether Auth0 always sends from the same sender is part of what M2 checks.
- Recommendation: if the tenant offers an authenticator factor and Nick is willing, enrol one in
  1Password and use TOTP; otherwise plan for SMS via Messages. Every other factor is
  `needsUser`. Auth0's "remember this device", if offered, plus the persistent auth partition and
  the silent redirect should make challenges rare. The fake site models each factor's page.
- Blocks: M2 (auth flow), M3 (OTP reader priority; whether Full Disk Access is needed at all).

### D5. Which Woolworths account

- Nick's answer (2026-11-07): Accepted: his real account, with the one-attempt limit in place first.
- Options: Nick's real account; a separate test account.
- Considerations:
  - The MVP's point is managing his real trolley, so the real account has to work eventually.
  - The main per-account risk is a **lockout** from a login bug ([R11](#risk-register)). A test
    account would absorb that.
  - Akamai blocks attached to the IP plus the UA fingerprint in run 4, not to an account, so a
    test account wouldn't protect against those. That's from one observation and not proven.
  - A second account may itself breach the terms.
- Recommendation: his real account, if Nick agrees, with live tests kept rare. Hard requirement
  before the first live **automated** login in M2: the runtime allows at most one automated
  password submit before `needsUser`, and the durable attempt marker is in place and tested
  (AC10). The first automated login runs with Nick watching.
- Blocks: M2.

### D6. 1Password setup

- Nick's answer (2026-11-07): He isn't sure which 1Password plan he has (probably a basic individual
  one). Ideal: passwords stay in his own vaults and he authorises each use once, not every run.
  Fallback: copy the item into a dedicated vault, or into the local Keychain, keeping a reference to
  the source item so a changed password can be re-synced. Open: check whether his plan offers service
  accounts, then pick the path.
- Questions for Nick: which plan (Individual, Families, Teams)? Are service accounts available
  on it? Is there a vault he's happy to dedicate?
- Options: move the Woolworths item into a new "Valet" vault; duplicate it there; skip
  service accounts and use only the desktop-app path.
- Recommendation: a new vault holding only items granted to Valet; **move** the item (a
  duplicate is a second copy to rotate, which is exactly what the architecture rejects for the
  Keychain). Autofill in his browser keeps working from any vault he can access. A service
  account scoped read-only to that vault.
- Blocks: M3 (unattended runs); M2 can use the desktop-app path.

### D7. 1Password fallback

- Options: `op read` through the CLI; the SDK's `DesktopAuth` (in the 0.5.0 SDK already
  installed); none.
- Recommendation: `DesktopAuth`. No CLI install or stdout parsing, the same SDK as the service
  account path, and the person approves in 1Password's own UI. Keep `op` only if `DesktopAuth`
  turns out not to support reading TOTP or to need a newer 1Password app than Nick has.
- Blocks: M3. Needs core change C7.

### D8. Full Disk Access for Messages

- Nick's answer (2026-11-07): Build the helper now. Open: check first whether a standard CLI already
  does this (something to vendor, or to prompt the person to install) before writing one.
- Options: grant FDA to the whole app; a small signed helper inside the bundle that holds FDA and
  answers only "latest code matching this sender and pattern since this time"; no Messages
  support.
- Considerations: FDA to the main app also covers every process that inherits from it, which
  will include adapter tool code. The helper is extra build and signing work (a Swift command
  line tool is simplest; a Node single-executable is possible).
- Recommendation: whole app for M3 (personal, first-party adapter only), the helper before M7
  admits third-party adapters.
- Blocks: M3 (if D4 needs SMS), M7.

### D9. User agent

- **Resolved** by run 4 of the live probe (main commit `cb0b1c3`). From Nick's IP, a fresh
  partition with Electron's default UA got a 403 on its first homepage load; the same build with
  a clean Chrome UA loaded normally. architecture.md now makes the clean Chrome UA the default.
- What the driver sends on every partition: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)
  AppleWebKit/537.36 (KHTML, like Gecko) Chrome/<major>.0.0.0 Safari/537.36`, where `<major>` is
  the bundled Chromium's real major version, and `Accept-Language: en-AU`. This is what Nick's
  own Chrome sends, so it is within [D24](#d24-bot-detection-posture).
- Still open: client-hint brands ([D24a](#d24a-client-hint-brands)).
- In code: `cleanChromeUserAgent()` exists, but the round-1 driver still defaults to Electron's UA
  and sends no `Accept-Language`. Round 2 makes both the default.

### D10. Analytics hosts

- Hosts in play, by partition:
  - **Auth partition navigation:** `https://www.woolworths.com.au` and
    `https://auth.woolworths.com.au`. The Auth0 pages' subresources aren't restricted by the
    security model (the site's own scripts are out of scope), but they are logged in M2.
  - **Tool partition egress, strict set:** www, `cdn0.woolworths.media`, `acs.woolworths.com.au`.
    Not `auth.woolworths.com.au`: the tool partition never talks to the identity provider.
  - **Optional:** the ~40 analytics and ad hosts the homepage contacts.
- Considerations: fewer hosts means less exfiltration surface and less tracking of Nick. But the
  site may behave differently, or look more bot-like, with its analytics blocked. Untested.
- Recommendation: strict by default, measured in M2. Add hosts only with evidence.
- Blocks: M2.

### D11. Adapter package format

- Options: a directory or zip with `manifest.json`, one compiled ESM `tools.mjs`, fixtures and a
  README, hashed with `bundleHash`; npm packages; git repositories.
- Considerations: npm brings install scripts and dependency trees nobody reviews. A single
  compiled file is what the sandbox will load anyway, and it's what the approval hash covers.
  Adapters with dependencies get them bundled in at build time.
- Recommendation: `.valet` zip with a fixed layout. Authors use TypeScript and a build
  command; the app only ever loads the built bundle, and the loader hashes exactly the bytes it
  imports, so nothing outside the hash can run. Approvals and grants keyed by the hash depend on
  that: today `ToolHost.register()` takes the hash from its caller, and no loader exists. npm and
  git are authoring conveniences, never the distribution channel.
- Blocks: M5 (IDE save format), M7.

### D12. Sandbox technology

- Options:
  - **QuickJS compiled to wasm** (e.g. quickjs-emscripten): a strong boundary with nothing
    reachable but what's injected; slower, and tool code can't use Node or modern-JS features
    QuickJS lacks; a new dependency.
  - **isolated-vm**: a V8 isolate in-process; fast; a native addon (rebuild per Electron), and
    its README described the project as in maintenance mode at last check; verify before choosing.
  - **A sandboxed hidden renderer**: tool code runs in a `BrowserWindow` with `sandbox: true`,
    no Node, a partition whose `webRequest` blocks everything, and the capability API over a
    `MessagePort`. Chromium's renderer sandbox is battle-tested, and it costs no dependency.
    Heavier per run (a renderer process).
  - **SES / Hardened JS compartments**: good capability discipline, but same process and realm;
    not a boundary on its own.
- Recommendation: spike the sandboxed renderer and QuickJS-wasm against the hostile-adapter
  suite in M7, and pick on evidence. Lean towards the sandboxed renderer: tool code is mostly
  orchestration of capability calls, so its speed doesn't matter, and it adds no dependency.
- Blocks: M7.

### D13. Authoring agent model access

- Options:
  - **MCP-inverted:** the IDE exposes its authoring tools over MCP; the person's own Claude Code
    or Claude Desktop drives them. No model access in the product.
  - **Bring-your-own API key** (Anthropic, or others later): the sanctioned path for a built-in
    agent using the Agent SDK.
  - **Shell out to the person's installed `claude` CLI:** works with their subscription, but it's
    a grey area under Anthropic's terms for third-party products, and fragile.
  - **Offer claude.ai login:** not allowed without Anthropic's approval.
  - **Local models:** possible later; quality unknown for this task.
- Recommendation: MCP-inverted first. It fits the product (it's already an MCP server), costs
  nothing, and uses whatever client the person prefers. Add bring-your-own key for a built-in
  agent in the IDE. Don't ship CLI shelling in a released build without asking Anthropic.
- Blocks: M6.

### D14. Relay

- Options: build a relay (Worker plus Durable Object, outbound WebSocket from the app, OAuth for
  MCP clients); document cloudflared or Tailscale Funnel; both.
- Considerations: the relay is the only piece that's a service with uptime, abuse and cost. It's
  also the only obvious thing to charge for. cloudflared and Tailscale work today for technical
  users but don't give claude.ai a proper OAuth flow without more setup.
- Recommendation: for Nick's own remote use after M3, build the app-side remote mode and
  document Funnel (then cloudflared) in front of it, as [relay.md](relay.md) recommends; no tunnel
  in front of the local endpoint. Build the hosted relay only after M8, and only after a waitlist
  shows demand.
- Blocks: M9.

### D15. Telemetry

- Options: none; opt-in crash reports; opt-in anonymous adapter health ("adapter X failed with
  class Y"), which would tell maintainers a site changed before users report it.
- Recommendation: none in v1. A privacy-first security product shouldn't phone home by default.
  Consider opt-in adapter health with M10, when there's a registry to feed.
- Blocks: M8.

### D16. Pricing

- Options: free and open source with a paid relay; paid app; donations or sponsorship;
  marketplace revenue share.
- Recommendation: free, open-source app. If the relay is built, a small monthly fee, tested
  with a waitlist and a price on the landing page before building it. Don't decide marketplace
  economics until there are outside adapter authors.
- Blocks: M9.

### D17. UI stack

- Options: React with plain CSS against `tokens.css` (React is already a devDependency); a
  component library; no framework.
- Recommendation: React and plain CSS, built with electron-vite (already a devDependency). The
  IDE in M5 will want a code editor (CodeMirror is lighter than Monaco); that's a dependency
  request for then.
- Blocks: M3.

### D18. Irreversible tools in shipped adapters

- Nick's answer (2026-11-07): Accepted: no irreversible tools in v1. Later he wants approvals sent
  to his phone, not only shown on the Mac; not needed yet.
- Options: no checkout in v1; a checkout tool behind in-app confirmation.
- Recommendation: none in v1. The framework supports `irreversible` and the confirmation path is
  tested against the fake site, but no shipped adapter moves money until the confirmation UX has
  had real use. Revisit after M4.
- Blocks: M3 scope, M8 messaging.

### D19. Confirmation when Nick is away

- Options: decline after a timeout; push to his phone (needs the relay or a notification
  service); queue for later.
- Recommendation: decline after a timeout in v1. Phone confirmation comes with the relay.
- Blocks: nothing in the MVP (no irreversible tools).

### D20. Platforms

- Recommendation: macOS only for v1. Keep the runtime free of macOS assumptions (already enforced
  by the "only two modules import Electron" rule), so Windows is a credential-provider and
  packaging job later, not a rewrite.
- Blocks: M8 messaging.

### D21. MCP client support

- Recommendation: v1 officially supports Claude Code and Claude Desktop, and tests against the
  MCP SDK's own client. Others (Cursor, ChatGPT's MCP support, VS Code) are "should work", with
  setup docs written as people report them.
- Blocks: M8.

### D22. Second adapter

- Options: port the earlier app's bank connector (read-only transactions); another grocer
  (Coles); a utility or a government site Nick uses.
- Considerations: a bank is the strongest test of the security model and the most valuable to
  Nick, but also the scariest to publish. Another grocer barely tests the framework.
- Recommendation: a bank, read-only, kept private (not in the public release) unless Nick
  decides otherwise. For the public release, pick one or two low-risk sites with fewer legal
  concerns, ideally ones that have no API.
- Blocks: M4, M8.

### D23. Update feed host

- Options: GitHub Releases (needs a public repo, or a token in the app for a private one, which
  is unacceptable); Cloudflare R2 or S3 with electron-updater's generic provider; no auto-update
  before M8.
- Recommendation: R2 with the generic provider until the repo is public, then GitHub Releases.
  The feed only serves signed builds; the updater verifies the signature.
- Blocks: M4 (auto-update); M3 needs only a DMG.

### D24. Bot-detection posture

- Nick's answer (2026-11-07): He doesn't mind sites objecting: no breaking the law or helping others
  to, but terms-of-service objections are each person's call, and the techniques listed here are all
  on the table. Open: which of them to build, and in what order. Agent-side limit: Claude doesn't
  solve CAPTCHAs or bypass bot challenges; those stay a needsUser hand-off.
- Recommendation: state it as a principle in the README and docs: Valet drives a real
  browser at human pace on the person's own account and machine, presents itself as the
  person's own browser would, and stops when a site objects.
  - **Allowed:** matching what the person's own browser sends: a clean Chrome UA with the
    engine's real version, the person's language, and their real IP and machine.
  - **Not allowed:** stealth plugins; patching `navigator` or other properties to hide
    automation; CAPTCHA solving; proxies; randomised, rotated or invented fingerprints; claiming
    to be a different browser, OS or device than the one actually running.

  In one sentence, worded the same way everywhere: we match the person's own browser, never go
  further to hide automation, and never solve a CAPTCHA.

  It's the honest position, it simplifies the legal story, and it's what makes a
  security-focused audience trust it.
- Blocks: D25, marketing. (D9 was decided within it.)

### D24a. Client-hint brands

- The UA string now says Chrome, but the `Sec-CH-UA` client hints still list `Chromium` rather
  than `Google Chrome`. Akamai accepted that in run 4.
- Options:
  - **Leave the brands as `Chromium`.** Truthful about the engine; nothing to maintain.
  - **Match Nick's Chrome's brands** with `Emulation.setUserAgentOverride` and
    `userAgentMetadata` over CDP on each partition. Arguably within D24 (it matches the person's
    own browser), but it is a claim about the product, not just the engine, and it adds a CDP
    override that must track every Electron upgrade.
  - **Strip client hints.** Real Chrome sends them, so this would look less like Nick's browser,
    not more.
- Recommendation: leave the brands as `Chromium` until a block is traced to the mismatch. If that
  happens, matching brands is acceptable under D24, but Nick decides.
- Blocks: nothing now; M2 if a logged-in block appears.

### D25. Adapter legal posture

- Questions: can the project publish adapters for sites whose terms prohibit automated access?
  Should adapters live in a separate repository, maintained by their authors, rather than in the
  framework's repository?
- Recommendation: get a short legal opinion (Australian, plus a US view if the audience is
  global) before M8. Meanwhile, structure the code so adapters can move to a separate repo
  without changes (they already only depend on `core`).
- Blocks: M8.

### D26. Where the Woolworths adapter lives at release

- Options: in the main repo as the reference adapter; in a separate adapters repo; private.
- Recommendation: decide with D25. Default to a separate repo, with a fake-site-only reference
  adapter in the main repo for the docs.
- Blocks: M8.

### D27. Retention

- Options: keep the audit log forever; rotate traces after N days; let the person choose.
- Recommendation: audit log kept (it's small and the chain needs continuity; rotation starts a
  new chain whose first record commits to the previous file's last hash). Traces and screenshots
  kept 14 days by default, configurable.
- Blocks: M4.

### D28. Rate budget defaults

- Nick's answer (2026-11-07): Accepted.
- **Known-bad baseline.** Run 1 of the live probe loaded the homepage and then made 4 scripted
  API calls about 2.5 s apart, with no navigation in between. That was enough for Akamai to flag
  the UA from Nick's IP within three minutes
  ([finding](findings/2026-11-07-woolworths-live-probe.md)). Every default must be clearly less
  aggressive than that, on every axis.
- Starting defaults for Woolworths:
  - **Minimum gap of 10 s between direct API calls** (`page.fetch` and the probe), with
    upward-only jitter of 0–50% (so 10–15 s, never less than 10). Four times run 1's gap.
  - **At most 2 direct API calls per page view.** After two, the next one waits for a real
    navigation (the runtime navigates to a relevant page, such as the trolley or a search URL)
    as well as the gap. Run 1 made 4 with none.
  - **At most 4 direct API calls a minute**, and 60 an hour.
  - **Prefer page-initiated reads.** Navigating to a search URL and reading the response the
    page fetched itself counts as a navigation, not a direct call.
  - **Cache reads for the session:** search and product detail until the session ends; the
    trolley until any write, after which the write's own response is the new cached trolley.
  - **Cool-down:** 30 minutes after any block, doubling up to 6 hours on repeat blocks,
    persisted across restarts. No call reaches the site during it.
- A realistic weekly shop (about 30 tool calls, many served from cache) then takes roughly
  15–30 minutes. That's slow for a bot and fine for an agent doing a shop in the background.
- **Where the code is.** Round 1's runtime has the minimum gap and the cool-down only, with looser
  defaults (2 s; 10 minutes doubling to 2 hours, which are also core v2's `limits` defaults), in
  memory, with no jitter, no per-page-view or per-minute cap, and no read cache. Reconciling the
  two is [D33](#d33-breaker-defaults-and-persistence).
- **What it covers.** The budget and breaker sit in the runtime's guarded page and probe, so they
  see `page.fetch`, `goto` and the probe only. Navigations the page makes, clicks that submit,
  `evaluate()` fetches, the site's own requests and the whole login go unpaced and unwatched for
  block pages. Closing that is [D55](#d55-driver-level-budget-and-block-detection).
- Recommendation: start here and loosen only with evidence from M2 and M3, never the other way
  round. A test asserts the run 1 pattern can't get through the defaults unspaced.
- Blocks: M2.

### D29. Pause, overnight and scheduled use

- Question: should agents be able to call tools at any hour? A login at 3 am with no human
  activity looks odd to a bot detector, and a `needsUser` at 3 am helps nobody.
- Recommendation: an optional "quiet hours" setting that returns `needsUser` with a clear reason
  instead of logging in during them; reads on an existing session still work.
- Blocks: nothing in the MVP; useful in M4.

### D30. Split add-to-cart

- Options: keep one `set_cart_quantity` (destructive, idempotent); add an additive
  `add_to_cart` alongside it (`destructiveHint: false`), so clients can auto-approve adds while
  still prompting for removals.
- Considerations: whether clients auto-approve on annotations is up to each client, and
  annotations are hints. But "add these five things" is most of a weekly shop, and prompting for
  each add would be tiresome. The runtime can't enforce "additive only" against the trolley
  update endpoint, which takes absolute quantities, so `add_to_cart` would read the trolley and
  write current + n, and its additive claim is the adapter's code, not a runtime guarantee.
- Status: overtaken by round 1. The adapter already ships `add_to_cart` (and `remove_from_cart`)
  alongside `set_cart_quantity`, and the MCP server derives `destructiveHint: true` for every
  `write` tool, so `add_to_cart` is advertised as destructive and clients still prompt for it.
  It stays that way until C9 lets a tool declare itself non-destructive.
- Recommendation: keep the tools as they are, destructive, for the MVP. With C9, mark
  `add_to_cart` non-destructive in M4 if the prompts are annoying in practice, knowing its
  additive claim is the adapter's code.
- Blocks: nothing in the MVP.

### D31. `retry` count semantics

- Today: `retry: { times: n }` runs its steps up to `n + 1` times, and the auth-flow tests pin
  that. Core documents only the range, 1 to 5.
- Options: keep "`n` retries after the first run" and document it in core; change it to `n` runs
  in all.
- Considerations: most authors will read `times: 2` as two runs, and get three. The extra run
  matters only where a `retry` wraps a submit, and D32 stops a second password submit anyway.
- Recommendation: keep the semantics, document `times` in core as "extra attempts after the
  first", and rename the field to `retries` at the next manifest `schemaVersion` (C13).
- Blocks: nothing. The Woolworths flow uses no `retry`.

### D32. Which failures retry

- Nick's answer (2026-11-07): Accepted.
- Two places retry: the `retry` step inside a login, and (designed) the runtime re-running a tool
  once after a re-login.
- Today `retry` re-runs after `auth-step/condition-timeout`, `auth-step/element-missing`,
  `auth-step/auth-failed` and `probe/not-logged-in`, and never after anything from `secret-fill`,
  `otp`, `grant` or `credential`, a block, `needsUser` or a timeout. The last two retryable ones
  happen after a password submit, so a `retry` around the fill can submit the password twice,
  which AC10 forbids.
- Options: keep the set; drop `auth-failed` and `not-logged-in` from it; have the filler count
  password fills per login and refuse a second whatever the steps say.
- Recommendation: both of the last two. `retry` only covers "the page wasn't ready yet"
  (`condition-timeout`, `element-missing`), and the filler refuses a second password fill in one
  login, ending it as `needsUser(login-required)`. For tools: after a re-login, the runtime
  re-runs a tool once only if it is `read` and failed `tool-run/not-logged-in`. Never a `write` or
  `irreversible` tool, whose request may already have reached the site (the adapter's
  `add_to_cart` would add twice).
- Blocks: M2. The second-submit refusal is a hard requirement before the first live automated
  login, with the attempt marker.

### D33. Breaker defaults and persistence

- Today: one rate budget and breaker per host, in memory, covering `page.fetch`, `goto` and the
  probe only ([D55](#d55-driver-level-budget-and-block-detection)); a 2 s minimum gap; a 10 minute
  cool-down doubling to 2 hours; the doubling resets on the next normal response. Core v2's
  `limits` defaults match the code (`minGapMs: 2000`, `cooldownSeconds: 600`,
  `maxCooldownSeconds: 7200`). [D28](#d28-rate-budget-defaults) recommends much stricter numbers
  for Woolworths and a persisted cool-down.
- Questions: whose numbers; whether and where to persist; what the budget and breaker are keyed
  on, and whose limits win when two adapters declare the same host.
- The keying disagrees today. Core's `manifest.ts` documents `minGapMs` as "across all of this
  adapter's runs" (per adapter). The runtime, the security model, the architecture and the
  `breaker-opened` event key per host, shared by every adapter. This decision's first draft said
  per manifest (every origin in one manifest's `navigation` and `egress`). With limits declared
  per manifest, two adapters on one host with different `minGapMs` or `cooldownSeconds` have no
  defined result.
- Options for persistence: none (a restart closes the breaker); a small `breakers.json` in the
  data directory; rebuild at start from the last `breaker-opened` per host in the audit log.
- Recommendation:
  - The Woolworths manifest sets D28's gap and cool-downs in its own `limits`. Core's defaults stay
    the floor for other adapters, and `limits` gains D28's per-minute and per-page-view caps
    (C10), which nothing has today.
  - Persist by rebuilding from the audit log at start. It is already fsynced and hash-chained, so
    there's no second file to keep consistent, and a restart can't be used to skip a cool-down.
  - Key both the budget and the breaker per host, shared by every adapter, and apply the
    strictest limits of all approved adapters that declare that host (the largest `minGapMs`,
    `cooldownSeconds` and `maxCooldownSeconds`). The site sees one person, one IP and one
    browser, not adapters, so one adapter tripping a block page stalling another's calls to that
    host is correct, not a bug. A block on the auth host during a login doesn't open www's
    breaker, but the login ends `blocked` and the attempt marker's backoff holds further logins.
  - Fix core's `minGapMs` comment to match (C20).
- Blocks: M2.

### D34. Form-action origin: granted or navigation

- Today: a password's owning form must post to an origin in the secret's granted origins. A
  round-1 reviewer asked whether the navigation list would do, since the navigation guard already
  checks where the page goes.
- Options: granted origins (today); navigation origins; granted origins plus an explicit
  per-secret `formActions` list for sites whose login form posts to another origin.
- Considerations: the navigation guard fires only after the POST has left, and a navigation-only
  rule would allow a password into a form that posts to a www search endpoint, the case the check
  exists for. Auth0 posts to its own origin, so Woolworths passes either way.
- Recommendation: keep the granted origins. If a real site posts cross-origin, add a per-secret
  `formActions` list to the manifest, shown on the approval screen, rather than loosening the rule.
- Blocks: nothing now.

### D35. The attempt marker after a timeout

- Nick's answer (2026-11-07): Accepted.
- Today: the marker is set before the login runs. A crash, abort or flow timeout leaves it set,
  and every later login returns `needsUser(login-attempt-pending)` until the person clears it.
  There's no UI to clear it yet.
- Problem: a timeout before any password was typed (a slow Auth0 page, a silent redirect that
  stalled) stops unattended use until Nick notices, though no attempt against the account was
  spent.
- Options: always need the person; record in the marker whether a password fill started (the
  filler updates it, fsynced, before typing), and turn a marker with no fill into an ordinary
  backoff hold; clear every marker after a fixed time.
- Recommendation: the second. With a fill, the tray says "Woolworths: a login was interrupted after
  the password was typed. Check you can still log in, then clear." with a Clear button. Without
  one, it's a backoff hold that clears itself. A fixed-time clear risks a lockout loop.
- Blocks: M2, before the first live automated login. Needs the filler to report "password typing
  started" to the runtime.

### D36. Redaction: whole string or substring

- Today: a string that contains a sensitive value is replaced whole with `[redacted]`, object keys
  included, and the call fails if the serialised result still contains one.
- Options: whole string (today); replace only the matching substring; fail the call whenever
  anything sensitive appears.
- Considerations: substring replacement keeps more of the output but leaves the text around the
  match, which can hold another encoding or a fragment of it. Failing the call is safest, but one
  echoed cookie value would then break a tool outright, where whole-string replacement loses one
  field.
- Recommendation: keep whole-string replacement, and record how many strings were redacted in
  `tool-finished` (C14), so a tool that keeps tripping it gets fixed. Encoded copies stay out of
  scope; output schemas and `httpOnly` cookies are the main defence.
- Blocks: nothing.

### D37. Cross-origin iframe logins

- Today: the driver refuses to focus or click an element in an out-of-process (cross-site)
  frame, and the flow ends in `needsUser`. Core v2's `inputReachable` makes that a check before
  the fill.
- Options: refuse (today); turn site isolation off process-wide, which the e2e suite showed lets
  `sendInputEvent` reach the frame; type through CDP `Input.dispatchKeyEvent` on the frame's
  target; navigate the auth page to the frame's URL directly, when it's on `navigation`.
- Considerations: turning site isolation off weakens Chromium's process isolation for every page
  in every partition, including tool pages running adapter code. CDP input is per frame and
  still trusted input, but attaches a debugger to the auth page. Loading the frame's URL directly
  often breaks the flow.
- Recommendation: refuse until a real site needs it, then CDP input, with the same per-keystroke
  origin check. Never turn site isolation off.
- Blocks: nothing for Woolworths: Auth0 Universal Login is a top-level page.

### D38. Keystroke events

- Nick's answer (2026-11-07): Accepted.
- Today: one `char` input event per character.
- Options: `char` only; `keyDown`, `char` and `keyUp` per character, as a physical keyboard
  produces; CDP `Input.insertText`.
- Considerations: some forms listen for key events, and bot-detection scripts look at keystroke
  pairs and timing. A stream of `char` events with no `keyDown` is not what the person's own
  browser produces, so the full sequence is the D24-consistent choice: it matches the person,
  and goes no further. `insertText` looks least like typing.
- Recommendation: `keyDown`/`char`/`keyUp` per character, with the origin check before each
  `keyDown`, tested against the fake site and in the e2e suite. Characters with no key fall back
  to `char`.
- Blocks: M2.

### D39. Auth subframe origins

- **Resolved** by core v2. Subframes of an auth page may load only `navigation` origins plus
  `auth.frameOrigins` (default empty). The round-1 driver allowed any https subframe and relied
  on the secret-fill binding; it adopts the list in round 2. For Woolworths, `frameOrigins` is
  whatever Auth0's bot detection embeds, measured in M2.
- Still open: when the window is handed to the person, a CAPTCHA frame the manifest didn't list
  is blocked, so they can't solve it. Recommendation: on hand-off, after the interpreter has
  stopped and will type nothing more, the subframe rule relaxes to any https origin for that
  window, and is restored for the next login.

### D40. Storage handoff document

- Today: storage keys are read and written in a page on their origin. An open page is reused;
  otherwise a hidden page loads `/robots.txt` on that origin, in each partition. That's an extra
  request to the site outside the rate budget, and an unusual one for a browser to make.
- Options: `/robots.txt` (today); the manifest's `home`; a path the manifest names; reuse only:
  hand off while the login's last page and the tool page are open, and fail otherwise.
- Recommendation: reuse only. The auth flow ends on a page of the site, and the tool page is open
  at `home`, so no extra request is needed. Keep the `/robots.txt` fallback off by default.
- Blocks: the first adapter with storage keys. Woolworths has none.

### D41. Stable MCP port and token rotation

- Nick's answer (2026-11-07): Valet must work from cloud environments, which need an HTTP MCP
  endpoint, and that comes right after the MVP. So: local clients use the bridge (no fixed port);
  cloud clients use the app-side remote mode from [relay.md](relay.md), built straight after M3
  rather than in M9, with as few duplicate code paths as possible. The shape agreed: one
  Streamable HTTP handler and one MCP server, mounted on two listeners that differ only in an
  `authenticate(request)` hook returning a client identity marked `local` or `remote` (the local
  listener checks a per-client token, D42; the remote one checks OAuth access tokens from the
  in-app authorisation server). The remote policy is a wrapper around the same `ToolCaller`, and
  every call still goes through the same `ToolHost`. The bridge and Funnel only move bytes. Open:
  whether cloud Claude Code sessions can finish an interactive OAuth sign-in; if not, a
  long-lived per-client token through the same hook.
- Today: a free port each launch, and one token written to a 0600 file. The stdio bridge re-reads
  its config, so bridged clients survive a restart. HTTP-native clients (Claude Code over HTTP)
  keep the URL and token in their own config, and break on every restart.
- Options for the port: random each launch (today); fixed and configurable; chosen once at first
  run and kept. For the token: never rotated; rotated on demand from the app; rotated every
  launch; one per client (D42).
- Considerations: a fixed port has a cost. While the app isn't running, another local account can
  bind it, and an HTTP-native client would hand it the token. The bridge doesn't have that
  problem: it reads the current port from a file only the person can read.
- Recommendation: make the bridge the default setup for every client. Offer a port chosen once and
  kept only for clients that can't launch a command, with the risk stated next to the option.
  Rotate tokens on demand ("Reset access" per client in the app), never on a timer, and move to
  per-client tokens (D42).
- Round 3: the app keeps its port (the bridge reads it from `bridge.json`) and issues a new token
  at every launch, since no HTTP-native setup exists yet to use a long-lived one. The bridge
  follows the new token on its own.
- Blocks: M3 (onboarding, AC3).

### D42. Per-client tool scopes

- Nick's answer (2026-11-07): Accepted: a token per client in M3.
- Today: any client with the token sees every approved tool, and the audit log's client name is
  whatever the client says in `initialize`.
- Options: one token, all tools (today); a token per client, named by the person, with identity
  from the token; per-client tool allowlists on top.
- Recommendation: a token per client in M3. It gives the audit log a real identity (C12) and lets
  one client's access be revoked alone; the mockups already show it. Per-client allowlists in M4,
  where a new client gets read tools, write tools are switched on per client, and `irreversible`
  tools still need the person's confirmation per call. The remote listener reuses the same
  allowlists.
- Blocks: M3 (tokens), M4 (allowlists).

### D43. Keychain and vault names

- Keychain items and grants outlive renames, so these are fixed before the first signed build.
- Options: derive every name from the bundle ID ([D1](#d1-product-name)); fixed names now.
- Recommendation:
  - Keychain items named from the bundle ID: service `<bundle id>.onepassword-service-account`
    for the token (account: the 1Password account's sign-in address), and
    `<bundle id>.mcp-client.<name>` per client token if those move from files to the Keychain.
  - The 1Password vault called "Valet".
  - Grants store item references by vault and item **ID**, not name (`op://<vault id>/<item id>`
    is already accepted), so renaming a vault or item in 1Password doesn't silently break or
    redirect a grant. The grant picker shows names.
- Blocks: M3.

### D44. `op` install path

- Today: `op` is found on `PATH`. An app started from Finder has a minimal `PATH`, and a `PATH`
  lookup runs whichever `op` comes first. A substitute `op` can't get secrets out of 1Password
  (the desktop app checks the caller), but it can hand back a wrong password and spend a login
  attempt, or log which items are used.
- Options: `PATH`; probe the known install locations (`/opt/homebrew/bin/op`,
  `/usr/local/bin/op`) at onboarding and pin the absolute path; also verify the binary's code
  signature against 1Password's Team ID before each use; drop the CLI for `DesktopAuth`
  ([D7](#d7-1password-fallback)).
- Recommendation: D7 first. If the CLI stays: find it at onboarding, pin the absolute path,
  refuse a binary or directory writable by anyone but root or the person, and check its signature
  before each use.
- Blocks: M3.

### D45. Grant file location

- Today: the runtime, credentials and mcp-server packages take file paths from the caller. Only
  the bridge config's path is documented.
- Options: everything under `~/Library/Application Support/<app>/`, a 0700 directory with 0600
  files; grants in the Keychain; grants only as events in the audit log.
- Considerations: files are simple and inspectable, but any process running as the person can
  edit them, and v0 tool code runs in the main process. An edited grant (another item, another
  origin) would be honoured.
- Recommendation: Application Support, one directory, as the architecture lists. Before
  third-party adapters (M7), `grants.json` and `approvals.json` carry a MAC keyed by a secret in
  the Keychain under the app's designated requirement, so an edited file fails closed; the audit
  log's latest hash gets the same, since a chain alone can be recomputed by whoever edits it.
- Blocks: M3 (location), M7 (integrity).

### D46. Touch ID on irreversible confirmations

- Options: a click in the app's window; Touch ID (`systemPreferences.promptTouchID`) as well; the
  macOS account password.
- Considerations: a click can come from anyone at the unlocked Mac, or from a UI-automation tool
  the person runs, including an agent with computer use, which is exactly the kind of client this
  confirmation exists to keep out. Touch ID proves presence. It isn't available on every Mac, or
  with the lid closed.
- Recommendation: Touch ID for `irreversible` confirmations when it's available, otherwise the
  click with a note saying so; nothing extra for `write`. Build it with the first `irreversible`
  tool, since v1 ships none ([D18](#d18-irreversible-tools-in-shipped-adapters)).
- Blocks: the first `irreversible` tool.

### D47. Grant re-bind on update

- Today: an update has a new hash, inherits no grant, and the person grants again. The mockup
  offers a re-bind, off by default.
- Options: always grant from scratch; offer a one-click re-bind of the same item when the secret's
  request didn't expand (the same or fewer fields and origins, the same Messages sender); re-bind
  automatically in that case.
- Recommendation: offer it, unticked, next to the approval diff, only when nothing expanded; audit
  `grant-made` with the new hash. Never automatic: the point of hash-keyed grants is that the
  person looks.
- Blocks: M4 (updates).

### D48. Tool titles with the adapter name

- Today: the MCP title is the manifest's `title` ("Get cart"), and the name is namespaced
  (`woolworths_get_cart`).
- Options: the bare title; "Woolworths: Get cart", built by the server from the adapter's `name`;
  no title.
- Considerations: clients show titles in permission prompts, where "Get cart" doesn't say which
  site. The adapter's `name` is manifest text, so a hostile adapter could call itself something
  else; the approval screen shows the id and name together, and the person approved both.
- Recommendation: the server prefixes the adapter's name. The manifest's title stays bare.
- Blocks: nothing.

### D49. Cancellation

- Today: the endpoint passes the client's abort signal to the runtime, which aborts the tool's
  signal, and the tool's capabilities refuse from then on. The bridge never answers a cancelled
  request.
- Open: what a cancel does to a login in progress, and to a write already sent.
- Options for a login: abort it at the next step; let it finish, detached from the call.
- Recommendation: before any secret is typed, abort the login at the next step. After, let it run
  to a classified outcome, bounded by its own timeout, so the marker is cleared by a result
  rather than left set (D35); the call itself returns at once as `aborted`. A write that may have
  reached the site isn't undone; the audit records the stage where it stopped. Tool code checks
  `ctx.signal` before each write, as the Woolworths adapter does.
- Blocks: M1 (wiring).

### D50. Confirmation and hand-off timeouts

- Today: the confirmation waits 5 minutes, a tool run 2 minutes, and the auth flow has its own
  timeout (the Woolworths steps can pause for about 60 s). The hand-off isn't wired. Clients have
  their own tool-call timeouts, which haven't been measured.
- Options for a hand-off: block the call until the person finishes; return `needsUser` at once
  and leave the window up; block for a short bound, then return `needsUser`.
- Recommendation: return `needsUser` at once and leave the window up for up to 15 minutes, then
  close it and hold logins for a backoff. The agent can tell the person and call again. For
  confirmations, keep the call open with MCP progress notifications for up to 2 minutes (or the
  client's timeout, if shorter), then decline ([D19](#d19-confirmation-when-nick-is-away)).
  Measure Claude Code's and Claude Desktop's timeouts in M2 and set these below them.
- Blocks: M3.

### D51. Approval acknowledgement friction

- Question: how much the approval screen asks of the person.
- Options: one Approve button; a tick per permission-expanding change; typing the adapter's name
  for anything `irreversible`.
- Recommendation: friction in proportion to the change. A first install: one Approve, after the
  summary. An update that expands nothing: one click. An update that expands anything (a host, a
  secret or its origins, a Messages sender, a `write` or `irreversible` tool or request): a tick
  per expansion before Approve enables. No typing. Revisit when the authoring agent (M6) makes
  updates frequent.
- Blocks: M3 (the approval screen).

### D52. Confirmation panel placement

- Options: the tray popover; a standalone window from the main process, on top and centred; a
  system notification with action buttons.
- Considerations: a notification's buttons can be pressed without reading the request, and Focus
  modes hide them. A popover vanishes when focus moves. The person has to see the
  runtime-rendered request (C4).
- Recommendation: a standalone window on top, with a notification that only opens it. It has no
  default button, so a keystroke meant for another app can't approve.
- Blocks: M3, with C4.

### D53. Fake trolley merge at login

- Question: when a visitor with items in an anonymous trolley logs in, does Woolworths merge them
  into the account's trolley, replace it, or drop them? The fake shows the account's trolley after
  login and drops the anonymous one; that was a guess.
- Why it matters: the tool partition is anonymous until the first handoff, and the search tools
  run there without logging in. Cart tools call `ensure()` first, so nothing should be added
  anonymously, but if something were, a merge would change Nick's real trolley at login.
- Options: model replacement (today); model a merge; record it live first.
- Recommendation: record it live in M2 with one cheap item, make the fake match, and add an
  adapter test that no cart tool writes before `ensure()` returns `ok`.
- Blocks: M2.

### D54. Cart line ceiling

- Today: the adapter refuses more than 50 of one product: `set_cart_quantity` takes 0 to 50, and
  `add_to_cart` won't go over 50. The site clamps to its own supply limits (often 36) and the tools
  report that.
- Options: 50; the site's usual limit; a lower cap; no cap.
- Considerations: the cap guards against an injected or confused client ("set 999 milk"), not a
  site rule. A weekly shop rarely needs more than a dozen of anything, and a lower cap bounds the
  harm a misused `write` tool can do (R6).
- Recommendation: 20 per line, raised only if real use hits it.
- Blocks: nothing. An adapter change.

### D55. Driver-level budget and block detection

- Nick's answer (2026-11-07): Accepted.
- Today: the rate budget and circuit breaker live in the runtime's guarded page and probe. They
  see `page.fetch`, `goto` and the probe, nothing else. The guarded page leaves requests the page
  makes, or that `evaluate()` code makes, to the driver, and the driver has no budget or
  breaker. Core v2's `ToolRunPolicy` has no rate field either. So `evaluate()` fetches, clicks
  that submit or navigate, the site's own XHRs and Akamai sensor POSTs, page navigations and the
  whole login in the auth partition are neither paced nor watched for block pages. A block page
  the site serves to a page-initiated request doesn't open the breaker, and calls keep coming.
- Why it matters: run 1's block came from a burst of requests. AC7 fails if anything bypasses
  the budget, and AC9 says no call reaches the site during a cool-down. Neither can pass.
- Options: leave it (tools must use `page.fetch` and `goto`; reviewers reject adapters that
  don't); move the budget into the driver entirely; split it: the runtime keeps the budget and
  breaker, the driver reports to them and asks them.
- Considerations: the driver sees every request in both partitions with its resource type and
  status, so it is the only place that can spot a block page served to a page-initiated request
  or a login. But pacing every subresource would break pages; only main-frame navigations are
  worth spacing, and the site's own XHRs follow from them. Keeping the state in the runtime keeps
  one breaker per host whichever partition saw the block.
- Recommendation: split it (C16). The driver reports block signatures (a 403 HTML page, Akamai's
  "Access Denied … Reference #" page, a 429) on navigations and API calls in both partitions to
  the runtime's breaker, and waits on the runtime's budget before each main-frame navigation,
  tool- or page-initiated, in both partitions. An open breaker cancels every request to that
  host in the tool partition and ends a login as `blocked`. AC7's test then counts requests at
  the fake site, not at the capability API.
- Blocks: M2 (AC7 and AC9, and every live test).

### D56. URL regex deadline

- Today: `urlRegex` conditions run synchronously in the main process. On `main` the auth flow
  compiles and runs them with a 2,048-character bound on the path and query, no screen and no
  deadline. Core v2 adds the parse-time screen, which stops exponential shapes but not polynomial
  ones such as `\d*\d*\d*\d*x`: at 2,048 characters a degree-4 pattern needs on the order of
  10^13 steps. A hostile adapter controls the pattern, and through `goto(url)` to its own
  navigation origins, the input too. That freezes the trusted main process: logins, the MCP
  endpoint and the audit log. OTP patterns already run in a worker under a deadline.
- Options: run `urlRegex` in the same worker-with-deadline as OTP patterns, a timeout counting
  as "doesn't match"; cap quantifiers per pattern (say at most two unbounded ones) and lower the
  input bound to about 256 characters; drop `urlRegex` and keep only `urlContains`.
- Considerations: `waitFor` polls its condition, so a worker round trip per poll costs latency,
  but conditions are polled every few hundred milliseconds at most, and a worker can be kept for
  the length of a login. A quantifier cap is cheap but is another screen that a cleverer shape
  might pass. Most real login flows only need `urlContains`.
- Recommendation: the worker with a deadline (C19), shared with the OTP matcher, and the input
  bound lowered to 256 as well. Until then, reject `urlRegex` in third-party manifests, and
  prefer `urlContains` in first-party ones.
- Blocks: M7 (third-party adapters). Nothing for Woolworths, whose flow needs only `urlContains`.

### D57. Blocked-request target

- Today: the round-1 driver reports a blocked request's target as the origin plus a 16-hex digest
  of the path, on purpose: tool code chooses the whole URL of a request it wants blocked, so a
  path can carry a session token into the audit log. Core v2's `BlockedRequest.target` is origin
  and path.
- Options: origin plus path digest (round 1); origin and path, through output redaction;
  origin only.
- Considerations: redaction catches only verbatim cookie and secret values, so an encoded token
  in a blocked path would be stored in the audit log, which is kept and may be shared to debug.
  The digest still lets the person see that the same path was blocked again, and match it
  against a path they already know. A readable path helps when an adapter breaks, but the
  developer can reproduce that against the fake site.
- Recommendation: keep origin plus path digest in `request-blocked` (C18).
- Blocks: M1 (the audit event's shape).

### D58. Page-initiated traffic

- Nick's answer (2026-11-07): Accepted.
- Today: core v2's policy holds the site's own API calls to the declarations, and counts
  navigations and API calls, the site's own included, against one ceiling
  (`limits.requestsPerRun`). The Woolworths manifest sets `requestsPerRun: 6` and declares only
  its tools' four endpoints. The site makes several calls on load, including Akamai's sensor
  POSTs. Under the v2 policy a home-page load can exhaust the ceiling, and the sensor POSTs are
  cancelled, which probably makes bot detection worse, against D24's intent. Declarations have
  no host, so declaring the sensor path on `acs.woolworths.com.au` also allows it on www, and
  it would have to be labelled `read`. G1's own warning (keep the partition-wide ceiling apart
  from the `page.fetch` count) was lost when core v2 merged them. Separately, deny segments apply
  to every resource type today, scripts included (R17).
- Options: one ceiling and per-host declarations; two ceilings, one for tool-initiated requests
  (what `requestsPerRun` was meant for) and a larger one for page-initiated navigations and API
  calls; for the site's own non-GET traffic, a host-scoped `telemetry` list (C8 reduced) or
  `host` on declarations with a purpose of its own.
- Considerations: the driver can't tell which world started a request, but the runtime knows
  which requests it made itself (`page.fetch`, `goto`), so it can count those separately. A
  telemetry list says plainly on the approval screen what it is; a `read` label on a sensor POST
  says something false. Cancelling a site's own sensor traffic is the kind of difference from the
  person's own browser D24 tells us to avoid.
- Recommendation: two ceilings (C17); `host` on declarations, defaulting to the home host, with
  the site's own non-GET background calls declared on their real hosts under a `telemetry`
  purpose that ranks with `read` and that no tool can call through `page.fetch`; and deny
  segments limited to R17's resource types. The Woolworths numbers, hosts and paths come from
  M2's measurement, and the manifest is fixed before the driver adopts the v2 policy.
- Blocks: M2. Until it's decided, the current Woolworths manifest breaks under the v2 policy.

### D59. Several Messages senders

- Today: a grant is one record per adapter, content hash and secret, and Messages codes are
  granted under the reserved secret `messages` with the sender handle as `itemRef`. So an adapter
  has one `messages` grant and one sender. `messagesSourcesIn()` can return several senders, and
  a manifest with two can't be fully granted.
- Options: one Messages sender per adapter, enforced when the manifest is parsed; a grant per
  sender (the secret becomes `messages:<sender>`, or the grant's key gains the sender); one grant
  whose `itemRef` holds a list.
- Considerations: sites that send codes from two numbers exist (a short code and a long number,
  or a change of provider), but none we target does. A list in `itemRef` muddies a field every
  other provider uses for one item. A grant per sender keeps each approval explicit.
- Recommendation: one sender per adapter for now, as a parse-time rule (C19), and a grant per
  sender if a real site needs two.
- Blocks: nothing for Woolworths.

### D60. The stdio bridge in a packaged app

- Nick's answer (2026-11-07): The small Swift proxy, as recommended. Off-the-shelf `mcp-remote`
  was considered and rejected: it needs Node and npm at every start, and it pins a fixed URL and
  token, which brings back D41's port problem. The Swift proxy is a second implementation of the
  TypeScript bridge, so both run against one shared test suite.
- Today: client snippets start the bridge with `tsx` from the repo, which needs Node 24 on
  `PATH`. A packaged build has no bridge command and shows no snippets. The `RunAsNode` fuse is
  off, so the app's own Electron binary can't run the bridge as Node.
- Options: a tiny separate binary in the app bundle (a Node single-executable app, or a small
  Swift or Go stdio-to-HTTP proxy), signed with the app; a second, unfused helper Electron
  binary; tell people to install Node and run `npx`.
- Considerations: the bridge only reads `bridge.json` (0600) and forwards bytes, so it is small
  in any language. A Node SEA is about 90 MB; a Swift or Go proxy is about 2 MB and has no runtime
  to keep patched. A second Electron binary doubles the bundle and brings back the fuse problem.
  `npx` asks every user to install Node and trusts a registry at every start.
- Recommendation: a small Swift proxy in `Contents/MacOS/`, signed with the app and covered by
  its designated requirement. Snippets point at its absolute path in the installed app.
- Blocks: M3 (onboarding, AC3).

### D61. The update feed's signing key

- Nick's answer (2026-11-07): 1Password, not a hardware key. The key goes in its own vault, apart
  from the credentials vault, and the release script reads it with Touch ID.
- Today (round 3): the feed carries an Ed25519 envelope over `latest-mac.yml` with an expiry, a
  version floor and the yml's hash. The app verifies it with a public key fixed at build time,
  before electron-updater sees the yml. Apple's signature on the zip is checked as well. Nothing
  yet decides where the private key lives.
- Options: an offline key in 1Password (a "valet release" item, used by the release script
  through `op read`); a key in the release Mac's Keychain; a hardware key (YubiKey, Ed25519 over
  PIV or OpenPGP).
- Considerations: the envelope only matters if the feed host (D23) is compromised, and must expire
  (62 days at most), so the release script re-signs the feed regularly even without a release.
  A hardware key makes that chore manual; 1Password keeps it scriptable with Touch ID.
- Recommendation: 1Password, in a vault apart from the "valet" credentials vault, read by
  the release script with Touch ID. Re-sign the feed monthly from a reminder.
- Blocks: M3 (first signed build).

### D62. Electron 44's unnamed ninth fuse

- Today: `@electron/fuses` 1.8.0 names eight fuses. Electron 44's fuse wire has nine, and the
  ninth is left as shipped (on). The packaged smoke reads the wire and checks the eight it knows.
- Options: leave it as shipped until `@electron/fuses` names it; read Electron's source for what
  it is and decide now.
- Recommendation: look it up when we bump `@electron/fuses`, before the first signed build; until
  then, the smoke fails if the wire's length changes again.
- Blocks: M3.

### D63. What the auth probe can't hide

- Today (round 3): the login probe (`AuthPage.fetch`) is a main-process `net.request` in the auth
  partition, built to send what the auth page's own `fetch(url, {credentials: 'include'})` sends:
  the same headers in Chrome's order and casing, client hints, `Origin` and `Referer` by the
  page's policy, and `Sec-Fetch-Mode: cors`. An Electron e2e test diffs the two. Known
  differences: `Sec-Fetch-Storage-Access` on cross-site targets (Chromium strips it from
  `net.request`), high-entropy client hints a site asks for with `Accept-CH`, and `Sec-Fetch-Site`
  across a chain of redirects.
- Options: keep `net.request` and accept the differences; run the probe as a `fetch` in the auth
  page's own main world (no differences; the site's scripts can see and change it, but the probe
  only reads a boolean and never carries a secret); probe by navigating a hidden auth page.
- Considerations: Woolworths' probe is same-site (`www` and `auth` share a site), so none of the
  known differences apply to it. A page-world `fetch` would be exactly the page, but trusts page
  scripts not to fake the answer.
- Recommendation: keep `net.request` and measure in M2's live session. Move to a page-world fetch
  only if Akamai reacts to the probe.
- Blocks: nothing until M2.

### D64. Group-writable `op` installs

- Today (round 3, decided in code, needs Nick's yes): D44's rule "nothing writable by anyone but
  root or the person" refused Homebrew's own layout, where `/opt/homebrew` and its links are
  `0775` with group `admin`. The app now accepts a group-writable file or directory only when its
  group is `admin` (gid 80) and the person is in `admin`. World-writable paths and every other
  group are still refused, and the code signature check still runs.
- Considerations: any admin can become root anyway, and on a one-person Mac the only admin is the
  person. On a shared Mac with several admins, any of them could swap `op`, but they could also
  replace the app.
- Recommendation: keep the admin exception, stated in the security model.
- Blocks: M3.

### D65. Demo-build test hooks

- Today (round 3): a demo build launched for e2e maps `evil.test` to `127.0.0.1` and exposes a
  main-process global `__valetE2e` (switch the fake to block everything; read the fake's
  trolley). A production `electron-vite build` contains no demo code, no fixtures and no test
  account; only `build --mode demo` does, and a packaged app can't start in demo mode.
- Options: accept hooks in demo builds only; move every hook into the fake site (an HTTP control
  endpoint) so the app has none.
- Recommendation: move what can go into the fake (round 4 adds a hostile page-script variant to
  it), keep the rest, and keep the check that a production build has no demo chunk.
- Blocks: nothing.
### D66. A block page in the person's login window

- Today (round 4): when the person opens the login window and its first page is Akamai's block
  page, the app opens the site's breaker, closes the window and reports `login/blocked-by-site`.
  The person never sees the block page.
- Options: keep that; show the person the page (they may be able to clear it, and the breaker
  still opens); show a short explanation in the app instead, with the time the breaker reopens.
- Recommendation: the explanation in the app. A block page in front of the person invites
  retrying, which deepens the block, and they can't do anything useful on it.
- Blocks: nothing.

### D67. Stopping a login when the call is cancelled

- Today (round 4): a client can cancel a call, and the runtime stops at once, but the automatic
  login it started runs on to the auth flow's own deadline. If that login stops part-way, the
  attempt marker stays set (`login-attempt-pending`) until the person clears it, as after a crash.
- Options: keep it (conservative: the person looks before another password fill); let
  `runAuthFlow` take a signal and report whether any secret was filled, so a cancel before the
  first fill clears the marker by itself. That's a core change to the `AuthRunner` contract.
- Recommendation: the core change, in M2, before the first automated live login. A cancel
  before any fill costs nothing at the site and shouldn't need the person.
- Blocks: nothing before M2's live login.

### D68. What the tray counts

- Today (round 4): the tray says "N clients connected", but N is the number of open MCP
  sessions. One client can hold several, and the bridge/HTTP split isn't shown anywhere.
- Options: say "N sessions"; count distinct clients by the name they give at `initialize`;
  show both in Settings → Clients.
- Recommendation: count distinct clients in the tray, and list sessions by transport in
  Settings → Clients. The names are the client's own claim, so the list says so.
- Blocks: nothing.

---

## What Nick has to do in person

Collected from the above, so tomorrow's review can schedule it.

1. Answer the decisions in [Answer these first](#answer-these-first): D4 (as far as he
   knows: is MFA on his Woolworths account, and which kind?), D5, D6, D8, D18, D24 and D28. Look
   through the [mockups](mockups/index.html) while doing it. Then the round-1 decisions that block
   M2 and M3: D32, D35, D38 and D41.
2. Review `core` and the overnight branches' guards and secret filler line by line (R13).
3. Run spike 1, with the clean Chrome UA: log in by hand in the spike window, close it, read the
   result (~15 minutes).
4. A session to confirm the rest of the Auth0 flow (password page, MFA, the silent redirect), the
   probe, and the checkout and payment request paths up to but not including "Place order"
   (~45–60 minutes).
5. Set up the 1Password vault and service account (~15 minutes), and give the app the token
   through its onboarding, not through chat or a file.
6. Grant Full Disk Access when the OTP reader lands.
7. Make notarisation credentials available in his Keychain for the release script.
8. Use it for two weeks.
