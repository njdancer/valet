# Adapter kinds beyond the browser

Status: **Agreed direction, partly built** (A `http`, B secrets v2, C the Node runtime and F `raw`; see each
"As built"). Nick agreed this on 2026-11-17, after discussing it from
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

#### As built (workstream A)

- `@valet/egress` is the broker: `EgressBroker(endpoints, options)` with `fetch(url, request, run)`,
  `websocket(url, options, run)` and `tunnels(run, { admit, plainTcp })`. A `RunContext` is
  `{ meter, signal, record }`: one `RunMeter` per call holds its upload budget, and `record` writes
  each connection's `egress-connection` audit event with bytes up and down.
- `packages/runtime/src/guarded-http.ts` is `ctx.http`. It shares the request checks with the
  page's fetch (`call-gate.ts`): the request surface with private hosts and exact ports, the
  tool's side effect and unlocks, the ceiling, the site's pace and breaker (a 429 or a 403 HTML
  page trips it, as in the browser), and a sticky `request-blocked` refusal.
- An `http` adapter gets `noBrowserDriver()`: no browser window at all; `ctx.page` refuses
  everything with `tool-run/not-granted`.
- Drafts: `valet_create_draft` takes `runtime: "http"` for a blank http draft. Cases answer
  `ctx.http` from the case's `fetch` list through the real guard. Live trials of an http draft go
  through the broker with read-only rules and reach the draft's public hosts only.

#### Decisions for Nick's review (workstream A)

Taken while Nick was away, each the recommendation. Any can be changed.

1. **Bodies are capped at 2 MB, not 4 MB.** A response crosses into the sandbox as JSON text, and
   the channel's message limit is 4 million characters; 2 MB still fits once written as base64.
2. **Feeds are a library function, not a capability.** Tool code imports `parseFeed` from
   `@valet/core`. It's pure JS, so it runs in the sandbox either way, and it needs no grant.
3. **A WebSocket message doesn't count as a request.** Opening a socket does (ceiling and pace).
   Counting every message would end a ticker after a few ticks; bytes sent are bounded by the
   upload budget instead.
4. **Live trials of a draft never reach its private hosts**, even with a `private-network`
   authoring grant. Cases cover them; the first real call is after the person approves the
   adapter, whose card lists each private host as a high-risk line.
5. **Authorization is refused outright** in tool code's headers. Once secrets v2 lands, it only
   ever comes from a kept credential the runtime adds.
6. **No signed-in http adapters yet.** An http manifest's probe is `none`; a `fetch` probe through
   `ctx.http` waits for credentials (workstream B).
7. **Routing headers are refused, on ctx.http and ctx.page.fetch alike**: `Forwarded`, `Via`,
   `X-Rewrite-URL`, `X-Host`, the client-address headers and the `X-Forwarded-*`, `X-Original-*`,
   `X-Envoy-*`, `X-Amzn-*` and `CF-*` families. Servers may route by them over the request line.
8. **Deny segments ignore a format suffix**: `/pay.json` and `/pay.` count as `/pay` everywhere, the
   browser path included.
9. **A request carrying a credential goes `accept-encoding: identity` and may not set Range**, an
   answer to it that is compressed or holds any 12-character piece of the token is refused, and its
   whole, base64 and JSON-escaped forms are redacted from the call's output and audit targets.

#### Red team (workstream A, 2026-11-17)

An adversarial pass on the broker, ctx.http, the XML reader and http drafts, as an agent that
writes both the manifest and the code. No critical or high findings. Fixed before merge, each with
its proof-of-concept kept as a test (`*.redteam.test.ts`):

- Path and host override headers (`X-Original-URL` and the rest) passed to the site (medium).
- WebDAV `Destination` was an unchecked second target. COPY and MOVE now need one, on the same
  origin, passing the request surface as if requested itself, and it is sent as checked; no other
  method may carry one (medium).
- Credential redaction was an exact match, so a gzipped or Range-split echo got past it, and the
  final output wasn't redacted for it (medium, latent until secrets v2 is wired).
- Deny segments missed `pay.json` (medium).
- A public name answering with one of this Mac's own public addresses was dialled (low; medium for
  raw tunnels).
- The XML reader copied namespace scopes per element: quadratic CPU (low).
- Concurrent socket opens passed the cap of 4 (low).
- WebSocket subprotocols weren't spent from the upload budget (low).
- `::ffff:0:a.b.c.d` (SIIT) counted as public; Tailscale's `100.100.100.100` and
  `fd7a:115c:a1e0::53` could be private hosts although this Mac answers them (low).

Residual risks, accepted for now:

- **Exfiltration to a declared endpoint, up to the upload budget.** By design: the budget, the
  declared hosts and the card are the limit.
- **Domain fronting inside a raw tunnel.** The broker checks SNI, not the HTTP Host inside TLS it
  can't read. Most CDNs now refuse a mismatch; raw adapters are high risk on the card regardless.
- **Tunnel ports must be registered as Valet's own** by the Node runtime (workstream C), so a raw
  adapter can't reach another adapter's tunnel.
- **A credential the server transforms** (hashed, re-encoded some other way) is not recognised.
  Only an exchange the host's own API chooses to make can do that.

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

#### As built (workstream B)

**Built**, except granting a credential in the app (the approval card and Mac screen), which is
B's follow-up. Where each part lives, for the workstreams that use it:

