# @siteadapter/mcp-server

The MCP endpoint. It exposes every tool the runtime lists, over Streamable HTTP on `127.0.0.1`,
and ships a stdio bridge for clients that can only launch a command.

The runtime is reached only through the `ToolCaller` interface in `src/tool-caller.ts`; this
package never imports `@siteadapter/runtime`.

## Wiring it into the app

```ts
// Reads the port the last launch saved in the bridge config file (mode 0600), listens there with a
// new token, and writes the file back:
const endpoint = await startEndpoint({ caller, configPath: bridgeConfigPath })
// show endpoint.url and endpoint.token to the person for HTTP clients.
// whenever adapters are approved, revoked or changed. One listing for every session; if the
// runtime can't list, it throws SiteAdapterError and no session changes:
const withheld = endpoint.refresh()
// when the person asks for a new token (one may have leaked):
await endpoint.resetToken()
// on quit:
await endpoint.close()
```

### Port and token across launches

The bridge config file keeps the port from one launch to the next; by default the token is new at
each launch. The stdio bridge re-reads the file and follows a new token on its own, so clients
registered through it (the recommended way, below) never notice. Clients registered with the HTTP
URL and a token store both, and must be given the new token after each launch unless they opt in
to keeping it:

- **`stablePort`** (default `true`): listen on the port the config file names. `false` picks a free
  port each launch, which only stdio-bridge clients survive.
- **`tokenRotation`** (default `'every-launch'`): make a new token at each start. `'on-reset'`
  keeps the config file's token until `resetToken()`, for HTTP-native clients that store it.
- **Why a new token each launch.** Listening ports are visible to other local accounts. While the
  app is down, another account can listen on the saved port and collect the token from any client
  that connects (the bridge, reconnecting, included), then let the port go so the app gets it back.
  With `'every-launch'` a token collected that way stops working at the next launch. With
  `'on-reset'` it stays valid, for every tool, until the person resets the token: that is the price
  of the opt-in.
- **The saved port is taken.** The endpoint moves to a free port _and makes a new token_, whatever
  `tokenRotation` says: a client still pointed at the old port sends its token to whatever holds
  that port, so the old token can't be trusted to mean the person's client. HTTP clients need the
  new URL and token; the bridge follows on its own.
- **The config file can't be trusted** (missing, edited, not 0600, not owned by the person, a
  symlink): its token and port are not reused, and the file is rewritten.
- **`resetToken()`** writes the new token to the file first, then switches the endpoint and closes
  every session; if the write fails nothing changes. Overlapping resets run one after another, so
  the file always holds the token the endpoint accepts. `startHttpServer` and `setToken` are the
  lower-level pieces, for a caller that keeps the port and token itself.

Registering with Claude Code through the bridge, which re-reads the config file if the app
restarts under a running client:

```bash
claude mcp add siteadapter -- <repo>/node_modules/.bin/tsx <repo>/packages/mcp-server/src/bridge-cli.ts \
  "$HOME/Library/Application Support/siteadapter/bridge.json"
```

That runs from any working directory, but needs Node 24 on the client's `PATH`. Until the app
bundles the bridge, this is the only way to launch it.

## What the endpoint guarantees

- **Names.** A tool is `<adapter id, - as _>_<tool>`. When two tools map to one name, both are
  withheld, so one adapter can't shadow another's tool. Tools whose input isn't a zod object, or
  whose schemas have no JSON Schema form, are withheld too; `refresh()` returns what was withheld.
- **Annotations.** `readOnlyHint` for `read`; `destructiveHint` for `write` and `irreversible`,
  since MCP reads `false` as "only adds" and a write can remove cart items; `idempotentHint:
  false` for `write` and `irreversible`; and `openWorldHint` always.
- **Titles and descriptions** are the manifest's. An `irreversible` tool's description ends with
  fixed text, never the adapter's: "The person must confirm this action in the siteadapter app
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
  - `needsUser`: the agent is told the person has been asked to act in the siteadapter app, with
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
  `Authorization: Bearer <token>` is required on every request (401), compared in constant
  time. Bodies over 1 MiB are refused. At most 32 sessions are kept; the least recently used goes
  first.
- **Bridge.** It writes nothing but JSON-RPC to stdout. Upstream failures become JSON-RPC errors
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
