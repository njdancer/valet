# P5 interview and accessibility walkthrough: Jordan (keyboard, VoiceOver, low vision)

Simulated persona interview, 2026-11-11, round 1, with Jordan answering in character. The
walkthrough uses evidence from the current renderer on fake data: Playwright ARIA snapshots,
recorded Tab orders, keyboard interaction probes, and renders at 200% zoom and 200% root font size
with Reduce Motion. VoiceOver wasn't run, so "what they hear" means the accessible name and role
Chromium exposes.

Severity: **Blocker** (can't finish the task without sighted help), **Major** (finishes, but loses
orientation, gets surprised or takes a big detour), **Minor** (friction).

---

## A. Interview

**R: Tell me about your setup.**
J: MacBook Air, Display zoom set to "Larger Text", plus Hover Text and full-screen Zoom at about
2.5x when I need detail. VoiceOver is on all day with the VO keys on Caps Lock. Reduce Motion and
Increase Contrast are on. I use the keyboard for everything. I have a trackpad, but finding a
pointer at 2.5x is like reading a map through a straw. My goal is simple: Claude Desktop does my
weekly Woolworths shop, and I want to handle whatever Valet asks of me without asking my sister.

**R: What makes a Mac app easy for you?**
J: Four things. Every screen starts with a heading that says where I am, and VO+Command+H takes me
through the sections. Focus lands somewhere sensible when something opens, and it comes back where
I was when it closes. Every control says what it acts on: "Approve Woolworths 0.4.0", not
"Approve" next to some text I have to hunt for. And when something changes, it tells me once,
politely, without moving me.

**R: And painful?**
J: Web pages pretending to be apps. You press a button, the page swaps, VoiceOver says "Valet,
window" and I'm at the top of an unknown screen. Or a "Revoke" that just happens, silently. And
small pale grey text that Larger Text doesn't touch, so I zoom the whole screen and lose the
layout.

**R: How do you want status changes announced?**
J: Three levels. Needs me now: a notification and a window that takes focus, with the question
read first. Something I just did: a polite one-liner, "Login grant revoked for Woolworths", with
focus on something useful, ideally Undo. Background changes: don't announce, but let me find
them. Never tick a countdown every second. Say "times out in 2 minutes" once, then at 30 seconds.

**R: Words you'd use?**
J: "Woolworths", not "adapter". "Claude", not "client". "Log in", "Confirm", "Approve update".
"Needs you" is good, it's short and it sounds like a list. "Egress", "partition" and "probe" mean
nothing to me. "Content hash" is fine if it's in a details section I can skip.

---

## B. Open card sort (35 cards)

Jordan sorted by "where would I tab to first", and wanted no more than six top-level places,
because each one is a stop in the sidebar.

