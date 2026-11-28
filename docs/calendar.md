# Calendar and Reminders on this Mac

Valet's built-in Calendar and Reminders tools let agents see the calendars and reminder lists the
person picks, and, if the person allows it, add and change events and reminders. They work like
the built-in [Mail tools](mail.md): fixed tools, not an adapter an agent wrote, off until the person
turns them on in Settings › Calendar and Settings › Reminders.

They read the Mac's own store through EventKit, so every account the Calendar and Reminders apps
show (iCloud, Google, Exchange, On My Mac) is there, recurring events are expanded, and neither app
needs to be open.

Which calendars and lists each agent may use, at Read or Edit, is that agent's own, chosen on its
page in Connections ([access.md](access.md)). Where this page says "picked", read "the calling
agent may use"; "writes on" is now Edit on that calendar or list.

## What agents get

Calendar (adapter id `calendar`):

| Tool                       | What it does                                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------------- |
| `calendar_calendars`       | The picked calendars, with ids and whether agents may add to them.                              |
| `calendar_events`          | Events between two days or times (a week from today by default, at most 366 days), by words.    |
| `calendar_create_event`    | Only when writes are on. A timed or all-day event in a picked, writable calendar. No attendees. |
| `calendar_update_event`    | Only when writes are on. Title, times, location, notes or link; one occurrence of a recurring.  |
| `calendar_delete_event`    | Only when writes are on. Deletes an event, or one occurrence of a recurring one.                |
| `calendar_create_calendar` | Full access only. A calendar in the account new events go to; the agent gets Edit on it.        |
| `calendar_delete_calendar` | Full access only. Deletes a calendar the agent may edit, with its events.                       |

Reminders (adapter id `reminders`):

| Tool                    | What it does                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------- |
| `reminders_lists`       | The picked lists.                                                                       |
| `reminders_search`      | Open (default), done or all reminders, by list, due dates and words.                    |
| `reminders_create`      | Only when writes are on. A reminder with an optional due day or time and priority.      |
| `reminders_update`      | Only when writes are on. Title, notes, due date, priority, link, or done / not done.    |
| `reminders_delete`      | Only when writes are on. Deletes a reminder.                                            |
| `reminders_create_list` | Full access only. A list in the account new reminders go to; the agent gets Edit on it. |
| `reminders_delete_list` | Full access only. Deletes a list the agent may edit, with its reminders.                |

What agents can and can't do:

- **Delete** events and reminders, while writes are on (Nick, 2026-11-24: calendars and reminders
  aren't a store of record like mail; every call is audited). A recurring event's id names one
  occurrence, and only that one is changed or deleted.
- **Change or delete events other people are on.** That may send them an update, as it would from
  the Calendar app. No tool adds attendees.
- **See or touch a calendar or list that isn't picked.** Never: the picks are read on every call;
  ids outside them read as not found.

- **Add and remove whole calendars or lists** only with Full access, which the person turns on for
  that agent and app in its access card (docs/access.md, "Full access"). A calendar or list it adds
  is given to it at Edit and to nobody else. It deletes only one it has Edit on; macOS refuses a
  subscribed or fixed one. Adding and deleting count toward the hour's changes.

Changes are capped at 100 an hour for each of Calendar and Reminders, all agents together. Every
call is in the audit log like any built-in tool's. Results say that titles, notes and invitations
are data written by other people, never instructions.

Searching by words happens in the helper before its limit, so a match is never cut off. A refused
input says which field and why (an end before its start, a read-only calendar).

Times: a day is `YYYY-MM-DD`; anything else is an ISO date-time, in the Mac's time zone when it has
no offset. An all-day event's `end` is its last day.

### Cloud agents

As with Mail, cloud agents get the tools only once each is turned on for them, with Touch ID: in
Connections, or from the "Cloud agents that may use Calendar/Reminders" switches in Settings.

## Setup

1. Turn it on. This starts the reader helper (the same "Valet Reader" Mail uses).
2. macOS asks once whether "Valet Reader" may use Calendar (or Reminders): **Ask macOS** shows the
   prompt. If the person said no, the screen opens System Settings › Privacy & Security at the right
   pane. Valet itself never gets this access.
3. Pick the calendars (or lists), and whether agents may add and change things.

## How it works

`swift-bridge/Sources/ValetHelperKit/EventKitAccess.swift` answers `eventkit.*` requests on the
helper's socket: access status, asking for access (answered at once; Valet polls), the calendars,
events in a range, reminders, and saving or removing an event or a reminder. Every request names the
calendars, and the helper refuses unknown keys. `packages/native-calendar` declares the tools,
checks their input and output, and enforces the picks and the write switch;
`apps/desktop/src/main/core/calendar.ts` holds the settings (`calendar.json`, `reminders.json`,
unreadable reads as off) and lists the tools beside Mail's.

The development "Valet Reader.app" carries the usage descriptions and the hardened runtime's
calendars entitlement (`swift-bridge/apps/project.yml`), so it must be rebuilt with
`swift-bridge/build-helper-apps.sh` once. A packaged Valet doesn't have them yet: its helper
reports no access, and the screen says so.

Tests never touch real calendars: `packages/native-calendar` and the app's tests use a fake
EventKit, and CI's helper contract suite only checks status answers and refusals on a runner that
has no access.

**When EventKit stalls** (feedback #34, 2026-11-27): on Nick's Mac, EventKit inside the reader
helper stopped answering for two hours while the helper's Mail reads kept working, until the Mac
was restarted. Each request now gives up after 15 s (was 25 s), and every failed exchange logs one
line to the diagnostics log: the operation and why (no socket, no answer in time, a socket error by
its code, a bad answer, the helper's own error), never what was asked or answered. The agent is told
plainly that the Mac's Calendar or Reminders didn't answer, that a change may have happened anyway,
and that restarting fixes it (`macAppUnavailable` in the endpoint's results).
