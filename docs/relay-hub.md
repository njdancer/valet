# The relay as a hub: one MCP address for all your nodes

Status: **brief, not built.** Agreed with Nick in the project thread on 2026-11-15/16. It
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

| #   | Question                         | Answer                                                                                                                                                                                                                                                                                                       |
| --- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| H1  | How you sign in                  | **D79**: Valet accounts with login and 2FA. Scanning a QR code with a signed-in phone is a shortcut for signing in (like Discord's), not an extra step. No separate device-approval step. 2FA by passkey or authenticator app, never SMS (proposed with D79, not separately confirmed).                       |
| H2  | Who authorises an agent          | **You approve once on your phone; nodes check it.** The phone signs the grant (agent, tools or scope, expiry) with its device approval key. The hub stores and carries it; each node verifies the signature against your account's device list before serving. The hub can't grant an agent access by itself. |
| H3  | The same site on two nodes       | **Scoped to the node.** Each node's tools are listed separately and name the node; nothing is merged or routed by preference.                                                                                                                                                                                 |
| H4  | A node that goes offline         | **Its tools disappear, after a grace period.** See [Offline nodes](#offline-nodes).                                                                                                                                                                                                                         |
| H5  | Whose nodes                      | **Just Nick for now.** One account, his nodes. Design the data model so sharing could come later, but build none of it.                                                                                                                                                                                     |
| H6  | What goes through the hub        | **Everything**: site tools and Valet's admin and authoring tools, each scoped to its node and still behind that node's own approvals. Phones pair with the **account**, but every device keeps its own keys (below).                                                                                          |
| H7  | Domain                           | **`valet.dncr.me`** on Nick's Cloudflare zone for now; move to a dedicated domain later. One host, so no per-Mac wildcard certificate is needed.                                                                                                                                                             |

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

## Open, for the building agent to propose (not for Nick unless it changes his goal)

- Storage: D1 vs a Durable Object per account.
- Exact grant format and how nodes fetch and cache the account's device list.
- Whether calls use the existing HTTP framing or a dedicated `tool-call` frame.
- Pricing (D16) and sharing (H5 later) are out of scope.
