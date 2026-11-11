# Round 1 test: P1, Nick (owner and power user)

Simulated session, 2026-11-11, following `protocol-round1.md`. Nick's answers are in first person;
**R:** marks researcher notes. These answers match his interview (`interviews/P1-nick.md`), where he
sketched: Needs you · Sites · Activity · Access · Secrets · Audit log · Settings.

## Part 1. Tree test

**R:** Nick answered fast and named the path before the task was finished being read. He said
outright that by IA-C he was answering from memory of the content, not reading the tree.

| Task                                  | IA-A                                                                                                                                             | IA-B                                         | IA-C                                                                                                                 |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| T1 Approve Woolworths 0.4.0           | Needs you → the review item. _Sure._ Second guess: Sites › Woolworths › Versions                                                                 | Same. _Sure_                                 | Home → Needs you item. _Sure_                                                                                        |
| T2 Why last get_cart failed           | Activity › Calls, filter tool=get_cart, outcome=failed → trace. _Sure._ Alt: Sites › Woolworths › Activity                                       | Calls → filter → trace. _Sure_               | History › Calls → trace. _Sure_                                                                                      |
| T3 Revoke Claude Code                 | Connections › Apps on this Mac › Claude Code → Revoke. _Sure_                                                                                    | Same. _Sure_                                 | Access › Connections › Claude Code. _Unsure_: "Access" made me hesitate between Connections and Secrets for a token. |
| T4 Remote access on                   | Connections › Remote access settings. _Sure_                                                                                                     | Same. _Sure_                                 | Access › Connections › remote. _Sure_                                                                                |
| T5 Change store                       | Sites › Woolworths › Overview. _Sure_                                                                                                            | Same                                         | Same                                                                                                                 |
| T6 Calls that used the login password | Secrets › Grants › Woolworths login → its calls. _Unsure._ Second guess: Activity › Audit log filtered by secret-used                            | Secrets › Grants. _Unsure_; Audit log second | Access › Secrets › Grants. _Unsure_                                                                                  |
| T7 Verify audit log                   | Activity › Audit log → Verify. _Sure_, but "verify" under "Activity" felt wrong for half a second                                                | Audit log → Verify. _Sure_, instantly        | History › Audit log. _Sure_                                                                                          |
| T8 SMS codes from Messages            | Secrets › One-time codes. _Sure._ (Not Settings: today it's in Settings and I think that's wrong)                                                | Same                                         | Access › Secrets › One-time codes. _Unsure_: two levels deep for a toggle                                            |
| T9 Woolworths blocking, until when    | Sites › Woolworths › Overview health line. _Sure._ Also expect the menu bar row to say it                                                        | Same                                         | Home → site health line. _Sure_, one click less                                                                      |
| T10 What Claude Desktop can call      | Connections › Claude Desktop's page. _Unsure_: today local clients can call everything, so I'd expect "All tools" and wonder why the page exists | Same                                         | Access › Connections. _Unsure_                                                                                       |
| T11 Trace retention                   | Settings › Data and privacy. _Sure_                                                                                                              | Same                                         | Same                                                                                                                 |
| T12 Approve cloud agent with code     | Needs you. _Sure._ Second: Connections › Remote clients                                                                                          | Same                                         | Home. _Sure_                                                                                                         |

**Score (sure / unsure / lost):** IA-A 10/2/0 · IA-B 10/2/0 (T7 faster) · IA-C 8/4/0.

**Winner: IA-B**, narrowly over IA-A. The trees performed the same on paths; IA-B wins on speed for
audit work and on keyboard mapping: seven top-level items map one-to-one to `⌘1–⌘7` and I never
have to remember a sub-tab. Audit is a different job from Calls for me (verify, export, chain),
even though they must link both ways. I'd accept IA-A if Audit log gets its own shortcut and the
sidebar shows Calls and Audit log as visible children, never a hidden tab.

**IA-C loses.** "Access" is a bucket word; it made me hesitate on T3, T8 and T10, and it puts my
two most security-relevant pages two levels deep. "Home" is fine, but I'd rather have Needs you
(see P8).

## Part 2. Labels

- **Sites** over Adapters. I build adapters, but the thing in the sidebar is Woolworths, and I
  shop at a site. Keep "adapter" on the Versions tab and in the review, where it's the code.
- **Connections** over Clients and Connected apps. "Clients" is MCP jargon even to me in a UI;
  "Connected apps" breaks when the thing is a cloud agent, not an app. In my interview I floated
  "Access"; after IA-C I take that back.
- **Secrets** over Passwords and Credentials. It covers TOTP and SMS codes, which aren't
  passwords. "Credentials" is fine but it's longer and the adapter manifest already says
  "secrets", so the trace, the manifest and the page agree.
- **Activity** over History. History sounds like browser history. If IA-B wins, the item is
  **Calls** anyway, which is the most precise.
