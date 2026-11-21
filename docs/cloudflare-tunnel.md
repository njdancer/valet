# My Cloudflare account

Nick asked on 2026-11-21 for an easy way to run remote access through a Cloudflare Tunnel in your
own Cloudflare account, as an alternative to Valet's relay ([blind-relay.md](blind-relay.md)).
Remote access shows it as the "Your own Cloudflare account" card.

## What the person does

They paste an API token and type a public name under one of their domains, such as
`valet.example.com`, then press Connect. The token needs **Cloudflare Tunnel: Edit** on the account
and **DNS: Edit** on the zone. If remote access is off, connecting turns it on, with the approval
that always takes. Adding the name is a widening, so it is signed like any public name added by hand.

The card says plainly that in this mode **Cloudflare decrypts traffic at its edge and can read what
agents send this Mac**. Valet's relay can't.

## What Valet does

`apps/desktop/src/main/core/cloudflare-tunnel.ts` makes the Cloudflare API calls and runs cloudflared.
`cloudflare-remote.ts` holds the app's side.

1. It finds the zone that holds the name: the longest suffix the token can see. It finds the
   remotely managed tunnel `valet-<name>`, or creates it.
2. It sets the tunnel's whole configuration: the name goes to the remote listener at
   `http://127.0.0.1:<port>`, and everything else gets a 404.
3. It adds a proxied CNAME to `<tunnel>.cfargotunnel.com`, then fetches the tunnel's token.
   - A record for the name that Valet didn't make is left alone (`name-taken`).
   - Running the setup again reuses the tunnel and the record.
4. It adds the name to remote access's public names, so the listener's host guard accepts it.
   - If the person doesn't approve, Valet removes what it made in the account.
5. It keeps the API token, the tunnel token and the ids in Valet's own Keychain item,
   `valet.cloudflare-tunnel`. A development build without the helper keeps them in a 0600 file.
6. It runs cloudflared (`tunnel --no-autoupdate run`) while the listener is up.
   - The tunnel token goes in cloudflared's environment, never in its arguments.
   - cloudflared gets none of Valet's own environment.
   - It starts again with backoff whenever it exits.
   - If the listener comes up on another port after a restart, Valet points the tunnel at the new
     port first.

Disconnecting does the following, in order:

1. Stops cloudflared and takes the name away at once.
2. Forgets the Keychain copy.
3. Deletes the DNS record, the tunnel's connections and the tunnel.

If Cloudflare can't be reached, the local side is still gone. The card then says that the tunnel was
left in the account.

## cloudflared in the app

A release ships Cloudflare's official cloudflared as `Contents/MacOS/cloudflared`. It is built by
`apps/desktop/scripts/cloudflared.mjs`, the same way as the Node runtime:

- It uses the release pinned in `build/cloudflared.json`.
- Both architectures are checked against the pinned SHA-256s and joined with `lipo`.
- It is signed on its own, with its own identifier and the hardened runtime, and no entitlements.

The release script checks that the binary ships, is universal, is signed that way and runs.

A build without cloudflared doesn't offer the option. A development build can name one with
`VALET_CLOUDFLARED`: an absolute path, or a `.mjs` stand-in that Electron runs as Node.
`VALET_CLOUDFLARE_API` points it at a stand-in API on 127.0.0.1, which a release refuses.

## Tests

- `apps/desktop/test/main/cloudflare-tunnel.test.ts` covers the API calls against a stand-in
  Cloudflare (`test/fixtures/fake-cloudflare.ts`):
  - provisioning, reuse and a record that isn't Valet's
  - each problem: token, permission, zone, network, garbled answers
  - removal
  - the runner: token only in its environment, restart with backoff, a missing binary
- `apps/desktop/test/main/cloudflare-remote.test.ts` covers the app's side:
  - connect, remote off, refusal leaving nothing behind, no binary
  - running only while the listener is up, and a restart onto another port
  - disconnect, including when Cloudflare is unreachable
  - replacing the name
  - both stores
- `apps/desktop/e2e/cloudflare.spec.ts` uses the built app, the stand-in API and a stand-in
  cloudflared that serves the tunnel's real configuration as Cloudflare's edge would:
  - connect from the card
  - a request for the name reaching the Mac's listener
  - a restart running it again with nothing asked
  - disconnecting removing everything
