# iCloud Mail, read only (example)

An example of a `protocol` adapter: IMAP to iCloud Mail, with a **kept** credential (your iCloud
email address and an app-specific password, made at account.apple.com, Sign-In and Security,
App-Specific Passwords). Valet signs in itself; the tool code never sees the password.

- `inbox_overview`: how many messages INBOX holds, and how many are unread.
- `recent_mail`: the newest messages (at most 10): sender address, subject, date, and whether
  you've read it. Never a body.

It is deliberately narrow: INBOX only (`folders`), read tools only, envelopes only. Valet opens
INBOX with `EXAMINE` and fetches with `BODY.PEEK`, so nothing on the server changes and nothing is
marked read. It's the adapter for the first live check against a real mailbox
([docs/live-checks/icloud-mail-read.md](../../docs/live-checks/icloud-mail-read.md)).

Cases answer `ctx.imap` from an `imap` script: each step is the operation the tool makes next, its
arguments if the case checks them, and what the server answers. The runtime's own checks (purpose,
folders, the request ceiling) run first, as on a live call.

Start a draft from it with `valet_create_draft` (`from: "example"`, `example: "icloud-mail-read"`).
