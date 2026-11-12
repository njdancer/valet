# The agent-run wireframes' story (one consistent world)

Like [`../wireframes/story.md`](../wireframes/story.md), every agent-run frame shows one world.
Use these facts verbatim so names, refs, times and counts agree across journeys, frames and the
card spec. A frame that shows another moment says so in its first note, and uses the "Other
moments" below.

## When and where

**Thursday 19 November 2026, 7:40 pm** in Sydney. Nick is at a café with his iPhone. His MacBook
Pro is at home, open, awake and online. (J1 and J2 happened a week earlier, on Thursday 12 November
from 8:05 pm, at the Mac.)

## Devices (Connections, Devices on the Mac; Valet, Devices on the phone)

- **Nick's MacBook Pro**: runs Valet 0.9.0. Has Touch ID. Online through the relay since 7:02 am.
- **Nick's iPhone**: paired Thursday 12 November, 8:07 pm. Face ID. Notifications on. "Require Face
  ID to open Valet" on. Nick saved the recovery code shown at pairing in 1Password.
- No other devices. Pairing another starts at the Mac.

## Agents (Connections, Agents on the Mac; Agents on the phone)

Names are the ones Nick typed. Monograms: CC, CA, CD.

| Name               | What it is                                         | Badge             | Can                                                            | Connected      |
| ------------------ | -------------------------------------------------- | ----------------- | -------------------------------------------------------------- | -------------- |
| **Claude Code**    | Claude Code on the MacBook                         | This Mac          | Use tools · See Valet (all agents' activity) · Ask for changes | 12 Nov 8:20 pm |
| **Claude app**     | claude.ai connector, used in the Claude iPhone app | Through the relay | Use tools · See Valet (its own activity) · Ask for changes     | 12 Nov 8:31 pm |
| **Claude Desktop** | Claude Desktop on the MacBook                      | This Mac          | Use tools · See Valet                                          | 12 Nov 8:22 pm |

- Claude app's remote tools (6 can be turned on remotely before J3: Wikipedia's 3 tools,
  Woolworths' Search products, Get cart and Add to cart): **on** for Wikipedia's 3 tools and
  Search products. Nick ticked "Ask for changes" himself at connect (it's off by default for remote
  agents).
- Claude Desktop has no "Ask for changes", so it can't make requests. It is the example agent for
  the "isn't allowed" refusals.
- A cloud agent's claimed identity ("calls itself Claude (claude.ai)") and redirect host
  (`claude.ai`) are in Details only.

## Sites

- **Woolworths 0.3.0** live, built in. Store: Woolworths Town Hall. Login: Keychain copy of the
  1Password item "Woolworths". `search_products` started failing at 6:58 pm: **site changed**
  (stage `tool-output`, class `invalid`, twice, in two sessions). Repair **R-4E1C** opened 7:12 pm.
  Nick, still at home, pasted Valet's sentence into Claude Code at 7:14 pm and left for the café.
- **Woolworths 0.3.1** draft by **Claude Code**, submitted 7:31 pm: one selector and one output
  field mapping changed; no new permissions; Valet's reproduction check passed on a fixture
  recorded by Valet's scratch browser. 23 tests the agent wrote pass. Approval **2D9C**.
- **Wikipedia 0.2.1** built in, no login, ok.
- **Yahoo Finance**: not installed (Nick removed the built-in one earlier, so J3 starts clean).
  Draft by **Claude app**, started 7:24 pm, submitted 7:38 pm (call **1F07**). Display name
  "Yahoo Finance", version 1.0.0. Hosts `finance.yahoo.com`, `query1.finance.yahoo.com`,
  `query2.finance.yahoo.com` (all under yahoo.com). Tools: Get quote, Get price history, Search
  symbols (all read). No login. Sandbox on, no exceptions. Valet's checks: build, manifest, lint,
  live trial of Get quote (AAPL) ok at 7:36 pm (call **0E5D**). 14 tests the agent wrote pass.
  References read: `github.com/…/valet-yahoo`, `github.com/…/yf-adapter`, neither installed.
  Approval **7B3F**.

## Needs you at 7:40 pm: 2 waiting (iPhone badge 2, Mac menu bar 2)

1. **Install "Yahoo Finance" for yahoo.com** · asked by Claude app at 7:38 pm · approval **7B3F** ·
   expires Fri 20 Nov 7:38 pm. Follow-ons sent with it: **"Get quote"** (approval **5A20**) and
   **"Get price history"** (approval **5A21**) for Claude app, both unticked until Nick ticks them.
   Because: "Draft Yahoo Finance, started 7:24 pm".
2. **Update Woolworths to 0.3.1** · asked by Claude Code at 7:31 pm · approval **2D9C** · Because:
   "Repair R-4E1C: Search products is broken" · expires Fri 20 Nov 7:31 pm.

Notify only, earlier today (Activity, Changes):

- 7:24 pm Claude app **started a draft**: Yahoo Finance.
- 7:05 pm Claude app **turned off** "Add to cart" for itself. (Undo turns it back on, which is a
  loosening: Face ID.)

## Calls (relevant rows)

| Ref  | Time    | Site          | Tool / admin tool    | Agent          | Outcome                   |
| ---- | ------- | ------------- | -------------------- | -------------- | ------------------------- |
| 1F07 | 7:38 pm | Valet         | `valet_submit_draft` | Claude app     | waiting for approval 7B3F |
| 0E5D | 7:36 pm | Yahoo (draft) | live trial Get quote | Claude app     | ok (scratch, anonymous)   |
| 9B12 | 7:31 pm | Valet         | `valet_submit_draft` | Claude Code    | waiting for approval 2D9C |
| 6B3E | 6:58 pm | Woolworths    | `search_products`    | Claude Desktop | failed: site changed      |

## Other moments (later the same evening, for the journeys that need them)

| Time    | What                                                                                                                                                                                                                                                             | Journey |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 7:41 pm | Nick ticks both follow-ons and approves 7B3F with Face ID. Then approves 2D9C.                                                                                                                                                                                   | J3, J5  |
| 7:45 pm | Claude Code asks for a signed-in session to check the cart page: approval **5E31**, Because "Repair R-4E1C".                                                                                                                                                     | J5 F2   |
| 7:50 pm | Claude Code, steered by text it read on a page, asks "Let Claude Code use your signed-in Woolworths": approval **6E11**, "Not linked to anything Valet knows about", "Claude Code already has a signed-in Woolworths session, for Repair R-4E1C, until 8:15 pm". | J7      |
| 7:52 pm | Nick declines 6E11, revokes Claude Code, then locks down from the phone.                                                                                                                                                                                         | J7      |
| 7:50 pm | (a different evening) Claude app asks "Confirm: Check out (Woolworths)": approval **7F90**, call **3D41**, 17 items, $84.20, Woolworths Town Hall pick-up Fri 20 Nov 10–11 am.                                                                                   | J4      |
| 8:02 pm | Claude app asks to turn on "Search symbols" for itself: approval **9D02**.                                                                                                                                                                                       | J8a     |
| 8:05 pm | Claude app asks Nick to choose the Woolworths store: approval **3B77**. Nick types "Bondi" and picks Woolworths Bondi Junction.                                                                                                                                  | J8b     |

## Words (one form each; see information-architecture.md, Vocabulary)

- Card titles: **Install "Yahoo Finance" for yahoo.com**, **Update Woolworths to 0.3.1**, **Let
  Woolworths use your login**, **Turn on "Get price history" for Claude app**, **Did you just add
  Valet to an agent?**, **Let Claude Code use your signed-in Woolworths**, **Choose your Woolworths
  store**, **Confirm: Check out (Woolworths)**, **Pair a new device**.
- Approve buttons: **Approve with Face ID** (iPhone), **Approve with Touch ID** (Mac); the Mac
  password prompt on a Mac without Touch ID; Confirm names the tool: **Check out with Face ID**.
- Asked-by line: **Asked by Claude app · 7:38 pm** with its badge. Never "Claude says".
- The agent's reason: under **In Claude app's words**, quoted, after the facts.
- Answered elsewhere: **Approved on Nick's iPhone at 7:41 pm** / **Declined on Nick's MacBook Pro**.
- After approval: **Claude app will see this the next time it checks Valet.** Never "has been told".
