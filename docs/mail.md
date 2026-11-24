# Mail on this Mac

Valet's built-in Mail tools let agents search and read the mail that the Mac's Mail app already
keeps, and save drafts that the person reviews and sends from Mail. Valet never sends mail here.
(Sending, when it comes, is the SMTP path in [smtp.md](smtp.md).) These tools are built in and
fixed, not an adapter an agent wrote, and they are off until the person turns them on.

The reason for reading Mail's own store is search. Mail already indexes every account it syncs,
so Valet doesn't download mailboxes over IMAP or build an index of its own.

## What agents get

Once Mail is on and at least one account is picked, agents see these tools (adapter id `mail`):

| Tool                | What it does                                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------------------------------- |
| `mail_accounts`     | The picked accounts, their mailboxes, ids and unread counts.                                                    |
| `mail_search`       | Messages by words, sender, recipient, subject, mailbox, dates, unread, flagged, attachments. At most 50 a page. |
| `mail_read`         | One message: headers, text (HTML turned into text), links, attachments; in chunks. Or one attachment as text.   |
| `mail_thread`       | The messages in a message's conversation, up to 30.                                                             |
| `mail_create_draft` | Only when drafts are on. A new message or a reply, saved to Mail's Drafts from a picked account's address.      |
| `mail_move`         | Only when organising is on. Up to 50 messages to Archive, Trash, Inbox or another mailbox of the same account.  |
| `mail_mark`         | Only when organising is on. Up to 50 messages marked read or unread, flagged or unflagged.                      |

Every result says that mail is data and not instructions. Every call goes in the audit log like an
adapter's, with `builtin` in place of a package hash.

An account that isn't picked doesn't exist for agents: its messages are never returned, and a
message id from it reads as not found. The setting is read on every call, so un-picking an account
takes effect at once.

### Cloud agents

Agents on this Mac see the tools as soon as Mail is on. Cloud agents (remote access, the claude.ai
connector) see them only once each is turned on in Connections › Remote, as for any site's tools.
They are listed there while Mail is on; turning Mail off takes them away from every agent, and
they can still be switched off remotely.

## Setup (Settings › Mail)

1. **Turn it on.** This starts the reader helper.
2. **Start the reader.** In a packaged Valet the helper is a launch agent inside Valet.app,
   registered with `SMAppService`; macOS may ask the person to allow it in Login Items. In a
   development build it is "Valet Reader.app", made by `swift-bridge/build-helper-apps.sh`, which
   Valet opens with `open -g -j -a` so it is responsible for itself.
3. **Full Disk Access, for the reader only.** Mail's files are protected by macOS. The screen opens
   System Settings at Full Disk Access and can show the reader in Finder to drag in. Valet itself
   never gets Full Disk Access. The screen checks again every two seconds and moves on once the
   reader can read.
4. **Pick accounts**, and choose whether agents may save drafts.

## How reading works

Everything that touches Mail's files is in the reader helper (swift-bridge,
`MailAccess.swift`), the same helper that reads Messages for one-time codes. Valet asks it over its
Unix socket, which only Valet (same Team ID; any caller in a debug build) may use. It answers five
questions and refuses everything else:

- `mail.info`: which library folder is in use (the highest `V<n>` with an Envelope Index).
- `mail.query`: one read-only SQL statement on the Envelope Index or Accounts4.sqlite. A SQLite
  authorizer allows only `SELECT` from a short list of tables (messages, subjects, addresses,
  recipients, mailboxes, summaries, attachments, conversations, message_global_data; ZACCOUNT and
  ZACCOUNTTYPE), and `PRAGMA table_info`. No writes, no other tables, no `ATTACH`, at most 5,000 rows.
- `mail.file`: one `.emlx` or `.partial.emlx` inside the library, resolved with `realpath`, no
  symlinks out, at most 25 MB.
- `mail.list`: the entries of a folder inside the library.
- `mail.spotlight`: `mdfind -onlyin` the library for a scrubbed word, for body search.

