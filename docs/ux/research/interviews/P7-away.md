# Interview: P7, Nick away from the Mac (the interrupted owner)

Simulated persona interview, round 1, 2026-11-11. The researcher is "R"; the persona is "P7". P7
is Nick (P1), working in Claude from his phone in another room through remote mode, coming back
to the Mac because Claude said "Valet needs you". Findings in parts C and D were checked against
the code and the screenshots in `docs/ux/research/current-screens/`. File paths are relative
to `apps/desktop/src/` unless they say otherwise.

## A. Interview

**R: Set the scene. Where are you when this starts?**

P7: On the couch with my phone, in a Claude chat that's doing the weekly shop through remote mode.
The MacBook is on the desk in the study, lid open but probably asleep or locked, since I walked
away twenty minutes ago. Claude writes "the person has been asked to act in the Valet app" and
stops. So I get up. That's thirty seconds to a minute of walking, then unlocking with Touch ID or
the watch, then finding the thing. If a confirmation only gives me two minutes, I've used half of
it before I see the screen.

**R: What do you need to see the moment you unlock?**

P7: The thing itself, not the app. If it's a "remove bananas, yes or no", that panel should be in
front of me with a clock on it. If it's a login, the login window. And one line somewhere that
says "this is 1 of 3", so I know whether I can go back to the couch afterwards. What I don't want
is a control panel opened on the Adapters table, or a notification I tap that does nothing.

**R: How do you want to be told?**

P7: On the phone, honestly, because that's where I am. But I know Valet only has the Mac. So two
things. One: Claude's message has to tell me what kind of thing it is and how long I have, "confirm
in Valet within 2 minutes" rather than "act in the Valet app". Two: on the Mac, a notification that
is still there when I unlock, says what it is, and goes to it in one click. And the menu bar icon
should look different while something's waiting, a dot or a count, like Tailscale does when it's
off. Right now the icon only changes for REMOTE and DEMO.

**R: Say three things are waiting. What order?**

P7: Whatever dies first. A confirmation that expires in 70 seconds beats a login that has 14
minutes left, and both beat an adapter review that can wait until tomorrow. Remote consent is in
between: its code dies in five minutes and someone's standing at the other end of it, usually me
on the phone. So: confirmations, then remote consent, then logins, then reviews. Sorted by deadline,
with the deadline shown on every row.

**R: And if you're too late?**

P7: Tell me it happened. "You missed: Remove from cart, Woolworths, declined automatically at
9:49 because nobody answered." Then give me the way to undo the damage, which usually means
"ask Claude to try again", so tell me that's what to do. What I don't want is the panel just gone,
the notification just gone, and no idea whether I lost something or whether it never existed.

## B. Open card sort (35 cards)

P7 sorted fast and by urgency first, then by subject.

