# iCloud Calendar (example)

An example of an `http` adapter speaking CalDAV (WebDAV's PROPFIND, REPORT and PUT) to iCloud, with
a **kept** credential: the person's Apple ID and an app-specific password (made at appleid.apple.com,
Sign-In and Security, App-Specific Passwords). Valet adds the Basic header to each request for the
hosts the credential names; the tool code never sees the password.

- `list_calendars` discovers the account's calendar home and lists the calendars that hold events.
- `list_events` reads events between two times, from one calendar or all.
- `add_event` adds an event. Its id comes from what the event is, and the PUT says `If-None-Match: *`,
  so adding the same event twice changes nothing.

**Partition hosts.** iCloud keeps each account on its own server, `pNN-caldav.icloud.com`, which
discovery names. A manifest names exact hosts only, so this version names `p01-caldav.icloud.com`.
`list_calendars` says which server the account is on and whether this version can reach it; for
another server, a new version adds that host to `egress`, the credential's `hosts` and the requests,
and to `SERVERS` in `src/tools.ts`.

What it shows: WebDAV requests and multistatus answers (`src/dav.ts`, with `parseXml`), iCalendar
reading and writing (`src/ics.ts`: unfolding, escaping, UTC, local and all-day times), a kept
credential named per request, a write tool, and cases that run with a placeholder credential.
Tool code has no `URL` class in Valet's sandbox, so `splitHref` takes hrefs apart.

Start a draft from it with `valet_create_draft` (`from: "example"`, `example: "icloud-calendar"`).