The rest is portable TypeScript in `packages/native-mail`: `MailStore` builds the queries, decides
which accounts are visible, finds a message's file and parses it (`emlx.ts`, `mime.ts`); `tools.ts`
declares the tools and checks their input and output. Before any query, `MailStore` checks the
Envelope Index has the columns it reads. If Mail changes its layout, setup says so ("unsupported")
and nothing is read.

The app side is `apps/desktop/src/main/core/mail.ts`: the settings (`mail.json`, unreadable reads
as off), the reader's controls, and `MailService`, which the tool caller lists beside adapters
(`NativeTools` in `caller.ts`). An installed adapter can't take the id `mail`.

## Attachments and links

Anyone who may read a message may read its attachments (Nick, 2026-11-23): no switch of its own.
`mail_read` with `attachment: n` (from 1, in the order the message lists them) returns that
attachment as text: text, CSV, calendar and other text files as they are, HTML as text, a forwarded
message as its headers and text, and a PDF through macOS's PDFKit (`pdf.ts`, a fixed JXA script on a
private temporary copy, removed afterwards), each page after a `--- Page N of M ---` line. Long
text comes in chunks: pass `nextOffset` back as `offset`, for the body too.

Agents should see files as they would on disk, and clients only take some shapes from a tool
(researched 2026-11-23: Claude Code, Desktop and claude.ai show MCP `image` blocks to the model; none
passes a PDF from a tool to it, claude.ai refuses one and Claude Code saves it to disk). So the bytes
go as MCP content after the JSON text, never in the output (so never in the audit log or structured
content), checked by type and capped at 8 MB in all (`results.ts`):

- An image comes as an `image` block, drawn by AppKit (`render.ts`, a fixed JXA script) as PNG or
  JPEG with its longest side at most 1568 px, so HEIC and TIFF photos work too.
- A PDF gives its text by default; `pages: [n, …]` (up to five) gives pictures of those pages
  instead, drawn by PDFKit at 1400 px, for layout, tables and scans.
- `as: "file"` gives any attachment itself as an embedded `resource` with a `valet-mail://` URI,
  which Claude Code saves to disk for the agent to open; other clients may refuse it.

The output's `sent` says which went with it: `picture`, `pages`, `file` or null.

When Mail has only part of a message, it keeps the attachment beside it in
`<mailbox>.mbox/<folder>/Attachments/<row>/<MIME section>/<name>`; the reader helper opens files
there and `.emlx` files, nothing else (never MailData), checked again after following links. One it
hasn't downloaded is fetched through Mail instead: the same fixed script returns the
message's whole `source` (Mail downloads it if it must, read-only), and the attachment is read from
that. Only when Mail can't give it either does it come back as `reason: "not-downloaded"`.

`links` lists the web and mail links of the HTML part, each once, at most 100, even when the body
comes from the plain-text part.

## Drafts

`MailDrafts` (`drafts.ts`) runs one fixed JXA script through `osascript`, with the draft as a
single JSON argument. A new message is an invisible `OutgoingMessage`; a reply finds the original
by Message-ID and uses Mail's `reply` without opening a window, so Mail keeps it in its thread.
Then `save`, which files it in the account's Drafts and syncs it like any draft the person wrote.
Mail starts if it isn't running. The first time, macOS asks whether Valet may control Mail; a "no"
comes back to the agent as "the person needs to allow this".

The draft's From must be an address of a picked account. Recipients are whatever the agent asks
for; nothing is sent, so the person sees them before anything leaves.

### Scripting or IMAP

Nick's rule: drafts must not fail because Mail wasn't open, and scripting should be used only if
it works consistently. `packages/native-mail/scripts/draft-trial.ts` measures that on a real Mac:
rounds of new and reply drafts with Mail closed and open, checking each lands in Drafts, then
deleting them. If it isn't reliable, drafts go through IMAP `APPEND` to the Drafts folder instead
(the same `MailDrafts.save` interface), which needs the account's app-specific password.

