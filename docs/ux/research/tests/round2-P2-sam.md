# Round 2 test: P2, Sam (first-time non-technical installer)

Simulated persona walkthrough of `wireframes/index.html`, 2026-11-11, following
`protocol-round2.md`. This test is consistent with `interviews/P2-sam.md` and `round1-P2-sam.md`.
Sam speaks in first person; researcher notes are marked **R:**. Every frame was screenshotted and
looked at, and setup, Needs you and the menu bar were looked at most closely.

## Part 1. Scenario walkthrough

Ratings: works / friction / broken.

| Scenario and step                        | Frame                                      | What I'd click                               | Next frame            | Rating                                                                                                                                                                                             |
| ---------------------------------------- | ------------------------------------------ | -------------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **S8 setup.** Welcome                    | `setup-welcome`                            | Get started                                  | `setup-1password`     | works. "Let Claude shop at Woolworths for you" and "Valet never pays" are exactly right.                                                                                                           |
| 1Password, happy path                    | `setup-1password`                          | Continue                                     | `setup-approve`       | works. Three ticks, with no account name to type.                                                                                                                                                  |
| 1Password, off                           | `setup-1password-problem`                  | Open 1Password settings, then come back      | (auto re-check)       | friction. The button exists, but the red box covers the text ("'…grate with other apps' is off"), and "1Password service account" is still offered to me.                                          |
| Approve                                  | `setup-approve`                            | Approve Woolworths                           | `setup-login`         | works. "Claude will be able to / It can't" is what I asked for. "Not now" is quiet, not red.                                                                                                       |
| Login                                    | `setup-login`                              | Use this login                               | `setup-store`         | friction. The codes row mixes a button ("Read codes from Messages…") with a single radio button ("I'll type them") that I can't untick.                                                            |
| Store                                    | `setup-store`                              | type 2000, Shop at Town Hall                 | `setup-connect`       | works. "Skip for now" collides with an annotation, but that's only the wireframe.                                                                                                                  |
| Skipped approve                          | `setup-blocked`                            | Go to Approve Woolworths                     | `setup-approve`       | works. "Nothing is lost" is reassuring.                                                                                                                                                            |
| Connect                                  | `setup-connect`                            | Restart Claude Desktop                       | `setup-test`          | works. It found my Claude. The Claude Code card shows a Terminal command even though it says "Not found".                                                                                          |
| Test                                     | `setup-test`                               | Open Claude Desktop, ask, Continue           | `setup-done`          | works for success. **Missing frame:** the 60-second "nothing arrived" state exists only as a note.                                                                                                 |
| Done                                     | `setup-done`                               | Open Valet                                   | `needs-you`           | friction. Only the "Almost set up" version is drawn. **Missing frame:** the all-done state, which is the "done" I asked for in round 1.                                                            |
| **S2** log in                            | `menubar-icon-notification` (notification) | Show login window                            | `login-handoff`       | works. Numbered steps, "Give up closes this window and tells Claude", and a clock time.                                                                                                            |
| S2 code variant                          | `login-handoff-code`                       | type the code, then I'm done                 | none                  | works.                                                                                                                                                                                             |
| **S3** confirm                           | notification, then Answer                  | `confirm-ready`                              | Remove / Don't remove | works. The sentence leads, and "Can't pay, check out" is ticked. The footer still shows `remove_from_cart · 9f3c1a7e`.                                                                             |
| S3 nearly out of time                    | `confirm-urgent`                           | none                                         | none                  | works. "At 9:50 pm nothing is removed" is now said twice, which is fine.                                                                                                                           |
| S3 missed                                | `menubar-missed`, then `needs-you`         | Copy a retry note                            | none                  | friction. A "retry note" means nothing to me: copy it to where? I'd want "Ask Claude to try again" to do it for me.                                                                                |
| **S1** approve 0.4.0                     | `site-overview-update`                     | Review Woolworths update (button, top right) | `site-review-update`  | works. There's a real button and a banner. In the review, "I've read the new web address" and Approve 0.4.0 are clear. "From the authoring agent" puzzles me.                                      |
| **S4** why it failed                     | `activity-call-failed`                     | none                                         | none                  | friction. "Woolworths changed how its trolley page answers" is plain, but "What to do: Copy a repair note" isn't for me. I'd want "Tell Nick" or "Nothing you can fix; Claude has been told."      |
| **S5** connect Claude Desktop            | `connections`, then Add an app             | `connections-add-app`                        | Add to Claude Desktop | works, but "Another app: speaks MCP over stdio. Copy JSON" is on my screen.                                                                                                                        |
| **S6** revoke Claude Code (I wouldn't)   | `connections`                              | Open, then revoke                            | `connections-revoke`  | not attempted. I'd still find Connections.                                                                                                                                                         |
| **S7** site limiting                     | `menubar-normal`, `site-overview-limited`  | nothing                                      | none                  | friction. "Calls resume at 9:52 pm" is great, but "Try now" (primary-looking) sits next to "Try now may make Woolworths wait longer". Tell me "Nothing to do" and make waiting the obvious choice. |
| **S9** remote (no idea pile)             | `setup-connect` link, `connections`        | none                                         | none                  | friction. Setup itself pushes "Set up remote access" at me ("Using Claude in a browser or on your phone?"). I'd click it out of curiosity.                                                         |
| **S10** audit (I wouldn't)               | `needs-you-empty`                          | none                                         | none                  | works. "Audit log checks out · verified 9:41 pm" is enough for me.                                                                                                                                 |
| **SS1** "is it working?"                 | `menubar-normal`                           | none                                         | none                  | works. "Ready · Town Hall · logged in" is the one line I wanted.                                                                                                                                   |
| **SS2** check the trolley                | `menubar-normal`                           | Open my trolley on woolworths.com.au…        | browser               | works. The fear-of-paying wording is gone.                                                                                                                                                         |
| **SS3** "did I break it?" after skipping | `setup-done`, `menubar-first-run`          | Continue setup                               | setup                 | works, but the counts disagree (see Part 3).                                                                                                                                                       |

## Part 2. My round 1 pain points

1. **1Password step asks for an account name:** **fixed.** `setup-1password` and
   `setup-1password-problem` have an "Open 1Password settings" button, a re-check, and no account
   box.
2. **Approval buried behind a jargon review, red Reject:** **fixed** in setup (`setup-approve`).
   **Partly** on the site path (`site-review-first-install`): the summary line is good, but the
   header has "adapter woolworths 0.3.0 9f3c…e0f1" and "Added by the authoring agent in Claude Code",
   and the button is "Don't install…".
3. **No "done, it works" moment:** **partly.** `setup-test` is excellent. But the only drawn
   `setup-done` is the incomplete one, and the test's failure state isn't drawn.
4. **Confirmation hid the human sentence:** **fixed** (`confirm-ready`, `confirm-urgent`).
5. **"Needs you" things that don't go anywhere:** **fixed** (`needs-you`, `menubar-waiting`,
   `site-overview-update`, `site-overview-needs-login`). Every waiting thing has a named button.

## Part 3. New problems

**Blockers**

- **B1. The finished setup isn't drawn** (`setup-done`). Only "Almost set up" exists. The design
  thread needs the all-done state ("Claude can use Woolworths", what next, where Valet lives) and
  the test-failed state on `setup-test`.

**Major**

- **M1. Counts disagree between frames.** The menu bar on first run says "Finish setup (5 steps
  left)… about 4 minutes" (`menubar-first-run`). Setup has 8 steps, and 6 are actions after Welcome.
  `setup-done` says "Two steps are left" but the rail shows three skipped (store, connect, test). Sam
  checks these numbers.
