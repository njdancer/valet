# Round 1 test: P6, Claude the calling agent

Simulated session, 2026-11-11. I'm testing as the MCP client that sends the person into Valet. I
never click anything in the app. So for the tree test, each answer gives:

- **Words:** the sentence I'd put in front of the person.
- **For each tree:** whether those words lead to exactly one place (_maps_), to two or more places
  (_ambiguous_), or to nowhere the person would recognise (_lost_).

I answered IA-A, then IA-B, then IA-C. My words come from the shared vocabulary table, not from the
tree, so knowing the trees changed little. Where it did change something, I say so.

## Part 1. Tree test, from the agent's mouth

| Task                             | Words I'd use                                                                                                                                                          | IA-A                                                                                                                                            | IA-B                                                                        | IA-C                                                                                                                                             |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| T1 Approve 0.4.0                 | "Open Valet, **Needs you**, _Review the Woolworths update (0.4.0)_." Fallback: "Sites, Woolworths, Versions."                                                          | Maps (Needs you, or Sites > Woolworths > Versions)                                                                                              | Maps, same                                                                  | Ambiguous: "Needs you" is a section of Home, not a page, so I must say "Home, Needs you". "Home" is the word people least expect to hold a task. |
| T2 Why get_cart failed           | "Open Valet, **Activity**, call **7F2A**." This needs a call reference in the result. Without one: "the latest get_cart call."                                         | Maps: Activity > Calls                                                                                                                          | Maps: Calls. This is the cleanest wording: "Calls" is what I call them too. | Maps: History > Calls. "History" reads as browsing history. Unsure.                                                                              |
| T3 Revoke Claude Code            | I wouldn't steer here. If asked: "**Connections**, Claude Code, Revoke."                                                                                               | Maps                                                                                                                                            | Maps                                                                        | Ambiguous: "Access" holds Connections and Secrets, and "revoke access" fits both a client and a grant.                                           |
| T4 Turn on remote access         | "**Connections**, Remote access."                                                                                                                                      | Maps                                                                                                                                            | Maps                                                                        | Maps once the person opens Access. One click deeper.                                                                                             |
| T5 Change the store              | After setting-required: "**Needs you**, _Choose your Woolworths store_." Otherwise "Sites, Woolworths, Overview, Store."                                               | Maps                                                                                                                                            | Maps                                                                        | Maps, with the same Home caveat as T1                                                                                                            |
| T6 Calls that used the password  | Owner task. "Secrets, Grants, Woolworths login, its calls."                                                                                                            | Ambiguous: Secrets > Grants or Activity filters. Both are fine if they link to each other (E2).                                                 | Same                                                                        | Ambiguous: Access > Secrets or History                                                                                                           |
| T7 Verify audit log              | Owner only; I'd never send them here.                                                                                                                                  | Maps: Activity > Audit log                                                                                                                      | Maps: Audit log, top level                                                  | Maps: History > Audit log                                                                                                                        |
| T8 SMS codes                     | After a repeated otp-required: "**Secrets**, One-time codes, turn on Messages."                                                                                        | Maps                                                                                                                                            | Maps                                                                        | Maps once the person opens Access. One click deeper.                                                                                             |
| T9 Blocked until when            | I already know the time from the result: "Woolworths is limiting requests; calls resume at 9:52 pm. Nothing for you to do." If they want to look: "Sites, Woolworths." | Maps (health line on Overview)                                                                                                                  | Maps                                                                        | Maps best: the Home health line shows it on the first page.                                                                                      |
| T10 What Claude Desktop can call | Not something I'd say. "Connections, Claude Desktop."                                                                                                                  | Maps                                                                                                                                            | Maps                                                                        | Lost-ish: Access > Connections > client page is three levels deep.                                                                               |
| T11 Trace retention              | Never steered by me                                                                                                                                                    | Maps: Settings > Data and privacy                                                                                                               | Maps                                                                        | Maps                                                                                                                                             |
| T12 Cloud agent with a code      | The browser page says it, not me: "Type the code into Valet on your Mac: **Needs you**, _Approve a connection_."                                                       | Ambiguous: Needs you or Connections > Remote clients. That's fine only if Needs you is the canonical place and Connections shows the same item. | Same                                                                        | Ambiguous: Home or Access                                                                                                                        |

**Winner: IA-A.** Every hand-off I relay goes to **Needs you**, and IA-A makes that a top-level
place with a name I can say verbatim. The rest of my words ("Activity", "Sites, Woolworths",
"Connections", "Secrets") each map to one item.

IA-C fails me in two ways:

- **Needs you is part of Home.** I'd have to say "Home" and then hope the item is visible.
- **"Access" is a bucket.** Clients, remote access and secrets all sit under one word I can't use
  precisely.

IA-B is close to IA-A, but splitting Calls from the Audit log helps the owner, not me. I'd take
IA-B's word "Calls" as the label of the first tab inside Activity. Learning effect: after IA-A I
expected "Activity" in IA-C and was briefly lost at "History".

