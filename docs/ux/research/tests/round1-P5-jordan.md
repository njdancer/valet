# Round 1 test: P5 Jordan (keyboard, VoiceOver, low vision)

Simulated test session, in character and consistent with `interviews/P5-jordan.md`. For the tree
test, Jordan imagines each tree as a sidebar of links in Tab and VO order, with an h1 per page and
tabs as a tablist (VO+Right to the tab list, arrow keys between tabs). Confidence: sure / unsure /
lost. The keyboard cost is the number of decisions by ear, not clicks.

## Part 1. Tree test

| Task                             | IA-A                                                                                         | IA-B                                          | IA-C                                                                                                     |
| -------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| T1 Approve 0.4.0                 | Needs you → Review Woolworths update (sure)                                                  | same (sure)                                   | Home → Needs you section (sure, but "is Home a list or a dashboard?")                                    |
| T2 Why get_cart failed           | Activity → Calls, filter outcome → trace (sure)                                              | Calls → trace (sure)                          | History → Calls (sure)                                                                                   |
| T3 Revoke Claude Code            | Connections → Claude Code page → Revoke (sure)                                               | same (sure)                                   | Access → Connections → Claude Code (unsure: "Access sounds like permissions, I looked in Secrets first") |
| T4 Remote access on              | Connections → Remote access settings (sure)                                                  | same (sure)                                   | Access → Connections (unsure)                                                                            |
| T5 Change store                  | Sites → Woolworths → Overview (sure)                                                         | same                                          | same                                                                                                     |
| T6 Calls that used the login     | Secrets → Grants → Woolworths login → its calls (unsure; second guess Activity filter)       | Secrets → Grants (unsure; second guess Calls) | Access → Secrets → Grants (lost for a moment, two levels down)                                           |
| T7 Verify audit                  | Activity → Audit log tab (sure)                                                              | Audit log (sure, fastest)                     | History → Audit log (sure)                                                                               |
| T8 SMS codes                     | Secrets → One-time codes (sure)                                                              | same                                          | Access → Secrets → One-time codes (unsure)                                                               |
| T9 Blocking until when           | Sites → Woolworths → Overview health line (sure); Needs you if it shows there (second guess) | same                                          | Home health line (sure, fastest)                                                                         |
| T10 What Claude Desktop can call | Connections → Claude Desktop (sure)                                                          | same                                          | Access → Connections → Claude Desktop (unsure)                                                           |
| T11 Trace retention              | Settings → Data and privacy (sure)                                                           | same                                          | same                                                                                                     |
| T12 Cloud agent with code        | Needs you (sure)                                                                             | Needs you (sure)                              | Home (sure)                                                                                              |

Learning effect: by IA-C Jordan knew the content, so the IA-C "unsure" marks are about the labels,
not unfamiliarity. IA-B felt easiest on T7 only because it was the second pass.

Tally: IA-A 10 sure, 2 unsure; IA-B 10 sure, 2 unsure; IA-C 6 sure, 5 unsure, 1 lost.

**Winner for Jordan: IA-A.** "IA-A and IA-B scored the same, but IA-A is six sidebar stops, not
seven, and Calls and Audit log as two tabs on one page means one h1 and an arrow key between them.
IA-C's Access is a folder inside a folder: every extra level is another announcement before I reach
what I want, and 'Access' and 'Secrets' both sound like passwords. Home duplicates Needs you, so I'd
hear the same items twice."

Condition: the Activity tabs must be a real `tablist` with the URL and h1 changing per tab ("Audit
log, heading level 1"). Otherwise the audit log is hidden behind a control I won't hear.

## Part 2. Labels

- **Sites** over Adapters. "Woolworths is a site. An adapter is something you plug into a wall."
- **Connections** over Clients or Connected apps. "Clients is what a lawyer has. Connected apps
  is three syllables longer to hear every time, and remote agents aren't apps on my Mac."
- **Secrets** is acceptable, but I'd still say **Passwords**. "Passwords is what I'd type into
  VoiceOver's item chooser. If it's Secrets, make sure 'passwords' finds it in search."
- **Activity** for the section, if it holds Calls and Audit log tabs. "History was my word, but
  Activity with two tabs is fine. Don't have both words in the app."
- **Needs you** over Inbox or Waiting. "Short, and it tells me it's my job. Inbox sounds like
  mail. Waiting sounds like Valet is waiting, not me."

## Part 3. Hypothesis feedback, with a11y acceptance criteria

**E1. Status and action separate. Accept.** "E1 would have let me find the update. E1b wouldn't.
A badge that's a button reads as 'Approved, button' and I wouldn't guess it's a review."
_AC:_ the status is plain text in the h1 region; the action is a `button` or link whose name
includes the object ("Review Woolworths 0.4.0 update"); it sits immediately after the status in
DOM and Tab order; the badge is never in the Tab order.

**E2. Every object is a link. Refine.** "Yes, but a hover card is a mouse thing."
_AC:_ links are real `<a>` with names that say the destination ("Call c_9a71d0, get_cart");
the hover card's actions are also in a context menu reachable by Shift+F10 or the Menu key, and
"Copy" is a separate focusable button; link style isn't colour-only (underline on focus and hover,
3:1 against text).

