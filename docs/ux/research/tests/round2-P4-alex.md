# Round 2 test: P4, Alex the adapter author

Simulated persona walkthrough of `docs/ux/wireframes/index.html` (2026-11-11), following
`protocol-round2.md`. Alex in character; **Researcher** marks observations. Frames were screenshotted
at 920 px and read; the ones that matter most to Alex were `site-versions`, `site-review-update`,
`site-review-diff`, `site-review-quick`, `activity-calls`, `activity-call-ok-blocked`,
`activity-call-failed` and `activity-call-step-login`. Consistent with my interview (adapter →
version → run) and round 1 (IA-B, P8a; the IA chose IA-A with Calls as a real tab, which I accept).

## Part 1. Scenario walkthrough

**S1. Approve Woolworths 0.4.0 from the site page.** `site-overview-update`: I see the
"0.4.0 waiting for review" badge _and_ a "Review Woolworths update" button, plus a banner with
"Review update" and "Compare". Click → `site-review-update`. **Works.** It's the fix for Nick's
complaint, done three ways. The review page: "What's new" lists exactly three additions, the
new host is flagged as "a different site from woolworths.com.au", Code card has "Open diff" per
file → `site-review-diff`. Acknowledgement checkbox sits right beside Approve ↵. **Works.**
Friction: the diff opens in a ~600 px modal over the review; for real code I want it full-width or
in the page (`site-review-diff`).

**S2. Log in when asked.** `needs-you` → "Show login window" → `login-handoff`, which names the call
and the client. **Works.** (But see call ref inconsistencies, Part 3.)

**S3. Confirm a removal.** `needs-you` → Answer… → `confirm-ready`. Footer shows
`remove_from_cart · call 7F2A · Woolworths 0.3.0 · 9f3c1a7e`, exactly the round 1 ask. **Works.**

**S4. Why did the last get_cart fail?** `activity-calls`: filters for Site, Tool, App, Outcome,
Version, "Has blocked requests"; Ref and Version columns; "Failed · site changed" on 6B3E. Click 6B3E →
`activity-call-failed`. The banner explains, the failing `GET /api/ui/Trolley 404` is selected, and the
inspector shows "Declared as", "Show in adapter declaration", "Copy step as JSON", "Audit record
4805". **Works.** Friction: the inspector stops at the request; it doesn't say _which line of tool
code_ made it (see A2).

**S5. Connect Claude Desktop.** Connections → Add an app (`connections-add-app`). **Works**; not my
flow, no notes.

**S6. Cut off Claude Code.** `connections-revoke`: the dialog names what stops, lists recent calls,
offers Reset access instead. **Works.**

**S7. Is Woolworths blocking me?** `site-overview-limited`: plain line, resume time, Try now, Pause
site, and a Details line with the call that tripped it. **Works.**

**S8. First launch.** `setup-approve` is a plain-language summary with "See every request it may
make". **Works** for Sam; I'd go to the link. Inconsistency below (provenance).

**S9. Remote access.** `connections-remote-on`: public name, cloud agents, per-tool switches.
**Works.**

**S10. Audit chain.** Audit log tab, record → "Open call" (`activity-audit-record`). **Works**, both
directions now (trace header has "Audit records (8)").

