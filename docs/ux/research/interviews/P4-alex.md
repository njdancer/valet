# Interview: P4, Alex the adapter author

Simulated persona interview, round 1 (2026-11-11). Alex is in character throughout parts A, B and E;
the researcher's observations are marked **Researcher** and were checked against the screenshots in
`docs/ux/research/current-screens/` and the renderer code in `apps/desktop/src/renderer/`.

Note on evidence: every `*-full.png` is 1180 x 780, the same as the viewport shot, because the
pages scroll inside an inner container. So the "full" shots don't show below-the-fold content
(the Permissions card on the adapter page, the Request surface section of the review). Where that
mattered, the code was read instead.

## A. Interview

**Context of use.**
"Three things are open: VS Code on the left half, with the authoring agent in its panel; Valet's
control panel on the right half, which at half of a 14-inch screen is close to the 880 x 560
minimum; and a terminal with the test runner. Claude Code is in that terminal too, and that's
what actually calls the tools. So Valet is never my main window. It's my approvals queue and my
trace viewer. I glance at it, act, and go back to the editor."

**Goals.**
"Shorten the loop. Ticket comes in, the agent records, proposes a diff, the IDE's repro check
passes, then I need to approve it in Valet, run the tool from Claude Code, and read the trace. On a
good day that loop takes four minutes, and the Valet part should be thirty seconds of it. Today
it's the part I dread, because I have to find things."

**The loop, step by step, as I live it.**

1. _Edit_: in the IDE. Valet isn't involved.
2. _Review_: the new hash lands, Valet shows "0.4.0 waiting". I want to get from wherever I am to
   the diff in one move, read what changed in permissions (that's the bit I actually care about
   as a security gate on my own work), skim the code, and approve.
3. _Run_: from Claude Code. I want Valet to show "running" against the version I just approved,
   so I know I'm not testing the old hash.
4. _Debug_: open the trace, find the red step, and jump from it to the thing that caused it: the
   manifest entry, the selector, the request declaration. Then copy it into the agent's prompt
   or straight into the editor.

**Mental model.**
"An adapter is a package. A version is a commit, identified by a content hash. An approval is a
merge into what's live. A call is a test run, and a trace is a test trace. Grants are like
environment secrets bound to a deploy: change the deploy, rebind the secret. So I think in
_versions_ first, then _runs against a version_. Valet thinks in _adapters_ and _activity_ as two
separate worlds, and the version is a grey chip nobody can click."

**What I compare it to.**

- _GitHub PR review_: a header with the from and to refs, a file list where every file opens its
  diff, a summary of checks, and one big Approve button. Valet's review screen looks like a PR
  but the file list doesn't open anything: `src/tools/rewards.ts +64` is just text.
- _Playwright trace viewer_: a timeline on the left, and clicking any action shows its detail,
  the DOM snapshot, the network call, the source line. Valet's trace timeline is a lovely
  read-only list. Clicking a step does nothing.
- _Chrome devtools Network panel_: filter by blocked, click a request, see headers, initiator and
  "why was this blocked". Valet has a "Requests" tab, but rows aren't selectable either.

**Vocabulary I use.** adapter, version, hash, manifest, egress allowlist, request surface,
"undeclared request", step, selector, fixture, repro, run, trace, approve, rollback, "dev build".
"I'd never say 'Recent runs' and 'Activity' and 'Audit log' for what is, to me, three views of the
same event stream. And the Activity list writes 'Read the trolley on Woolworths' where I want to
see `woolworths.get_cart`. That sentence is for Sam, not me. Give me a toggle."

## B. Open card sort

Alex sorted the 35 cards into seven groups.

