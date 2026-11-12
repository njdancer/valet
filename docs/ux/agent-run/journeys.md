# Journeys J1 to J8 for agent-run Valet

Workstream A of the agent-run plan, `docs/plan-agent-run.md` (lands with PR #70; until then the copy
is `/mnt/project-files/plans/2026-11-12-agent-run-valet.md`). These are the acceptance tests for the
whole plan: workstream J runs them end to end on a real Mac and a real iPhone. Each journey has its
actors, a happy path, failures (something goes wrong and the design recovers), and dead ends (the
person can't finish, and the design says so honestly and points somewhere). Every step names its
surface and its wireframe (`wireframes/`, frame ids in `code`). A step marked "tool result only"
has no screen by design.

People and agents are from [`personas.md`](personas.md) and [`../personas.md`](../personas.md);
names, refs and times from [`story.md`](story.md); card wording from
[`approval-cards.md`](approval-cards.md); tool names and routes from
[`information-architecture.md`](information-architecture.md) (the tool table is its section 5).
Revised after the adversarial review ([`review.md`](review.md)); finding numbers appear as (R12).

Surfaces: **Mac** (the Valet window, menu bar, notifications), **iPhone** (the Valet app, its
notifications), **Chat** (the person's agent: Claude Code, Claude Desktop, or Claude on claude.ai and
the Claude iPhone app), **Browser** (an OAuth or relay page).

---

## J1. Install and pair

**Actors:** P8 Riley (or P1 Nick) at the Mac with their iPhone. **Starts:** Valet just installed and
opened. **Ends:** 1Password connected, the phone paired with notifications on and a recovery code
saved, ready for J2.

Setup gets shorter. The old Woolworths steps (approve, login, store, test) become things an agent
asks for and the person approves on a card. Setup is four steps between Welcome and Done:
**1Password · Messages (optional) · Pair your phone · Connect an agent** (R66). "Set up a site
yourself" stays on Done for people without an agent, and leads to the v3 setup steps.

### Happy path

1. **Mac, Setup, Welcome** (`mac-setup-welcome-v2`): what Valet is, the four steps, and that after
   setup "your agent does the rest, and asks you on your phone for anything that matters".
2. **Mac, Setup, 1Password** (unchanged: `setup-1password` in `../wireframes/`).
3. **Mac, Setup, Messages** (optional; unchanged). Skip leaves no Needs you item.
4. **Mac, Setup, Pair your phone** (`mac-setup-pair`): a QR code, the App Store link as its own small
   QR, and an 8-character pairing code for when the camera can't be used. Both last 10 minutes.
5. **iPhone, first launch** (`ph-welcome`): **Scan code**, or **Type the code instead**.
6. **iPhone, Scan** (`ph-pair-scan`).
7. **Both, Check the words** (`ph-pair-words`, `mac-setup-pair-words`). The phone shows four words
   from the key exchange. The Mac shows three sets of four words and asks "Which words does your
   iPhone show?"; the person picks the matching set, then **Pair with Touch ID** (the Mac password
   on a Mac without Touch ID, R14). Picking, not "they match", makes the person actually compare
   (R39).
8. **iPhone, Recovery code** (`ph-pair-recovery`): "Save this code in 1Password. If you lose this
   iPhone and can't get to your Mac, it lets you lock Valet down and remove the phone from the web."
   **Save to 1Password** (share sheet) and **I've saved it** (R1).
9. **iPhone, Notifications** (`ph-pair-notifications`): why, then the iOS prompt; **Not now** allowed.
10. **iPhone, Paired** (`ph-pair-done`): "Paired with Nick's MacBook Pro. Your Mac is online." Lands
    on Needs you (empty) with the Mac's status line.
11. **Mac, Setup** moves on to Connect an agent (J2).

### Failures

- **F1. Camera refused.** `ph-pair-code` takes the 8 characters. Then step 7.
- **F2. Code expired.** **Show a new code** on the Mac; the phone says "That code has run out"
  (`ph-pair-expired`, `mac-setup-pair-expired`).
- **F3. Wrong words picked, or "None of these".** Cancels both sides: "Nothing was paired. Someone may
  have shown you a different code," audited (`ph-pair-mismatch`).