- **Declaration.** `packages/core/src/credential.ts`: `credentialDeclarationSchema`, and
  `credentialIssues(credentials, runtime, secretNames)`, which `manifestSchema` runs with
  `runtimeOf(manifest)`. Each runtime may declare only its own use: `http` a header, `protocol` a
  protocol sign-in, `raw` an entrusted credential, `browser` none (its logins are `secrets`). A
  credential may not share a name with a secret. Until A's `runtime` field lands, every manifest is
  a browser adapter, so any `credentials` are refused.
  - Endpoints are `host:port`: a lower-case DNS name, an IPv4 literal or a bracketed IPv6 literal.
    Header hosts are a lower-case DNS name or an IPv4 literal (a private host). Neither has
    wildcards. The broker (A) decides which of them are reachable.
  - A header credential fills one header from an allow-list: `authorization`, `x-api-key`,
    `api-key`, `apikey`, `x-auth-token`, `x-access-token`, `private-token`, or a vendor's own
    `x-<vendor>-key` or `x-<vendor>-token` (never one starting `x-forwarded`, `x-original`,
    `x-rewrite`, `x-http-method`, `x-method`, `x-real`, `x-client`, `x-host` or `x-proxy`). Its
    format is the placeholder alone or after one scheme word (`Bearer {value}`, `Token {value}`,
    `Basic {basic}`), so it can't carry a path or words for a card. `{basic}` is RFC 7617
    `username:password` in base64, for a password credential only. The filled value must be
    printable ASCII. `credentialHeaderNames(manifest)` lists the names tool code must never set.
  - Hosts are at most 100 characters and credential names at most 40, so a card never cuts one.
    `messages` is reserved.
  - Fields per kind: a password is `username` and `password`, a token is `token`, an SSH key is
    `ssh-key` and an optional `username`. 1Password references: `token` reads an API Credential
    item's `credential` field, `ssh-key` reads an SSH Key item's `private key` in OpenSSH format.
    A Keychain copy can hold all four.
- **Grants.** `CredentialGrant` (core) and `FileCredentialGrantStore` (`packages/credentials`),
  in their own file beside the secret grants, with the same file rules (`SecureJsonFile`). A grant
  names the adapter, hash, credential, kind, custody, provider, item and targets (a non-empty
  subset of the declaration's). `credentialCarriesOver` (desktop `grants.ts`) keeps a grant across
  an approved update only when the credential's kind, custody, protocol or header are unchanged
  and its targets are the same or fewer.
- **Valet-made SSH keys.** `ValetKeys` (`packages/credentials/src/valet-key.ts`, provider
  `valet-key`) makes an Ed25519 key in OpenSSH's own format, writes the private half straight to
  Keychain service `valet.key`, and keeps the public line and fingerprint in the item's comment.
  Grant references are `valet-key:<uuid>`.
- **Handing a credential out.** `CredentialGate` (`packages/runtime/src/credential-gate.ts`) is
  the only way a non-browser adapter's credential leaves its provider:
  - `headerFor(credential, host)` for A's `ctx.http`: returns `{ name, value }` for that one
    request;
  - `signIn(credential, protocol, endpoint)` for the protocol host (D, E, G): returns the username
    (or null) and the secret;
  - `entrusted(credential)` for F's `ctx.secrets`: returns the value and the endpoints it may
    reach, narrowed to the grant's.

  Each checks the declaration, the use, the target and the grant (same adapter, hash, kind and
  custody, targets within the declaration's) before resolving anything. It then registers every
  value for output redaction, audits `secret-used` with the target and `custody`, and only then
  hands it over. If either step fails, nothing is handed over.
- **Redaction.** `packages/runtime/src/secret-forms.ts` adds each secret's encoded forms to the
  run's redaction set: base64 and base64url at all three alignments (so a secret inside a longer
  string encoded as a whole is still found), of the UTF-8, UTF-16LE and Latin-1 bytes, and twice
  over; hex; percent, URL, form and `URLSearchParams` encoding; JSON and `\uXXXX` escapes; the
  value and its reverse in any case; for an SSH key each line and the body joined; and for a value
  of 24 characters or more, 16-character windows every 8, so any 24 characters of it in a row are
  caught however the rest was cut or rewrapped. Each string is also matched after decoding
  (`normalisedViews`: NFKC, format characters removed, percent escapes up to three deep, HTML
  entities, `\u` and `\/` escapes, white space removed). `redactOutput` finally checks the
  whole output and every string run together, and fails the call if a secret is still there (a
  secret split across two values). Forms shorter than 6 characters are dropped, and a username is
  never registered, so mail addresses and paths survive. It applies to browser secrets too.
- **Residual risks (red team, 2026-11-17).** Redaction is a backstop for what a hostile `raw`
  adapter does with an entrusted value: a transform it doesn't list (ROT13, octal, XOR, a cipher,
  hex with separators, one character per call) is not caught. The boundaries are the endpoints and
  the upload budget (A, F). Two duties fall on the workstreams that call the gate:
  - **A:** a server can echo a kept header (a debug endpoint returning `Authorization`).
    `ctx.http` must redact responses, headers and bodies, against the run's set before they reach
    QuickJS, or the adapter would see a kept value.
  - **F:** a raw adapter process lives across calls, so an entrusted value it was given in one call
    can come back in a later one. Its values belong in a redaction set that lives as long as the
    process, not the call.
