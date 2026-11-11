# Round 2 test: P7, Nick away from the Mac (wireframe walkthrough)

Simulated persona test, 2026-11-11, following `protocol-round2.md`. P7 is Nick coming back to
the Mac from the couch, phone in hand, because Claude said Valet needs him. I read
`docs/ux/information-architecture.md`, then screenshotted and read these frames:
menubar-waiting, menubar-icon-notification, menubar-missed, needs-you, needs-you-empty,
needs-you-approve-connection, confirm-ready, confirm-urgent, confirm-missed, login-handoff,
login-handoff-code, login-handoff-not-yet, site-overview-update, site-overview-limited,
settings-notifications, activity-call-failed. For connections-remote-on, connections-revoke and
activity-audit the screenshot didn't render, so I judged those on their `desc` and `notes` only.
I spent the most time on the surfaces I meet first: the icon, the notification, the popover,
Needs you, and the two windows.

## Part 1. Scenario walkthrough

### My own scenarios (round 1)

| Step                                          | Frame                             | What I click                       | Next frame                             | Result                                                              |
| --------------------------------------------- | --------------------------------- | ---------------------------------- | -------------------------------------- | ------------------------------------------------------------------- |
| R1 2-min confirmation: lock screen on arrival | menubar-missed (left)             | Read "Answer by 9:50 pm", unlock   | confirm-ready already on screen        | works                                                               |
| R1 via the notification                       | menubar-icon-notification         | Answer                             | confirm-ready (window brought forward) | works                                                               |
| R1 via the menu bar (my habit)                | menubar-waiting                   | Whole row 1 / "Answer ›"           | confirm-ready                          | works. The row is first, 1:42, until 9:50 pm                        |
| R1 answering                                  | confirm-ready → confirm-urgent    | Remove / Don't remove              | (no "answered" frame)                  | friction: no frame for the state after I answer                     |
| R2 Login hand-off                             | menubar-waiting row 3 "Show ›"    | Show                               | login-handoff                          | works. Steps, deadline, Give up explained                           |
| R2 I press I'm done too early                 | login-handoff-not-yet             | I'm done again                     | (no success frame)                     | friction: 0:48 left and no way to get more time                     |
| R2 I'm done, it worked                        | missing                           |                                    |                                        | **missing**: what the banner says, and whether Claude is told       |
| R2 Window ran out (15 min)                    | missing                           |                                    |                                        | **missing**: there's no missed-login frame                          |
| R3 Remote consent with a code                 | menubar-waiting row 2 "Approve ›" | Approve                            | needs-you-approve-connection           | works, but two hops (popover, then window sheet)                    |
| R3 typing the code                            | needs-you-approve-connection      | type code, tick tools, Approve     | (no result frame)                      | friction: no requester identity, no approved/wrong-code state drawn |
| R4 Three things at once                       | menubar-waiting, needs-you        | top row first                      | confirm-ready shows "1 of 3 waiting"   | works in layout, broken in counts (see Part 3)                      |
| R5 Arrived after a time-out                   | menubar-missed (right)            | Copy a retry note / Open call 7F2A | confirm-missed / call trace            | works for confirmations only                                        |

### Brief scenarios S1 to S10

| Scenario                       | Path through frames                                                                                                        | Result                                                                                       |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| S1 Approve 0.4.0 from the site | site-overview-update: "Review Woolworths update" button top right, plus a banner with "Review update" → site-review-update | works. The pill is now a label with a real button beside it (E1). Found it in under a second |
| S2 Log in when Claude asks     | menubar-waiting / needs-you "Show login window" → login-handoff                                                            | works. No done state (above)                                                                 |
| S3 Confirm a removal           | confirm-ready                                                                                                              | works. The sentence comes first, buttons are named by verb, Return declines                  |
| S4 Why get_cart failed         | popover "2 failed" → activity-calls-filtered → activity-call-failed                                                        | works. The red box says what happened and what to do                                         |
| S5 Connect Claude Desktop      | Connections → connections-add-app (desc)                                                                                   | works on paper                                                                               |
| S6 Cut off a leaked token      | connections-app → connections-revoke / connections-reset-undo (desc)                                                       | works on paper. Reset with Undo first, Revoke asks                                           |
| S7 Woolworths blocking us      | popover site row → site-overview-limited: "Limited until 9:52 pm", Try now, Pause site                                     | works. Exactly the decision I wanted to make                                                 |
| S8 First launch                | setup-welcome … setup-done (desc), ends on Needs you                                                                       | not my scenario. Ending on Needs you is right                                                |
| S9 Remote access on            | connections-remote-on (desc)                                                                                               | works on paper                                                                               |
| S10 Audit tamper check         | needs-you-empty "Audit log checks out · verified 9:41 pm · Check now"; activity-audit                                      | works. One click from the empty Needs you page                                               |

## Part 2. My round 1 pain points

1. **Tray "Answer" opened a copy of the confirmation where Allow can't work.** **Fixed**
   (menubar-waiting, needs-you, IA §5). Answer brings the real window forward. Engineering must keep
   it that way: the popover and the Needs you row must never render the panel themselves.
2. **Needs you clipped and unsorted in the tray.** **Fixed** (menubar-waiting). Three full rows
   sorted by deadline, each with a countdown and the clock time, then "+1 more in Valet", then a
   Missed line. The Today tiles shrink to one line. This is the frame I'd frame and hang on the wall.