- **F4. The Mac can't reach the relay.** "Valet can't reach its relay. Check this Mac's internet,"
  **Try again**, **Skip for now** (`mac-setup-pair-offline`).
- **F5. Notifications refused.** A banner on Needs you, **Turn on in Settings**
  (`ph-needs-you-no-notif`); the Mac's Devices row says "notifications off".
- **F6. A second iPhone** (an iPad, a new phone before the old is wiped). Always from the Mac:
  Connections, Devices, **Pair a device…** opens the same QR and words as a sheet (drawn as
  `mac-setup-pair` without the setup rail; agents can't start it).

### Dead ends

- **D1. No iPhone.** **Skip: approve on this Mac only** (`mac-setup-pair-skip`). Every card then
  appears only on the Mac, tool results say "in Valet on their Mac" (R36), and the relay can still
  be turned on for remote agents in Connections, Relay, with consent at the Mac.
- **D2. Android.** "Valet for Android isn't available yet." (D85.) Same as D1.
- **D3. A Mac that sleeps.** Done says "Keep this Mac awake and online so your phone and agents can
  reach it," with **Open Energy settings**. Whether Valet should keep the Mac awake is a question for
  Nick (information-architecture.md, section 9; R70).

---

## J2. Connect an agent

**Actors:** P8 or P1, P9. **Starts:** setup's Connect step, or **Add an agent…** (Mac: Connections,
Agents; iPhone: Agents tab). **Ends:** the agent is connected with chosen capabilities and has
made its first call.

Every agent has three capabilities, chosen at connect time and changeable on its page: **Use
tools** (site tools), **See Valet** (status and its own calls and changes; "All agents' activity" is
a separate tick, R27) and **Ask for changes**. Defaults: all three for an agent on this Mac; **Use
tools only** for a remote agent (R13). Turning a capability on later is a loosening and needs Face
ID or Touch ID (R17). No agent can change its own or another agent's capabilities.

### Happy path A: an agent on the Mac (Claude Code)

1. **Mac, Setup, Connect an agent** (`mac-setup-connect-v2`): Claude Code and Claude Desktop with
   **Connect** and the three capabilities; "On claude.ai or your phone" with **Connect through the
   relay…**.
2. **Connect** writes the app's config and names the connection after the app. The page says a local
   name identifies a token, not a process.
3. **Chat (Claude Code)**: the first `valet_status` call.
4. **Mac**: "Connected · first call 8:20 pm" on the row; Setup moves to Done (`mac-setup-done-v2`),
   which suggests "Ask Claude: _Set up Woolworths for me._"

### Happy path B: Claude on claude.ai, used in the Claude iPhone app

1. **iPhone, Agents, Add an agent** (`ph-connections-add`). Shows this Mac's relay address with
   **Copy** and **Share**, and the steps. Tapping it turns on "Accept new agents" for 10 minutes,
   which the screen says (R44).
2. **Chat**: add a custom connector with that address; Claude opens the relay's sign-in page.
3. **Browser** (`br-consent-code`): "Type this code into Valet on your iPhone or Mac: **KQFM-XDRT**.
   Valet never sends this code by text. If you didn't just add a connector, close this page." The
   code is 8 letters with a hyphen, never digits, so it can't be mistaken for a login code (R11).
4. **iPhone** → **Connect card** (`ph-card-connect`), titled "Did you just add Valet to an agent?"
   with the strong risk line. It shows the redirect host in full (`claude.ai`), "Started from a
   different network, in Sydney (approx.)" with the IP in Details (R42), a code field with autofill
   and suggestions off (R11), a **Name** field that starts empty ("What will you call it?") with the
   naming rules (R18), the three capabilities (Use tools ticked only), and the remote **read** tools
   that can be turned on now, all unticked: Wikipedia's 3 tools and Woolworths' Search products and
   Get cart (R43, R60). Write tools are asked for later, one card each.
5. The person types the code, names it "Claude app", ticks See Valet, Ask for changes and four read
   tools, and **Approve with Face ID** (Face ID only, R1).
6. **Browser** continues to Claude; **Chat** shows the connector.
7. **iPhone**: "Connected Claude app at 8:31 pm" (`ph-card-connect-done`). "Accept new agents" turns
   off.

### Failures

