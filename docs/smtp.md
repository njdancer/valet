# SMTP protocol adapters

A `protocol` adapter can send mail over SMTP, through Valet's own client, never its own code. Its
irreversible tools call `ctx.smtp.send` with a plain message. Valet checks it, shows the person
exactly what will be sent, and sends it only on their yes. This is workstream G of
[adapter-kinds.md](adapter-kinds.md#protocol). It shares the protocol host with
[IMAP](imap.md).

## The manifest

```json
{
  "runtime": "protocol",
  "protocols": {
    "smtp": {
      "endpoint": "smtp.mail.me.com:587",
      "credential": "mail",
      "recipients": ["@example.com", "ann@example.org"]
    }
  },
  "credentials": {
    "mail": {
      "description": "Your iCloud app-specific password",
      "kind": "password",
      "custody": "kept",
      "use": { "protocol": "smtp", "endpoint": "smtp.mail.me.com:587" }
    }
  },
  "tools": [{ "name": "send_mail", "title": "Send mail", "description": "...", "sideEffect": "irreversible" }]
}
```

- **`endpoint`** is `host:port` with a host name. Port 465 starts TLS with the first byte. Any
  other port must offer STARTTLS, and Valet upgrades before it signs in or sends anything. A
  server that doesn't offer it gets nothing. TLS 1.2 is the least Valet accepts.
- **`credential`** names a kept password for exactly this protocol and endpoint (secrets v2). The
  username is the account's address, and it is the message's From.
- **`recipients`**, when given, is the only set of addresses tools may send to, Bcc included. An
  entry is an exact address or `@domain`, which covers every address at exactly that domain and
  not its subdomains. Compared without case. Without the list, anyone.
- A manifest may declare `imap`, `smtp` or both. Each must use its own credential declaration,
  since a credential is for one protocol and endpoint.

## ctx.smtp.send

```ts
const { messageId, accepted } = await ctx.smtp.send({
  to: ['ann@example.com'],
  cc: [], // optional
  bcc: [], // optional
  subject: 'Your receipt',
  text: 'Hi Ann,\n...',
  inReplyTo: '<parent@example.com>', // optional
  references: ['<parent@example.com>'], // optional
})
```

The message is checked by `packages/core/src/smtp-policy.ts` (`checkMailMessage`):

- Addresses are plain `local@domain`: a dot-atom local part (without `%` or `!`, the old
  routing characters) and a host name with a top-level domain. No display names, comments, quotes, commas, angle brackets, spaces or line breaks, so
  one address can't hide another recipient or an SMTP command. At most 50 recipients in all, with
  none twice.
- The subject (300 characters at most) and the text (100,000 characters) have nothing a person
  can't see: no control or format characters (zero-width spaces and joiners, direction marks, tag
  characters), no line or paragraph separators, no private-use or unassigned characters, no blank
  fillers, and no variation selectors but the emoji ones. The text may have line breaks (`\n` or
  `\r\n`) and tabs.
- Lists are copied by index and then checked, never read through their iterator. Holes, extra
  properties and array subclasses are refused.
- `inReplyTo` and `references` must be `<left@right>` message ids.
- Unknown keys are refused, not ignored. There is no way to add a header, an attachment or HTML.

Valet builds the message itself (`buildMailMessage`): From is the signed-in account, then To, Cc,
Subject (as RFC 2047 words when it isn't short ASCII), Date, a fresh random Message-ID at the
server's domain, the reply headers, and a base64 UTF-8 text body. Bcc is never in the headers,
only in the envelope. Since the body is base64, no text a tool writes can start a header or end
the DATA.

## The checks, in order

In the main process (`packages/runtime/src/guarded-smtp.ts`), for each send:

1. The call is still live.
2. The tool is irreversible. A read or write tool's send is refused, because a send can't be
   undone.
3. The message passes `checkMailMessage`. If not, the send fails `invalid`.
4. Every recipient, Bcc included, is on the manifest's list, if it has one.
5. It counts against the run's request ceiling.
6. **The person confirms this exact message.** The confirmation window shows Valet's own
   rendering of what it will send: From (your account at the server), To, Cc, Bcc (marked as not
   shown to the others), Subject, the reply's parent, References, and the text. Its button is **Send this
   email**. Each send asks again, so one yes never covers another message, and a call's sends go
   one at a time, so two questions are never up at once. A decline or time-out
   fails the send, and nothing was sent.
7. It waits for the site's pace, starts a fresh protocol host, signs it in just in time through
   the call's CredentialGate (audited as `secret-used`), sends once, and ends the host.

A refusal at 2, 4 or 5 is sticky for the call and audited as `request-blocked` with method
`SMTP`. These come on top of the irreversible tool's own confirmation before it ran.

In the protocol host (`packages/protocols/src/host/protocol-host.ts`), the message, message id
and recipient list are checked again as if hostile, the message is built there with From set to
the username, and the host sends at most one message before it ends.

On the wire (`packages/protocols/src/smtp/client.ts`), every line is built from the checked
values. The client:

- refuses anything the server sent after its STARTTLS reply but before the handshake, even an
  unfinished multi-line reply (the STARTTLS injection attack), and forgets everything it heard
  before TLS;
- signs in with AUTH PLAIN, or LOGIN if that's all there is, only over TLS;
- sends MAIL FROM, one RCPT TO per recipient (any refusal sends RSET, and nothing is sent), then
  DATA, dot-stuffed;
- holds replies to limits on line length, lines per reply and bytes in all, and times out each
  command.

## Tests

Every test runs against `smtp-server` on loopback, never a real mail server.

- `packages/core/test/smtp-policy.test.ts` covers the message rules and the bytes Valet builds.
- `packages/protocols/test/smtp.e2e.test.ts` runs the host end to end: STARTTLS and port 465, no
  STARTTLS, a refused sign-in, a refused recipient, header and recipient smuggling straight at the
  host, a second send, IMAP on an SMTP host, and a server that injects a reply before the TLS
  handshake.
- `packages/runtime/test/smtp.e2e.test.ts` covers the checks above through the tool host, and from
  an isolated tool process.
- `apps/desktop/test/main/confirmations.test.ts` and `test/confirmation.test.tsx` cover the
  confirmation's text and window.

## Not yet

- **The app registers no SMTP backend yet**, as for IMAP: the protocol host needs the signed Node
  binary (workstream C's follow-up). Until then an SMTP adapter's sends answer not-granted.
- The approval card doesn't yet list the manifest's recipients, as it doesn't list IMAP folders.