3. **Remote consent not in Needs you.** **Fixed** (needs-you, menubar-waiting,
   needs-you-approve-connection). It no longer hijacks a settings page.
4. **Missed items vanish.** **Partly fixed.** For confirmations it's excellent: confirm-missed says
   "missed, not declined" and when, menubar-missed replaces the notification instead of taking it
   down, and needs-you keeps it for 24 hours. But there's no frame for a missed login hand-off or a
   missed connection, and the "Missed (any kind)" row in IA §5 is only drawn for a confirmation.
5. **No ambient signal, no deadline in Claude's words.** **Fixed on paper**
   (menubar-icon-notification: count, "!" under 30 s, Paused and Locked as words; IA §7: "waits until
   9:50 pm", "open until 10:03 pm"). I can't check the tool-result side in a wireframe. It has to be
   tested against the real strings.

## Part 3. New problems

### Blockers

None. Nothing in the frames stops me doing my job.

### Major

1. **Notifications contradict themselves about actions.** menubar-icon-notification shows Answer and
   Decline buttons, plus "Approve…" on the connection notification. settings-notifications says
   "Nothing is approved from a notification. Clicking one only opens Valet at that item." IA §10
   allows Decline, and today's code (`main/core/notifications.ts`, D52) has no buttons at all. Pick
   one rule and draw it everywhere. My choice: Decline is allowed; the opening button is named "Open…",
   or "Enter code…" for a connection. **"Approve…" on a notification must go**: I'd believe I was
   approving from the lock screen.
2. **Counts disagree within one storyline** (all frames are 9:48 pm, 1:42 left). menubar-waiting
   says 4 (header and badge), needs-you says "4 waiting", menubar-icon-notification shows **3** on
   the icon, and confirm-ready says **"1 of 3 waiting"**. Principle 1 is "badges add up". If "1 of 3"
   deliberately leaves out the review (no deadline), say so: "1 of 3 timed, 1 review". Otherwise make
   it 4 everywhere.
3. **No login success or missed state** (login-handoff family). After I'm done: does the window
   close, does a toast say "Logged in. Claude's next call goes through", and is Claude told? After 15
   minutes: a "Missed: Log in to Woolworths" notification and row, like confirm-missed. This was
   my round 1 Part 4 point 4 (the return trip) and it's still undrawn.
4. **No more time on the login window** (login-handoff-not-yet at 0:48, in red). If I'm mid-way
   through a verification check at 0:00, the window closes under me. I want an "Extend 10 min"
   button, or a rule that it doesn't close while I'm typing in it.
5. **The approve-connection sheet doesn't say who is asking** (needs-you-approve-connection). Today's
   page shows "claude.ai · from 203.0.113.24 · calls itself Claude". The sheet only says "A cloud
   agent". That's when I most need to know it's my phone's claude.ai and not someone else. Add the
   host, the time it was asked, and the claimed name as a claim. Also draw two requests at once.
6. **The walk is still unanswered** (settings-notifications, settings-general). My round 1 ask was an
   optional longer confirmation time ("2 min / 5 min", with the trade-off stated). It's neither drawn
   nor in IA §11 as an open question for Nick. At least list it there.

### Minor

7. confirm-urgent replaces "1 of 3 waiting" with "Ends in 0:24": I lose the count exactly when I most
   need to know whether to stay. Keep both. It also says the time-out sentence twice (in the body
   and under the buttons); drop one.
8. confirm-ready has no state after I answer ("Removed. Claude has been told." and the window closes,
   or the next item opens?). I'd like "Next: Approve a connection, 4:10" if more are waiting.
9. "Copy a retry note for Claude" (confirm-missed, menubar-missed, needs-you) copies to the Mac's
   clipboard, but my Claude chat is on my phone. Universal Clipboard may save it; otherwise show the
   sentence big enough to retype, or rely on "Claude was told it timed out", which already covers it.
10. Lock-screen notification shows "Claude Code is waiting" (menubar-missed, left). A client's
    name is only what it says it is, and today's notifier keeps it out of notifications on purpose.
    Use "An app is waiting" or confirm that's an intended change.
11. The code field's placeholder "ABCD-1234" looks like a real code (needs-you-approve-connection).
    Use "XXXX-XXXX".
12. needs-you-empty: the Woolworths sidebar dot is amber while its status line says Ready, and
    Yahoo's dot is green while it's limited. Make the sidebar dots match the status lines.
13. login-handoff: asked at 9:47 pm, closes at 10:03 pm, but the window lasts 15 minutes, so it
    should close at 10:02.
14. menubar-missed: annotation 4 overlaps the word "miss" on the notification's Dismiss.
15. menubar-waiting: "+1 more in Valet" is a link, but the item it names ("Review the Woolworths
    update") is grey text, not a link. Make the item itself the link.

## Part 4. Verdict

**Sign off on IA-A and the wireframes, conditional** on: one rule for notification actions with no
"Approve…" on a notification (major 1); counts that agree across the icon, popover, Needs you and
confirmation window (major 2); login success and missed-login frames (major 3); a way to extend a
login window (major 4); requester identity in the connection sheet (major 5); and the longer
confirmation time added to the open questions for Nick (major 6).