First trial (2026-11-22, iCloud, 5 rounds): new drafts 10 of 10 (about 3 s with Mail closed,
under 1 s open); replies 9 of 10, the miss being the first reply right after Mail was quit (it timed
out). Replies left compose windows behind, hidden and one visible, and `reply` fills in the
original's sender as recipient. So the script now waits for a freshly started Mail to load its
accounts, retries finding the original, only adds recipients a reply doesn't already have, and
closes the message (saving) after `save`. The trial now replies only to a message the person sent
themselves, and reports leftover outgoing messages and compose windows.

Second trial (same day, after that fix): 19 of 20 saved, no compose windows left behind, replies
addressed only to the person. The miss was again a draft right after Mail started (a new one this
time), which hung until the timeout and left one unsaved message. So `MailDrafts.save` now retries
once: it closes that unsaved message without saving (which discards it, never sends) and makes the
draft again. Decision: drafts stay on scripting; IMAP `APPEND` remains the fallback if this changes.

### Asking before each draft

`approveDrafts` is stored and `callMailTool` supports asking (declined or timed out comes back to
the agent as declined), but the app doesn't ask yet: the approval broker's confirmations are tied
to an adapter manifest, which the built-in tools don't have. Nick agreed this can wait while
nothing is sent.

## Organising

"Let agents archive, trash and mark mail" in Settings › Mail turns on `mail_move` and `mail_mark`.
It is off by default, separate from reading and drafts, and a cloud agent also needs its own
"archive, trash and mark" switch on the Mail page (Touch ID), as for any tool.

- **Delete is a move to Trash.** Nothing is erased: the account's Trash keeps the message for as
  long as the account does (30 days on iCloud), and Nick agreed that is enough for now.
- **Moves stay inside one account.** `to` is `archive`, `trash`, `inbox` or a mailbox id from
  `mail_accounts`. Archive and Trash are found by their usual names (Archive, Deleted Messages,
  Trash, Deleted Items, Bin, Gmail's All Mail and Trash); an account without one says so. A mailbox
  in another account is refused, and Outbox, Drafts and Sent are never a destination.
- **Through Mail.** `MailOrganizer` (packages/native-mail/src/organize.ts) runs a fixed JXA script
  with the request as one JSON argument, so Mail makes the change and syncs it like the person had.
- **A few at a time.** Mail can take seconds to find each message in a big mailbox, so a call runs
  the script on three messages at a time and starts no new run after 30 seconds (Claude Code gives
  up on a call at 60). The script finds each message by Mail's own id first, checked against its
  Message-ID, which is quick; searching a big mailbox by Message-ID took Mail ~10 s a message. Ids it didn't get
  to come back as `notDone` (send them again); a run that failed partway puts its ids in
  `uncertain` (search first), and what moved before it is still recorded. Only a failure on the
  first run fails the call (agent feedback #7).
- **A cap.** At most 500 messages moved an hour across all agents; past that the tool says to try
  later.
- **Every move is recorded.** One `mail-moved` audit record per message, with account, Message-ID,
  from and to mailbox, subject, sender and date. Agents reading the audit log see only the ids and
  mailboxes, never subject or sender. In Activity the person can press "Put back" on a move once;
  that moves it back through Mail and records the undo with `undoOf`.

The audit log stays on the Mac. Backing it up elsewhere could be a later relay feature.

## Tests

- `swift-bridge/Tests/ValetHelperKitTests/MailAccessTests.swift`: the helper's refusals and answers
  on a made-up library.
- `packages/native-mail/test`: the parser, the store and the tools against a made-up library
  (`fixture-library.ts`), the socket client, and `helper-contract.test.ts`, which runs the real
  helper (plain binary and the Valet Reader bundle, on macOS CI) and checks it answers exactly as
  the in-process reader does.
- `apps/desktop/test/main/mail.test.ts`: settings, account gating, audit, setup states, and the
  caller routing built-in tools. `apps/desktop/test/mail-settings.test.tsx`: the setup screen.

No test reads real Mail data.
