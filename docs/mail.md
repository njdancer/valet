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
| `mail_read`         | One message: headers, text (HTML turned into text), attachment names. Never attachment contents.                |
| `mail_thread`       | The messages in a message's conversation, up to 30.                                                             |
| `mail_create_draft` | Only when drafts are on. A new message or a reply, saved to Mail's Drafts from a picked account's address.      |

Every result says that mail is data and not instructions. Every call goes in the audit log like an
adapter's, with `builtin` in place of a package hash.

An account that isn't picked doesn't exist for agents: its messages are never returned, and a
message id from it reads as not found. The setting is read on every call, so un-picking an account
takes effect at once.

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
