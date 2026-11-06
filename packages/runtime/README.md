# @siteadapter/runtime

Runs adapter tools. Plain Node, no Electron, no `@siteadapter/auth-flow`: the browser comes in as a
`SessionDriver` and the login as an injected `AuthRunner`.

## Wiring

```ts
const secrets = new SecretRedactionSet() // the auth flow gets rememberSecret() through AuthRunRequest
const host = new ToolHost({
  approvals: new ApprovalStore(join(dataDir, 'approvals.json')),
  audit: new AuditLog(join(dataDir, 'audit.jsonl'), systemClock),
  markers: new LoginAttemptMarker(join(dataDir, 'login-markers'), systemClock),
  prompt, // ConfirmationPrompt: the app's own window, never the MCP client
  authRunner, // (request: AuthRunRequest) => Promise<AuthOutcome>, from auth-flow
  secrets,
})
host.register({ definition, bundleHash, driver })
await host.listTools() // approved adapters only
await host.call({ adapterId, tool, input, client, callId }) // ToolCallResult
```

## Order of checks in `call()`

1. Adapter registered and its exact bundle hash approved, else `failed manifest/not-granted`.
2. Tool declared and implemented (own properties only), else `failed manifest/not-found`.
3. Input parsed with the tool's zod schema, else `failed tool-input/invalid`.
4. Per-adapter FIFO lock. Approval is checked again once the lock is held.
5. Site circuit breaker open: `blocked` with `retryAfterMs`.
6. `irreversible` tool: the person confirms first. Declined, timed out, a prompt error, or an
   approval that can't be audited: `declined` (or `failed`), and no tool code runs.
7. The tool runs with a guarded `ToolContext`, a timeout (2 min default) and an `AbortSignal`.
   Capabilities die when the call returns.
8. Output parsed with the tool's zod schema, else `failed tool-output/invalid`; then redacted.

`tool-called` is audited as soon as the adapter is found, before the approval check, so refused
calls are on record too; a call that can't be audited doesn't run. `tool-finished` follows for
every outcome (`blocked` and `declined` are recorded as `failed` with `tool-run/blocked-by-site`
and `confirm/declined`, since core's event has no such outcomes).

## Guarded tool page

- `fetch`: URL resolved against `manifest.home` (never the page's current URL), then
  `decideRequest` against `egress` and `requests`. On top of core: denied segments are also
  checked after percent-decoding and dropping `;matrix` params; a request may not exceed its
  tool's side effect (a `read` tool can't call a `write` endpoint); method-override headers are
  refused.
- `goto`: https on an egress host; denied segments need an `irreversible` tool.
- Every request counts against `limits.requestsPerRun` and waits for the site's rate budget.
- Violations are sticky: the call fails even if tool code catches the error, and every capability
  refuses from then on. `request-blocked` audit events carry origin and path only, redacted.

## Site protection

Per site host, shared by every adapter for that host: a `RateBudget` (2 s minimum gap by default)
and a `SiteCircuitBreaker` (10 min cooldown, doubling to 2 h). A 403 HTML response, or HTML where
JSON was expected, trips it. Inside a running tool that surfaces as
`SiteAdapterError('tool-run', 'blocked-by-site')`; the call returns `blocked`.

## Session

`ctx.session.ensure()` probes (fetch probes only; cookie probes are reported via diagnostics and
treated as logged out), and if logged out: refuse with `needsUser` if the login marker is set;
set and fsync the marker; run the `AuthRunner`; hand off cookies and storage; clear the marker;
re-probe. An `AuthRunner` that throws leaves the marker set. Concurrent `ensure()`s share one
login.