| Group (P7's name)               | Cards                                                                                                                                                              | Where he'd start                                                                                                      |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| **Waiting for me** (time-boxed) | 35 See what needs me right now; 9 Confirm or decline; 8 Log in when asked; 20 Approve a remote sign-in (code); 1 Approve an adapter update                         | The menu bar icon (badge), then one "Needs you" list at the top of the popover and at the top of the window's sidebar |
| **Sites** (one page per site)   | 2 What it may reach; 3 Its tools; 4 Choose the store; 5 Give it a password; 6 Revoke a grant; 10 Open my trolley; 25 Is the site blocking us; 34 Remove an adapter | Click the site in the menu bar popover or the sidebar                                                                 |
| **What happened**               | 11 Today's calls; 12 Why a call failed; 13 Blocked requests; 14 Verify audit chain; 15 Export audit log                                                            | Click a number in the popover (calls, blocked) and land on the filtered list                                          |
| **Who can call**                | 16 Add Claude Desktop; 17 Reset a client; 18 Revoke a client; 19 Turn on remote access; 21 Tools for remote clients                                                | Sidebar "Clients", with remote as a section of it, not a separate place                                               |
| **Kill switches**               | 22 See the MCP address; 23 Turn MCP off; 24 Pause all adapters                                                                                                     | Menu bar popover, always one click                                                                                    |
| **Passwords and codes**         | 26 Set up 1Password; 27 SMS codes from Messages; 7 Re-sync Keychain copy                                                                                           | Sidebar "Credentials"                                                                                                 |
| **Settings**                    | 28 Trace retention; 29 App updates; 30 Run setup again; 31 Reset/uninstall; 32 Open at login; 33 Notifications                                                     | Settings, reached by ⌘,                                                                                               |

Notes from the sort:

- He put **20 (remote sign-in)** in "Waiting for me" without hesitating: "it's a person waiting with
  a code, it's the same kind of thing as a confirmation". In the current app it is the only waiting
  item that isn't in the Needs you list.
- He hesitated on **1 (approve update)**: "it's waiting for me, but it's not urgent. Same list, at
  the bottom, no clock."
- **25 (blocked by site)** went to Sites, with "and a line in Waiting for me if a call is stuck on
  it, without a button, just so I know why Claude is stalling".
- **33 (notifications)** he wanted duplicated: in Settings, and a "notify me about..." line right
  under the Needs you list when it's empty.

## C. Walkthroughs on the current app

Severity: **S0** blocks the task or loses the action, **S1** major, **S2** minor, **S3** polish.

### C1. A 2-minute confirmation arrives while he's away

1. **Entry (phone).** Claude's call to `remove_from_cart` waits; the MCP result only says the
   person must confirm in the Valet app (`packages/mcp-server/src/server.ts:200`). No deadline is
   given to the agent, so Claude can't say "you have 2 minutes". **S1.**
2. **Entry (Mac).** A notification "Valet needs your approval... Unanswered, it is declined in 2
   minutes" (`main/core/notifications.ts:57-63`). The duration is relative to when it was posted;
   reading it on unlock 90 s later, "in 2 minutes" is wrong. No absolute time. **S2.**
3. **Where he looks.** The floating confirmation panel is shown inactive, top-right, on all
   workspaces (`main/electron/windows.ts:131-177`), so it is probably already on screen after unlock.
   Good. Decline has focus and Approve arms after 800 ms. Expectation met.
4. **If he goes via the menu bar instead** (the habit P1 has), the Needs you row says "Confirm
   Remove from cart · Woolworths" and its button is **Answer**, which calls
   `openControlPanel(href.confirm(id))` (`renderer/tray/TrayPopover.tsx` AttentionRow). That route
   renders `ConfirmationPanel` _inside the control panel window_ (`renderer/control/App.tsx:30-31`),
   replacing whatever page was open. But the main process only accepts an approval from the
   confirmation window opened for that id (`main/core/confirmations.ts`, `answer()`:
   `from.role !== 'confirmation' || from.shows !== id` throws `ConfirmationRefused`). So **Allow from
   the tray's Answer fails** with a generic "couldn't do that" while the clock runs. Decline works.
   **S0.** The fix is for Answer to bring the existing confirmation window forward
   (`focusConfirmation`), the same as the notification does.
5. **Timer visibility.** The panel shows "Times out in 1:52" (`confirm.png`); the tray row shows no
   time at all. **S1** for P7: he decides what to do first from the tray.

### C2. A login hand-off

1. **Entry.** Claude says "the person has been asked to act in the Valet app (reason:
   verification...)" (`packages/mcp-server/src/results.ts:40`). Notification: "Valet needs you to sign
   in. Woolworths: signing in stopped... The window closes in 15 minutes"
   (`notifications.ts:66-76`, `HANDOFF_WINDOW_MS` in `main/core/constants.ts:41`).
2. **Where he looks.** The auth window with the banner above it (`needs-user.png`): what Valet
   filled, the allowed hosts, "Closes in 4:00", Give up / I'm done. Clear and trustworthy. The banner
   is a separate always-on-top window that follows the auth window (`windows.ts:186-255`).
