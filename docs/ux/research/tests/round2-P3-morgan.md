# Round 2 test: P3 Morgan, the security-minded reviewer

Simulated persona walkthrough of `docs/ux/wireframes/index.html` against
`docs/ux/information-architecture.md`, following `protocol-round2.md`. Frames were screenshotted
and read; frame notes were checked in `wireframes/frames/*.js`. Morgan speaks in the first person;
researcher notes are marked **R**.

## Part 1. Scenario walkthrough

| #                              | Step: frame → click → next frame                                                                                                                                                                                          | Result                                                                                                                                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1                             | `site-overview-update`: banner **Review update** (or header **Review Woolworths update**) → `site-review-update` → Open diff → `site-review-diff` → Back to review → tick "I've read the new web address" → Approve 0.4.0 | **Friction.** The route is fixed. The review itself has a blocker: the login carry-over is ticked by default (Part 3, #1).                                                                                              |
| S2                             | `needs-you` → **Show login window** → `login-handoff` → I'm done                                                                                                                                                          | **Works.** I like "Can only open woolworths.com.au, auth.woolworths.com.au" and "Give up … tells Claude you didn't log in". The call ref is wrong (Part 3, #5).                                                         |
| S3                             | `needs-you` → **Answer…** → `confirm-ready` → Don't remove / Remove                                                                                                                                                       | **Works.** The split between "adapter wrote this sentence" and "Valet checked the request" is kept. Dates disagree (Part 3, #6).                                                                                        |
| S4                             | `activity-calls` → row → `activity-call-ok-blocked` / `activity-call-failed` → blocked step → **Show in adapter declaration**, **Audit record 4801**                                                                      | **Works.** This is the evidence-to-rule link I asked for. The header fields (Site, Version, Tool, App, Login used) are all links.                                                                                       |
| S5                             | `connections` → **Add an app…** → `connections-add-app`                                                                                                                                                                   | **Works.**                                                                                                                                                                                                              |
| S6                             | `connections` → Claude Code **Open** → `connections-app` → **Revoke…** → `connections-revoke` → Revoke Claude Code                                                                                                        | **Works.** It names the client, shows what it did recently (141 calls, last 3), says its 2 waiting calls will be declined, and defaults to Cancel. Reset access (`connections-reset-undo`) is the problem (Part 3, #3). |
| S7                             | `needs-you-empty`: the Yahoo line "limiting requests · calls resume at 9:52 pm" → Try now / Pause site; `site-overview-limited`                                                                                           | **Works.** I'd still want "opened by call 1C55" on the line itself; the audit log has it (record 4807).                                                                                                                 |
| S8                             | `setup-welcome` → … → `setup-test` → `setup-done`                                                                                                                                                                         | **Works** (not my focus).                                                                                                                                                                                               |
| S9                             | `connections` → **Set up remote access…** → `connections-remote-on`; then `needs-you` → **Approve…** → `needs-you-approve-connection`                                                                                     | **Broken for me.** The sheet lost the source IP, the "calls itself" name and the "if you didn't start this, someone else did" warning. Read tools are ticked by default (Part 3, #2).                                   |
| S10                            | `activity-audit` → **Check now** → banner "checks out · verified 9:48 pm", head hash with a copy button → **Export…**; broken: `activity-audit-broken`                                                                    | **Works.** It has re-check, a timestamp, a copyable head, and "Expects before it / Record 4789 is" on a break. Wording issue (Part 3, #8).                                                                              |
| S11 Which calls used the login | `secrets` → Woolworths login → `secrets-login` → **Calls that used it**, **All 5 calls in 7 days**, **Login use in the audit log**                                                                                        | **Works.** It answers the question from both ends.                                                                                                                                                                      |
| S12 What can Claude Code reach | `connections-app` → **Can reach**: 12 tools on 3 sites, 5 hosts, 1 login, with "Apps on this Mac can call every approved tool. Why?" and Copy as text                                                                     | **Works**, and it's what I asked for. The site-side version counts a revoked app (Part 3, #4).                                                                                                                          |
| S13 Revoke everything fast     | Toolbar **Pause Valet ▾** → Lock down… → `global-lockdown` → Lock down                                                                                                                                                    | **Friction.** The dialog is good. There is no frame for the locked-down window, the menu bar while locked, or Unlock (Part 3, #7).                                                                                      |

**R:** No frame shows S9's remote warning state, the locked-down state, or a remote client's page
(`connections-app` is local only).

## Part 2. My round 1 pain points

1. **No blast-radius view: fixed.** `connections-app` (Can reach), `site-overview` (Can reach card),
   `secrets-login` (What can cause Valet to type this login). They are computed, timestamped, and
   copyable as text. It's exactly the join I used to do by hand. Two gaps remain: the remote approve
   sheet has no Can reach preview, and the site's count is wrong.
2. **Evidence and controls on different pages: fixed.** Trace ↔ declaration ↔ audit record
   (`activity-call-ok-blocked`, `activity-audit-record` with **Open call 8F2E**). Grant ↔ calls
   (`secrets-login`). Client ↔ calls ↔ audit records (`connections-app`). Counts are doors
   (`needs-you-empty` "Today", `menubar-normal` tiles).
3. **Unconfirmed destructive actions, kill switches only in the menu bar: partly fixed.** Revoke
   is fixed (`connections-revoke`), and Lock down sits in the toolbar, menu bar and app menu
   (`global-lockdown`, `global-app-menu`). Still open:
   - Reset access acts at once with Undo, which restores a token I may have reset _because_ it
     leaked (`connections-reset-undo`).
   - Lock down is one level down, behind ▾.
   - The grant **Revoke…** on `secrets-login` has no frame for its dialog.
4. **Status I can't re-check: fixed.** Each status has "Check now" and a time (`needs-you-empty`,
   `site-overview`, `connections`, `activity-audit`). The head hash is copyable. The sidebar footer
   leads to the status block.
5. **Inconsistent inventory and naming: not fixed, it moved.** Revoked Cursor still counts as able
   to call the site. Call refs and approval dates disagree between frames (Part 3).

## Part 3. New problems

1. **Blocker: `site-review-update`.** "Keep using your Woolworths login for 0.4.0" is **ticked by
   default** on an update that adds a new egress host, `api.woolworthsrewards.com.au`. The note
   says the login pages are identical. But the risk isn't the login pages: tool code in 0.4.0 can
   now send requests carrying the logged-in session to a new host. The security model says grants
   don't carry over, and D47 (re-bind on update) is still open. Required change:
   - unticked whenever egress, navigation or the request surface widens;
   - the new-host row restores the old consequence text ("tool pages may send requests, including
     your session cookies, here");
   - the "I've read" tick covers all additions, not only the address.
2. **Major: `needs-you-approve-connection`.** Two read tools are pre-ticked. The security model says
   "Remote tools are off by default, per tool", and round 1's own sheet said "Every tool starts off".
   Also:
   - The request's origin IP, its self-reported name and the "a request you didn't start was
     started by someone else" warning are gone.
   - There is no Can reach preview. Ticking "Woolworths · View cart" lets a cloud agent cause a
     login fill, and the sheet should say so ("Can cause Valet to type 1 login").
3. **Major: `connections-reset-undo`.** Undo after Reset access, and "old token works for 10 s".
   For a suspected leak, both the grace period and the Undo hand the token back. If a grace period
   is needed for the bridge, say so in the dialog. Remove Undo, or offer it only when the reset
   wasn't from Lock down or a "this leaked" path.
4. **Major: inconsistent with `connections`.** Cursor is revoked there, yet:
   - `site-review-update` says the new tool is "callable by Claude Code, Claude Desktop, Cursor";
   - `site-overview` / `site-overview-update` say "Called by … Cursor 0" and "3 apps … can call it";
   - the footer everywhere says "2 apps connected".

   A Can reach that counts a revoked client is the one number I must be able to trust.
5. **Major: call refs.** `login-handoff` and `site-overview` ("Last call 9:47 pm · Get cart · call
   7F2A") give get_cart the ref 7F2A, but in `activity-audit`, `needs-you` and `connections-app` 7F2A
   is remove_from_cart at 9:48 and get_cart at 9:47 is 9A71. Refs are the thing I paste into the
   audit search.
6. **Minor: dates.** `confirm-ready` says "approved on 2 Nov"; `site-overview` and `site-versions`
   say approved Fri 6 Nov (7:54 pm).
7. **Major: missing frames.** No frames for:
   - the window and sidebar while locked down, or the Unlock flow (only one menu bar line in
     `70-menubar.js`);
   - the grant Revoke dialog;
   - a remote client's own page with its Can reach and per-tool scopes.

   Lock down should also say what happens to calls in flight and to waiting confirmations (are they
   declined?).
8. **Minor: `activity-audit-broken`.** It says every new record "links to the last good one, so
   later checks still find this break", yet records 4791 to 4797 are all marked "after the break".
   Either the chain re-anchors or it doesn't. Also say whether a record was changed or deleted, if
   Valet can tell.
9. **Major: `site-grant-sheet`.** It dropped the old "The adapter can / It can't" panel, which was
   the best consequence statement in the app. It also lists "Woolworths Rewards, saved for
   woolworthsrewards.com.au" without warning that its saved site doesn't match
   auth.woolworths.com.au. Show a Can reach summary for the grant before **Use this login**.
10. **Minor: `site-permissions`.** "What it can do" says "Open pages on woolworths.com.au", while the
    hosts include `cdn0.woolworths.media`, a different domain. The plain summary must never be
    narrower than the truth. Label "What it can't do" as worked out by Valet from the declaration
    (as the confirmation does), not as a claim.
11. **Minor: `connections`.** The endpoint is a toggle switch, while the notes say "On is a status;
    Turn off is the button beside it" (E1). Pick one.
12. **Minor: `menubar-normal`, toolbar.** Lock down is only inside Pause's ▾ menu. I accept this if
    ⌥⇧⌘L is shown in that menu and in the palette. A first-time security reviewer won't open a
    dropdown on "Pause" looking for an incident response.

## Part 4. Verdict

I'd sign off on the IA and most of the wireframes. Can reach, revoke, the audit log and evidence
links are what I asked for. Must fix first:

1. login carry-over unticked when access widens (`site-review-update`);
2. remote tools off by default, with source IP, warning and Can reach (`needs-you-approve-connection`);
3. no Undo or grace token after a reset meant for a leak (`connections-reset-undo`);
4. Can reach must exclude revoked apps, and call refs and dates must be consistent (`site-overview`,
   `site-review-update`, `login-handoff`, `confirm-ready`);
5. draw the locked-down state, Unlock and the grant Revoke dialog (`global-lockdown`, `secrets-login`).