- **Cards.** `describeCredentialUse` builds one sentence from the declaration's structured fields
  only, never the author's description. The Mac's install lines use the new `credential` area,
  always `high` and never `critical`, so a `raw` adapter is approved on the phone or the Mac like
  everything else. The phone parses the new area (and the `auth-steps` and `probe` areas it was
  missing), and a shared test vector now keeps the two lists equal.
- **Audit.** `secret-used` gains `custody` for credentials, with `origin` holding the target.
  New events `credential-granted`, `credential-revoked` and `key-generated` are defined for the
  follow-up.
- **Mail sign-in sources** (above) fit the secret-grant shape of a Messages sender, not a
  credential grant: the mail account they read is a kept `imap` credential granted as here.

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
  `cookie` and hop-by-hop headers, and the header a named credential fills. Bodies are capped at
  2 MB each way (so a body still fits the tool channel as base64), with 30 s time limits.
- WebDAV verbs (`PROPFIND`, `REPORT`, `MKCOL`, `MKCALENDAR`, `COPY`, `MOVE`) are added to the
  request methods, so CalDAV and CardDAV (iCloud calendars and contacts) work. `PROPFIND` and
  `REPORT` may be declared `read`.
- `ctx.http.websocket(url, { credential?, protocols? })` opens a socket on a declared `GET`
  path marked `websocket: true`. Opening it counts against the run's ceiling and takes a pacing
  slot; each message sent is spent from the upload budget. Messages are capped at 1 MB, at most
  four sockets are open per call, and they close when the call ends.
- `parseFeed(text)` (imported from `@valet/core` in tool code) parses RSS, Atom and JSON Feed into
  one shape, and `parseXml(text)` reads CalDAV and CardDAV answers with namespaces resolved. Both
  are pure JS in the tool library the sandbox loads, so parsing never happens in the main
  process, and neither takes a DOCTYPE, so no entity tricks.
- The authoring guide's API-as-home workaround (#111, #112) is kept for browser adapters that
  also call an API, and dropped as the advice for pure APIs.

### `protocol`

Valet ships a client for each protocol. It runs in a **protocol host**: a Node process that runs
only Valet's own vetted code, under the same kind of sandbox profile as F3, whose only network is
the broker. It gets each secret just in time from the main process. Parsing hostile mail or file
listings therefore never happens in the main process. Adapter code in QuickJS calls typed
capabilities, and each one is checked against the tool's purpose before the protocol host
touches the server.

| Protocol | Library (to confirm in the thread)                    | Read                                                                                                                                                    | Write                                               | Irreversible                                                                                  |
| -------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| IMAP     | Valet's own ([imap.md](imap.md))                      | List folders. Open a folder read-only (`EXAMINE`), so a fetch never marks mail as read. Search. Fetch envelopes, structure, and bodies with `BODY.PEEK` | Set flags, copy, move, append, create folders       | Expunge, delete folders                                                                       |
| SMTP     | Valet's own ([smtp.md](smtp.md))                      | None                                                                                                                                                    | None                                                | Send, through `confirm()`; `From` fixed to the account; optional recipient allow-list setting |
| SFTP     | `ssh2` for SSH, Valet's own SFTP ([sftp.md](sftp.md)) | List, stat and read under declared roots                                                                                                                | Write, make folders and rename under declared roots | Remove                                                                                        |

- The manifest declares `protocols: { imap?: { endpoint, credential, folders? }, smtp?: {…}, sftp?:
  { endpoint, credential, hostKeySha256, username?, roots: [{ path, access }] } }`. An SFTP host
  key is pinned, never trusted on first use ([sftp.md](sftp.md)).
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

#### As built (workstream F)

- `runtime: "raw"` is in `AVAILABLE_RUNTIMES`. Its manifest (`rawIssues` in `packages/core/src/manifest.ts`)
  has `endpoints` and/or `privateHosts` (without `certSha256`), and no `home` (derived from the first
  endpoint, for pacing only), `navigation`, `cartUrl`, `egress`, `requests`, login or irreversible
  tools. Its only sandbox exceptions are `files`, which become the profile's read and read-write
  paths (`apps/desktop/src/main/core/raw-runtime.ts`). An entrusted credential's endpoints must be
  among its endpoints or private hosts.
- **A call** (`ToolHost.rawFor` in `packages/runtime/src/tool-host.ts`): the Node runtime starts a
  process for the call (`nodeRuntimeProcess`, binary `Contents/MacOS/valet-node`); its tunnels come
  from `EgressBroker.tunnels` with the call's own `RunMeter` (the tool's upload budget), and each
  connection takes one request from `requestsPerRun` and one pacing slot. Every connection is audited
  as `egress-connection` (`kind: tunnel`). A connection the broker refuses for `upload-budget`,
  `sni-mismatch` or `host-not-allowed` fails the whole call, even if tool code catches the socket
  error. A raw adapter has no `ctx.page`, `ctx.http` or `ctx.local`; without the runtime (off macOS,
  no binary) its calls are `tool-run/unavailable` and it never runs anywhere else.
- **Tunnel ports are Valet's own.** Each tunnel is a `net.Server` in the main process, so
  `own-ports.ts` records its port while it listens: no `local-service` exception can reach it, and the
  profile lets each process reach only its own call's ports.
- **`ctx.secrets.get(name)`** returns `{ value, username }`. It goes through a `CredentialGate`
  (`entrusted`): declared, entrusted, granted for this exact hash, registered with its encodings for
  the call's redaction and audited as `secret-used` before anything is handed over. Before the value
  is returned, the call's tunnels are **narrowed** to that credential's endpoints
  (`TunnelSet.restrict`): every open connection to another endpoint is closed, and a new one is
  refused and fails the call. Narrowing never widens again.
