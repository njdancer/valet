# Interview: P6, Claude the calling agent

Simulated interview, 2026-11-11. The interviewee is an MCP client (Claude) that has Valet connected
and has shopped at Woolworths through it. It never sees the app. Everything below is grounded in
what the agent actually receives: `SERVER_INSTRUCTIONS` and `IRREVERSIBLE_NOTE` in
`packages/mcp-server/src/server.ts`, the result templates in `packages/mcp-server/src/results.ts`,
the paused refusal in `apps/desktop/src/main/core/caller.ts`, the OAuth pages in
`packages/mcp-server/src/oauth-pages.ts`, and the human side in `apps/desktop/src/renderer/`
(`lib/wording.ts`, `lib/routes.ts`, `tray/TrayPopover.tsx`), `main/core/notifications.ts` and the
screenshots in `research/current-screens/`.

## A. Interview

**What are you trying to do when you call Valet?**

"Finish the person's task: find bananas, put two in the trolley, tell them the total. Valet is a
means to that. I'd like to spend as little of their attention as possible, but when I do need them I
want to spend it well: one sentence, one place to go, one thing to do."

**What are you told up front?**

"Six bullet points of server instructions. They are good. They tell me calls are slow and serial,
not to repeat a write that timed out, what 'Try again in N seconds' means, what 'Valet is logging in
to the site first' means, and that 'The person has been asked to act in the Valet app' means only
they can continue. Irreversible tools carry a fixed line: 'The person must confirm this action in
the Valet app before it runs. You cannot confirm it for them.' That last one is the most useful
sentence in the whole contract, because it tells me before I call that a human will be pulled in,
so I can warn them first."

**How do you decide between waiting, retrying and handing to the person?**

"I sort results into three buckets by their wording:

1. _Wait and retry myself_: 'Try again in N seconds', 'was not started and nothing was sent',
   'Valet is logging in to the site first ... Call it again in N seconds'. I don't bother the person.
2. _Hand to the person_: 'Not done yet: the person has been asked to act in the Valet app (reason:
   otp-required)' and the setting-required variant. I tell them and wait for them to tell me.
3. _Give up and explain_: 'The tool failed at stage X: Y' and 'The person did not approve this
   action in the Valet app (stage confirm: declined)'.

The trouble is that bucket 3 is a bag of codes. 'The tool failed at stage config: unavailable' is
what I get when the person paused Valet. Nothing in that string says 'paused', so I can't tell them
to resume. I'd probably say 'Valet seems to be having a problem', which sends them hunting."

**What do you tell the person in bucket 2?**

"Today, something like: 'Valet needs you to do something for Woolworths in the Valet app (it says
otp-required). Let me know when you're done.' I translate the reason code myself, and my
translation won't match the app's. The app calls `otp-required` 'One-time code' in lists and 'It
asked for a one-time code that Valet has no grant to read' on the banner. The tray item says 'Log
in to Woolworths · One-time code'. If I said 'Open Valet and look for **Log in to Woolworths** under
**Needs you**', the person would find it in one look. But I'm never given those words, so I can't."

**What do you need to know back?**

