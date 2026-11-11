# Interview: P1, Nick (owner and power user)

Simulated interview, round 1, 2026-11-11. Researcher notes are marked **R:**, Nick's answers are
in first person. Screens cited are in `docs/ux/research/current-screens/`; claims about what
is clickable were checked in `apps/desktop/src/renderer/`.

## A. Interview

**R: When and where do you use Valet?**
Every day, on the MacBook, usually with Claude Code in a terminal, VS Code and Claude Desktop open.
Valet itself is in the background. I look at the menu bar icon maybe ten times a day, and open the
window a couple of times a day: when something went wrong, when the authoring agent pushed a new
adapter version, or on Sunday night when the weekly shop happens. I also kick off shopping from
my phone through remote mode, and then I'm walking back to the Mac because Claude told me Valet
needs me.

**R: What jobs do you hire Valet for?**

1. Let my agents do the Woolworths shop without me babysitting it.
2. Tell me, in one glance, that it's healthy and nobody is misbehaving.
3. When it needs me, take me straight to the thing, let me act, get out of my way.
4. When I'm debugging an adapter, get me from "that call failed" to the failing request in two
   clicks.

**R: What do "done" and "healthy" look like?**
Healthy is: green icon, nothing in Needs you, MCP on, Woolworths logged in, no breaker open. I
want that as one line, not three cards. Done, for a task, is that the thing I was sent to do is
gone from Needs you and the agent carried on without me re-prompting it.

**R: Describe Valet's main concepts in your words.**

- _Adapter_: a plugin for one site. Code plus a manifest. A version is a hash.
- _Site_: honestly, the same thing as an adapter to me today. One site, one adapter. The sidebar
  calls them "Sites" and the page calls them "Adapters", which is two names for one list.
- _Client_: an app that holds a token: Claude Code, Claude Desktop. I'd call them "Apps" or
  "Connections" in the UI.
- _Grant_: permission for one adapter version to use one 1Password item on one origin. I think of
  it as a binding.
- _Needs you_: my inbox. Approvals, logins, confirmations, remote sign-ins. All of them.

**R: What apps do you compare it to?**
1Password (the mini window is fast, everything is a click target, keyboard driven), Tailscale
(menu bar tells me state in one line, the admin detail is somewhere else), Little Snitch (a prompt
that pops up exactly when needed, with the rule and the consequence, and a rules list I can edit
in place). Also Linear for the "everything is a link" feeling. Valet currently looks like a
well-designed web dashboard. I want it to feel like a Mac utility.

**R: Trust and fear?**
I trust the model because I designed it. My fear is not leaks; it's friction that makes me
approve without reading, and me missing a prompt so a call times out. Second fear: the window
lying to me, like a status that says "intact" with nothing I can click to check it again.

**R: How do you want to be interrupted?**
Notification for anything with a timer (confirmation, login hand-off, remote code). Clicking the
notification must open the exact item, not the home page. Badge only for reviews: they can wait.
Never a modal over my editor for an update review.

**R: Vocabulary?**
"Needs you" is good, keep it. "Review update", "Approve". "Trolley" is what Woolworths says but
the tools say `get_cart`, and the Activity list says "Read the trolley". Pick one. "Remote
sign-in" for a page that's mostly about remote access is wrong: I'd call it "Remote access".
"Credentials" is fine; "Secrets" on the adapter page and "Credentials" in the sidebar are the same
thing, so pick one.

## B. Open card sort (35 cards)

