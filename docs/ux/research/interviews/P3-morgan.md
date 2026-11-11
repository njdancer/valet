# P3 interview: Morgan, the security-minded reviewer

Simulated persona interview, round 1 (2026-11-11). Researcher notes are marked **R**, Morgan's
answers **M**. Screenshots are in `docs/ux/research/current-screens/`. Note: the `*-full.png`
captures are the same 1180 x 780 as the viewport, so they do not show below-the-fold content; for
anything below the fold I checked `apps/desktop/src/renderer/` instead.

## A. Interview

**R: How would you actually use Valet?**
M: Twice, really. Once properly: Nick hands me the app and the security model and I spend an
afternoon trying to work out what it can touch. Then in short bursts after that: when an update
lands, when something weird shows up in a trace, or when I suspect a token leaked. In the short
bursts I'm under time pressure and slightly paranoid. I want to get from "something's off" to "it's
cut off" in seconds, and then go and gather evidence calmly.

**R: What jobs are you hiring it for?**
M: Three. One: tell me the blast radius. For any adapter, secret or client, what can it reach right
now, and what does it reach in practice. Two: give me evidence I can check myself, not adjectives.
Three: give me a kill switch per thing and a global one, with a clear statement of what each
switch does and doesn't do.

**R: What does "trustworthy" look like on screen?**
M: Every claim is either verifiable or labelled as a claim. Your confirmation window is actually
good at this: "Checked by Valet" versus a dashed box saying "Shown by the Woolworths adapter, not
verified by Valet" (`confirm.png`). That's the right instinct. Trustworthy is also "I can see the
same fact from both ends": the grant shows its uses, the use shows its grant.

**R: And "healthy"?**
M: Healthy is a short list of things that are true right now, each with a timestamp of when it was
last checked: chain verified at 9:48, endpoint listening on 127.0.0.1 only, 2 local clients with
tokens, 0 remote clients, 1 grant, no open breakers. And when something isn't healthy, the line
goes red and becomes a button. A green dot that says "Audit chain intact" in the sidebar footer
with no time and no way to click it (`adapters.png`, bottom left) is not health, it's decoration.

**R: Describe your mental model of Valet.**
M: Capabilities and principals. Principals are clients (Claude Code, Claude Desktop, remote
connectors). Capabilities are adapter tools, which are bounded by the manifest: egress hosts,
request paths, navigation origins. Secrets are a separate capability, bound by a grant to one
adapter hash and a set of origins. So blast radius is a join: client → tools it can call →
adapter version → hosts and paths → secrets it may cause to be filled. I want that join drawn
for me. Today I have to do it by hand across four pages.