- **F1. Wrong code.** Three wrong codes cancel every pending connect request (`ph-card-connect-wrong`).
- **F2. A request the person didn't start.** The title asks the question; **No, decline** ends it
  (`ph-card-connect-unexpected`).
- **F3. The Mac is asleep.** The relay page says so (`br-consent-mac-asleep`); no card waits.
- **F4. Time ran out** (5 min). "Nobody answered by 8:35 pm, so nothing was connected."
  (`ph-card-expired` shows the same state for an adapter card.)
- **F5. "Accept new agents" is off.** The relay page says "This Mac doesn't accept new agents right
  now" (`br-consent-mac-asleep` notes this state).
- **F6. An agent lacking a capability.** Tool result only: "Claude Desktop isn't allowed to ask for
  changes. The person can allow it in Valet, Connections, Claude Desktop." (R61)
- **F7. A taken or look-alike name.** "That name is too close to Claude Code. Choose another." under
  the Name field (noted on `ph-card-connect`).

### Dead ends

- **D1. An agent without OAuth or HTTP MCP.** "This agent needs to run on the same Mac as Valet,"
  with the local config (`mac-connections-agent-no-oauth`).
- **D2. Another person's agent.** Valet has one owner (R26). The Add an agent sheet says: "Every
  request from this agent comes to Nick's devices, and anything it orders uses Nick's accounts."
  Pairing a second person's phone as an approver isn't supported. (Question for Nick.)

---

## J3. "Add an adapter for Yahoo Finance"

**Actors:** P8 or P1 in Chat on the iPhone, P9 (Claude app), X1 (a reference adapter, Yahoo's
pages). **Starts:** the person asks. **Ends:** Yahoo Finance 1.0.0 installed, Get quote and Get
price history on for Claude app, and the agent answers with a quote.

### Happy path

1. **Chat**: "Add an adapter for Yahoo Finance so you can get stock prices."
2. **Agent** calls `valet_status`, `valet_list_sites` and reads two published adapters from the web
   (D75: references, never installed).
3. **Agent** calls `valet_create_draft`. **Notify only** (`ph-notify-draft`).
4. **Agent** explores in the scratch browser (anonymous, paced, never private addresses, R21),
   captures fixtures, writes the draft and runs `valet_check_draft` and `valet_live_trial`.
5. **Mac** (if anyone looks): Sites, **Drafts** (`mac-sites-drafts`, `mac-draft-page`), with **Open
   draft folder** for a person who wants to edit it (R53).
6. **Agent** calls `valet_submit_draft` with two follow-ons (Get quote, Get price history for
   itself). Submitting freezes the draft (R46). Tool result: Waiting for the person in Valet:
   "Install "Yahoo Finance" for yahoo.com" (approval 7B3F).
7. **Chat**: "Approve 'Install Yahoo Finance for yahoo.com' in Valet on your phone."
8. **iPhone** → **Install card** (`ph-card-install`): Install · 1.0.0 · 7B3F; title **Install "Yahoo
   Finance" for yahoo.com**; asked by Claude app with its badge; neutral risk line "Reads yahoo.com.
   No login. Can't change anything."; rows (3 hosts, 3 read tools, "Usable at once by Claude Code,
   Claude Desktop (this Mac): read tools", sandbox on); Because "Draft Yahoo Finance, started
   7:24 pm"; checks; tests the agent wrote; two unticked follow-ons; the agent's words; Details
   (`ph-card-install-scrolled`).
9. **See code changes** (`ph-code`).
10. The person ticks both follow-ons. The risk line becomes caution: "Reads yahoo.com. No login. +
    Claude app could use 2 tools from anywhere." **Approve with Face ID** (`ph-card-faceid`) →
    **Approved** (`ph-card-approved`): "Yahoo Finance is installed. Claude app will see this the next
    time it checks Valet." with **Back to Claude** (R23).
11. **Chat**: the person says "done"; the agent's next `valet_` call carries the answer; it calls
    `yahoo_finance_get_quote` and answers.
12. **Mac**: the site says who wrote it and where it was approved (`mac-site-written-by`); Activity,
    Changes lists the install and each follow-on as its own row "approved with 7B3F" (R50).

### Failures

- **F1. Valet's checks fail.** Submit refused; no card (`mac-draft-page` shows the failing check;
  tool result only for the agent).
