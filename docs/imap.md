# IMAP protocol adapters

A `protocol` adapter reaches a mail server over IMAP, through Valet's own client, never its own
code. Its tools call `ctx.imap`, a short list of typed operations. Each operation is checked
against the tool's declared side effect and the manifest's folder list before anything is sent.
This is workstream D of [adapter-kinds.md](adapter-kinds.md#protocol). The same client also reads
sign-in links and codes for browser adapters ([email sign-in](#email-sign-in)).

## The manifest

```json
{
  "runtime": "protocol",
  "protocols": {
    "imap": {
      "endpoint": "imap.mail.me.com:993",
      "credential": "mail",
      "folders": ["INBOX", "Receipts"]
    }
  },
  "credentials": {
    "mail": {
      "description": "Your iCloud app-specific password",
      "kind": "password",
      "custody": "kept",
      "use": { "protocol": "imap", "endpoint": "imap.mail.me.com:993" }
    }
  },
  "tools": [
    {
      "name": "search_mail",
      "title": "Search mail",
      "description": "...",
      "sideEffect": "read"
    }
  ]
}
```

- **`endpoint`** is `host:port` with a host name, never an IP address. TLS starts with the first
  byte (port 993). STARTTLS is never used, so nothing is ever sent in the clear.
- **`credential`** names a kept password declared for exactly this protocol and endpoint
  (secrets v2, [adapter-kinds.md](adapter-kinds.md#f2-secrets-version-2)). The person grants it
  once. Valet signs in with it just in time, for each call. Adapter code never sees it, and any
  echo of it is redacted from tool output.
- **`folders`**, when given, is the only set of folders tools may use. Names must match exactly,
  except INBOX, which matches in any case. `Receipts` doesn't cover `Receipts/2026`. Without the
  list, every folder is allowed.
- A protocol adapter has no `navigation`, `egress`, `privateHosts`, `requests` or `cartUrl`. It
  reaches its one server and nothing else. Its `home` is derived from the server's name, and is
  only the key that pacing and the breaker are kept under.

## ctx.imap

| Operation                                      | Purpose                                | What it does                                                                       |
| ---------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------- |
| `listFolders()`                                | read                                   | Folders with their special use (`\Sent`, `\Trash`...), allowed ones only           |
| `status(folder)`                               | read                                   | Message, unseen and UID counts                                                     |
| `search(folder, criteria?, { limit? })`        | read                                   | UIDs, newest first, at most 500. Criteria are structured, never raw search text    |
| `fetch(folder, uids)`                          | read                                   | Envelopes, flags, dates and sizes for at most 100 messages                         |
| `message(folder, uid, { maxTextChars? })`      | read                                   | The first text and HTML parts, decoded, and a list of the other parts              |
| `attachment(folder, uid, part, { maxBytes? })` | read                                   | One part's bytes as base64, at most 1.5 MB                                         |
| `setFlags(folder, uids, { add?, remove? })`    | write, or irreversible with `\Deleted` | System flags and keywords                                                          |
| `copy` / `move(folder, uids, to)`              | write                                  | Both folders must be allowed. `move` needs the server's MOVE                       |
| `append(folder, message, { flags? })`          | write                                  | A whole RFC 5322 message, at most 1 MB                                             |
| `createFolder(folder)`                         | write                                  | Never INBOX                                                                        |
| `expunge(folder, uids)`                        | irreversible                           | `UID EXPUNGE` of just these messages, if they are marked `\Deleted`. Needs UIDPLUS |
| `deleteFolder(folder)`                         | irreversible                           | Never INBOX                                                                        |

Results are plain, bounded data. Headers are decoded to one line, with control characters,
bidirectional overrides and invisible characters removed. Bodies keep line breaks and tabs and
nothing else that a terminal could act on. HTML comes back as text, never rendered.

## Three layers of checks

Each rule holds in three places, so a bug in one layer is caught by the next.

1. **In the main process** (`packages/runtime/src/guarded-imap.ts`). It checks the operation's
   purpose against the tool's side effect, every folder argument against the manifest, the run's
   request ceiling, and the site's pace and breaker. A refusal is audited as `request-blocked`
   with method `IMAP`, ends the call, and is sent nowhere.
2. **In the protocol host** (`packages/protocols/src/imap/operations.ts`). It checks every
   argument again as if hostile: types, sizes, UID ranges, flag names, folder names and the folder
   list. It also refuses a write from a read session.
3. **On the wire** (`packages/protocols/src/imap/command.ts`). Every command is structured data,
   never pasted text. `checkCommand` holds each one to the session's purpose before a byte is
   written:
   - A read session may only look. It opens folders with `EXAMINE`, and fetches message data only
     with `BODY.PEEK`, so nothing is marked read. `BODY[]`, `RFC822`, `BINARY` and header-field
     sections are refused outright.
   - `\Deleted` needs an irreversible session, in `STORE` and `APPEND` alike.
   - Changes go only to a folder opened with `SELECT`.
   - `CLOSE` (which expunges silently) and plain `EXPUNGE` (which removes whatever any client
     marked) are never sent, whatever the purpose. Neither is anything else outside the table in
     `packages/core/src/imap-policy.ts`.

   Strings with a line break, NUL, an 8-bit byte, or more than 1000 bytes go as literals. Atoms
   are checked against a strict pattern, and mailbox names are written in modified UTF-7.

## The protocol host

The client runs in its own Node process, never in the main process, so hostile mail is parsed
somewhere that can do little harm. It's the Node runtime's sandbox
([node-runtime.md](node-runtime.md)): a Seatbelt profile on macOS, no network of its own, and one
loopback port per declared endpoint, which the egress broker's tunnel connects to the real
server. The broker checks the TLS name (SNI), counts bytes against the run's upload budget, and
records the connection.

The host script is Valet's own code, bundled into one file by esbuild (`src/build.ts`). It
imports only `node:` modules and the policy table. The main process talks to it over fd 3 in JSON
lines: `boot`, `login`, `op`, `signInMail` and `end`. The password is sent only in `login`, after
the tunnel is up. Replies are checked to be plain JSON before they are used.

The client reads replies with hard limits on line length (2 MB), literal size (8 MB), total
response size (16 MB), nesting (40) and value count. It times out each command, and stops reading
past 64 MB on the connection. It fails closed on anything it can't parse, on a reply tagged for
another command, on a go-ahead nobody asked for, and on a `PREAUTH` greeting.

**Shipping.** The main build emits the host as `out/main/protocol-host.cjs`
(`apps/desktop/protocol-host-plugin.ts`). Packaged, electron-builder unpacks it beside app.asar
(`Contents/Resources/app.asar.unpacked/out/main/`), because the sandboxed Node can't read inside
the archive, and the release check makes sure the shipped `valet-node` parses it. The app runs it
with `Contents/MacOS/valet-node`, or in a development run with `.node-runtime/valet-node`
(`scripts/node-runtime.mjs`). Without the binary, protocol adapters answer not-granted and
sign-in mail isn't offered (`src/main/core/protocol-host.ts`).

## Cases and the example

A protocol draft's cases answer `ctx.imap` from an `imap` script in the case: each step names the
operation the tool makes next, the arguments it checks (from the first), and the server's `answer`
or an `error`. The runtime's own GuardedImap runs first, so a case shows a refused write or folder
as a live call would. No credential is ever asked for. The worked example is
`examples/icloud-mail-read`, the adapter for the [live check](live-checks/icloud-mail-read.md).

`examples/icloud-mail-drafts` writes: it saves drafts to iCloud Drafts with `append`, building the
message with core's checked mail builder (`checkMailMessage`, `buildMailMessage`, the ones
`ctx.smtp` uses, which tool code may import), and replaces one by moving the old version to
Deleted Messages. It exists because Mail's own scripting wraps a draft's text in a quote block.

## iCloud

- IMAP is `imap.mail.me.com:993`, which `ICLOUD_IMAP_ENDPOINT` names.
- It needs an app-specific password, made at account.apple.com. The username is
  the full iCloud address. iCloud doesn't accept the account password over IMAP.
- iCloud advertises UIDPLUS and MOVE, so `expunge` and `move` work. Its folders include
  `Sent Messages`, `Deleted Messages` and `Junk`, marked with their special use.
- The fake server (`fakes/imap`) advertises iCloud's capabilities by default.

## Email sign-in

Some sites sign in by emailing a link or a code. A browser adapter's login can read these from a
mail account Valet already holds, without any adapter code seeing the mail.

```json
{ "op": "openMailLink", "from": "login@shop.example", "subjectContains": "Sign in", "linkOrigin": "https://www.shop.example", "maxAgeSeconds": 600 }
{ "op": "otp", "selector": "#code", "source": { "mail": { "from": "login@shop.example", "pattern": "code: ([0-9]{6})", "maxAgeSeconds": 300 } } }
```

- **The grant.** The site's Login card shows the sender ("Sign-in links by email"), and its
  grant sheet lists the mail accounts Valet holds. The person picks one and the origins, and signs
  it with Touch ID or on the phone, as a `secret-grant` with provider `mail`. The grant is stored
  under the reserved secret name `mail` with provider `mail`. Its item is
  `<adapterId>/<credential> <sender>`. Every mail step in a manifest names the same sender, and a
  link's origin must be in `navigation`.
- **The account.** A mail account is a protocol adapter's kept IMAP credential: installed and
  approved, its credential granted, and none of its tools able to change INBOX. Another adapter
  that may change INBOX and was granted the same item disqualifies it, since that may be the same
  mailbox. This is checked when the sheet lists accounts and again on every lookup, so revoking
  the account's password stops sign-in mail at once.
- **The account must be read-only for INBOX.** A message that an IMAP client appends skips the
  receiving server, so its own forged Authentication-Results would be the topmost one. A mail
  account whose adapter has any tool that may change INBOX (core's `mayWriteInbox`) can't serve
  sign-in mail, and the mail reader refuses it.
- **The lookup.** It's one built-in, read-only operation in the protocol host (`imap/signin.ts`),
  signed in with the mail account's own kept credential, through that adapter's CredentialGate,
  so the use is audited as that adapter's. It examines INBOX
  and takes only messages that pass all of these checks:
  - The message arrived after the login asked for it, inside `maxAgeSeconds`. The server's clock
    may be up to 30 seconds behind Valet's, or two minutes ahead.
  - Its From is exactly one address, the approved sender. A display name doesn't count.
  - Its subject contains `subjectContains`. A link step must give one, because anyone can make a
    site send its other mail (an invitation, a share) from the same address.
  - The topmost Authentication-Results header, which the receiving server added, shows
    `dmarc=pass` for the sender's domain, or `dkim=pass` with a signing domain (`header.d`, never
    `header.i`) aligned with it. Any other DMARC result for the domain refuses the message.
    Comments and quoted strings are dropped before the header is read, because the server copies
    sender-chosen text into them. A message with no such header is accepted, because not every
    server adds one.
  - Its From address is compared in ASCII lower case only, so a look-alike such as a Kelvin sign
    never folds into an approved address.
- **The link.** The newest message that counts is read. A link must be `https` on exactly
  `linkOrigin`, with no user info. A code must be 4 to 10 letters or digits. The value is checked
  again in the main process, and once more before it is used.
- **Its use.** A code is typed like any other one-time code. A link is opened in the auth
  partition, but first it is kept for redaction, audited as `secret-used`, and paced like any
  navigation. Valet's lookup never hands either to tool code, tool output or MCP. The mail itself
  stays unread in INBOX, so a mail adapter's own read tool on the same account can still read it,
  within that tool's boundary like any other mail.
- **Waiting.** The login asks again every five seconds until `maxAgeSeconds` or the flow's
  deadline passes. One host session per account is kept for 30 seconds between asks, so the server
  sees one sign-in rather than one per ask.

## Tests

All of these tests run against the fake server, never real mail.

- `packages/protocols/test` covers the wire parser, command encoding and purpose checks,
  operations, MIME decoding, a hostile server, the sign-in lookup, and the host end to end
  (`host.e2e`, `mail-reader.e2e`). The host tests run under Seatbelt on the macOS runner.
- `packages/runtime/test/guarded-imap.test.ts` and `imap.e2e.test.ts` cover the main process's
  checks, the tool host and the isolated tool process.
- `packages/auth-flow/test/mail.test.ts` covers the two login sources.
- `packages/core/test/manifest-protocol.test.ts` covers the manifest rules.
- `apps/desktop/test/main/service.test.ts` ("mail adapters and sign-in mail") runs both through
  the real app service and protocol host: a protocol adapter's tool signs in with its granted
  password, a browser adapter is granted sign-in mail from it, and the account stops serving when
  its password is revoked or a write-capable adapter holds the same item.
  `apps/desktop/test/main/protocol-host.test.ts` covers where the app finds the host, and
  `grant-sheet.test.tsx` the mail grant's screens.
- `*.redteam.test.ts` files keep the red team's proofs of concept.
