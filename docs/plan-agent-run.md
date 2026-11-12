# Revised plan: agent-run Valet

Draft, 2026-11-12, from Nick's direction in the project thread "Plan agent-run Valet with phone
approvals". It changes everything after the MVP in [plan.md](plan.md). The MVP itself (M3, a
Woolworths order through the MCP) and its live sessions with Nick are unchanged and still come
first for Nick's time.

## The direction in one paragraph

You install Valet on your Mac, give it access to what it needs (1Password, Messages), pair your
phone, and connect the agents you already use. From then on, your agents set Valet up and keep it
working through Valet's own MCP tools: they look at its state, change settings, and write, test and
repair adapters. Anything sensitive asks you first, on the Mac or on your phone, with Face ID or
Touch ID, so you can run all of this from your phone while the Mac sits at home. There is no
built-in chat and no marketplace. Shared adapters are references your agent reads and learns from;
each person's agent writes their own, and you always approve the final adapter.

## What Nick decided on 2026-11-12

| #   | Decision                                             | Answer                                                                                                                                                                                                                                       |
| --- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D72 | Companion app on the phone                           | **A native app.** Every alert and approval reaches the phone as well as the Mac. iOS first (Android open, D85).                                                                                                                              |
| D73 | Sandbox for adapter code                             | **Good to add, not mandatory.** Adapters may expose local data, so the sandbox needs a flexible, declared exceptions system rather than one fixed boundary.                                                                                    |
| D74 | What needs approval                                  | **Not everything.** Reads and harmless actions run without asking; the tiers are in [Approval tiers](#approval-tiers).                                                                                                                       |
| D75 | Sharing adapters                                     | **No way to install someone else's adapter directly.** Adapters others publish are references. Your agent finds, compares and writes its own, and you approve the final adapter even when it copied one. Users accept the residual risk. |
| D76 | Remote transport: tunnel or relay                    | **Leaning to a Cloudflare Workers relay**, because the Mac only dials out and accepts no inbound connections. Pros and cons still to weigh (below).                                                                                          |
| D82 | A chat built into Valet (answers D13)                | **No.** Agents work through MCP tools. No built-in agent, no bring-your-own-key agent.                                                                                                                                                       |
| D83 | Marketplace or registry (M10)                        | **Dropped**, by D75.                                                                                                                                                                                                                         |

Also from the same message: adapters must be installable after the app is built (resolves D11:
needed now), and a web view of auditing and monitoring would be nice but raises data concerns
(D78, open).

## What this replaces in plan.md

| Old                                             | Now                                                                                                                      |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| M5 IDE and recorder                             | Workstream F: authoring tools over MCP. No IDE window; the agent is the IDE's user. The Mac app shows drafts and diffs. |
| M6 authoring agent (built-in, D13)              | Dropped (D82). The person's own agent authors through F.                                                                  |
| M7 sandbox and packages                         | Split: C (packages, now) and I (sandbox with exceptions, optional per D73).                                                |
| M9 relay beta                                   | G (relay) and H (iOS app), pulled forward.                                                                                |
| M10 registry                                    | Dropped (D83).                                                                                                            |
| D11, D12, D13                                   | Answered by C, D73 and D82.                                                                                               |
| Cloudflare Tunnel as the remote transport (D14) | Kept until the relay ships; whether it stays as a self-host option is D76.                                               |

M4 (hardening) and M8 (open-source release) stay, after this.

## The user journeys

Workstream A turns these into full journeys, IA and wireframes before any UI is built. They are
the acceptance tests for the whole plan.

- **J1. Install and pair.** Install, set up 1Password, scan a QR code on the Mac with the phone.
- **J2. Connect an agent.** Locally (Claude Code, Claude Desktop) and remotely (claude.ai, phone,
  cloud agents) through the relay, with consent on the phone.
- **J3. "Add an adapter for Yahoo Finance."** From a chat on the phone, the agent looks for
  reference adapters, explores the site in Valet's scratch browser, writes the adapter, tests it,
  and submits it. Nick approves the permissions on his phone. The agent then uses it.
- **J4. Approve on the phone.** Every approval kind (below) as a phone card: what it is, who asked,
  what it can reach, with Face ID.
- **J5. Repair from chat.** A site changes; the agent sees the repair item through Valet's tools,
  diagnoses it, proposes a fix, Nick approves the diff.
- **J6. A login needs you while you're away.** Today's hand-off opens a window on the Mac. What can
  the phone do (a code, a "try later", nothing for a CAPTCHA)? Open question for A.
- **J7. Something looks wrong.** Pause, lock down, revoke an agent, from the phone.
- **J8. Everyday admin by agent.** Turn a tool on for remote use, change the Woolworths store,
  read why a call failed.

## Approval tiers

Recommended defaults (D74; B finalises them and the Mac and phone render the same structured
card for each):

| Tier             | Examples                                                                                                                                                                          |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No approval      | Read Valet's status, adapters, tools, health, repair items, recent calls, redacted traces, the audit log. Author in the anonymous scratch browser. Run a draft's tests offline. |
| Notify only      | A draft adapter saved; a tool turned off; a setting that only makes things stricter.                                                                                             |
| Approve          | Install or update an adapter (the permission diff). Grant a secret. Turn a tool on for remote clients. Change a setting that loosens anything. A logged-in authoring session.    |
| Approve each use | An irreversible tool (checkout), with Face ID or Touch ID every time (D46).                                                                                                       |

No MCP tool can approve anything, and approvals are never inferred from a click alone: each needs a
user-presence gesture on a device the Mac trusts.

## The relay, and what end-to-end encryption can cover

Nick asked how end-to-end encryption would even work, since the MCP client would have to encrypt.
He's right that it can't cover MCP traffic. An MCP client talks plain HTTPS to a public URL, so
whatever terminates that TLS (today the Cloudflare Tunnel, later the relay Worker) sees the tool
calls and results. That's true of the tunnel already. What we can do:

- **Mac to phone: end to end.** We write both ends. Pairing exchanges keys by QR code; alerts,
  approval requests and approvals travel as ciphertext the relay can't read or forge. The Mac
  accepts an approval only if the phone's Secure Enclave key, unlocked by Face ID, signed it.
- **MCP traffic: plaintext at the relay, in transit only.** The relay forwards and never stores
  bodies, and logs only metadata. The person's model provider sees the same data anyway.
- **Web audit and monitoring (D78, open).** Either a browser becomes another paired device and
  decrypts what the Mac sends it (no data at rest in the service), or the service stores audit data
  (simpler, and a real data-protection obligation). Recommendation: the first, later.

Tunnel versus relay (D76), for the record:

| | Cloudflare Tunnel (today) | Workers relay |
| --- | --- | --- |
| Inbound connections to the Mac | Through `cloudflared`, which the person installs and runs | None; the Mac dials out over a WebSocket |
| Setup for the person | A Cloudflare account, a domain, `cloudflared` | Pair the phone; nothing else |
| Who sees MCP traffic | Cloudflare | Cloudflare (our Worker) |
| Phone channel | Needs a separate service anyway | Same service |
| Cost to us | None | Running a service, abuse limits, D16 pricing |

Recommendation: the relay is the default for everyone; the tunnel path is removed once the relay
ships, to keep one code path, unless Nick wants it as a self-host option.

## Workstreams

Ten workstreams. Each starts with the design steps in [How every workstream runs](#how-every-workstream-runs).

### A. Journeys, IA and wireframes for agent-run Valet

- **Depends on:** nothing. Starts first.
- **Scope:** J1 to J8 in full, for the existing personas (`docs/ux/personas.md`) plus a phone-first
  owner and the agent as an actor. The Mac app's IA changes (pairing, drafts, approvals from
  agents). The iOS app's IA. The content of every approval card, readable on a phone. Answers J6.
- **Output:** `docs/ux/agent-run/` and a wireframes artifact.
- **Done when:** every journey has wireframes for its happy path, failures and dead ends; an
  adversarial reviewer has walked each persona through them; B, D, E, F, G and H have signed off
  that the screens match their contracts.

### B. Security design: agents as authors, phone approvals, the relay

- **Depends on:** nothing. Runs beside A.
- **Scope:** revised threat model in `security-model.md` (agent-authored adapters, prompt injection
  through page text and through reference adapters, self-approval, a hostile relay, a stolen
  phone). Pairing and device keys; signed approvals and replay protection; approval and grant
  stores the Mac can trust (MAC or signature). The approval tiers. The sandbox exceptions model's
  security rules (with I). The relay protocol and what it may see (with G).
- **Done when:** the docs are merged, the contracts (types in `packages/core`) are merged, and a
  red-team agent's review of the design found nothing unaddressed.

### C. Adapters installed at runtime

- **Depends on:** B's review of the package hash and storage rules (small).
- **Scope:** a package format (manifest, TypeScript sources, fixtures, tests); Valet compiles the
  sources itself so the hash covers what runs; storage under the app's data folder by id and hash;
  versions and one-click rollback; the three built-in adapters move onto the same path. Installs come
  only from drafts (F) and, for development, a local folder; never a URL (D75).
- **Done when:** the built-in adapters load as packages; install, update with the permission diff,
  and rollback are covered by unit and e2e tests; a tampered package on disk is refused.

### D. Approval broker

- **Depends on:** B's contracts; A's approval-card spec for the UI.
- **Scope:** one service in the Mac app for every approval kind in the tier table, with a structured
  payload rendered the same on Mac and phone; Touch ID on the Mac (D46); signed phone approvals;
  trusted stores. Extends today's Needs you.
- **Done when:** every approval kind works on the Mac; tests show a synthetic click, a written file
  and a replayed approval all fail; adversarial review of the critical path (D71).

### E. Admin tools over MCP

- **Depends on:** nothing for the read tier (start now); D for anything that changes Valet.
- **Scope:** a `valet_` namespace: status, adapters and tools, health, repair items, recent calls,
  redacted traces, audit queries (read, no approval); turning tools on or off, settings, the store,
  asking for a secret grant (through D). Results in the IA's wording; page text marked as data.
- **Done when:** each tool has tests and annotations; a prompt-injection pass (hostile tool results
  trying to steer the agent into changes) shows every change still goes through D.

### F. Authoring tools over MCP

- **Depends on:** C and D; A's J3 and J5; B's threat model.
- **Scope:** an anonymous scratch browser (navigate, click, type non-secret text, DOM snapshot with
  values stripped, screenshot); a scrubbed network log; fixture capture; a draft workspace (create
  and edit a draft's files); build, lint and manifest check; tests against fixtures and a fake made
  from the recording; a paced live trial of a read tool in the scratch partition; diff against the
  installed version; submit for approval. A logged-in authoring session only with approval, per
  session. Repair: the structured repair ticket, readable through E.
- **Done when:** in an eval, an agent starting from a clean chat builds a working Yahoo Finance
  adapter and a working adapter for a fake login site end to end, and repairs a broken one; a
  hostile-page suite shows injected text can't get past the approval.

### G. Cloud relay on Cloudflare Workers

- **Depends on:** B's relay protocol.
- **Scope:** a Worker with a Durable Object per Mac; the Mac's outbound WebSocket; remote MCP
  clients reach the Mac through it, with the Mac's existing OAuth server and consent (consent now
  also on the phone); the end-to-end Mac-to-phone channel; APNs push; per-source limits; no stored
  bodies. Identity by device keys, no accounts (D79, recommended).
- **Done when:** a remote client completes OAuth and calls a tool through the relay against a
  local Workers runtime in CI; abuse limits tested; deployed to staging on Nick's Cloudflare account
  (needs Nick).

### H. Native iOS app

- **Depends on:** A's iOS IA and wireframes; B's pairing protocol; G's channel (built against a
  local fake relay until G lands).