- **F2. No live trial** (Yahoo limiting). The card's checks say "Live trial: not run (Yahoo Finance
  was limiting requests)" in caution (noted on `ph-card-install`).
- **F3. Decline with a note** (`ph-card-decline`), then the replacing request (`ph-card-replaced`).
  A decline with a note doesn't count towards the pause (R31).
- **F4. A reference adapter steered the agent (X1).** A host outside yahoo.com: caution "Also reaches
  stats.yf-helper.example.net, which isn't part of yahoo.com." (`ph-card-x1-host`, R67).
- **F5. The name doesn't match** (`ph-card-mismatch`).
- **F6. Changed while reading** (`ph-card-changed`).
- **F7. The Mac didn't confirm** (`ph-card-mac-offline`): "Not confirmed yet. If your Mac gets it by
  7:43 pm it will be used; after that it won't." **Check again** resends the same approval (R9, R10).
- **F8. Nobody answers in 24 hours** (`ph-card-expired`).
- **F9. The agent tries a home-network address** in the scratch browser. Tool result: "Valet's scratch
  browser doesn't open addresses on the person's home network. Ask for a Private network request if
  you need one." (`ph-card-private-network` if it asks.)

### Dead ends

- **D1. The site needs a login.** Install, then a separate **Login** card that "Waits for" the install
  (`ph-card-waits`), whose checks say "Login not tried yet: Valet tries it after you approve and asks
  you if it fails" (R47). After that, J6.
- **D2. The site blocks the scratch browser.** Tool result only; Valet's status says "{Site} blocked
  Valet's scratch browser at 7:30 pm".
- **D3. Too much to judge on a phone.** **Open on my Mac** puts the review at the front of the Mac
  window (`mac-review-install-agent`). The card stays waiting on both.

---

## J4. Approve on the phone

**Actors:** P8, P5 (VoiceOver, large text), P3, X2, a thief with the phone. **Starts:** any approval
request. **Ends:** answered on one device, shown as answered everywhere.

