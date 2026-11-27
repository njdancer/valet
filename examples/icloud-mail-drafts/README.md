# iCloud Mail drafts (example)

A `protocol` adapter that writes drafts to iCloud Mail over IMAP, with a **kept** credential: your
iCloud email address and an app-specific password, made at account.apple.com, Sign-In and Security,
App-Specific Passwords. Valet signs in itself; the tool code never sees the password.

Mail's own scripting can't save a draft's text without wrapping it in a quote block, so the
person's Mail app shows it indented and the sent message's plain part gets "> " on every line. This
adapter builds the whole message itself, with Valet's checked builder (the one `ctx.smtp` uses),
and appends it to Drafts, where Mail on every device opens it as a normal draft.

- `create_draft`: saves a new plain-text draft (To, Cc, Bcc, subject, body; for a reply, the
  original's Message-ID and references). Returns the new draft's `messageId`.
- `replace_draft`: saves a new version of a draft found by its `messageId`, then moves the old
  version to Deleted Messages. The new one is saved first, so a failure leaves both, never neither.

It never sends: IMAP can't send mail, and the adapter reaches only Drafts and Deleted Messages
(`folders`). Addresses are plain `local@domain` and the subject can't hold a line break, so no text
an agent passes can add a recipient or a header.

Start a draft from it with `valet_create_draft` (`from: "example"`, `example: "icloud-mail-drafts"`).
