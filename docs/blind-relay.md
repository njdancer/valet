# The blind relay

Nick decided on 2026-11-21 that the relay must not be able to read traffic: it is a dumb proxy, so
people can trust it without trusting whoever runs it. This replaces the Cloudflare hub
([relay-hub.md](relay-hub.md)) once Nick's Mac has moved over. Design note with the decisions:
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
  points at the relay's Fly addresses, while `valet.dncr.me` itself stays on the hub until the move.

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

## Tests

- `packages/core/test/tunnel.test.ts`: the ClientHello parser against real Node hellos, frames,
  and the multiplexer's flow control, resets and limits.
- `apps/blind-relay/test/relay.test.ts`: relay and Mac on loopback: routing, ciphertext only,
  large bodies both ways, refused keys and bindings, denied Macs, replacement, relay restart, the
  ACME challenge, a stalled caller not blocking others.
- `apps/blind-relay/test/mcp.test.ts`: a real MCP SDK client registers, gets consent at the Mac,
  takes a token and calls a tool through the relay; nothing it carried is readable.
