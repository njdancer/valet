# The relay Worker (workstream G)

Status: built and tested locally (miniflare); not deployed. Deploying needs Nick's Cloudflare
account and a host name ([What needs Nick](#what-needs-nick)).

This is the design of the relay that [plan-agent-run.md](plan-agent-run.md#g-cloud-relay-on-cloudflare-workers)
asks for. The protocol and threat model are B's, in
[agent-run-security.md](agent-run-security.md#the-relay-protocol) and
`packages/core/src/relay-protocol.ts`; this document says how the Worker and the Mac's side carry
them out, and what they add. The background and the options considered are in [relay.md](relay.md).

## Brief

- **Journeys served:** J2 (connect a remote agent: OAuth through the relay, consent at the Mac),
  J4 (approve on the phone: sealed envelopes and pushes), J7 (lock down from the phone), J8 (agents
  calling tools from anywhere). Journeys are in `docs/ux/agent-run/journeys.md` (PR #73).
- **Must not break:** the Mac decides everything. The relay holds no tokens, grants or approvals,
  can't read or forge the phone channel, and stores only `RelayStoredState`.
- **Must not change:** the frames in `relay-protocol.ts`. H builds against them now.

## Shape

```
remote MCP client ─HTTPS─▶ Worker ──▶ Durable Object "MacRelay" (one per macId) ◀─WSS─ Mac (relay client)
 https://<macId>.<RELAY_HOST>/mcp               ▲                                       │ loopback HTTP
                                                └──────────────WSS───────── phone       ▼
                                                                              remote listener (OAuth + MCP)
```

- **`apps/relay`**: the Worker (`src/index.ts`) and the Durable Object (`src/mac-relay.ts`).
- **`packages/mcp-server/src/relay-client.ts`**: the Mac's side. It dials out, answers the
  challenge with the transport key, and turns each `http-request` frame into a loopback request to
  the existing remote listener (`startRemoteListener`), exactly as cloudflared did. No second MCP
  or OAuth code path: the relay client is a byte pipe (D41).

### Host names

Each Mac has its own host, `<macId>.<RELAY_HOST>`. The Mac's OAuth server already derives its
issuer and resource from the host (`https://<host>/mcp`), and OAuth metadata discovery is at the
host's root, which is why `RELAY_FORWARDED_PATHS` are root paths. A path prefix per Mac would mean
changing the Mac's OAuth server and the well-known paths, for no gain.

Device connections go to the bare `RELAY_HOST`: `wss://<RELAY_HOST>/v1/mac/<macId>` and
`wss://<RELAY_HOST>/v1/phone/<macId>`. Any other host or path gets a plain 404.

Recommended host: a short dedicated domain (relay.md: a separate registrable domain, so cookies and
reputation can't cross onto anything else, eventually on the Public Suffix List). Its first-level
wildcard `*.<domain>` is covered by Cloudflare's free Universal SSL. Under `dncr.me`,
`*.relay.dncr.me` is a second-level wildcard and needs Advanced Certificate Manager
(about US$10 a month) or Total TLS. This is Nick's call.

## Connections

1. The Worker routes `/v1/mac/<macId>` and `/v1/phone/<macId>` to `MacRelay` named by `macId`
   (after checking `macId` matches `KEY_ID`), and the Durable Object accepts the WebSocket with the
   hibernation API, so idle connections cost almost nothing.
2. The relay's first frame is `challenge` with a fresh 32-byte nonce and `RELAY_ORIGIN`.
3. The device answers `hello`. The relay verifies the signature over
   `valet/relay-auth/v1\n` + `relayAuthPayload({ nonce, relay, role, id })` (JSON in that key order,
   no whitespace), with WebCrypto ECDSA P-256 over SHA-256 (raw r||s is WebCrypto's own format).
   - **Mac** (`role: 'mac'`, `id` must equal the path's `macId`): if the relay has no key for this
     Mac, `transportKey` is required and becomes the stored key (trust on first use, see
     [Risks](#risks-and-open-questions)); after that `transportKey` must be absent or equal to it.
   - **Phone** (`role: 'phone'`): `id` must be a device the Mac registered, verified with its
     stored transport key; `transportKey` must be absent.
4. A wrong role, id or signature, or no hello within `challengeTimeoutMs`, closes the socket
   (code 4401 or 4408) and nothing is stored.
5. On success the Mac gets `ready { devices }`; a phone gets `ready { macOnline }`. A second Mac
   connection replaces the first (the old one closes with 4409), so a reconnecting Mac never
   locks itself out; a second phone connection for the same device does the same.
6. Online changes are told to the other side: phones get `mac-online`, the Mac gets
   `device-online`.

Each socket's authenticated identity lives in its hibernation attachment, never in storage.

## Forwarded HTTP

For a request on `<macId>.<RELAY_HOST>`:

1. **Path.** One of `RELAY_FORWARDED_PATHS`, `RELAY_CONSENT_PATH`, or 404 from the relay.
2. **Method.** GET, POST or DELETE (the contract's set); anything else is 405.
3. **Origin.** A request that carries `Origin` is refused with 403, except a GET to `/authorize`.
   The relay drops every header outside `RELAY_FORWARDED_HEADERS`, so without this check the
   Mac's own Origin guard (which refuses any request with an Origin) would be silently bypassed.
4. **Limits**, before anything reaches the Mac:
   - per source address (`CF-Connecting-IP`), with the Workers rate-limiting binding: 120
     forwarded requests a minute, and 20 a minute on `/register`, `/token` and `/authorize`;
   - per Mac, in the Durable Object: `maxConcurrentRequestsPerMac` (16) in flight, then 429.
5. **Body.** At most `maxRequestBodyBytes` (1 MiB), read as UTF-8 text; 413 above it. A POST to
   `/mcp` must parse as a JSON-RPC message or batch, or it is 400: the relay is not a general
   tunnel.
6. **Mac offline.** Answered at once, nothing queued: a `tools/call` gets a JSON-RPC result with
   `isError: true` ("The Mac running Valet isn't connected to its relay…"); anything else is 503
   with `Retry-After: 30`.
7. **Forward.** An `http-request` frame with a fresh id, the allowed headers only, the body, and
   `source` = `CF-Connecting-IP`. The Mac's answer streams back as `http-response-start`, `-chunk`s
   and `-end`; the relay keeps only allowed response headers and adds `cache-control: no-store`
   and `x-content-type-options: nosniff` if the Mac set none.
8. **Cancel.** If the client goes away, the relay sends `http-cancel`. If the Mac disconnects
   mid-response, the stream errors (or, before the start frame, the client gets 502).
9. **Timeout.** A response that hasn't started within 120 s is 504. A started stream has no
   timeout of its own (the Mac's long calls send progress, relay.md "Long calls").

Frames from the Mac are capped at `maxFramesPerSecondPerMac` (50) per second; above it the relay
closes the Mac's socket (4429), which fails its in-flight requests. Every frame from a device is
parsed with its direction's schema; anything else closes the socket (4400). A response frame for
an id the relay doesn't know is ignored.

### On the Mac

The relay client sends each `http-request` to the remote listener on `127.0.0.1` with
`Host: <macId>.<RELAY_HOST>` and `CF-Connecting-IP: <source>`, so the listener's host check,
per-source OAuth limits and audit see what they saw behind cloudflared. The listener's
`hosts()` must include the relay host; the app adds it when relay mode is on. Responses are
streamed back in chunks of at most `maxResponseChunkBytes`, decoded as UTF-8 with a streaming
decoder so a multi-byte character is never split.

## Consent (`/authorize`)

`/authorize` is the one page the relay renders, from a fixed template filled with the Mac's
structured `consent-view` (never HTML from the Mac):

1. A browser opens `/authorize?<OAuth query>`. The relay sends `consent-open { id, query, source }`
   with a fresh random id.
2. The Mac runs the same checks as its own `/authorize` (`RemoteAuthorization.consentView`, shared
   with the HTTP route) and answers:
   - `waiting` with `code`: a consent request is open on the Mac. The relay shows the code and
     "Type this code into Valet on your Mac", and the page refreshes to `/authorize?wait=<id>`
     every 3 s.
   - `approved` or `declined` with `redirect`: the relay answers 302 to the redirect (the client's
     registered https redirect URI, with `code` or `error`).
   - `declined` without `redirect`: the relay shows "This sign-in can't go on" (unknown client, bad
     redirect URI, too many attempts).
   - `expired`: "This sign-in has ended."
3. A refresh (`?wait=<id>`) sends `consent-open` again with the **same id** and an empty query.
   The Mac treats a known id with an empty query as a poll of that request, and an unknown one as
   expired. The id is 128 random bits, so another browser can't poll it.
4. Mac offline: the relay shows "Your Mac isn't connected" and sends nothing.

The page has the same CSP and headers as the Mac's own pages (no script, no forms, no images).

## The phone channel

- `envelope` frames are routed, never opened. The relay checks the outer fields only:
  `from` must be the sender's authenticated id; from the Mac, `to` must be a registered phone;
  from a phone, `to` must be the Mac. The frame is capped at `maxEnvelopeBytes`.
- An envelope for a device that isn't connected is dropped. The sender knows it is offline
  (`device-online` / `mac-online`) and the inner `ack`s show what arrived; nothing is queued.
- A phone may send `maxEnvelopesPerMinutePerDevice` (60) a minute; above it, extra envelopes are
  dropped and the socket closes (4429).
- `device-register` stores the phone's id and transport key (at most `maxDevicesPerMac`, else the
  frame is ignored). `device-unregister` removes it and closes its socket at once.
- `push-token` from a phone is stored on its device entry.

## Push

`push { deviceId, kind }` from the Mac sends an APNs alert whose payload is exactly
`pushPayloadSchema`: title "Valet", body "Valet needs you" or "Something changed in Valet".
Nothing from the Mac reaches APNs except the choice of kind.

- APNs token auth: an ES256 JWT signed with the APNs key (a Worker secret), cached for 50 minutes.
- At most one push per device per 10 s, and 60 per device per hour; extras are dropped.
- A 410 from APNs (token no longer valid) clears the stored token.
- Without APNs settings (local development, CI) pushes are dropped silently.

APNs needs HTTP/2. Workers' outbound `fetch` negotiates HTTP/2 with origins that offer it, but
that it works with `api.push.apple.com` is to be confirmed on staging (_verify_). If it doesn't,
the fallback is a small push sender outside Workers; the `PushSender` interface keeps that a
one-file change.

## What the relay keeps, and logs

- **Storage:** exactly `RelayStoredState` under one key: `macId`, `macTransportKey`, each device's
  id, transport key and push token, `createdAt`. Nothing else is ever written. A test reads the
  whole storage after a full OAuth-and-tool-call run and checks this.
- **Memory only:** in-flight requests (ids, the client's response stream), rate counters, the
  APNs JWT.
- **Logs:** `observability.enabled = false` and no `console` calls with request data. Error paths
  log a stage and an error class (`relay: forward failed (TypeError)`). A lint test fails the
  build if `console.` appears in `apps/relay/src` outside `log.ts`.

## Failure cases

| Case                                   | What happens                                                                                    |
| -------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Mac offline                            | Tool calls get a tool error, other requests 503; consent page says the Mac isn't connected      |
| Mac drops mid-request                  | Not started: 502. Streaming: the stream errors. Nothing is retried (a write might have happened) |
| Mac floods frames                      | Socket closed at 50 frames/s; its requests fail                                                 |
| Mac never answers                      | 504 after 120 s; `http-cancel` sent                                                             |
| Client disconnects                     | `http-cancel`; later frames for that id ignored                                                 |
| 17th concurrent request                | 429 with `Retry-After: 1`                                                                       |
| Phone not registered                   | Hello refused (4401)                                                                            |
| Phone sends an envelope to another phone | Dropped; socket closed (4400)                                                                 |
| Device unregistered while connected    | Its socket closes at once                                                                       |
| Relay restarts / DO evicted            | Hibernated sockets survive; in-flight requests fail; Mac and phones reconnect with backoff     |
| Two Macs claim one macId               | The second must sign with the stored key; otherwise refused                                    |

The Mac's client reconnects with exponential backoff (1 s to 60 s, with jitter) and answers
in-flight requests it can't finish with nothing: the relay fails them when the socket closes.

## Options considered

- **One host, path per Mac** (`relay/m/<macId>/mcp`): no wildcard certificate, but the OAuth
  issuer gains a path, well-known URLs change shape, and `RELAY_FORWARDED_PATHS` would have to
  change. Rejected for the contract's per-host design.
- **Forwarding in-process to the MCP handler instead of loopback HTTP:** one less hop, but a second
  way into the handler with its own header and stream mapping. The loopback listener already
  exists for cloudflared and has the guards. Kept loopback.
- **Queueing calls for an offline Mac:** rejected (relay.md: a replayed write is worse than a
  failure).
- **KV or D1 for device registrations:** a Durable Object per Mac already serialises everything
  about that Mac; a second store would be a second thing to keep within `RelayStoredState`.

## Risks and open questions

- **First registration is trust on first use.** If a Mac's stored state were ever lost, someone
  who knows its `macId` (it is in the public host name) could register a key first. Proposed to B:
  an optional proof on the first hello (the Mac's approval key and a one-time Touch ID signature
  over the transport key). Until then: the relay never deletes a Mac's state on its own, and the
  Mac shows "Valet can't sign in to its relay" if its hello is refused.
- **Relay-side lock and recovery code** (A's J7 F1 and F2) need new frames; proposed to B, not
  built.
- **"Not accepting new agents"** (A's J2 F5) needs a `consent-view` state; proposed to B.
- **Wiring into the app** waits for device keys in the Swift helper (D's or H's pairing work): the
  relay client takes a `TransportSigner`, and the app passes the helper's signer when it exists.
- **APNs over Workers fetch** (_verify_ on staging).
- **Sign-up abuse:** anyone can create a Durable Object by connecting a new key. Per-source limits
  on new Mac registrations (10 an hour per address) bound it; invites or payment come with D16.

## What needs Nick

Batched for the coordinator, none of it on the Woolworths order path:

1. A Cloudflare account (Workers Paid, about US$5 a month, for Durable Objects and the
   rate-limiting binding) and an API token for deploys, or Nick running `wrangler deploy` himself.
2. The relay's host: a dedicated short domain (recommended) or `relay.dncr.me` with Advanced
   Certificate Manager.
3. An APNs key (.p8), its key id and team id, from the Apple Developer account H also needs.
4. A go-ahead to deploy to staging, and later to production.
