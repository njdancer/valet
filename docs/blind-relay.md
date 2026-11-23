# The blind relay

Nick decided on 2026-11-21 that the relay must not be able to read traffic: it is a dumb proxy, so
people can trust it without trusting whoever runs it. It replaced the Cloudflare hub
([relay-hub.md](relay-hub.md)), which closed on 2026-11-22. Design note with the decisions:
"Valet blind relay: design note" (claude.ai doc).

## Shape

```
Claude / ChatGPT / phone ──TLS for <macId>.<mac domain>──▶ relay :443 ──WebSocket──▶ Mac
                                                             │ reads the server name only
                                                             └ TLS ends on the Mac
```

- **The relay** (`apps/blind-relay`) accepts TCP on port 443 and parses exactly one thing: the
  server name in the TLS ClientHello (`parseClientHello` in `packages/core/src/tunnel-protocol.ts`).
  A name `<macId>.<mac domain>` is piped, still encrypted, down that Mac's WebSocket. Its own
  control host (where Macs dial in) is the only name whose TLS it ends. It stores nothing, keeps no
  registry and logs counts only: Mac id, bytes, connections.
- **The Mac** (`packages/mcp-server/src/tunnel-client.ts`) dials the control host, signs in, and
  gets each connection as a stream of raw bytes. It reads the ClientHello itself, puts its own
  certificate on the stream with Node's `TLSSocket`, and hands the decrypted connection to the remote
  listener's HTTP server (`RunningRemoteListener.accept`). That is the same listener, OAuth server
  and policy a tunnel daemon reaches on 127.0.0.1, so there is still one MCP code path (D41).
- **Names.** A Mac's name is its macId, which is the id of its approval key. The relay checks the
  sign-in against the key itself, so it needs no registry and loses nothing on restart. For now the
  Mac domain is `valet.dncr.me`: a wildcard `*.valet.dncr.me` DNS record (DNS only, not proxied)
  points at the relay's Fly addresses. `valet.dncr.me` itself was the hub's, deleted with it (`.github/workflows/retire-hub.yml`).

## Signing in

The relay sends the Worker relay's challenge (`relayChallengeSchema`, naming the relay's origin);
the Mac answers with `relayHelloSchema`: its transport key's signature over
`relayAuthPayload`, plus the binding in which its approval key (Touch ID, once) vouches for the
transport key. The relay checks that the approval key's id is the macId in the path, the binding,
and the signature, then answers `ready` with the Mac's name. A second sign-in as the same Mac
replaces the first, which closes with 4409 and stops retrying.

## Streams

After `ready`, binary WebSocket messages are stream frames: `kind (u8) | stream (u32) | payload`
(`TUNNEL_FRAME`): `open` (relay to Mac, with the caller's address), `data`, `end` (half close),
`reset` and `credit`. Each side may send `TUNNEL_LIMITS.window` bytes on a stream before it hears
credit, so a caller that never reads its reply holds back only its own stream. Both ends use the
same `TunnelMux` (`packages/core/src/tunnel-mux.ts`).

Headers that only something on this Mac may set (`Cf-Connecting-Ip`, `X-Valet-Transport`) are
removed from requests that arrive through the tunnel, and `Cf-Connecting-Ip` is set to the address
the relay saw, so the OAuth server's per-source limits still hold.

## Certificates

A connection that offers ALPN `acme-tls/1` is Let's Encrypt validating the name (TLS-ALPN-01, RFC
8737). The Mac answers it with the challenge certificate and serves nothing else on it. The ACME
client and the certificate writer are in `packages/acme` (no dependencies; DER written by hand,
read back with Node's `X509Certificate`).

## In the app

`apps/desktop/src/main/core/blind-tunnel.ts` runs the tunnel and the certificate together. Phones
starts it once the Mac's keys and relay binding are ready (the same sign-in the Worker relay
took). Remote access serves the Mac's name
from then on, and offers `https://<macId>.<mac domain>/mcp` as the connector address once the
certificate is there. The certificate and its keys stay in Valet's own Keychain item
(`valet.relay-certificate`), or a 0600 file in a development build without the helper.

Valet's relay (`relay.valet.dncr.me`, Macs under `valet.dncr.me`) is built in and on by default:
a release always uses it. A development build uses it too, unless `VALET_BLIND_RELAY` names
another control host with `VALET_BLIND_MAC_DOMAIN`, or is `off`. `VALET_BLIND_RELAY_CONNECT` (a
`wss://` address) and `VALET_ACME_DIRECTORY` point it at a local relay and CA. Demo and e2e runs
use a relay only when the environment names one, so tests never reach the real relay or Let's
Encrypt.

Remote access's "Through Valet's relay" card says how far it has got: connecting, setting up the
Mac's address (the certificate), or waiting for Let's Encrypt's weekly limit with the time it tries
again. It shows the Mac's own address to copy once the certificate is there. Remote access can be
turned on meanwhile. A connection with no server name (one
dialled by address) is answered as the control host.

