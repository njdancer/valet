# Approval cards: content spec

Workstream A, for workstreams B (security), D (approval broker), E (admin tools), F (authoring) and
H (iOS app). One structured card per approval request, rendered the same on the Mac and the phone,
and summarised in one sentence in the agent's tool result. This spec says what each card says, in
what order, from which data, and within which limits. The wireframes draw every kind on both
devices (`wireframes/`, group "J4 · Cards on the phone and Mac", and the journey groups).

Names and refs follow [`story.md`](story.md). Tiers are the plan's recommended defaults (D74,
answered: "not everything needs approval"); B finalises them. Revised after the adversarial review
([`review.md`](review.md)); finding numbers are given as (R12).

## 1. Rules every card follows

1. **Valet writes the card, not the agent.** Kind, title, risk line, change rows and checks come
   only from Valet's structured diff and Valet's own runs. Text the agent wrote (a draft's display
   name, its reason) is always quoted and labelled, never the subject of the title, never in a
   notification. (Guards X1 and X2; R3.)
2. **What you see is what you sign.** The card is rendered from one canonical payload, and the
   approval signs that payload's hash with a one-time nonce and an expiry 2 minutes after signing
   (B's contract). Submitting a draft freezes it at its hash; Valet installs the frozen snapshot it
   compiled itself, and any later edit starts a new request (R46). If the payload changes while the
   card is open, the card is replaced and says so; a stale approval is refused by the Mac.
3. **Name the asker by the name the person gave it.** "Asked by Claude app", where "Claude app" is
   the name chosen at connect time, with its **This Mac** or **Through the relay** badge and its
   monogram everywhere. Names are unique (a confusables check refuses look-alikes) and can't
   contain a device word ("iPhone", "Mac", "phone"), "Valet" or "your" (R18). A cloud agent's
   self-description and redirect host appear in Details. A local name identifies a token, not a
   process: any process that reads that app's config holds the same name. Requests raised by Valet
   itself say "Raised by Valet".
4. **Say why it exists.** Every card has a **Because** row from data Valet can check: the repair it
   serves (R-4E1C), the draft it belongs to, the request it follows. A request linked to nothing
   Valet knows says "Not linked to anything Valet knows about" in the caution tone, and the first
   request of a kind from an agent says "First request of this kind from Claude Code". A request for
   something the agent already holds names what it holds and why: "Claude Code already has a
   signed-in Woolworths session, for Repair R-4E1C, until 8:15 pm" (R19).
5. **One gesture, on a trusted device.** Approve needs Face ID or the phone's passcode on the
   iPhone, and Touch ID or the Mac password on the Mac (section 6). A tap alone never approves; a notification
   never approves and has no action buttons (security model, Notifications, Enforced; R7, R37).
6. **First line first.** The tone word (strong and caution cards), title, who asked, the risk line
   and the buttons sit above the fold on a 393 x 852 iPhone at the default text size. At
   accessibility text sizes the tone word and risk line move into the pinned action bar, so they
   are on screen whenever Approve is (R33).
7. **Words, not colour.** Every change row has a marker word (Adds, Removes, Changes, Same) as well
   as a tint. Risk tones are neutral, caution and strong, each with its own icon and word.
8. **Never shorten what could be faked.** Hosts, origins and paths are shown in full and wrap; the
   registrable domain is bold, and its accessibility label says "query1.finance.yahoo.com, owned by
   yahoo.com" (or "owned by example.net, not yahoo.com") so VoiceOver gets the same defence (R34).
9. **Decline is one tap and never needs a gesture.** It can carry a note, delivered only to the
   asking agent (R56).
10. **The Mac decides.** The first valid answer the Mac records wins; every other copy of the card
    turns into "Approved on Nick's iPhone at 7:41 pm" (or Declined, Expired), and a late answer from
    another device says it wasn't used (R29).
11. **Strong cards take a second step.** A tick "I've read what this does" sits above Approve on
    strong cards and must be ticked first (R31).

## 2. Anatomy

In reading order. This is also the VoiceOver order: the heading group (items 1 to 3), then the risk
line, what changes and Because, then the actions, which Magic Tap and the rotor also reach (R33).

| #   | Part                  | Content and source                                                                                                                                                                                                                 | Limits (iPhone, default text)                 |
| --- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| 1   | Kind strip            | Kind word and version for adapter kinds ("Install · 1.0.0"), approval ref (`7B3F`), deadline or age. When the Mac is offline: "Mac last seen 7:39 pm" (R28).                                                                       | One line.                                     |
| 2   | Title                 | Template per kind (section 3), from the diff. Tone word first on strong and caution cards ("Can't be undone."). Connect's title is the question (R32).                                                                             | 60 characters; wraps, never truncates.        |
| 3   | Asked by              | "Asked by {name} · {time}" with the agent's monogram and badge, or "Raised by Valet · {time}".                                                                                                                                     | One line.                                     |
| 4   | Risk line             | One sentence from section 4, computed over the parent and every ticked follow-on, with tone; "and 2 more risks" when more apply.                                                                                                   | 100 characters.                               |
| 5   | What changes          | Change rows (section 5): expansions first, reductions, then relevant unchanged rows. Five shown, then "Show 3 more".                                                                                                               | Each row up to 60 characters before it wraps. |
| 6   | Because               | Rule 4.                                                                                                                                                                                                                            | One line.                                     |
| 7   | Checks Valet ran      | Valet's own runs only: build, manifest, lint, sandbox, live trial (signed out, or signed in where F's trial tier allows), reproduction check (on fixtures Valet recorded, or a signed-in live trial for pages behind the sign-in). | One line each.                                |
| 8   | Tests the agent wrote | "14 tests the agent wrote pass (Valet ran them)", in plain text, never with a tick and never above the fold (R22). Fixtures say "recorded by Valet" or "edited by the agent".                                                      | One line.                                     |
| 9   | Follow-ons            | Remote-tool requests for this adapter's tools, unticked (section 8).                                                                                                                                                               | Up to 5.                                      |
| 10  | In {agent}'s words    | The agent's reason, quoted, plain text only, "Show more" after 280 characters.                                                                                                                                                     | 2,000 characters stored.                      |
| 11  | Details               | Code changes, references the agent read (URLs only), payload fingerprint, the agent's self-description, redirect host, the call ref.                                                                                               | Collapsed.                                    |
| 12  | Actions               | **Decline** and the approve button (section 6). Pinned at the bottom.                                                                                                                                                              | Always visible.                               |
| 13  | Footer                | "Expires {day, time} if nobody answers." "Only you can approve this. Claude can't approve its own requests."                                                                                                                       | Two lines.                                    |

