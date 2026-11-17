# Live check: read Nick's iCloud inbox (read only)

Status: **Prepared, not run.** It needs Nick present (docs/adapter-kinds.md, "Testing and red
team"). It is the one live trial of the protocol kind: a real IMAP sign-in to a real mailbox, read
only, with nothing on the server changed.

## What it proves

- Valet signs in to `imap.mail.me.com:993` itself, with a kept app-specific password the adapter
  never sees, through the protocol host under its Seatbelt profile and the egress broker's tunnel.
- The approval card says what the adapter can reach: the kind, "Mail folder INBOX", and the
  credential kept for `imap.mail.me.com:993`.
- Reading changes nothing: INBOX is opened with `EXAMINE`, messages are fetched with `BODY.PEEK`,
  and the unread count in Mail is the same before and after.

## What it never does

- No write, flag, move or delete: the adapter has two `read` tools, and Valet refuses anything
  else at three layers (runtime, protocol host, wire).
- No folder but INBOX (`folders: ["INBOX"]`), and no message body: envelopes only.
- No retries past one. If a step fails, stop and record what failed.

## Before Nick sits down (no Nick needed)

1. The adapter is the example `icloud-mail-read` (`examples/icloud-mail-read`). Its cases pass, and
   `apps/desktop/test/main/examples.e2e.test.ts` runs it as installed against the fake IMAP server
   through the real protocol host. That run checks no flag changed, no `SELECT`, `STORE`, `APPEND`,
   `COPY`, `MOVE` or `EXPUNGE` was sent, no body was fetched, and no other folder was named. CI must
   be green on main.
2. Nick's Mac runs a build of main with the protocol host (`out/main/protocol-host.cjs`) and
   `valet-node`. Without the binary, protocol adapters answer not-granted. **Only one thread may
   rebuild or restart Valet on Nick's Mac at a time**: ask the coordinator before touching it.
3. The phone is paired and signed in to the hub, so the card can be approved on either device.

## With Nick (about 10 minutes)

1. **Nick makes an app-specific password** at account.apple.com (Sign-In and Security,
   App-Specific Passwords), named "Valet mail read check". He saves it in 1Password, in the item
   Valet's grant sheet will offer, with the username set to his full iCloud email address. iCloud
   doesn't accept the Apple ID password over IMAP.
2. **Nick notes INBOX's message and unread counts in Mail**, for comparison.
3. **An agent drafts the adapter**: `valet_create_draft` with `from: "example"`,
   `example: "icloud-mail-read"`, then `valet_check_draft` (every case passes) and
   `valet_submit_draft`.
4. **Nick reads the card and approves it**, on the phone or the Mac. Expected lines: "Uses mail or
   file protocols through Valet", "Mail folder INBOX" (high), one credential kept by Valet for
   `imap.mail.me.com:993`, and two read tools. Anything else means stop.
5. **Nick grants the credential** from the adapter's Credentials card, picking the item from step 1.
   An agent can ask for it with `valet_request_credential`.
6. **The agent calls `inbox_overview`.** The counts should match step 2.
7. **The agent calls `recent_mail` with `count: 3`.** Nick checks the three senders and subjects
   against the top of his inbox. Then he checks Mail's unread count is unchanged.
8. **Check the log.** The adapter's run detail shows each call's `secret-used` for `mail` and an
   `egress-connection` to `imap.mail.me.com:993`, and no `request-blocked`.

## Afterwards

- Nick decides whether to keep the adapter. If not, uninstall it from Sites, which also drops its
  grant. He can revoke the app-specific password at account.apple.com either way.
- Record the outcome, with dates and anything surprising, in docs/red-team.md under the cross-kind
  record, and in this file's status line.

## If something goes wrong

| What happens                                | Likely cause                                                      | Do                                       |
| ------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------- |
| `credential/not-granted`                    | Step 5 not done, or granted to another version                    | Grant it again for the installed version |
| `tool-run/unavailable`                      | No `valet-node` or protocol host in this build                    | Stop; rebuild (one thread on the Mac)    |
| `auth-failed` / LOGIN refused               | Wrong username, or the Apple ID password, not an app-specific one | Fix the item, try once more              |
| `egress/sni-mismatch` or `host-not-allowed` | DNS answered something unexpected (VPN, NAT64)                    | Stop and record the answer; don't loosen |
| Counts differ from Mail                     | Mail hasn't synced, or Mail's "Inbox" combines accounts           | Compare with iCloud.com Mail instead     |