## Phones

The iPhone reaches each Mac at the Mac's own address too: `wss://<macId>.<mac domain>/v1/phone/<macId>`,
TLS ended on the Mac like an agent's connection. The Mac answers that path itself
(`apps/desktop/src/main/core/approvals/phone-door.ts`) with exactly the frames the old Worker relay
used for phones ([relay-worker.md](relay-worker.md#connections)), so the phone app and the phone
channel above it are the same whichever way a phone comes in:

- a challenge naming the Mac's own origin (`https://<macId>.<mac domain>`), answered by a hello
  the phone's transport key signs for that origin; a challenge for any other origin is never signed;
- then sealed envelopes both ways, each checked to be from that phone to this Mac;
- or, before a hello, one sealed pairing reply to an offer the Mac opened.

What the old Worker relay checked because it was a stranger, the Mac checks against its own device list:
a phone it paired, or one on the account's list. There is no registration, and a phone removed
there is shut out at once (4403). A stranger and a wrong signature get the same refusal (4401). A
second connection from the same phone replaces the first (4409). Phones are served whether or not
remote access is on, because the tunnel hands a connection whose first request is
`GET /v1/phone/…` to the door before the remote listener sees it (`routeByRequest`). `relay-lock`
does nothing here: it asks a relay to stop passing traffic while the Mac is away, and nothing
reaches the Mac at its own address while it is away; Pause and Lock down, sealed, stop it.

**Pairing.** The QR code names the Mac's own origin once the Mac is online at the blind relay
with its certificate, so a new phone dials only that. Until then, and on a Mac with no Worker
relay, it names whichever the Mac has.

**Only this way (2026-11-22).** Nick closed the hub and the Worker relay, so the phone app has no
account sign-in and no fallback: a paired phone dials only `https://<macId>.valet.dncr.me`
(`PhoneModel.valetMacDomain`, the same as the Mac's `VALET_RELAY`), and pairing by the Mac's QR
code is the only way in. A phone an older build signed in to the account (`viaAccount`) forgets
that state at launch and asks to pair, with a word on why. The Mac sends every phone's frames
through the door (`Phones` has no other way out), and trusts only phones paired with it.

## Deploying

`.github/workflows/deploy-relay.yml` deploys main's tip to the Fly app `valet-relay` after CI
passes, when anything the relay runs has changed. It needs the `FLY_API_TOKEN` secret.

With `CLOUDFLARE_DNS_TOKEN`, or else the hub's `CLOUDFLARE_API_TOKEN` (either with Zone › DNS ›
Edit on dncr.me), it then points `relay.valet.dncr.me` and `*.valet.dncr.me` at the app's dedicated addresses (`apps/blind-relay/scripts/sync-dns.mjs`):

- an A record per dedicated IPv4 and an AAAA record per dedicated IPv6;
- DNS only, because Cloudflare's proxy would end TLS;
- stale addresses removed, nothing else in the zone touched.

Fly's dedicated addresses don't change while they're held, so this only matters when one is added or
released. The token stays in GitHub: a DNS updater on the relay would hand anyone who broke into it
the whole zone.

**IPv4.** Fly's free shared IPv4 reaches an app only through Fly's own HTTP and TLS handlers, which
end TLS at Fly, so the blind relay can't use it. Raw TCP on IPv4 needs a dedicated IPv4. Without
one, only callers with IPv6 reach the relay. That rules out GitHub's runners, so the workflow reads
the version live through flyctl rather than `/healthz`.

## Tests

- `packages/core/test/tunnel.test.ts`: the ClientHello parser against real Node hellos, frames,
  and the multiplexer's flow control, resets and limits.
- `apps/blind-relay/test/relay.test.ts`: relay and Mac on loopback: routing, ciphertext only,
  large bodies both ways, refused keys and bindings, denied Macs, replacement, relay restart, the
  ACME challenge, a stalled caller not blocking others.
- `apps/blind-relay/test/mcp.test.ts`: a real MCP SDK client registers, gets consent at the Mac,
  takes a token and calls a tool through the relay; nothing it carried is readable.
- `apps/desktop/e2e/blind-relay.spec.ts`: the built app, the real relay and a CA that really checks
  TLS-ALPN-01. The app gets its certificate through the relay; an agent signs in with the Mac's
  OAuth server from a real browser and calls a tool at the Mac's address; pausing closes it; a relay
  restart costs nothing, not even a new certificate.
- `apps/blind-relay/test/sync-dns.test.ts`: the deploy's DNS step against a stand-in zone.
- `apps/desktop/test/main/phone-door.test.ts`: the phone channel at the Mac's own address through
  the real relay and tunnel: pairing by QR, a card approved, a resend after the phone was away,
  nothing readable at the relay, refusals, removal and replacement.
- `ios/ValetPhoneKit/Tests/ValetPhoneCoreTests/OwnAddressTests.swift`: the phone dials the Mac's
  own address first, falls back to the relay it paired through, goes back, and never signs a
  challenge for another origin.
