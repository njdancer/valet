# The relay Worker (workstream G)

Status: built, and tested in CI against a local Workers runtime (Miniflare). Not deployed:
deploying needs Nick's Cloudflare account and a host name ([What needs Nick](#what-needs-nick)).
Not yet wired into the app: that waits for the device keys in the Swift helper.

This is the design of the relay that [plan-agent-run.md](plan-agent-run.md#g-cloud-relay-on-cloudflare-workers)
asks for. The protocol and threat model are B's, in
[agent-run-security.md](agent-run-security.md#the-relay-protocol) and
`packages/core/src/relay-protocol.ts` (contracts v2). This document says how the Worker and the
Mac's side carry them out, and what they add. The background and the options considered are in
[relay.md](relay.md).

## Brief

- **Journeys served** (`docs/ux/agent-run/journeys.md`):
  - J1, pairing a phone: the relay carries the sealed pairing messages.
  - J2, connecting a remote agent: OAuth through the relay, with consent at the Mac.
  - J4, approving on the phone: sealed envelopes and pushes.
  - J7, locking down from the phone or with the recovery code.
  - J8, agents calling tools from anywhere.
- **Must not break:** the Mac decides everything.
  - The relay holds no tokens, grants or approvals.
  - It can't read or forge the phone channel or pairing.
  - It stores only `RelayStoredState`.
- **Must not change:** the frames in `relay-protocol.ts`. H builds against them now.

## Shape

```
remote MCP client ─HTTPS─▶ Worker ──▶ Durable Object "MacRelay" (one per macId) ◀─WSS─ Mac (relay client)
 https://<macId>.<RELAY_HOST>/mcp               ▲                                       │ loopback HTTP
                                                └──────────────WSS───────── phone       ▼
                                                                              remote listener (OAuth + MCP)
```

- **`apps/relay`** holds four pieces:
  - the Worker (`src/index.ts`);
  - the front door (`src/front.ts`): routing, limits and checks, before any Durable Object is
    involved;
  - the Durable Object (`src/mac-relay.ts`), whose logic is in `src/core.ts` and has no Workers
    imports, so it is unit-tested with fake sockets;
  - a second, single Durable Object (`src/push-relay.ts`) that holds the APNs token.
- **`packages/mcp-server/src/relay-client.ts`** is the Mac's side.
  - It dials out and answers the challenge with the transport key.
  - It turns each `http-request` frame into a loopback request to the existing remote listener
    (`startRemoteListener`), exactly as cloudflared did.
  - There is no second MCP or OAuth code path: the relay client is a byte pipe (D41).

### Host names

Each Mac has its own host, `<macId>.<RELAY_HOST>`.

- The Mac's OAuth server already derives its issuer and resource from the host
  (`https://<host>/mcp`).
- OAuth metadata discovery is at the host's root, which is why `RELAY_FORWARDED_PATHS` are root
  paths.
- A path prefix per Mac would mean changing the Mac's OAuth server and the well-known paths, for
  no gain.

Device connections go to any host that isn't a Mac's:

- `wss://<RELAY_HOST>/v1/mac/<macId>`
- `wss://<RELAY_HOST>/v1/phone/<macId>`

Any other host or path gets a plain 404.

**Recommended host:** a short dedicated domain.

- relay.md explains why: as a separate registrable domain, cookies and reputation can't cross onto
  anything else, and it can go on the Public Suffix List eventually.
- Its first-level wildcard `*.<domain>` is covered by Cloudflare's free Universal SSL.
- Under `dncr.me`, `*.relay.dncr.me` is a second-level wildcard. That needs Advanced Certificate
  Manager (about US$10 a month) or Total TLS.

This is Nick's call.

## Connections

1. **Routing.** The Worker checks that `macId` matches `KEY_ID`, then routes `/v1/mac/<macId>` and
   `/v1/phone/<macId>` to `MacRelay` named by `macId`. The Durable Object accepts the WebSocket
   with the hibernation API, so idle connections cost almost nothing, and answers `ping` with
   `pong` without waking.
2. **Challenge.** The relay's first frame is `challenge`, with a fresh 32-byte nonce and
   `RELAY_ORIGIN`.
3. **Hello.** The device answers `hello`. The relay verifies the signature with WebCrypto ECDSA
   P-256 over SHA-256 (raw r||s is WebCrypto's own format). The signature covers
   `valet/relay-auth/v1\n` + `relayAuthPayload({ nonce, relay, role, id })`: JSON in that key
   order, with no whitespace.
   - **A Mac** (`role: 'mac'`, with `id` equal to the path's `macId`).
     - Sending `transportKey` registers or rotates it. That needs `binding`: the Mac's approval
       key, whose key id is the Mac id, signing the transport key under `valet/relay-binding/v1`.
     - So knowing a Mac's id (it is in its public host name) is never enough to claim it, even if
       the relay lost its storage. There is no trust on first use.
     - Without `transportKey`, the stored key is used.
     - The relay checks the binding in WebCrypto (`src/verify.ts`), because core's
       `verifyRelayBinding` uses `node:crypto`, which workerd doesn't fully support. A test checks
       that the two agree.
   - **A phone** (`role: 'phone'`). Its `id` must be a device the Mac registered, and it is
     verified with that device's stored transport key.
4. **Refusals.** Each of these closes the socket and stores nothing:
   - a wrong role, id, signature or binding (4401, "refused");
   - an unregistered or revoked phone (4401, "refused", the same answer, so a stranger can't tell
     which phone ids exist);
   - no hello within `challengeTimeoutMs` (4408).
5. **Ready.** On success the Mac gets `ready { devices }` and a phone gets `ready { macOnline }`.
   - If the relay is locked, `relay-locked` follows at once.
   - A second connection for the same Mac or phone replaces the first, which closes with 4409. So
     a reconnecting device never locks itself out.
6. **Online changes** are told to the other side: phones get `mac-online`, and the Mac gets
   `device-online`.

Each socket's authenticated identity lives in its hibernation attachment and in memory, never in
storage.

**The Mac's `lastSeenAt`** is updated at most once a day. A Mac unseen for 180 days is forgotten:
its Durable Object deletes its state. That is safe because re-registering needs the binding.

## Forwarded HTTP

For a request on `<macId>.<RELAY_HOST>`:

1. **Path.** It must be one of `RELAY_FORWARDED_PATHS`, `RELAY_CONSENT_PATH` or `/recover`.
   Anything else gets 404 from the relay.
2. **Method.** GET, POST or DELETE (the contract's set). Anything else is 405.
3. **Origin.** A request that carries `Origin` is refused with 403, except a GET to `/authorize`.
   The relay drops every header outside `RELAY_FORWARDED_HEADERS`. Without this check, the Mac's
   own Origin guard, which refuses any request with an Origin, would be silently bypassed.
4. **Limits**, before anything reaches the Mac. These use Workers rate-limiting bindings, keyed
   per Mac and source address (`CF-Connecting-IP`). An IPv6 address counts by its /64.
   - 120 forwarded requests a minute.
   - 20 a minute on `/register`, `/token` and new `/authorize` sign-ins.
   - 40 consent-page polls a minute.

   Device connections are limited to 20 a minute per source. In the Durable Object, each Mac may
   have `maxConcurrentRequestsPerMac` (16) requests in flight, and 4 open event streams; past
   either limit the answer is 429. A limiter that errors counts as a refusal.
5. **Request size.**
   - The query is at most 2048 characters (414), and each forwarded header at most 8 KiB (431).
   - The body is at most `maxRequestBodyBytes` (1 MiB), read as UTF-8 text; above it the answer
     is 413.
   - A POST to `/mcp` must be one JSON-RPC message, or a batch of 1 to 100, or it is 400. The
     relay is not a general tunnel.
6. **Mac offline.** Answered at once, with nothing queued.
   - A `tools/call` gets a JSON-RPC result with `isError: true`: "The Mac running Valet isn't
     connected to its relay…"
   - Anything else gets 503 with `Retry-After: 30`.
7. **Locked** ([Lock and recovery](#lock-and-recovery)). Nothing is sent to the Mac.
   - A `tools/call` gets a tool error: "Valet isn't reachable: the person locked it down. Nothing
     was sent."
   - Anything else gets 503 `{ error: 'locked' }`.
8. **Forward.** The relay sends an `http-request` frame with:
   - a fresh id;
   - only the allowed headers;
   - the body;
   - `source` set to `CF-Connecting-IP`.
9. **The Mac's answer** streams back as `http-response-start`, then `-chunk`s, then `-end`.
   - Only `RELAY_RESPONSE_HEADERS` are kept.
   - The content type must be `application/json` or `text/event-stream`. Anything else, or a 1xx
     status, is 502 and `http-cancel`. A "Mac" is any program that speaks the protocol, and must
     not be able to serve pages or files from the relay's domain.
   - Every response gets `content-security-policy: sandbox; default-src 'none'; frame-ancestors
'none'`, `x-content-type-options: nosniff` and `referrer-policy: no-referrer`. It also gets
     `cache-control: no-store` unless the Mac set one.
10. **Caps.**
    - A response over 8 MiB is cut off with an error, and `http-cancel`.
    - An event stream lasts at most 10 minutes, then ends cleanly; MCP clients reconnect.
    - A response that hasn't started within 120 s gets 504, and `http-cancel`.
11. **Cancel.**
    - If the client goes away, the relay sends `http-cancel`.
    - If the Mac disconnects mid-response, the stream errors. Before the start frame, the client
      gets 502.
    - Nothing is retried, because a write might already have happened.

**Frames from the Mac** pass a token bucket: 50 a second (`maxFramesPerSecondPerMac`) with a
burst of 500. Past it, the relay closes the Mac's socket (4429), which fails its in-flight
requests.

- Every frame from a device is parsed with its direction's schema, and is at most 2 MiB.
  Anything else closes the socket (4400).
- A response frame for an id the relay doesn't know is ignored.

### On the Mac

The relay client sends each `http-request` to the remote listener on `127.0.0.1`.

- It sets `Host: <macId>.<RELAY_HOST>` and `CF-Connecting-IP: <source>`. So the listener's host
  check, per-source OAuth limits and audit see what they saw behind cloudflared.
- The listener's `hosts()` must include the relay host. The app adds it when relay mode is on.
- Responses stream back in chunks of at most 64K characters, coalesced over 20 ms. They are
  decoded as UTF-8 with a streaming decoder, so a multi-byte character is never split.
- The client pings every 30 s and reconnects with exponential backoff and jitter (1 s to 60 s).
- If the relay refuses its hello (4401), it waits the longest backoff before trying again. If it
  is replaced by a newer connection (4409), it stops.

## Consent (`/authorize`)

`/authorize` is the one page the relay renders. It is a fixed template, filled with the Mac's
structured `consent-view`, never with HTML from the Mac.

1. **Open.** A browser opens `/authorize?<OAuth query>`.
   - The query must name exactly one https `redirect_uri` (relay mode requires it) and be at most
     4 KiB.
   - The relay sends `consent-open { id, query, source }` with a fresh random id.
2. **Answer.** The Mac runs the same checks as its own `/authorize`, through
   `RemoteAuthorization.relayConsent`, which shares its code with the HTTP route. It answers with
   one of these:
   - `waiting` with `code`: a consent request is open on the Mac. The relay shows the code and
     "Type this code into Valet on your Mac or iPhone". The page refreshes every 3 s to
     `/authorize?wait=<token>`.
   - `approved` or `declined` with `redirect`: the relay answers 302 to the redirect, which
     carries `code` or `error`. It does so only if the redirect's origin and path equal the
     `redirect_uri` the browser asked with. Otherwise it shows "can't go on", so a Mac can't turn
     the relay's domain into an open redirect.
   - `declined` without `redirect`: "Valet can't go on with this sign-in" (an unknown client or a
     bad redirect URI).
   - `expired`: "This sign-in has ended."
   - `closed`: "This Valet isn't accepting new agents right now." (403)
   - `busy` or `too-many`: "Valet has too many sign-ins waiting." (429)
3. **The wait token.** It is base64url JSON `{ id, macId, redirect, exp }` with an HMAC-SHA256
   under `WAIT_SECRET`, and lasts 6 minutes.
   - A poll must carry nothing but the token.
   - The relay sends `consent-open` again with the token's id and an empty query.
   - The Mac treats a known id with an empty query as a poll of that request, and an unknown one
     as expired.
   - Polls count against the poll limit, not the sign-in limit.
4. **Mac offline:** "The Mac running Valet isn't connected", and nothing is sent. **Locked:**
   "This Valet is locked down."
5. **The code** is eight letters from `CONSENT_CODE_ALPHABET`, shown as `ABCD-EFGH`, so it never
   looks like a login code (A's R11).

The page has the same CSP and headers as the Mac's own pages: no script, no forms and no images.

## Pairing

These are the frames of B's pairing design (`pairing.ts`, J1). The relay passes sealed messages
it can't open.

1. **Offer.** The Mac sends `pairing-open { offerId, expiresAt }`.
   - The relay holds the offer in memory on the Mac's socket, for at most 6 minutes, whatever
     expiry the Mac asks for.
   - At most 3 offers can be open at once.
2. **Reply.** The phone connects to `/v1/phone/<macId>`, which is not yet registered. Instead of a
   hello it sends `pairing-reply { macId, offerId, sealed }`.
   - The relay passes it to the Mac only once per offer, and only while the offer is open.
   - Replies are limited to 10 a minute per Mac.
   - Everything else is refused (4401), and so is any frame the phone sends while it waits.
3. **Challenge and result.** The Mac's `pairing-challenge` and `pairing-result` go to that waiting
   socket only. After the result the relay closes it (1000). A phone that paired connects again
   and says hello.
4. **Registration** is not done by pairing: the Mac sends `device-register` once it has checked
   the phone.

## The phone channel

- **Routing.** `envelope` frames are routed, never opened. The relay checks only the outer fields:
  - `from` must be the sender's authenticated id;
  - from the Mac, `to` must be a registered phone;
  - from a phone, `to` must be the Mac.

  The whole frame is capped at `maxEnvelopeBytes`.
- **Offline devices.** An envelope for a device that isn't connected is dropped. The sender knows
  the device is offline (`device-online` or `mac-online`), and the inner `ack`s show what
  arrived; nothing is queued. Resending unacked envelopes when a device comes back is the Mac's
  job (D's broker), on `device-online`.
- **Rate.** A phone may send `maxEnvelopesPerMinutePerDevice` (60) a minute. Past that, its socket
  closes (4429).
- **Registration.** `device-register` stores the phone's id and transport key, for at most
  `maxDevicesPerMac` phones; beyond that the frame is ignored. `device-unregister` removes it.
  Either one closes the phone's socket at once if its key changed or it was removed.
- **Push token.** `push-token` from a phone is stored on its device entry.

## Lock and recovery

These are J7 F1 and F2, and the contract's item 4 from G.

- **Lock.** `relay-lock` from a registered phone sets `locked` in storage.
  - Every in-flight request fails.
  - The Mac and every phone get `relay-locked`.
  - While locked, nothing from the internet reaches the Mac: see forwarded HTTP, item 7.
  - The lock holds even while the Mac is offline, so a stolen token's calls can't land first when
    the Mac reconnects.
- **Unlock.** Only the Mac lifts the lock, with `relay-unlock`, which the app sends only after
  the person approves it at the Mac (not built yet). The relay tells every phone.
- **Recovery code.** The Mac registers only the code's hash (`recovery-register { codeHash }`):
  SHA-256 of the code, uppercased, with spaces and dashes removed, in hex. The code itself never
  reaches the relay before it is used.
- **The recovery page** is `https://<macId>.<RELAY_HOST>/recover` (`br-recovery`).
  - It is a form with no script, posting only to itself (`form-action 'self'`).
  - The code travels only in the POST body, never in a URL, so it stays out of logs and history.
  - A post from another origin is refused.
  - With the right code the relay locks, as above, and if asked also removes every paired phone
    and closes their sockets. The Mac gets `relay-locked { by: 'recovery', phonesUnregistered }`.
  - It can never unlock, approve or pair.
- **Recovery limits.** Tries are limited to 10 an hour per Mac, in the Durable Object, and to 20
  a minute per source at the front door.
  - A Mac with no code set gets the same answer as a wrong code.
  - The code is 128 bits, so the limits are against noise, not guessing.

## Push

`push { deviceId, kind }` from the Mac sends an APNs alert. Its payload is exactly
`pushPayloadSchema`: title "Valet", and body "Valet needs you" or "Something changed in Valet".
Nothing from the Mac reaches APNs except the choice of kind.

- **Token auth.** An ES256 JWT, signed with the APNs key (a Worker secret), held for 50 minutes
  in one `PushRelay` Durable Object. A 403 from APNs mints a new one.
- **Limits.** At most one push per device per 10 s, and 60 per device per hour; extras are
  dropped.
- **Gone tokens.** A 410 from APNs (the token is no longer valid) clears the stored token.
- **No settings.** Without APNs settings (local development, CI), pushes are dropped silently.

APNs needs HTTP/2. Workers' outbound `fetch` negotiates HTTP/2 with origins that offer it, but
whether it works with `api.push.apple.com` is to be confirmed on staging (_verify_). If it
doesn't, the fallback is a small push sender outside Workers; the `PushSender` interface keeps
that a one-file change.

## What the relay keeps, and logs

- **Storage:** exactly `RelayStoredState`, under one key:
  - `macId` and `macTransportKey`;
  - each device's id, transport key and push token;
  - `recoveryCodeHash`, `locked`, `createdAt` and `lastSeenAt`.

  Nothing else is ever written. A test reads the whole storage after a full OAuth and tool-call
  run and checks this.
- **Memory only:**
  - in-flight requests: their ids and the client's response stream;
  - open pairing offers;
  - rate counters;
  - the APNs JWT.
- **Logs:** `observability.enabled = false` and `logpush = false`.
  - No `console` calls carry request data. Error paths log a stage and an error class
    (`relay: forward failed (TypeError)`).
  - A test fails the build if `console.` appears in `apps/relay/src` outside `log.ts`.
  - Cloudflare's own zone analytics and any zone-level Logpush still see request URLs. The
    `/authorize` query (client id, state, PKCE challenge) is not secret, and codes and tokens
    travel only in bodies and redirects. Don't turn on zone Logpush for the relay's zone.

## Failure cases

| Case                                     | What happens                                                                                       |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Mac offline                              | Tool calls get a tool error, other requests 503; the consent page says the Mac isn't connected     |
| Relay locked                             | Tool calls get a tool error, other requests 503, the consent page says locked; nothing reaches Mac |
| Mac drops mid-request                    | Not started: 502. Streaming: the stream errors. Nothing is retried (a write might have happened)   |
| Mac floods frames                        | Socket closed past the burst; its requests fail                                                    |
| Mac answers HTML or a file               | 502, `http-cancel`                                                                                 |
| Mac never answers                        | 504 after 120 s; `http-cancel` sent                                                                |
| Response over 8 MiB                      | Cut off with an error; `http-cancel`                                                               |
| Client disconnects                       | `http-cancel`; later frames for that id are ignored                                                |
| 17th concurrent request, or 5th stream   | 429 with `Retry-After: 1`                                                                          |
| Phone not registered                     | Hello refused (4401)                                                                               |
| Phone sends an envelope to another phone | Dropped; socket closed (4400)                                                                      |
| Device unregistered while connected      | Its socket closes at once                                                                          |
| Relay restarts / DO evicted              | Hibernated sockets survive; in-flight requests fail; the Mac and phones reconnect with backoff     |
| Someone claims a Mac id                  | Refused without the Mac's approval key's binding                                                   |
| Mac unseen for 180 days                  | Its state is deleted; it re-registers with its binding                                             |

## Options considered

- **One host, with a path per Mac** (`relay/m/<macId>/mcp`).
  - For: no wildcard certificate.
  - Against: the OAuth issuer gains a path, the well-known URLs change shape, and
    `RELAY_FORWARDED_PATHS` would have to change.
  - Rejected, in favour of the contract's per-host design.
- **Forwarding in-process to the MCP handler, instead of over loopback HTTP.**
  - For: one hop fewer.
  - Against: a second way into the handler, with its own header and stream mapping. The loopback
    listener already exists for cloudflared and has the guards.
  - Kept loopback.
- **Queueing calls for an offline Mac.** Rejected: relay.md explains that a replayed write is
  worse than a failure.
- **KV or D1 for device registrations.** A Durable Object per Mac already serialises everything
  about that Mac. A second store would be a second thing to keep within `RelayStoredState`.
- **Polling consent with the bare id in the URL.** Replaced by the signed wait token, which also
  binds the redirect the relay may follow.

## Risks and open questions

- **Wiring into the app** waits for the device keys in the Swift helper (D's or H's pairing
  work). The relay client takes a `TransportSigner` and a `RelayBinding`, and the app passes the
  helper's when they exist.
- **APNs over Workers fetch** is _verify_ on staging.
- **Who locked.** `relay-locked` on reconnect says `by: 'phone'` even after a recovery-page lock,
  because storage keeps only `locked`. Proposed to B: store `lockedBy`.
- **Recovery code normalisation** is the relay's (`recoveryCodeHash` in `src/core.ts`). Proposed
  to B: pin it in core, so the Mac hashes the same way.
- **Sign-up abuse.** Anyone with a key pair can create a Durable Object by registering. The
  per-source connection limit bounds it; invites or payment come with D16.
- **In-memory limits** (recovery tries, pairing replies, the frame bucket) reset if Cloudflare
  evicts the Durable Object. The front door's limits don't, and the codes are long enough that
  this doesn't matter.

## What needs Nick

Batched for the coordinator. None of it is on the Woolworths order path.

1. A Cloudflare account, and either an API token for deploys or Nick running `wrangler deploy`
   himself. It needs Workers Paid (about US$5 a month), for Durable Objects and the rate-limiting
   binding.
2. The relay's host: a dedicated short domain (recommended), or `relay.dncr.me` with Advanced
   Certificate Manager.
3. An APNs key (.p8), its key id and team id, from the Apple Developer account that H also needs.
4. A go-ahead to deploy to staging, and later to production.
