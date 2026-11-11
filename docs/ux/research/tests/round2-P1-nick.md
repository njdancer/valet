# Round 2 test: P1, Nick (owner and power user), wireframe walkthrough

Simulated session, 2026-11-11, following `protocol-round2.md`. I read
`information-architecture.md` and screenshotted the frames I walked through (about 30 of 73). Nick
speaks in first person; **R:** marks researcher notes. Frame ids are in `backticks`.

**R:** Nick's round 1 tree-test pick was IA-B, but IA-A shipped. He accepts it because Audit log
got its own tab with its own shortcut (`⇧⌘3`). That was the condition he set in round 1.

## Part 1. Scenario walkthrough

| Step                                    | Frame                                              | I'd click                                                       | Next frame              | Result                                                                                                                                                                                                               |
| --------------------------------------- | -------------------------------------------------- | --------------------------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **S1** Approve 0.4.0 from the site page | `site-overview-update`                             | "Review Woolworths update" (header) or "Review update" (banner) | `site-review-update`    | **Works.** This was my first-run problem and it's gone: two real buttons. The page has three ways to reach the review (header button, banner, badge), which is one too many.                                         |
| S1 cont.                                | `site-review-update`                               | Tick "I've read the new web address", Approve `↩`               | back to `site-overview` | Works. The tick sits next to Approve and only appears because a host was added, which is what I asked for.                                                                                                           |
| S1 alt                                  | `site-versions`                                    | Review update / Compare                                         | `site-review-diff`      | Works.                                                                                                                                                                                                               |
| **S2** Log in when asked                | `menubar-waiting` → Show ›                         | `login-handoff`                                                 |                         | Works. Countdown with clock time, sorted by deadline.                                                                                                                                                                |
| **S3** Confirm a remove                 | `confirm-ready`                                    | Remove / Don't remove                                           |                         | **Works, best frame in the set.** The sentence comes first and the buttons are named by verb, with focus on the safe one.                                                                                            |
| **S4** Why did get_cart fail            | `activity-calls` → Tool filter, or click `6B3E`    | `activity-call-failed`                                          |                         | Works. The search box matches tool names, and each row shows the tool and the sentence. The trace header fields are links, and "Compare with 0.4.0" and "Copy a repair note" are exactly my author loop.             |
| **S5** Connect Claude Desktop           | `connections` → Add an app…                        | `connections-add-app`                                           |                         | Works.                                                                                                                                                                                                               |
| **S6** Token leaked: cut it off         | `connections` → Open → `connections-app` → Revoke… | `connections-revoke`                                            |                         | Works. The dialog names what breaks and lists the calls that will be declined, and it offers "Reset access instead". Revoke is red.                                                                                  |
| **S7** Woolworths blocking us           | `site-overview-limited`                            | Try now / Pause site                                            |                         | **Works.** It says when calls resume, shows a warning on Try now, and has a per-site pause. My round 1 blocker is fixed.                                                                                             |
| **S8** First launch                     | `setup-welcome` … `setup-test` → `setup-done`      | Continue                                                        |                         | Works. The live "Watching for Claude's call" check is great. `setup-blocked` replaces the dead-end pages.                                                                                                            |
| **S9** Remote access                    | `connections` → Set up remote access…              | `connections-remote-on`                                         |                         | Works. The tools start off, and the switches use the same tool names as everywhere else.                                                                                                                             |
| S9 cont. Approve a cloud agent          | `needs-you` → Approve…                             | `needs-you-approve-connection`                                  |                         | **Friction.** The sheet doesn't say which agent or where it's connecting from. The old screen showed "claude.ai · from 203.0.113.24 · calls itself Claude". For the riskiest prompt in the app, that's a regression. |
| **S10** Audit untouched                 | `activity-audit` → Check now                       | `activity-audit-broken` (for the failure)                       |                         | Works. It shows when it was last verified, and the call refs are links.                                                                                                                                              |
| **N1** Pause everything from the window | toolbar Pause Valet / `⇧⌘P`                        | `global-pause-undo`                                             |                         | Works. There's an Undo toast and the sidebar footer changes.                                                                                                                                                         |
| **N2** Keyboard to Needs you, approve   | `⌘1` → `needs-you`, `⌘K` → `global-palette`        |                                                                 |                         | Works for navigation. **Missing:** a frame for moving between Needs you items with the keyboard (arrows, Return = main action).                                                                                      |
| **N3** Change store                     | `site-overview` → Change store…                    | `site-store-sheet`                                              |                         | Works.                                                                                                                                                                                                               |
| Author: quick review of a dev build     | `site-review-quick`                                | Approve `↩`                                                     |                         | Friction, and see the blocker in Part 3.                                                                                                                                                                             |

## Part 2. Round 1 pain points

1. **Status not actionable where I see it: fixed.** Every status has a button beside it
   (`site-overview-update`, `site-overview-limited`, `needs-you-empty`), and the numbers are links
   (`site-overview` Today, `menubar-waiting` Today).
2. **No single Needs you, and the menu bar clipped it: fixed.** `needs-you` has a Missed section,
   and `menubar-waiting` shows 3 rows plus "+1 more in Valet", with remote connections included.
