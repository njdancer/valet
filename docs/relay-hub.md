# The relay as a hub: one MCP address for all your nodes

Status: **step 1 built** (see [Step 1 as built](#step-1-as-built)); steps 2 to 5 not yet. Agreed with Nick in the project thread on 2026-11-15/16. It
replaces the per-Mac byte pipe in [relay-worker.md](relay-worker.md) as the way remote agents
reach Valet. The phone channel, pairing crypto and approvals described there stay unless this
says otherwise.

## Why

Today each Mac is its own MCP server, reached at `<macId>.<relay host>/mcp` (or through a
cloudflared quick tunnel). The relay is a byte pipe: it holds no tokens and each Mac runs its own
OAuth. That gives one connector per Mac, URLs that change, and nothing that spans Macs. On
2026-11-15 the quick tunnel was deleted by Cloudflare and the connector broke until someone
noticed.

Nick's intent: the relay is a **service that gathers the tools of every node you have
connected**. You add one connector, `https://valet.dncr.me/mcp`, sign in, and see exactly the
tools your connected nodes offer, scoped by node.

## Decisions (Nick, 2026-11-15/16)

| #   | Question                   | Answer                                                                                                                                                                                                                                                                                                        |
| --- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1  | How you sign in            | **D79**: Valet accounts with login and 2FA. Scanning a QR code with a signed-in phone is a shortcut for signing in (like Discord's), not an extra step. No separate device-approval step. 2FA by passkey or authenticator app, never SMS (proposed with D79, not separately confirmed).                       |
| H2  | Who authorises an agent    | **You approve once on your phone; nodes check it.** The phone signs the grant (agent, tools or scope, expiry) with its device approval key. The hub stores and carries it; each node verifies the signature against your account's device list before serving. The hub can't grant an agent access by itself. |
| H3  | The same site on two nodes | **Scoped to the node.** Each node's tools are listed separately and name the node; nothing is merged or routed by preference.                                                                                                                                                                                 |
| H4  | A node that goes offline   | **Its tools disappear, after a grace period.** See [Offline nodes](#offline-nodes).                                                                                                                                                                                                                           |
| H5  | Whose nodes                | **Just Nick for now.** One account, his nodes. Design the data model so sharing could come later, but build none of it.                                                                                                                                                                                       |
| H6  | What goes through the hub  | **Everything**: site tools and Valet's admin and authoring tools, each scoped to its node and still behind that node's own approvals. Phones pair with the **account**, but every device keeps its own keys (below).                                                                                          |
| H7  | Domain                     | **`valet.dncr.me`** on Nick's Cloudflare zone for now; move to a dedicated domain later. One host, so no per-Mac wildcard certificate is needed.                                                                                                                                                              |

Context Nick gave with these: the threat model isn't strict; approvals exist to limit what is
exposed to models ([agent-run-security.md](agent-run-security.md), "Who this guards against
first"). Prefer the simpler design wherever the security cost is small, and say so when choosing.

## Shape

```
MCP client ──HTTPS──▶ valet.dncr.me  (Worker: OAuth AS + MCP server for the account)
                          │  account, devices, nodes, grants (D1 or a Durable Object per account)
                          ├──WSS── node A (Mac, relay client)  ─▶ its local MCP handler
                          ├──WSS── node B
                          └──WSS── phones (account devices)
```

- **The hub is the MCP server** the client talks to. It terminates OAuth for the client
  (the hub is the authorisation server and resource), answers `initialize`, `tools/list` and
  `tools/call`, and forwards each call to the node that owns the tool.
- **Nodes stay the authority over their own tools.** A node runs a call only if it carries a
  grant your phone signed (H2) and the node's own policy allows it (remote tool enablement,
  approvals, pacing, circuit breaker, lockdown). The hub never sees site secrets; it does see
  tool arguments and results in transit, as the relay does today.
- **Nodes dial out**, as now. A node authenticates with its transport key (challenge, `hello`),
  and is bound to the account when it is added (below).

## Accounts and devices

- **Account**: email (or passkey-first) login with 2FA, per D79. Session for the web pages on
  `valet.dncr.me`; OAuth for MCP clients.
- **Devices**: each phone and each Mac keeps its own Secure Enclave keys (approval, transport,
  agreement) exactly as in [agent-run-security.md](agent-run-security.md#devices-and-keys). The
  account holds the list of device public keys. End-to-end messages (approvals, alerts) are
  encrypted to each device's agreement key separately, so the hub still can't read them.
- **Adding a phone**: sign in on the phone (QR shortcut from an already signed-in device, or
  login + 2FA). The device list change is signed by an existing device's approval key so nodes
  can verify the list without trusting the hub. The first device bootstraps the list.
- **Adding a node (Mac)**: signed in to the account from Valet's Settings, the Mac registers its
  keys; a signed-in phone approves the addition (this is the account's "new device signed in"
  moment, not a separate approval step on top of login).
- This replaces Mac-to-phone pairing (`phones.startPairing` and the pairing frames). Plan the
  migration: today Nick has one Mac and one phone paired directly.

## Tool naming (H3)

- Names must be unique across nodes and stable. Suggested: `<node>__<adapter>_<tool>`, where
  `<node>` is a short slug the person picks when adding the node (default from the Mac's name,
  e.g. `mbp`). Keep within common client limits (64 characters, `[a-zA-Z0-9_-]`).
- The tool's description and title name the node ("Woolworths: add to cart (MacBook Pro)").
- Admin tools (`valet_*`) are per node too: `mbp__valet_status`. Consider a few hub-level tools
  later (list my nodes, which are online); none are required for the first slice.

## Offline nodes

MCP has `notifications/tools/list_changed`, but many clients fetch the tool list only at connect
and some ignore the notification, so removing tools immediately causes churn and dangling calls.

- The relay client pings every 30 s. A node with no frame for **90 s** is offline.
- For a **2-minute grace** after that, its tools stay listed and a call fails fast with a clear
  result: "MacBook Pro is offline. Try again shortly." (an `isError` tool result, not a protocol
  error).
- After the grace, its tools leave `tools/list` and the hub sends `list_changed` to connected
  sessions. When the node returns, its tools come back and `list_changed` is sent again.
- A call to a tool that no longer exists gets the same clear "offline or removed" error.
- Make both numbers settings in the hub's config, not constants buried in code.

## Grants (H2)

- When an MCP client finishes OAuth at the hub, the hub asks your phone (push, or the account's
  web page when no phone) to approve: which agent (client name, redirect host, the code shown in
  the browser, as the current consent does), and which nodes or tools. The phone signs the grant
  with its approval key (Face ID).
- A grant names the account, the client id, the scope (nodes, tools or "all remote-enabled
  tools"), and an expiry. Revoking is a signed tombstone the nodes also check.
- The hub attaches the grant (or a reference the node can fetch and verify) to each forwarded
  call. The node verifies it against the account's signed device list, then applies its own
  remote policy as today (`remote.json` tool enablement, approvals for side effects).
- Keep the current Mac-side consent code (`relayConsent`, `/authorize` with a typed code) only as
  long as the migration needs it.

## Build order (suggested)

1. **Hub skeleton on `valet.dncr.me`**: Worker, account store, login with 2FA (passkey first),
   deployed to staging. Node sign-in from Valet Settings; node presence with heartbeat.
2. **Aggregated MCP**: OAuth AS at the hub, `tools/list` from online nodes with node-scoped names,
   `tools/call` forwarded over the existing node socket (reuse `http-request` framing or add a
   `tool-call` frame), offline grace and `list_changed`.
3. **Grants signed on the phone**, verified by nodes; retire the per-Mac consent.
4. **Phones on the account**: device list signed by devices, QR sign-in shortcut, E2E envelopes
   addressed per device; migrate Nick's existing pairing.
5. Retire the per-Mac host (`<macId>.<RELAY_MAC_HOST>`) and the cloudflared docs once 1–3 work.

Each step ships behind CI with the relay's Miniflare tests extended, and a written threat-model
delta in [agent-run-security.md](agent-run-security.md).

## Constraints that still hold

- Adapter code never sees secrets; tests never touch real 1Password, Keychain or Messages.
- No logged-in Woolworths actions without Nick present.
- Deploying the Worker, DNS on `dncr.me`, and anything published needs Nick in the thread.
- The Mac's transport and agreement keys work after first unlock (PR #115), so nodes stay
  online while locked; the hub design relies on that.

## Step 1 as built

The hub runs in the relay's own Worker (`apps/relay/src/hub/`), on `HUB_HOST`. Without `HUB_HOST`
there is no hub: that host serves nothing and a Mac that asks hears `off`.

**Storage: one Durable Object with SQLite** (`Hub`, named `hub`). H5 is one account, so one
object holds the account, its passkeys, sessions and nodes. Every row carries its account id, so
moving to an object per account later is a data move, not a redesign. Chosen over D1 because the
object also has to be the single place that hands out link codes and, from step 2, holds the MCP
sessions that get `list_changed`; D1 would need a Durable Object for that anyway.

**Signing in (H1).**

- Sign-up is open once: it needs `HUB_SETUP_SECRET` (a Worker secret, typed on `/sign-up`) and
  closes for good once the account exists. Then a passkey is made (WebAuthn, user verification
  required, "none" attestation, `@simplewebauthn/server`).
- Sign-in is a discoverable passkey: the browser offers the site's passkeys, so the page never
  says which emails exist. A passkey counts as both factors.
- The backup is **email, password and an authenticator-app code, all three** (RFC 6238, 6 digits,
  30 s, each code once). Set up on `/security` after signing in. No SMS, no email codes (the hub
  sends no email).
- You can't remove your last way in: the last passkey stays until the app backup is on, and the
  app backup can't be turned off without a passkey.
- Sessions: a random token in a `__Host-` cookie (HttpOnly, Secure, SameSite=Lax), stored only as
  its SHA-256, 30 days. Every change is a JSON POST whose `Origin` must be the hub's.
- Changes that add or remove access (adding a node, a passkey or the app backup; removing
  anything) need a sign-in from the last 10 minutes. The page signs in with the passkey again and
  retries.

**Adding a node.** No second socket and no new signature: the Mac asks over the relay socket it
already has, which its transport key authenticated.

1. Settings › Devices › Connect to your Valet account sends `hub-link-start` with the Mac's name.
2. The hub answers `hub-status` in state `linking` with a code (`ABCD-EFGH`, 10 minutes, one per
   Mac) and Valet opens `https://<hub>/link`.
3. Someone signed in types the code and picks the node's short name (H3; defaults from the Mac's
   name). The code is never in a link, so a link someone sends you can't add their Mac to your
   account. Wrong codes are limited to 10 per 10 minutes per account.
4. The hub sends `hub-status` `linked` (account email, slug, name). After every hello the Mac hears
   its status again, so it is right after a restart.

Leaving: the Mac sends `hub-unlink`, or the node is removed on the hub's page (the Mac is told at
once). Step 4 moves "a phone approves the new node" onto the phone; until then the passkey
sign-in on the hub's page is that approval.

**Presence.** From the Mac's own object, so nothing new is sent. The relay client pings every 30 s
and the platform answers without waking the object; `getWebSocketAutoResponseTimestamp` gives
the last ping, and the hello time covers the first 30 s. A node is online if its socket is open and
it was heard from within `HUB_OFFLINE_AFTER_S` (default 90), which also catches a socket that
looks open but whose Mac went away. Connect and close are pushed to the hub as well, for step 2's
grace period and `list_changed` (`HUB_GRACE_S`, default 120, read from step 2).

**Trying it locally.** `VALET_HUB_BROWSER=1 HUB_CHROMIUM=<chromium> pnpm exec vitest run
test/hub-browser.test.ts` in `apps/relay` drives the pages in Chromium with a virtual passkey, at
`http://localhost:<port>` (`HUB_ORIGIN`, which only accepts that form).

**Deploying it (needs Nick).** In `wrangler.jsonc`: the `HUB` binding and the `v2` migration are
there. Set `HUB_HOST = "valet.dncr.me"`, add a Workers Custom Domain for `valet.dncr.me`, run
`wrangler secret put HUB_SETUP_SECRET`, deploy, then open `https://valet.dncr.me/sign-up`.

## Step 4 as being built: the account's device list

Nick chose (2026-11-15) to build step 4 before steps 2 and 3, so the hub never lets an agent in
without a grant your phone signed.

**The list is a chain of signed changes** (`packages/core/src/roster.ts`). Each change adds or
removes one device (its id, role, name and three public keys), names the change before it by
hash, and is signed by the approval key of a device already on the list (Face ID or Touch ID). The
first change is a device adding itself. Limits: 32 devices, 512 changes, never zero devices.

- **The hub keeps it and can't change it.** It stores the chain per account, accepts an append
  from a linked Mac (`hub-roster-append`) only if the whole chain still checks (WebCrypto in the
  Worker), and sends the whole chain (`hub-roster`) to every node of the account after a change,
  after a hello and after joining. A change built on an old head is refused as a conflict.
- **Each node trusts only its own check.** It refuses a chain that forks, reorders, drops changes
  or goes back to a head it has already seen (`verifyRoster` with `pinned` and `known`).
- **The Mac starts the list, without re-pairing**
  (`apps/desktop/src/main/core/approvals/roster-keeper.ts`). On an account whose list is empty, the Mac writes the first change (itself,
  with its three keys) and one add for each phone it already paired, all signed under one Touch ID
  prompt ("put this Mac and its iPhones on your Valet account"), and sends them as one
  `hub-roster-append` the hub keeps all together or not at all. Each phone's keys are the ones the
  Mac verified when it paired. After that the Mac keeps the list in step: a phone paired here is
  added, a phone removed in Settings is removed (each one more prompt), and a phone of this Mac's
  that another device took off the list is revoked here too.
- **What the Mac pins.** Only a list whose first change it signed itself: the trusted ledger
  keeps that hash with the latest head and count it saw. A hub can't hand the Mac a list some other
  key started; such a list shows "Another device started your account's device list" and the Mac
  signs nothing on it. Leaving the account forgets the pin, so a fresh start pins again.
- **The Secure Enclave helper checks each change before the prompt**
  (`swift-bridge/Sources/ValetHelperKit/ChannelSigning.swift`): up to 9 at once, all by this Mac,
  for one account, numbered one after another and each naming the hash of the one before. The
  Mac adds itself (with its own keys) only as the very first change, and otherwise adds iPhones
  or removes other devices. It never adds another Mac and never removes itself; the helper writes
  the prompt's reason itself.
- **Settings › Devices** shows the list's state under "Valet account": how many devices it has,
  "Try again" after a cancelled prompt, or why it isn't used.
- **Not yet trusted from the list:** a phone this Mac didn't pair. That comes with step 4c, where
  the iPhone signs in to the hub with the QR shortcut, can sign adds and removes itself, and each
  Mac registers every phone on the list with its own relay object. A Mac joining an account whose
  list another device started waits for that device to add it (also 4c), and a Mac whose keys are
  renewed (only keys made before they worked while locked) needs its entry replaced then too.

Why a chain and not a list re-signed each time: removing a device must not need the device
being removed, and a node that saw a removal must never be shown a list without it again.

## Step 3 as being built: agents' grants

Built in this order: the hub's sign-in for agents and the grant format (3a), then the Mac's part
(3b), then the aggregated MCP (step 2), so no agent is ever served without a signed grant.

- **The hub is an OAuth 2.1 server for MCP clients** (`apps/relay/src/hub/oauth.ts`): metadata for
  `<hub>/mcp`, Dynamic Client Registration (public clients, https or loopback redirects, at most
  100), the code flow with PKCE S256 and resource indicators, codes good once for a minute,
  access tokens for an hour, rotating refresh tokens (a reuse ends everything from that sign-in).
  Tokens are stored as hashes, each tied to the grant that approved it.
- **`/authorize` never decides.** It shows the browser a code and tells every node of the account
  (`hub-consents`). The person approves on a device and types that code there, as for today's
  remote consents. The agent's browser polls and, holding the cookie `/authorize` set, collects
  its code once a grant is in. No sign-in to the hub is needed on that page: the device's
  signature is what counts, and the code ties it to that browser.
- **A grant** (`packages/core/src/hub-grant.ts`, domain `valet/hub-grant/v1`) names the account,
  the sign-in, the agent and its redirect host (claims, shown as such), the scope
  `remote-tools`, and at most 90 days. It is signed by the approval key of a device on the
  account's list. The hub keeps it only after checking the list and the signature with WebCrypto,
  and only for a sign-in still waiting from that agent. Every node hears all grants
  (`hub-grants`) and serves an agent only for one it checked against the list it verified itself.
- **What `remote-tools` gives:** on each Mac, the tools it already lets remote agents use, behind
  its own approvals, pacing and lockdown. Nothing wider. Valet's own admin and authoring tools stay
  per-Mac decisions, as today.
- **The Mac's part (3b)** (`apps/desktop/src/main/core/approvals/hub-agents.ts`). The hub's
  waiting sign-ins appear in the same "Approve a connection" sheet as the Mac's own, marked
  "Through: your Valet account", with the same notification. There are no tools to tick: the
  sheet says what the agent gets instead. The code typed picks the sign-in; approving signs the
  grant with Touch ID (the Secure Enclave helper checks it is this Mac's, for `remote-tools`, for
  at most 90 days, and writes the prompt's reason) and sends it. Grants last 30 days. Declining
  tells the hub. The Mac holds the hub's grants and honours only those that check against the
  device list it verified, and serves agents with them from step 2 (below).
- **Taking access away needs no signature.** The hub can drop a grant (and its tokens), and a Mac
  can stop honouring one; neither can add one.
- **Who signs:** any device on the list. Nick chose whether that includes the Mac's Touch ID or only
  the phone (see the thread); the format allows both.

## Step 2 as built: one MCP address

- **`<hub>/mcp`** (`apps/relay/src/hub/mcp.ts`) takes an access token from the hub's OAuth server
  whose grant the hub still holds, and answers `initialize`, `ping`, `tools/list` and `tools/call`
  itself, as plain JSON. It is stateless towards the agent: no session id and no event stream, so
  `list_changed` is not sent yet (clients that list tools again on their own see changes).
- **Calls use the existing `http-request` framing.** The hub sends each node a POST to its own
  `/mcp`, through that Mac's relay object, with `hub: { grantId }` and no credential. The Mac's
  relay client serves it only if `HubAgents` checks that grant against the device list the Mac
  verified; it then supplies its own token, minted in memory for client `hub-<grant>`, and the
  request goes to the same remote listener, policy, approvals, pacing and audit as any remote
  agent's. Anything else gets a 403 from the Mac. A public request can't set `hub`: the front door
  builds every forwarded request itself.
- **What an agent through the hub gets on a Mac:** every tool that Mac turned on for remote agents,
  at the side effect it had then, and none of Valet's own admin or authoring tools. A grant the
  hub stops sending ends its tokens and sessions on the Mac.
- **Names:** `<node slug>__<the node's tool name>` (for example `studio__woolworths_view_cart`),
  skipping any name that would pass 64 characters. Titles and descriptions name the node.
- **Offline nodes:** online means the Mac's object heard a frame within `HUB_OFFLINE_AFTER_S`
  (default 90). An offline node's tools stay listed for `HUB_GRACE_S` (default 120) after it
  went quiet or closed, and a call fails fast with "<name> is offline, so nothing was sent. Try
  again shortly." After that its tools leave the list until it is back. A call to a name that
  isn't there gets a tool error saying to list the tools again.
- **Towards each node** the hub keeps one MCP session per grant, and the node's last tool list for
  that grant (what an offline node shows during its grace), both in memory only: never stored.
  A node that forgot the session (a restart) gets a new one on the next request.
- **Not yet:** `list_changed` over an event stream, hub-level tools (which nodes are online), and a
  page on the hub to see and revoke grants. Step 5 retires the per-Mac hosts.

## A Mac that started the list goes

Every node trusts only a device list it started itself (until 4c lets a second Mac join one). So
when the person removes, on the hub's page, the Mac whose change was first on the list, the hub
drops the list and every grant signed under it (and those grants' tokens), and tells the other
nodes. The next Mac starts a new list, and agents sign in again. This is how a Mac that lost its
keys, and so came back with a new id, gets going again: remove the old one, link the new one.
Removing needs a recent sign-in; it only takes access away.

## Open, for the building agent to propose (not for Nick unless it changes his goal)

- Storage: D1 vs a Durable Object per account.
- Exact grant format and how nodes fetch and cache the account's device list.
- Whether calls use the existing HTTP framing or a dedicated `tool-call` frame.
- Pricing (D16) and sharing (H5 later) are out of scope.