3. **Breakdowns.** The banner is 168 px of dense text in four sizes; the countdown is in the
   strip _below_, at the far right, in 11 px grey. With 15 minutes this is fine; under 1 minute it
   needs to be loud. **S2.** "I'm done" is the primary action but there's no hint of what happens if
   the probe says he's not signed in. **S2.** No "go back to Claude" cue once done: the next call
   goes through only when Claude calls again, and nothing tells Claude. **S1** (P6 overlap).
4. **If the notification is clicked after the window closed itself:** the click handler only acts
   if `service.hasHandoff(adapterId)` (`main/electron/app.ts:266-268`); otherwise nothing happens at
   all. No window, no message. **S1.**

### C3. A remote consent with a code

1. **Entry.** He's on the phone adding the connector in claude.ai; his browser shows a code. On
   the Mac: one notification "A connector wants access to Valet. Type the code your browser
   shows..." (`notifications.ts` `remoteConsent`), and the control panel **opens itself** on
   `#/remote` (`main/core/service.ts:381-385`), even if he was on another page.
2. **Where he looks.** The menu bar: the consent is **not in Needs you**. The attention list is
   handoffs + confirmations + reviews only (`service.ts:1163-1170`). Only the sidebar badge on
   "Remote sign-in" shows it. **S1**: the one place he's told to look for "needs me" doesn't have it.
3. **The page.** `remote.png`: the "Remote access" settings card comes first; the request card
   ("A connector wants access") is second, and its Approve button sits at the bottom edge of the
   window at 780 px, below the fold at the 560 px minimum. The page leads with configuration, not
   with the thing that's waiting. **S1.**
4. **Timer.** "ends in 4:20" in xs grey inside a metadata line (`RemoteConsent.tsx:152-153`). The
   code dies at 5 minutes (`packages/mcp-server/src/oauth-consent.ts:18`). He has to carry the code
   from his phone to the Mac; with walking time that's tight. **S2.**
5. **Code field.** Placeholder `XXXX-XXXX`, not obviously focused on arrival; a wrong code warns
   that three wrong codes cancel every request (`RemoteConsent.tsx:38`). Clear but scary. **S3.**

### C4. Three things waiting at once (confirmation, login, review)

1. **Tray.** Header "Needs you 3", but the list shows **one row, cut off mid-row**, with no scroll
   indicator (`tray.png`). Cause: the window is a fixed 400 x 640 (`windows.ts:28`), and
   `.needs-list` is the only flex child allowed to shrink (`renderer/styles/screens.css:757-761`)
   while the stats, endpoint and Adapters sections keep their full height. The most important
   section gets whatever space is left. **S0** for P7.
2. **Order.** Items come handoffs first, then confirmations, then reviews (`service.ts:1169`), so the
   2-minute confirmation sits _below_ the 15-minute login and is the row that gets clipped. **S1.**
3. **No deadline on any row**, no "1 of 3", no indication which ones are about to expire. **S1.**
4. **Window.** The sidebar puts the total attention count (3) on **Adapters**
   (`renderer/control/Sidebar.tsx:86-92`), but the Adapters page only shows adapter-related items;
   the confirmation lives in its own window, and the consent on Remote sign-in, which has its own
   badge, so the badges add up to 4 for 3 things (or more). **S2.**
5. **Notifications.** A review gets none (`notifications.ts:78-80`), which is right; but there's no
   summary notification ("3 things need you"), so after unlocking he sees two or three banners
   stacked in Notification Centre in arrival order. **S2.**
6. **Menu bar icon.** No badge or title while anything is waiting: the title only ever says
   REMOTE or DEMO (`main/core/tray-remote.ts`), and the Dock icon is hidden (`app.ts:198`). From the
   doorway nothing on the Mac says "something's waiting". **S1.**

### C5. Arriving after one timed out

