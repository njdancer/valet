# Brief: fewer switches for giving agents access

Status: for discussion. Nothing here is decided or built. Written 2026-11-25 after Nick set up
Calendar and Reminders (PR #221, #222) and found it "pretty laborious". Read this before talking it
through with Nick, then turn whatever he settles into numbered decisions in [plan.md](../plan.md).

## What Nick asked for (2026-11-25)

1. **Fewer approvals and switches.** "Our UX is being too careful and requiring too many approvals
   and things to be turned on at multiple levels."
2. **Select all** in the calendar and reminder-list pickers.
3. **Read and/or edit access per calendar or list**, instead of one write switch for all of them.
   Probably the same per Mail account. Per mail folder "might be too much"; open question.
4. **A full-access option**: agents may also add and remove calendars and lists themselves, so
   they can help with how things are organised, not just with what's in them.

## What setup takes today

Calendar, for one cloud agent (Reminders is the same again; Mail is similar):

| Step | Where                              | What the person does                                                                        |
| ---- | ---------------------------------- | ------------------------------------------------------------------------------------------- |
| 1    | Settings › Calendar                | Turn Calendar on (starts Valet Reader).                                                     |
| 2    | macOS                              | Ask macOS, then allow "Valet Reader" to use Calendar.                                       |
| 3    | Settings › Calendar                | Tick each calendar one by one; there's no select all.                                       |
| 4    | Settings › Calendar                | Turn on "add and change" (one switch for all picked calendars).                             |
| 5    | Settings › Calendar › Cloud agents | Turn the agent's read switch on: Touch ID **twice** (one per read tool).                    |
| 6    | Same                               | Turn the agent's "Add and change" switch on: Touch ID **three times** (one per write tool). |

So Calendar plus Reminders for one cloud agent is two app switches, two macOS prompts, two lists of
ticks, two write switches and **ten Touch ID prompts**. A second agent means ten more. Mail adds
Full Disk Access, a drafts switch, an organising switch and its own per-tool Touch IDs.

Where the layers come from:

- **App on/off + picks + write switch**: `apps/desktop/src/main/core/calendar.ts` keeps
  `{ enabled, calendars, writes }` per app ([calendar.md](../calendar.md)). Mail has the same plus
  drafts and organising ([mail.md](../mail.md)).
- **Per-tool remote switches with Touch ID**: the per-tool remote policy in
  [relay.md](../relay.md#per-tool-remote-policy): tools are local-only until turned on one by one,
  `write` tools "with the side effect spelled out". The Touch ID per tool comes from
  `CloudAgents` in `apps/desktop/src/renderer/screens/settings/EventKitSection.tsx`, which calls
  `remote.setClientTool` once per tool; each is its own signed `tool-enable` after Touch ID
  (`setRemoteClientTool` in `apps/desktop/src/main/core/service.ts`). Turning off needs none.
- **macOS prompts and Full Disk Access**: macOS's own and unavoidable, but asked once ever per helper.

## Options to discuss

### A. One Touch ID per change of access, not per tool

The switch the person flips already names what they're granting ("see the events", "add, change
and delete events"). Ask Touch ID once for that switch and grant all the tools behind it in one
signed change. Same security: Touch ID still proves the person is there for every widening of
access. Calendar plus Reminders for one agent drops from ten Touch IDs to four, or to one with B.

The remote policy store may need a batch "set these tools" call so one Touch ID covers it, and the
audit then records one grant with a list of tools.

### B. One screen or preset for "what this agent may do"

Instead of switches on three settings pages, an agent's page in Connections could show the built-in
apps together (Mail, Calendar, Reminders) with None / Read / Read and change per app, and one
Touch ID to save. Possibly presets: "Read only", "Assistant (read, draft, add and change)",
"Full access".

### C. Merge the app-level write switch into the per-agent grant

Today "agents may add and change" is set both per app (step 4) and per agent (step 6). One of
them could go: e.g. the app page only says which calendars exist for agents and at what level
(see D), and each agent's grant says whether that agent may use the write level. Or the reverse:
local agents follow the app level, cloud agents follow it too once approved, with no separate
switch. Worth asking Nick which of the two he actually thinks of as "the" setting.

### D. Per calendar, list and account: Hidden / Read / Read and change

Replace the ticks plus the single write switch with a level per item, and a select all (or "all
at this level") at the top. New calendars and lists: ask Nick whether they default to hidden or
follow a "new calendars" row.

- Calendar and Reminders: EventKit gives each calendar an id and whether it's writable at all, so
  this is a settings and enforcement change in `packages/native-calendar` (the picks are already
  checked on every call). Read-only-by-macOS calendars (holidays, subscriptions) show Read at most.
- Mail: per account, Hidden / Read / Read and draft / Read, draft and organise. Per mailbox is
  possible (mailbox ids are already in `mail_accounts`) but Nick thought it might be too much;
  suggest per account now, per mailbox later only if he asks.

### E. Full access: manage calendars and lists themselves

New tools: create, rename, recolour and delete calendars and reminder lists (EventKit
`EKCalendar` save and remove, in a source the person allows, e.g. iCloud). Things to settle:

- Is it its own level above "Read and change", granted per account/source? (Suggested: yes, off by
  default, Touch ID to turn on.)
- Deleting a calendar or list deletes everything in it, and EventKit has no undo. Options: always
  ask on the Mac for deletes (the D46 pattern for irreversible confirmations), or allow it with a
  snapshot of the contents kept in Valet so Activity can "Put back", as Mail moves do.
- A calendar an agent creates: visible to agents automatically at the level that created it?
  (Probably yes, or the agent can't use what it made.)
- Calendars shared with other people: renaming or deleting affects them too. Exclude shared ones,
  or warn in the tool result?
- For Mail, the equivalent would be creating and removing mailboxes (folders). Ask whether he
  wants that too.

## Suggested order

1. Select all in the pickers (small, no design question).
2. A: one Touch ID per switch (biggest cut in effort, keeps the security model).
3. D: levels per calendar, list and account.
4. B and C together, as one redesign of an agent's access.
5. E: full access, once Nick has answered the delete question.

## Questions for Nick

1. Is one Touch ID per change of access enough, or would he rather have none at all for read access
   and Touch ID only for writes?
2. Which write setting is the real one: per app, or per agent? (C)
3. Per mail account enough, or per mailbox too? (D)
4. New calendars and lists: hidden until picked, or a default level? (D)
5. Full access: may agents delete a whole calendar or list without asking on the Mac? Shared
   calendars in or out? Mailboxes too? (E)