On the Mac the card is the top of the Review page (`#/sites/<id>/versions/<hash>/review`) for
adapter kinds, and a sheet over Needs you for the others, with the same parts in the same order.

Times are shown in the phone's time zone; when that differs from the Mac's, "(7:52 pm at home)"
follows (R30).

## 3. Kinds, titles, tiers and who may ask

| Kind              | Tier              | Title template                                        | Example                                              | Asked by                      |
| ----------------- | ----------------- | ----------------------------------------------------- | ---------------------------------------------------- | ----------------------------- |
| Install           | Approve           | Install "{name}" for {registrable domain}             | Install "Yahoo Finance" for yahoo.com                | agent                         |
| Update            | Approve           | Update {Site} to {version}                            | Update Woolworths to 0.3.1                           | agent, Valet                  |
| Restore           | Approve           | Go back to {Site} {version}                           | Go back to Woolworths 0.3.0                          | agent, person                 |
| Login             | Approve           | Let {Site} use your login                             | Let Woolworths use your login                        | agent, Valet                  |
| Remote tool       | Approve           | Turn on "{Tool}" for {agent}                          | Turn on "Search symbols" for Claude app              | agent (for itself only)       |
| Local tool        | Approve           | Turn on "{Tool}" on this Mac                          | Turn on "Add to cart" on this Mac                    | agent, person                 |
| Setting           | Approve           | {Verb phrase of the setting}                          | Choose your Woolworths store                         | agent (no value), person      |
| Signed-in session | Approve           | Let {agent} use your signed-in {Site}                 | Let Claude Code use your signed-in Woolworths        | agent                         |
| Private network   | Approve           | Let {agent}'s scratch browser reach your home network | Let Claude Code's scratch browser reach 192.168.1.20 | agent                         |
| Connect           | Approve           | Did you just add Valet to an agent?                   | Did you just add Valet to an agent?                  | person (started in a browser) |
| Confirm           | Approve each use  | Confirm: {Tool} ({Site})                              | Confirm: Check out (Woolworths)                      | agent                         |
| Pair              | Approve, Mac only | Pair a new device                                     | Pair a new device                                    | person                        |
| Login needs you   | (hand-off)        | Log in to {Site} ({reason})                           | Log in to Woolworths (verification check)            | Valet                         |