**E3. Selection policy. Accept.** _AC:_ `user-select: none` on chrome; values keep text
selection and a visible-on-focus copy button named "Copy hash 9f3c…"; the copy result is announced
("Copied") in a polite live region.

**E4. Destructive actions confirm. Accept, strongly.** "This fixes my worst moment."
_AC:_ `role="alertdialog"`, `aria-labelledby` the question ("Revoke Claude Code?") and
`aria-describedby` the consequence; initial focus on Cancel; Escape cancels; focus contained;
on close, focus returns to the row (or to the next row if the row is gone) and a live region says
"Claude Code revoked". Undo toasts stay until dismissed or 10 s after the last keyboard activity,
and Undo is reachable with a shortcut (Cmd+Z) as well as Tab, because toasts are hard to reach by
keyboard.

**E5. Deadlines visible. Refine.** "Show the clock time first: 'until 9:50 pm, 1 minute 42 left'.
The clock time doesn't change while I'm reading it."
_AC:_ the countdown is `role="timer"` with `aria-live="off"`; separate polite announcements at
2 minutes, 1 minute and 30 seconds only; the static clock time is in the accessible name of the
item; Reduce Motion stops any animated ring or bar but keeps the text.

**E6. One health line per site. Accept.** _AC:_ the health line is text, the action ("Try now",
"Resume") is a separate button named with the site; a health change for a site with an open page is
announced politely once; colour or dot is never the only signal.

