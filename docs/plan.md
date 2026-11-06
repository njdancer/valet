# Development plan

Draft, 2026-11-07. Covers the work from here to a v1 open-source release. Nick reviews it and
answers the [decisions](#decisions). It sits on top of [security-model.md](security-model.md) and
[architecture.md](architecture.md), and doesn't repeat them. Where this plan finds a gap in either,
it says so.

"siteadapter" is a working name throughout ([D1](#d1-product-name)).

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

As of commit `d20fdd8` on `main`:

| Area                    | State                                                                                                                                                                                                                                                                                           |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Docs                    | Security model and architecture drafts. One live finding (the Akamai block).                                                                                                                                                                                                                    |
| `packages/core`         | Done for v0: manifest schema with declarative auth steps, probes, request surface, origin and host matching, `SecretValue`, page and session-driver contracts, credential, grant and OTP contracts, audit events, the error vocabulary and content hashing. Tested.                             |
| Other packages          | Skeletons with their dependencies: `runtime`, `auth-flow`, `credentials`, `mcp-server`, `browser-electron`, `adapters/woolworths`, `fakes/woolworths-site`, `apps/desktop`. Separate overnight branches (`wip/*`) are filling in each one against `core`; they haven't been reviewed or merged. |
| Spike 1                 | Code written (`spikes/01-woolworths-electron`). **Not run.** It needs Nick to log in by hand.                                                                                                                                                                                                   |
| Spike 2                 | Run. The first anonymous probe worked; Akamai blocked the second about three minutes later. See [the finding](findings/2026-11-07-woolworths-live-probe.md).                                                                                                                                    |
| Mockups                 | Design tokens only (`docs/mockups/tokens.css`). The screens are listed under [Desktop UI](#ws5-desktop-ui).                                                                                                                                                                                     |
| Packaging, CI, releases | Nothing yet. The repo is local-only, with no remote and no CI.                                                                                                                                                                                                                                  |

The overnight branches are the biggest unknown in this plan. They're written against fakes by
agents in parallel, so expect integration friction when they meet: shared fakes, how the runtime
drives `auth-flow`, and what `browser-electron` actually implements of `SessionDriver`. Reviewing
and merging them is the first job of [M1](#m1-vertical-slice-against-fakes).

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

- **Evading bot detection.** No stealth plugins, fingerprint spoofing, CAPTCHA solving or
  residential proxies. When a site objects, the person sees the window (`needsUser`) or the call
  fails as `blocked-by-site`. This is a principle, not just a scope cut ([D24](#d24-bot-detection-posture)).
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
   adapter (showing its hosts, secrets, requests and tools), and granting the `login` secret by
   picking a 1Password item. The grant is keyed to the adapter's content hash.
3. The app shows how to connect Claude Code (HTTP plus bearer token) and Claude Desktop (stdio
   bridge), with a copy button for each config. Both list the four tools, with MCP annotations
   matching their side effects (`readOnlyHint` for reads; `destructiveHint: false`,
   `idempotentHint: true` for `set_cart_quantity`).

**Behaviour, live**

4. From a logged-out state, `get_cart` logs in with no human involvement when Woolworths doesn't
   challenge, and returns the trolley. With a challenge the app can't meet (CAPTCHA, unknown
   prompt), the login window appears in front of Nick, and the tool returns `needsUser` within
   the client's timeout rather than hanging.
5. If Woolworths asks for a one-time code by SMS, it's read from Messages and filled, with no
   human involvement, within 60 s of the SMS arriving ([D4](#d4-woolworths-2fa)).
6. `set_cart_quantity` changes are visible in Nick's normal browser on woolworths.com.au after a
   refresh.
7. A realistic session (about 30 tool calls over 20 minutes, the shape of a weekly shop) completes
   without an Akamai block, on three separate days.
8. With the Mac locked and Nick away, a tool call from a scheduled agent succeeds through the
   service account.

**Failure handling**

9. An Akamai block surfaces as `blocked-by-site`, opens a cool-down, and further calls fail fast
   until it ends. No call during the cool-down reaches the site. (Automated against the fake
   site; observed live if it happens.)
10. A wrong password classifies as `auth-failed`, writes the attempt marker, and blocks further
    login attempts until Nick clears it in the app. (Automated.)

**Security**

11. The canary egress suite passes: canary secrets reach only the fake site's login POST, and
    never tool output, traces, logs, the audit log, the MCP transport or any other host. The
    suite also asserts the canaries were actually typed. (Automated, in `pnpm check`.)
12. The hostile-adapter suite passes: an adapter that tries a service worker, `localStorage`
    poisoning, input listeners, exfiltration to an undeclared host, undeclared API paths and
    checkout paths gets blocked on each, and each block is audited. (Automated.)
13. No request to a checkout or payment path leaves the tool partition, whether from
    `page.fetch`, `page.evaluate` or a click. (Automated; see [gap G1](#g1-the-request-surface-only-covers-pagefetch).)
14. The audit log verifies end to end with a CLI command, and tampering with any line makes
    verification fail. (Automated.)
15. A changed adapter (any byte) loses its grants and must be re-approved, with a diff that
    highlights new hosts, secrets and write tools. (Automated.)
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

### M0. Foundations (done, apart from merging tonight's branches)

- Scope: docs, core contracts, workspace tooling, both spikes' code, package skeletons.
- Exit: `core` tested; spike 2 run; findings recorded.
- Remaining: Nick runs spike 1 (part of M2).

### M1. Vertical slice against fakes

- Scope:
  - Review and merge the overnight branches; resolve their interface disagreements.
  - Wire the whole path in plain Node: an MCP client calls a tool over Streamable HTTP; the
    runtime takes the adapter lock, checks the rate budget, runs `session.ensure()`, runs the
    auth flow against a fake `SessionDriver` backed by the fake Woolworths site, fills canaries
    from the fake credential provider, hands off the session, runs the tool, redacts and returns
    the output, and writes the audit log.
  - The stdio bridge.
  - The canary egress suite and the hostile-adapter suite, at the `SessionDriver` level.
  - The rate budget and circuit breaker in the runtime.
- Exit: one Node test drives a real MCP client through the full path and passes; both security
  suites pass; `pnpm check` green on `main`.
- Effort: 3–5 agent-days. Nick: 2–3 hours of review.
- Decisions needed: none blocking. [D11](#d11-adapter-package-format) and
  [D12](#d12-sandbox-technology) shape later work but not this.

### M2. Electron driver and live Woolworths

- Scope:
  - Run spike 1 with Nick: log in by hand, copy the session, call the trolley from the tool
    partition. Answer: default UA vs Chrome UA; does `_abck` survive the copy; does an
    isolated-world `fetch` carry same-origin credentials.
  - Record the real login flow (selectors, redirects, "remember this device", any OTP) in a
    session with Nick present. Confirm a login probe (likely `/api/ui/v2/bootstrap`).
  - `browser-electron`: the real `SessionDriver`, hidden-but-headed windows, tolerant navigation,
    paced `sendInputEvent` typing, the `webRequest` egress guard, partition-wide deny paths,
    WebRTC off, cookie and storage handoff.
  - Electron end-to-end tests with Playwright against the fake site served over local HTTPS.
  - A dev build of the app (unsigned is fine) with the MCP endpoint and no UI beyond the tray.
- Exit: from Claude Code, Nick adds a real item to his real trolley through a dev build, with the
  login automated end to end.
- Effort: 4–6 agent-days. Nick: 3–5 hours, spread over at least two days so the live probing
  stays sparse.
- Decisions needed: [D4](#d4-woolworths-2fa), [D5](#d5-which-woolworths-account),
  [D6](#d6-1password-setup), [D9](#d9-user-agent), [D10](#d10-analytics-hosts).

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
- Decisions needed: [D1](#d1-product-name) (bundle ID, Keychain service names and partition names
  are hard to change once grants and Full Disk Access exist), [D7](#d7-1password-fallback),
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
- Decisions needed: [D1](#d1-product-name), [D2](#d2-licence),
  [D3](#d3-repository-hosting-and-going-public), [D15](#d15-telemetry),
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
wants remote access for himself earlier; documenting cloudflared or Tailscale covers that in the
meantime.

Rough totals to the open-source v1: 45–75 agent-days, 35–50 Nick-hours, and calendar time
dominated by the two-week and one-month use periods. Treat these as ±50%.

---

## Workstreams

Each workstream lists what exists, what's next, and what it depends on. "Next" is ordered.

### WS1. Runtime and security

- Exists: `core` contracts. `wip/runtime` is in progress.
- Next:
  1. Tool-call orchestration: adapter lock, rate budget, `session.ensure()`, auth-on-demand,
     retry-once after re-login, output validation against the tool's zod output schema, output
     redaction, audit events.
  2. Rate budget and circuit breaker, per site, owned by the runtime: minimum gap between
     requests, a per-minute ceiling, jitter, and a cool-down on `blocked-by-site`. The cool-down
     persists across restarts. Defaults for Woolworths are a guess until M2 ([D28](#d28-rate-budget-defaults)).
  3. Login hygiene from the earlier app: the durable attempt marker (fsync before submit), the
     pessimistic outcome classifier.
  4. The audit writer: append-only JSONL, hash chain, fsync per record, a verifier.
  5. Grants: the store, keyed by adapter hash; revocation; the approval diff.
  6. The confirmation broker: the app shows the person a runtime-rendered description of an
     `irreversible` or confirm-gated action ([gap G4](#g4-confirm-takes-adapter-authored-text)).
  7. Output hardening against prompt injection ([R6](#risk-register)).
- Depends on: nothing outside `core`.
- Port from the earlier app: `bank-login-attempt-marker.ts`, `bank-login-outcome.ts`,
  `bank-request-ceiling.ts`, `bank-request-surface-guard.ts`,
  `connector-stage-vocabulary.ts`. Read them; don't copy their bank-specific parts.

### WS2. Browser driver

- Exists: spike code that shows the shape. `wip/browser-electron` in progress.
- Next:
  1. `SessionDriver` for Electron: partitions, hidden-but-headed windows with
     `backgroundThrottling: false`, tolerant navigation, step timeouts, `destroy()` on close.
  2. Network guard in each tool partition: egress allowlist, partition-wide deny paths, the
     per-run ceiling, WebRTC off, blocked requests audited. In the auth partition: navigation
     allowlist on every committed navigation, including subframes.
  3. Element inspection for the secret-fill checks (frame origin, input type, form action).
  4. Handoff: cookies by domain, web storage over CDP `DOMStorage`, one way only.
  5. `needsUser`: show the same window, with app chrome that says why and how to finish.
  6. Check the side channels the security model lists as open (DNS prefetch, `sendBeacon`,
     speculative preconnect) and set the Chromium switches that close them.
- Depends on: spike 1 results (UA, `_abck`, isolated-world credentials).
- Constraint: this package and `apps/desktop` are the only ones that import `electron`.

### WS3. Credentials

- Exists: contracts; `@1password/sdk` 0.5.0 installed. `wip/credentials` in progress.
- Next:
  1. Service-account provider over the SDK, with the token from the Keychain (asynchronous,
     bounded prompts).
  2. Desktop-app provider. SDK 0.5.0 has `DesktopAuth`, which authenticates through the
     1Password app with the person's approval. That likely replaces the `op` CLI fallback
     entirely: no CLI install, no stdout parsing ([D7](#d7-1password-fallback)).
  3. TOTP from 1Password (`secret` OTP source), for sites that use it.
  4. Messages OTP reader: read `~/Library/Messages/chat.db` with `node:sqlite` (built into Node
     24; no dependency), handling the `attributedBody` blob that newer macOS uses instead of
     `text`. Copy the database (and its WAL) to a temp file before reading, so the reader never
     contends with Messages. Needs Full Disk Access ([D8](#d8-full-disk-access-for-messages)).
  5. The fake provider and fake OTP reader for tests (exist in some form on the branch).
- Honest limit: both 1Password paths hand back the secret as a JS string, which can't be zeroed.
  `SecretValue` zeroes its own buffer, but a copy lives in the V8 heap until garbage collection.
  This is acceptable (the main process is the trusted computing base) but the security doc
  should say so rather than imply zeroing is complete.

### WS4. MCP

- Exists: `@modelcontextprotocol/sdk` 1.32.2 installed. `wip/mcp-server` in progress.
- Next:
  1. Streamable HTTP on `127.0.0.1`, random port by default with a fixed-port option, bearer
     token from the Keychain, `Origin` header checked (DNS-rebinding defence).
  2. Tools generated from manifests: names namespaced by adapter (`woolworths_get_cart`),
     annotations from `sideEffect`, input and output schemas from the zod schemas.
  3. The stdio bridge: a small executable shipped in the app bundle that forwards to the HTTP
     endpoint, for Claude Desktop.
  4. Client identity in the audit log: from the bearer token (one token per client, named by
     the person), not from the self-reported `clientInfo`.
  5. Long calls: login with OTP can take a minute. Use progress notifications, and return
     `needsUser` before the client's timeout rather than after.
- Depends on: WS1.

### WS5. Desktop UI

- Exists: tokens. React and its test tools are in the desktop app's devDependencies.
- Screens to mock, in MVP order:
  1. **Tray menu:** status per adapter (logged in, needs you, blocked until 14:20), recent calls,
     "Open control panel", "Pause all", quit.
  2. **Onboarding:** 1Password connection (service-account token or desktop app), vault choice,
     MCP client setup with copyable configs.
  3. **Adapter approval:** identity, version, hash, and the permissions as a person reads them:
     sites it navigates, hosts it contacts, secrets it asks for, each API request with its
     purpose, each tool with its side effect colour (tokens `--read`, `--write`,
     `--irreversible`). For an update, the same screen as a diff, additions highlighted.
  4. **Grant picker:** for each requested secret, choose a 1Password item; show the origins it
     will be typed on.
  5. **`needsUser` window chrome:** a banner over the site window: why it's showing, what to do,
     "Done" and "Give up".
  6. **Confirmation dialog:** runtime-rendered action description, the calling client, approve
     or decline, a timeout.
  7. **Audit log:** filterable list, chain-verified badge, export.
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

- Woolworths: `wip/adapter-woolworths` in progress against the fake site. Real login flow and
  probe come from M2. Read tools should prefer what the page loads itself where that's cheap
  (navigate to a search URL and read the response the page fetched), and keep direct API calls
  sparse and cached, per the Akamai finding.
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

- Starts in M9 at the earliest. Before then, document cloudflared and Tailscale Funnel as
  do-it-yourself remote access, with a warning that it exposes the endpoint and should sit behind
  OAuth or the bearer token.
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

| Layer               | Runs                       | What it covers                                                                                                                                                                                                                                         |
| ------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unit                | `pnpm check`, every commit | Every module in plain Node with injected clock, sleep, spawn, fs paths and network. Explicit tests, no factories.                                                                                                                                      |
| Guard tests         | `pnpm check`               | One adversarial test per guard: the test that tries to get past it (wrong origin, `http:`, a lookalike host, a form action elsewhere, an open redirect, a subframe, `*.` edge cases, encoded paths).                                                   |
| Fake sites          | `pnpm check`               | `fakes/woolworths-site`: real `node:http` servers on port 0, recording every request, with switchable behaviours: login variants, OTP challenge, "remember this device", Akamai-like blocking after fast bursts, anonymous token cookies, shape drift. |
| Canary egress       | `pnpm check`               | Unique canaries through the real login and tool path against the fake site. Assert they appear only in the login POST, and that they were typed.                                                                                                       |
| Hostile adapter     | `pnpm check`               | A fixture adapter that tries every attack in the security model, each asserted blocked and audited.                                                                                                                                                    |
| Electron end-to-end | `pnpm e2e`, before merge   | Playwright's Electron support drives the built app against the fake site over local HTTPS. Repeats the canary and hostile suites with the real driver, plus UI flows (approval, grant, confirm).                                                       |
| Live smoke          | `pnpm smoke:live`, by hand | Gated on Nick ([below](#live-smoke-tests)).                                                                                                                                                                                                            |

### Fake sites over HTTPS

`core` only accepts `https` origins, which is right for production. The fake site therefore
serves HTTPS on `127.0.0.1` with a certificate generated per test run, and the Electron e2e
suite trusts it through `setCertificateVerifyProc` on the test partitions. That trust override
must be impossible in a production build: it lives behind a build-time flag, and a test asserts
the packaged app ignores it. Unit tests that don't need a browser can use the fake site's
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

| #   | Risk                                                                                                                                                                                               | L                    | I   | Mitigation                                                                                                                                                                                                                                                                                                      | Residual                                                                                                     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| R1  | **Bot detection.** Akamai blocked our second anonymous probe within minutes. Automated login, or a burst of tool calls, gets Nick's session or IP blocked, possibly affecting his normal shopping. | H                    | H   | Headed hidden windows, Electron's real Chromium, no UA games unless spike 1 says so. Runtime-owned rate budget, jitter and cool-down. Prefer page-initiated requests for reads; cache. `needsUser` instead of fighting. Live tests rare and paced.                                                              | High. We won't evade, so some sites will simply not work unattended. That's a product limit to state openly. |
| R2  | **Site changes.** Woolworths changes its login, endpoints or response shapes.                                                                                                                      | H                    | M   | Zod output schemas; drift detection in smoke tests; `failed` with a clear class rather than wrong data; the authoring agent (M6) to repair; fixtures recorded from live.                                                                                                                                        | Medium. Every site adapter is maintenance forever.                                                           |
| R3  | **Terms of service and legal.** Woolworths' terms likely prohibit automated access. Publishing an adapter for it, or a marketplace of them, invites a takedown or worse.                           | M                    | H   | Personal use is the person automating their own account. For the release: the person runs it on their own machine with their own credentials; no hosted automation; adapters distributed separately from the framework if advice says so; no evasion. Get advice before M8 ([D25](#d25-adapter-legal-posture)). | Medium until advised. This plan isn't legal advice.                                                          |
| R4  | **1Password limits.** Service accounts can't read personal vaults; rate limits apply; plan eligibility unconfirmed; the desktop-app path needs an unlocked app.                                    | M                    | M   | Dedicated vault; cache nothing, but fetch only at login; desktop-app fallback; `needsUser` with a clear reason when neither works.                                                                                                                                                                              | Low once [D6](#d6-1password-setup) is answered.                                                              |
| R5  | **Electron footprint.** ~250 MB app, a Chromium per window, memory while idle.                                                                                                                     | H                    | L   | Close windows after each run; one hidden window at a time per site; idle with no windows. Measure in M3.                                                                                                                                                                                                        | Low for personal use; a talking point for the OSS audience.                                                  |
| R6  | **Prompt injection through tool output.** Product names, descriptions and reviews are site-controlled text that goes straight to the LLM, which may also hold write tools.                         | M                    | H   | Output is schema-validated structured data with length caps on every string; tools return fields, never page HTML; `irreversible` actions confirmed by the person in the app, never by the client; MCP descriptions note that outputs are untrusted; per-client tool allowlists (M4).                           | Medium. A `write` tool (cart) can still be misused by an injected client; the harm is bounded to the cart.   |
| R7  | **Sandboxing third-party adapters.** `utilityProcess` isn't a security boundary. A malicious adapter could read files or reach the network.                                                        | H (if shipped as is) | H   | No third-party adapters before M7. Sandbox choice in [D12](#d12-sandbox-technology). Hostile-adapter suite against the sandbox itself.                                                                                                                                                                          | Low after M7, if the sandbox is real.                                                                        |
| R8  | **The request surface doesn't bind `page.evaluate` or clicks.** See [G1](#g1-the-request-surface-only-covers-pagefetch).                                                                           | H                    | H   | Enforce deny paths and the per-run ceiling for the whole tool partition in `webRequest`, regardless of initiator.                                                                                                                                                                                               | Medium: declared-path checks for site-initiated requests remain impossible.                                  |
| R9  | **Session exfiltration through tool output.** Exact-match redaction misses an encoded cookie.                                                                                                      | L                    | M   | Woolworths' auth cookies are `httpOnly`, so tool code can't read them. Output schemas reject unexpected fields. Flag adapters whose manifests copy web-storage tokens.                                                                                                                                          | Low for Woolworths; higher for storage-token sites.                                                          |
| R10 | **Full Disk Access is broad.** Granting it to the whole app hands every adapter's host process access to Mail, Safari history and the rest.                                                        | M                    | H   | A tiny signed helper with FDA that only answers OTP queries ([D8](#d8-full-disk-access-for-messages)).                                                                                                                                                                                                          | Low with the helper.                                                                                         |
| R11 | **Lockouts.** A login bug burns attempts and locks Nick's Woolworths account.                                                                                                                      | M                    | M   | Attempt marker; `ambiguous` counts as a failure; at most one automated attempt before `needsUser`.                                                                                                                                                                                                              | Low.                                                                                                         |
| R12 | **Signing and Keychain identity churn.** A bundle ID or Team ID change after launch orphans Keychain items and FDA grants.                                                                         | M                    | M   | Decide the name before the first signed build ([D1](#d1-product-name)).                                                                                                                                                                                                                                         | Low.                                                                                                         |
| R13 | **Agent-built code nobody fully read.** Much of this is built overnight by agents in parallel.                                                                                                     | M                    | H   | Small commits; the security suites as the acceptance bar; Nick reviews `core`, the guards and the filler line by line; an independent review pass before M8.                                                                                                                                                    | Medium.                                                                                                      |
| R14 | **Market.** Few people want to run a local Electron app to give agents site access; the relay doesn't sell.                                                                                        | M                    | L   | Personal use pays off regardless. Waitlist before building the relay.                                                                                                                                                                                                                                           | Accepted.                                                                                                    |
| R15 | **Anthropic terms for the authoring agent.** Offering claude.ai login in a third-party product isn't allowed without approval.                                                                     | M                    | M   | API keys, or the MCP-inverted route ([D13](#d13-authoring-agent-model-access)).                                                                                                                                                                                                                                 | Low.                                                                                                         |
| R16 | **MCP and Electron churn.** Spec revisions, SDK major versions, Electron's eight-week cadence.                                                                                                     | H                    | L   | Pinned versions; a maintenance pass per Electron major; the update feed means users get fixes.                                                                                                                                                                                                                  | Low.                                                                                                         |

---

## Gaps found in the current design

Writing this plan turned up these. Each needs a fix in the docs or code; the ones that touch
`core` are listed as change requests for Nick to approve.

### G1. The request surface only covers `page.fetch`

The architecture says an in-page `fetch` from tool code that matches no declaration is cancelled.
That works for `page.fetch`, which the runtime mediates. But `page.evaluate` runs adapter code in
an isolated world, and that code can call `fetch` or `XMLHttpRequest` itself. `webRequest`
can't tell those requests from the site's own (it doesn't report the world), so it can't apply
declarations to them. Clicking a "Place order" button has the same effect through the site's own
code.

Fix: in the tool partition, `webRequest` enforces, for **every** request whatever its initiator,
the egress host allowlist, the deny segments (checkout, payment and the rest) unless an
`irreversible` tool with confirmation is running, and the per-run ceiling. Declared-path checks
stay on `page.fetch` only. The security model should say plainly that declarations are a
`page.fetch` guarantee, while the deny list and hosts are partition-wide. `SessionDriver` has
no way today to install or change that guard; see change request C2.

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
security model should cover who holds it ([D8](#d8-full-disk-access-for-messages)).

### G9. The probe needs the tool partition, which needs a session first

The probe runs in the tool partition. On a cold start the tool partition has only anonymous
cookies (which on Woolworths include `wow-auth-token`, so a cookie probe is useless). That's
fine with a `fetch` probe, but it means every first call of the day costs a probe request plus a
home-page load. Count them in the rate budget.

### Core change requests

| #   | Change                                                                                                                                                       | Needed by |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| C1  | `limits` gains `minGapMs`, `requestsPerMinute` and `cooldownSeconds` (with defaults), and `AuditEvent` gains `rate-limited` and `cooldown-started`.          | M1        |
| C2  | `SessionDriver` takes a network policy for the tool partition (hosts, deny segments, ceiling, an "irreversible unlocked" flag) and reports blocked requests. | M1        |
| C3  | `EnsureResult.needsUser` and step `needsUser`/`fail` carry a reason code from a fixed vocabulary, with optional manifest text shown only in the app.         | M1        |
| C4  | `confirm()` takes a structured action description; free text becomes an optional, attributed note.                                                           | M3        |
| C5  | A declarative tool-action schema.                                                                                                                            | M5        |
| C6  | Tool input and output JSON Schemas declared in the manifest (generated from zod at build time and checked to match).                                         | M7        |
| C7  | `ProviderKind` gains `onepassword-desktop` for the SDK's `DesktopAuth`, if [D7](#d7-1password-fallback) picks it.                                            | M3        |

---

## Decisions

Each decision has options, a recommendation, and what it blocks. The first table lists the ones
to answer first: they block M2 or M3, or they're expensive to change later.

### Answer these first

| #   | Decision                                   | Recommendation                                              | Blocks     |
| --- | ------------------------------------------ | ----------------------------------------------------------- | ---------- |
| D1  | **Product name**                           | Pick before the first signed build                          | M3         |
| D4  | **Woolworths 2FA**                         | Find out in the M2 session; support SMS via Messages        | M2–M3      |
| D5  | **Which Woolworths account**               | Nick's real account                                         | M2         |
| D6  | **1Password setup**                        | Service account on a new "siteadapter" vault; move the item | M2–M3      |
| D8  | **Full Disk Access for Messages**          | Helper before release; whole app acceptable for M3          | M3         |
| D9  | **User agent**                             | Electron default unless spike 1 says otherwise              | M2         |
| D18 | **Irreversible tools in shipped adapters** | None in v1                                                  | M3, M8     |
| D24 | **Bot-detection posture**                  | No evasion, stated publicly                                 | Everything |

### D1. Product name

- Options: keep "siteadapter"; pick a new name now; pick one at M8.
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

- Options: MIT; Apache-2.0; AGPL-3.0; source-available (e.g. FSL, BSL) for the relay only.
- Considerations: Apache-2.0 adds an explicit patent grant and is common for security-relevant
  infrastructure. AGPL discourages someone hosting the relay as a competing service, but also
  discourages contributors and companies. The relay, if it's the commercial piece, can be closed
  or source-available without touching the app's licence.
- Recommendation: Apache-2.0 for the app, packages and adapters. Decide the relay's licence when
  it exists.
- Blocks: M8.

### D3. Repository hosting and going public

- Options: stay local until M8; private GitHub repo now, public at M8; public now.
- Recommendation: private GitHub repo now, for backup and later CI, public at M8. Public before
  the sandbox (M7) invites people to install third-party adapters the design can't contain yet.
- Blocks: M8; CI before then.

### D4. Woolworths 2FA

- Unknown: whether Woolworths challenges a new device, and how (SMS code, email code, nothing).
  The login page wasn't captured before the block.
- Options: SMS via the Messages reader; email via a mail reader (not planned; would need Mail
  access); `needsUser` whenever a code is asked; 1Password TOTP if Woolworths offers an
  authenticator app (unlikely).
- Recommendation: find out in the M2 session with Nick. Plan for SMS via Messages. Email codes
  fall back to `needsUser` until there's a reason to build a mail reader. "Remember this device"
  in the persistent auth partition should make codes rare.
- Blocks: M2 (auth flow), M3 (OTP reader priority).

### D5. Which Woolworths account

- Options: Nick's real account; a separate test account.
- Considerations: the MVP's point is managing his real trolley. A test account would protect his
  real one from an Akamai block or lockout, but blocks are per session or IP, not per account,
  so it barely helps, and a second account may itself breach the terms.
- Recommendation: his real account, with live tests kept rare.
- Blocks: M2.

### D6. 1Password setup

- Questions for Nick: which plan (Individual, Families, Teams)? Are service accounts available
  on it? Is there a vault he's happy to dedicate?
- Options: move the Woolworths item into a new "siteadapter" vault; duplicate it there; skip
  service accounts and use only the desktop-app path.
- Recommendation: a new vault holding only items granted to siteadapter; **move** the item (a
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

- Options: Electron's default UA (which advertises Electron); a clean Chrome UA with matching
  client hints.
- Considerations: run 1 of spike 2 wasn't refused with the default UA. Changing the UA without
  changing everything else that fingerprints Electron is detectable, and edges towards evasion.
- Recommendation: the default, unless spike 1 shows the default gets refused while logged in and
  a clean Chrome UA doesn't. If it comes to that, decide again in light of [D24](#d24-bot-detection-posture).
- Blocks: M2.

### D10. Analytics hosts

- Options: allow only the hosts the site needs (www, `cdn0.woolworths.media`,
  `acs.woolworths.com.au`); also allow the ~40 analytics and ad hosts.
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
- Recommendation: `.siteadapter` zip with a fixed layout. Authors use TypeScript and a build
  command; the app only ever loads the built bundle. npm and git are authoring conveniences,
  never the distribution channel.
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
- Recommendation: document both tunnels at M3 for Nick's own remote use. Build the relay only
  after M8, and only after a waitlist shows demand.
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

- Recommendation: state it as a principle in the README and docs: siteadapter drives a real
  browser at human pace on the person's own account and machine, and stops when a site objects.
  No stealth, no CAPTCHA solving, no proxies, no fingerprint spoofing. It's the honest position,
  it simplifies the legal story, and it's what makes a security-focused audience trust it.
- Blocks: D9, D25, marketing.

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

- Starting guess for Woolworths, to be tuned in M2: at least 2 s between site requests with
  ±30% jitter; at most 20 requests a minute; a 30-minute cool-down after any block, doubling up
  to 6 hours on repeat blocks; cache reads for 5 minutes within a session.
- Recommendation: start conservative and loosen with evidence, never the other way round.
- Blocks: M2.

### D29. Pause, overnight and scheduled use

- Question: should agents be able to call tools at any hour? A login at 3 am with no human
  activity looks odd to a bot detector, and a `needsUser` at 3 am helps nobody.
- Recommendation: an optional "quiet hours" setting that returns `needsUser` with a clear reason
  instead of logging in during them; reads on an existing session still work.
- Blocks: nothing in the MVP; useful in M4.

---

## What Nick has to do in person

Collected from the above, so tomorrow's review can schedule it.

1. Answer the decisions in [Answer these first](#answer-these-first): D1, D4 (as far as he
   knows), D5, D6, D8, D9, D18 and D24.
2. Review `core` and the overnight branches' guards and secret filler line by line (R13).
3. Run spike 1: log in by hand in the spike window, close it, read the result (~15 minutes).
4. A recorded login session for the real auth flow, the probe and any 2FA (~30–45 minutes).
5. Set up the 1Password vault and service account (~15 minutes), and give the app the token
   through its onboarding, not through chat or a file.
6. Grant Full Disk Access when the OTP reader lands.
7. Make notarisation credentials available in his Keychain for the release script.
8. Use it for two weeks.
