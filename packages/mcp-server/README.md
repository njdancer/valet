# @valet/mcp-server

The MCP endpoint. It exposes every tool the runtime lists, over Streamable HTTP on `127.0.0.1`,
and ships a stdio bridge for clients that can only launch a command.

The runtime is reached only through the `ToolCaller` interface in `src/tool-caller.ts`; this
package never imports `@valet/runtime`.

## Wiring it into the app

```ts
// One token per client (D42). Each client's bridge config file (mode 0600) holds the endpoint URL
// and that client's token; the port the files name is reused at the next launch:
const endpoint = await startEndpoint({
  caller,
  clients: [{ id: 'c_0123456789abcdef', configPath: `${dir}/client-configs/c_0123456789abcdef.json` }],
})
// whenever adapters are approved, revoked or changed. One listing for every session; if the
// runtime can't list, it throws ValetError and no session changes:
const withheld = endpoint.refresh()
// the person adds a client: a new token, written to its file:
await endpoint.addClient({ id, configPath })
// "Reset access" for one client (its token may have leaked): a new token for it alone, its sessions end:
await endpoint.resetClient(id)
// revoking a client: its token is refused, its sessions end and its file is deleted:
await endpoint.removeClient(id)
// the sessions open now, which client each belongs to, and how each arrived:
endpoint.sessions() // { total, bridge, http, sessions: [{ identity, transport, client }] }
// on quit:
await endpoint.close()
```

### Who is calling: the authenticate hook

`startHttpServer` runs one Streamable HTTP handler and one MCP server per session, and takes an
`authenticate(request, listener)` hook (`src/auth.ts`). The hook names the client behind a request,
as a `ClientIdentity` of `{ origin: 'local' | 'remote', clientId }`, or refuses it with 401 or 403.
Nothing else in the handler knows how a client proved who it is, so a listener is the handler plus
a hook (D41):

- **Local** (`localAuthenticator(tokens)`, `src/local-auth.ts`): the Host must be
  `127.0.0.1:<port>` and any Origin a localhost one (403 otherwise), then `Authorization: Bearer`
  must carry a token in the `ClientTokens` table (401 otherwise). The table keeps only SHA-256
  hashes, one per client, and a token names exactly one client.
- **Remote** (after M3, [relay.md](../../docs/relay.md)): the same handler, bound wherever Funnel
  delivers, with a hook that checks OAuth access tokens and returns `origin: 'remote'`.

A session answers only the identity that opened it: another client's token on that session id gets
404, as if it didn't exist. Every call carries the identity to the `ToolCaller` as
`ToolCall.identity`; `identityLabel()` gives the audit log's `local:<id>` or `remote:<id>`, recorded
as `tool-called.clientId` beside the self-reported name (C12). `endSessions(match)` closes the
sessions of the clients that match, for when a hook stops accepting a credential.

### Port and tokens across launches

The clients' config files keep the port from one launch to the next; by default every token is new
at each launch. The stdio bridge re-reads its file and follows a new token on its own, so clients
registered through it (the recommended way, below) never notice. Clients registered with the HTTP
URL and a token store both, and must be given the new token after each launch unless they opt in
to keeping it:

- **`stablePort`** (default `true`): listen on the port the first trustworthy client file names.
  `false` picks a free port each launch, which only stdio-bridge clients survive.
- **`tokenRotation`** (default `'every-launch'`): make new tokens at each start. `'on-reset'`
  keeps each client's token from its file until `resetClient()`, for HTTP-native clients that store
  it.
- **Why new tokens each launch.** Listening ports are visible to other local accounts. While the
  app is down, another account can listen on the saved port and collect the token from any client
  that connects (the bridge, reconnecting, included), then let the port go so the app gets it back.
  With `'every-launch'` a token collected that way stops working at the next launch. With
  `'on-reset'` it stays valid, for every tool, until the person resets that client: the price of
  the opt-in.
- **The saved port is taken.** The endpoint moves to a free port _and makes new tokens for every
  client_, whatever `tokenRotation` says: a client still pointed at the old port sends its token to
  whatever holds that port, so the old tokens can't be trusted to mean the person's clients.