**E7. Numbers are doors. Accept.** _AC:_ the tile is one link with a full name ("12 blocked
requests today, show them"), not a number then a separate unlabelled sparkline; sparklines are
`aria-hidden` or have a text summary ("rising since 9 pm").

**E8. Plain words first. Accept.** _AC:_ the Details disclosure is a `button` with
`aria-expanded`; technical terms in Details still have plain names for VO ("content hash" not
"sha256:").

**E9. Headings, title, focus, announcements, scrolling. Accept, and it's the one I need most.**
_AC (all testable by Playwright):_ every route has exactly one h1, and card titles are h2;
`document.title` = "Page — Valet"; after a route change focus moves to the h1 (`tabindex="-1"`),
or to the first field for forms and sheets; a skip link "Skip to content" is the first Tab stop;
every action result goes through one shared polite live region; no window or panel has
`overflow: hidden` on its scroll axis, and at 200% zoom every control is reachable by scrolling;
the window reflows to one column below about 700 CSS px; type is in rem and follows a text-size
setting; all text is 4.5:1 (3:1 for 18px+), focus rings 3:1, drawn with `outline` so forced colours
keep it.

**E10. Global Pause. Accept.** _AC:_ a toggle button with `aria-pressed` and a stable name ("Pause
Valet"); the shortcut is listed in the app menu so VO reads it; pausing is announced ("Valet
paused. Calls wait until you resume.").

**E11. Badges count one thing. Accept.** "This is my 'Adapters 3' versus 'Activity 37' complaint."
_AC:_ the badge's accessible text is "3 need you", not "3"; there's no badge on totals; the
sidebar link reads "Needs you, 3 items".

**P1. Needs you page. Accept.** _AC:_ a list (`ul` with item count), each item an `li` with an h2
or h3 title ("Confirm: Remove Cavendish Bananas"), the inline action buttons named with the item;
new items announced politely ("New: Log in to Woolworths"); when an item is answered, focus moves
to the next item, not the top. The "Missed" section is its own heading.

**P2. One page per site with tabs. Refine.** "Five tabs is fine if they're a real tablist and the
URL changes. Don't make me re-hear the whole Overview to reach Permissions."
_AC:_ `role="tablist"` with arrow-key movement and automatic activation; each tab has its own
route; the update banner sits directly after the h1 with the button from E1.

**P3. Review as a full page. Accept.** "A page I can scroll and navigate by heading beats a
chromeless window."
_AC:_ h1 "Review Woolworths 0.4.0"; h2 per section (What's new, Permission changes, Files, Code);
added and removed lines labelled in text ("Added:", "Removed:") or via `ins` and `del` with
visually hidden text; Approve is always focusable with `aria-disabled` and `aria-describedby`
pointing to "Tick 'I've read the additions' first"; after Approve, focus goes to the site's h1 and a
live region says "Woolworths 0.4.0 approved. Grant its login next."; Escape returns focus to the
link that opened it.

**P4. Activity filters in the URL, trace links. Accept.** _AC:_ filters are labelled form
controls; changing a filter announces the count ("2 calls"); the trace header is a `dl`; the
timeline is an ordered list with step numbers.

**P5. Connections one page, client pages. Accept.** _AC:_ one h2 per group (On this Mac, Remote);
row buttons named with the client ("Revoke Claude Code"); a pending remote sign-in also appears
in Needs you.

**P6. Secrets one page. Accept.** _AC:_ the grants table has a caption and row headers; the
"calls that used it" link is named "Calls that used the Woolworths login".

**P7. Settings its own page, Cmd+comma. Accept.** _AC:_ h2 per group; Tab order follows reading
order (fix today's two-column jump); switches are `role="switch"` with names that don't change
with state.

**P8. Home. Pick: P8a, refined.** "Open on Needs you when something waits, Sites otherwise. P8b
puts a dashboard between me and the item and makes me listen to health lines I didn't ask for.
P8c makes me go looking when I know I'm needed."
_AC:_ whichever page opens, focus lands on its h1 and the window title says it ("Needs you, 2
items — Valet"), so I'm never unsure where I landed. Opening from a notification goes to that
item, not the page.

**P9. Setup ends with a working test. Accept.** _AC:_ the test result is announced; skipped steps
appear in Needs you with the same wording as the setup step.

**P10. Confirmation leads with the sentence. Accept.** "This fixes my 'Confirm a tool action,
dialog' problem."
_AC:_ the dialog's accessible name _is_ the sentence ("Remove Cavendish Bananas from your
trolley?"); initial focus on the safe button ("Don't remove"); focus contained; the window scrolls,
and at 200% zoom the buttons stay visible in a sticky footer; button names are verbs.

**P11. Menu bar popover. Refine.** "Make it behave like a menu."
_AC:_ on open, focus goes to the first Needs you item; arrow keys move between rows and Tab moves
between groups; each row is one focusable element with a full name ("Log in to Woolworths, for
Claude Code, until 9:58 pm"); the site rows are buttons; at 200% zoom the popover scrolls
vertically and nothing clips sideways.

**Vocabulary table. Accept.** "If Claude says 'Log in to Woolworths' and VO's item chooser finds
'Log in to Woolworths', I can jump straight there. That's the whole point." _AC:_ each phrase in
the table is the exact accessible name of the matching Needs you item.

## Part 4. What the hypotheses missed

"My biggest worry is that this all ships in visual form and the keyboard and VoiceOver parts get
half-done: a lovely tablist you can only click, a toast that disappears before I reach it, motion
that ignores Reduce Motion. I want E9's criteria as automated checks that fail the build: one h1
per route, focus on the h1 after navigation, no unnamed or duplicate-named buttons in a row, no
clipped controls at 200%, and AA contrast."

Also missing:

- **App-wide keyboard shortcuts** listed in the app menu: Cmd+1 to Cmd+6 for sidebar sections,
  Cmd+F for search on every list, Cmd+comma for Settings, a Pause shortcut.
- **Focus restoration as a rule**, not per screen: after any sheet, dialog, toast or deletion,
  focus goes back to the invoking control or its nearest surviving neighbour.
- **The login hand-off window** isn't covered by any hypothesis: it needs focus on the site's
  form, "I'm done" before "Give up", and the timer handled like E5.
- **A text-size setting in Valet** as well, because web content ignores macOS Larger Text.
- **Motion:** every animation the design work adds needs a Reduce Motion version that keeps the
  meaning (fade or instant) and never moves focus.
