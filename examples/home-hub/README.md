# Home hub (example)

An example of an `http` adapter for a device on the person's own network: a home-automation hub at
192.168.1.20:8123, with a self-signed certificate and a long-lived access token.

- `list_devices` reads the hub's states over its REST API (`GET /api/states`).
- `switch_light` turns a light on or off over its WebSocket API: `call_service`, then `get_states`
  on the same socket for the new state, skipping the events the hub sends in between.

What it shows:

- A **private host**, by address, pinned by the SHA-256 of the hub's own certificate
  (`certSha256`): no CA vouches for a hub, so only that exact certificate is trusted. The
  `0000…` in the manifest is a placeholder: the person reads the real one from their hub.
- A **kept token**: Valet adds `Authorization: Bearer …` to the REST request and to the socket's
  upgrade, for that address only, over https only.
- The socket declared as a **write**, because anything sent on it could act; reading stays on the
  REST path a read tool may use.
- Cases that **script the socket**: what the hub sends, what the tool must send, and a close.

Live trials never reach the person's network, so the cases are the test until the person approves
it. Locks are listed but not changed: unlocking a door is not something this example does.

Some hubs (Home Assistant among them) want the token in the socket's first message rather than on
the upgrade. A kept credential can't be put in a message, so for those the socket would need an
entrusted credential, which only a raw adapter may have.

Start a draft from it with `valet_create_draft` (`from: "example"`, `example: "home-hub"`).
