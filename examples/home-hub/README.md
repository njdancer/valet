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
- A **kept token**, used two ways, as Home Assistant wants it: Valet adds `Authorization: Bearer …`
  to the REST request, and signs in to the socket with the manifest's **credential message**
  (`{"type":"auth","access_token":"{value}"}`) when the tool calls `socket.sendCredential('hub')`
  after the hub says `auth_required`. Both go to that address only, over https only, and the tool
  code never sees the token. What the hub sends back is redacted for it.
- The socket declared as a **write**, because anything sent on it could act; reading stays on the
  REST path a read tool may use.
- Cases that **script the socket**: what the hub sends, what the tool must send, and a close.

Live trials never reach the person's network, so the cases are the test until the person approves
it. Locks are listed but not changed: unlocking a door is not something this example does.

A hub that takes the token on the socket's upgrade instead opens it with
`ctx.http.websocket(url, { credential: 'hub' })` and leaves out the message.

Start a draft from it with `valet_create_draft` (`from: "example"`, `example: "home-hub"`).
