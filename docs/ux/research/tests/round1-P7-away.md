# Round 1 test: P7, Nick away from the Mac (the interrupted owner)

Simulated persona test, 2026-11-11, following `protocol-round1.md` against
`../hypotheses-round1.md`. P7 is Nick (P1) arriving at the Mac from the couch, phone in hand,
because Claude said Valet needs him. Consistent with `../interviews/P7-away.md`: he cares most
about getting from "Claude said so" to the right window in one click, before the clock runs out,
and about being told when he was too late.

## Part 1. Tree test

The order was fixed (A, then B, then C). By C I knew the tasks, so my confidence on C is a bit
inflated, and I say where.

| Task                                          | IA-A                                                                                              | IA-B                                 | IA-C                                                               |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------ |
| T1 Approve Woolworths 0.4.0                   | Needs you → the review item. Sure. Second guess: Sites › Woolworths › Versions                    | Same. Sure                           | Home → Needs you. Sure, but I scanned past the site health first   |
| T2 Why get_cart failed                        | Activity › Calls, filter tool get_cart → trace. Sure                                              | Calls → trace. Sure, one click fewer | History › Calls. Sure (learned)                                    |
| T3 Revoke Claude Code                         | Connections › Apps on this Mac › Claude Code → Revoke. Sure                                       | Same. Sure                           | Access › Connections. Unsure: "Access" also reads like permissions |
| T4 Turn on remote access                      | Connections › Remote access settings. Sure                                                        | Same. Sure                           | Access › Connections › remote. Unsure                              |
| T5 Change Woolworths store                    | Sites › Woolworths › Overview. Sure                                                               | Same. Sure                           | Same. Sure                                                         |
| T6 Calls that used the login password         | Secrets › Grants › Woolworths login → its calls. Unsure: also tried Sites › Woolworths › Activity | Same, unsure                         | Access › Secrets › Grants. Unsure, two levels to guess             |
| T7 Verify audit log                           | Activity › Audit log. Sure                                                                        | Audit log. Sure                      | History › Audit log. Sure                                          |
| T8 SMS codes from Messages                    | Secrets › One-time codes. Sure                                                                    | Same. Sure                           | Access › Secrets › codes. Unsure                                   |
| T9 Woolworths blocking, until when            | Sites › Woolworths › Overview health line. Sure. Also expected it in Needs you if a call is stuck | Same                                 | Home: the site health line. Sure, fastest of the three             |
| T10 What Claude Desktop can call              | Connections › Claude Desktop's page. Sure                                                         | Same                                 | Access › Connections. Unsure                                       |
| T11 How long traces are kept                  | Settings › Data and privacy. Sure                                                                 | Same. Sure                           | Same. Sure                                                         |
| T12 Approve a waiting cloud agent with a code | Needs you → the connection item. Sure                                                             | Same. Sure                           | Home → Needs you. Sure                                             |

Tally: IA-A 11 sure, 1 unsure; IA-B 11 sure, 1 unsure; IA-C 7 sure, 5 unsure (with learning helping).

**Winner: IA-A.** It's the navigation I sketched in my interview, nearly word for word. IA-B scores
the same on paper, but seven top-level items is one too many for a utility, and the audit log on
its own is a place I visit once a month; it doesn't earn a top slot. IA-C fails on "Access": it hides
Connections and Secrets one level down under a word that means permissions to me, and "Home" puts
the urgent list on the same page as site health and today's numbers, which is exactly the tray
problem I complained about: the waiting items share space with things that don't expire. For my
tasks (T1, T12) all three were fine because Needs you is top-level in all of them. That's the part
that matters most to me, and every tree got it right.

## Part 2. Label preference

- **Sites over Adapters.** Claude says "Woolworths", I say "Woolworths". Adapter is a word for the
  author (P4); put it on the Versions tab.
- **Connections over Clients and Connected apps.** It covers the endpoint and remote access, which
  aren't clients. "Connected apps" breaks down for a cloud agent, which isn't an app on my Mac.
- **Secrets, barely, over Credentials; not Passwords.** Passwords would hide one-time codes. Secrets
  is short and honest. Credentials is fine too; I won't fight over it.
