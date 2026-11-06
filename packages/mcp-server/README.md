# @siteadapter/mcp-server

The MCP endpoint. It exposes every tool the runtime lists, over Streamable HTTP on `127.0.0.1`,
and ships a stdio bridge for clients that can only launch a command.

The runtime is reached only through the `ToolCaller` interface in `src/tool-caller.ts`; this
package never imports `@siteadapter/runtime`.

## Wiring it into the app

```ts
const token = generateToken()
const endpoint = await startHttpServer({ caller, token }) // port 0: a free port each launch
await writeBridgeConfig(bridgeConfigPath, { url: endpoint.url, token }) // mode 0600
// whenever adapters are approved, revoked or changed:
endpoint.refresh()
// on quit:
await endpoint.close()
```

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
- **Annotations.** `readOnlyHint` for `read`, `destructiveHint` only for `irreversible`,
  `idempotentHint: false` for `write` and `irreversible`, and `openWorldHint` always.
- **Results.** Only `ok` output reaches the client, and only after it validates against the
  tool's output schema. Every other outcome is a tool error with fixed text: `failed` gives stage
  and error class (replaced with `tool-run: internal` if either is outside core's vocabulary), and
  an exception from the runtime never has its message sent.
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
  with fixed text. The config file must be mode 0600, owned by this user, and name
  `http://127.0.0.1:<port>/mcp`, so an edited file can't send the token elsewhere.