## Part 2. Label preference

- **Sites** over Adapters. People ask me about Woolworths, not about an adapter. The MCP prefix
  `woolworths_` already matches the site name. Keep "adapter" for authoring views.
- **Connections** over Clients or Connected apps. "Connected apps" breaks on a cloud agent, which
  isn't an app on the Mac. But see the vocabulary collision under "Missing secret" below.
- **Secrets** over Passwords or Credentials. One-time codes aren't passwords, and "Credentials" is
  jargon. I would rarely say this word anyway.
- **Activity** over History. "History" means browser history to most people. Use "Calls" as the
  first tab inside Activity.
- **Needs you** over Inbox or Waiting. It's the phrase I'd say anyway ("Valet needs you to..."). An
  inbox suggests messages to read, and "Waiting" doesn't say who it's waiting for.

## Part 3. Hypothesis feedback

**E1 (accept, E1 over E1b).** I tell the person a verb: "Review the Woolworths update." E1 puts a
button with exactly that label next to the badge, so my words match the screen. E1b's chevron badge
says "0.4.0 waiting for review", which has no verb and isn't the phrase I used. E1 would have let
Nick find the review. E1b might have, if he guessed the pill was a button. Make the button label
**Review update** everywhere: Needs you item, site Overview banner and Versions tab.

**E2 (accept).** I need one thing from it: the call reference in my results must be the same short
id the Activity list shows and links on.

**E3 (accept).** A person who wants to quote a call id or an error back to me must be able to select
and copy it. That's covered: values stay selectable.

**E4 (accept).** Undo on pause is good for me too. A person who pauses by accident unpauses before
my retry fails.

**E5 (refine).** Countdowns matter to me as much as to the person: I should be told the same
deadline. Show the clock time first ("until 9:50 pm"), because that's what I can say. I can't say
"1:42 left", since it's stale by the time they read my message.

**E6 (accept, strongly).** The health line is the sentence I want to say, so make it the same
template as my result text. "Woolworths is limiting requests; calls resume at 9:52 pm" should appear
word for word in both.

**E7, E9, E11 (accept).** No agent stake.

**E8 (accept).** One wording table, used by both the app and `results.ts`. Today they are separate
tables (`renderer/lib/wording.ts` and the fixed templates), so they drift. Generate result strings
from the shared table and test that they match.

**E10 (accept).** Pause must also be visible to me. See the result strings below.

**P1 (accept).** This is my biggest need. It must hold every kind of hand-off: login, confirmation,
remote connection, review, setting, grant, and "Valet is paused" when a call was refused for it. Item
titles must be the exact strings in my results. Each item needs an id I can be given and a deep link,
e.g. `valet://needs-you/<id>`. The **Missed** section matters: "you missed the confirmation, it was
declined at 9:50" is how I'd explain a timeout.

**P2 (accept).** "Sites, Woolworths" is easy to say. Name the tabs as I'd say them. Keep "Versions":
I'd say "Versions" or nothing.

**P3 (accept).** A full page with a URL means it can be a deep link target.

**P4 (accept).** Filters in the URL let me print "Activity filtered to Woolworths, failed" as a link.

**P5 (accept).** The client page should also show the name I'm known by, so the person can match
"a client calling itself Claude Code" to me.

**P6 (accept).** It needs per-secret pages: "Secrets, Woolworths login".

**P7 (accept).** No stake.

**P8 (pick P8a).** "Open Valet" has to be enough when something waits, and only P8a guarantees it.
P8b lands on the right page, but the item sits inside Home and I can't name it as a place. With P8c,
every hand-off costs an extra click on a sidebar count. Condition: notifications and deep links still
open the exact item, not Needs you in general.

**P9 (accept).** "Ask Claude: what's in my Woolworths trolley?" is a test I'd pass. Skipped steps as
Needs you items mean my setting-required and missing-grant results have somewhere to point.

**P10 (refine).** The sentence "Remove Cavendish Bananas from your trolley?" is adapter text that
Valet doesn't verify. Lead with it, but keep it visibly attributed. My results can never repeat it,
since `results.ts` passes no adapter text. So the shared title is the tool title, "Confirm: Remove
from cart (Woolworths)", and I add the product name in my own message.

**P11 (accept).** Tray first, same order and titles as Needs you.

### The vocabulary table, judged hard