- **Loading.** A raw package compiles with `Compiler.compileNode` against its dependencies, read from
  Valet's tarball store and checked again, and is described in the Node runtime with no network.
- **Authoring.** `valet_create_draft` takes `runtime: "raw"` (a blank draft with one TLS endpoint and a
  case). A raw draft's cases run in the Node runtime with no network at all, and a case naming
  `pages` or `fetch` fails. A live trial reaches the draft's public endpoints only, through the
  broker's tunnels, with a read's upload budget and the site's pace, and is never given a credential.
- **Cards.** The kind is a high line, not critical, so a raw adapter is approved on the phone or the
  Mac (Nick). Each endpoint is a high line ("its own encrypted connection; Valet checks the server
  name"), each private host says "its own connection", and the npm packages are a high line on every
  version's card (direct ones by name and version, and a count of the rest).
- **Tests.** `packages/node-runtime/test/raw-adapter.e2e.test.ts` (the tool host, the real broker and
  Node runtime, fake HTTPS API), `apps/desktop/test/main/raw-drafts.test.ts`, the raw cases in
  `service.test.ts`, and `manifest-raw.test.ts`. CI runs the Node runtime's tests and the raw drafts'
  under Seatbelt on the macOS runner on every PR.

#### Decisions for Nick's review (workstream F)

Taken while Nick was away, each the recommendation. Any can be changed.

1. **Raw is high risk on the card, not critical.** Workstream C's diff rated it critical, which would
   have made it Mac-only. Nick said raw adapters get the same approval as everything else.
2. **No irreversible tools in a raw adapter, for now.** `confirm()` names declared requests, and a
   raw adapter has none, so nothing could ask the person before an action that can't be undone. A
   raw confirmation (the tool and its input on the card) is a follow-up; it needs a new card kind
   on the phone.
3. **Every public endpoint is TLS from its first byte, with its own name.** No plain TCP or STARTTLS
   to a public host: the SNI check is the main defence on a shared host. IMAP and SMTP with STARTTLS
   belong to the `protocol` kind.
4. **Getting a credential narrows the call to its endpoints**, closing other connections, rather than
   refusing a credential to a call that has other connections open.
5. **What the broker refuses ends the call** (upload budget, another server name, a refused
   endpoint), so its output never leaves.
6. **Each connection is one request** against `requestsPerRun` and one pacing slot.
7. **Files are the only exceptions**, as profile paths: `/*` and `/**` both mean the folder.
8. **A trial never gets a credential**, and never reaches a private host: unapproved code is never
   entrusted with anything.
9. **A raw process's stderr is dropped**, not logged: it can hold anything the adapter printed.
10. **Entrusted credentials use B's grants as they are.** A raw adapter's registration takes the same
    `credentialKeeper.sourceFor(id, hash)` as every other kind, so an entrusted credential is
    granted in the app like a kept one, and carries over to an update only on B's terms.
11. **A raw adapter with an entrusted credential keeps no read-write files** (found by the red team
    below). Narrowing and redaction are per call, so a folder that outlives the call would carry the
    secret to a later call that never asked for it. Its per-call temporary folder is removed after
    each call. Read-only file paths are still allowed.

#### Red team (workstream F, 2026-11-17)

An adversarial pass on raw adapters, as an agent that writes the manifest and the code and may run a
server at an allowed endpoint. Fixed before merge, each with its proof of concept kept as a test
(`*.redteam.test.ts`):

- **A raw draft's live trial ran with the draft's own `files` exceptions (high).** The trial handed
  the runtime the draft's manifest, and the runtime turns `files` into profile and permission-model
  paths. Unapproved code could read the person's files (or write to them from a "read" trial) and
  return or upload them before any card was shown. A trial's process now gets no file paths, like
  every other trial and case.
- **A read-write folder carried an entrusted secret between calls (high).** A call given the token
  could write it to the adapter's read-write folder, and a later call that never asked for it could
  read it and send it to any declared endpoint, or return it unredacted. Closed by decision 11.
- **A tunnel listener's later error could crash Valet's main process (low).** A failed accept (out
  of file descriptors) is an `'error'` event on the server, and after `listen()` nothing handled it.
  It now closes that call's tunnels.

Held: `restrict` closes connections mid-hello, mid-dial and open; narrowing asked for before the
tunnels open applies when they open; the SNI parser refuses duplicate extensions, ECH, trailing
bytes, zero or several names, oversized and SSLv2 hellos; held ClientHello bytes count against the
upload budget; private hosts can't be loopback or this Mac; IP-literal public endpoints are
dropped; at most 16 connections per call; isolation errors carry only a stage and class.

Residual risks, accepted for now:

- **Side effects in a raw adapter are claims.** The broker can't see inside TLS, so a tool declared
  `read` can make any request its endpoint accepts (a `DELETE`, say) within a read's upload
  budget. "No irreversible tools" only changes the label.
- **Transforms redaction doesn't list.** Shifting each character code, a cipher, or similar still
  gets an entrusted value into tool output (as workstream B noted). The endpoints and the budget
  are the boundary.
- **Timing channels to an allowed endpoint aren't budgeted.** When the adapter reads
  (backpressure), when it closes connections, and how many it opens can signal a server it
  controls. Only the per-connection request count limits this.
- **Unverified on macOS:** the profile lets the adapter read `kern.hostname` (the Mac's name, often
  the person's). (`(remote ip "localhost:PORT")` matching `::1` and UDP is closed: the rule is now
  `remote tcp4`, workstream I.)

## H. Example adapters

Worked examples an agent can start a draft from (`valet_create_draft` with `from: "example"` and an
`example` name), one per thing the new kinds can do. They live under `examples/`, each a package
with a README, its own cases and fixtures. None is installed or approved by anyone; a draft from one
goes through the same check and approval as any other.

#### As built (workstream H)

| Example           | Kind   | What it shows                                                                                         |
| ----------------- | ------ | ----------------------------------------------------------------------------------------------------- |
| `hacker-news`     | `http` | A public JSON API with no login and no home workaround: lists and items, HTML to text                 |
| `feed-reader`     | `http` | RSS (BBC News sections) and Atom (GitHub releases) from two hosts with `parseFeed`                    |
| `icloud-calendar` | `http` | CalDAV: discovery across hosts, PROPFIND, REPORT and an idempotent PUT, with a kept password          |
| `icloud-contacts` | `http` | CardDAV: discovery and an `addressbook-query` search, with a kept password                            |
| `home-hub`        | `http` | A private host pinned by its certificate, a kept token, REST to read and a WebSocket (a write) to act |
| `cache-reader`    | `raw`  | Its own TLS to one endpoint, the `redis-parser` npm package, and an entrusted password                |

- **Fakes.** `fakes/example-services` answers as each service, by Host and TLS name: Hacker
  News's API, BBC News's feeds, GitHub's release feeds, iCloud-style CalDAV and CardDAV (Basic
  auth, a principal on `caldav.icloud.com` and the data on a partition host), a home hub on
  `192.168.1.20:8123` (https with a self-signed certificate, REST and a WebSocket that needs the
  token on the upgrade), and a Redis-style cache over TLS with an ACL. Each records what reached it.