1. The broker settles `timed-out` and closes the window (`confirmations.ts` `settle`); the Notifier
   then **takes the notification down** because the item is gone (`notifications.ts`
   `Notifier.attention`, `takeDown`). Notification Centre is now empty. **S1.**
2. The Needs you list no longer has it. The count drops. There is no "missed" state anywhere in the
   tray or sidebar. **S1.**
3. If he had the tray's Answer page open, the control panel says "Nothing to confirm. This
   confirmation was answered or has timed out." (`Confirmation.tsx`) — it doesn't say which, when,
   or what to do next, and doesn't link to the run. **S2.**
4. Evidence does exist: Activity has a "Needed you" filter (`renderer/screens/Activity.tsx:38`) and
   the audit log records `confirmation` with `answer: 'timed-out'`
   (`packages/runtime/src/tool-host.ts:1098-1110`). But nothing points there from the place he lands.
   **S2.**
5. On the agent side the time-out comes back as a failure code, and Claude can only say "try again".
   That is actually the right recovery; the app should say it too: "Ask Claude to try again." **S2.**
### C6. S1 — Approve Woolworths 0.4.0 from the adapter page

- Adapter page header has a blue pill "0.4.0 waiting for review" that **is a link** to the review
  (`renderer/screens/AdapterDetail.tsx:110-113`, `adapter-wow.png`). It looks exactly like the green
  "Approved" status pill next to it, so it reads as a label. P7: "I'd never click that. Where's the
  Review button?" **S1.**
- On the Adapters list, the "0.4.0 to review" pill in the table is a plain span
  (`renderer/screens/Adapters.tsx:184-185`); only the callout above the table has a "Review changes"
  button. **S2.**
- The tray Adapters row shows "0.4.0 waiting for review" but the row isn't clickable. **S2.**

### C7. S2 — "Valet needs you to log in to Woolworths"

- Covered in C2. Additional entry: the adapter page's Session card says "Waiting for you" with a
  **Show login** button (`AdapterDetail.tsx:593-610`) — good, but the words differ from the tray
  ("Log in to Woolworths", button "Open") and the notification ("sign in"). Claude's words are "act
  in the Valet app". Four phrasings for one thing. **S2.**
- The tray Adapters row says "Login window open" with a pulsing dot, not clickable. **S2.**

### C8. S3 — Confirm removing an item from the trolley

- Covered in C1. The panel itself (`confirm.png`) front-loads "Checked by Valet" with five green
  ticks, a POST path and a hash; the human sentence ("Remove Cavendish Bananas (2 × $0.79)") is
  third, greyed, in a dashed box marked "Not verified by Valet". P7 understands why, but at speed
  the eye lands on the ticks. **S2.** The countdown is bottom-left, small. **S2.**

### C9. S7 — Woolworths seems to be blocking you

- Tray row: "Blocked by site · retry in 4 min" in red, not clickable. **S2.**
- Breaker notification opens `#/adapters`, not the site's page (`notifications.ts` `breakerOpened`).
  **S2.**
- Adapters page: "Site circuit breakers" card with "Open · 3:58" — information only; there's no
  action anywhere (no "try once now", no link to the call that tripped it, no "pause this site").
  For P7 the decision is "tell Claude to stop for now"; nothing in the app helps him decide that.
  **S2.**

## D. "Should be interactive" and layout oddities (tray popover and Needs you)

1. **Needs you clipped to one partial row** in a fixed 640 px window while lower-priority sections
   keep full height (C4.1). The pill "3" isn't clickable either.
2. **The three stat tiles** (37 tool calls, 3 logins, 12 blocked) look like buttons, with sparklines,
   and do nothing. P7 expected 12 blocked to open Activity filtered to blocked requests.
3. **Adapter rows** in the tray (avatar, name, version, status) look like list items and aren't
   links. "0.4.0 waiting for review" and "Login window open" are the two most clickable-looking
   strings in the popover.
