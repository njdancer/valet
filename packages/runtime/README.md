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

1. `callId` matches `/^[A-Za-z0-9_-]{1,64}$/`, else `failed tool-input/invalid` with nothing audited.
2. Adapter registered and its exact bundle hash approved, else `failed manifest/not-granted`.
3. Tool declared and implemented (own properties only), else `failed manifest/not-found`.
4. Input parsed with the tool's zod schema, under a deadline (10 s default), else
   `failed tool-input/invalid` or `tool-input/timed-out`.
5. Per-adapter FIFO lock. Approval is checked again once the lock is held.
6. Site circuit breaker open: `blocked` with `retryAfterMs`.
7. `irreversible` tool: the person confirms first, under a deadline (5 min default) whose signal
   the prompt receives. Declined, timed out, a prompt error, or an approval that can't be audited:
   `declined` (or `failed`), and the tool's `run()` never starts.
8. The tool runs with a guarded `ToolContext`, a timeout (2 min default) and an `AbortSignal`.
   Capabilities die when the call returns.
9. Output parsed with the tool's zod schema, under the same parse deadline, else
   `failed tool-output/invalid` or `tool-output/timed-out`; then converted to plain JSON (one
   `JSON.stringify`, so getters and `toJSON` run once; Buffers, typed arrays, cycles and BigInts
   are `tool-output/invalid`), redacted, and checked once more as a whole (`tool-output/internal`
   if anything sensitive is left).

Schemas are adapter code: a `refine`, `transform` or `superRefine` runs whatever the adapter wrote,
and input parsing runs before the confirmation, because the person is shown the parsed input. So
"no tool code before approval" means the tool's `run()`, not its schemas. The deadlines are what
stop a schema from holding a call or the lock.

After a call returns, the adapter's lock stays held until the runtime work the call started (page
operations, `ensure()`, prompts) has settled, up to 30 s by default, so a timed-out call can't keep
driving the session under the next one. The next call never joins an earlier call's `ensure()`:
if one is still running past that bound, it gets `failed probe/unavailable`.

`tool-called` is audited as soon as the adapter is found, before the approval check, so refused
calls are on record too; a call that can't be audited doesn't run. `tool-finished` follows for
every outcome (`blocked` and `declined` are recorded as `failed` with `tool-run/blocked-by-site`
and `confirm/declined`, since core's event has no such outcomes). The client name is stripped of
control and format characters and cut to 100 characters once, and that one value goes to both the
audit log and the confirmation prompt.

## Guarded tool page

- `fetch`: `init` is read once into a frozen snapshot (method, string-valued headers, a plain copy
  of `json`), every check runs on the snapshot, and only the snapshot reaches the driver. The URL
  is resolved against `manifest.home` (never the page's current URL), then `decideRequest` against
  `egress` and `requests`. On top of core: a path with `%2F`, `%5C`, `%00` or a backslash in a
  segment, or a segment that decodes to `.` or `..`, is `undeclared-request`; denied segments are
  also checked after percent-decoding, dropping `;matrix` params and splitting on decoded
  backslashes; a request may not exceed its tool's side effect (a `read` tool can't call a `write`
  endpoint); method-override headers are refused.
- `goto`: https on an egress host; the same ambiguous-path refusal; denied segments need an
  `irreversible` tool; a path matching a GET declaration whose purpose outranks the tool's side
  effect is refused. Otherwise navigation, like `click()`, is not checked against the request
  surface: a read tool can still navigate to an undeclared page that changes state when loaded.
- Every request counts against `limits.requestsPerRun` and waits for the site's rate budget.
- Violations are sticky: the call fails even if tool code catches the error, and every capability
  refuses from then on. `request-blocked` audit events carry origin and path only, redacted.

## Site protection

Per site host, shared by every adapter for that host: a `RateBudget` (2 s minimum gap by default)
and a `SiteCircuitBreaker` (10 min cooldown, doubling to 2 h). Only a block signature trips it: a
429, a 403 HTML page, or Akamai's "Access Denied … Reference #" page. Inside a running tool that
surfaces as `SiteAdapterError('tool-run', 'blocked-by-site')`; the call returns `blocked`. Other
HTML where JSON was expected (an error page, a login redirect) is `tool-run/invalid` and leaves the
breaker alone.

## Session

`ctx.session.ensure()` probes and logs in only on an explicit logged-out answer: the expected
status with the wrong value, or a 401. Any other status, or HTML where the probe expected JSON, is
`failed probe/unavailable` (a 429 is a block). Cookie probes aren't supported yet: they are
reported via diagnostics and fail as `probe/unavailable`, never logging in.

Logins are rationed:

- At most one login per call. Later `ensure()`s in the call get that login's outcome; if the
  login worked and the session drops again, `failed probe/not-logged-in`.
- Before the `AuthRunner` runs, the marker is set and fsynced. An `AuthRunner` that throws (a crash,
  an abort) leaves it set, and every later login is refused with `needsUser` until the person
  clears it.
- After a classified outcome, `login-finished` is audited and a block trips the breaker, and only
  then is the marker cleared or replaced by a hold. `auth-failed`, or a login after which the
  probe still says logged out, holds until the person clears it. Any other failure (including
  `needsUser` and a failed handoff) holds for a backoff: 5 min, doubling per failure in a row, up
  to 6 h (`loginBackoff`). A login that works clears the hold.

Concurrent `ensure()`s from one call share one login.
