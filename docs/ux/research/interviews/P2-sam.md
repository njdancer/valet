# Interview: P2, Sam (first-time non-technical installer)

Simulated persona interview, round 1 (2026-11-11). Researcher notes are marked **R:**. Sam's
answers are first person. Screenshots are in `docs/ux/research/current-screens/`. Claims about
what you can click were checked in `apps/desktop/src/renderer/`.

Fixture caveat: the `fr-*` shots use shared fake data (37 calls, a Coles breaker, "2 clients
connected" on a fresh Mac). Sam reacted to what was on screen. A real first launch needs its own
empty-state check.

---

## A. Interview

**R: When and where would you use Valet?**
On my MacBook Air, on the couch, on a Sunday when we plan the week's food. Claude Desktop open,
1Password in the menu bar, Woolworths in Safari because I don't fully trust this yet. After setup,
I'd open Valet only when Claude tells me to.

**R: What job are you hiring it for?**
Let Claude fill my Woolworths trolley so that I only check it and pay. Set it up once, tell me when
it needs me, never buy anything without me. I don't want to manage it.

**R: What does "done" and "healthy" look like?**
Done with setup means a big tick and "Claude can now use Woolworths. Try asking it: what's in my
trolley?" Healthy means one green word next to Woolworths, like "Working" or "Ready". Right now the
menu bar shows me 37 / 3 / 12 with little bar charts (`fr-tray.png`). I don't know if 12 "blocked
requests" is bad. Red bars look bad. On my first day, why has anything been blocked?

**R: In your words, what are these: adapter, site, client, grant?**

- **Adapter:** "a plug for a website, I guess? Like a travel adapter." I'd call it _Woolworths_. I
  don't think of a separate thing that has a version number. "Woolworths 0.3.0" makes it sound like
  software I'm supposed to update.
- **Site:** Woolworths. That's the thing I care about. The sidebar has both "Adapters" and
  "Sites", both listing Woolworths, which makes me think they're two different things.
- **Client:** "a customer?" I'd say _Claude_ or _the Claude app_. "A client calling itself 'Claude
  Code'" (`confirm.png`) sounds like an impostor warning.
- **Grant:** "money from the government." In context I get "let it use my password", so I'd call
  it _Allow login_ or _Use my 1Password login_.
- **MCP:** no idea. It's on the first screen of setup, in the menu bar and in the sidebar footer.

**R: Which apps do you compare it to?**
1Password (one "unlock" moment, then out of the way). Family Sharing "Ask to Buy" (a notification
with Approve / Decline, the item and its price). Wi-Fi in the menu bar (one icon state means OK).

**R: What do you trust and what scares you?**
I trust 1Password and Apple. I'm scared of Claude checking out or buying the wrong thing, of
giving my password to "something", and of clicking a button that breaks Nick's setup. "Nothing
irreversible without you" (`setup-welcome.png`) is the most reassuring line in the app, but it's a
small card beside two I didn't understand. The red "Reject" and "Grants are tied to the content
hash" (`fr-review.png`) make me feel I'm signing a contract.

**R: How do you want to be interrupted?**
A normal Mac notification in plain words ("Claude wants to remove bananas from your trolley")
that opens straight to the thing. A countdown is fine if it says what happens at zero ("nothing is
removed"). No windows popping up by themselves; if one must, make it look like a Mac dialog.

**R: Which words on screen did you not understand?**
Every one of these stopped me: MCP, Streamable HTTP, stdio, bridge, adapter, manifest, bundle,
content hash, egress, allowlist, auth partition, origin, declared hosts, probes, hand-over domains,
secret fills, request surface, circuit breaker, endpoint, token, client, grant, bind, provider,
service account, CLI, JSONL, audit chain, "Not verified by Valet" (then who did?), stockcode, POST,
`login.username`. Words I got and liked: trolley, store, log in, Allow, Decline, "needs you",
"Times out in 1:52".

---

## B. Open card sort

| My group                           | Cards                                                                                                                                                                       | Where I'd start                                                                    |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **Needs me now**                   | 35 See what needs me, 8 Log in when asked, 9 Confirm or decline, 1 Approve an adapter update, 20 Approve a remote sign-in (code)                                            | A notification, then the menu bar. It should be the first thing in the window too. |
| **My shopping (Woolworths)**       | 4 Choose the store, 10 Open my trolley, 11 See today's calls, 25 See whether a site is blocking us, 3 See its tools                                                         | Window, on the Woolworths page. The trolley one from the menu bar.                 |
| **Passwords and logins**           | 5 Give it a password from 1Password, 6 Revoke a password grant, 7 Re-sync a Keychain copy, 26 Set up 1Password, 27 SMS codes                                                | Window, a "Logins" or "Passwords" section, or the Woolworths page.                 |
| **Connecting Claude**              | 16 Add Claude Desktop, 17 Reset a client's access, 18 Revoke a client, 22 See the MCP address                                                                               | Window. Setup first time, then a "Connected apps" page.                            |
| **Off switches**                   | 24 Pause all adapters, 23 Turn the MCP endpoint off                                                                                                                         | Menu bar. A single big "Pause Valet" is all I'd want.                              |
| **App settings**                   | 29 Check for updates, 30 Run setup again, 31 Reset or uninstall, 32 Open at login, 33 Notifications                                                                         | The Valet menu, then Settings (like any Mac app, Cmd-comma).                       |
| **Nick's stuff (I'd leave alone)** | 12 See why a call failed, 13 Blocked requests, 14 Verify the audit chain, 15 Export audit log, 28 Trace retention, 2 What it may reach (hosts, paths), 34 Remove an adapter | Window, ideally under an "Advanced" or "Details" heading I can ignore.             |
| **No idea**                        | 19 Turn on remote access for cloud agents, 21 Turn a tool on/off for remote clients                                                                                         | Wouldn't look. "Cloud agents" sounds like something I shouldn't turn on.           |

**R:** Sam groups by _urgency_ and _site_, not object type, and would never open "Audit log",
"Clients" or "Remote sign-in". Cards 1, 8, 9 and 20 belong in one inbox; today they're split across
the tray, chromeless windows, a banner and a sidebar page. Card 25 is "is Woolworths OK" and belongs
on the site's page.

---

## C. Cognitive walkthrough

Severity: **B** blocker (Sam stops or does the wrong thing), **Ma** major (big detour, fear,
or misunderstanding), **Mi** minor.

### S8. First launch, in depth

**Welcome (`setup-welcome.png`).** Sam reads the title and the first line, "Valet runs small
adapters for sites without a public API ... offers their tools to Claude over MCP", and stops.
Expects: "what you'll need" (1Password, 5 minutes) and a big Continue. Exists: Continue, a 6-step
sidebar, "About 5 minutes" (good), and "Skip setup" bottom left.

- Ma: the subtitle is the most jargon-dense sentence in the app (API, adapters, tools, MCP), and
  it's the first sentence Sam reads.
- Mi: the three-box diagram is good, but `woolworths_get_cart` and "manifest" in it undo that.

**1Password (`setup-onepassword.png`).** Expects: "Connect 1Password" that opens 1Password and asks
Touch ID. Exists: a card titled "Copy in your Keychain", status "Not set up", an empty text box
`my.1password.com` with a greyed-out Save, and an instruction to turn on "Integrate with other apps"
in 1Password's Developer settings.

- **B:** Sam doesn't know their "account name" (they've never looked at the top of 1Password's
  sidebar), and has never opened 1Password's Developer settings. There's no button that opens it,
  and no way to check it worked. Sam's choices are typing a guess or "Skip for now".