- **Scope:** SwiftUI app: pairing by QR, Needs you, approval cards with Face ID signing, push,
  activity and health, pause and lock down, consent for remote clients. Built on the design system's
  tokens with native iOS components (Liquid Glass where it fits).
- **Done when:** simulator UI tests cover J1, J4, J7 and J8 on the phone; accessibility and dark
  mode pass; a TestFlight build installs on Nick's phone (needs Nick's Apple Developer account).

### I. Sandbox with declared exceptions

- **Depends on:** C; B's exceptions rules.
- **Scope:** pick the sandbox (D12's options); on by default per adapter; exceptions declared in the
  manifest (local files by path, local apps, other hosts), each shown in the approval diff; an
  adapter may run unsandboxed only when it says so and the approval says so loudly. Makes local-data
  adapters possible.
- **Done when:** a hostile-adapter suite aimed at the sandbox finds no escape; an example local-data
  adapter works through a declared exception.

### J. Integration and QA

- **Depends on:** A to I landing.
- **Scope:** wire the streams together and run J1 to J8 end to end; several adversarial persona QA
  rounds, as for the redesign; a red-team pass on the whole agent-run surface; updated demo and app
  tour.
- **Done when:** every journey passes on a real Mac build with a real phone (with Nick), and the last
  QA round finds nothing above minor.

## Order

```
Phase 0 (now):      A journeys ─┐   B security ─┐   C packages   E read tier
Phase 1:            D broker (B, A)   G relay (B)   H iOS (A, B; fake relay)   I sandbox (C, B)
Phase 2:            E write tier (D)   F authoring (C, D)
Phase 3:            J integration and QA rounds
```

At most four build threads at once, since macOS CI is shared (H adds iOS jobs to it). Contracts
(types, protocols) merge before anything builds on them.

## How every workstream runs

1. **Brief.** The workstream's scope, the journeys it serves, what it must not break.
2. **Design.** A design doc with the options considered and why one won, the contracts, and the
   failure cases. UI streams work from A's wireframes, not their own.
3. **Design review.** A fresh adversarial reviewer agent (and B for anything security relevant);
   the design changes until it passes.
4. **Contracts first.** Shared types and protocols merge on their own, so dependants can start.
5. **Build with tests.** Unit and e2e tests at the coverage thresholds; tests never touch real
   1Password, Keychain or Messages.
6. **Adversarial code review and red team** on every critical path (D71): approvals, secrets,
   pairing, the relay, the sandbox.
7. **Persona QA** on the built app (J runs the cross-stream rounds).
8. **Docs** updated in the same PR; merge on green with auto-merge.

## What needs Nick

None of this is on the Woolworths order path, so it's batched and asked once, when a stream reaches
it:

- An Apple Developer Program membership, an App ID and an APNs key (H, G).
- A Cloudflare account for the Worker, and a host name such as `relay.valet.dncr.me` (G).
- Installing TestFlight builds and trying the journeys (H, J).
- Later decisions: D76 (keep the tunnel?), D78 (web audit), D85 (Android), D16 (pricing).

## Open decisions

| #   | Decision                                   | Recommendation                                                                                       |
| --- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| D76 | Keep Cloudflare Tunnel once the relay ships | Remove it, for one code path, unless Nick wants self-hosting.                                        |
| D77 | What end-to-end encryption covers          | Mac to phone only; MCP traffic is plaintext at the relay in transit, never stored.                   |
| D78 | Web audit and monitoring                   | Later, as a paired browser that decrypts locally; no audit data stored by the service.                |
| D79 | Accounts in the relay                      | None; device keys from pairing.                                                                       |
| D80 | Who authorises remote MCP clients          | The Mac's existing OAuth server, through the relay, with consent on Mac or phone.                     |
| D81 | Agent driving your signed-in session       | Off by default; approved per session.                                                                 |
| D16 | Pricing                                    | Still not asked until after the MVP; the relay makes it real.                                         |
| D85 | Android                                    | After iOS.                                                                                            |