- **Install titles** name the registrable domain from Valet's diff; the agent's display name is
  quoted. A draft reaching more than one registrable domain says "for 2 sites: yahoo.com,
  example.net". The version is in the kind strip. Updates and restores keep the installed name.
- **Tool titles** are the approved adapter's display names, so they may appear on cards, but never in
  notifications (security model, Notifications): the notification says "Turn on a Yahoo Finance tool
  for Claude app".
- **Setting** requests from an agent never carry a value. The card shows the choices from the
  adapter's own list for what the person types on the card (security model, Adapter settings,
  Enforced). The store is a Setting (R8).
- **Confirm** shows the cart, store or fulfilment slot, total and payment method as Valet read them,
  bound into the payload (R20).

**Notify only** (no card; one row in Activity, Changes, with Undo; one quiet notification without
actions, grouped per agent per hour): a draft started or saved; an agent turning a tool off for
itself; an agent disconnecting itself; a site uninstalled (Restore available for 24 hours, R24).

**Never Notify only, whatever the direction** (R6): anything that deletes or shortens evidence
(trace or audit retention down, history deleted, audit export off), turning off a repair or
approval notification. These are Setting cards. The audit log can't be shortened by anyone but the
person at the Mac.

**Agents can never:** approve or undo anything (no `valet_undo` tool); change another agent's
capabilities, tools or settings (R24, R57); change their own capabilities; change approval policy;
pair, unlock or reset.

**Limits:** at most 10 Notify-only changes per agent per hour, then refused (R57). Undo has the
tier of the change it makes: undoing a stricter change is a loosening and needs the matching
gesture. Undo is off while Locked down (R7).