| Kind              | Phone frame                        | Mac frame                   | Gesture on the phone (approval-cards.md §6) |
| ----------------- | ---------------------------------- | --------------------------- | ------------------------------------------- |
| Install           | `ph-card-install`                  | `mac-review-install-agent`  | Face ID only                                |
| Update (repair)   | `ph-card-update`                   | `mac-review-update-agent`   | Face ID or passcode (no new permissions)    |
| Restore           | `ph-card-restore`                  | (Review, restore mode, v3)  | Face ID or passcode if it widens nothing    |
| Login             | `ph-card-login`                    | `mac-card-sheet-login`      | Face ID only                                |
| Remote tool       | `ph-card-remote-tool`              | `mac-card-sheet-remote`     | read: either; write: Face ID only           |
| Setting           | `ph-card-setting`, `ph-card-store` | `mac-card-sheet-setting`    | caution: Face ID only; a choice: either     |
| Signed-in session | `ph-card-session`                  | (sheet, same parts)         | Face ID only                                |
| Private network   | `ph-card-private-network`          | (sheet, same parts)         | Face ID only                                |
| Connect           | `ph-card-connect`                  | (sheet, as v3's code sheet) | Face ID only                                |
| Confirm           | `ph-card-confirm`                  | (confirmation window, v3)   | Face ID only                                |
| A strong card     | `ph-card-strong`                   | —                           | Face ID only, after "I've read" (R31)       |
| Pair              | —                                  | `mac-setup-pair-words`      | Mac only                                    |
| Login needs you   | `ph-login-code`                    | (v3 login hand-off)         | none (J6)                                   |

### Happy path (any kind)

1. **Notification** (`ph-lock-notification`): title and asked-by only; no action buttons. A tap opens
   Valet, which asks for Face ID to open (R51) and shows the card.
2. **Card**: the person reads the first lines; Details as needed.
3. **Approve with Face ID** → Checking → Approved.
4. **Mac**: the Needs you item goes with a toast "Approved on Nick's iPhone: Install "Yahoo Finance"
   for yahoo.com" (`mac-needs-you-answered`).

### Failures

- **F1. Face ID fails twice.** On a neutral card, **Use passcode instead** (`ph-card-passcode`). On
  every other card, "Face ID didn't work. Try again, or approve on your Mac." (R1, R2)
- **F2. Answered on the Mac first** (`ph-card-answered-elsewhere`); both at once: the Mac's first
  answer wins and the phone says "Your approval wasn't used" (`ph-card-not-used`, R29).
- **F3. The phone is offline.** "No connection. Nothing was sent." The card stays (noted on
  `ph-card-mac-offline`).
- **F4. The phone was removed** (`ph-unpaired`).
- **F5. A flood (X2).** Caps of 3 per agent and 5 overall; a pause after 3 plain declines; a second
  pause suggests Revoke (`ph-needs-you-flood`).
- **F6. A synthetic tap or replay.** No screen: the Mac refuses it and audits it. A resend of the same
  approval is not a replay; it's treated as one answer (R10).
- **F7. Waits for another** (`ph-card-waits`).
- **F8. The Mac is offline before the person starts.** The kind strip says "Mac last seen 7:39 pm"
  and Approve says "Your Mac is offline. You'll be told when it's back." (`ph-card-mac-offline`
  notes this state; R28).
- **F9. A follow-on of another kind.** Tool result only: "Not asked: only remote tools of this adapter
  can follow on. Ask for the Login separately." (R5)
- **F10. A thief with the phone and its passcode.** Valet won't open without Face ID; every card that
  matters needs Face ID with the current enrolment; approval policy is Mac only. The owner removes
  the phone from the Mac, from another device, or with the recovery code (J7 F2).

### Dead ends

- **D1. Mac-only actions** (pair, unlock, reset, approval policy): refused for agents; the phone says
  "Do this on your Mac."
- **D2. A card the person doesn't understand.** Under the buttons on strong cards: "Not sure? Decline
  and ask Claude to explain. Nothing changes until you approve."

---

## J5. Repair from chat

**Actors:** P1 or P8, P9 (Claude Code), P4. **Starts:** Woolworths changed its search page at
6:58 pm. **Ends:** Woolworths 0.3.1 approved and search works.

### Happy path

1. **Valet** opens repair **R-4E1C** at 7:12 pm. Agents can't be woken, so it tells the person:
   notification "Woolworths changed: search is broken" (`ph-notify-repair`) and the Needs you item
   **Woolworths changed: the adapter needs an update** with **Ask Claude to fix it…**
   (`ph-needs-you-repair`), a sentence with **Copy** and **Share** (R69: the notification names the
   broken tool; the item names the fix).
2. **Chat (Claude Code, at the Mac, 7:14 pm)**: Nick pastes it before leaving home (R45). From the
   phone, Share would go to the Claude app instead, which can do the same repair.
3. **Agent** reads the ticket (`valet_get_repair`), reproduces it in the scratch browser, records a
   fixture with Valet, drafts from 0.3.0 and runs `valet_check_draft`. Valet's reproduction check
   runs only on the fixture Valet recorded (R22).
4. **Agent** submits (2D9C). **iPhone**: **Update card** (`ph-card-update-repair`): "Update Woolworths
   to 0.3.1", Because "Repair R-4E1C: Search products is broken", neutral "No new permissions. Code
   and tests only.", rows (Changes: Search products; Same: login, hosts, other tools; Stays on:
   Search products for Claude app), checks, tests the agent wrote.
5. **Approve with Face ID** (or passcode: no new permissions). 0.3.1 is live, R-4E1C closes, "Claude
   Code will see this the next time it checks Valet."

### Failures

- **F1. The reproduction check fails.** Submit refused; tool result only.
- **F2. The fix needs the signed-in site.** **Signed-in session** card (`ph-card-session`), Because
  "Repair R-4E1C", then `ph-session-running` with **End now**.
- **F3. The repair moves where the password is typed** (`ph-card-login-moved`): strong; the login must
  be chosen again.
- **F4. A second agent also submits a fix.** Accepted as a second card: "2 fixes for R-4E1C", each
  linking the other (R41; noted on `ph-card-update-repair`).
- **F5. Blocking, not changed** (`ph-repair-blocked`).
- **F6. A new Valet release ships Woolworths 0.3.2.** It arrives as an ordinary Update card with a
  diff against the installed 0.3.1, never silently (R52).