- **M2. "Today" numbers contradict each other.** `site-overview-update`, `-limited` and
  `-needs-login` show Woolworths with 37 calls, 2 failed and 12 blocked, which are the totals for
  all sites (`menubar-normal`, `needs-you-empty`). `global-pause-undo` says Woolworths has 12 calls
  (12 + 20 + 5 = 37).
- **M3. 1Password vault mismatch.** `setup-login` lists my items in "Personal vault". The grant
  sheet `site-grant-sheet` searches vault "Valet" only. Which one is it? If it's "Valet", setup has
  promised me something it can't do.
- **M4. One-time code choices differ.** `setup-login` offers "Read codes from Messages… / I'll type
  them". `site-grant-sheet` offers "Use the code in this 1Password item / Read it from Messages /
  Ask me". These should be the same three choices with the same words.
- **M5. Who made Woolworths?** `setup-approve` says "comes with Valet". `site-overview-first-install`
  and `site-review-first-install` say "added 9:31 pm by the authoring agent". For me, an
  unknown "agent" adding something is alarming. Draw the bundled first install, which is my case.
- **M6. Approve a connection is too easy for someone who never started one.** In `needs-you`,
  `menubar-waiting`, the notification and `needs-you-approve-connection`, "Approve…" is the blue
  primary button. "If you didn't start this, decline it" is grey small print. For me, Decline should
  be at least equal, and the warning should be the first line.
