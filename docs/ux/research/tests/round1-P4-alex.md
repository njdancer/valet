# Round 1 test: P4, Alex the adapter author

Simulated persona test, 2026-11-11, following `protocol-round1.md`. Alex is in character (first
person). **Researcher** notes are observations. Consistent with `interviews/P4-alex.md`: Alex works
with the IDE and authoring agent on the left and Valet at half width on the right, and thinks in
adapter → version → run.

## Part 1. Tree test

Order was fixed (A, B, C). I learned the shared subtrees (Sites, Connections, Secrets) on IA-A, so
B and C were faster for those tasks; differences below are about the parts that differ.

| Task                              | IA-A                                                                                             | IA-B                                                        | IA-C                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- | -------------------------------------------------------------------- |
| T1 Approve Woolworths 0.4.0       | Needs you → item (sure); second guess Sites › Woolworths › Versions                              | same (sure)                                                 | Home → Needs you item (sure); "Home" made me pause for a beat        |
| T2 Why last get_cart failed       | Activity › Calls, filter tool=get_cart → trace (sure)                                            | Calls → trace (sure, one fewer level)                       | History › Calls → trace (sure)                                       |
| T3 Revoke Claude Code             | Connections › Apps on this Mac › Claude Code (sure)                                              | same                                                        | Access › Connections › … (unsure: "is revoking access or a secret?") |
| T4 Remote access on               | Connections › Remote access settings (sure)                                                      | same                                                        | Access › Connections › remote (sure)                                 |
| T5 Change store                   | Sites › Woolworths › Overview (unsure: Overview or a Settings tab?)                              | same                                                        | same                                                                 |
| T6 Calls using the login password | Secrets › Grants › login → calls (unsure); second guess Activity › Audit log filter "secret use" | Secrets › Grants (unsure), then Audit log                   | Access › Secrets › Grants (unsure), then History › Audit log         |
| T7 Verify audit log               | Activity › Audit log (sure, but "Activity" isn't where I'd look first)                           | Audit log (sure, instant)                                   | History › Audit log (sure)                                           |
| T8 SMS codes from Messages        | Secrets › One-time codes (sure)                                                                  | same                                                        | Access › Secrets › One-time codes (unsure: tried Settings first)     |
| T9 Blocked until when             | Sites › Woolworths › Overview (sure)                                                             | same                                                        | Home (sure, health line), or Sites                                   |
| T10 What Claude Desktop can call  | Connections › Claude Desktop page (sure)                                                         | same                                                        | Access › Connections › Claude Desktop (sure)                         |
| T11 Trace retention               | Settings › Data and privacy (unsure; looked for it in Activity first)                            | Settings › Data and privacy (unsure; looked in Calls first) | Settings › Data and privacy (unsure)                                 |
| T12 Cloud agent with a code       | Needs you (sure)                                                                                 | same                                                        | Home (sure)                                                          |

Totals: IA-A 9 sure, 3 unsure; **IA-B 10 sure, 2 unsure**; IA-C 7 sure, 5 unsure, 0 lost.

**Winner: IA-B.** "Calls and Audit log are both first-class to me, and I visit Calls twenty times
a day. Burying it one level under Activity costs me a click on every debug loop, and putting the
audit log under 'Activity' makes T7 sound like a call list. Seven places is fine; it's a sidebar,
not a menu bar." IA-C's "Access" lumping secrets with connections was the one structure that made
me hesitate on revoke (T3) and SMS (T8).

**Researcher:** Alex's only consistently weak tasks were T6 (no tree makes "calls that used a
secret" obvious; both Secrets › Grants and the audit filter were tried) and T11 (retention lives
far from the traces it affects). Both are cross-links, not tree problems; see P4 and P6 below.

## Part 2. Labels

- **Sites vs Adapters:** Adapters, narrowly. "What I version, approve and debug is an adapter. A
  site is where it runs." I'll accept **Sites** in the sidebar for Sam's sake _if_ the page header
  shows the adapter id and version (`woolworths 0.3.0 · 9f3c…e0f1`) and the Versions tab says
  "adapter versions".
- **Connections** over Clients and Connected apps. "Clients" is my word, but Connections holds the
  endpoint and remote access too, which aren't clients. "Connected apps" excludes cloud agents.
- **Secrets** over Passwords and Credentials. It matches the manifest (`secrets`, `secretRef`), and
  one-time codes aren't passwords.
- **Activity vs History:** neither; I want **Calls** (IA-B). Between the two, Activity, because
  History sounds like it stops at yesterday.
- **Needs you** over Inbox and Waiting. It's also what the agent tells the person, so it's the word
  I grep for in tool results.

## Part 3. Hypothesis feedback

**E1, accept.** "A separate **Review update** button beside the badge would have got me there on
the first try. E1b, a badge with a chevron, I'd still read as a status pill at half width; I
skipped exactly that today." E1 finds the review; E1b probably not. Refine: the adapter header's
Version row should also carry it ("0.3.0 live · 0.4.0 waiting · Review").

**E2, accept, top priority for me.** Every object a link, both ways. Add _version_ and _hash_ to the
list of objects explicitly; they're missing from it. Context menu: Copy, Open, and for a hash,
"Compare with live".

**E3, accept.** "Exactly my interview ask: labels don't select, values do." Refine: code diffs and
JSON need multi-line selection, and Copy on a trace should give the whole step as JSON.