**R: Per adapter, per secret, per client?**
M: Per adapter: hosts, paths by purpose, which secrets, and which clients have called it. Per
secret: which adapter hash, which origins, which tools can trigger a login that fills it, every
use. Per client: which tools it can call (for local clients the answer seems to be "all of
them", and the UI never says so), what it has actually called, and the button to cut it.

**R: What apps do you compare it to?**
M: Little Snitch: every rule shows its traffic and every connection shows its rule; I can flip
from one to the other. 1Password Watchtower: one list of problems, each with a "fix this"
button. macOS Privacy & Security: per-capability lists of apps with a toggle each, dead simple.
Tailscale admin: machines, ACLs, and a "what can this node reach" preview. GitHub's fine-grained
token page: scopes listed at creation and revocation with a confirm that names the token.

**R: How should evidence and controls connect?**
M: Bidirectionally, always. If I'm looking at a `secret-used` audit record, I need "open the
call", "open the grant", "revoke the grant" right there. If I'm looking at a grant, I need "last
used 9:47 pm" to be a link to the filtered audit log. If I'm looking at a blocked request in a
trace, I want to see the manifest line that didn't allow it.

**R: Vocabulary?**
M: I'm fine with "adapter", "manifest", "hash", "egress", "grant". I'd prefer "revoke" over
"remove" because it's precise. What confuses me is the same thing named three ways: "Remote
sign-in" in the sidebar, "Remote access" on the card, "connector" in the request. And "Clients"
and "Settings" are two sidebar items that open the same page with the columns swapped
(`clients.png` vs `settings.png`). That makes me wonder what else isn't what it says.

## B. Open card sort

| Group (Morgan's name)                     | Cards                      | Where I'd start                                                                                                                    |
| ----------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Needs me now**                          | 35, 1, 8, 9, 20            | Menu bar first, then a "Needs you" inbox at the top of the window                                                                  |
| **Adapters (what code runs)**             | 2, 3, 4, 34, 25, 10        | Adapters list → adapter page. 25 (breaker) belongs on the site's adapter page as well as a health view                             |
| **Secrets and grants (what it can fill)** | 5, 6, 7, 26, 27            | A "Secrets" or "Credentials" page, with each grant also shown on its adapter                                                       |
| **Who can call (principals)**             | 16, 17, 18, 19, 21, 22, 23 | A "Clients" page that covers local and remote together; remote is just another kind of client with scopes                          |
| **Evidence**                              | 11, 12, 13, 14, 15         | Activity for calls, Audit for the chain. I'd merge them into one "Evidence" area with two views                                    |
| **Emergency**                             | 24, 23, 18, 6              | A single "Lockdown" control reachable from the menu bar and the window toolbar. These are duplicates of cards elsewhere on purpose |
| **App housekeeping**                      | 28, 29, 30, 31, 32, 33     | Settings, and nothing security-relevant hidden in there                                                                            |

Notes: I put 23 and 24 in two groups deliberately. Kill switches should exist where the thing
lives and in one emergency place. I'd pull 21 (remote tool toggles) next to the client it
applies to, not on a separate "Remote sign-in" page.

## C. Cognitive walkthrough

Severity: **S1** blocks the task or risks a wrong security decision; **S2** major friction or
evidence gap; **S3** minor.

**S1. Approve Woolworths 0.4.0 from its adapter page** (`adapter-wow.png`, `review.png`)

- Look: hero, for a banner or button. See a blue "0.4.0 waiting for review" pill. Expect a
  button. It is in fact a link (`AdapterDetail.tsx:111`), but styled exactly like the status pill
  beside it, so I'd hover the green "Approved" pill first and get nothing. **S2**: discoverable
  only by accident. On the Adapters list the matching "0.4.0 to review" pill is a plain `span`
  (`Adapters.tsx`), not a link; only the banner's "Review changes" works there.
- Review screen itself is strong: "+1 host" with the consequence ("Tool pages may send
  requests, including your session cookies, here"), manifest diff, files. Breakdowns: the left
  column cuts off at "Request surface" with no visible scroll affordance (**S2**: the part I care
  most about is below the fold); "I've read the highlighted additions" is a checkbox with no link
  to jump between additions (**S3**); the code files list (`src/tools/rewards.ts +64`) isn't
  openable, so I approve code I can't read in the app (**S1** for a reviewer).

**S2. Log in to Woolworths when asked** (`needs-user.png`, `tray.png`)

- Look at the menu bar "Needs you": "Log in to Woolworths · Open". Fine. In the banner I like
  "Can only visit www.woolworths.com.au, auth.woolworths.com.au" and the honest "nothing is marked
  inside the page, where the site could fake it". Breakdown: the page body is blank grey in the
  capture; I can't tell whether that's a loading state or a bug (**S2**). "Give up" doesn't say
  what happens to the waiting call (**S3**).

**S3. Confirm a remove from trolley** (`confirm.png`)

- Best screen in the app for me. Verified vs unverified is explicit, the request it will make is
  shown, the timeout is visible. Breakdowns: the content sits in a narrow column with a large
  empty grey area below (**S3**, layout); "Tool declared write" yet the window exists because it
  asks first, so "write" vs "irreversible" is muddled (**S2**); no link to this client's recent
  calls, so I can't check whether this request fits what Claude has been doing (**S3**).

**S4. Why did the last get_cart fail?** (`activity.png`, `activity-call.png`)

- Activity list rows are links to traces. The trace is excellent evidence: secret fills with
  origin checks, the hand-off, blocked requests with reason codes. Breakdowns: the header's
  "Adapter 0.3.0 9f3c…", "Client", "Secrets used login (2 fields)" are all plain text, not
  links (`Activity.tsx:253, 269`) (**S2**). No "show these records in the audit log" (**S2**).
  Activity has a client filter but no adapter filter, and the adapter page's "All activity" button
  goes to the unfiltered list (`AdapterDetail.tsx:52, 187`) (**S2**). Sidebar swaps "Sites" for
  "Recent" on this page only, so the left nav changes shape under me (**S3**).

**S5. Connect Claude Desktop** (`clients.png`)

- "Add a client…" is where I'd expect. Fine. Breakdown: the Clients and Settings nav items open
  the same page with the columns mirrored (**S2**, trust-eroding). "Tokens: One per client, new
  at every launch" contradicts the "Reset access" explanation below it (**S3**).

**S6. Claude Code's token leaked. Cut it off.** (`clients.png`)

- Clients → Claude Code row → "Revoke". It is a ghost button that fires immediately on click
  (`ClientsSettings.tsx:353`): no confirmation naming the client, no statement of consequence
  ("its bridge will stop working; you'll have to add it again"), no undo (**S1** for an
  irreversible step that's one misclick from "Reset access" directly above it). I also can't see
  what the token was used for in the meantime: "141 calls · 7d" is not a link to those calls
  (**S2**). Remote clients get a two-step "Revoke all…" (`RemoteConsent.tsx:263`); local ones
  don't. Inconsistent.

**S7. Woolworths seems to be blocking you** (`adapters.png`, `adapter-wow.png`)

- Adapters page shows "Site circuit breakers" with "Open · 3:58" for Coles. Good evidence, but
  no control: no "open the call that tripped it", no "keep it closed / pause this site" (**S2**).
  The "Blocked by site" pill in the Health column is a span; only "Needs you" is a link.

**S8. First launch** (`setup-welcome.png`, `fr-review.png`)

- Welcome's three promises are exactly what I'd want to verify, but none links to its evidence
  (the security model or the relevant setting) (**S3**). First-run review says "0 files" for
  the adapter I'm approving (**S2**: either a bug or I'm approving nothing). "Every permission,
  in detail" is collapsed below a large empty area.

**S9. Turn on remote access** (`remote.png`)

- Remote card says "Off" with "Turn on" disabled, yet directly below "A connector wants access"
  from 203.0.113.24 with a live countdown (**S1** confusion: how is a request arriving while
  off?). The tool list includes "Wikipedia · Get summary", which is not an installed site in the
  sidebar (**S2**: the scope list doesn't match the inventory). Good: the orange "a request you
  didn't just start… Decline it" warning.

**S10. Check the audit log hasn't been tampered with** (`audit.png`)

- "Verify chain" and "Export JSONL" are where I'd expect. The banner is honest about tail
  truncation needing an external anchor, which I respect. Breakdowns: the head hash
  "e73a…b69d" is truncated with no copy, so I can't record an anchor myself (**S2**). The
  sidebar's "Audit chain intact" isn't a link to this page and carries no timestamp (**S2**). The
  Seq/Call column shows call IDs as text, not links to the trace (`AuditLog.tsx:301`) (**S2**).
  The record pane offers "Open adapter" and "Copy record", but not "Open call", "Open grant" or
  "Revoke". The chain mini-blocks for 4812/4814 look clickable and aren't (**S3**).

**S11 (P3). Which calls used the login secret?**

- Credentials → Woolworths grant → "Last used 9:47 pm". Expect a link to every use. It's text
  (`Credentials.tsx:130`). Go to Audit → "Secret use" filter + "Any adapter". Works, but I had to
  know to do it. Each `secret-used` row has no link to its call (**S2**). Nothing anywhere answers
  "which tools can trigger a login that fills this" (**S2**).

**S12 (P3). What can Claude Code reach right now?**

- No page answers it. Clients shows calls and buttons; no scopes. I infer "every tool of every
  approved adapter", then hand-join against each adapter's Permissions card (below the fold on
  `adapter-wow.png`; its host chips aren't links either). **S1**: the core blast-radius question
  has no answer in the UI.

**S13 (P3). Revoke everything, fast.**

- In the window there is no pause or lockdown. "Pause all adapters" and "Turn off MCP for all
  clients" exist only in the menu bar menu (`tray.png`; `grep setPaused` finds nothing under
  `screens/`). Grant revokes are one-click with no confirm (`AdapterDetail.tsx:721`,
  `Credentials.tsx:148`) which is fast but unsafe, and there's no "revoke all grants". **S1**.

## D. Looks interactive but isn't / should be interactive

Evidence without its control:

- Sidebar footer "Audit chain intact" and "MCP on · 127.0.0.1:47821": plain spans. Should open
  Audit (with re-verify) and the endpoint card.
- Trace header: adapter version + hash, client, "Secrets used". Should link to adapter, client,
  grant.
- Credentials "Last used", Clients "Calls · 7d", adapter "Calls · 7d" per tool: counts with no
  drill-down.
- Audit Call ID column, hash chips (`9f3c1a7e…e0f1`), chain neighbour blocks.
- Site circuit breakers card and "Blocked by site" pill: no link to the tripping call, no action.
- Blocked requests in a trace: no link to the manifest rule or the review that would allow it.
- Adapter Permissions host chips: should filter Activity/Audit by host.
- Adapters list "0.4.0 to review" pill and Approval/Health pills (except "Needs you").
- Review screen code files: not openable.

Controls without their evidence or consequence:

- Revoke (client, grant): no confirm, no consequence text, no "what it was used for" summary.
- Reset access: doesn't say which sessions it will end.
- "Give up" on the login banner: doesn't say what happens to the waiting call.
- "Turn on" remote: disabled with no reason next to it.

Layout oddities:

- Clients and Settings: one page, two nav items, columns mirrored.
- Confirmation window: narrow column, half the window empty.
- Login hand-off banner: blank page area under it in the capture.
- Review: left column clipped mid-section with no fade or scroll cue; first-run review has a
  large void above "Every permission, in detail".
- Sidebar group changes from "Sites" to "Recent" on Activity only.
- Grant sheet: search "Woolworths" says "4 items match" but lists Coles.
- Unknown adapter id shows a bare one-liner with breadcrumb still pointing at it
  (`adapter-yahoo.png`).

## E. Summary

**Top 5 pain points (ranked)**

1. No blast-radius view: nothing answers "what can this client / secret / adapter reach right now"
   (S12, S11).
2. Evidence and controls live on different pages with no links between them (trace ↔ grant ↔
   audit ↔ client).
3. Destructive actions (revoke client, revoke grant) are one-click, unconfirmed, without
   consequence text, while the emergency controls (pause, MCP off) are only in the menu bar.
4. Status that can't be re-checked from where it's shown ("Audit chain intact", breaker states),
   and a truncated head hash I can't copy to anchor.
5. Inconsistent inventory and naming (Wikipedia in remote scopes, remote "Off" with a pending
   request, Clients = Settings, "0 files" on review) erode trust in everything else.

**Top 5 needs**

1. Per-client, per-secret, per-adapter "Can reach" panels, computed from the manifest + grants.
2. Every piece of evidence links to its control, and every control to its evidence.
3. A Lockdown control in the window and menu bar: pause adapters, MCP off, revoke remote, with a
   clear list of what it does and an undo where one is possible.
4. Revoke with a confirm that names the thing, states the consequence and offers a filtered
   audit trail of what it did.
5. Verifiable status: timestamps, a re-check button, a copyable head hash.

**Quotes**

- "A green dot that says 'intact' with no time and no button isn't a status, it's a sticker."
- "I can find out that the login secret was used at 9:47. I can't click 9:47."
- "Your confirmation window gets it: what Valet checked versus what the adapter claims. Do that
  everywhere."
- "The most destructive button on the Clients page is the same grey text as 'Set up'."
- "When two sidebar items open the same page, I stop believing the sidebar."

**Morgan's ideal top-level navigation**

```
Needs you            (inbox: approvals, logins, confirmations, remote requests)
Overview             (health checklist with timestamps; each line clickable)
Adapters             → adapter: Can reach · Tools · Secrets · Runs · Versions/Review
Access
  Clients            → client: Can reach · Calls · Token (reset/revoke) — local and remote together
  Secrets            → grant: Can fill where · Triggered by tools · Uses
Evidence
  Activity           (calls; filter by adapter, client, secret, host)
  Audit log          (chain, verify, export, copy head hash)
Settings             (app only: startup, notifications, retention, updates, reset)
[Lockdown]           (toolbar button + menu bar, always visible)
```