3. **No quick controls in the window: fixed.** Pause and Lock down are in the toolbar, the app
   menu (`global-app-menu`) and the palette (`global-palette`). The keyboard is fixed for pages
   but not for lists (N2).
4. **Inconsistent naming and structure: partly fixed.** The sidebar never changes shape, and
   Clients and Settings are split. But "trolley" and "cart" still sit side by side in one row
   ("Remove from cart" … "from your trolley", `confirm-ready`; "3 change your trolley" on
   `connections-app` vs "3 change your cart" on `site-overview`). The app menu says "Needs You"
   with a capital Y.
5. **Web-page feel: partly fixed (can't verify yet).** It's a wireframe, so selection and native
   feel are for the design thread. The layouts no longer have the dead bands I complained about.

## Part 3. New problems (harsh)

**Blocker**

- **B1 `site-review-quick`: the quick review is checked against an unapproved version.** It says
  "Nothing it can reach changes … Checked against 0.4.0", but 0.4.0 is still waiting for review
  everywhere else, and 0.3.0 is the live version. A quick review must diff against the **live
  approved** version, or it lets a dev build skip the 0.4.0 host addition. It also needs a rule
  for which pending reviews collapse.
- **B2 `needs-you-approve-connection`: no agent identity in the code sheet.** Show the origin, the
  IP, the name it calls itself, and "Only approve if you just started this", as `connections-remote-on`
  already does. Without them I'm approving a code blind.

**Major (consistency: the fake data contradicts itself, and that will leak into the build and the QA rounds)**

- **M1 Call ref 7F2A means four different calls.** It's remove_from_cart at 9:48 (`activity-calls`,
  `confirm-ready`), "Last call 9:47 pm Get cart · call 7F2A" (`site-overview`), "got too many
  requests at 9:22 pm" (`site-overview-limited`), "Call 7F2A · Get cart · 9:53 pm · ok"
  (`global-palette`) and the setup test call (`setup-test`). Refs are the thing I'd grep. They
  must be unique across all frames.
- **M2 Per-site counts equal the global ones.** Woolworths shows "37 calls" (`site-overview`), but
  37 is the total across all sites; `global-pause-undo` gives Woolworths 12, Yahoo 20 and
  Wikipedia 5. "2 failed / 12 blocked" is copied the same way.
- **M3 The revoked Cursor still counts.** "3 apps" can reach Woolworths (`site-overview`), Cursor
  is in "Called by" and "callable by Cursor" (`site-review-update`), but the footer says "2 apps
  connected" and `connections` shows Cursor revoked.
- **M4 Health dots disagree with the page.** On `needs-you-empty` Woolworths is Ready but its
  sidebar dot is orange, and Yahoo is limited but its dot is green. On `site-overview` Woolworths
  is Ready while the Needs you badge is 1, and the item behind that badge isn't stated.
- **M5 "Add a site…" on `global-pause-undo`** contradicts IA §10 ("adding a site is out of
  scope"). Either draw the flow or remove the button.
- **M6 Too many review entry points** on `site-overview-update`: a header button, a banner button
  and a badge all say the same thing. Keep the banner (status + action, as E1 says) and the header
  button. The banner also has "Compare", which should go: it lives on Versions.
- **M7 No keyboard frame for lists** (Needs you, Calls, Audit): focus ring, arrow keys, Return to
  run the main action, Space for details. For me this is the core of "utility, not dashboard".
- **M8 Reset access and Revoke appear twice** on `connections-app` (the header and the Access
  card). Pick one place, the header.

**Minor**

- m1 `activity-calls`, `activity-audit`: the "Since" filter wraps onto its own line, which is the
  same orphaned-filter glitch I complained about in round 1. Put it on one row, or put time first.
- m2 `global-app-menu`: two menus are drawn open at once, and "Needs You" should be "Needs you".
- m3 `needs-you`: the header pill "4 waiting · next ends 1:42" duplicates the first row's
  countdown. Keep just "4 waiting".
- m4 `activity-call-failed`: "Pause Woolworths" inside the failure box is the same action as
  "Pause site" in the health line. Use the same label everywhere ("Pause site").
- m5 `site-overview`: the "Today" sparkline is unlabelled and too small to read. Either give it an
  axis or drop it.
- m6 `connections`: "Remove from list" on the revoked Cursor. Does it delete the audit attribution?
  Say so.
- m7 `menubar-waiting`: the Pause button's dropdown (Lock down) has no frame of its own.

## Part 4. Verdict

**I'd sign off on the IA (IA-A with real Calls / Audit log tabs, P8a) and on the wireframes as a
direction, conditional on these must-fixes:** B1 (`site-review-quick` diffs against the live approved
version), B2 (agent identity in `needs-you-approve-connection`), M1–M4 (one consistent fake
dataset: unique call refs, per-site counts, the revoked Cursor gone, dots that match the health
line), and M7 (a keyboard-navigation frame for Needs you and Calls). M5, M6, M8 and the trolley/cart
wording before the build; the minors in the design pass.