**E4, refine.** Fine for revoke. But for _reject_ on a review, don't make me confirm: a rejected
dev build is cheap and I'll push another one. Confirm the consequence only where something stops
working.

**E5, accept** for confirmations and remote codes. Low value for me otherwise.

**E6, refine.** One health line is good, but it must have a state for "working, but N requests
blocked in the last hour". That's drift starting, and today it reads green "ok".

**E7, accept.** "12 blocked requests" opening Calls filtered to blocked is the single most useful
door for an author.

**E8, refine.** Plain first is fine _if_ Details is one click and remembered. Give me a "Show
technical names" preference (tool ids instead of sentences in Calls, stage/errorClass inline),
not a Details twisty on every row.

**E9, accept.** No notes; Jordan's call.

**E10, accept.** Add: pausing one adapter, not only everything, from the adapter page.

**E11, accept.** The "Adapters 3" vs "2 installed" confusion is exactly this.

**P1 Needs you, accept.** Refine: reviews from the authoring agent should say so ("from the IDE,
repair for ticket #12") and group repeated dev builds of the same adapter into one row showing only
the newest, so I don't approve a stale hash.

**P2 One page per site, accept with changes.** The Versions tab is the thing I asked for, but as
written it's "pending review, history, compare". It needs:

1. **Restore** a previous hash with the approval gesture (the design doc promises one click).
2. Each version row shows who/what authored it, approval time, and **its calls** (link to Calls
   filtered by hash), so I can see whether 0.4.0 fails where 0.3.0 didn't.
3. Compare any two versions, not only pending vs live, with the same permission-first diff as the
   review.
   Also add **Secrets** as a tab (grants are per hash; I re-grant on every dev build, so it belongs
   next to Versions).

**P3 Review update as a full page in the site, accept.** "Better than the floating window: I keep
the sidebar, and Escape returns me to the trace I came from." Must-haves to close my loop: file
rows open a real code diff; the approve control works from the keyboard (Return after the
acknowledgement, which itself should be focusable and next to the button); and the pre-ticked
"keep the same 1Password item" when auth, egress, navigation and session are byte-identical.

**P4 Activity with URL filters and linked trace, accept, insufficient.** Header links are half of
it. The other half is the **step inspector**: click a step or request, see the full URL,
initiator, decision and reason, and actions "Show in manifest", "Copy as request declaration",
"Open audit record". Add filters for **version/hash** and **has blocked requests**. And "ok with
blocked requests" must be its own outcome colour in the list.

**P5 Connections, accept.** "Remote is a kind of client. Finally."

**P6 Secrets, accept.** Grant → calls that used it answers T6, which no tree did on its own.

**P7 Settings, accept.** Put a "Keep traces for…" link on Calls too (T11).

**P8, pick P8a.** "When the agent pushes a build, I open Valet to approve it. Opening straight onto
Needs you is the loop. When nothing waits, put me on Sites. P8b's Home is a dashboard I'd scroll
past every time; P8c makes me take one extra click on exactly the moment I'm in a hurry." Refine:
if the window was just closed (say within five minutes), reopen where I was; I'm usually mid-trace.

**P9 Setup test, accept** (not my flow; fine).

**P10 Confirmation, accept.** Add tool id, call id and version in small type at the bottom, so a
test confirm can be matched to its run.

**P11 Menu bar, accept.** Site rows clickable is good. Add the live version and a dot when a
review is waiting, and make a waiting review open the review page directly.

**Vocabulary table, accept with two additions.** "Review the Woolworths update (0.4.0)" should
include who made it in the app ("from the authoring agent"). And add a row for drift:
"Woolworths tools are working but Valet blocked N requests the adapter didn't declare" so the agent
and the app say the same thing, and it matches the trace's "undeclared request".

### Do P2's Versions tab, P3 and P4 give me edit, review, run, debug?

- **Edit:** in the IDE, out of scope. Fine.
- **Review:** _mostly yes_ with P3, _if_ file diffs open and approve is keyboard-fast. Without
  file diffs, no.
- **Run:** _not addressed._ Nothing says which hash a running or just-finished call used, in the
  list or the menu bar. After approving I need "next call will use 0.4.0" and each call row to show
  its version, or I can't tell whether my fix is live.
- **Debug:** _half._ P4 gets me from a call to the adapter and version; without the step inspector
  and "Show in manifest" I still retype selectors and URLs from a picture.
- **Versions:** compare is there; restore and per-version calls aren't. Those are what turn
  "it broke after my change" into a one-minute rollback.

Verdict: P2 + P3 + P4 close maybe 60% of the loop. The remaining 40% is step inspector, version on
every call, and restore.

## Part 4. What the hypotheses missed

"My biggest worry if everything shipped: I'd still be approving agent-written code I can't read in
Valet, and doing it many times a day. The heavy review exists to stop a bad proposal; if every dev
build costs a review plus a re-grant, I'll start clicking through it without reading, which is the
outcome the design doc warns about. You need the review to be _fast when nothing risky changed_
(code-only diff, same auth block: one screen, file diffs, keep-grant pre-ticked, Return to
approve) and _loud when something did_ (new host, moved secret fill). Nothing in E or P
distinguishes those two speeds."

Second worry: the repair ticket ("Woolworths needs a repair", authoring-agent.md) has no home in
any tree. It should be a Needs you item and a banner on the site's Overview, linking to the failing
calls that opened it.
