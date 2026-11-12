# Personas for agent-run Valet

Workstream A of [`docs/plan-agent-run.md`](../../plan-agent-run.md) (PR #70). These add to the seven
personas in [`../personas.md`](../personas.md), which still hold: P1 to P7 walk every journey here
too. Like those, these are assumptions written from the plan and Nick's direction of 2026-11-12, not
research with real people.

The plan changes who does the work. Before, a person configured Valet in its window and an agent
only called site tools. Now the person installs, grants and pairs once, and their **agents** do the
configuring, the adapter writing and the repairs through Valet's own MCP tools, while the person
approves from wherever they are, usually a phone. So there are two new people and two new kinds of
actor:

| ID  | Persona or actor                           | One line                                                                             | Primary surfaces                                     |
| --- | ------------------------------------------ | ------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| P8  | Riley, the phone-first owner               | Set Valet up on a Mac at home once; runs everything else from an iPhone              | iOS app: Needs you, approval cards, notifications    |
| P9  | Claude as Valet's administrator and author | The person's own agent, using `valet_` tools to inspect, configure, write and repair | Tool results, approval states, the draft workspace   |
| X1  | A hostile web page                         | Text on a site the agent reads while authoring or calling tools                      | Scratch browser, tool results, the agent's summaries |
| X2  | A rogue or hijacked agent                  | A connected agent that has turned against the person, or was never theirs            | Every `valet_` tool, approval requests               |

X1 and X2 are not users. The adversarial reviews walk them through each journey to check that every
change they could cause still reaches the person as an honest approval card.

## How the old personas change

- **P1 Nick** now spends most of his Valet time in the phone app and in Claude, not in the window.
  He still wants depth (diffs, traces) one tap away, and the window for long reviews at the desk.
- **P2 Sam** may never install the phone app. Valet has one owner, so Sam's phone isn't an approver;
  if Sam ever answers a card on the Mac, it has to be safe for someone who reads only its first line.
- **P3 Morgan** now cares about who asked for each change, which device approved it, and whether
  an agent could approve its own request. Every card and audit record must answer those three.
- **P4 Alex** mostly stops typing adapter code. Their agent writes it; Alex reviews drafts, test
  runs and diffs, on the Mac for big changes and on the phone for repairs.
- **P5 Jordan** uses VoiceOver on iOS as well as macOS. Cards must read in a sensible order with
  rotor headings and Magic Tap. Face ID works with VoiceOver, and "Use passcode instead" is
  on every card.
- **P6 Claude (calling agent)** is now also P9. The calling side is unchanged; P9 covers the admin
  and authoring side.
- **P7 Nick away** mostly becomes P8: the phone is where the approval happens, so walking back to
  the Mac is the exception (a CAPTCHA, J6), not the rule.

## P8. Riley, the phone-first owner

- **Who:** a household member or a solo user who keeps an old Mac mini (or a MacBook left open) at
  home, set Valet up there in one sitting with their agent's help, and has not sat at that Mac
  since. Uses the Claude app on an iPhone for nearly everything. Comfortable with 1Password and
  Face ID; not a developer. They/them.
- **Goals:** ask Claude for something ("add Yahoo Finance", "why did the order fail?") and only be
  interrupted for the decisions that are really theirs; answer each one in under a minute,
  one-handed, on the train; trust that a "yes" on the phone can't be faked by anyone else.
- **Frustrations to expect:** a card that says "Approve?" without saying what changes; a card that
  needs the Mac ("open Valet on your Mac to continue") with no way to finish or defer from the
  phone; long technical diffs; five notifications for one task; not knowing whether the Mac at home
  is even awake; a request they didn't start that looks exactly like one they did.
- **Mental model:** "Valet is the thing at home that lets Claude use websites for me, and my phone
  is its doorbell". Thinks in tasks ("the Yahoo thing Claude made"), not in adapters, versions or
  hashes. Expects Face ID to mean "I'm sure", as in their banking app.
- **Tech:** average to good. Thumb first. Reads the title and the first two lines, then the button.
- **Constraints:** an iPhone at 393 x 852 points, often with larger text; patchy mobile data; the Mac
  may be asleep, off, or on a flaky home connection; the Mac may be a long way away for days.
- **Key scenarios:** pair the phone during setup (J1); approve a Yahoo Finance adapter Claude wrote
  (J3, J4); approve a repair after the site changed (J5); a login check while on holiday (J6);
  lock everything down after a weird notification (J7); ask Claude to change the store (J8).

## P9. Claude as Valet's administrator and author

- **Who:** the person's own agent (Claude Code or Claude Desktop on the Mac, or Claude on claude.ai,
  the phone or a cloud agent through the relay), connected to Valet with admin and authoring tools
  as well as site tools. Not Valet's agent: Valet has no built-in chat (D82).