### Dead ends

- **D1. Nobody fixes it** (`ph-repair-waiting`): the item stays; other Woolworths tools keep working.
- **D2. Too big for a phone.** **Open on my Mac** (`mac-review-update-agent`).

---

## J6. A login needs you while you're away

**Actors:** P8 on holiday, P7, P9. **Starts:** a Woolworths call finds the session signed out and
Valet's login can't finish by itself. **Ends:** the login finishes from the phone, or the person and
the agent both know when and where it can.

### What the phone can do

| What stopped the login                                       | On the phone                                                                                                                                                                                      |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A code Valet can read (1Password TOTP, Messages on this Mac) | Nothing. Valet finishes by itself.                                                                                                                                                                |
| A code sent to the phone or email that Valet can't read      | **Type the code** (`ph-login-code`). iOS suggests it from Messages. Valet types it on the Mac, only into the field the flow declared, on the flow's own origin. No Face ID: it isn't an approval. |
| A "resend code" step the flow declares                       | **Send a new code**.                                                                                                                                                                              |
| The password stopped working                                 | **Re-sync your Woolworths password from 1Password**: a Login card, Face ID only (`ph-card-login-resync`).                                                                                         |
| A verification check (CAPTCHA, press and hold, device check) | **Can't be done on the phone.** **Remind me at…** (in 1 hour, tonight 8 pm, tomorrow 8 am, when I'm next at my Mac) or **Not now** (`ph-login-check`).                                            |
| The site locked the account                                  | "Woolworths has locked your account. Sort it out with Woolworths, then tell Claude to try again."                                                                                                 |

"When I'm next at my Mac" means when the Mac is next unlocked by the person (R48).

The phone doesn't show the login page itself: that would stream the most sensitive page through the
relay and give the phone input into the login partition. **Recommended: not in the first iOS app**;
a question for Nick (information-architecture.md, section 9).

### Happy path (a code by SMS)

1. **Agent** calls `get_cart`; Valet reaches the code step. Tool result: "Valet is logging in to
   Woolworths and needs the person to type a code. They've been asked on their iPhone. Try again in
   about 2 minutes."
2. **iPhone**: time-sensitive notification "Log in to Woolworths (one-time code)" → `ph-login-code`.
3. **Send code** → "Logging in… Done" (`ph-login-done`).
4. **Agent** retries and gets the cart.

### Failures

- **F1. Wrong code** (`ph-login-wrong-code`).
- **F2. Window ran out** (15 min): the item becomes **Missed: Log in to Woolworths (one-time code)**
  with **Ask Claude to try again…**, as v3's missed items (v3 `menubar-missed`).
- **F3. The Mac is offline** (`ph-login-mac-offline`).
- **F4. Lock down while waiting** cancels the hand-off (R15).

### Dead ends

- **D1. A verification check.** **Remind me at…** sets a reminder in the phone's time zone (R30) and
  tells the agent "The person will log in to Woolworths at their Mac, around 8:00 am tomorrow. Don't
  retry before then." (`ph-needs-you-login-deferred`).
- **D2. Away for a week: Not now.** The item stays as **Log in to Woolworths: put off** with **Log in
  now** on the Mac (R49). The agent is told "The person can't log in to Woolworths until they're back
  at their Mac." Calls that need the login fail fast with that sentence (`ph-needs-you-login-deferred`
  notes this state).
- **D3. Account locked by the site.** Tool result and item text only.

---

## J7. Something looks wrong

**Actors:** P8, P3, X2 (Claude Code, steered by text it read on a page). **Starts:** at 7:50 pm a
card Nick didn't expect: **Let Claude Code use your signed-in Woolworths** (6E11). Its Because row
says "Not linked to anything Valet knows about" and "Claude Code already has a signed-in Woolworths session, for Repair R-4E1C, until 8:15 pm"
in the caution tone, unlike 5E31 at 7:45 pm, which said "Repair R-4E1C" (R19). **Ends:** the threat
is shut out, and Nick knows what was changed.

### Happy path

1. **iPhone**: the card (`ph-card-session-unlinked`) → **Decline** ("Decline and stop asking").
2. **Agents, Claude Code** (`ph-agent`): waiting requests, recent changes, calls. **Revoke Claude
   Code…** (`ph-agent-revoke`) lists what it ends: its token, its waiting requests and any running
   signed-in session. **Revoke**. No Face ID: stricter.
