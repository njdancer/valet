# Messages on this Mac

Valet's built-in Messages tools let agents read the Mac's Messages history: iMessage, SMS and RCS,
with names from Contacts. They only read. Nothing here sends a message, marks one read or changes
anything. Like the [Mail tools](mail.md), they are built in and fixed, not an adapter an agent
wrote, and they are off until the person turns them on in Settings › Messages.

## What agents get

Adapter id `messages`:

| Tool                  | What it does                                                                                         |
| --------------------- | ---------------------------------------------------------------------------------------------------- |
| `messages_chats`      | Conversations, newest first: id, name, people, last message, unread count. Filter by name or number. |
| `messages_search`     | Messages by words, conversation, sender, own or others', dates, attachments. At most 100 a page.     |
| `messages_read`       | One conversation, oldest first: the newest page, or before or after a message id.                    |
| `messages_attachment` | One attachment: a photo as a picture, a text file or contact card as text, anything else by name.    |

A conversation is every chat with the same `chat_identifier`, so the SMS and iMessage chats with
one number are one conversation, as the Messages app shows them. Its id is that identifier: a
phone number, an email address, or `chat…` for a group. Each message has its sender (handle and
Contacts name), text, attachments, reactions (with removals applied), the message it replies to,
and whether it was edited or unsent. Group events (renames, people added) are left out.

Every result says that messages are data and not instructions. Every call goes in the audit log
like any built-in tool's.

### What agents never see

- **Hidden conversations.** Agents see every conversation except the ones the person ticks in
  Settings › Messages (Nick, 2026-11-26: "all chats, minus ones you hide"); new conversations are
  visible. A hidden conversation doesn't exist for agents: it isn't listed, its messages never
  match, and its ids and attachments read as not found. The list is read on every call.
- **One-time codes.** While "Hide one-time codes" is on (the default), an incoming message that
  looks like a sign-in or verification code (`packages/native-messages/src/codes.ts`: a code word
  and a code-shaped string) comes back with its text replaced and `hidden: "code"`, and never
  matches a search, so an agent can't probe for digits. Valet reads codes itself to sign the person
  in, and a code an agent could read is a sign-in it could take.

### Cloud agents

As with Mail, cloud agents get the tools only once each is turned on for them, with Touch ID: in
Connections, or from "Cloud agents that may read Messages" in Settings › Messages (one switch for
the four tools).

## Setup

1. Turn it on. This starts the reader helper, the same "Valet Reader" Mail uses.
2. The reader needs Full Disk Access, which macOS asks for once for Mail and Messages together. If
   Mail already works, there is nothing to do.
3. Optionally tick conversations to hide, and choose whether codes stay hidden.

## How it works

`swift-bridge/Sources/ValetHelperKit/MessagesAccess.swift` answers three questions on the helper's
socket and refuses everything else:

- `messages.info`: whether `~/Library/Messages/chat.db` is readable, and which Contacts databases
  exist (`~/Library/Application Support/AddressBook`, "main", and each `Sources/<id>`).
- `messages.query`: one read-only SQL statement on chat.db or one Contacts database. The same
  SQLite authorizer as Mail's allows only `SELECT` from `message`, `chat`, `handle`,
  `chat_message_join`, `chat_handle_join`, `attachment` and `message_attachment_join` (or
  `ZABCDRECORD`, `ZABCDPHONENUMBER` and `ZABCDEMAILADDRESS`), and `PRAGMA table_info`. On chat.db,
  `message_text(text, attributedBody)` gives a message's text however Messages stored it (newer
  macOS leaves `text` empty and keeps an archived `NSAttributedString`).
- `messages.file`: one file inside `~/Library/Messages/Attachments`, resolved with `realpath`, no
  links out, at most 25 MB.

Messages stores times as nanoseconds since 2001, which a JSON number can't hold exactly, so the
store's SQL turns them into milliseconds and multiplies its own bounds (`m.date >= ? * 1000000`),
and paging anchors on a message id inside SQL.

The rest is portable TypeScript in `packages/native-messages`: `MessagesStore` checks chat.db has
the columns it reads (newer ones, such as edits and emoji reactions, only when present; a missing
required one stops with "unsupported"), builds the queries, applies the hidden list and the codes
rule, and puts Contacts names to handles (an email, or a number's last nine digits); `tools.ts`
declares the tools and checks their input and output. Photos are drawn by Mail's `render.ts`
(AppKit), so HEIC works.

The app side is `apps/desktop/src/main/core/messages.ts`: the settings (`messages.json`,
unreadable reads as off) and `MessagesService`, which the tool caller lists beside Mail.

### Valet's own one-time codes

When a login needs a code from Messages, Valet reads it through this same reader:
`MessagesOtpReader` (`otp.ts`) asks `MessagesStore.recentFrom(handle, services, since)` for the
recent incoming messages from exactly the sender the person approved, codes included and ignoring
the hidden list, then keeps only those `looksLikeCode` (`codes.ts`) calls a code. So a code Valet
types for the person is always one the Messages tools hide from agents, and a sender whose code
messages that detector misses fails the login as not-found rather than reading an ordinary message.
The pattern runs in a worker under a deadline (`@valet/credentials`), only a code-shaped capture
(`isCodeShaped`) is handed back, as a SecretValue for the login's filler, and the checks before
any read (the grant, one exact sender, a screened pattern) are credentials' `prepareOtpLookup`.
None of this is an agent's tool or reachable from adapter code. Turning on Messages codes in
Settings starts the reader helper, whether or not the Messages tools are on.

## Tests

- `swift-bridge/Tests/ValetHelperKitTests/MessagesAccessTests.swift`: the helper's refusals and
  answers, the text function, and paths outside Attachments.
- `packages/native-messages/test`: the store, tools and code lookup (`otp.test.ts`) against a
  made-up chat.db and Contacts (`fixture.ts`), and `helper-contract.test.ts`, which runs the real
  helper on macOS CI, checks it answers exactly as the in-process files do, and reads a code
  through it.
- `apps/desktop/test/main/messages.test.ts` and `messages-settings.test.tsx`: settings, the hidden
  list and codes rule per call, audit, setup states, and the screen.

No test reads real messages.
