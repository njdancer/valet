# Security for agent-run Valet

Workstream B of [plan-agent-run.md](plan-agent-run.md). Draft, 2026-11-12. This covers what changes
when the person's own agents set Valet up and write its adapters, when approvals reach a phone,
and when remote traffic goes through a relay instead of a tunnel. [security-model.md](security-model.md)
still covers everything else and has a short section pointing here.

The types this document names are in `packages/core` (`signing.ts`, `devices.ts`, `approvals.ts`,
`admin-actions.ts`, `trusted-store.ts`, `permission-change.ts`, `sandbox.ts`, `relay-protocol.ts`).
Status marks are the security model's: **Contract** means the types and checks are in core with
tests but nothing uses them yet; **Designed** means decided here and not built.

## Summary

- **Agents can do anything that only reads or tightens. Anything that widens what an adapter, a
  client or an agent can reach waits for the person.** One table in core decides which is which
  (`ADMIN_ACTION_TIERS`). The Mac looks the tier up from the action; the agent can't choose it.
- **Approvals are signatures, not clicks.** Every device (the Mac too) holds an approval key in its
  Secure Enclave that only works after Face ID, Touch ID or the device passcode. An approval counts
  only if that key signed the exact request. No MCP tool, renderer, relay or file write can make one.
- **The Mac builds every request.** The card's content is fields the Mac filled in from its own
  knowledge (the manifest diff, the grant's origins). The agent's own words appear only under
  "The agent says", never as the headline.
- **Stores carry their evidence.** Each approval, grant and remote-tool record keeps the signed
  approval that allowed it, and each store file's hash is anchored in the Keychain, so neither a
  forged record nor a rolled-back file is honoured.
- **The phone channel is end to end. MCP traffic is not.** The relay routes sealed envelopes
  between the Mac and its phones that it can't read or forge. Remote MCP and OAuth traffic is
  plaintext at the relay, in transit only, as it already is at the Cloudflare Tunnel (D77).
- **The sandbox is on unless an adapter says otherwise (D73).** Exceptions are declared
  capabilities, each on the approval card. Unsandboxed is possible, critical, and approvable only
  at the Mac, because it gives tool code everything Valet can reach.
- **Until the sandbox ships, any adapter not built into the app counts as unsandboxed**, and no
  draft code runs before it's approved.

## What's new to defend

The security model's two guarantees stay the target:

1. Adapter code never obtains a secret's value.
2. Adapter code can't cause a secret, or a session a secret produced, to reach anything outside
   the hosts its manifest declares.

Agent-run Valet adds four:

3. **Nothing widens without the person.** No sequence of MCP calls, by any client, raises what an
   adapter, a tool or a client can reach without a user-presence gesture on a paired device.
4. **The person approves what they saw.** A signed approval covers the exact request text the
   device rendered; nothing between the Mac and the device can change it.
5. **The relay is a pipe.** It can't approve, can't read or forge Mac-to-phone messages, holds no
   tokens, grants or approvals, and stores no call data.
6. **A lost phone is recoverable.** A phone alone can't approve without its owner's face or
   passcode, can't add another device, and can be revoked from the Mac or another device.

Out of scope, as before: malware running as the person (it can drive the Mac's UI and its
Touch ID prompts), the sites themselves, and a jailbroken phone. The person's model provider sees
whatever the agent sees.

## Threat model

| Attacker                                               | Wants                                                 | What stops or limits them                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------ | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Text on a page in the scratch browser                  | Steer the agent into installing or widening something | The agent can only ask. Every widening is an approval the person sees with the Mac's own diff. Page text reaches the agent marked as data. Worst case is a bad draft submitted for approval, or approval spam (rate-limited, below).                                                                      |
| A hostile reference adapter the agent reads and copies | Get its code installed under the person's approval    | No direct install (D75). The card shows the permission diff, computed by the Mac, and lists what the agent says it copied from, labelled as a claim. Code is bounded by the manifest: it can only reach declared hosts and granted secrets, and egress additions are high risk on the card.               |
| The agent itself, misled or misaligned                 | Approve its own request                               | No MCP tool answers approvals (`NEVER_OVER_MCP`). An approval is a Secure Enclave signature behind Face ID or Touch ID. The tier comes from the Mac's table, not the agent. An agent can't choose the card's headline.                                                                                    |
| The agent, laundering                                  | Hide a widening inside an innocuous change            | The diff is semantic and computed from the manifests by the Mac (`PermissionChange`), not the agent's summary. Splitting a change across several small updates still shows each widening on its own card. A tool whose `sideEffect` goes up is a diff line.                                               |
| The agent, through a signed-in session                 | Act on the person's account while "authoring" (D81)   | Off by default; approved per session (`authoring-session`), at most 60 minutes, limited to listed origins, every action audited. Scratch browsing is anonymous and never shares a tool partition.                                                                                                         |
| Approval fatigue                                       | Get a yes by asking often                             | At most 3 pending requests per client and 10 in all; after 3 declines from one client in an hour its requests are refused for an hour and the person is told. Critical cards are never batched. Requests expire.                                                                                          |
| A hostile relay, or its operator                       | Approve, forge alerts, read approvals, drive tools    | Can't approve: it has no device key. Can't read or alter the phone channel: HPKE auth mode between keys exchanged by QR. Can read MCP traffic in transit and replay OAuth tokens it saw, so can call remote-enabled tools within the Mac's caps until revoked; every such call is in the Mac's audit log. |
| The relay replaying an old approval                    | Approve a new request with an old signature           | A signature covers the request's digest, its random id and the Mac's id. The Mac accepts it only for a request it holds as pending, once. Expired requests can't be approved.                                                                                                                             |
| A stolen or lost phone                                 | Approve things                                        | Every approval needs Face ID or the passcode. A phone can't pair a device or approve unsandboxed code. Revoke from the Mac or another device; lockdown from either. Approvals the phone made stay valid, and revoking it lists them for review.                                                           |
| Someone who photographs the pairing QR                 | Pair their own phone                                  | The QR lives 5 minutes, works once, and pairing still needs Touch ID at the Mac after both screens show the same six digits.                                                                                                                                                                              |
| A local process writing Valet's files                  | Add an approval or bring back a revoked grant         | Records without valid signed evidence are ignored. A file whose hash doesn't match its Keychain anchor fails closed. (Full protection needs a signed build: a dev build's Keychain items are reachable by any process run as the person.)                                                                 |
| A remote MCP client                                    | Reach the admin tools                                 | The `valet_` tools are local-only until the person turns each on remotely, which is itself an approval. Remote-enabled admin tools keep the same tiers.                                                                                                                                                   |
| Push notifications                                     | Leak content to Apple or onto a lock screen           | APNs payloads are fixed text ("Valet needs you") with no content. The phone fetches the sealed request from the relay after it wakes.                                                                                                                                                                     |
| An adapter with sandbox exceptions                     | Read more than it declared                            | Exceptions are capabilities the main process enforces after resolving symlinks, against paths no approval can grant (`FORBIDDEN_PATHS`: Valet's data, Keychains, Messages, credential stores, the system).                                                                                                |

## Approval tiers

Final for D74, as `ADMIN_ACTION_TIERS` and `KIND_TIER` in core (**Contract**).

| Tier             | What happens                                                   | Actions                                                                                                                                                                                                                                                    |
| ---------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| None             | Done at once and audited                                       | Every read (status, adapters, tools, health, repairs, calls, redacted traces, audit, settings, devices). Scratch browsing. Editing, building and testing a draft (tests run sandboxed only, below). Deleting a draft.                                      |
| Notify           | Done at once, audited, and the person is told on Mac and phone | Creating a draft; a paced live trial of a read tool in the scratch partition; turning a tool off; removing an adapter; revoking a secret, a client or a device; a setting that only tightens; choosing an adapter setting (the store); pause and lockdown. |
| Approve          | Nothing happens until a device signs                           | Installing, updating or rolling back an adapter; a secret grant; turning a tool on, locally or remotely; a setting that loosens; a signed-in authoring session; resuming from pause or lockdown (at the Mac only); a remote client's consent.              |
| Approve each use | As Approve, never remembered                                   | An irreversible tool call (D46).                                                                                                                                                                                                                           |

Rules that go with it:

- **The Mac classifies, never the caller.** An admin tool names an action; the Mac decides whether
  a setting change tightens or loosens from its own table of settings, not from the agent's claim.
  An action not in the table is refused.
- **Never over MCP, at any tier:** pairing a device, answering an approval, reading a secret's
  value, resuming from pause or lockdown.
- **Where each kind may be approved:** everywhere except pairing a device, installing
  unsandboxed code and resuming, which need the person at the Mac (`approvableOn`). The first two
  defeat every other guarantee if a stolen phone could do them; lockdown is what the person
  reaches for when the phone is lost, so the phone can't lift it.
- **Expiry:** an irreversible call keeps the confirmation's short life (2 minutes); a remote
  client's consent and a resume 10 minutes; an authoring session 30; the rest 24 hours, so an
  install can wait for the person to be back (`APPROVAL_TTL_MS`).
- **Batching:** the phone may show several `approve` cards as one list, but each is signed on its
  own. Critical cards (unsandboxed code, a `command` exception, a new egress host on an adapter with
  a secret grant) are never in a list.
- **Fatigue limits** as in the threat model (`APPROVAL_LIMITS`). Declines need no signature, so declining is always one
  tap and never needs Face ID.

### What a card shows

Every card is rendered from the request's fields by a fixed template on each device. A
request carries:

- **Kind and subject:** structured fields only (`approvalRequestSchema`). Text fields refuse
  control, format and line-separator characters, invisible letters and piles of combining marks
  (`isDisplayText`), rather than cleaning them, because the Mac fills them in and must have
  cleaned them already. Ids (clients, calls, tools, addresses) have strict patterns.
- **Which fields someone else wrote.** The card's headline and every label are the app's own
  wording. Some values come from the adapter's manifest, which the agent wrote: the adapter's
  name, each exception's `purpose`, the unsandboxed `reason`, and setting labels and values. The
  card shows those under "The adapter says", never as a headline. A remote client's host and
  source address, and a phone's name, are claims too, and are shown as claims.
- **Requester:** the client the credential names (`local:<id>` or `remote:<id>`), with its
  self-reported name as a label.
- **The agent says:** at most 280 characters, shown as a quote under its own heading.
- **For an install:** the Mac's permission diff (`PermissionChange[]`, each with a risk), the
  source (draft, local folder or rollback), whether it replaces an adapter and inherits its
  signed-in session (`inheritsSession`), the references the agent says it read, and whether it
  runs unsandboxed. The Mac sets `unsandboxed` from the new manifest (and, before the sandbox ships, for
  every adapter not built in), and the schema refuses a critical `sandbox-mode` line without it. Any critical line (unsandboxed, a `command` exception) makes the whole card Mac only.
- The system's own Face ID or Touch ID prompt names the action in the app's words, so the last
  thing the person sees before signing is drawn by the OS.

A device must render from exactly the text it hashes. It parses the request text it received,
checks the schema (unknown fields are refused), and signs over that text's digest. It never
re-serialises. That's what makes guarantee 4 hold even against a relay that tampers.

## Devices and keys

Each device holds three P-256 keys (`DeviceRecord`). P-256 is the only curve the Secure Enclave
holds on both Mac and iPhone.

| Key       | Where                                          | Signs or does                                                         |
| --------- | ---------------------------------------------- | --------------------------------------------------------------------- |
| Approval  | Secure Enclave, `.userPresence` access control | Approval decisions; on the Mac also device records. Nothing else.     |
| Transport | Secure Enclave, no user presence               | The relay's connection challenge, so the device reconnects unattended |
| Agreement | Secure Enclave key agreement (or Keychain)     | The end-to-end channel (HPKE)                                         |

- A device's id is the first 128 bits of the SHA-256 of its approval key (`keyId`). The Mac's id
  (`macId`) is its own device id.
- The Mac's own record is self-signed; every phone's record is signed by the Mac's approval key,
  so making one needs Touch ID at the Mac.
- On the Mac, the keys live in the Swift helper (`swift-bridge`), which signs on request and shows
  the Touch ID prompt itself. Electron never holds a private key.
- A Secure Enclave key's stored blob is usable only on its own device. Another process on the same
  Mac could use the blob too, but each use of the approval key still asks for Touch ID, and that
  is the malware case, out of scope.
- **Signing format:** every signature is over `<domain>\n<payload>` with a domain per kind of
  thing (`SIGNING_DOMAINS`), so a signature over one thing never passes as another. Signatures are
  raw r||s (CryptoKit's `rawRepresentation`), keys SPKI DER (`derRepresentation`), both base64url.
  Whoever signs sends the exact payload text; the verifier checks the signature, then parses.
  Nothing re-serialises JSON to check a signature, so Swift and TypeScript never need to agree on
  a canonical form.

### Pairing

1. At the Mac, the person opens Pair a phone. The Mac shows a QR code (`PairingOffer`): its id,
   its approval and agreement keys, the relay's origin, a 32-byte one-time secret, and an expiry
   5 minutes out. The QR is shown only while that screen is open and is spent by the first reply.
2. The phone makes its three keys and sends the Mac, through the relay, its name and public keys,
   sealed with a key derived from the one-time secret (HKDF-SHA256 with the Mac's id as salt,
   AES-256-GCM). The relay never sees the QR, so it can neither read nor replace the reply.
3. Both screens show six digits derived from the transcript (both sets of keys and the secret).
   The person checks they match and approves on the Mac with Touch ID (`device-pair`, Mac only).
4. The Mac signs the phone's record, registers the phone's transport key with the relay
   (`device-register`) and sends the signed record back over the new channel. The phone pins the
   Mac's approval and agreement keys from the QR. It checks device records against the approval
   key. Requests aren't signed, because that would need Touch ID for every one; they're
   authenticated by the HPKE auth-mode seal from the pinned agreement key.
5. Three wrong confirmations, or the 5 minutes passing, abandon the offer; a new QR is needed.

At most 5 phones per Mac.

## Approvals

**Contract** in `approvals.ts`; built by D.

1. The Mac builds the request, including `tier` from `KIND_TIER`, a random 128-bit `id`, and
   `expiresAt`. `serializeRequest` checks it against the schema and produces its text and digest.
   The Mac stores the text as the pending request and audits `approval-requested` with the digest.
2. The Mac shows it in its own window and sends it, sealed, to each paired phone that may approve
   it, then pushes a content-free wake-up.
3. On a device, the person reads the card and approves with Face ID or Touch ID. The approval key
   signs `ApprovalDecision`: the Mac's id, the request's id and digest, the device's id, the time.
4. The Mac checks with `verifyDecision` in `live` mode, in this order: the payload names a known
   device of this Mac; that device's approval key signed it; the payload's shape; the Mac id; the
   request id and digest; the kind may be approved on that device's role; the device isn't revoked;
   the request is still pending; it hasn't expired. Then it removes the request from pending (so a
   second copy of the same signature fails as `not-pending`) and acts.
5. Every refusal is audited (`approval-answered` with `answer: 'refused'` and the reason), so a
   forged or replayed approval leaves a record.

A decline needs no signature: the Mac's own window, or an authenticated envelope from a paired
device, can decline. The worst a forged decline can do is say no.

Pending requests survive a restart of the app (they're stored with the approvals store), so a
phone can approve an install while the Mac is asleep and the Mac acts when it wakes. That's still
single use: answering removes it.

## Trusted stores

**Contract** in `trusted-store.ts`; built by D. Applies to the approvals, grants, remote-tool
policy, device, settings and safety-state (pause and lockdown) stores, and to the pending
requests. Not to the adapter store (C), whose versions are self-verifying by hash
and whose `state.json` decides nothing: what runs is what the approvals store approved.

- **Evidence.** Every record that widens anything carries `Evidence`: the request text, the
  device's signed decision, and the Mac's own receipt (`receivedAt`, the Mac's clock when it
  accepted the decision live). On every load, `verifyEvidence` checks it in `stored` mode: the
  receipt is within the request's life and before any revocation of that device, and the
  request's subject is exactly this record (`matches`). The signer's own `decidedAt` is never
  trusted for timing, so a device can't backdate a decision past its revocation, and a phone with
  a wrong clock can't make an approval that passes live and fails later. Irreversible calls and
  pairings are never stored evidence. A record whose evidence fails is
  ignored and audited (`store-refused`). Records that only tighten (a revocation, a tool turned
  off) need no evidence.
- **Anchor.** Each store's SHA-256 and a generation number live in a Keychain item under the app's
  designated requirement (`StoreAnchor`). A write is two-phase: write the next hash into the
  anchor (`beginWrite`), write and sync the file, then move the anchor (`commitWrite`). On load,
  `checkAnchor` says `ok`, `advance` (a crash between the two phases), `fresh`, or `mismatch`. On a
  mismatch, Valet goes into lockdown, treats that store as empty (so everything it would have
  allowed is off), tells the person, and audits it. Lockdown rather than "empty" alone because
  some stores also hold tightening records without evidence (a tool turned off); emptying those
  would loosen. A write may not begin while another is uncommitted (`beginWrite` throws). A load
  that finds the old file with a write begun (`interrupted`) can't tell a crash from the new
  file being swapped back, and the lost write may have been a revocation, so it also locks down
  and asks the person to repeat the change before `abandonWrite`, and a failed commit is fatal for that change: the
  person is told a revocation is done only after its commit. That stops a
  rolled-back file from bringing a revoked grant back, which evidence alone can't, because the old
  grant's evidence is still valid.
- **Migration.** Today's `approvals.json` and `grants.json` have no evidence. On the first launch
  of the version that enforces this, the Mac shows the existing approvals and grants as one list
  and asks for Touch ID once; the Mac's approval key then signs evidence for each. Until the person
  does, the old records keep working, so the Woolworths login isn't interrupted (and the app says
  migration is waiting).
- **Lockdown on tamper is a denial of service by design.** A local process that corrupts one byte
  of a store forces lockdown. That's the safe direction, and a process running as the person could
  stop Valet anyway.
- **Dev builds.** An unsigned build's Keychain items are reachable by any process running as the
  person, so the anchor is only as strong as the evidence there. A signed release build closes it.

## Agents as authors

How workstreams E and F stay inside guarantee 3. **Designed**.

- **Scratch browser:** an anonymous, in-memory partition per draft, never one of the tool or auth
  partitions, so no session or cookie of the person's is ever in it. It types only text the agent
  supplies, which never includes a secret, because the agent never has one. Page text goes back
  to the agent marked as data, with input values stripped from DOM snapshots.
- **Network log:** scrubbed of cookies, `Authorization`, `Set-Cookie` and bodies over a size cap.
  There's nothing of the person's in the scratch partition to leak, but sites set tracking ids.
- **No draft code runs before the sandbox (workstream I).** Building and linting a draft are data
  checks. Running its tests, describing its schemas, or a live trial executes adapter code. Before
  the sandbox exists, the only place that runs is a full Node process with Valet's own access, so
  F's test and trial tools, and C's describe step for the `draft` source, stay off until I lands.
  C has a guard for this. Once they run, draft code runs with none of its declared exceptions and
  with egress limited to the scratch partition's, whatever its manifest asks for: nobody has
  approved those yet.
- **Submitting** a draft is an `adapter-install` approval with the Mac's diff against the
  installed version (or against nothing). A draft that takes an existing adapter's id replaces it,
  and inherits its signed-in session, because partitions are named by adapter id. That's what
  repair (J5) needs, so the diff says it in a high-risk line: "This code will use your signed-in
  session for <site>". Removing an adapter clears its partitions, so a later draft under the same
  id can't quietly inherit a session the diff (against nothing) wouldn't mention. Whether that
  line appears is decided from whether the partition holds a session, not from the version
  history.
- **Remote enablement is per version.** `tool-enable` names the adapter hash, so an update starts
  with its tools off for remote clients again.
- **References** (D75): the agent fetches others' adapters as text and may copy from them. Valet
  never installs one directly. The card lists what the agent says it consulted, as a claim.
- **Signed-in authoring sessions** (D81): off by default; `authoring-session` approval per session,
  at most 60 minutes, listed origins only, ended by the person at any time, every action audited.
  During one, the agent drives the tool partition through the same capability API adapter code
  uses, so it still never sees a secret, and egress is still the adapter's manifest.
- **Repair** (J5): the repair ticket the agent reads through E is the runtime's structured
  failure (stage, class, the failing request's path), never page text a hostile site wrote.

## Sandbox exceptions

**Contract** in `sandbox.ts` (the manifest's optional `sandbox` field); enforced by workstream I.

- **The default is sandboxed with no exceptions.** A manifest without the field means that. The
  field is optional with no default, so existing manifests hash exactly as before.
- **An exception is a capability, not a hole.** The runtime injects one more host function
  (a file reader limited to these paths, an Apple Events sender for this bundle id). The main
  process enforces it. Kinds: `files` (read or read-write, by path pattern), `app` (Apple Events to
  one bundle id), `local-service` (127.0.0.1 on one port above 1023), `network` (HTTPS from tool
  code to named hosts, outside the browser), `command` (one program by absolute path).
- **Paths** are absolute or under `~/`, with no `.` or `..` and at most one trailing `*` or `**`
  (`isPathPattern`). `~/*` and `/**` are refused. The person's home is named as `~/`: an absolute
  path under `/Users` or a volume's `Users` folder is refused, as are `/Volumes` itself and a whole
  volume. At run time, the runtime resolves each path with `realpath`, checks it with
  `touchesForbiddenPath(path, home)` (which maps `<home>/x` back to `~/x`), and re-checks an opened
  file by its real path, so a symlink placed later can't escape.
- **Never grantable** (`FORBIDDEN_PATHS`, matched after NFKC and case folding, by ancestor too):
  Valet's own data (every product name), Keychains, Messages (one-time codes come only through the
  provider), 1Password's data, every browser's cookies and profiles, Mail, LaunchAgents and
  Preferences, `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.config`, shell startup files, `~/.local/bin`,
  and the system folders.
- **Writing is allow-listed.** A deny list can't name every file that runs code (shell and editor
  configs, an MCP client's config), so `read-write` paths must be under `~/Documents`,
  `~/Downloads`, `~/Desktop`, `~/Pictures`, `~/Movies`, `~/Music` or another disk
  (`WRITABLE_ROOTS`).
- **Apple Events are allow-listed** (`ALLOWED_APPS`): Calendar, Reminders, Notes, Contacts, Music,
  Photos and Numbers, which hold the person's data and can't run code or send anything. Browsers,
  Mail, Messages, terminals and editors are egress or code execution under another name.
- **Commands** are critical and Mac only whatever they name. Shells, interpreters and script
  runners are refused outright, as is any program in a folder the person can write to (`/Users`,
  `/Volumes`, `/tmp`, Homebrew), since anything running as them could swap it. The runtime checks
  the program's real path again before each run.
- **Risk** (`exceptionRisk`): reading files is medium; writing, or a `**` pattern, is high; Apple
  Events and network are high; a local service is medium; a command is critical.
- **The diff** lists each new exception (`sandboxWidening`). Any change to one counts as new.
- **Unsandboxed** (`mode: 'unsandboxed'` with the author's reason): tool code runs as today's v0,
  in a full Node process with Valet's access. That breaks guarantees 1 and 2 for every adapter,
  not just this one, because it could read any keychain-copy secret Valet holds. The card says so
  in those words, it's critical, and it's approvable only at the Mac.
- **Before workstream I ships,** every adapter that isn't built into the app is treated as
  unsandboxed on its card, whatever its manifest says.

## The relay protocol

**Contract** in `relay-protocol.ts`; built by G.

```
remote MCP client ─HTTPS─▶ relay Worker ─▶ Durable Object per Mac ◀─WSS (out)─ Mac
                                                   ▲
                                                   └──────────WSS (out)─────── phone
```

- **Connections.** The Mac and each phone dial out. The relay's first frame is a challenge with a
  random nonce and its own origin; the device answers with its transport key's signature over
  them (`relayHelloSchema`). A Mac registers its transport key on first connection; a phone may
  connect only after its Mac registered it (`device-register`). No bearer secret is ever sent.
- **Forwarded HTTP.** Only `/mcp`, the OAuth endpoints and the well-known metadata
  (`RELAY_FORWARDED_PATHS`), with a fixed set of request and response headers. Bodies are capped
  at 1 MiB, as at the local endpoint; at most 16 concurrent requests and 50 frames a second per
  Mac. `/authorize` is a fixed relay template filled from the Mac's structured `consent-view`; the
  relay never forwards HTML from a Mac. The Mac's own OAuth server decides everything (D80); the
  relay keeps no tokens.
- **The phone channel.** `envelope` frames carry HPKE (RFC 9180) auth-mode ciphertext between the
  sender's and recipient's agreement keys, suite DHKEM(P-256, HKDF-SHA256), HKDF-SHA256,
  AES-256-GCM, with `info` set to the sender and recipient ids. Auth mode means a phone accepts
  only what the Mac's key sealed, and the reverse. Inside, a per-sender sequence number, accepted only in order (`seqVerdict`), stops the
  relay replaying, reordering or silently dropping messages. Approvals inside are signed as well, so a broken seal
  still can't approve. What goes inside is one schema per direction: `macToPhoneMessageSchema` (request text,
  closings, alerts) and `phoneToMacMessageSchema` (signed decisions, declines, the tightening
  commands below). The Mac parses a phone's messages only with `parsePhoneToMac`. Each side acknowledges what it received (`ack`), so a phone shows a command as
  "not confirmed" until the Mac's ack arrives, and a relay that drops one can't hide it. H and D
  may add kinds; each is a contract change.
- **Phone commands without Face ID.** A phone can send tightening commands, which are pause, lockdown, revoke a client and
  revoke a device, over the authenticated channel without a signature. Speed matters for J7, and
  the worst a stolen unlocked phone can do with them is lock things down. Undoing any of them is
  `resume`, which needs an approval.
- **Pushes** carry fixed text only (`pushPayloadSchema`).
- **What the relay keeps** (`RelayStoredState`): the Mac's id and transport key, each phone's id,
  transport key and APNs token, and a creation time. Nothing about calls, tools, results or
  approvals. Logs for payload-bearing routes are off, and error paths log a stage and class only.
- **Mac offline:** the relay answers a remote call at once with a tool error and queues nothing.
  Envelopes for an offline Mac are refused, not queued, except that the phone retries.

What the relay can see, for the record (D77): MCP requests and results, OAuth tokens in transit,
timing and sizes, which devices belong to which Mac, and APNs tokens. It can't see secrets, the
phone channel's contents, or approvals.

## Lockdown and revocation

- **Lockdown** (J7) from the Mac or a phone: every call is refused, every remote client revoked,
  every pending request withdrawn, and authoring sessions end. Undoing it is a `resume` approval.
- **The Mac can't be revoked**, from any channel or tool (`canRevokeDevice`, enforced by
  `deviceRevocationSchema` and `parsePhoneToMac`). Otherwise an
  unlocked phone, or an agent at notify tier, could revoke the Mac and leave the stolen phone as
  the only approver.
- **Revoking a device** removes its record from use at once: its future signatures fail as
  `device-revoked`, the relay drops its registration, and the device store keeps the revocation
  forever. The approvals it signed while paired stay valid, because a stolen phone's earlier
  approvals were the owner's. The Mac lists everything that device approved, with one button to
  withdraw them all.
- **Revoking an agent** (a client) withdraws its pending requests and ends its sessions.

## Package hash and storage (for C)

Reviewed on 2026-11-12 ([the review](findings/2026-11-12-review-of-adapter-packages.md)). C's formula is kept: the adapter hash covers `src/**` and the
canonical parsed manifest; tests, fixtures and the README are not covered, and the compiler and
library prelude are app code. The rules B asked for:

1. No `draft` code runs (describe, tests, trials) before the sandbox; a guard in install.
2. An adapter has at most one approved hash, so the approvals store, not `state.json`, decides what
   runs. A test pins it.
3. Rollback shows the permission diff against the active version, and revoked grants stay revoked.
4. An install that replaces an adapter with a session or grants says so in the diff.
5. Each stored version records the app version, the prelude's hash and the esbuild version.
6. Schemas from describe: a node-count cap and a keyword allowlist.

## What this needs from other streams

- **A:** the card template follows "What a card shows"; the agent's words never as the headline;
  pairing shows six digits on both screens; decline is one tap.
- **C:** the six rules above; the permission diff produces `PermissionChange` lines, including
  `sandbox-mode` and `sandbox-exception`.
- **D:** the broker builds requests with `serializeRequest`, checks with `verifyDecision`, stores
  with evidence and anchors, enforces fatigue limits, and migrates today's stores.
- **E:** every admin tool names an action in `ADMIN_ACTION_TIERS`; nothing outside it.
- **F:** the scratch browser, network log and repair-ticket rules above; tests and trials wait for
  I.
- **G:** the frames in `relay-protocol.ts` and the storage limit; no payload logging.
- **H:** keys as in the table; render from the exact text, never re-serialise; Face ID prompt
  text in the app's words; pushes carry nothing.
- **I:** exceptions as capabilities; forbidden paths after `realpath`; the unsandboxed wording.

## Contract changes after the first merge

Asked for by D, G and H while building, 2026-11-12. Accepted unless marked otherwise.

**From H (iPhone):**

1. **The iPhone's approval key uses `.biometryCurrentSet`,** not `.userPresence`, so a thief who
   knows the passcode still can't approve. A Face ID enrolment change kills the key and the phone
   re-pairs. The Mac keeps `.userPresence`, since a Mac may have no Touch ID. A second,
   passcode-capable key for neutral cards waits for a separate decision.
2. **Pairing wire format** (`pairing.ts`):
   - The Mac opens an offer at the relay by id only (`pairing-open`). `pairingOfferId` is a hash
     of the secret.
   - The phone sends `pairing-reply` without a hello, sealed with AES-256-GCM under
     `pairingSealKey`.
   - The Mac answers with `pairing-result`, sealed the same way.
   - `pairingCode` gives the six digits: HKDF over the secret, salted with the Mac id, with the
     offer text, the reply and a fresh Mac nonce in the info. The Mac accepts only the first
     reply to an offer, then sends the nonce (`pairing-challenge`). Without it, someone who saw
     the QR and controls the relay could open the reply and grind substitutes until the digits
     matched (H's review).
   - The Mac signs the challenge with its approval key, which the QR pins, over the offer, the
     nonce and the hash of the reply it accepted (`pairingChallengePayload`, H's CR-11). The phone
     checks both. Otherwise that same attacker could answer first with its own reply, then grind
     a nonce for the phone until both screens showed the same digits.
   - The reply travels on the phone's ordinary relay socket, as the one frame allowed before a
     hello, for an offer the Mac opened. That's G's rendezvous, without a second endpoint.
   - Six digits (20 bits) is enough because the QR is single use, the reply is sealed, and three
     wrong confirmations end the offer. A's four words would also do if the card spec wants them.
3. **`status`**, Mac to phone, for the phone's tabs, and **`unpaired`**: a sealed notice that
   tells a revoked phone to delete its keys, since the relay refuses its hello without saying why.
   - **Sequence numbers:** accept only the next one, re-ack a duplicate without acting, and hold a
     gap (`seqVerdict`). The first design's "drop anything not above the last" let a relay hold
     back a lockdown and make every resend look old.
   - **HPKE `info`** is pinned as `envelopeInfo`: the sender's then the recipient's key id bytes.
4. **`display`** on requests: the Mac's own words for the card ("Because", client badge, the
   registrable domain, follow-ons, checks), plus `fromAdapter` (site name and tool titles), which
   cards show as the adapter's words. It's inside the request text, so the signature covers it.
5. **A note on declines,** and D's `stopAsking`.
6. **`approval-closed` with `refused`**, the reason and the device that answered.
7. **`choice`** on a signed decision, checked against the setting's offered `choices` (the store,
   J8b).
8. A sealed notification title is for later, with a Notification Service Extension; no contract
   yet.
9. **`ask`**, phone to Mac, limited to `PHONE_ASKS`. The Mac builds the request itself, as it
   does for an agent. Pairing and resume are never asked from a phone. H not offering Unlock on
   the phone is fine: `approvableOn` allows it, but the UI needn't.
10. **J6:**
    - `handoff` tells the phone a login needs it.
    - `login-code` carries a one-time code the person typed on the phone. The Mac treats it as a
      secret: used only for that hand-off's OTP step, never logged, and audited as a secret use.

**From D (broker):**

1. **`context`** on requests: repair, draft, follows, replaces.
   - A follow-on is its own request and signed on its own.
   - One Face ID (one `LAContext`) may sign several requests only when the phone showed them
     together as one list, and never a critical one.
2. **Decline note and "stop asking"**, as H's 5.
3. **Limits** follow A's card spec: 5 pending across agents, 3 per agent, 20 requests per agent
   per day.
4. **One anchored ledger** (`trusted.json`) for pending requests, evidence, devices, revocations
   and safety state, instead of evidence beside each store.
   - Accepted. It has one anchor and no crash window across files.
   - One rule with it: any tightening record that supersedes evidence must be in the ledger too.
     That covers a tool turned off after it was enabled, and a grant revoked. Otherwise an edit to
     an unanchored store would bring the old evidence back into force.
5. **Face ID only on the phone:** already so since H's 1 (`.biometryCurrentSet`); there is no
   passcode-capable key to tell apart. If Nick takes A's passcode fallback for neutral cards, the
   phone gets a second, `.userPresence` key in its device record, and the Mac picks from its own
   request which key a decision must be signed with.
6. **Resume at the Mac only:** `approvableOn('resume')` is `['mac']`, and `valet.resume` left
   `ADMIN_ACTION_TIERS` for `NEVER_OVER_MCP`.
7. **Consent code typed, not compared:** the remote-client request carries no code; the phone
   puts the typed code in the signed decision (`typedCode`, letters only, `consentCodeSchema`) and
   the Mac refuses a mismatch (`wrong-code`, given the issued code through `consentCode`).
   Consents have their own bucket (`consentPending`, `consentPerSourcePerHour`) outside
   `pendingTotal`.
8. **`confirmationId` on an irreversible call** (`cf_…`), so two `ctx.confirm` questions in one
   call are two requests.
9. **Loosening paths outside `ADMIN_ACTION_TIERS`** (approval-broker.md, "Every loosening
   path"), agreed: lifting Valet's in-memory Pause and a site's breaker pause are clicks;
   `grants.resync` keeps the same item, origins and fields, so it doesn't widen; Messages OTP,
   remote on and remote hosts become `setting` requests. One condition: adding a local client is
   unsigned but notifies on the Mac and phone like any Notify action, so a client that appears
   without the person is seen.

**From A (screens), signing off section 10 of the information architecture:**

- `relay.md` now has consent on the Mac or a paired phone, the letters-only typed code, the
  redirect host in full, and a ten-minute consent life to match `APPROVAL_TTL_MS`.
- The approval gesture fallback lives in `authoring-agent.md`, not `security-model.md`: on a Mac
  without Touch ID it is now the Mac account password through the system prompt
  (`.userPresence`), not typing characters of the hash.
- Phone notifications follow the Mac's rules, and the relay-visible push text is fixed
  (`security-model.md`, Notifications).

**From G (relay):**

1. **`relayAuthPayload`**: the hello signs `JSON.stringify` of `{nonce, relay, role, id}` in
   that order.
2. **Consent polling.** The waiting page polls through `consent-open` with the same id and an
   empty query. The Mac treats a known id as a poll and an unknown one as expired.
3. **No `Origin` header.** The relay refuses forwarded requests that carry one (except GET
   `/authorize`), and `/mcp` POST bodies must be JSON-RPC.
4. **Relay-side lock and recovery code.**
   - A phone can ask the relay to stop forwarding remote traffic to its Mac (`relay-lock`). Only
     the Mac lifts it (`relay-unlock`).
   - A 128-bit recovery code, shown once, whose hash the Mac registers. The code's page can only
     lock and unregister phones.
5. **More consent states:** `closed` ("not accepting new agents"), and `busy` and `too-many`
   for load.
6. **No trust on first use.** A Mac's first hello carries `binding`: its approval key, whose key
   id is the Mac id, signing the transport key once with Touch ID (`verifyRelayBinding`). A relay
   that lost its storage can't be claimed by someone who only knows the Mac id. The same binding
   lets a Mac rotate its transport key. With it, the relay may delete Macs unseen for a long
   time (`lastSeenAt`), since re-registering needs the binding.
7. `/revoke` is no longer forwarded: the Mac's OAuth server has no RFC 7009 endpoint.
8. The envelope's byte cap applies to the whole frame.
9. A phone's lockdown sent while the Mac is offline is lost, but the relay-side lock (4) holds
   at the relay, so a stolen token's calls can't land first when the Mac reconnects.
10. G's own choices, no contract change:
    - Consent polls carry an HMAC'd wait token bound to the original `redirect_uri`, and the
      relay redirects only there.
    - Forwarded responses are limited to `application/json` and `text/event-stream`, with a CSP
      sandbox.

11. After the relay was built (PR #79):
    - `RelayStoredState.lockedBy`, so `relay-locked` on reconnect names who locked it.
    - `normaliseRecoveryCode` and `recoveryCodeHash` pin the recovery code: upper-cased,
      spaces and dashes removed, 16 to 64 of A-Z and 0-9, then SHA-256 hex. A fixed vector is in
      the core tests for the relay's own.
    - `consent-view` carries an optional `expiresAt` for the page's "Ends at".
    - The relay checks the binding with WebCrypto, since workerd lacks parts of `node:crypto`; its
      test checks it agrees with `verifyRelayBinding`.

## Accounts, when the service has them (D79)

Nick's answer (2026-11-12): an ordinary account login with 2FA, with a QR code as a sign-in
shortcut, and no separate device-approval step on top. Until the service has accounts, pairing
stays exactly as above, so nothing in the contracts changes now.

What changes when accounts arrive:

- **Who can make a device that approves.** Today only the Mac can: it trusts only keys it accepted
  itself, so even a fully compromised relay can't approve anything. With accounts, the service
  decides which devices belong to the person. Its security then bounds approvals too: a breach of
  the service (every user's Mac at once), a "lost my 2FA" recovery, or a stolen SMS code would
  yield a device that can approve installs and checkouts. Nick accepted that trade.
- **What stays.** Approvals are still Secure Enclave signatures over the exact request, verified
  by the Mac (`verifyDecision`); the Mac-only kinds stay Mac only; lockdown and the relay lock
  stay. Only enrolment moves: the Mac would accept a device the account vouches for, through a
  signed statement from the service, in place of the QR pairing ceremony.
- **The QR login** is the signed-in device scanning a code the new one shows. It replaces typing
  the password and 2FA there, and is never needed in addition.

Proposed by A, **not confirmed by Nick**, because they recover most of what device approval gave:
2FA by passkey or authenticator app, never SMS; "new device signed in" alerts on the person's
other devices and the Mac; and a 24-hour cooling-off before a newly signed-in device can approve,
unless a device they already have says yes, restarted by any recovery that resets 2FA.

## Open questions

- **D78 (web audit):** a browser as another paired device would fit this design (its own keys,
  WebAuthn instead of the Secure Enclave), but it isn't designed here.
- **Mac without Touch ID** (a Mac mini, or a closed laptop): `.userPresence` falls back to the
  login password, which is fine, but the person may then prefer approving on the phone.
- **D76:** if the tunnel stays as a self-host option, the phone channel needs the relay anyway, so
  "tunnel only" would mean no phone.