- **Activity over History.** History sounds like old stuff. Activity includes the call happening now.
- **Needs you over Inbox and Waiting.** It's the phrase Claude should use to send me there. Inbox
  implies reading and archiving; Waiting is ambiguous (who's waiting, me or it?). Needs you is the
  one I'd say out loud.

## Part 3. Hypothesis feedback

### Elements

- **E1. Accept E1 over E1b.** "If the pill had been a pill and the button a button, I'd have found
  the review in a second." E1 would have let me find it; E1b is the same trap with a chevron I'd still
  read as decoration at a glance. Change: the button uses the verb from the vocabulary table
  ("Review update").
- **E2. Accept.** Links both ways matter to me in one spot: from a Missed item to the call it
  belonged to, so I can tell Claude which one to retry.
- **E3. Accept.** Selectable values with copy on hover is right. Don't make the countdown selectable;
  it jitters.
- **E4. Accept, refine.** Undo toasts are good for pause. But nothing I do in the 2-minute window
  should go through an extra dialog: Decline on a confirmation must stay one click, no "are you sure".
- **E5. Accept, refine hard.** This is the one that decides whether I make it. Changes:
  1. Show both, but lead with the clock time when it's minutes away and with the countdown when
     it's under 2 minutes: "until 9:50 pm (14 min)" for a login, "1:42 left" for a confirmation.
  2. The same deadline must appear in the notification ("declined at 9:49 pm if nobody answers")
     and in the tool result Claude gets, so Claude can tell me on my phone. A deadline I learn only
     when I reach the Mac is half spent.
  3. Under 30 seconds the row and the panel turn urgent (colour plus the word "Ending"), and under
     Reduce Motion it doesn't pulse.
  4. Sort is by deadline; items with no deadline (reviews, missing settings) go last, oldest first.
  5. After sleep, compute from wall-clock time on wake, never resume a stale timer: if it already
     ended, show it as Missed immediately.
- **E6. Accept.** "Woolworths is limiting us, calls resume at 9:52 pm" is what I want to read to
  myself before telling Claude to wait. Keep "Try now" behind a small confirm-free button; that's fine.
- **E7. Accept.** "12 blocked" opening Activity filtered is exactly what I tried.
- **E8. Accept.** Shared words are the bridge between my phone and the Mac.
- **E9. Accept.** Plus: when a notification opens the window, focus goes to the item, not the page
  heading.
- **E10. Accept.** Pause is what I'd do from the couch if I could. Since I can't, at least make it
  one keystroke when I arrive.
- **E11. Accept.** The count on Adapters that included a confirmation was wrong. One count, on Needs
  you, equal to the number of rows.

### Pages

- **P1. Needs you page. Accept, refine hard.** It's my ideal, with four changes:
  1. **Confirmations are never approved inline on this page.** The security model only accepts Allow
     from the floating confirmation window opened for that request, which is why today's tray
     "Answer" breaks. The row's action is "Answer", and it brings that window forward. Decline can be
     inline. Remote consent can take the code inline, since typing the code is the check.
  2. **Missed section** keeps each item until I dismiss it or for 24 hours: what, when, outcome
     ("declined automatically at 9:49 pm, nobody answered"), and the next step ("Ask Claude to try
     again"), with a link to the call.
  3. Every row shows "1 of 3" context through the header ("3 need you, the next ends in 1:42") so I
     know whether I can go back to the couch.
  4. Rows for a stuck site ("Woolworths is limiting requests until 9:52 pm") appear as information
     only, no action, under the actionable ones, because that's why Claude is stalling.
     Without change 1 I'd reject it: an inline Allow either fails or weakens the check.
- **P2. Accept.** Versions with the pending review at the top, and the Overview banner with a real
  button.
- **P3. Accept.** Escape returning me to Needs you when I came from there is the detail that matters.
- **P4. Accept.** Filters in the URL so the Missed link can deep-link to the exact call.
- **P5. Accept.** Remote sign-in requests stop hijacking a settings page; they live in Needs you, and
  Connections shows the clients afterwards.
- **P6. Accept.** Not my scenario, no notes.
- **P7. Accept.** ⌘, to Settings, and Notifications as its own section, since I rely on them.
- **P8. Pick P8a.** When anything waits, the window opens on Needs you; otherwise on Sites. I
  arrive with one job; P8b makes me look past site health and numbers to find it, and P8c makes me
  click once more every time. One refinement: a notification opens the item itself (the confirmation
  window, the login window), and the control panel only if the item needs it.
- **P9. Accept.** A skipped step as a Needs you item, without a deadline, sorted last.
- **P10. Accept.** "Remove Cavendish Bananas from your trolley?" with "Remove" and "Don't remove"
  reads in two seconds. Keep the countdown next to the buttons, not in the corner.
- **P11. Menu bar popover. Accept, refine hard.**
  1. **The icon itself needs a badge** (count or filled dot) while anything waits. P11 says nothing
     about the icon, and the icon is the only thing I see from the doorway.
  2. Needs you is first and grows to fit at least three full rows before it scrolls; when anything
     waits, the stat tiles collapse to one line. Today the list is the part that shrinks.
  3. Rows show the countdown on the right and the whole row is clickable; the click does exactly
     what the Needs you page's row does (Answer focuses the floating confirmation window).
  4. Remote sign-in requests are in it.
  5. A "Missed (1)" line under the list that opens the Missed section.
  6. Site rows clickable, as proposed. Fine.

### Vocabulary table

Accept, with two changes:

- **"Approve a connection (code ABCD-1234)": reject the code part.** The code comes from my browser
  and I type it on the Mac to prove the request is mine. If the app or Claude shows the code, that
  check is gone. The wording should be "Approve a connection: type the code your browser shows".
- **Add the deadline to every time-boxed phrase**, for both app and tool result: "Confirm: Remove
  Cavendish Bananas (by 9:49 pm)", "Log in to Woolworths (window open until 10:02 pm)". Add the Missed
  phrase too: "Missed: Remove Cavendish Bananas, declined at 9:49 pm. Ask Claude to try again."

## Part 4. What the hypotheses missed

My biggest remaining worry is **the walk**. Even with everything above shipped, a 2-minute
confirmation starts counting when Claude asks, not when I'm told, and I'm on the couch. Walking
over and unlocking eats a minute. Nothing here addresses that:

1. **Tell the agent the deadline** (E5 point 2), so Claude says "you have until 9:49 pm" the moment
   it happens, not "act in the Valet app".
2. **Consider a longer confirmation time as a setting** (Settings › Notifications or General: 2 or 5
   minutes), with the security trade-off stated. I'd pick 5 when I'm working remotely.
3. **A locked Mac** can't show the floating panel. The notification on the lock screen should say
   what and by when, so I know whether to run.
4. **The return trip.** After I log in or answer, nothing tells Claude I'm done; I walk back and type
   "done" myself. A tool result like "the person finished logging in at 9:51 pm" on the next call, or a
   hint "call again now", would close the loop.

If the Missed section, the icon badge and the deadline in Claude's message all ship, I'll forgive the
walk. If only the page ships, I'll still be timing out on the stairs.