| Group (Alex's name)                   | Cards                                                                                                                                           | Where Alex expects to start                                                                                         |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **Inbox / Needs me**                  | 1 Approve update, 8 Log in when asked, 9 Confirm irreversible action, 20 Approve remote sign-in, 35 What needs me now                           | A single "Needs you" list at the top of the sidebar _and_ the menu bar; also inline on the adapter page for 1       |
| **Adapter (one site)**                | 2 Allowed hosts and paths, 3 Tools, 4 Choose store, 25 Is the site blocking us, 34 Remove adapter, 10 Open trolley in browser                   | Adapter detail page, reached from sidebar Sites                                                                     |
| **Versions** (sub-area of an adapter) | 1 again, plus "compare versions" and "roll back" (no card exists; Alex added both)                                                              | A "Versions" tab on the adapter page                                                                                |
| **Runs and traces**                   | 11 Today's calls, 12 Why a call failed, 13 Blocked requests                                                                                     | Activity, but filterable by adapter, tool and version                                                               |
| **Secrets**                           | 5 Give a password, 6 Revoke a grant, 7 Re-sync Keychain, 26 Set up 1Password, 27 SMS codes                                                      | Credentials page for the provider setup (26, 27, 7); but 5 and 6 belong on the adapter, because a grant is per hash |
| **Access (who can call)**             | 16 Add Claude Desktop, 17 Reset client, 18 Revoke client, 19 Remote access, 21 Tool on/off for remote, 22 MCP address, 23 MCP off, 24 Pause all | "Connections" or "Clients", one page; 24 and 23 also in the menu bar as kill switches                               |
| **Audit**                             | 14 Verify chain, 15 Export                                                                                                                      | Audit log                                                                                                           |
| **App**                               | 28 Trace retention, 29 Updates, 30 Run setup again, 31 Reset or uninstall, 32 Open at login, 33 Notifications                                   | Settings                                                                                                            |

**Researcher:** Alex split card 1 across two groups without hesitation ("it's an inbox item _and_
a version thing") and created two missing cards (compare, roll back). Alex hesitated only on 25
(circuit breaker): "it's per site, not per adapter, but I'd look on the adapter first." Alex
expected 28 (trace retention) next to the traces, not in Settings, "but I'd accept Settings with
a link from Activity". The current sidebar has no "Needs you" destination, and "Remote sign-in"
as a peer of "Clients" confused Alex: "remote is a kind of client, why is it a separate page?"

## C. Cognitive walkthrough on the current screens

Severity: **4** blocks the task, **3** major delay or wrong path, **2** friction, **1** cosmetic.

### S1. Approve Woolworths 0.4.0 from the adapter page (`adapter-wow.png`)

- _Looks:_ header. Sees green "Approved" and blue "0.4.0 waiting for review" side by side.
- _Expects:_ a "Review 0.4.0" button, or the version row on the right ("Version 0.3.0 · approved
  2 Nov") to say "0.4.0 available, Review".
- _Actually:_ the blue pill **is** a link (`AdapterDetail.tsx:111`, `<a className="pill info">`),
  but it looks identical to the non-link "0.4.0 to review" pill on the Adapters list
  (`Adapters.tsx`, a plain `<span>`) and to the non-link "Approved" pill beside it. There's no
  hover cue in a screenshot and no button. Alex: "I'd never click a status badge. Badges are
  output." **Sev 3** (Nick's own complaint; most people will fall back to the menu bar).
- On the review (`review.png`) the left column is cut at "Request surface" with no visible
  scrollbar or fade (**sev 2**); Approve is pale and disabled until the bottom-left checkbox is
  ticked, with nothing pointing from the button to the checkbox (**sev 2**). The Code card lists
  `src/tools/rewards.ts new +64` but **you can't open the code diff**: the rows are a plain table
  (`ReviewUpdate.tsx` ~290-310). **Sev 3** for Alex; for a reviewer of agent code, it's
  arguably sev 4.
- After approving, the security model's Touch ID/hash-typing gesture (authoring-agent.md,
  "Approval integrity") doesn't appear in the UI at all. Noted, not tested.

### S2. Log in when asked (`needs-user.png`, `adapter-wow.png`)

- Alex goes to the adapter page: the Session card says "Waiting for you" with "Show login".
  Works. But on the Adapters list the same state reads "Login window open" + "Needs you" pill,
  neither clickable (only the adapter name is a link). **Sev 2.**

### S3. Confirm a removal (`confirm.png`)

- Opens as its own window. Fine. Alex wants "which tool, which call id, which version" visible so
  a test confirm can be matched to the run. **Sev 1.**

### S4. Why did the last get_cart fail? (`activity.png`, `activity-call.png`)

- _Looks:_ sidebar "Recent", sees `get_cart` with a red dot at 3:58 pm. Clicks: lands on the trace.
  Good, the fastest path in the app.
- But Recent omits the adapter (Coles `get_trolley` and Woolworths `get_cart` look like peers),
  and truncates `update_cart_li…`, `remove_fro…` (**sev 2**, cosmetic glitch Nick also saw).
- Via Activity: rows are sentences, not tool ids; filters are status and client only, **no adapter,
  tool or version filter** (`Activity.tsx` ~110-135; Audit log has "Any adapter", Activity
  doesn't). **Sev 3.**
- The adapter page's "All activity" buttons (header and Recent runs) go to unfiltered `#/activity`.
  **Sev 2.**

### S5. Connect Claude Desktop (`clients.png`)

- Clients page is findable. Alex didn't struggle. "MCP address" is in the sidebar footer and the
  tray, but not copyable from the footer. **Sev 1.**

### S6. Cut off Claude Code's token (`clients.png`)

- Findable on Clients. Alex: "fine, but Activity says 'for Claude Code' and that's not a link to
  that client." **Sev 2.**

### S7. Is Woolworths blocking me? (`adapters.png`)

- "Site circuit breakers" card on Adapters shows Coles Open 3:58. Nothing in it is clickable: no
  "see the call that tripped it", no "reset", no link to the adapter. Health pill "Blocked by site"
  is a dead span. **Sev 3** ("evidence, no action").

### S8. First launch (`setup-*.png`, `fr-review.png`)

- `fr-review.png` shows "0 files" for a first install, which reads as broken, and the right column
  is a lonely purple grant callout with ~450 px of empty space below it (**sev 2**, Nick's "weird
  gaps"). The hash in that header (`4b7e2d91…a83c`) is the same hash `review.png` shows for 0.4.0,
  while `fr-adapter.png` shows 0.3.0 as `9f3c1a7e…e0f1`. Probably fake data, but an author
  notices hash mismatches instantly and stops trusting the screen. **Sev 2** (fix the fixtures).

### S9. Remote access (`remote.png`)

- Alex found it but asked why "Remote sign-in" is separate from Clients, and why the tray doesn't
  show remote status. **Sev 2.**

### S10. Audit chain (`audit.png`)

- Clear and good-looking. "Verify chain" and "Export JSONL" are real buttons. But record 4813 is a
  `tool-finished` with `callId: c_9a71d0` and the inspector offers "Open adapter" and "Copy record",
  **not "Open run"** (`AuditLog.tsx:683-691`). Same in reverse: the trace doesn't link to its audit
  records. **Sev 2.**

### A1 (Alex). Approve a dev build fast

- Agent pushes 0.4.1 with only a code change. Expected: a notification or tray item that opens the
  review, a short screen ("no new permissions") and Approve with one keystroke. Actually: the
  "This update adds no permissions" path exists (`ReviewUpdate.tsx` foot), but it's the same heavy
  window. There's no "approve the next dev build of this adapter with the same permissions"
  shortcut, which is right for safety, but there's no keyboard shortcut either (the Approve button
  has `default-ring` styling; whether Return triggers it wasn't verifiable). Grants don't carry
  over, so every dev build also means a trip through the grant sheet (`grant.png`), with the
  1Password item list re-picked. The design doc proposes a pre-ticked "keep the same item" option
  when auth/egress are byte-identical; the current review has only the "Grant login next"
  checkbox. **Sev 3** for iteration speed.

### A2 (Alex). From a failed call to the failing step and the manifest line

- On `activity-call.png`, the blocked `POST /apis/ui/Trolley/Recommendations` is red in the
  timeline and explained in the right column ("The manifest declares no matching request").
- Expected next click: the step opens a detail panel with the full URL (it's truncated:
  `collect.tealiumiq…`), the initiator stack, and a "Show in manifest" or "Copy as request
  declaration" action. **Actually, steps aren't interactive at all**; only two "Details"
  disclosures on the probe steps. The Adapter KPI "0.3.0 9f3c1a7e…e0f1" is a `<Hash>` span with a
  title tooltip (`ui.tsx:98`), not a link to that version, not copyable with one click.
  Breadcrumb is "Activity > woolworths.update_cart_line"; there's no way from the trace to the
  adapter page at all. **Sev 4** for this persona's core loop.
- The outcome reads green "ok" while 2 requests were blocked. "ok with 2 blocked is the most
  important state for me, it's where drift starts. It must not look identical to clean ok."
  **Sev 3.**

### A3 (Alex). Compare two versions

- No version history anywhere. The adapter page shows only the current version and hash; the
  review shows from → to for the pending update only. No restore, though the design doc says
  "the old hash stays installed and can be restored with one click". **Sev 4** (the feature is
  missing, not hidden).

## D. Looks interactive but isn't / should be interactive / layout oddities

**Looks interactive but isn't (verified in code):**

- Every status pill on the Adapters table: "0.4.0 to review", "Needs you", "Blocked by site",
  "Healthy". Only "Choose store" is a link.
- Code file rows in the review (`src/tools/rewards.ts`): look like a PR file list.
- Hash chips everywhere (`9f3c1a7e…e0f1`): styled like tokens/buttons, only a tooltip.
- Tray adapter rows (`tray.png`, `TrayPopover.tsx:288`, a `<div>`): look like menu rows, do nothing.
- Breaker rows on Adapters ("Open · 3:58").
- Tool rows on the adapter page, and their "Calls · 7d" counts.
- The trace timeline steps, the "Requests" summary in the trace header ("4 sent · 2 blocked"),
  "Secrets used: login (2 fields)".
- "Today" sparklines on Adapters and in the tray (no hover values, no click to filter Activity).
- Client names in quotes ("Claude Code") throughout.

**Is interactive but doesn't look it:**

- "0.4.0 waiting for review" pill on the adapter page (a link that looks like a badge).
- "Run setup again" in the sidebar footer, styled as small blue text, easy to hit by accident.

**Should be interactive (Alex's list):** open file diff; step → detail panel; step/request →
manifest line; trace → adapter version; trace ↔ audit records; Activity filters for adapter,
tool, version, "has blocked requests"; "Copy trace as JSON"; "Copy hash"; version history with
compare and restore; breaker "reset now" and "show tripping call".

**Selectable text:** "Honestly, I'm the one persona who _wants_ selection, but only in the right
places: hashes, call ids, selectors, URLs, JSON. Everywhere else, buttons and labels and headings
selecting on a drag is web-page behaviour." Today only diff gutter numbers are `user-select: none`
(`app.css:1052`).

**Layout oddities:**

- `fr-review.png`: right column empty below a single callout; "0 files".
- `review.png`: inner scroll on the left column with no scroll affordance; content stops at a
  section header. Right column ends at the Code card, leaving a gap of uneven height.
- `adapter-wow.png`: header right ("Version / Content hash") floats at a different baseline from
  the title; manifest descriptions repeat the "FROM THE MANIFEST" eyebrow on every row of the
  tools table, which wastes a third of each row.
- `activity.png`: list sits in a narrow band with ~400 px of empty canvas below; the "7 calls" count
  floats far right, detached from the list.
- `adapter-yahoo.png`: "No adapter with that id is installed." centered in a full blank page, with
  an "All activity" button still in the title bar and no link back.
- Sidebar Recent: truncated tool names, no adapter, same weight as navigation.
- Badge counts mismatch in meaning: "Adapters 3" (attention count, orange) beside "Activity 37"
  (a total, grey); the Adapters header says "2 installed", which makes "3" look like a bug.

## E. Synthesis

**Top 5 pain points (ranked).**

1. The trace is a dead end: steps, requests, version and hash aren't clickable, and nothing links
   to the manifest, the adapter or the audit records (A2, sev 4).
2. No version history, compare or restore (A3, sev 4).
3. Code changes in the review can't be opened, so I approve agent-written code I can't read in the
   app (S1, sev 3-4).
4. The way into review from the adapter is disguised as a status badge; the Adapters list version
   of it isn't a link at all (S1, sev 3).
5. Activity can't be filtered by adapter, tool or version, and speaks in sentences, not tool ids
   (S4, sev 3).

**Top 5 needs.**

1. One click from a red step to its detail, with "show in manifest" and "copy as declaration".
2. A Versions tab: list of hashes with approval date and who/what authored them, diff any two,
   restore with the approval gesture.
3. A review screen that is a real diff viewer (files open), with a keyboard-approvable footer.
4. A single "Needs you" inbox reachable from everywhere, and an obvious "Review 0.4.0" button on
   the adapter itself.
5. "ok with blocked requests" as its own visible state in lists, tray and trace.

**Quotes.**

- "Valet looks like a PR review, then refuses to show me the files."
- "I'd never click a status badge. Badges are output. If it's a door, make it look like a door."
- "The trace tells me exactly what went wrong and then gives me nowhere to go."
- "A version is the most important noun in my world, and in Valet it's a grey chip with a tooltip."
- "Green 'ok' with two blocked requests is how drift hides. That's the call I most need to see."

**Alex's ideal top-level navigation.**

```
Needs you (3)            ← inbox: reviews, logins, confirmations, remote sign-ins
Adapters
  Woolworths             ← tabs: Overview · Tools · Permissions · Versions · Runs · Secrets
  Coles
Runs                     ← was Activity; filters: adapter, tool, version, outcome, has-blocked
  └ run detail           ← timeline | requests | step inspector (links: version, manifest, audit)
Connections              ← local clients + remote, MCP address, kill switches
Credentials              ← providers (1Password, Keychain copy, Messages); grants live on adapters
Audit log                ← every record with a call id links to its run
Settings
──────────
status footer: MCP on (copy) · chain intact (verify) · paused?
```

"Same nouns everywhere: adapter, version, run. Every one of them a link."
