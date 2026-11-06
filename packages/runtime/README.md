# @siteadapter/runtime

Runs adapter tools. Plain Node, no Electron, no `@siteadapter/auth-flow`: the browser comes in as a
`SessionDriver` and the login as an injected `AuthRunner`.

## Wiring

```ts
const audit = new AuditLog(join(dataDir, 'audit.jsonl'), systemClock)
const approvals = new ApprovalStore(join(dataDir, 'approvals.json'), audit)
const host = new ToolHost({
  approvals, // ApprovalLookup
  audit, // AuditSink
  prompt, // ConfirmationPrompt: the app's own window, never the MCP client
  authRunner, // (request: AuthRunRequest) => Promise<AuthOutcome>, wrapping auth-flow's runAuthFlow
  markers: new LoginAttemptMarker(join(dataDir, 'login-markers'), systemClock),
  breakerStore: new JsonFileStore(join(dataDir, 'breakers.json')),
  // Optional: clock, sleep, pacingSleep, timeoutMs, validationTimeoutMs, confirmationTimeoutMs,
  // settleTimeoutMs, loginBackoff, diagnostics.
})
host.register({ definition, bundleHash, driver }) // driver: SessionDriver for this adapter's site
await host.listTools() // approved adapters only
await host.call({ adapterId, tool, input, client, callId }) // ToolCallResult

// When the person approves or rejects a bundle in the app; both write their own audit event.
await approvals.approve(adapterId, bundleHash, manifest.version)
await approvals.reject(adapterId, bundleHash, manifest.version)
```

The `authRunner` must call `request.registerForRedaction(secret)` for every secret it resolves,
before disposing it. The runtime keeps a clone until the tool call ends, so the call's output can
still be redacted after the filler has zeroed its own copy.

## Order of checks in `call()`

1. `callId` matches `/^[A-Za-z0-9_-]{1,64}$/`, else `failed tool-input/invalid` with nothing audited.
2. Adapter registered and its exact bundle hash approved, else `failed manifest/not-granted`.
3. Tool declared and implemented (own properties only), else `failed manifest/not-found`.
4. Input parsed with the tool's zod schema, under a deadline (10 s default), else
   `failed tool-input/invalid` or `tool-input/timed-out`.
5. Per-adapter FIFO lock. Approval is checked again once the lock is held.
6. Site circuit breaker open (including state persisted by an earlier run): `blocked` with
   `retryAfterMs`.
7. `irreversible` tool: the person confirms first, under a deadline (5 min default) whose signal
   the prompt receives. Declined, timed out, a prompt error: `declined`; an approval that can't be
   audited: `failed`. The tool's `run()` never starts.
8. `driver.beginRun(policy, onBlocked)` with the manifest's egress, its request surface plus the
   probe's own GET, the tool's side effect as `maxPurpose`, and `limits.requestsPerRun` as the
   ceiling. Only after step 7's approval, `driver.unlockIrreversible()`. If either throws, the tool
   doesn't run (`failed egress/...`).
9. The tool runs with a guarded `ToolContext`, a timeout (2 min default) and an `AbortSignal`.
   Capabilities die when the call returns.
10. Output parsed with the tool's zod schema, under the same parse deadline, else
    `failed tool-output/invalid` or `tool-output/timed-out`; then converted to plain JSON (one
    `JSON.stringify`, so getters and `toJSON` run once; Buffers, typed arrays, cycles and BigInts
    are `tool-output/invalid`), redacted, and checked once more as a whole (`tool-output/internal`
    if anything sensitive is left).

Schemas are adapter code: a `refine`, `transform` or `superRefine` runs whatever the adapter wrote,
and input parsing runs before the confirmation, because the person is shown the parsed input. So
"no tool code before approval" means the tool's `run()`, not its schemas. The deadlines are what
stop a schema from holding a call or the lock.

After a call returns, the adapter's lock and the driver's run stay held until the runtime work the
call started (page operations, `ensure()`, prompts) has settled, up to 30 s by default; only then
does `driver.endRun()` run. So a timed-out call can't keep driving the session under the next one,
or outside its run policy. The next call never joins an earlier call's `ensure()`: if one is still
running past that bound, it gets `failed probe/unavailable`.

**One call per adapter at a time, reads included.** The driver holds one run policy per session, so
calls on one adapter never overlap; calls on different adapters do.

## Results and audit events

`ToolCallResult` is `ok`, `needsUser` (a `NeedsUserReason` code only; the app renders its own
wording), `failed` (stage and error class), `blocked` (with `retryAfterMs`), or `declined`.

A tool ends its run as `needsUser` by throwing `NeedsUserError(reason)`, typically with the reason
`ensure()` returned. A tool that throws anything else after `ensure()` said `needsUser` or `failed`
reports what `ensure()` said. A guard violation or a site block wins over either. A reason outside
`NEEDS_USER_REASONS` becomes `other`.

`tool-called` is audited as soon as the adapter is found, before the approval check, so refused
calls are on record too; a call that can't be audited doesn't run. `tool-finished` follows for
every outcome, with `adapterId`, the outcome (`ok`, `needsUser` with its reason, `failed` with stage
and class, `blocked`, `declined`) and the duration. `confirmation` carries the client. The client
name is stripped of control and format characters and cut to 100 characters once, and that one
value goes to both the audit log and the confirmation prompt.

`ApprovalStore.approve(id, hash, version)` replaces the adapter's previous approval and audits
`adapter-approved` with `previousHash`; approving the hash already approved does nothing.
`reject(id, hash, version)` audits `adapter-rejected` and withdraws that hash's approval, if it had
one. The event is written before the file: an approval that can't be audited doesn't happen.

## Guarded tool page