4. **No timers** on any Needs you row; rows aren't sorted by deadline (C1.5, C4.2).
5. **Inconsistent button styles**: login row "Open" is primary, confirmation "Answer" is primary,
   review "Review" is secondary. The style encodes kind, not urgency.
6. **Whole row not clickable**: only the small button acts; the title "Log in to Woolworths" isn't a
   target.
7. **Selectable text** in the popover: dragging across a row selects it like a web page (complaint 3).
8. **The Answer route** renders a 460 px panel in the 1180 px control window, centred with large
   empty areas (`confirm.png` layout), and replaces the page he was on.
9. **Remote consent page** leads with settings, Approve below the fold (C3.3).

## E. Synthesis

### Top 5 pain points

1. Tray "Answer" opens a copy of the confirmation in the control panel where **Allow can't work**
   (C1.4, S0).
2. **Needs you is clipped** in the tray and isn't sorted by deadline; the urgent item is the hidden
   one (C4.1-2).
3. **Remote consent isn't in Needs you**; it hijacks the control panel instead (C3.2).
4. **Missed items vanish**: notification taken down, list emptied, no "you missed" and no next step
   (C5).
5. **No ambient signal** on the menu bar icon, and no deadlines in the words Claude relays (C4.6,
   C1.1).

### Top 5 needs

1. One click from notification or tray row to _the_ window for that item, always the real one.
2. One Needs you list containing every waiting kind, sorted by deadline, each row with a live
   countdown and "1 of N".
3. A "Missed" state that stays until dismissed: what, when, outcome, and "Ask Claude to try again".
4. A menu bar badge (count, or a dot coloured by the most urgent kind) while anything is waiting.
5. Agent-facing wording that names the kind and the deadline, matching the screen's words ("Confirm
   in Valet within 2 minutes: Remove from cart, Woolworths").

### Quotes

- "I've used half the two minutes before I see the screen."
- "You can't act from the notification is fine. You can't _find_ it from the notification isn't."
- "The thing that's about to die is the row you've cut off."
- "Tell me I missed it. Silence is the worst answer."
- "Whatever dies first goes first."
- "That blue pill is a button? I'd never have clicked it."

### P7's ideal "Needs you"

- **Menu bar icon** gains a count badge (or a filled dot) while anything waits; red tint when the
  most urgent item has under a minute.
- **Tray popover** puts Needs you directly under the status line, above stats, and grows to fit up
  to 4 rows before scrolling (stats collapse into one line when anything waits). Each row: kind icon,
  one-line title in plain words ("Remove from cart · Woolworths"), live countdown on the right
  ("1:12", "14 min", "code ends 4:01", none for reviews), whole row clickable, one primary verb
  (Answer, Log in, Enter code, Review). Sorted by deadline. Remote consent included.
- **Missed** sub-list under it, greyed: "Remove from cart · declined at 9:49, nobody answered ·
  Ask Claude to try again" with Dismiss and a link to the run in Activity. Kept until dismissed or
  24 h.
- **Notifications**: one per item, kept until the item ends; when it ends unanswered, replaced by
  a "You missed..." notification instead of vanishing. Body gives the absolute deadline ("by 9:49").
  A burst of 3+ collapses into "3 things need you".
- **Control panel**: a "Needs you" item at the top of the sidebar (its own page, same list, same
  order) instead of the count sitting on Adapters. Answering always focuses the real floating
  confirmation window, never an in-window copy.

### P7's top-level navigation

1. **Needs you** (badge; the page above, with Missed)
2. **Sites** (Woolworths, Coles, ...: one page each with tools, permissions, session, site health,
   update review as a clear button at the top)
3. **Activity** (calls, blocked requests; audit log as a tab)
4. **Connections** (local clients and remote access/consents together)
5. **Credentials**
6. **Settings** (⌘,)

The tray stays the glance: status and kill switches, Needs you, sites as clickable rows, numbers
that open filtered Activity.