- **End to end** (`apps/desktop/test/main/examples.e2e.test.ts`): each example starts as a draft
  from the example, passes `valet_check_draft` with every case, and runs for real. Live trials
  reach the fakes through the real egress broker. Then each runs as installed, through `ToolHost`
  with the real broker, the real credential gate over a test grant, and for `cache-reader` the
  Node runtime, with `redis-parser` and `redis-errors` added by `valet_add_dependency` from a fake
  registry serving their real npm tarballs (vendored under `apps/desktop/test/fixtures/npm`).
- **What building them changed in Valet:**
  - **Cases can use kept credentials.** A case fills each kept header credential with a
    placeholder (`case-username`, `case-password`, `case-token`), through the real gate, so a tool
    that names a credential runs in a case as it would installed. Before, it failed as not granted,
    so no credentialed http adapter could pass its check.
  - **Cases can script a WebSocket** (`sockets`: server messages, the client messages the tool must
    send, and a close). Before, a case couldn't open one, so no WebSocket adapter could pass.
  - **`{ "inline": null }` answers JSON `null`** to `ctx.http` (it was an empty body), and `ctx.http`
    gets a fixture's text as it is.
  - **Fixtures may be `.xml`**, for feeds and WebDAV answers.
  - **Closing a socket that has closed already does nothing** (it failed the call as
    `tool-run/invalid`, so `finally { await socket.close() }` broke when the far end closed first).
    Using a closed socket is `egress/unavailable`.
  - **A raw adapter with npm dependencies can be installed.** The app's registry hashed sources and
    manifest only, while the package hash covers `valet-lock.json` too, so any raw adapter with a
    dependency failed its check with "The package hash did not match". Both formulas now add the
    lock the same way (`lockHashEntry` in core). Hashes of packages without a lock are unchanged.
  - The authoring guide lists the examples and covers kept credentials, pinned private hosts,
    sockets in cases, and the sandbox's lack of a `URL` class.

#### Decisions for Nick's review (workstream H)

Taken while Nick was away, each the recommendation. Any can be changed.

1. **Examples are drafts, not built-ins.** They ship embedded so an agent can start from one, but
   nothing is installed, so nothing new asks for Nick's approval.
2. **iCloud's partition hosts are named, not discovered.** iCloud keeps each account on its own
   server (`pNN-caldav.icloud.com`), which discovery names. Egress takes exact hosts only, so the
   examples name `p01` and say which server an account is on (`list_calendars` returns it), for a
   new version to add. A "discovered host" (allowed if a declared host names it) would remove the
   step, at the cost of a host the person never saw on the card. Not built.
3. **The home hub reads over REST and acts over its WebSocket, which is declared a write.** A
   socket's declaration covers every message sent on it, so a read-declared socket could act from a
   read tool. Declaring it a write keeps reads from opening it. Per-message purposes would let one
   socket do both; not built.
4. **The hub's token goes on the socket's upgrade**, as a kept credential. Hubs that want it in the
   first message (Home Assistant) can't be reached with a kept credential; that needs an entrusted
   one, which only `raw` may hold, or a "credential in a message" placeholder, which isn't built.
5. **A raw example takes an optional `caseReply` input for its cases.** Raw cases have no network, and
   the check needs a passing case that checks each tool's output, so the tool decodes a given
   answer instead of asking the cache. It's a read and only decodes what it is given. Scripted
   sockets for raw cases, like the http ones, would remove it.
6. **The cache example ships without its lockfile**, so the agent's first step is
   `valet_add_dependency`, as for any raw draft.