| Group (my name)                    | Cards                                                                                                                                                                    | Where I'd start                                                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| **Needs you** (inbox)              | 1 Approve an adapter update, 8 Log in to a site when asked, 9 Confirm or decline an irreversible action, 20 Approve a remote sign-in, 35 See what needs me right now     | Menu bar or the notification first; also a top item in the window's sidebar. Prompts (confirm, login) open their own window. |
| **Sites** (one page per adapter)   | 2 What an adapter can reach, 3 Its tools, 4 Choose the Woolworths store, 10 Open my trolley, 25 Is a site blocking us, 34 Remove an adapter, (1 again, from the adapter) | Window: Sites > Woolworths. Card 10 also from the menu bar.                                                                  |
| **Activity** (calls and traces)    | 11 Today's calls, 12 Why a call failed, 13 Which requests were blocked                                                                                                   | Window: Activity. The menu bar stat tiles should open it filtered.                                                           |
| **Access** (who and what can call) | 16 Add Claude Desktop, 17 Reset a client's access, 18 Revoke a client, 19 Turn on remote access, 21 Tool on/off for remote, 22 MCP address, 23 Turn MCP off              | Window: Access (Connections + Remote). 22 and 23 also in the menu bar.                                                       |
| **Secrets**                        | 5 Give an adapter a password, 6 Revoke a grant, 7 Re-sync Keychain copy, 26 Set up 1Password, 27 SMS codes from Messages                                                 | Window: Secrets. 5 and 6 also inline on the adapter page.                                                                    |
| **Audit**                          | 14 Verify the chain, 15 Export                                                                                                                                           | Window: Audit log.                                                                                                           |
| **Quick controls**                 | 24 Pause all adapters, 23 again                                                                                                                                          | Menu bar first, plus a toolbar button in the window.                                                                         |
| **Settings**                       | 28 Trace retention, 29 App updates, 30 Run setup again, 31 Reset or uninstall, 32 Open at login, 33 Notifications                                                        | Window: Settings (and the app menu, `⌘,`).                                                                                   |

**R:** Nick put cards 1, 5 and 25 in two groups and insisted they must be reachable from both
(the inbox and the site page). He dropped "Credentials" as a top-level idea at first ("it's a
property of an adapter") but brought it back as "Secrets" because 1Password setup has no other
home.

## C. Cognitive walkthrough on the current screens

Severity: **B** blocker, **M** major, **m** minor.

### S1. Approve Woolworths 0.4.0 from the adapter page (`adapter-wow.png`)

1. _Look:_ the header. I see "Approved" and "0.4.0 waiting for review" as two pills. _Expect:_ a
   "Review update" button near the version on the right. _Actual:_ the blue pill **is** a link
   (`AdapterDetail.tsx:111`), but it's styled exactly like the green "Approved" status pill next
   to it, which is not a link. I didn't try it. **B (discoverability)**: this is the exact
   complaint from my first run. The capability existed; nothing told me.
2. _Look:_ Version / Content hash on the right. _Expect:_ "0.3.0 · 0.4.0 available: Review". _Actual:_
   only 0.3.0. **M**.
3. On the Adapters list (`adapters.png`), "0.4.0 to review" pill in the Approval column is plain
   text (`Adapters.tsx:185`); only the banner's "Review changes" works. **M**.
4. Review screen (`review.png`): good content. But Approve is disabled until I tick "I've read the
   highlighted additions" bottom-left, far from the button at bottom-right. **m** (for me; I'll tick
   without reading, which is the point of my fear). The "Grant 'login' next" checkbox in the purple
   box is an odd place for a follow-up action. **m**.

### S2. "Valet needs you to log in to Woolworths" (`tray.png`, `needs-user.png`)

1. Menu bar: Needs you shows "3" but only one row is visible, cut off at the bottom by the
   Adapters section (`tray.png`). I can't see the other two without scrolling a tiny inner area.
   **M**.
2. "Open" opens the login window. The banner is clear; "I'm done" / "Give up" make sense.
3. From the control panel: Adapters health "Needs you" pill and Session "Login window open" are
   plain text (`Adapters.tsx:259`, session cell). On the adapter page "Show login" works. **M**.