- Ma: the card is called "Copy in your Keychain": the password in two places sounds less safe. The
  orange "Not set up" pill on arrival reads as an error.

**Approve (`setup-approve.png`, `setup-approve-review.png`).** Expects: "Allow Claude to use
Woolworths? It can search and change your trolley. It can't pay." and Allow. Exists: a card with
a hash, monospace hosts, "3 read / 3 write / 0 irreversible", and "Review Woolworths 0.3.0…", which
opens a full-window review with 11 coloured pills ("2 login origins, 2 secret fills, 2 hand-over
domains…"), a red Reject and Approve 0.3.0.

- **Ma (near-blocker):** the step has no Approve button; a second screen titled "Review new
  adapter" does. "Am I reviewing or approving?"
- Ma: the orange and purple pills read as warnings Sam can't evaluate. "0 irreversible" in red is
  frightening although it's good news.
- Ma: Reject has equal weight to Approve, and nothing says what it does to setup.
- Mi: "Imported at 9:47 pm" and "0 files" look odd for something bundled.
- Mi: "Grant 'login' next (opens the grant sheet)": "grant sheet" means nothing to Sam. The empty
  right half of the page (`setup-approve-review-full.png`) looks half-loaded.

**Grant (`setup-grant.png`).** On first arrival without approving: a mostly blank page with one blue
line, "Approve Woolworths first: a grant is tied to the version you approved. Go to approval".

- Ma: the sidebar happily lets Sam reach steps 4 and 5 without step 3, then shows a dead end. If
  Sam used "Skip for now" on step 3, steps 4 and 5 are both blank and the whole setup ends with
  nothing working.
- After approving (code: `Setup.tsx` Grant): a row "login · Not granted. Typed only on
  auth.woolworths.com.au" and "Choose an item…". The grant sheet (`grant.png`) is the best screen
  for Sam: "The adapter can / It can't" in green and red is exactly what they want. But it opens
  with three provider radio buttons first, the "Recommended" one disabled and "Not set up", and a
  "1Password service account" preselected. Sam would ask Nick what a service account is.
- Mi: the help text under the item list is clipped by the footer (`grant.png`).

**Store (`setup-store.png`).** Expects a postcode search box. Before approval: blank plus "Approve
Woolworths first: the store is found through its tools". Sam doesn't understand why a store needs
"tools". After approval the `SettingBlock` picker shows. Mi: "Woolworths's" is a typo-looking
possessive in the lede.

**Connect Claude (`setup-clients.png`).** Expects: "Which Claude do you use?" Exists: Claude Code
(a terminal tool) first, Claude Desktop second, a lede about tokens and "Valet's bridge", and
`http://127.0.0.1:47821/mcp`.

- Ma: Sam doesn't know which Claude they have, and the lede doesn't help.
- Ma: Claude Desktop takes two clicks with near-identical labels ("Add Claude Desktop", then "Add to
  Claude Desktop", `AddToClaudeDesktop.tsx`), a JSON snippet, then "Quit and reopen". The pill says
  "Not connected yet" until Claude's first call. No "Test it" button.
- Mi: before a client is added the main button reads "Finish without a client", which sounds like
  a telling-off rather than an option.
- Mi: "changed later in the control panel": Sam doesn't know what or where that is.

**After setup (`fr-adapters.png`).** Expects "You're set up". Exists: an 8-column table, "Site
circuit breakers", charts. **Ma:** no sign it worked and no next step ("Ask Claude: what's in my
trolley?"). Orange badges on Adapters and Remote sign-in demand attention on day one.

### S1. Approve Woolworths 0.4.0 from the adapter page (`adapter-wow.png`)

Sam looks for an "Update" or "Review" button at the top. The blue pill "0.4.0 waiting for review"
_is_ a link (`AdapterDetail.tsx:111`), but it looks exactly like the static "Approved" pill beside
it, and the only header button is "All activity". Sam scrolls and gives up. **Ma** (Nick's failure:
discoverable only by accident). On the list (`adapters.png`) the "0.4.0 to review" pill is _not_ a
link (`Adapters.tsx:185`); only the banner's "Review changes" works. In `review.png` Sam ticks "I've
read the highlighted additions" without reading the JSON diff, so the checkbox is theatre for this
persona. The real risk ("New host… including your session cookies") needs Sam's words: "Woolworths
will also be able to talk to Everyday Rewards".

### S2. "Valet needs you to log in to Woolworths"

Sam opens the menu bar (`tray.png`): "Needs you 3", but only one row is visible, and it's clipped
mid-row ("Log in to Woolworths … Open"). The other two are hidden under the Adapters section with no
visible scroll. **Ma.** Clicking Open gives the hand-off window (`needs-user.png`): an orange banner
with chips `login.username` `login.password`, "nothing is marked inside the page, where the site
could fake it", and the site below it (blank in this capture). **Ma:** Sam doesn't know whether to press
"I'm done" before or after solving the check, "Give up" sounds final, and "Closes in 4:00" doesn't
say what happens then.

### S3. Confirm removing an item (`confirm.png`)

The title is good. But the sentence Sam needs, "Remove Cavendish Bananas (2 × $0.79) from the
trolley?", is greyed out in a dashed box labelled "Not verified by Valet", below five ticks about
manifests and `POST /api/v3/ui/trolley/update`. What _is_ verified, `{ "stockcode": 133211 }`, means
nothing to Sam. **Ma.** Decline has focus and Return declines (`Confirmation.tsx`): safe, but Sam
presses Return meaning "yes" and is surprised. **Mi.** The window is far bigger than its content.

### S4. Why did get_cart fail?

Activity rows (`activity.png`) are plain English and are links (`Activity.tsx:144`), with no visual
hint. The trace (`activity-call.png`) is developer timing. **Ma:** no one-line "What went wrong:
Woolworths asked for a verification check" at the top. The sidebar "Recent" list uses raw tool
names in monospace, unlike the main list.

### S5. Connect Claude Desktop

Sam goes to "Clients" (would never guess it's called that). The page is titled "Clients and
settings" (`clients.png`). "Settings" in the sidebar opens the same page with the columns swapped
(`settings.png`). **Ma** (two menu items, one page). "Add a client…" isn't "Connect Claude Desktop".
The row actions "Set up / Reset access / Revoke" are grey text with no button look. Sam isn't sure
they're clickable, and fears Revoke.

### S6, S9, S10 (outside Sam's role)

S6: Sam would ask Nick. If forced, Clients then "Revoke", which sits beside "Reset access" with the
difference explained only in a paragraph at the bottom. **Mi.** S9: "no idea" pile, but the orange
badge on "Remote sign-in" pulls Sam in to a security warning (`remote.png`). **Ma** (fear). S10:
"Audit chain intact" in the footer reassures without meaning anything. The Audit log (`audit.png`)
is JSON and hashes. Fine, as long as it stays out of Sam's path.

### S7. Woolworths seems to be blocking us

The tray's "Blocked by site · retry in 4 min" (`tray.png`) is clear. The window's "Site circuit
breakers" card says "Open · 3:58" in red and "Closed" in green. **Ma:** Sam reads it backwards ("the
shop is open"). Nothing says what to do (nothing: wait).

### Sam-specific scenarios

**SS1. "Is it working?" (a week later).** The tray says "Running" in green, Woolworths says "Login
window open" in orange, and the stats have red bars. No single "Woolworths: ready" line, and the
Woolworths row isn't clickable (`TrayPopover.tsx` `AdapterRow` is a div). **Ma.**

**SS2. Check the trolley.** The tray's "Check out on woolworths.com.au…" opens the browser, but Sam
reads "check out" as "pay now" and won't click it. Better: "Open my trolley on woolworths.com.au".
**Ma** (fear of spending).

**SS3. "Did I break it?" after clicking Skip.** Sam skipped the 1Password step and the approval.
Nothing on the Adapters page says "Setup isn't finished: 2 steps left". The only route back is a
small blue "Run setup again" in the footer, which sounds like starting over. **Ma.**

---

## D. Looks interactive but isn't / should be interactive / layout oddities

Looks clickable, isn't (checked in code):

- Adapters list pills "0.4.0 to review", "Needs you", "Blocked by site", "login · not granted"
  (`adapters.png`, `Adapters.tsx`): each names a job and does nothing.
- Tray adapter rows and their state text (`tray.png`); tray stat tiles (37 / 3 / 12), which look
  like buttons and don't open Activity.
- The 11 "What it asks for" pills on the review (`fr-review.png`).
- Orange credential rows on the Adapters page ("1Password app · not set up", `fr-adapters.png`).
- Footer "MCP on" and "Audit chain intact".

Clickable, doesn't look it: the "0.4.0 waiting for review" pill on the adapter page; whole Activity
rows; "Set up / Reset access / Revoke" on Clients (grey text); tool names in Recent runs (blue
monospace reads as code).

Layout oddities: confirmation and hand-off windows mostly empty grey (`confirm-full.png`,
`needs-user-full.png`); setup steps 4 and 5 80% blank before approval; review page's right column a
single box over a big gap; Clients and Settings are the same page with columns swapped; tray "Needs
you" cut off mid-row and "waiting for revie" truncated (`fr-tray.png`); "Sites" duplicates
"Adapters" in the sidebar; `adapter-yahoo.png` is a near-empty page saying "No adapter with that id
is installed"; double-clicking a pill selects its text like a web page.

---

## E. Summary

**Top 5 pain points (ranked)**

1. The 1Password step asks for an account name and a hidden developer setting, with no button to
   connect and no way to check it worked (blocker for setup without Nick).
2. Approval is buried behind a second "Review" screen full of jargon pills, with a red Reject next
   to Approve and nothing that says it's safe for a bundled adapter.
3. No "you're done, it works, try this" moment at the end of setup, and the post-setup dashboard
   (charts, breakers, hashes, orange badges) reads as a list of problems.
4. The confirmation dialog hides the human sentence ("Remove bananas?") under "Not verified by
   Valet" and leads with code, so Sam can't tell what they're agreeing to.
5. Things that say "needs you" (pills, tray rows, badges) don't take you anywhere, and the one that
   does (the pill on the adapter page) doesn't look clickable.

**Top 5 needs**

1. One "Needs you" inbox, the same in the menu bar, the window and notifications, where every item
   opens its exact action.
2. Plain words: Woolworths not adapter, Claude not client, "Allow login" not grant, "blocked for
   now, try again at 9:52" not "breaker open".
3. A single health line per site: "Woolworths: ready", "Woolworths: needs you to log in".
4. Setup that only lets me move forward when the step worked, shows a real test at the end, and
   tells me which Claude I have.
5. Reassurance about money everywhere it matters: "Valet never pays. Checkout happens on
   woolworths.com.au, by you."

**Quotes**

- "I wanted to connect 1Password and it asked me for an account name I've never seen."
- "Is 'Reject' going to break the setup? Is 'Approve' going to let it spend money? I just want to
  know what it can't do."
- "Open means blocked and closed means fine? That's backwards."
- "It says 'Not verified by Valet' right over the only sentence I understood."
- "I quit Claude and opened it again like it said. Did it work or not? Nothing tells me."

**Sam's ideal top-level navigation**

1. **Needs you** (badge, opens by default when anything waits)
2. **Woolworths** (one page per site: status, store, trolley link, login, "what it can and can't do")
3. **Connected apps** (Claude Desktop, Claude Code: connect, test, disconnect)
4. **Passwords** (1Password, which logins each site may use)
5. **History** (plain-English activity; the audit log under it, for Nick)
6. **Settings** (start at login, notifications, updates, run setup, and an "Advanced" area for
   remote access, the MCP address and trace retention)