**A1 (mine). Approve a dev build fast.** `site-review-quick`: title says "Quick review", repair ticket
#12 linked, "replaces 2 older dev builds", Valet-computed "Nothing it can reach changes", inline diff,
keep-login pre-ticked, focus on Approve, Return approves. This is the screen I asked for. **But
broken on one point:** the header says it was "Checked against 0.4.0", and 0.4.0 is _not approved_
(it's waiting, with a new host). So "nothing it can reach changes" is measured against an
unapproved baseline: 0.4.1-dev quietly carries `api.woolworthsrewards.com.au` past the full review.
**Broken (blocker).** It must diff against the live approved hash (0.3.0).

**A2 (mine). Failed call → failing step → manifest line.** `activity-call-ok-blocked`: amber banner
"It worked, but Valet blocked 2 requests the adapter didn't declare", "ok, 2 blocked" badge in its
own colour, step selected, inspector with Asked for by, Decision, Why, "Copy as request
declaration". **Mostly works.** Friction: "Show in adapter declaration" is offered on an _undeclared_
request, where there's nothing to show; it should read "Show nearby declarations" or be replaced
by "Add to manifest draft". Missing: the tool-code source location (`src/tools/cart.ts:42`) for a
request the tool code made, which is the actual jump I make into the editor. **Friction (major).**

**A3 (mine). Compare two versions.** `site-versions`: compare pickers (any two), per-row Compare,
Restore…, login per version, calls per version linked to Calls filtered by version. Structure is
right. But **there is no frame for the compare result or for restore mode**. The notes say compare
"opens the same permission-first diff as the review, read-only" and restore is "a review page in
restore mode"; neither is drawn, so I can't judge them. **Missing frames.**

**A4 (mine, new). Run after approving: am I testing the new hash?** After Approve on
`site-review-update`, where do I land, and what tells me the next call uses 0.4.0? No post-approve
state is drawn (no toast, no Overview with "0.4.0 live since 10:14 pm"). The Version column on
`activity-calls` will tell me after the fact, which is good. **Missing frame.**

## Part 2. Round 1 pain points

| #   | Pain point                                                       | Status                                                                                                                                                     | Frame                                                                          |
| --- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 1   | Trace is a dead end                                              | **Fixed, mostly.** Header fields are links, steps open an inspector, audit both ways, Copy as JSON. Still missing: source location for tool-code requests. | `activity-call-ok-blocked`, `activity-call-failed`, `activity-call-step-login` |
| 2   | No version history, compare, restore                             | **Partly.** History with calls and login per version is excellent; compare and restore are promised but not drawn.                                         | `site-versions`                                                                |
| 3   | Can't open code in the review                                    | **Fixed.** Open diff per file, unified/split, ↑↓ between files. Modal is cramped.                                                                          | `site-review-update`, `site-review-diff`, `site-review-quick`                  |
| 4   | Review link disguised as a badge                                 | **Fixed.** Button beside badge, banner button, Needs you item, Versions banner.                                                                            | `site-overview-update`, `site-versions`, `needs-you`                           |
| 5   | Activity can't filter by adapter/tool/version; sentences not ids | **Fixed.** Site · tool id · sentence in one cell; Version filter and column; "Has blocked requests".                                                       | `activity-calls`, `activity-calls-filtered`                                    |

## Part 3. New problems

**Blockers**

- **Quick review baseline is the unapproved 0.4.0** ("Checked against 0.4.0 at 10:12 pm", "0.4.0
  4b7e…a83c → 0.4.1-dev"). A dev build stacked on a pending widening gets waved through. Diff against
  the live approved hash, and if a pending update widens access, the newer dev build inherits the
  full review. `site-review-quick`.

**Major**

- **Call ref 7F2A means four different calls.** `needs-you` and `confirm-ready`: remove_from_cart
  at 9:48; `site-overview-update`: "Last call 9:47 pm · Get cart · call 7F2A"; `login-handoff`: "Get
  cart at 9:47 pm · call 7F2A"; `site-overview-limited`: "too many requests at 9:22 pm, call 7F2A".
  `activity-calls` has 9A71 for the 9:47 get_cart. Refs are the thing I copy into the agent; the
  wireframes have to be exact or the build will copy the mess.
- **"From the authoring agent in Claude Code"** (`site-review-update`, `site-review-quick`,
  `site-versions`) links to the Claude Code _client_ page. The authoring agent runs in my IDE;
  Claude Code is also the caller in every trace. Conflating author and caller in the place where I
  decide trust is wrong. Say "authoring agent (IDE)" and link the repair ticket, not a client.
- **Provenance disagrees:** `setup-approve` says "0.3.0 comes with Valet"; `site-versions` says
  0.3.0 is from "Authoring agent" and 0.1.0 "From a file". Pick one model.
- **No authoring provenance in the review.** The design doc wants model, recordings, agent-lowered
  purposes, agent-written fake handlers, lint findings and the IDE repro check result. None appears
  on `site-review-update` or `site-review-quick`. For agent code, "repro check passed on the old
  and new bundle" is the line I most want before Return-to-approve.
- **Missing frames:** compare result, restore review, post-approve state, and the "Woolworths
  changed: the adapter needs an update" repair item (it's in the IA's item table but not on
  `needs-you`). `site-versions`, `needs-you`.
- **Tool-code source location missing** from the request inspector. `activity-call-ok-blocked`,
  `activity-call-failed`.

**Minor**

- Needs you count disagrees across frames: 4 on `needs-you` (which lists 4), 3 on Activity frames,
  1 on Sites frames. Fine as separate moments, but the design thread will copy them; annotate.
- Approval date: `confirm-ready` "approved on 2 Nov"; header and `site-versions` "Fri 6 Nov".
- `activity-call-ok-blocked` header "4 allowed" vs the timeline's 2 allowed tool requests (are the
  probes counted?). Say "2 allowed + 2 checks".
- `activity-call-failed`: "3 of the last 4 Woolworths calls failed this way since 9:20 pm", but
  `activity-calls` shows one site-changed failure since then.
- `site-overview-limited` shows Woolworths limiting, but `activity-calls` has Yahoo Finance as the
  site-limited call. OK if they're different moments; label them.
- "Show in adapter declaration" on an undeclared request (`activity-call-ok-blocked`).
- Diff modal is ~600 px wide with "50 more lines · scrolls"; give it the full content area or a
  resizable sheet. `site-review-diff`.
- Versions table: the waiting 0.4.0 is only in the banner, not a row; I'd want it as the top row
  marked "waiting" so Compare pickers and the table agree. `site-versions`.
- Per-row "Compare" doesn't say "with what" (live? previous?). `site-versions`.

## Part 4. Verdict

I'd sign off on the IA and most of the wireframes, provided these are fixed first:

1. Quick review diffs against the live approved hash, not the pending one (`site-review-quick`).
2. Call refs, approval dates and provenance are made consistent across frames.
3. Author ("authoring agent, IDE, ticket #12") is kept apart from caller (Claude Code).
4. Frames are drawn for compare, restore, post-approve and the repair Needs you item.
5. Authoring provenance (including the repro check) goes into the review.
6. The request inspector gets a tool-code source location.