- **Needs you** over Inbox and Waiting. It's already in the menu bar and I like it. "Inbox" implies
  I can leave things there; "Waiting" is ambiguous (who's waiting, me or the call?).

## Part 3. Hypothesis feedback

**E1 Status and action separate: accept.** E1 would have let me find the 0.4.0 review on the first
run: a "Review update" button next to the version is what I looked for. E1b (pill with a chevron)
probably would have too for me, but I already learned today that I can't tell which pills are links,
so I don't trust pills any more. Keep the badge, add the button.

**E2 Every object reference is a link: accept.** Add right-click: Copy, Open, Show in Activity. Hover
cards are nice but keep them fast (300 ms max) or they get in the way of reading a trace.

**E3 Selection policy: accept.** This is my complaint 3 fixed exactly. Also make double-click on a
hash select the whole hash, not up to the ellipsis, and copy the full value, not the truncated one.

**E4 Destructive confirms, reversible undoes: accept.** Refine: Reset access is the default action,
Revoke is the red one. I want `⌘Z` to work for the Undo toast too.

**E5 Deadlines visible: accept.** Show the clock time only when it's more than a few minutes out;
"1:42 left" is enough for a 2-minute confirmation.

**E6 One plain health line per site: accept.** "Try now" must exist, with a warning that it might
re-trip the breaker. Also "Pause this site" next to it; pause-all is too blunt.

**E7 Numbers are doors: accept.** Every number. Calls-7d, blocked count, the "2 blocked" in a run row.

**E8 Plain words first: refine.** Fine for Sam, but don't make me expand Details on every page. A
setting (Settings › General: "Show technical details") that expands them by default.

**E9 Headings, focus, scrolling: accept.** I don't use VoiceOver, but "nothing is clipped" fixes the
tray and the review page for me too.

**E10 Pause as global control: accept.** Shortcut `⌥⌘P` (or anything global), and the menu bar icon
must change when paused so I can't forget it's off.

**E11 Badges count one thing: accept.** Only Needs you gets a number. Drop the 37 on Activity.

**P1 Needs you page: accept.** The "Missed" section is the part I'd use most when coming back from
my phone. Each missed item should say what happened to the call ("Claude was told it timed out").

**P2 One page per site: accept.** Tabs are right. Overview must show "0.4.0 available: Review
update" in the header, not only in a banner I've learned to ignore.

**P3 Review as a page inside the site: accept.** The chromeless review window was part of my
first-run problem. Refine: move the "I've read the additions" tick next to Approve, or drop it
for the owner and keep it only when additions include a new host or secret.

**P4 Activity filters in URL, linked trace: accept.** Add a search box that matches tool names
(`get_cart`) as well as the plain sentence, and show the tool name in each row.

**P5 Connections one page: accept.** Each client page needs "Calls from this client" and "Last 5
calls" inline.

**P6 Secrets one page: accept.** This answers T6, which was my weakest task: grant → calls that used
it should be a first-class link, not an audit filter.

**P7 Settings own page, `⌘,`: accept.** Obviously.

**P8 Home: P8a.** Open on Needs you when something waits, otherwise on Sites. When a notification
opens the window, it opens the item itself, not Needs you. P8b adds a page I'd skim past; P8c
makes me click once more every time something waits, which is exactly when I'm in a hurry.

**P9 Setup ends with a working test: accept.** And don't show me steps that are dead ends: if
approval is skipped, store and grant become Needs you items, not empty pages.

**P10 Confirmation leads with the sentence: accept.** "Remove" / "Don't remove" over Allow/Decline.
Return = the safe one, as it is today.

**P11 Menu bar popover: accept.** Rows clickable to the site page. Keep it short: 3 Needs you rows
visible with a "+2 more" link rather than a scroll area inside a popover.

**Vocabulary table: accept.** One change: "Approve a connection" should name the client ("Approve
claude.ai, code ABCD-1234"). And pick **trolley** everywhere user-facing, since it's Woolworths'
word, while tool names stay `get_cart`; show both in Activity rows.

## Part 4. What the hypotheses missed

1. **Keyboard and command palette.** Nothing above gives me `⌘K` (jump to site, client, call id,
   "Pause", "Verify chain") or `⌘1–⌘7`. For me that's the biggest remaining gap; it's how 1Password
   and Linear feel fast.
2. **Notifications as a first-class surface.** The vocabulary table covers tool results, but the
   notification text and its click target need the same rule: open the item, show the countdown,
   offer the action (Allow/Decline) from the notification where macOS allows it, for low-risk items.
3. **Developer loop.** As the author, I still review my own dev builds through the full flow.
   There's nothing about comparing two versions quickly or a "trust dev builds from this folder"
   mode (P4's problem too, but I hit it daily).
4. **Native feel beyond selection.** Window title bar, vibrancy, toolbar, right-click menus, the
   app menu bar (File / View / Window). The hypotheses fix web-page behaviour but don't say "this
   is a Mac app".

**Biggest remaining worry:** that after all this it's still a nice dashboard I have to _go to_.
If Needs you, notifications and the menu bar don't take me straight to the one action with the
keyboard, I'll still be hunting, just in a better-organised place.