| Candidate                                                | Verdict                   | Why, and what to use                                                                                                                                                                                                                                                 |
| -------------------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Needs you                                                | Accept                    | The place name. Every result that hands off says "Open Valet, Needs you".                                                                                                                                                                                            |
| Log in to Woolworths                                     | Refine                    | It's the right item title. But for a CAPTCHA, a locked account or new terms, the job isn't logging in. Keep one title per hand-off, with the app's existing short reason as a qualifier: "Log in to Woolworths (verification check)".                                |
| Enter the one-time code for Woolworths                   | Reject                    | There's no field in Valet to enter it. The person types it into the site, in the same login window. A separate title for the same window splits one item into two names. Use "Log in to Woolworths (one-time code)".                                                 |
| Confirm: Remove Cavendish Bananas                        | Reject as a shared string | The product name is adapter text. It can't go in a result or a notification, so the title I'm given can't contain it. Use "Confirm: Remove from cart (Woolworths)" with the tool title. Buttons can still say "Remove".                                              |
| Approve a connection (code ABCD-1234)                    | Refine                    | I never get this as a tool result. The cloud agent isn't connected yet. It belongs on the browser waiting page and the Needs you item. Include the tool step, or the agent connects with no tools: "Approve a connection: type the code, choose its tools, Approve". |
| Review the Woolworths update (0.4.0)                     | Accept                    | It must also be sent to me when a call fails because of it. Today I get "manifest: not-granted".                                                                                                                                                                     |
| Paused (Resume in Valet)                                 | Refine                    | Too terse for a result. Say it was paused, that nothing was sent, and where Resume is.                                                                                                                                                                               |
| Woolworths is limiting requests; calls resume at 9:52 pm | Refine                    | Keep the seconds as well: I schedule on "Try again in N seconds" and relay the clock time. Separate Valet's own cap: "Valet is limiting its requests to Woolworths".                                                                                                 |
| Choose your Woolworths store                             | Accept                    | Generalise to "Choose a setting for Woolworths (Store)". The setting name was approved with the adapter, as site names are.                                                                                                                                          |
| Connect your Woolworths login                            | Reject                    | "Connect" collides with **Connections**: the person will look there and find clients. Use "Give Valet your Woolworths login" (in Secrets). Add a separate item for a locked 1Password: "Unlock 1Password".                                                           |

The table is missing these, which I need:

- decline told apart from timeout
- the MCP endpoint is off
- the client was revoked or reset
- a guard refusal, with a call reference

### Exact tool-result strings I propose

Each string keeps a stable code in parentheses for my logic. `{site}` is the approved adapter name,
`{n}` and `{time}` are numbers and clock times, and `{ref}` is the short call reference shown in
Activity.

- **Login hand-off:** `Not done yet: Valet needs the person. Ask them to open Valet, Needs you, "Log in to {site} ({reason words})". It is open until {time} ({n} minutes). Call this tool again once they say they're done (needs-user: {code}).`
- **Setting missing:** `Not done yet: ask the person to open Valet, Needs you, "Choose a setting for {site} ({setting})". Call again once they have (needs-user: setting-required).`
- **Grant missing:** `Not done yet: Valet has no login it may use for {site}. Ask the person to open Valet, Needs you, "Give Valet your {site} login". Call again once they have (needs-user: grant-missing).`
- **Irreversible tool description:** keep `The person must confirm this action in the Valet app before it runs. You cannot confirm it for them.` and add ` Valet shows it as "Confirm: {tool title} ({site})" and waits up to {n} minutes.`
- **Progress while confirming:** `Waiting for the person to confirm on the Mac, until {time}.` This replaces "Valet spaces its requests to the site", which is wrong during a confirmation.
- **Declined:** `The person declined this in Valet (confirm: declined). Nothing was changed.`
- **Timed out:** `Nobody answered in Valet by {time}, so it was not done (confirm: timed-out). Nothing was changed. Ask the person before trying again.`
- **Update waiting:** `Not done: {site} has an update waiting for review, and its tools are off until then. Ask the person to open Valet, Needs you, "Review the {site} update ({version})" (manifest: review-pending).`
- **Paused:** `Valet is paused, so this call was not started and nothing was sent (config: paused). Ask the person to resume Valet from the menu bar or the Valet window, then call again.`
- **Site limiting:** `{site} is limiting requests, so this call was not started and nothing was sent; calls resume at {time} (tool-run: rate-limited). Try again in {n} seconds.`
- **Own cap:** `Valet is limiting its requests to {site} for the hour; calls resume at {time} (tool-run: hourly-cap). Try again in {n} seconds.`
- **Guard or other failure:** `The tool failed at stage {stage}: {class}. The person can see it in Valet, Activity, call {ref}.`

## Part 4. What the hypotheses still miss

**My biggest remaining worry is still not knowing when the person is done.** Even if everything
above ships, I relay "Log in to Woolworths", then I either nag the person or call again blind. I
need one of these:

- a bounded `wait` on a Needs you item, or
- a `valet_status` read-only tool or resource that lists open items, their state (waiting, done,
  given up, missed) and the deadline.

The second worry is **drift**. If the app's wording and `results.ts` stay as two tables, these
strings will drift apart within a release. Generate both from one table and test that they're
identical.

Third, remote mode. When the person is on a phone (P7), a `valet://` link I print can't open
anything there. Results should say "on your Mac" whenever the action can only happen there.