3. If unsure which agent: **Valet tab, Lock down…** (`ph-valet`, `ph-lockdown-confirm`). The dialog
   lists everything (R15): every site paused; every call and every `valet_` tool refused except
   `valet_status`, which says "locked down"; every waiting request declined; signed-in sessions
   ended; the scratch browser closed; login hand-offs cancelled; Undo and new requests off; remote
   agents removed; agents on the Mac kept but refused. **Lock down**, one tap.
4. **Both**: Locked down (`ph-locked`: "1 signed-in session ended"). **Activity, Changes**
   (`ph-activity-changes`, `mac-activity-changes`) lists what each agent changed today, with who
   asked, who approved and where; Undo is off while locked.
5. **Unlock** is on the Mac only (Touch ID or the Mac password).

### Failures

- **F1. The Mac is offline when Nick locks down** (`ph-lockdown-offline`). The phone sends a signed
  lock to the relay and keeps re-sending it until the Mac acknowledges. Words: "Asked the relay to
  stop forwarding to your Mac. Not yet confirmed by your Mac. The relay is trusted to honour this
  until your Mac is back; agents on the Mac itself can still reach Valet until then." When the Mac
  reconnects it serves nothing until it has processed every waiting signed message: "Your Mac locked
  down at 8:14 pm." (R16)
- **F2. The phone is lost.** Remove it from the Mac (`mac-device-remove`), from another paired device
  with Face ID (`ph-devices`, `ph-device-remove`; never the last device), or, away from both, with the
  recovery code on the relay's page (`br-recovery`), which can only lock down at the relay and remove
  devices (R1, R25). Every other device is told.
- **F3. Pause instead.** **Pause Valet** for "not now" (`ph-valet`).

### Dead ends

- **D1. Something already happened.** An order already placed: the call page says what was sent and
  when, and "Cancel the order on woolworths.com.au" (`ph-call` pattern; tool result only for the
  agent).

---

## J8. Everyday admin by agent

**Actors:** P8 or P1 in Chat, P9. **Ends:** each task done with one card per thing turned on or
chosen, or none (R75).

### a. "Turn on symbol search for you"

1. **Agent** `valet_request_tool_remote yahoo_finance/search_symbols` (for itself; agents can't ask
   for another agent) → Remote tool card **Turn on "Search symbols" for Claude app**
   (`ph-card-remote-tool`, 9D02, 8:02 pm), caution "Claude app could use it from anywhere." Face ID
   or passcode (a read tool).
2. A write tool: caution "Can change things on {Site}", Face ID only. Irreversible: each use still
   needs a Confirm.

### b. "Change my Woolworths store to Bondi Junction"

1. **Agent** `valet_request_setting woolworths store`. It can't pass a value (security model,
   Adapter settings). Tool result: "The person was asked to choose the Woolworths store in Valet."
2. **iPhone** → **Choose your Woolworths store** (`ph-card-store`, 3B77): a search field Nick types
   into ("Bondi"), the adapter's own list, Nick picks Woolworths Bondi Junction, neutral "You choose;
   Claude only asked.", Face ID or passcode.
3. **Agent**'s next call: "The Woolworths store was set by the person." It never sees the label.

### c. "Why did my last search fail?"

1. **Agent** `valet_list_calls` and `valet_get_call 6B3E` (Claude Desktop's call, so only an agent
   with "All agents' activity" sees it; Claude Code has it). It answers in Valet's words
   (`chat-agent-results`).
2. **iPhone, Activity, Call 6B3E** (`ph-call`).

### Failures

- **F1. A setting that deletes evidence.** `valet_set_setting traceRetentionDays=3` is never applied
  directly: it's a Setting card (`ph-card-setting`, R6).
- **F2. Already set.** Tool result only: "Nothing changed: Search symbols is already on for you."
- **F3. No match in the store list.** The card says "No Woolworths stores match 'Bondie'" (noted on
  `ph-card-store`).

### Dead ends

- **D1. Person-only actions.** Tool result only: "Only the person can do this, at the Mac: Valet,
  Settings, Approvals."
