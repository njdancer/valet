# The wireframes' story (one consistent world)

Every frame shows the same moment unless its note says otherwise: **Saturday 7 November 2026,
9:48 pm** in Sydney. Use these facts verbatim so counts, refs, names and dates agree across frames.

## Sites

- **Woolworths** 0.3.0 live. Comes with Valet. Approved Fri 6 Nov, 8:12 pm. Hash `9f3c…e0f1`.
  Store: Woolworths Town Hall. Login: Keychain copy of the 1Password item "Woolworths" (Personal
  vault), filled only on `auth.woolworths.com.au`; last re-synced Fri 6 Nov.
- **Woolworths 0.4.0** waiting for review since 9:20 pm. Made by the authoring agent in the IDE (not
  a Connections app). Adds 1 host (`api.woolworthsrewards.com.au`) and 1 read tool (Everyday
  Rewards balance). Hash `4b7e…a83c`.
- **Yahoo Finance** 1.2.0 and **Wikipedia** 0.2.1: come with Valet, no login. Yahoo Finance is
  limiting requests; calls resume at 9:52 pm.

## Apps (Connections)

- Claude Code and Claude Desktop: connected (2 apps). Cursor: revoked 3 Nov; it appears only in
  history (old calls, audit), never in "Called by", "Can reach" or app counts.
- Remote access: on (public name valet.example.com), no cloud agents approved yet. One cloud agent is asking to connect (see Needs you); a request can only arrive while remote access is on.

## Needs you at 9:48 pm: 4 waiting (menu bar icon badge 4, sidebar 4, "1 of 4" in the confirmation window)

1. Confirm: Remove from cart (Woolworths): call **7F2A** `remove_from_cart` from Claude Code, asked
   9:48 pm, ends 9:50 pm.
2. Approve a connection: asked 9:47 pm from 203.0.113.24, calls itself "Claude (claude.ai)" (not
   verified), ends 9:52 pm.
3. Log in to Woolworths (verification check): raised by call **9A71** `get_cart` from Claude Code at
   9:47 pm; login window open until 10:02 pm.
4. Review the Woolworths update (0.4.0): no deadline.

- Missed: Confirm: Remove from cart (Woolworths), call **5C10** at 6:10 pm, missed 6:12 pm.

## Calls

| Ref  | Time    | Site          | Tool             | App            | Outcome                  |
| ---- | ------- | ------------- | ---------------- | -------------- | ------------------------ |
| 7F2A | 9:48 pm | Woolworths    | remove_from_cart | Claude Code    | waiting for you          |
| 9A71 | 9:47 pm | Woolworths    | get_cart         | Claude Code    | needs you (login)        |
| 8F2E | 9:31 pm | Woolworths    | update_cart_line | Claude Code    | ok, 2 blocked            |
| 4C21 | 9:22 pm | Yahoo Finance | get_quote        | Claude Desktop | limited by site          |
| 6B3E | 8:05 pm | Woolworths    | search_products  | Claude Desktop | failed: site changed     |
| 5C10 | 6:10 pm | Woolworths    | remove_from_cart | Claude Code    | missed (nobody answered) |

Today, all sites: 37 calls, 2 failed, 12 requests blocked. Woolworths alone: 21 calls.

## Words (one form each)

- Button for any update: **Review update**. Needs you title: **Review the Woolworths update (0.4.0)**.
  First install: **Review Woolworths before first use**.
- Limiting: **"{Site} is limiting requests · calls resume at {time}"** (full site name).
- Login: button **Show login window**. Missing login: title **Give Valet your Woolworths login**,
  button **Choose login…**.
- Missed: **Missed: {original title}**, action **Ask Claude to try again…** (shows the sentence to
  send, with Copy; works when Claude is on a phone too).
- Cart words: tool titles as approved ("Remove from cart"); "trolley" only in **Open my trolley**
  (Woolworths' own word for its page).
- The author of an update is "the authoring agent (IDE)"; never a link to a Connections app.

## Setup

Six action steps: 1Password, Approve Woolworths, Login, Store, Connect Claude, Test it (plus
Welcome and Done). "Finish setup (N steps left)" counts action steps not done.