4. In the screenshot the login window body is empty grey under the banner (the page itself isn't
   rendered in fixtures, so I can't judge more). **R:** not counted.

### S3. Confirm a remove (`confirm.png`)

1. Clear title, timer, Decline/Allow. Keyboard focus is on Decline, which I like.
2. The checklist is five lines of "Checked by Valet" before the actual question ("Remove Cavendish
   Bananas?") which is in a grey dashed box marked "Not verified". The thing I'm deciding sits below
   the proof. For me fine; I'd still put the human sentence first. **m**.
3. Content is top-left aligned in a large empty canvas in the screenshot. **R:** may be a capture
   artefact at 1180x780; real window size should be checked. **m**.

### S4. Why did the last get_cart fail? (`activity.png`, `activity-call.png`)

1. Sidebar Activity, list of sentences. The rows are links (good, `Activity.tsx:144`). But the row
   says "Read the trolley on Woolworths", not `get_cart`; I searched for `get_cart` with my eyes
   and didn't find it. No search box and no adapter filter, only outcome and client. **M**.
2. Sidebar swaps "Sites" for "Recent" on this page, with truncated names (`update_cart_li…`). The
   sidebar changes shape under me. **M**.
3. Trace (`activity-call.png`) is great: timeline, blocked requests explained, redaction. Missing:
   a link from "Adapter 0.3.0" and the hash to the adapter page/version, and from a blocked request
   to the manifest line. Header fields look like links but aren't. **m**.
4. Adapter page "Recent runs": tool names are links (good), but outcome pills and "2 blocked" are
   not. **m**.

### S5. Connect Claude Desktop (`clients.png`)

1. Sidebar "Clients" lands on a page titled "Clients and settings". "Add a client…" exists. Fine.
2. "Set up / Reset access / Revoke" as three stacked grey text links per row, no hierarchy and no
   destructive styling on Revoke. **M**.

### S6. Claude Code's token leaked: cut it off (`clients.png`)

1. Revoke is a grey word, same weight as "Set up". I'd want "Reset access" (rotate) to be the
   suggested action and Revoke red with a confirmation that says what breaks. Couldn't see either
   from code without a dialog (not in screenshots). **M**.
2. Nothing on the client row links to its calls in Activity or Audit. Call count "141" is plain
   text. **M**.

### S7. Woolworths seems to be blocking us (`adapters.png`)

1. "Site circuit breakers" card shows Coles "Open · 3:58". Health column "Blocked by site · retry in
   4 min". Neither is clickable; no "Try now", no "Pause this site", no link to the call that
   tripped it. I can only read it. **B** for the "decide what to do" half: there is no action
   anywhere in the window. Pause exists only as "Pause all adapters" in the menu bar
   (`setPaused` is only called from `TrayPopover.tsx`). **B**.

### S8. First launch (`setup-*.png`, `fr-*.png`)

1. Welcome is good. 1Password step offers only "Copy in your Keychain"; the service account and the
   1Password app (which Credentials and the grant sheet offer) aren't there. **M**.
2. Steps 4 and 5 are empty pages with a blue "Approve first" box and a disabled Continue next to an
   enabled "Skip for now". If approval is a prerequisite, don't let me reach those steps as dead
   ends. **M**.
3. `fr-adapters.png` shows a Coles breaker and "37 tool calls today" on a fresh install with one
   unapproved adapter, and `fr-tray.png` says "Working · 1 waiting their turn" for an unapproved
   adapter. **R:** likely fixture leakage, but it reads as a lying dashboard. **m** pending check.

### S9. Remote access for a cloud agent (`remote.png`)

1. Page is "Remote sign-in" but it holds the on/off, public names and tool list. Tools here are
   called "View cart" / "Set cart quantity", elsewhere `get_cart` / `update_cart_line`, and
   "Wikipedia" appears though no Wikipedia site is in the sidebar. **M**.
2. A pending consent is shown on this page and as a sidebar badge, but it's **not** in the menu bar
   Needs you list (attention kinds are only needs-user, confirmation, review in `api.ts`). That's
   my P7 nightmare: a 4:20 timer I can only find by opening the window. **B**.
3. The card is wider than its content (right gutter on a 1180 window, stops at ~955 px) and the
   Approve footer is cut by the window bottom. **m**.

### S10. Check nobody tampered with the audit log (`audit.png`)

1. "Verify chain" button exists, green callout, Export JSONL exists. Good.
2. Call IDs in records are text (`AuditLog.tsx:301`), not links to the trace. "Open adapter"
   exists in the record panel. **M**.
3. Filters wrap onto a second row with "Last 7 days" orphaned on the left. **m**.

### N1 (Nick). Pause everything now, from the window

Only in the menu bar. No toolbar button, no app-menu item, no shortcut. **M**.

### N2 (Nick). Keyboard: jump to Needs you, then approve

No `⌘1…` page shortcuts in the control panel; only the confirmation and grant sheet listen for
keys (`Confirmation.tsx:126`, `GrantSheet.tsx:106`). The tray menu advertises `⌘1` for
Activity, but nothing in the window. No Needs-you page at all in the window. **M**.

### N3 (Nick). Change the Woolworths store

Adapter page > Settings card > "Change…". Works. But the Adapters list's "Choose store" pill is
the only health pill that is a link, so I learn that pills are sometimes links. **m** (consistency).

## D. Looks interactive but isn't / should be interactive / layout oddities

**Looks like a control, isn't:**

- Adapters list: "0.4.0 to review", "Needs you", "Blocked by site", "Approved", tool counts,
  secret badges, "Login window open", calls-7d (`adapters.png`).
- Adapters page "Today" card bars and numbers; "Credentials" card rows; breaker rows.
- Menu bar stat tiles (37 / 3 / 12) and adapter rows (`tray.png`): rows look like menu items.
- Trace header fields (Adapter, Requests "2 blocked", Secrets used) (`activity-call.png`).
- Audit call IDs and hash chips; Credentials "Valid for" hash chips; header "Content hash".
- Sidebar footer "MCP on · 127.0.0.1:47821" and "Audit chain intact": should open Access and
  Audit/verify respectively. Only "Run setup again" is a link.
- Sidebar badges: Adapters "3" (orange, but there are only 2 adapters: it counts attention items)
  next to Activity "37" (grey count). Two badge meanings in one column.

**Is interactive, doesn't look it:**

- Adapter header "0.4.0 waiting for review" pill (the S1 root cause).
- Adapter name in the Adapters table (bold text, no affordance); row itself isn't a target.
- Adapters "Choose store" pill.

**Layout oddities:**

- All body text is selectable (no global `user-select: none`; only diff gutters set it,
  `app.css:1052`). Labels, buttons, sidebar all highlight on drag. Feels like a web page.
- `adapters.png`: large empty band under the three cards; three cards of unequal content forced to
  equal height with dead space.
- `clients.png` / `settings.png`: two sidebar items open the same page with the columns swapped;
  long empty space under the Clients column; Settings rows wrap descriptions into 4-5 lines in a
  narrow column while the label column is wide and mostly empty.
- `remote.png`: content stops ~200 px short of the right edge; footer clipped.
- `tray.png`: Needs you list clipped after one row; endpoint URL truncated with "Streamable HTTP"
  eating the space.
- `review.png`: left column cut at "Request surface" with no visible scroll cue.
- `adapter-yahoo.png`: "No adapter with that id is installed." as one grey line in an empty page,
  no way back except the breadcrumb.
- Adapter page header: "FROM THE MANIFEST" small caps labels repeated on every row of the tools
  table; noisy.

## E. Summary

**Top 5 pain points (ranked)**

1. The thing I need to act on is visible but not actionable where I see it (review from the
   adapter, breaker, health pills, counts). Status and controls live in different places.
2. No single "Needs you" place in the window, and the menu bar one is clipped and misses remote
   sign-in requests.
3. No quick controls in the window: pause, try site again, turn MCP off, keyboard navigation.
4. Inconsistent naming and structure: Sites vs Adapters, Credentials vs Secrets, trolley vs cart,
   Remote sign-in vs remote access, Clients and Settings sharing a page, the sidebar changing on
   Activity.
5. Web-page feel: selectable text, inconsistent pills-as-links, gaps and unequal card heights.

**Top 5 needs**

1. One inbox (Needs you) in the window and menu bar, every item deep-linkable from a notification.
2. Every status shows its action next to it (pill = button when there's something to do).
3. An adapter page that owns its whole lifecycle: update available, review, grants, session,
   breaker, pause, remove.
4. Keyboard first: `⌘1-6` pages, `⌘F` search, `⌘K` command palette, Return/Escape on prompts.
5. Cross-links everywhere: call ↔ adapter version ↔ client ↔ audit record.

**Quotes**

- "The review button existed the whole time and it looked exactly like the status pill next to it.
  That's not my fault."
- "If it's red and it has a timer, I should be able to click it."
- "Don't make me open the menu bar to pause the thing I'm looking at in the window."
- "Pick one word. Trolley or cart. Site or adapter. I built it and I'm still translating."
- "It's a dashboard. I want a utility."

**Nick's ideal top-level navigation**

1. Needs you (inbox; badge only here)
2. Sites (list, then one page per site: overview, tools, permissions, secrets, versions, runs)
3. Activity (calls and traces, searchable, filter by site/client/outcome)
4. Access (MCP endpoint, connected apps, remote access)
5. Secrets (1Password, Keychain copies, Messages, all grants)
6. Audit log
7. Settings (`⌘,`), with Pause and MCP on/off in the toolbar and app menu