| Group (Jordan's name)         | Cards                                                                                                                                                                     | Where Jordan would start                                                                                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Needs you**                 | 1 Approve an update, 8 Log in when asked, 9 Confirm or decline, 20 Approve a remote sign-in, 35 What needs me now                                                         | The first item in the sidebar and the first section of the menu bar panel. A count in the name: "Needs you, 3 items".                                                                         |
| **Sites** (one page per site) | 2 What it may reach, 3 Its tools, 4 Choose the store, 5 Give it a password, 6 Revoke a password grant, 10 Open my trolley, 25 Is the site blocking us, 34 Remove the site | The site's own page, with headings: Status, Tools, Store, Login, Permissions.                                                                                                                 |
| **History**                   | 11 Today's calls, 12 Why a call failed, 13 Blocked requests, 14 Verify the audit chain, 15 Export the audit log                                                           | A single "History" with two views, Calls and Audit log. "I don't care which log it is, I care what happened."                                                                                 |
| **Connections**               | 16 Add Claude Desktop, 17 Reset access, 18 Revoke a client, 19 Remote access on, 21 Tools for remote clients, 22 MCP address, 23 MCP off                                  | One page with headings: On this Mac, Remote.                                                                                                                                                  |
| **Passwords**                 | 7 Re-sync a Keychain copy, 26 Set up 1Password, 27 SMS codes                                                                                                              | Hesitated, then said: "I'd look for my passwords in one place, so 1Password, Keychain and SMS go here. Revoking a grant also works from here." Card 6 was placed in both Sites and Passwords. |
| **Settings**                  | 24 Pause all (also wanted it in the menu bar), 28 Trace retention, 29 App updates, 30 Run setup again, 31 Reset or uninstall, 32 Open at login, 33 Notifications          | Settings, with headings so VO+Command+H works.                                                                                                                                                |

Jordan also wanted "Pause all" as a keyboard shortcut, and didn't expect "Remote sign-in" at the
top level: "That's a connection. When someone's waiting, it belongs in Needs you."

---

## C. Walkthrough of S1 to S10 (keyboard and screen reader, current app)

### Cross-cutting findings that affect every scenario

1. **Focus is dropped to `<body>` on every route change.** Probes: Enter on "0.4.0 waiting for
   review", focus moves to `BODY`; Enter on an Activity row, `BODY`; Approve, `BODY`. VoiceOver
   reads from the window top or says nothing. Cause: `lib/router.ts:16` only updates state on
   `hashchange`. Nothing moves focus to the new page's heading or announces the page. **Major,
   everywhere.**
2. **Most pages have no heading.** Activity, Audit log, Clients and settings, Remote sign-in,
   Credentials, Adapters, the trace, Review update, Confirmation and the menu bar panel have **zero**
   `h1` to `h6` elements (audit `headings: []`). Page titles are `<div className="title">`
   (for example `screens/Activity.tsx:106`, `screens/AuditLog.tsx:144`,
   `screens/ReviewUpdate.tsx:146`), and card titles are plain text. Only Adapter detail
   (`AdapterDetail.tsx:101`) and setup have an h1. VO+Command+H is useless. **Major.**
3. **No live regions for results.** `role="status"` is used only for store-search errors
   (`AdapterDetail.tsx:500-528`) and copy feedback. Verify, revoke, approve, filter and
   add-client results are silent. **Major.**
4. **Text doesn't scale with system or root font size.** Type tokens are fixed px, 11 to 15
   (`styles/tokens.css:11-15`), and the base is 13px (`tokens.css:95`). Setting
   `html { font-size: 200% }` changed nothing. Some labels are 10px (`app.css:903`). Tertiary
   text `#a1a1a6` on white (`tokens.css:39`) is about 2.6:1 and fails WCAG AA. **Major.**
5. **The window can't scroll its frame at 200% zoom.** `.window { height: 100vh; overflow: hidden }`
   (`styles/app.css:201-208`), so content below the fold is clipped (see S3). **Major to Blocker.**
6. **No skip link.** 9 to 15 sidebar stops come before the content on every page (on Activity
   that includes the sidebar's recent calls). **Minor**, but it adds up.
7. **Focus ring missing on some controls.** Ghost and small buttons have no visible focus at all:
   "Revoke", "Reset access" and "Copy address" on Clients and Credentials, "Show record N" on Audit
   log, "Decline all", "Skip for now". The ring is a `box-shadow` with `outline: none`
   (`controls.css:15-21`), so variants that reset `box-shadow` lose it. **Major.**

### S1. Approve Woolworths 0.4.0 from the adapter page

1. Sidebar, "Woolworths" link, Enter: focus goes to BODY (cross-cutting 1). VO+Command+H finds
   "Woolworths, heading level 1", which is good.
2. Tab order on the page: Breadcrumb "Adapters", then **"All activity"** (top right), then
   "0.4.0 waiting for review" (stop 13 of 26). The link exists (`AdapterDetail.tsx:112`), which
   answers Nick's complaint in principle, but it's a pill-sized link, and the main heading
   section never says "An update is waiting". Jordan: "I found it because I tabbed everything. I'd
   expect a banner under the heading with a button, 'Review update'." **Minor.**
3. Enter on the link: focus goes to BODY on the Review page. The page has **no heading and no
   landmark** (audit: `headings: []`, `landmarks: []`). VoiceOver reads one ~400-word text run
   from "Review update Woolworths 0.3.0 → 0.4.0 Close W Woolworths 0.4.0 Waiting for…". **Major.**
4. Tab: "Close", then a **focusable scroll container** whose name is its whole contents
   ("Permission changes additions are highlighted Tools may contact · egress allowlist = …"),
   then the checkbox "Grant 'login' next", then "I've read the highlighted additions", then
   "Reject". **"Approve 0.4.0" is disabled and not in the Tab order** (`ReviewUpdate.tsx:343`).
   Nothing tells Jordan that ticking the checkbox will enable it, and the hint "Until you approve,
   calls keep using 0.3.0" isn't linked to the button by `aria-describedby`. **Major.**
5. The diff is read as a flat string ("@@ "version" @@ 5 − "version": "0.3.0", 5 + …"). Added
   lines differ only by colour and a +/− glyph. **Major** for reviewing by ear.
6. The files table has no column headers (`th=0`), so cells read as "src/tools/rewards.ts, new,
   +64". **Minor.**
7. Tick the checkbox, Tab twice, Approve, Enter: the window goes back to Woolworths and focus goes
   to BODY. **No announcement** that 0.4.0 was approved. The sidebar count changing from
   "Adapters 3" to "Adapters 2" is the only sign. **Major.**

Outcome: completed, with about 30 key presses and no confirmation by ear.

### S2. "Valet needs you to log in to Woolworths"

1. The menu bar panel opens as a `dialog "Valet"` with no initial focus (focus stays on BODY).
   Arrow keys do nothing (probe: ArrowDown leaves focus on BODY). It isn't a menu, so the menu
   bar habit of arrowing through items fails. **Major.**
2. Tab: "Copy endpoint address", then **"Open"**, then "Answer", then "Review". The buttons are
   named only by their verb, and the item text is a sibling. VoiceOver says "Open, button", not
   "Open login for Woolworths" (`tray/TrayPopover.tsx:204, 227, 252`). Jordan has to VO-arrow
   back to find what "Open" opens. **Major.**
3. The "Adapters" section rows aren't focusable (`TrayPopover.tsx:104-117`). **Minor.**
4. The login hand-off banner (`needs-user`): a `region "Login hand-off"` with **no initial
   focus**. Tab lands on "Give up" _before_ "I'm done", so the destructive choice comes first.
   The site's own login form, where Jordan has to type, isn't reachable from the banner by any
   documented key. "Closes in 4:00" sits outside the region and isn't announced. **Major.**

### S3. Confirm removing an item from the trolley

1. The Confirmation window is the best-built surface: `dialog "Confirm a tool action"`, and focus
   starts on **Decline**, with Escape and Return declining (`Confirmation.tsx:114-126`). Good.
2. But Tab cycles **Allow, then BODY, then Decline, then BODY**. Focus escapes to the document
   every other press, and VoiceOver announces the whole dialog text again each time. No focus
   containment. **Minor.**
3. The dialog's accessible name doesn't include the question. "Let Woolworths continue: Remove
   from cart?" isn't a heading and isn't `aria-labelledby`, so VoiceOver says "Confirm a tool
   action, dialog" and Jordan has to read on to learn which item. The concrete item ("Remove
   Cavendish Bananas (2 × $0.79)") is far down, in the adapter's unverified box. **Major.**
4. **At 200% zoom the Decline and Allow buttons are at y=1016 in a 780px window, and nothing
   scrolls** (scroll-container audit: none). The countdown is clipped too. With Zoom, Jordan
   can't see the buttons at all and depends on knowing that Return declines. Allowing is possible
   only blind. **Blocker** for a low-vision user who relies on zoom rather than VoiceOver.
5. "Times out in 1:52" (`Confirmation.tsx:249`) is never announced. **Minor.**

### S4. Why did the last get_cart call fail?

1. Sidebar "Activity 37" (37 _what_? It reads the same way as the alert count "Adapters 3", see D).
2. Filter "Failed or blocked", Enter: list changes, **no announcement** of "2 calls". Focus stays
   on the button (good). The "7 calls" count text isn't a status region. **Minor.**
3. Rows are links with good, full names: "Ran get trolley on Coles for 'Claude Desktop' blocked
   9:44 pm". This is the best list in the app. Outcome is a word, not just a colour. Good.
4. Enter opens the trace, and focus goes to BODY. No heading. The summary is text and `strong`
   pairs, not a description list, so it reads as one run. The timeline list reads well ("0.812
   Stopped at Tool code: Blocked by site"), but there's **no link** to the adapter, the version,
   or what to do about it. **Major.**

### S5. Connect Claude Desktop

1. The sidebar "Clients" and "Settings" links are **two links to one page**
   (`control/App.tsx:81-83`), so Jordan lands in the middle of a long two-column page with no
   headings.
2. "Add a client…", Enter: a form appears, but **focus stays on BODY**, and Jordan has to Tab
   through the whole MCP card again to find the new fields. **Major.**
3. Tab order jumps between the two columns ("Check now" at y 747, then "Stable" at y 406).
   **Minor.**
4. At 200% the right column is clipped, with no horizontal scroll. **Major.**

### S6. Claude Code's token leaked: cut it off

1. Clients table: three rows each have "Set up, Reset access, Revoke" buttons with **identical
   names**. VoiceOver's rotor lists "Revoke, Revoke" with no client. The buttons have no
   focus ring (NORING). **Major.**
2. Enter on the first "Revoke": **the client is revoked immediately, with no confirmation.** The
   copy says "Revoke cuts it off for good" (`ClientsSettings.tsx:201`). Focus is lost to BODY, and
   there's **no announcement**. The only evidence is "Revoked" text in a row Jordan has to find
   again. If Jordan was on the wrong row, Claude Desktop was cut off for good, silently.
   **Blocker** (irreversible and silent).

### S7. Is Woolworths blocking us?

1. Adapters table: Coles' "Health" cell reads "Blocked by site Retry in 4 min". The table has
   headers but no caption, and only the name is focusable. **Minor.**
2. On Adapter detail, the "Site" status sits in a card whose title isn't a heading. The dot
   (`AdapterDetail.tsx:626-631`) duplicates the text, which is fine, but there's no "Pause" or
   "Try now". Jordan: "It tells me, it doesn't let me do anything." **Minor.**

### S8. First launch setup

1. The most accessible flow: `navigation "Setup steps"` with `aria-current="step"`
   (`Setup.tsx:207`), an h1 per step, "Done" as text. Good.
2. Focus on step change goes to BODY, and "Step 3 of 6" isn't announced. **Minor.**
3. On the Approve step, "Continue" is disabled and not focusable, and "Skip for now" has no focus
   ring. The reason Continue is disabled ("Until you approve, its tools stay off MCP") isn't
   associated with it. **Minor.**
4. The Grant step, when approval was skipped, says "Approve Woolworths first" with a link. That's
   a clear recovery. Good.

### S9. Turn on remote access

1. No heading, but the two `region`s are labelled. Good.
2. "Turn on" is **disabled and skipped by Tab**, so Jordan never hears it exists until the
   public-name field has text. "Add" is disabled too. **Major** (Jordan can't discover the
   sequence).
3. Tool checkboxes are well named ("Woolworths: View cart"). The sign-in request row says
   "claude.ai just now from 203.0.113.24 · ends in 4:20" with a "Decline" button, but "Approve" for
   that request is further down, after the code field, and also disabled and skipped. **Major.**

### S10. Check the audit log hasn't been tampered with

1. "Verify chain", Enter: focus stays on the button, and the result callout updates with **no
   live region** (`AuditLog.tsx:360-380`). Jordan has to go and find "Chain intact up to record
   4813". A failure _does_ use `role="alert"` (`AuditLog.tsx:349`), which is right, but the
   success case is silent. **Major.**
2. Enter on "Show record 4811" opens `complementary "Record"`, but focus stays on the row, the
   panel comes after the whole table in reading order, and Escape does nothing. **Major.**
3. The table has column headers. The "Call" column shows `c_9a71d0` as text, not a link to the
   trace. **Minor** (that's Nick's "should be interactive" complaint).

---

## D. Interaction, layout and zoom problems

**Should be interactive (heard as text, expected to act):** tray Adapters rows; Audit "Call"
IDs and the trace's Call, Adapter and Client values; Adapters table Health, Session and
Approval cells ("0.4.0 to review" is text in the list but a link on the detail page); Recent
runs Client column; the sidebar footer "MCP on" and "Audit chain intact"; tray stat tiles, whose
sparklines also have no text alternative.

**Colour-only or ambiguous status:**

- Sidebar counts: "Adapters 3" (orange, items needing you) and "Activity 37" (grey, a total) are
  read **identically**. The meaning lives only in the colour of the badge (`Sidebar.tsx:52-53`,
  class `count alert`). It should say "3 need you".
- Review diff: added and removed lines differ by colour plus a single +/− glyph. The
  "additions are highlighted" summary is colour.
- Status dots are always paired with text, which is fine.

**Focus traps and loss:**

- Grant sheet: correct `aria-modal`, the window behind is `inert` (`control/App.tsx:56-57`), and
  focus goes into the sheet (`GrantSheet.tsx:93`). That's the model to copy. But Escape left focus
  on BODY in the probe, although `GrantSheet.tsx:97` tries to restore focus to the opener. The
  route change re-renders the opener, so `isConnected` fails.
- Confirmation: no containment (Tab reaches BODY).
- Every route change, every revoke and every approve: focus to BODY.

**Tables:** most have `th`, but none has a caption, so the rotor lists "table, table". The Review
files table has no headers, action columns have empty headers, and row buttons have no row
context in their names.

**Live regions:** none for success states anywhere. Countdowns (confirmation 2 min, login 4 min,
remote 4:20) aren't timers.

**Selectable text:** everything except the diff gutter is selectable (`app.css:1052` is the only
`user-select: none`). Cmd+A selects the whole UI, and a click with Hover Text selects words
instead of activating. Jordan wants chrome unselectable and values (hashes, addresses, JSON, IDs)
selectable, with a copy button.

**Zoom and larger text:** the px type scale ignores the root size. At 200% zoom: the tray panel
clips horizontally ("12 Blocked request…" is cut off, and the endpoint address disappears so only
"Streamable HTTP" shows). The Review header text collides ("· 3 files changed" overlaps
"+1 host"). Clients and settings clips its right column. The confirmation buttons are off-screen.
The 880 x 560 minimum window plus fixed 220px sidebar doesn't reflow to one column.

**Reduce Motion:** one transition exists (`screens.css:1116`) and nothing checks
`prefers-reduced-motion`. The coming motion work must.

---

## E. Synthesis

**Top 5 pain points**

1. Focus drops to the document on every navigation and action, so Jordan is lost after every
   Enter.
2. Destructive actions (revoke client, revoke grant) happen instantly, silently and without undo.
3. No headings on most screens, so there's no way to skim by ear.
4. Text is fixed at 11 to 13px with pale tertiary grey, and at zoom, windows clip instead of
   scrolling (the Allow and Decline buttons vanish).
5. Buttons named by verb only ("Open", "Revoke", "Review"), with disabled primary actions hidden
   from Tab.

**Top 5 needs**

1. On every page change, move focus to the h1 and set `document.title`. After an in-page action,
   keep focus on a sensible element and announce the result politely.
2. A confirmation (alertdialog) or an undo toast for every revoke, reset or remove, naming the
   target.
3. A real heading structure (h1 page, h2 card) and labelled tables. A skip link to the content.
4. A rem-based type scale that follows the system text size, AA contrast for all text, and
   windows that scroll (and reflow to one column) instead of clipping.
5. Self-describing controls ("Revoke Claude Code", "Open Woolworths login"), disabled buttons
   kept focusable with `aria-disabled` and a described reason, and a "Needs you" list that's the
   first stop everywhere.

**Quotes**

- "Every time I press Enter, VoiceOver just says 'Valet'. I'm back at the front door."
- "I revoked Claude Code and nothing said anything. I only know because I went looking."
- "The Approve button doesn't exist until I tick a box nobody told me about."
- "At zoom the confirmation window has a question and no answers."
- "'Adapters 3' and 'Activity 37' sound the same. One's an alarm and one's a counter."
- "The setup screens are lovely. Make the rest like that."

**Jordan's ideal top-level navigation** (sidebar, in Tab order, each an h1 when opened):

1. **Needs you** (count in the name; login, confirmations, updates to review, remote sign-ins)
2. **Sites** (Woolworths, Coles: one page each with h2 Status, Tools, Store, Login, Permissions,
   Recent calls; update banner under the h1 with "Review update")
3. **History** (Calls and Audit log as two tabs; every ID a link)
4. **Connections** (Claude apps on this Mac, then Remote)
5. **Passwords** (1Password, Keychain, SMS, all grants)
6. **Settings**

Plus a global "Pause everything" shortcut, and the menu bar panel as a real `menu` with
arrow-key navigation and "Needs you" items first.