- `fetch`: `init` is read once into a frozen snapshot (method, string-valued headers, a plain copy
  of `json`), every check runs on the snapshot, and only the snapshot reaches the driver. The URL
  is resolved against `manifest.home` (never the page's current URL), then core's `decideRequest`
  against `egress` and `requests` (which refuses ambiguous paths as `ambiguous-path` and checks
  denied segments after percent-decoding and dropping `;matrix` params). On top of that: a request
  may not exceed its tool's side effect (a `read` tool can't call a `write` endpoint), and
  method-override headers are refused.
- `goto`: https on an egress host; core's `ambiguousPath`; denied segments need an `irreversible`
  tool; a path matching a GET declaration whose purpose outranks the tool's side effect is refused.
  Beyond that, navigation, like `click()`, is left to the driver's run policy.
- Every request counts against `limits.requestsPerRun` and waits for the site's rate budget.
- Violations are sticky: the call fails even if tool code catches the error, and every capability
  refuses from then on. `request-blocked` events (initiator `tool`) carry origin and path only,
  redacted.

## What the driver refuses

The driver reports each request it refuses to `onBlocked`. Each becomes a `request-blocked` audit
event with the driver's initiator and the refusal mapped onto the error vocabulary
(`purpose-exceeded` is `denied-path`, `bad-url` is `invalid`). Identical refusals are recorded once
per call, and at most 50 per call (a `request-blocked-capped` diagnostic says when the cap is hit).

- Initiator `tool` (tool code reaching past the capability API, say a `fetch` inside `evaluate()`),
  or a run over its ceiling from either side: a sticky violation, so the call fails.
- Initiator `page` (the site's own scripts, its analytics, say): recorded only.
- None of them touches the site's breaker. They are our own policy at work, not the site refusing
  us; site blocks are seen in responses (below).

## Site protection

Per site host, shared by every adapter for that host: a `RateBudget` and a `SiteCircuitBreaker`.
Both read `manifest.limits`: `minGapMs` between requests, and a cooldown of `cooldownSeconds`,
doubling for blocks in a row up to `maxCooldownSeconds`. Adapters sharing a host get the most
cautious numbers any of them declares.

Only a block signature trips the breaker: a 429 (`rate-limited`), a 403 HTML page, or Akamai's
"Access Denied … Reference #" page (`blocked-by-site`). Tool code sees that as
`SiteAdapterError('tool-run', cause)`, and a request refused because the breaker is already open
as `tool-run/rate-limited`; either way the call returns `blocked`. Other HTML where JSON was
expected (an error page, a login redirect) is `tool-run/invalid` and leaves the breaker alone.
`breaker-opened` (host, cause, retry time, call) is audited when it trips, and `breaker-closed` at
the first normal answer after a run of blocks.

**Breaker state persists.** Each change is written to the injected `JsonStore` (`JsonFileStore`,
replaced atomically), so a restart straight after a block doesn't hit the site again; the run of
blocks carries over too, so the next block doubles. The file is read once, before the first call
sends anything. A persisted retry time further out than `maxCooldownSeconds` is cut back to it.

**A breaker file that can't be read or doesn't parse fails closed:** every host's breaker opens for
its `cooldownSeconds`, counted from when the file was read, and a `breaker-state-unreadable`
diagnostic is raised. The corrupt file is left alone until the next real breaker change rewrites
it, and that rewrite includes the fail-closed holds. A failed write keeps the breaker in memory and
raises `breaker-state-write-failed`.

## Session

`ctx.session.ensure()` probes and logs in only on an explicit logged-out answer:

- A fetch probe: the expected status with the wrong value, or one of the probe's
  `loggedOutStatuses` (default `[401]`). Any other status, or HTML where the probe expected JSON, is
  `failed probe/unavailable`; a block signature is a block, even if its status is listed as logged
  out.
- A cookie probe: `driver.cookieNames(cookieDomains)` lacks the named cookie. It never touches the
  site.

No login starts while the site's breaker is open.

Logins are rationed:

- At most one login per call. Later `ensure()`s in the call get that login's outcome; if the
  login worked and the session drops again, `failed probe/not-logged-in`.
- Before the `AuthRunner` runs, the marker is set and fsynced. An `AuthRunner` that throws (a crash,
  an abort) leaves it set, and every later `ensure()` gets `needsUser login-attempt-pending` until
  the person clears it.
- After a classified outcome, `login-finished` is audited (with the `needsUser` reason, or outcome
  `blocked`) and a block trips the breaker, and only then is the marker cleared or replaced by a
  hold. `auth-failed`, or a login after which the probe still says logged out, holds until the
  person clears it. Any other failure (including `needsUser` and a failed handoff) holds for a
  backoff: 5 min, doubling per failure in a row, up to 6 h (`loginBackoff`). While held, `ensure()`
  returns `needsUser login-required`. A login that works clears the hold.
- A marker store that can't be written fails as `login/login-in-progress`.

Concurrent `ensure()`s from one call share one login.

## Redaction

Output, and every `request-blocked` target, is checked against:

- the session values `driver.sessionSecrets(cookieDomains, storage)` reports (cookie values and
  handed-off storage values), collected at the start of the call, after each `ensure()` and before
  the output leaves; values shorter than 8 characters are ignored;
- clones of the secrets this call's login registered, disposed when the call ends. A secret
  registered after it was disposed (or something that isn't a `SecretValue`) can't be matched, so
  everything then counts as sensitive and the output is withheld (`tool-output/internal`).

Matching is exact substring matching, and any string that matches is replaced whole. For
`request-blocked` targets, session values also match case-insensitively, because URL parsing
lower-cases hostnames. Secrets can only be matched exactly without revealing them, so for the
guarded page the target is also redacted when what tool code passed contains a secret as written.
A secret lower-cased into a hostname by the driver's own parsing is not caught.