- **M7. "Copy a retry note" / "Copy a repair note"** (`needs-you`, `menubar-missed`,
  `activity-call-failed`). Two different made-up nouns, and neither says where to paste. The IA
  table says "Ask Claude to try again". Use that, and say "then paste it to Claude".
- **M8. Remote access is advertised inside setup** (`setup-connect`, "Set up remote access"). That's
  my "no idea" pile, on my critical path. Move it to Connections only.

**Minor**

- m1. The approval date differs: "approved Fri 6 Nov" (`site-overview*`) vs "approved on 2 Nov"
  (`confirm-ready`).
- m2. Hashes and ids still sit on my pages: `9f3c…e0f1` in every site header, the grant sheet's
  "(9f3c…e0f1)", the confirmation footer `remove_from_cart`, and "Can reach: cdn0.woolworths.media".
  Put them under Details unless "Show technical details" is on.
- m3. `needs-you-empty`: the sidebar shows Woolworths with an orange dot while the status says
  "Woolworths · Ready".
- m4. The "Confirm" item icon is a ✓ (`needs-you`, `menubar-waiting`), which reads as "done". The
  Missed item uses the same icon.
- m5. The menu bar's "Today" is three tiles in `menubar-normal` and a line of links in
  `menubar-waiting` / `-paused`. Pick one.
- m6. `menubar-normal`: the Woolworths row has no chevron, while the other two do.
- m7. The "Pause Valet ▾" menu holds "Lock down…" (`menubar-paused` shows it as a plain row). For me
  "Lock down" sounds like something got hacked. It needs a one-line explanation.
- m8. `setup-connect`: the "Not found" Claude Code card still shows the full Terminal command.
  Collapse it.
- m9. `connections`: "Cursor" (revoked) appears as "Called by … Cursor 0" on the site page. Hide
  revoked apps there.
- m10. `confirm-ready` header says "1 of 3 waiting" while Needs you in the same scene has 4 (3 timed
  plus 1 review). Say "1 of 3 with a deadline" or count all 4.
- m11. `setup-1password-problem`: the annotation dot covers the red error text. That's a wireframe
  artefact, but check that the real error line can't be clipped.

**R:** M2, M3, M4 and m1 are data-consistency issues in the wireframes, not design choices, but
P2 notices them because they read numbers and names literally.

## Part 4. Verdict

Sam would sign off on the IA (Needs you first, Sites, Connections, Secrets with the "Passwords"
subtitle) and on the setup, Needs you and menu bar wireframes. Before the design thread starts,
these must be fixed:

- **B1:** draw the all-done `setup-done` and the test-failed `setup-test`.
- **M1, M2:** make the step and call counts agree.
- **M3, M4:** one vault, one set of code choices.
- **M5:** draw the bundled first install without "authoring agent".
- **M6:** make Decline equal for Approve a connection, with the warning first.
- **M7:** one "Ask Claude to try again" action in place of the retry and repair notes.
- **M8:** take remote access out of setup.