- **Goals:** do what the person asked in one go: find out Valet's state, change what it may change,
  write and test an adapter, and get the person's approval with as little of their attention as
  possible. Know at every moment whether it is waiting on the person, and for what.
- **What it needs from Valet:**
  - status and history it can read without asking (the "No approval" tier), worded the same way
    the app words it, so it can tell the person "Valet shows Woolworths as 'limiting requests'";
  - every change it asks for returned as an **approval request with a stable ref and title** that
    match the card the person sees, plus a way to wait for or check the answer;
  - a decline that carries the person's own note, so it can fix the draft and try again without a
    second conversation;
  - clear refusals for things it may never do (approve, read a secret, use the signed-in session
    without approval), each saying what to ask the person for instead;
  - page text from sites always marked as data, never mixed into Valet's own words.
- **Frustrations to expect:** approval requests that vanish without an answer; not knowing whether
  the person saw the card; an approval that only works if the person is at the Mac; a tool that
  silently changed nothing because the setting was already set.
- **Key scenarios:** "add an adapter for Yahoo Finance" (J3); "the Woolworths search broke, fix
  it" (J5); "turn on the quote tool for my phone" and "change my store" (J8); explain a failed call
  (J8); relay a login check it can't do (J6).

## X1. A hostile web page

- **What it is:** any text the agent reads from a site: a product description, a review, an error
  page, a hidden element in the DOM snapshot, or the README and comments of a reference adapter
  someone published (D75: references are read, never installed).
- **What it wants:** to make the agent ask for something the person wouldn't knowingly approve: a new
  egress host, a secret typed on another origin, a sandbox exception for `~/Documents`, a tool whose
  side effect is understated, a logged-in authoring session, a remote-enabled write tool. Or to make
  the card lie, by getting its own words into the card's title or "what changes" lines.
- **What the design must guarantee:** a card's title, risk line and change rows come only from Valet's
  structured diff, never from text the agent or a page wrote. The agent's reason appears once,
  labelled as the agent's words, after the facts. Hosts, paths and origins are shown in full, never
  shortened in a way that hides a look-alike (`woolworths.com.au.example.net`).

## X2. A rogue or hijacked agent

- **What it is:** a connected agent acting against the person: steered by X1, a cloud agent someone
  else connected (the consent phishing case in `docs/relay.md`), or a local process pretending to be
  an agent.
- **What it wants:** to approve its own request (a synthetic tap, a written approval file, a replayed
  signature); to wear the person down with a stream of requests until they tap Approve without
  reading; to time a request to look like one the person just asked for; to hide behind another
  agent's name; to change things in the "Notify only" tier that add up to something worse.
- **What the design must guarantee:** no MCP tool can approve; every card names the requesting
  connection by the name the person gave it at connect time (not a name the agent chose); requests
  per agent are capped, and a capped agent is visible as such; any agent can be revoked from the
  phone in two taps; "Notify only" changes are capped per agent and undoable in Activity, Changes; one agent can never change another agent's tools or settings.