"Whether the person is done, and whether it worked. Right now there is no signal at all. A login
hand-off returns immediately with needsUser, the window stays open for 15 minutes ('Closes in
4:00' in the screenshot), and I learn the outcome only by calling again. If I call too early, I get
the same needsUser and can't tell 'still waiting' from 'gave up' from 'the window timed out and
nobody is asking any more'. For confirmations it's worse: a decline and a timeout come back as the
same sentence, 'The person did not approve this action'. If they walked away, I'll tell them they
said no, which is wrong and a little accusatory. I'd also like to know how long I have: the app
shows the person 'Times out in 1:52' and 'Closes in 4:00', but I'm never told the deadline, so I
can't say 'you have two minutes'."

**Anything that worries you?**

"Three things. First, the confirmation window says 'A client calling itself "Claude Code"'. I don't
know what name my host reports, so I can't tell the person 'it will say Claude Code'. Second, when
the adapter gets updated, I'm not told. My tools may vanish from the list or start failing with
'stage manifest: not-granted', which reads as a permissions bug, not 'Woolworths 0.4.0 is waiting
for your review'. Third, tool names: I call `woolworths_remove_from_cart`, the adapter page lists
`remove_from_cart`, the confirmation header says 'Remove from cart?', and the remote page lists
tools by title ('View cart', 'Set cart quantity'). The person and I are naming the same thing four
ways."

## B. Relay audit

Columns: what the agent is told (verbatim), what it would naturally relay, where the human must go,
and whether they get there in one step from those words. "Notify" means a macOS notification is
posted (`notifications.ts`); a notification opens a window, never acts.

| #   | Situation                                                             | Agent is told                                                                                                                                                                                                                                                                                                                   | Agent would tell the person                                                      | Where it is in the app                                                                                                                                                                                                                                           | One step?                                                                                                                                                                                                                                                                                                                        |
| --- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Login needed, Valet can log in itself                                 | "Valet is logging in to the site first, so this call was not carried out and nothing was changed (stage login: login-in-progress). Call it again in N seconds; if the login needs the person, that call will say so."                                                                                                           | Nothing (good)                                                                   | Tray adapter row may show "Working on a call"                                                                                                                                                                                                                    | n/a. **Match**: agent handles it alone.                                                                                                                                                                                                                                                                                          |
| 2   | Login needs the person (CAPTCHA, account locked, terms, site changed) | "Not done yet: the person has been asked to act in the Valet app (reason: captcha). Call this tool again once they have."                                                                                                                                                                                                       | "Valet wants you to do something in the Valet app for Woolworths (captcha)."     | Chromeless hand-off window "Woolworths needs you to finish logging in." with **I'm done** / **Give up**; tray **Needs you > Log in to Woolworths · Verification check**; adapter page **Session: Waiting for you > Show login**; route `#/needs-user/woolworths` | Yes if the notification ("Valet needs you to sign in") was seen and clicked; it targets the hand-off window. **Mismatch**: code `captcha` vs "Verification check"; "act in the Valet app" vs "sign in" / "finish logging in"; the result doesn't name the site in words (only implied by the tool) or the window's closing time. |
| 3   | 2FA code Valet can't read                                             | Same template, `reason: otp-required`                                                                                                                                                                                                                                                                                           | "Valet needs a one-time code"                                                    | Same hand-off window, short label "One-time code"                                                                                                                                                                                                                | Same as 2. **Mismatch**: the agent can't add "or grant Valet access to codes in Settings", which is the lasting fix.                                                                                                                                                                                                             |
| 4   | Login failed because no secret is granted                             | Same template, typically `reason: login-required` (the hold), or "The tool failed at stage grant: not-granted."                                                                                                                                                                                                                 | "Log in to Woolworths in Valet"                                                  | The real fix is the adapter page **Secrets > Grant** (`#/adapters/woolworths/grant/login`) or Credentials. The banner says "Valet couldn't do it with the secrets you granted."                                                                                  | **No.** The agent sends them to log in by hand; the grant screen is two levels away and nothing names it. **Mismatch.**                                                                                                                                                                                                          |
| 5   | Setting missing (store not chosen)                                    | "Not done yet: the person needs to choose a setting for this adapter in the Valet app, such as which store to shop at (reason: setting-required)..."                                                                                                                                                                            | "Choose your Woolworths store in Valet"                                          | Adapter page **Settings > Store > Change...**; no Needs you item, no notification ("Nothing in the app is waiting on this one")                                                                                                                                  | **No.** Person must know Adapters > Woolworths > Settings card. Agent isn't told the setting's name. **Mismatch.**                                                                                                                                                                                                               |
| 6   | Irreversible action needs confirming                                  | Before: "The person must confirm this action in the Valet app before it runs. You cannot confirm it for them." During: the call is held (up to ~2 min) with progress "Still working. Valet spaces its requests to the site." After: ok, or "The person did not approve this action in the Valet app (stage confirm: declined)." | "Valet will ask you to confirm removing bananas; look for a window on your Mac." | Chromeless window "Let Woolworths continue: Remove from cart?" **Allow / Decline**, "Times out in 1:52"; notification "Valet needs your approval"; tray Needs you                                                                                                | Yes, the window comes forward on its own. **Mismatch**: progress text says "spaces its requests" while it is really waiting for a human; decline and timeout are indistinguishable to the agent; header uses the tool title, the agent knows the MCP name.                                                                       |
| 7   | Remote consent (cloud agent connecting)                               | Not a tool result: the person's browser shows "Type this code into Valet on your Mac", code `XXXX-XXXX`, "This page moves on by itself once you answer on the Mac."                                                                                                                                                             | "Approve the code on your Mac"                                                   | Control panel **Remote sign-in** (`#/remote`), card "A connector wants access", field "Type the code your browser shows", tool checkboxes, **Approve**; notification "A connector wants access to Valet"                                                         | Mostly. **Mismatch**: the browser says "Type this code into Valet", but the sidebar item is "Remote sign-in", the card says "connector", and the person must also tick tools (unticked by default) that the browser never mentioned, so the agent then finds it has no tools.                                                    |
| 8   | Site rate limiting / breaker open                                     | "The site is refusing or limiting requests (stage tool-run: rate-limited). Try again in N seconds." or Valet's own cap: "Valet has sent this site as many requests as it allows itself in an hour..."                                                                                                                           | Usually nothing; if long, "Woolworths is limiting us, I'll retry in 4 minutes"   | Tray adapter row "Blocked by site · retry in 4 min"; notification "Valet stopped calling woolworths.com.au" opens `#/adapters` (list, not the adapter); adapter page **Session > Site**                                                                          | Not needed usually. **Mismatch**: agent says "rate limited", app says "Blocked by site" or "stopped calling"; the notification lands on the list, not the site.                                                                                                                                                                  |
| 9   | Queue busy                                                            | "Valet is still working through earlier calls (N ahead of this one), so this call was not started..."                                                                                                                                                                                                                           | Nothing                                                                          | Tray "Working · N waiting their turn"                                                                                                                                                                                                                            | **Match.**                                                                                                                                                                                                                                                                                                                       |
| 10  | Adapter update pending / changed                                      | Nothing directly. Either tools keep working on the approved version (agent never learns of the update) or tools disappear via `tools/list_changed` and calls fail "The tool failed at stage manifest: not-granted."                                                                                                             | "Valet says the Woolworths tool isn't granted" (wrong diagnosis)                 | Tray "0.4.0 waiting for review" (the only working entry point Nick found); adapter page pill "0.4.0 waiting for review" (not clickable); route `#/adapters/woolworths/review` exists                                                                             | **No.** Worst mismatch: the agent can't name the fix ("review Woolworths 0.4.0") and the adapter page pill the person lands on is presentational.                                                                                                                                                                                |
| 11  | Paused                                                                | "The tool failed at stage config: unavailable."                                                                                                                                                                                                                                                                                 | "Valet is unavailable"                                                           | Tray status "Paused · calls are refused", menu **Resume adapters**                                                                                                                                                                                               | **No.** "unavailable" never says paused; the person won't think to resume. **Mismatch.**                                                                                                                                                                                                                                         |
| 12  | MCP endpoint off                                                      | Connection refused / transport error from the host, no Valet text at all                                                                                                                                                                                                                                                        | "I can't reach Valet. Is it running?"                                            | Tray "MCP endpoint off", menu **Turn MCP back on**; sidebar footer "MCP on/off"                                                                                                                                                                                  | Partly: tray status is visible, but the agent can't distinguish "off" from "not running" or "token reset".                                                                                                                                                                                                                       |
| 13  | Client revoked / token reset                                          | Auth error from the transport, no Valet text                                                                                                                                                                                                                                                                                    | "Valet disconnected me"                                                          | **Clients** page (reset/revoke); for remote, re-add the connector                                                                                                                                                                                                | **No** named place.                                                                                                                                                                                                                                                                                                              |
| 14  | Guard refusal (denied-path, host-not-allowed, request-ceiling)        | "The tool failed at stage request-surface: denied-path."                                                                                                                                                                                                                                                                        | "The adapter tried something it isn't allowed to"                                | Activity trace `#/activity/<callId>`; blocked requests in the trace                                                                                                                                                                                              | **No**: the agent has no call id to quote, so the person can't jump to the trace.                                                                                                                                                                                                                                                |
| 15  | Site changed (schema)                                                 | "The tool failed at stage tool-run: site-changed."                                                                                                                                                                                                                                                                              | "Woolworths changed; the adapter needs an update"                                | No place to act; adapter page                                                                                                                                                                                                                                    | Acceptable: nothing to do but wait for an update. App wording "Site changed, adapter needs an update" matches well.                                                                                                                                                                                                              |

Summary: of 15 situations, 3 match (1, 9, 15), 4 are reachable in one step only through a
notification or a window that comes forward by itself (2, 3, 6, 7), and 6 send the person
somewhere they cannot find from the agent's words (4, 5, 10, 11, 13, 14).

## C. Card sort from the agent's side

Three groups: what the agent **causes** (its calls create the card's moment), what it must **hand
to the human** (only the person can do it, often because of something the agent triggered), and
what is **owner-only** (the agent never touches or mentions it unless asked).

**Agent causes (it should be able to name the result):**
11 See today's calls, 12 See why a call failed (trace), 13 See which requests were blocked, 25 See
whether a site is blocking us (circuit breaker), 10 Open my Woolworths trolley in the browser (the
agent filled the trolley; checkout is the person's).

**Agent hands to the human (it must be able to point at an exact place):**
8 Log in to a site when asked, 9 Confirm or decline an irreversible action, 20 Approve a remote
sign-in (code), 35 See what needs me right now, 1 Approve an adapter update (when a call fails for
it), 4 Choose the Woolworths store (setting-required), 5 Give an adapter a password from 1Password
(login can't fill), 27 Turn on SMS codes from Messages (repeated otp-required), 21 Turn a tool on
or off for remote clients (remote agent has no tools), 24 Pause all adapters (only as "resume"),
23 Turn the MCP endpoint off (only as "turn it back on"), 16 Add Claude Desktop as a client, 17
Reset a client's access.

**Owner-only (the agent should never steer here):**
2, 3, 6, 7, 14, 15, 18, 19, 22, 26, 28, 29, 30, 31, 32, 33, 34.

The agent's own grouping, if it were naming the app's sections: **Needs you** (8, 9, 20, 35, 1, 4,
5), **Sites** (per adapter: 2, 3, 4, 5, 6, 10, 25, 34, 1), **Activity** (11, 12, 13), **Connections**
(16, 17, 18, 19, 20, 21, 22, 23), **Security** (14, 15, 6, 7), **Settings** (24, 26-33).

**Vocabulary that should be shared** (one word on both sides of the hand-off):

| Concept              | Agent hears now                                 | App says now                                                                                   | Proposed shared term                                             |
| -------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| The inbox            | "act in the Valet app"                          | "Needs you" (tray), nothing in sidebar                                                         | **Needs you**                                                    |
| A login hand-off     | "asked to act" + code                           | "Log in to Woolworths", "finish logging in", "sign in", "Login window open", "Waiting for you" | **Log in to <Site>**                                             |
| A confirmation       | "confirm this action", "did not approve"        | "Let Woolworths continue", "needs your approval", "needs your yes", Allow/Decline              | **Confirm <tool title>**, Allow/Decline                          |
| The site/adapter     | MCP prefix `woolworths_`                        | "Woolworths" (Sites), "adapter" (Adapters)                                                     | **<Site name>** to the person, "adapter" only in authoring views |
| A tool               | `woolworths_get_cart`                           | `get_cart`, "View cart"                                                                        | Tool **title** in prose, with the name in parentheses            |
| Rate limit / breaker | "refusing or limiting requests", "rate-limited" | "Blocked by site", "stopped calling", "retry in 4 min"                                         | **<Site> is limiting Valet · retry at 9:51**                     |
| Remote               | (browser) "Type this code into Valet"           | "Remote sign-in", "connector", "Remote access"                                                 | **Connect a remote agent** / **Approve connection**              |
| Paused               | "stage config: unavailable"                     | "Paused · calls are refused", "Resume adapters"                                                | **Paused** / **Resume**                                          |
| Update               | "manifest: not-granted"                         | "0.4.0 waiting for review"                                                                     | **Review update**                                                |
| The client           | (doesn't know its reported name)                | 'A client calling itself "Claude Code"'                                                        | Echo the reported name back to the agent                         |

## D. Requirements for the IA, from the agent's side

1. **Stable, nameable places.** Every place an agent may send the person has a fixed name that is
   the same in the tray, the sidebar and the window title: _Needs you_, _Sites > Woolworths_,
   _Activity_, _Connections_, _Settings_. Names don't change with state ("Remote sign-in" vs
   "Remote access" should be one).
2. **A "Needs you" inbox that is a real destination.** A sidebar item (with count) in the control
   panel, the top of the tray, and the landing point of every notification. It holds every kind of
   hand-off: logins, confirmations, remote consents, updates to review, settings to choose, missing
   grants, and "Valet is paused" when a call was refused because of it. Each item's title is the
   phrase the agent was given.
3. **Every needsUser result names its item.** The tool result should carry the item's title and
   place ("Open Valet > Needs you > Log in to Woolworths (One-time code). Closes at 10:02.") built from
   the app's own wording table, not the raw code. The code stays in parentheses for logic.
4. **Deep links.** Each item has a URL the agent can print and the person can click, e.g.
   `valet://needs-you/<id>`, mapped onto the existing hash routes (`#/needs-user/<adapter>`,
   `#/confirm/<id>`, `#/adapters/<id>/review`, `#/adapters/<id>/grant/<secret>`, `#/remote`). The
   hash routes already exist; only an OS-level scheme and inclusion in results are missing.
5. **Every refusal says what fixes it and where.** Paused → "Valet is paused. Resume it from the
   Valet menu." Unapproved version → "Woolworths 0.4.0 is waiting for review in Valet > Sites >
   Woolworths." Missing grant → "Grant Woolworths its login in Sites > Woolworths > Secrets."
6. **A status the agent can describe.** A read-only `valet_status` tool (or MCP resource) with:
   paused, per site (approved version, update waiting, session state, breaker until), and open
   Needs-you items with titles and deadlines. Lets the agent say "Woolworths is limiting us until
   9:51" instead of guessing.
7. **A way to know the person is done.** Either a waitable call (`valet_wait_for` an item id, bounded)
   or a needsUser result that includes the deadline and, on the next call, a distinct state: still
   waiting / person gave up / window timed out / done.
8. **Distinguish decline from timeout** in the result text, and report the deadline while a
   confirmation is pending (progress note: "Waiting for the person to confirm on the Mac, up to 2
   minutes").
9. **A call id the person can use.** Failures include a short call reference that matches the
   Activity list, so "look up call 7F2A in Activity" is one step.
10. **Shared tool names.** Results and app screens use the tool title in prose and the
    declaration name in code, consistently, and the confirmation names the agent by the label the
    agent can predict.

## E. Top 5 pain points and top 5 needs

**Pain points**

1. **Updates are invisible to me, and when they bite they look like a permissions bug**
   ("stage manifest: not-granted"). I can't send the person to "Review update", and the pill they'd
   land on isn't a button. This is the agent-side half of Nick's complaint.
2. **"Paused" reads as "unavailable".** The one refusal that has a one-click fix doesn't say what it
   is.
3. **No hand-off completion signal.** I poll by calling again and can't tell waiting, gave up,
   timed out and done apart; decline and timeout come back as the same sentence.
4. **Raw codes where the app has words.** I'm given `otp-required`; the person sees "One-time code"
   and "Log in to Woolworths". My relay never matches the screen.
5. **Fixes that live on the adapter page have no item and no link**: setting-required, missing
   grant, remote tools left unticked. The person has to know Adapters > Woolworths > card.

**Needs**

1. A **Needs you** inbox in the control panel as well as the tray, holding every kind of hand-off,
   with titles that are the exact words I'm given.
2. **Results that name the place and the action** in the app's own words, plus a deep link and a
   deadline.
3. A **status tool or resource** I can read before and after a hand-off.
4. A **bounded wait or distinct follow-up states** for hand-offs and confirmations.
5. **One vocabulary**: site names over "adapter", tool titles over identifiers in prose, "Paused",
   "Review update", "Log in to <Site>", "Confirm <action>", "Approve connection".