- **A client's file can't be trusted** (missing, edited, not 0600, not owned by the person, a
  symlink, or holding a token another client's file holds): its token and port are not reused, and
  the file is rewritten.
- **`resetClient()` and `addClient()`** write the new token to the file first, then switch the
  endpoint and close that client's sessions; if the write fails nothing changes. Changes run one
  after another, so each file always holds the token the endpoint accepts.

Registering with Claude Code through the bridge, which re-reads the client's config file if the app
restarts under a running client (the app's Clients screen gives the exact line for each client):

```bash
claude mcp add valet -- <repo>/node_modules/.bin/tsx <repo>/packages/mcp-server/src/bridge-cli.ts \
  "$HOME/Library/Application Support/valet/client-configs/<client id>.json"
```

That runs from any working directory, but needs Node 24 on the client's `PATH`. Until the app
bundles the bridge, this is the only way to launch it.

## Live sessions and their transport

`sessions()` on the running server, and on what `startEndpoint` returns (a
`SessionReportingEndpoint`, which extends `RunningEndpoint`), returns the open sessions:
`{ total, bridge, http, sessions }`, where each session is `{ identity, transport, client }`, least
recently used first. `client` is the name from the client's `initialize`, cleaned as for the
audit log, or `unknown` until it is known. Session ids are never shown. Pass
`onSessionsChanged(sessions)` in the options to hear when a session opens, learns its client's
name, or closes (evicted, its client's access reset or revoked, or closed by the client). A listener that throws is
ignored.

`transport` is `'stdio-bridge'` or `'http'`. The bridge sends `x-valet-transport:
stdio-bridge` on every request (`TRANSPORT_HEADER`, `BRIDGE_TRANSPORT`). The endpoint reads it only
on the `initialize` that opens a session, and only that exact value counts; the label then stays
with the session. Every call passes it to the runtime as `ToolCall.transport`.

**It is a label, not a permission.** Any local client that has a token can send the same header.
So nothing depends on it: the token, Host and Origin checks, the tools listed, their
descriptions and every result are the same either way. A header sent without the token opens
nothing.

## What the endpoint guarantees

- **Names.** A tool is `<adapter id, - as _>_<tool>`. When two tools map to one name, both are
  withheld, so one adapter can't shadow another's tool. Tools whose input isn't a zod object, or
  whose schemas have no JSON Schema form, are withheld too; `refresh()` returns what was withheld.
- **Annotations.** `readOnlyHint` for `read`; `destructiveHint` for `write` and `irreversible`,
  since MCP reads `false` as "only adds" and a write can remove cart items; `idempotentHint:
  false` for `write` and `irreversible`; and `openWorldHint` always.
- **Titles and descriptions** are the manifest's. An `irreversible` tool's description ends with
  fixed text, never the adapter's: "The person must confirm this action in the Valet app
  before it runs. You cannot confirm it for them."
- **Results.** Only `ok` output reaches the client, and only after it validates against the
  tool's output schema. What is sent is the parsed value, so keys the schema doesn't declare are
  dropped at every level (a schema that itself passes anything, such as `z.record()` or
  `z.unknown()`, still does). Every other outcome has fixed text, with codes from core's
  vocabularies (anything outside them is replaced, with `tool-run: internal` or `other`):
  - `failed`: a tool error with stage and error class. An exception from the runtime never has
    its message sent; a thrown `NeedsUserError` is treated as `needsUser`.
  - `blocked`: a tool error with stage, class (`blocked-by-site` or `rate-limited`) and whole
    seconds to wait, at least 1. A blocked outcome with any other class is reported as `failed`,
    with no wait: a guard's refusal never passes with time, so the agent isn't told to retry it.
  - `declined`: a tool error, `confirm: declined`, when the person said no or didn't answer.
  - `needsUser`: the agent is told the person has been asked to act in the Valet app, with
    the reason code only (a manifest's note is shown in the app, never sent). It is not an error,
    except for tools that declare an output schema: MCP requires every non-error result of those to
    carry matching structured content, and the SDK on both ends rejects one that doesn't, so for
    them it is sent flagged as an error with the same text.
- **Audit inputs.** Each call carries the client's self-reported name from `initialize`, with
  control characters removed and capped at 100 characters, plus a fresh call id.
- **HTTP.** The Host header must be `127.0.0.1:<port>`, and any Origin must be a localhost
  origin (DNS-rebinding protection, answered 403). Register HTTP-native clients with the
  `127.0.0.1` URL `endpoint.url` reports, never `localhost`: Node resolves `localhost` to `::1`
  first, where the endpoint isn't listening and another local account could be, and would be
  handed the token. Requests that say `localhost` are refused so that URL never seems to work. Then
  `Authorization: Bearer <token>` with a client's token is required on every request (401), looked
  up by its SHA-256. Bodies over 1 MiB are refused. At most 32 sessions are kept; the least recently used goes
  first.
- **Bridge.** It labels itself with `x-valet-transport: stdio-bridge` (see above). It
  writes nothing but JSON-RPC to stdout. Upstream failures become JSON-RPC errors
  with fixed text. Every client request gets exactly one answer: if the app quits or restarts
  mid-call, or the connection resets, the call is answered at once with a fixed error instead of
  waiting out the client's own timeout, and a late answer is dropped. A request the client
  cancelled gets no answer from the bridge. Its one timer (the reconnect timeout) is injected as
  `schedule`. The config file must be a regular file (not a symlink), mode 0600, owned by this
  user, and name `http://127.0.0.1:<port>/mcp`, so an edited file can't send the token elsewhere.
- **Errors about local files** use stage `config`: `not-found`, `insecure-file` (a symlink, a
  non-regular file, another owner, or readable or writable by others), `invalid` (content that
  isn't a token, or isn't the config's exact shape) or `unavailable` (can't be read or written, or
  the port can't be bound).
