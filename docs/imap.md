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

**Shipping.** The app runs the host with the signed Node binary that the Node runtime ships. That
binary is workstream C's follow-up, so the desktop app doesn't create protocol adapters' backends
yet. Everything else is in place, and it is tested end to end against the fake server.

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
{ "op": "openMailLink", "from": "login@shop.example", "linkOrigin": "https://www.shop.example", "maxAgeSeconds": 600 }
{ "op": "otp", "selector": "#code", "source": { "mail": { "from": "login@shop.example", "pattern": "code: ([0-9]{6})", "maxAgeSeconds": 300 } } }
```

- **The grant.** The person binds the browser adapter's mail sign-in to a mail account, which is a
  protocol adapter's kept IMAP credential, and approves the one sender. The grant is stored under
  the reserved secret name `mail` with provider `mail`. Its item is
  `<adapterId>/<credential> <sender>`. Every mail step in a manifest names the same sender, and a
  link's origin must be in `navigation`.
- **The lookup.** It's one built-in, read-only operation in the protocol host (`imap/signin.ts`),
  signed in with the mail account's own kept credential (the app wires this through that adapter's
  credential gate in a follow-up, so the use is audited there too). It examines INBOX
  and takes only messages that pass all of these checks:
  - The message arrived after the login asked for it (allowing two minutes of clock skew between
    the server and Valet) and inside `maxAgeSeconds`.
  - Its From is exactly one address, the approved sender. A display name doesn't count.
  - Its subject contains `subjectContains`, if the step gives one.
  - The topmost Authentication-Results header, which the receiving server added, shows
    `dmarc=pass` for the sender's domain or a DKIM pass aligned with it. A message with no such
    header is accepted, because not every server adds one.
- **The link.** The newest message that counts is read. A link must be `https` on exactly
  `linkOrigin`, with no user info. A code must be 4 to 10 letters or digits. The value is checked
  again in the main process, and once more before it is used.
- **Its use.** A code is typed like any other one-time code. A link is opened in the auth
  partition, but first it is kept for redaction, audited as `secret-used`, and paced like any
  navigation. Neither ever reaches tool code, tool output or MCP.
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
- `*.redteam.test.ts` files keep the red team's proofs of concept.