**No approval, no notification:** reads (scoped to the agent's own activity unless it has "All
agents' activity", R27), scratch-browser authoring, offline test runs, paced live trials of a
draft's read tools on its declared hosts. Live trials are their own tier (F): they need Ask for
changes, run signed out by default, and are paced with the site's own adapters; a trial of the
submitted files is listed on the card under Checks Valet ran. The scratch browser and live trials never reach loopback,
private, link-local, CGNAT or tailnet addresses, or `.local` names (the rules in `docs/relay.md`);
that takes a Private network card (R21).

**Repairs behind the sign-in.** When the page that broke is only reachable signed in, the
reproduction check may run as a signed-in live trial instead of on recorded fixtures. The check
line then reads: "Repair R-4E1C: in a signed-in trial, the installed version fails as it did, and
this one works."

**The site's host beside an install title.** The title names the registrable domain ("for
yahoo.com"). On the Mac's Review page and the phone card's Details, the site's own host sits next to
it ("Site: finance.yahoo.com"), because agents in F's evals found the domain alone confusing
("for example.test").

## 4. Risk line templates

Valet computes the facts over the parent and every ticked follow-on, shows the strongest, and adds
"and n more risks" when others apply. "New hosts" means hosts outside the registrable domain in the
title, so hosts under yahoo.com don't make a Yahoo Finance install caution (R4).

| Condition                                           | Risk line                                                                     |
| --------------------------------------------------- | ----------------------------------------------------------------------------- |
| Runs without the sandbox                            | (strong) Runs without the sandbox: it can reach anything you can on this Mac. |
| Adds a local data exception                         | (strong) Can read {path} on your Mac.                                         |
| Adds or moves where a login is typed                | (strong) Changes where your {Site} password is typed.                         |
| Adds an irreversible tool, or a side effect goes up | (strong) Adds a tool that can't be undone. You'll still confirm each use.     |
| Confirm                                             | (strong) Orders {n} items for {total} from {store}. This can't be undone.     |
| Signed-in session                                   | (strong) Claude Code can act as you on woolworths.com.au until {time}.        |
| Private network                                     | (strong) Can open {address} on your home network.                             |
| Connect                                             | (strong) Only approve if you started this. Type the code the page shows you.  |
| Hosts outside the title's domain                    | (caution) Also reaches {host}, which isn't part of {domain}.                  |
| Adds a write tool, or turns one on                  | (caution) Can change things on {Site}.                                        |
| Turns on remote use                                 | (caution) {agent} could use it from anywhere.                                 |
| Setting that loosens or deletes evidence            | (caution) {Plain sentence of what is now allowed or removed}.                 |
| Not linked to anything Valet knows                  | (caution) Not linked to anything Valet knows about.                           |
| Install, reads only, no login, only its own domain  | (neutral) Reads {domain}. No login. Can't change anything.                    |
| Update with no permission changes                   | (neutral) No new permissions. Code and tests only.                            |
| Choose a setting from the adapter's list            | (neutral) You choose; Claude only asked.                                      |
| Restore that widens nothing                         | (neutral) Back to a version you approved on {date}. Nothing new.              |

## 5. Change rows

| Row type    | Example                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------- |
| Host        | **Adds** `query1.finance.`**`yahoo.com`** · reads only                                      |
| Login       | **Uses** 1Password item "Woolworths" · typed only on `auth.`**`woolworths.com.au`**         |
| Login moved | **Moves** where your password is typed: `/login` → `/signin` on `auth.woolworths.com.au`    |
| Tool        | **Adds** "Get quote" · read · no confirm                                                    |
| Local use   | **Usable at once by** Claude Code, Claude Desktop (this Mac): read tools only (R40)         |
| Remote use  | **Stays on** "Search products" for Claude app (shown when an update keeps a remote tool on) |
| Local data  | **Adds** read access to `~/Documents/Receipts/` (sandbox exception)                         |
| Sandbox     | **Turns off** the sandbox for this site                                                     |
| Setting     | **Changes** trace retention: 14 days → 3 days                                               |
| Session     | **Opens** your signed-in Woolworths to Claude Code for 30 minutes                           |
| Replaced    | **Why it was replaced**: repair R-4E1C (Restore cards, R55)                                 |
| Unchanged   | **Same** login, hosts, other tools                                                          |

Write and irreversible tools of a new install are off for local agents until a Local tool card
turns them on, as for remote agents (R40). If an update raises a tool's side effect, every remote
and local enablement of that tool turns off and the Update card says so (R24).

## 6. The approving gesture

| Card                                                                                                                                                   | iPhone                               | Mac with Touch ID | Mac without Touch ID |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ | ----------------- | -------------------- |
| Every card the phone can answer (Install, Update, Restore, Login, Remote or Local tool, Setting, Signed-in session, Connect, Private network, Confirm) | Face ID, or **Use passcode instead** | Touch ID          | Mac account password |
| Remove a device                                                                                                                                        | Face ID, or **Use passcode instead** | Touch ID          | Mac account password |
| Pair, Unlock, Reset, approval policy (Settings, Approvals)                                                                                             | Not on the phone                     | Touch ID          | Mac account password |

- **The passcode always works** (Nick, 2026-11-12, recorded by B in PR #86). On every card the phone
  can answer, the phone's passcode can stand in for Face ID, as it does everywhere else on an
  iPhone. Nick accepts the risk that a thief who has watched the passcode can approve; the defences
  left are the Mac-only list below, removing a lost phone (J7 F2) and iOS Stolen Device Protection,
  which iOS applies on its own terms.
- "Use passcode instead" is an explicit button on every card, for everyone, and the approval
  records which gesture was used (`iphone:faceid` or `iphone:passcode`). This also answers the
  accessibility question (R35): someone who can't use Face ID approves with the passcode.
- On a Mac without Touch ID, the system password prompt replaces the old typed-fingerprint
  fallback; secure input can't be synthesised by a process with Accessibility permission (R14).
- The approve button names its gesture: **Approve with Face ID**; Confirm cards name the tool:
  **Check out with Face ID** (R68).
- The answered card says which gesture was used: "Approved with Face ID on Nick's iPhone".

## 7. Names an agent can't fake

- The install title is the domain (section 3). A draft's display name that matches an installed
  site, or a well-known brand Valet's list ties to a domain, but whose hosts don't match gets the
  title "Install "{name}" for {domain} (the name doesn't match)" with a strong risk line, and the
  "I've read" tick (rule 11).
- A draft can't take an installed site's name unless it is an update of that site.
- Tool titles are capped at 40 characters, plain text, and checked for safety words ("safe", "read
  only") that contradict the declared side effect.

## 8. Follow-ons and request limits

- **Only one kind may follow on:** a Remote tool request for a tool of the parent adapter, for the
  requesting agent. Valet checks the tool belongs to the parent; the agent's claim of dependency
  isn't trusted. Everything else is its own card (R5). A Login for a new adapter is its own card
  that "Waits for" the install.
- **Follow-ons are never pre-ticked.** Each write tool has its own caution line under its tick box.
  A ticked follow-on that is stronger than the parent raises the card's risk line and tone.
- **At most 3 waiting requests per agent, and 5 across all agents** (follow-ons count with their
  parent), and 20 per agent per day. Further requests are refused with a tool result.
- **Three declines from one agent within an hour pause its requests for the hour.** A decline with a
  note doesn't count, unless the person picks "Decline and stop asking". A second pause in a day
  turns the row into "Revoke Claude app?" (R31).
- Lock down declines every waiting request.
- Two agents may each submit a fix for the same repair; the second card says "2 fixes for R-4E1C"
  and links to the other, so the person compares them (R41).

## 9. Card states

| State                | When                                                               | What the card shows                                                                                                                                                                             |
| -------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Waiting              | Normal                                                             | Full card, both buttons.                                                                                                                                                                        |
| Mac offline          | The Mac hasn't been seen for 2 minutes                             | "Mac last seen 7:39 pm". Approve says "Your Mac is offline. You'll be told when it's back." (R28)                                                                                               |
| Waits for another    | Depends on a request not yet approved                              | "Waits for: Install "Yahoo Finance" for yahoo.com" with a link; Approve disabled.                                                                                                               |
| Checking             | After the gesture                                                  | "Sending to your Mac…"; buttons disabled.                                                                                                                                                       |
| Not confirmed yet    | The Mac hasn't acknowledged within 30 s                            | "Not confirmed yet. If your Mac gets it by 7:43 pm it will be used; after that it won't." **Check again** resends the same signed approval (same nonce), which the Mac treats as one (R9, R10). |
| Approved             | The Mac applied it                                                 | "Approved with Face ID on Nick's iPhone at 7:41 pm", what Valet did, and "Claude app will see this the next time it checks Valet." **Back to Claude** (R23).                                    |
| Already approved     | A resend reached a Mac that had already applied it                 | Same as Approved.                                                                                                                                                                               |
| Declined             | Either device                                                      | "Declined on … at …" and the note, if any.                                                                                                                                                      |
| Not used             | Another device answered first                                      | "Declined on Nick's MacBook Pro first. Your approval wasn't used." (R29)                                                                                                                        |
| Expired              | 24 h for adapter kinds; deadline for Confirm and Connect           | "Nobody answered by …, so nothing changed."                                                                                                                                                     |
| Replaced             | The agent submitted a newer version                                | "Claude Code replaced this with a newer draft." + **See the new one**.                                                                                                                          |
| Changed while open   | Payload hash changed between render and gesture                    | "This changed while you were reading it. Nothing was approved." + **See what changed**.                                                                                                         |
| Refused by the Mac   | Signature, device or nonce failure (never a duplicate)             | "Your Mac didn't accept this approval. This iPhone may have been removed from Valet."                                                                                                           |
| Locked down          | Lock down while waiting                                            | "Declined: you locked Valet down at …".                                                                                                                                                         |
| Changed before order | Confirm only: the cart, store, total or payment differ at run time | "Your trolley changed after you confirmed. Nothing was ordered." (R20)                                                                                                                          |

## 10. Notifications

- **No action buttons, no reply field.** A tap opens the card (security model, Notifications,
  Enforced). Undo and Decline live in the app (R7, R37).
- **Title:** the app's own wording plus the site name or host, never a tool title or the agent's
  words: "Install an adapter for yahoo.com", "Turn on a Yahoo Finance tool for Claude app",
  "Check out on Woolworths: can't be undone".
- **The relay sees only "Valet needs you".** The real title and body are inside the encrypted
  payload the notification extension decrypts; if it fails, iOS shows the generic text (R38).
- **Lock screen:** title only, unless the person allowed previews.
- **Grouping:** one thread per agent; Notify-only changes group as "Claude Code made 3 changes".
- **Time-sensitive:** only Confirm, Connect and the login hand-off.
- **Mac back online:** "Nick's MacBook Pro is back online. 2 requests are waiting." (R28)
- Requires "Require Face ID to open Valet" (on by default) before any card opens on the phone, and a
  privacy cover in the app switcher (R51).

## 11. What the agent is told (the same request, as a tool result)

The agent gets an answer on its next call of any `valet_` tool, not only `valet_get_approval`
(R23). Tool results name the devices that exist: "on their iPhone and Mac", or "in Valet on their
Mac" without a phone (R36). They never contain the person's name or site text.

| Moment            | Tool result text                                                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Request made      | Waiting for the person in Valet: "Install "Yahoo Finance" for yahoo.com" (approval 7B3F). Nothing changes until they answer. Requests expire after 24 hours. |
| Still waiting     | Still waiting: approval 7B3F, asked 12 minutes ago. The person was notified on their iPhone and Mac.                                                         |
| Approved          | Approved by the person at 7:41 pm: approval 7B3F. Yahoo Finance 1.0.0 is installed; its tools are listed now. Also approved: "Get price history" for you.    |
| Declined          | Declined by the person at 7:41 pm. Their note: "Don't add query2, query1 is enough." Nothing changed.                                                        |
| Expired           | Nobody answered approval 7B3F in 24 hours, so nothing changed. Ask the person before asking again.                                                           |
| Replaced          | Approval 7B3F was replaced by 8C01 when you submitted a newer draft.                                                                                         |
| Too many waiting  | Not asked: you already have 3 requests waiting for the person. Wait for an answer, or withdraw one with `valet_withdraw_approval`.                           |
| Paused            | Not asked: the person declined 3 of your requests in the last hour, so Valet won't send more until 8:40 pm.                                                  |
| Setting asked     | The person was asked to choose the Woolworths store in Valet. You'll see "store set" on your next call once they have; Valet doesn't tell you which store.   |
| Approving refused | Agents can't approve requests. Only the person can, in Valet on their Mac or iPhone.                                                                         |

## 12. Where each card can be answered

| Card                                                                                                                        | iPhone                      | Mac |
| --------------------------------------------------------------------------------------------------------------------------- | --------------------------- | --- |
| Install, Update, Restore, Login, Remote and Local tool, Setting                                                             | Yes                         | Yes |
| Signed-in session, Private network, Connect                                                                                 | Yes                         | Yes |
| Confirm                                                                                                                     | Yes                         | Yes |
| Remove another device                                                                                                       | Yes (never the last device) | Yes |
| Pair a new device, Unlock after Lock down, Reset Valet, change the 1Password account, approval policy (Settings, Approvals) | No                          | Yes |

**A lost phone, away from the Mac** (R1): at pairing, Valet shows a recovery code to save in
1Password. On the relay's web page, the code can do two things only: lock down at the relay, and
remove a device. It can never approve anything. B to design (for B).
