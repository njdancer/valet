# Adapter kinds beyond the browser

Status: **Agreed direction, not built.** Nick agreed this on 2026-11-17, after discussing it from
2026-11-14 to 2026-11-17 (it started as valet-feedback #6). It replaces the earlier HTTP-only design,
which was merged too early. Each workstream below is built in its own thread. Each one has tests
against fakes and a red-team pass before it merges. None of it is on the path to the first
Woolworths order, and none of it should get in that path's way.

## The four kinds

| Kind       | Adapter code runs in                               | Reaches the outside through                                                    | Secret                                                                             | Example                                           |
| ---------- | -------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------- |
| `browser`  | QuickJS sandbox (today)                            | The tool partition: a real browser, with its egress proxy                      | Kept: typed in by the declarative login                                            | Woolworths                                        |
| `http`     | QuickJS sandbox                                    | `ctx.http`: Valet's HTTPS and WebSocket client                                 | Kept: Valet adds it as a header                                                    | Hacker News, an RSS feed, CalDAV, CardDAV         |
| `protocol` | QuickJS sandbox                                    | `ctx.imap`, `ctx.smtp`, `ctx.sftp`: protocol clients Valet ships               | Kept: Valet does the login                                                         | iCloud mail, a NAS over SFTP                      |
| `raw`      | A Node process under its own macOS sandbox profile | Real sockets, which reach only Valet's broker; it tunnels them to pinned hosts | Entrusted: the adapter is given the value, under the limits in [Secrets](#secrets) | Anything npm can talk to, where nothing else fits |

The kind is the manifest's `runtime` field. If it's left out, the kind is `browser`, so every
existing manifest and approved hash stays exactly as it is (the same rule `sandbox` follows).

Why there are three non-browser kinds:

- **`http` and `protocol` keep the strongest boundary.** The adapter's own code runs in the
  QuickJS sandbox that was red-teamed in #85. Valet makes the connections, does the logins and
  enforces each tool's purpose. A `protocol` adapter is how you get very narrow tools, for example
  "read the subjects of unread mail in one folder", where Valet refuses anything else at the
  command level.
- **`raw` is for rare cases**, where an npm package is the only practical way in. It gives up the
  language-VM boundary for an OS one, and the adapter holds the secret. It gets the same approval
  as everything else (Nick, 2026-11-17), but the card says plainly what it can do.

## Foundations

Three foundations come first, because every kind except `browser` needs them.

### F1. The egress broker

This is the one place in the main process through which all non-browser traffic goes. It grows out
of the tool partition's CONNECT proxy (`packages/browser-electron/src/egress-proxy.ts`) and
`ctx.local.fetch` (`packages/sandbox/src/local/net.ts`). It does the following:

1. **Endpoints.** It allows exact host and port pairs from the manifest, and nothing else. The
   broker does every DNS lookup, and a public endpoint must resolve to public addresses only (the
   rules `ctx.local.fetch` uses today). A private endpoint is an IP literal with a
   `private-network` grant (below). A host name is never resolved to a private address.
2. **Server name.** For a tunnelled TLS connection (`raw`), it reads the ClientHello and refuses
   unless the SNI equals the endpoint's host. That stops one shared CDN address being used to
   reach someone else's service. It never decrypts tunnelled traffic.
3. **Policy for traffic Valet makes itself** (`http` and `protocol`). HTTP requests go through
   `decideRequest` in `packages/core/src/request-surface.ts`, the same function the browser path
   uses: hosts, ambiguous paths, deny segments, declarations and purpose. Protocol commands go
   through each protocol's own table (below).
4. **Pacing.** It takes the adapter's `SiteProtection` budget and breaker
   (`packages/runtime/src/site-protection.ts`) per request or command. A `raw` adapter takes one
   slot per connection opened.
5. **Byte accounting and an upload budget.** It counts bytes up and down on each connection, for
   each call. A `read` tool may send at most `limits.uploadBytesPerRun` (default 64 KB, plus
   1 KB per 100 KB received). Past that, the connection is closed and the call fails with
   `egress/upload-budget`. A `write` or `irreversible` tool gets a declared budget instead. The
   counts are audited.
6. **Reporting.** Every refusal is reported in `blocked` (`initiator: tool`) and audited as
   `request-blocked`, with new reasons (`endpoint-not-allowed`, `sni-mismatch`, `upload-budget`,
   `command-not-allowed`). Connection open and close are audited with byte counts.

Shared code, not copies: the broker and the browser driver call the same decision functions in
`packages/core`. If a check lives only in the browser driver today, it moves to core first.

**Private network.** `privateHosts: [{ address, port, scheme?, certSha256? }]` covers any kind.
Each entry is an IP literal, so DNS can't be redirected. It is never a port Valet listens on.
`certSha256` pins a self-signed certificate. The `private-network` approval kind becomes durable
for an adapter's hash, not just 30 minutes of authoring. A kept secret is never sent over
unencrypted `http`.

### F2. Secrets, version 2

The rule in security-model.md, "adapter code never obtains a secret's value", becomes:

> A secret is either **kept** by Valet or **entrusted** to one adapter. Kept is the default and
> the only option for `browser`, `http` and `protocol`. Entrusted is only for `raw`, and an
> entrusted secret must be a credential that adapter alone uses and that the person can revoke
> (an app password or token, never a main account password). The adapter may reach only the
> endpoints that secret is for. It gets no writable files unless it declares them, its uploads
> are budgeted, its output is scrubbed of the value and its common encodings, and every new
> version is reviewed for where the secret goes before the approval card is shown.

The manifest gets `credentials`, next to the existing `secrets`, which keep meaning browser logins:

```jsonc
"credentials": {
  "mail": {
    "description": "Your iCloud app-specific password",
    "kind": "password",                  // password | token | ssh-key
    "custody": "kept",                   // kept | entrusted
    "use": { "protocol": "imap", "endpoint": "imap.mail.me.com:993" }
    // or { "header": { "name": "authorization", "format": "Bearer {value}" }, "hosts": ["api.example.com"] }
    // or { "entrusted": { "endpoints": ["host:port", …] } }      (raw only)
  }
}
```

- Credential providers gain `token` and `ssh-key` fields alongside `username`, `password` and
  `otp` (`packages/credentials`). An SSH key can be **generated by Valet** for an adapter. The
  private half goes in the Keychain, and the person is shown the public half to add to the
  server, so it never leaves the Mac.
- Grants work like secret grants. They are per adapter and content hash, and bound to a
  1Password item or a Keychain copy. Each use is audited as `secret-used`, with the endpoint,
  never the value.
- Output redaction (`packages/runtime/src/redaction.ts`) also matches the value's base64,
  base64url, hex, URL-encoded and reversed forms, for every credential a run used.
- The approval and phone cards name each credential and its custody in plain words. For example:
  "Valet signs in to imap.mail.me.com with your iCloud app password. The adapter never sees it."
  Or: "This adapter is given your Home Assistant token, and can use it only with 192.168.1.20."

### F3. The Node runtime (for `raw`)

- **Binary.** It's a separate Node binary, signed under its own identifier, with no
  Keychain access groups and no entitlements beyond what Node needs. It is never Electron run as
  Node: the RunAsNode fuse stays off, and Valet's signing identity is never lent to adapter code.
- **Sandbox.** It runs under a deny-by-default macOS sandbox profile, generated for each adapter
  hash. The profile allows only these:
  - reading the Node binary, the adapter bundle, the system libraries and frameworks Node loads,
    time zone data, and the declared read paths;
  - writing to a fresh temp folder, plus any declared read-write paths;
  - one network connection, to the broker's loopback port.

  It refuses running other programs, Apple Events, the pasteboard, Keychain and security
  services, launch services, other Mach services that aren't needed, and anything in the
  never-grantable list (`FORBIDDEN_PATHS` in `packages/core/src/sandbox.ts`). Like `command`, if
  `sandbox-exec` disappears the runtime is `unavailable`, never unconfined.
- **Network shim.** This is for compatibility only, not security. A preload routes `net.connect`,
  `tls.connect`, `dns.lookup` and the global `fetch` dispatcher through the broker's tunnel, so
  ordinary npm packages work without knowing about it. The profile is what enforces the limits.
- **Process.** There is one process per adapter hash, with an empty environment, a throwaway
  `HOME`, a heap cap and a call deadline. It is killed when idle or at its limits. The only
  channel to Valet is a socket for tool calls, which carries the same capability protocol
  QuickJS uses today.
- **Dependencies.** These are bundled with esbuild when the draft is checked. The lockfile, with
  integrity hashes, is part of the adapter hash. There are no install scripts, no `node_modules`
  at run time, and no native addons (`.node` files are refused). Agents add a dependency with a
  new authoring tool, `valet_add_dependency`. Valet fetches the package from the npm registry,
  checks its integrity, and writes it into the draft. The approval card lists the direct
  dependencies and a count of the rest.

## The kinds in detail

### `http`

- The manifest has `runtime: "http"`, `egress` (exact hosts), and `requests` (each with a `host`).
  It has no `home`, `navigation`, `cartUrl`, `auth`, `session.cookieDomains`, `session.storage`
  or `frameOrigins`. `session.probe` is `none`, or a `fetch` probe that runs through `ctx.http`.
- `ctx.http.fetch(url, { method, headers, body, credential? })` returns
  `{ status, headers, body }`. Redirects come back unfollowed. Valet refuses the `host`,
  `cookie` and hop-by-hop headers, and the header a named credential fills. Responses are capped
  at 4 MB, with 30 s time limits.
- WebDAV verbs (`PROPFIND`, `REPORT`, `MKCOL`, `MKCALENDAR`, `COPY`, `MOVE`) are added to the
  request methods, so CalDAV and CardDAV (iCloud calendars and contacts) work. `PROPFIND` and
  `REPORT` may be declared `read`.
- `ctx.http.websocket(url, { credential?, protocols? })` opens a socket on a declared `GET`
  path. Each message counts against the run's ceiling and upload budget. Each message is capped
  in size, and the socket closes when the call ends.
- `ctx.feeds.parse(text)` parses RSS, Atom and JSON Feed into one shape. It's a pure-JS parser
  bundled into the sandbox prelude, so parsing never happens in the main process.
- The authoring guide's API-as-home workaround (#111, #112) is kept for browser adapters that
  also call an API, and dropped as the advice for pure APIs.

### `protocol`

Valet ships a client for each protocol. It runs in a **protocol host**: a Node process that runs
only Valet's own vetted code, under the same kind of sandbox profile as F3, whose only network is
the broker. It gets each secret just in time from the main process. Parsing hostile mail or file
listings therefore never happens in the main process. Adapter code in QuickJS calls typed
capabilities, and each one is checked against the tool's purpose before the protocol host
touches the server.

| Protocol | Library (to confirm in the thread) | Read                                                                                                                                                    | Write                                               | Irreversible                                                                                  |
| -------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| IMAP     | `imapflow`, `mailparser`           | List folders. Open a folder read-only (`EXAMINE`), so a fetch never marks mail as read. Search. Fetch envelopes, structure, and bodies with `BODY.PEEK` | Set flags, copy, move, append, create folders       | Expunge, delete folders                                                                       |
| SMTP     | `nodemailer`                       | None                                                                                                                                                    | None                                                | Send, through `confirm()`; `From` fixed to the account; optional recipient allow-list setting |
| SFTP     | `ssh2`                             | List, stat and read under declared roots                                                                                                                | Write, make folders and rename under declared roots | Remove                                                                                        |

- The manifest declares `protocols: { imap?: { endpoint, credential, folders? }, smtp?: {…}, sftp?:
  { endpoint, credential, hostKeySha256, roots: [{ path, access }] } }`. An SFTP host key is
  pinned, never trusted on first use.
- The capabilities return structured data, not raw protocol text. Mail bodies come back as text
  and HTML parts with size caps, and attachments as metadata unless a tool asks for one by its id.
- Folder and root allow-lists are enforced by the protocol host, not by adapter code.
- iCloud is the first real target. Its IMAP is `imap.mail.me.com:993` and its SMTP is
  `smtp.mail.me.com:587` with STARTTLS. Both need an app-specific password.

### Email sign-in links and codes

Some sites sign in by emailing a link or a code: claude.ai, for example. A browser adapter's
declarative login gets these from the IMAP protocol host, the same way it gets SMS codes from the
Messages database today (Nick, 2026-11-17). Any limit added to the mail boundary later applies to
sign-in mail too.

- **Two new login sources.** `otp` gains a `mail` source next to `messages`:
  `{ mail: { from, subjectContains?, pattern, maxAgeSeconds } }`. There's also a new auth step,
  `openMailLink: { from, subjectContains?, linkOrigin, maxAgeSeconds }`. It opens the link in the
  **auth partition**, the same isolated browser that asked for the email, so a site that signs
  you in when the link is opened in the same browser does so. The session is then handed to the
  tool partition as usual, and it stays signed in between runs in the persistent partitions, so
  sign-ins are rare.
- **Valet runs the lookup, not adapter code.** A sign-in link is a login secret. If a mail
  adapter's agent-written tool code found it, that code would see it and could swap in another
  link. Instead, the protocol host runs one built-in, read-only operation. It opens the inbox
  with `EXAMINE`, keeps only messages from the approved sender that arrived after the login asked
  for the email and inside `maxAgeSeconds`, and takes the first link whose origin is
  `linkOrigin`, which must be on a `navigation` origin. The result goes to the auth runner as a
  secret value. It never reaches tool code, tool output or MCP, and its use is audited as
  `secret-used`.
- **Grant.** The person binds the browser adapter's mail source to a mail account Valet already
  holds a kept credential for, and approves the sender. That's the same grant shape as a Messages
  sender. Waiting polls with backoff for up to `maxAgeSeconds`, within the site's own pacing. If
  nothing arrives, the login ends with `needsUser`.

### `raw`

- `runtime: "raw"`, with `endpoints: ["host:port", …]` (exact, and each also covered by an
  entrusted credential or marked as needing none), plus `privateHosts`, read paths and optional
  read-write paths.
- Code runs in F3's Node runtime. `ctx.secrets.get(name)` returns an entrusted credential's value.
  The tool context otherwise matches the other kinds (`confirm`, `pace`, settings), without `page`.
- Every F2 entrusted limit applies. The broker's SNI check and upload budget are the main defences
  against the two routes no host allow-list closes: logging in to another account on a shared
  host, and slipping the secret into tool output.

## Approval cards and the permission diff

Each new thing a manifest can ask for becomes a line in the permission diff
(`packages/core/src/permission-change.ts`, `sandbox-diff.ts`), with a risk rating. The new things
are a runtime kind, an endpoint, a private host, a protocol scope, a credential and its custody,
read-write paths, and dependencies. A version that adds any of them needs approval like any other
change. `raw` is approved on the phone or the Mac, like everything else (Nick). The iOS and Mac
cards use the same wording source (`display-text`).

## Authoring

- `valet_create_draft` takes `runtime`. The authoring guide gets a section for each kind, and
  `valet_check_draft` validates each kind's manifest rules.
- Live trials and cases run through the broker and the protocol host with the same checks as live
  calls. A trial without a granted credential fails with `needsUser`, naming the credential.
- `valet_add_dependency` (`raw` only), as described in F3.

## Testing and red team

- **Fakes only. No test touches a real account.** The fakes are a local HTTPS and WebSocket server,
  a fake IMAP server, `smtp-server` for SMTP, and `ssh2`'s server for SFTP, all on loopback with
  test certificates. Valet's fake 1Password and in-memory Keychain supply the credentials.
- Sandbox profile behaviour is tested on the macOS CI runner, as `command` is today. These tests
  are never skipped on macOS.
- Each workstream ends with a red-team pass by an agent instructed to attack it. It focuses on
  attacks an agent could drive: a hostile adapter, a hostile server and a prompt-injected author.
  Findings are fixed, or written down as residual risks in this doc, before merge. Baseline
  attacks for every kind:
  - getting a kept secret, or an encoding of it, into tool output, a file or an undeclared
    endpoint;
  - reaching an undeclared host, a private address, Valet's own ports or DNS;
  - a write or irreversible action from a `read` tool;
  - outliving the call, or keeping state between calls;
  - escaping the sandbox profile through file paths, symlinks, Mach services or child processes;
  - a hostile server: oversized and malformed responses, IMAP literals, decompression bombs and
    redirect loops.
- The one live trial is read-only against Nick's real iCloud mailbox. It happens at the very end,
  with Nick present.

## Workstreams

Each one is a thread, a PR or more, and its own red team. There are at most four build threads at
once, counting other work.

| Wave | Workstream                                                                                                                                        | Needs                         |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| 1    | **A. Broker and `http`**: F1, private hosts, the `runtime` field, `ctx.http` (WebDAV, WebSocket, feeds), authoring and guide                      | —                             |
| 1    | **B. Secrets v2**: F2, `credentials`, token and SSH-key fields, grants, redaction of encodings, card wording                                      | —                             |
| 1    | **C. Node runtime**: F3, the profile generator, the preload shim, bundling dependencies, `valet_add_dependency`                                   | —                             |
| 2    | **D. IMAP**: the protocol host, `ctx.imap`, a fake IMAP server, iCloud specifics, [email sign-in links and codes](#email-sign-in-links-and-codes) | A, B (C's profile when ready) |
| 2    | **E. SFTP**: `ctx.sftp`, pinned host keys, Valet-generated keys                                                                                   | A, B                          |
| 2    | **F. `raw` adapters**: `ctx.secrets`, SNI check, upload budgets in practice                                                                       | A, B, C                       |
| 3    | **G. SMTP**: `ctx.smtp`, irreversible sends, recipient allow-list                                                                                 | D                             |
| 3    | **H. Example adapters**: Hacker News and an RSS feed over `http`, CalDAV and CardDAV against fakes, a WebSocket example, a raw example            | A–F                           |
| 3    | **I. Cross-kind red team**, plus the live iCloud read trial with Nick                                                                             | everything                    |

**Who owns which contract.** A owns `runtime`, `egress`/`endpoints`/`privateHosts` and the
broker API. B owns `credentials` and the redaction contract. C owns the runtime host protocol
and the profile generator. D, E and G own their own `protocols.*` entries. Each workstream merges
`main` often. A change to someone else's contract goes through that workstream's thread.

## Decisions for Nick's review

Nick was away while these were built and asked each thread to take its own recommendation and
note it here. Each one can be reversed.

**Workstream C (the Node runtime, [node-runtime.md](node-runtime.md)):**

- **One process per call, not one per adapter hash.** The design said "one process per hash,
  killed when idle". The build starts a fresh process for every call, so no state carries between
  calls. Node starts in well under a second, so the cost is small.
- **One loopback port per endpoint.** The broker opens one listener per declared endpoint for each
  process, rather than one CONNECT proxy with a token. The shim stays synchronous, and code that
  goes around it reaches nothing more.
- **Three days before a release can be added.** `valet_add_dependency` picks the newest version in
  range that has been public for three days, the same rule this repository's own lockfile follows.
- **No audit event for adding a dependency.** The addition lands in the draft's lockfile, and the
  approval card shows the dependencies when the draft is submitted. That card is the decision point.
- **A memory cap on the whole process.** Valet ends a process whose resident memory passes 1 GB
  (the heap alone is capped at 256 MB), found by the red team.
- **Shipping the signed Node binary is a follow-up.** It touches the release signing setup, so it
  gets its own pull request. Until then nothing uses the runtime: `raw` stays refused (workstream F).