7. **Case credentials are fixed placeholders**, not values the case chooses, so a case can't make
   the gate hand anything else, and the fixtures don't check headers.
8. **Examples use `tool-run/not-found`** for a missing thing, as the authoring guide says. The blank
   http template used `tool-input` and now matches.

### Red team (workstream H, 2026-11-17)

A fresh agent attacked the case runner's credentials and scripted sockets, the socket-table change,
`from: "example"`, the lock in the package hash, `.xml` fixtures and the examples. PoCs stay as
`apps/desktop/test/main/examples.redteam.test.ts` and `registry-lock.redteam.test.ts`.

Fixed:

- **iCalendar property injection (medium).** `add_event`'s `title` and `location` could carry a lone
  CR or U+2028, which some parsers read as a new line, so a calling agent could add `ATTENDEE` and
  have iCloud email an invitation from the person's account. `escapeText` now escapes backslash
  (it didn't) and every kind of line break, and drops other control characters; the inputs refuse
  control characters and line breaks, as does `find_contacts`' name. `fold` counts UTF-8 octets and
  never splits a character. A case covers the lone CR.
- **Discovery could name any host (low).** `list_calendars` reported whatever server the DAV answer
  named, and the README tells agents to add it to the credential's hosts. Both iCloud examples now
  refuse a host outside `pNN-caldav.icloud.com` / `pNN-contacts.icloud.com`; the guide says to check
  discovered hosts against the provider's pattern.
- **The raw example's test input (low).** Renamed `reply` to `caseReply` so its purpose is plain to
  anyone copying it.

Held: the lock hash matches core's `adapterHashOf` with and without a lock and any change to it
changes the hash; `snapshotIntact` catches a tampered, added or removed lock; reserved hash entries
are refused; case credentials follow the real gate (hosts, https only, no hand-set header); a read
tool can't open a write socket in a case; unexpected messages and unlisted sockets fail a case; only
issued socket ids get the no-op close.

Residual risks:

- An installed `cache-reader` still accepts `caseReply`, so a caller can make `get_key` return what
  it chose. No credential or network is involved. Scripted sockets for raw cases would remove it.
- `TLS_OPTIONS` is exported so tests can add a CA; a copied version could add
  `rejectUnauthorized: false`, which the approval card wouldn't show.
- A case passes even when a scripted socket's `client` steps or its `fetch` entries go unused, so a
  passing case is weaker evidence that a write tool sends what it should.

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

**Workstream E (SFTP, [sftp.md](sftp.md)):**

- **`ssh2` for the SSH transport only, with Valet's own SFTP client.** As with IMAP, owning the
  SFTP side is what lets the wire refuse any packet, open flag or path the session's purpose and
  roots don't allow. `ssh2`'s own SFTP code would have needed the same checks wrapped around it.
- **A separate host bundle for SFTP.** It carries `ssh2` and its pure-JavaScript dependencies; the
  IMAP host stays free of npm code. `ssh2`'s native and WebAssembly parts are left out, so
  chacha20-poly1305 isn't offered (AES-GCM and AES-CTR are). Compression is never offered.
- **Keys only, no passwords yet.** The credential is a kept `ssh-key` Valet makes. A password could
  follow if a server needs one.
- **The host key is pinned in the manifest, never trusted on first use.** The author finds it with
  `ssh-keyscan` and `ssh-keygen -lf`, and the card shows it. A changed key fails the call as
  `egress/host-key-mismatch`, a new error class.
- **A private IP address may be the endpoint directly**, shown as a high-risk "on your network"
  line, rather than declared again under `privateHosts`. A NAS is the main use.
- **The item's username wins over the manifest's** `username`, which is the fallback.
- **Replacing a file is irreversible**; creating never overwrites, appending needs an existing
  file, and rename never overwrites. `remove` takes files and links only, `removeDir` empty
  folders only, so nothing deletes a tree in one call.
- **Roots are never changed**, renamed, removed, or carried away by renaming a folder that holds
  one. The deepest root decides what a path allows, and `/` is a valid root.
- **Links are followed for reads only when the target stays inside the roots**; nothing is ever
  written through a link.
- **No new permission areas on the card.** The server is a Network line (or Your network) and each
  root a Requests line, risk by its access. New areas would need an iOS app change.
- **The broker's tunnel turns off Nagle's algorithm** on the sockets it accepts (workstream A's
  code). SSH sends small writes one at a time; without it each operation took about a second.
- **No authoring support yet.** `valet_create_draft` makes `browser` and `http` drafts only, as for
  IMAP, so the guide doesn't describe `ctx.sftp` until drafts can be `protocol` ones.
- **The app wiring is a separate pull request**, following IMAP's (the SFTP host bundled beside
  the IMAP one, on the raw runtime's Node binary). Until it lands, the app registers no SFTP
  backend, so SFTP tools answer not-granted.
- **Residual risks.** Another client of the same server can swap a folder for a link between
  Valet's check and its use; SFTP has no way to open relative to a checked handle. A root that the
  server resolves to `/` widens what the resolved-path check allows to everything that account can
  reach. File names come back as the server sends them (bidirectional characters included).
  Windows short names (`KEEP~1`) aren't folded, so a nested narrower root on a Windows server can
  still be reached that way; avoid nesting roots there.
- **Red team (2026-11-17).** Four findings, all fixed ([sftp.md](sftp.md#red-team)): renames
  across roots of different access, case-insensitive servers reaching a nested narrower root, card
  wording for write access, and quadratic packet reading. It found no way past the path form, the
  link checks (both kinds of `REALPATH`), the purpose checks at the wire, or the host key pin
  (checked on every key exchange, re-keys included).

**Workstream D (IMAP and email sign-in, [imap.md](imap.md)):**

- **Valet's own IMAP client, not `imapflow` and `mailparser`.** The client is small (a reader with
  hard limits, structured commands, and a check of each command against the session's purpose
  just before it's written). Owning it is what lets the wire itself refuse `BODY[]`, `CLOSE`,
  plain `EXPUNGE` and anything outside the table, whatever a bug above it does. The libraries
  would also have needed bundling into the sandboxed host along with their dependencies. MIME is
  read from the server's `BODYSTRUCTURE` and `ENVELOPE`, so no general MIME parser is needed.
- **Folder names match exactly**, except INBOX in any case. `Receipts` doesn't cover its
  subfolders. Patterns were the alternative; they can wait until an adapter needs them.
- **`\Deleted` counts as irreversible**, whether it's added, removed or set on append, because
  marking a message deleted is the first half of losing it. Only `UID EXPUNGE` is ever sent, so
  an expunge removes just the messages a tool names. A server without UIDPLUS can't expunge.
- **An irreversible IMAP tool needs only its declared side effect.** An `http` adapter's
  irreversible request also needs the tool to name it. IMAP has no per-request declarations, so
  the tool's side effect (and the approval that comes with it) is the gate.
- **No private IMAP hosts yet.** `endpoint` must be a public host name. A home server can follow
  through `privateHosts` when someone needs one.
- **Sign-in mail is accepted without Authentication-Results** when the receiving server adds none.
  When it adds one, the topmost must show DMARC, or DKIM aligned with the sender's domain, as a
  pass. Refusing mail without the header would break servers that don't add it. iCloud adds it.
- **One sender per manifest**, so the person approves one address for a site's sign-in mail.
- **A link step needs `subjectContains`** (the design had it optional). The red team showed that
  a site's other mail from the same address, which anyone can trigger, would otherwise be taken
  for the sign-in mail. A code step may still leave it out, since a code must match the pattern.
- **Sign-in mail needs an account no tool can write INBOX in.** A message appended over IMAP
  carries whatever Authentication-Results its author wrote. The mail reader refuses an account
  whose adapter has any tool that may change INBOX. The app wiring must also check every other
  adapter on the same account when the grant is made.
- **Sign-in mail stays readable by the account's own read tools.** The lookup reads with
  `BODY.PEEK`, so the mail stays unread. An agent with a mail adapter that may read INBOX could
  read a sign-in link or code there, as Nick noted on 2026-11-17. Hiding sign-in mail from read
  tools, or redacting recently found links from every tool's output, could follow if wanted.
- **The mail grant's item is `<adapterId>/<credential> <sender>`**, under the reserved secret
  name `mail`, the same shape as a Messages grant.
- **Sign-in mail is polled every five seconds**, with one host session per account kept for 30
  seconds between polls (10 minutes at most), so the server sees one sign-in per login.
- **The app runs the protocol host from a file beside app.asar** (added 2026-11-17, with the
  app wiring). The sandboxed Node can't read inside app.asar, and Valet's data folder is one of
  the places its profile denies, so the main build emits `protocol-host.cjs` and electron-builder
  unpacks it into `app.asar.unpacked`, sealed by the app's signature. A development run uses
  `out/main` and `.node-runtime/valet-node`; without that binary, protocol adapters answer
  not-granted and sign-in mail is not offered.
- **The mail grant is a login grant, shown with Messages, not a credential grant** (2026-11-17).
  It lets a browser adapter's login read its own sign-in mail, so it sits in the site's Login
  card next to "One-time codes by SMS", uses the same grant sheet, and is signed as a
  `secret-grant` whose provider is now `mail` (the phone shows it as "Sign-in mail"). The
  `credential-grant` kind and secrets v2's Credentials card are for an adapter's own code, and
  stay as they are.
- **A mail account is checked again on every lookup** (2026-11-17). It must be an installed,
  approved protocol adapter whose kept IMAP credential has a grant that counts, with no tool that
  may change INBOX. Another adapter that may change INBOX and holds a grant to the same item also
  disqualifies it, since it may be the same mailbox. Nothing is copied into the mail grant, so
  revoking the account's password, an update that adds a write tool, or uninstalling it stops
  sign-in mail at once. The lookup signs in through that adapter's CredentialGate, so it is
  audited as that adapter's `secret-used`, and its connection as `egress-connection` with call
  `sign-in-mail`.
- **A mail grant carries over an update** only when every mail step of the new version is one the
  old version had (same sender, subject, link origin, pattern and age) and navigation doesn't
  grow, the same rule as Messages.

**Workstream G (SMTP, [smtp.md](smtp.md)):**

- **Valet's own SMTP client, not `nodemailer`.** Sending one message needs a few hundred lines,
  and owning them means every line on the wire is built from checked values. It also keeps the
  sandboxed host free of outside code, as for IMAP.
- **Two confirmations for a send.** The irreversible tool's own confirmation before it runs, then
  one for each message, showing Valet's rendering of it. The second is what makes the yes about
  the email itself, since the tool's input needn't be the message. Merging them into one card
  could follow, at the cost of asking before the tool has decided what to send.
- **From is the signed-in account, shown as "your account at smtp.mail.me.com".** The username is
  only known once the credential is used, which is after the person says yes. Showing the address
  itself would mean reading the credential before the confirmation.
- **No headers of tool code's own, no HTML, no attachments.** Plain text only, sent as base64, so
  no text can start a header or end the DATA. These can come later as typed fields.
- **Only an irreversible tool may send**, and a send from any other tool is a sticky violation.
- **Recipients may be limited to exact addresses or `@domain`**, with no subdomains. Bcc counts
  like any other recipient, and the confirmation lists it.
- **One send per host.** Each send starts a fresh host and signs in again, so nothing carries
  between messages. A tool sending ten messages signs in ten times.
- **Caps:** 50 recipients, a 300-character subject, 100,000 characters of text, 20 references.
- **The Message-ID is random, at the server's own domain** (`<uuid@smtp.mail.me.com>`), so it
  says nothing about the Mac. EHLO says `[127.0.0.1]` for the same reason.
- **Invisible characters are refused, emoji joined with a zero-width joiner among them.** The red
  team showed hidden text could ride an approved message. Emoji that stand alone still work.
- **`%` and `!` are refused in addresses**, so an `@domain` rule never relies on the domain's
  server refusing old-style relaying. An exact address rule ignores case, as nearly every mail
  server does.
- **The approval card doesn't list the recipients list yet**, as it doesn't list IMAP folders.

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
  gets its own pull request (#139, merged). Workstream F turned `raw` on.

**Workstream B (secrets v2):**

- **B: entrusted passwords are allowed, with a warning.** A `raw` adapter may be entrusted a
  `password` as well as a `token`, because app-specific passwords (iCloud's) are passwords. The
  card adds "Use a token or app password you can revoke." The alternative was to refuse entrusted
  passwords outright.
- **B: credential headers come from an allow-list**, not a deny-list: `authorization`, the common
  API-key headers and `x-<vendor>-key`/`-token`. A site needing another header name waits for a
  change to the list.
- **B: usernames aren't redacted** from tool output. Only the secret is, so a mail adapter's
  `from` and `to` fields survive. A username is not a secret, and redacting it made mail and
  SFTP adapters unusable.
- **B: a key Valet makes is never handed to adapter code.** Valet-made SSH keys are offered only
  for `kept` credentials. If an adapter wants the raw key, the person brings their own key from
  1Password.
- **B: a Valet-made key is tied to one adapter and one credential.** Its public line ends
  `valet.<adapter>.<credential>`, and a grant refuses a key made for anything else. So the
  server's authorized_keys line names what it lets in, and revoking deletes the key.
- **B: a grant carries over an update only when the update keeps the session.** That needs the
  person's signed approval of the update. A rollback never carries a grant, and revoking a carried
  grant also drops its carry record.
- **B: an agent asks for a credential by name only** (`valet_request_credential`). The ask
  goes to Needs you on the Mac, and **Choose and grant…** opens the site's page, where the person
  picks the item and approves with Touch ID. It isn't answered on the phone, because the phone
  can't choose an item. The agent never names or sees the item, and `valet_get_adapter` tells it
  only whether each credential is granted and usable.
- **B: credential asks have their own limits.** At most 3 per agent and 10 in all can wait at
  once. A declined ask holds the same agent's same ask back for an hour. Asks end after 24 hours,
  when the agent is disconnected or revoked, on lockdown, or when a new version is approved. Two
  agents asking for the same credential get two cards rather than one shared card.

### Decisions for Nick's review (workstream I)

Taken by the cross-kind red team while Nick was away, each the recommendation. The findings are
in [red-team.md](red-team.md#2026-11-17-cross-kind-red-team-workstream-i). Any can be changed.

1. **Folders and recipients are card lines, under "What kind of adapter it is".** No new card area,
   so phones on today's build read them. Every folder, INBOX, and every recipient line are high;
   another folder is medium.
2. **A kept IMAP or SMTP grant doesn't carry over a wider folder or recipient list.** The person is
   asked for the password again. Narrowing still carries.
3. **A send whose recipients don't all fit on the signed card is declined**, rather than sent to the
   Mac only, which would need a new field the phone understands. In practice that's more than about
   15 recipients. Addresses are capped at 190 characters (was 200).
4. **The body of a send may still be cut on the phone's card** (20 lines of 200 characters), with
   "and N more lines not shown". The Mac panel shows all of it. Recipients are what a yes is about.
5. **Sign-in mail stops while any non-protocol adapter holds the same mail password**, an http one
   included, though it can't speak IMAP. It's the cautious reading.
6. **The browser partition's proxy refuses a name that resolves to a non-public address**, the
   broker's rule. A site behind NAT64 (`64:ff9b::`) answers is refused too, as the broker refuses it.

Residual risks, accepted for now:

- **The same password in two items.** Items are matched by id, not value, so the mail password
  copied into a second 1Password item and granted to a raw adapter isn't noticed.
- **A mail grant follows the account adapter's updates.** It names the account adapter, not its
  endpoint or item, so an approved update that moves the account to another server, plus a new
  credential grant, moves where sign-in links come from. Both steps are the person's.
- **A raw adapter's new npm packages on the Mac review.** The phone's card lists them on every
  version; the Mac's review shows them only in the code diff.
- **The upload allowance grows with what a raw tunnel receives** (1 KB per 100 KB, no ceiling), so a
  server the adapter controls can raise it. Bytes received already reach tool output.
