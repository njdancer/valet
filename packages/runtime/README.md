# @valet/runtime

Runs adapter tools. Plain Node, no Electron, no `@valet/auth-flow`: the browser comes in as a
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
  budgetStore: new JsonFileStore(join(dataDir, 'budgets.json')), // optional; see "Site protection"
  // Optional: clock, sleep, pacingSleep, timeoutMs, validationTimeoutMs, confirmationTimeoutMs,
  // settleTimeoutMs, queueWaitMs, loginBackoff, diagnostics.
})
host.register({ definition, bundleHash, driver }) // driver: SessionDriver for this adapter's site
await host.listTools() // approved adapters only
await host.call({ adapterId, tool, input, client, callId, signal, transport }) // ToolCallResult
await host.runLoginStep(adapterId, async (ctx) => { ... }, { waitMs, timeoutMs, signal })
await host.siteHealth() // SiteHealthSnapshot[]

// When the person approves or rejects a bundle in the app; both write their own audit event.
await approvals.approve(adapterId, bundleHash, manifest.version)
await approvals.reject(adapterId, bundleHash, manifest.version)
```

The `authRunner` must call `request.registerForRedaction(secret)` for every secret it resolves,
before disposing it. The runtime keeps a clone until the next successful login, so output can still
be redacted after the filler has zeroed its own copy, in that call and in later ones. Its `ok`
outcome may say how many secrets it filled (`filledSecrets`); if that is more than were registered,
every output is withheld (`tool-output/internal`) until a login registers them all.

The `authRunner` owns the `login-started` and `login-finished` audit events (auth-flow's
`runAuthFlow` writes them); the runtime writes neither, so one login is one pair in the log. Its
outcome has auth-flow's shape, so `runAuthFlow`'s result can be passed straight through, including
`blocked` with `errorClass` `blocked-by-site` or `rate-limited`.

## Order of checks in `call()`

`signal` and `transport` are optional. An aborted `signal` ends the call `failed tool-run/aborted`
at whichever step it reaches; see "Cancelling a call" below.

1. `callId` matches `/^[A-Za-z0-9_-]{1,64}$/`, else `failed tool-input/invalid` with nothing audited.
2. Adapter registered and its exact bundle hash approved, else `failed manifest/not-granted`.
3. Tool declared and implemented (own properties only), else `failed manifest/not-found`.
4. Input parsed with the tool's zod schema, under a deadline (10 s default), else
   `failed tool-input/invalid` or `tool-input/timed-out`.
5. Per-adapter FIFO lock, waited for at most `queueWaitMs` (30 s default), else `busy` with
   `ahead` (the calls still in front, at least 1) and `retryAfterMs`. A call that finds so many in
   front that one `minGapMs` each would use up the wait is answered `busy` at once without joining
   (three in front at Woolworths' 10 s gap). Either way it never started and sent nothing; it is
   audited `failed tool-run/busy`. `retryAfterMs` is a guess, one gap per call in front, kept
   between 5 s and 60 s. Approval is checked again once the lock is held.
6. Site circuit breaker open (including state persisted by an earlier run): `blocked` with
   `retryAfterMs`.
7. `irreversible` tool: the person confirms first, under a deadline (5 min default) whose signal
   the prompt receives. Declined, timed out, a prompt error: `declined`; an approval that can't be
   audited: `failed`. The tool's `run()` never starts.

   `ctx.confirm(action)` (C4) names the declared requests the tool will make on a yes and may add
   a note. The runtime swaps each for the manifest's own declaration and asks with those; one that
   isn't declared, or whose purpose outranks the tool's side effect, or a malformed action, is
   refused without asking (`failed confirm/undeclared-request` or `confirm/invalid`), and the
   refusal sticks even if tool code catches it. A yes unlocks nothing.
8. The session values (`driver.sessionSecrets`) are collected, so that refusals the driver reports
   while the tool page opens are redacted; if that fails, `failed tool-run/internal`. Then
   `driver.beginRun(policy, onBlocked)` with the manifest's egress, its request surface plus the
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

## Cancelling a call

`ToolCallRequest.signal` is the caller's `AbortSignal`, for an MCP client that cancels or goes away.
Every case ends `failed tool-run/aborted`, audited as `tool-finished` like any other outcome:

- Already aborted: nothing runs and the driver isn't touched.
- Aborted while waiting for the adapter's lock: the call leaves the queue. Its turn still comes,
  and it hands the lock straight on, so calls behind it keep their order.
- Aborted during the irreversible confirmation: the prompt's signal aborts and the answer is
  recorded as `declined`. A `yes` that lands after the abort doesn't run the tool either.
- The same holds for a `ctx.confirm()` and for a call that times out during one. The answer is
  audited as `declined` the moment the call's signal aborts, whether or not the prompt has
  settled. So the app should close its prompt when the prompt's signal aborts, not when the
  `confirmation` audit event arrives.
- Aborted while the tool runs: the tool's own `ctx.signal` aborts, the call returns at once, and
  the lock and the driver's run stay held until the runtime work the call started has settled, as
  after a timeout. A `ctx.confirm()` in progress answers no.
- A login the call started gets the same abort through `AuthRunRequest.signal`. A runner that
  stops part-way leaves the attempt marker set, so the next login waits for the person
  (`login-attempt-pending`), as after a crash.

A value that isn't an `AbortSignal` is ignored.

## The client's transport

`ToolCallRequest.transport` is `'stdio-bridge'` or `'http'`: how the client reached the MCP
endpoint. The runtime passes it to `ConfirmationRequest.transport`, for both kinds of
confirmation, so the prompt can say which way the client came in. Any other value is dropped.

It is a label, not a permission. The bridge names itself, so any local client could claim to be
it. Nothing the runtime decides depends on it, and core's audit events don't carry it yet.

## Login steps the person drives

`runLoginStep(adapterId, step, options)` runs the app's own work on an adapter's login (opening
the login window, finishing a hand-off) under the protections a tool call gets:

1. The adapter is registered and its exact hash approved, else `manifest/not-granted`. The step
   is checked again once it holds the lock.
2. It takes the adapter's lock, in turn behind running calls and their settling. Calls that
   arrive later wait for it. It waits at most `waitMs` (default 30 s), else `login/timed-out`.
3. The site's breaker must be closed, persisted state included, else `login/rate-limited`.
4. It waits for one slot of the site's rate budget (`minGapMs`, paced like a tool request), and
   checks the breaker again, since another adapter on the host may have been blocked meanwhile.
5. `step(ctx)` runs under `timeoutMs` (default the tool timeout). On timeout, `login/timed-out`,
   and the lock stays held until the step settles, up to the settle bound.

`ctx` has:

- `signal`, which aborts on the deadline, on `options.signal`, or when the step returns;
- `pace()`, to call before each further request the step makes (a navigation, a form post). It
  takes another budget slot and refuses with `login/rate-limited` while the breaker is open, or
  `login/aborted` once `signal` has aborted;
- `reportBlocked(cause)`, for a step that lands on the block page or gets a 429. It opens the
  site's breaker with `callId: null`, so `breaker-opened` is audited and later calls fail fast.

`waitMs` and `timeoutMs` must be finite numbers above zero. Anything else (NaN, Infinity, a
negative number, a string) fails with `config/invalid` before the lock is taken, since an unbounded
step would hold the adapter's lock for good.

`options.signal` gives up the wait, or stops waiting for the step: `login/aborted`. Whatever the
step throws is passed on unchanged, since it is the app's own code. The runtime writes no audit
event of its own for a step, and doesn't touch the login marker: the app owns both.

## Site health

`siteHealth()` returns one `SiteHealthSnapshot` per registered site host, in registration order,
after loading the persisted breaker state. It reads only: no budget slot is taken and nothing is
written. Times are epoch milliseconds from the runtime's clock.

- `host` and `adapterIds`: every registered adapter on the host, approved or not.
- `breaker` (`open` or `closed`), `retryAt` (while open) and `retryAfterMs`.
- `cooldownMs`: the cooldown the current run of blocks applied, 0 when there is none.
  `nextCooldownMs`: the cooldown the next block would start, after doubling, within the maximum.
- `budget.minGapMs` (the most cautious gap any adapter on the host declares) and `budget.waitMs`
  (how long a request asking now would wait).

The cause of the last block isn't kept here; it is in the `breaker-opened` audit event.
`SiteCircuitBreaker.status()` and `RateBudget.waitMs()` are the per-site views it is built from.

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
value goes to both the audit log and the confirmation prompt, with the transport when the call
gave one.

`ApprovalStore.approve(id, hash, version)` replaces the adapter's previous approval and audits
`adapter-approved` with `previousHash`; approving the hash already approved does nothing.
`reject(id, hash, version)` audits `adapter-rejected` and withdraws that hash's approval, if it had
one. The event is written before the file: an approval that can't be audited doesn't happen.

## Verifying the audit log

`pnpm valet:verify-audit [--head <hash>] [path]` (AC14) runs `verifyAuditLog` over the whole file:
every record's sequence number, back-link and hash. With no path it checks the release app's log,
`~/Library/Application Support/Valet/audit.jsonl`; a relative path is taken from where you ran
`pnpm`. It prints `ok: <n> records, head <hash>` and exits 0, or names the first bad line, echoes
it (cut to 400 characters) and exits 1; bad usage exits 2. A missing file is an error here, not an
empty log.

An edited byte, a deleted, moved or swapped line, or a file cut off mid-line always fails. Records
removed cleanly from the end leave a shorter valid chain, so pass `--head` with a head hash noted
earlier (from a previous run, or the control panel) to catch that too. The same entry point
(`src/verify-audit-cli.ts`) is what a command inside the packaged app's `Contents/MacOS` will run.

## Tool code in its own process

`RegisteredAdapter.isolation` (`{ script, start }`) runs the adapter's tool code in a process of
its own instead of calling `run()` here. The app sets it for every built-in adapter; tests that
leave it out run tool code in process, with the same guards.

- **The script.** `buildToolScript(entry)` (`@valet/runtime/tool-script`, build time only) bundles a
  module that exports `tools` into one IIFE. `@valet/core` resolves to its `tool-code` entry, and an
  import of a Node built-in or `electron` fails the build.
- **One process per call.** `start()` gives a fresh `ToolChannel`; `runIsolated` sends it the
  script and the run, and kills it when the call ends however it ends: done, thrown, timed out,
  aborted, or when the process breaks the protocol. A process that exits first ends the call
  `failed tool-run/internal`.
- **The context.** `serveToolRuns` (`@valet/runtime/tool-worker`, the process side) evaluates the
  script in a fresh `node:vm` context with string compilation and wasm off, and without
  `SharedArrayBuffer`, `Atomics`, `WebAssembly` or `console`. The context holds no host object:
  only strings cross, so no constructor chain leads out to the host's `Function`. Its `ToolContext`
  is built from messages; `currentUrl()` is the page's URL as of the last reply.
- **The channel is untrusted.** Every message must be plain JSON within `MAX_MESSAGE_CHARS`, a
  capability call must name one of `CAPABILITIES`, ids can't repeat, and at most `MAX_IN_FLIGHT`
  calls may wait at once. Anything else ends the call `failed tool-run/invalid`. Thrown errors
  cross as a stage and class or a needsUser reason from the fixed vocabularies, nothing else.
- **Each capability call is answered by the same guarded context** an in-process tool gets, so the
  guards, budget, breaker, C4 checks, redaction and audit are unchanged. Input and output are
  still validated here with the definition's schemas.
- **Not a sandbox.** `node:vm` is not a security boundary and the app's utility process is a full
  Node process. This is M3's crash and hang isolation in the shape M7's sandbox keeps
  ([registry-and-sandbox.md](../../docs/registry-and-sandbox.md#the-sandbox)).

## Guarded tool page

- `fetch`: `init` is read once into a frozen snapshot (method, string-valued headers, a plain copy
  of `json`), every check runs on the snapshot, and only the snapshot reaches the driver. The URL
  is resolved against `manifest.home` (never the page's current URL), then core's `decideRequest`
  against `egress` and `requests` (which refuses ambiguous paths as `ambiguous-path` and checks
  denied segments after percent-decoding and dropping `;matrix` params). On top of that: a request
  may not exceed its tool's side effect (a `read` tool can't call a `write` endpoint), and
  method-override headers are refused.
- `goto`: https on an egress host; core's `ambiguousPath`; a path matching a GET declaration whose
  purpose outranks the tool's side effect is refused; a denied segment (checkout, payment, payee,
  transfer, ...) needs an `irreversible` tool **and** a matching GET declaration with purpose
  `irreversible`, as core's `decideRequest` requires. Beyond that, navigation is left to the
  driver's run policy.
- `fetch` and `goto` count against `limits.requestsPerRun` and wait for the site's rate budget.
  `click` waits for the rate budget too (it may navigate or post a form) but isn't counted, since
  most clicks send nothing; it is refused while the site's breaker is open. `fill`, `extract` and
  `evaluate` are neither paced nor counted.
- Violations are sticky: the call fails even if tool code catches the error, and every capability
  refuses from then on. `request-blocked` events (initiator `tool`) carry origin and path only,
  redacted.

## What the driver refuses

The driver reports each request it refuses to `onBlocked`. Each becomes a `request-blocked` audit
event with the driver's initiator and the refusal mapped onto the error vocabulary
(`purpose-exceeded` is `denied-path`, `bad-url` is `invalid`). Identical refusals are recorded once
per call, and at most 50 per call (a `request-blocked-capped` diagnostic says when the cap is hit).

- Initiator `tool`: a raw `ToolPage.fetch`/`goto` the driver refused (one the guarded page let
  through, so a guard disagreement): a sticky violation, so the call fails.
- Initiator `page`: the site's own scripts **and** `evaluate()`d code, which the driver can't tell
  apart. `denied-path`, `ambiguous-path`, `purpose-exceeded` and `request-ceiling` are sticky
  violations whoever asked, since the site's own scripts have no reason to cause them; so a
  `fetch('/checkout/...')` inside `evaluate()` fails the call. `host-not-allowed`, `undeclared` and
  `bad-url` from the page (its analytics, say) are recorded only. So `evaluate()`d code can still
  try off-list hosts and undeclared endpoints without failing the call; the driver refuses each.
- None of them touches the site's breaker. They are our own policy at work, not the site refusing
  us; site blocks are seen in responses (below).

## Site protection

Per site host, shared by every adapter for that host: a `RateBudget` and a `SiteCircuitBreaker`.
Both read `manifest.limits`: `minGapMs` between requests, and a cooldown of `cooldownSeconds`,
doubling for blocks in a row up to `maxCooldownSeconds`. Adapters sharing a host get the most
cautious numbers any of them declares.

Only a block signature trips the breaker: a 429 (`rate-limited`), a 403 HTML page, or Akamai's
"Access Denied … Reference #" page (`blocked-by-site`), in the answer to a guarded `fetch` or the
probe, or a login the `AuthRunner` reports `blocked` (with its cause). After each `goto` (tool
code's, or the probe's trip home) a read-only script in the page's isolated world looks for
Akamai's page by its title and text; `goto` reports no status, so a 403 or 429 from a navigation
can't be seen. Tool code sees a block as `ValetError('tool-run', cause)`, and a request
refused because the breaker is already open as `tool-run/rate-limited`; either way the call
returns `blocked`. Other HTML where JSON was expected (an error page, a login redirect) is
`tool-run/unexpected-shape` and leaves the breaker alone. `breaker-opened` (host, cause, retry
time, call) is audited when it trips, and `breaker-closed` at the first normal answer after a run
of blocks. A normal answer that arrives while the breaker is open, or to a request admitted before
the latest trip (one already in flight when another request was blocked), is ignored: it neither
closes the breaker nor resets the doubling.

**Breaker state persists.** Each change is written to the injected `JsonStore` (`JsonFileStore`,
replaced atomically), so a restart straight after a block doesn't hit the site again; the run of
blocks carries over too, so the next block doubles. The file is read once, before the first call
sends anything. A persisted retry time further out than `maxCooldownSeconds` is cut back to it.

**The pace persists too,** when a `budgetStore` is given. Each request let through writes the time
it went, per host, to that store (not waited for, so the disk never holds a request up), and after
a restart the first request to a host waits out the rest of its `minGapMs` since the last one
before it. Nothing is held at a start with nothing stored. A stored time in the future counts as
now, so a restored time never holds a request longer than one gap; entries a day old are dropped.
A file that can't be read or doesn't parse fails slow, not closed: every host waits one gap from
when it was read, `budget-state-unreadable` is raised and the file is rewritten. A failed write
raises `budget-state-write-failed`. A wait for a slot that is aborted sent nothing, so it hands its
slot back when no request has queued behind it.

**A breaker file that can't be read or doesn't parse fails closed:** every host's breaker opens for
its `cooldownSeconds`, counted from when the file was read, and a `breaker-state-unreadable`
diagnostic is raised. The file is then rewritten straight away with the fail-closed holds (and
again when a host is first registered after the load), so a restart after the holds have passed
reads a valid file instead of failing closed again. A failed write keeps the breaker in memory and
raises `breaker-state-write-failed`.

## Session

`ctx.session.ensure()` probes and logs in only on an explicit logged-out answer:

- A fetch probe: the expected status with the wrong value, or one of the probe's
  `loggedOutStatuses` (default `[401]`). Any other status, or HTML where the probe expected JSON, is
  `failed probe/unavailable`; a block signature is a block, even if its status is listed as logged
  out. The page's fetch sends cookies same-origin only, so when tool code left the page on another
  origin (an `api.` or `assets.` egress host), the probe first takes it back to `home` (paced, and
  counted by the driver's ceiling, which counts navigations); if it lands anywhere else, `failed
  probe/unavailable` and no login.
- A cookie probe: `driver.cookieNames(cookieDomains)` lacks the named cookie. It never touches the
  site.

No login starts while the site's breaker is open.

Logins are rationed:

- At most one login per call. Later `ensure()`s in the call get that login's outcome; if the
  login worked and the session drops again, `failed probe/not-logged-in`.
- Before the `AuthRunner` runs, the marker is set and fsynced. An `AuthRunner` that throws (a crash,
  an abort) leaves it set, and every later `ensure()` gets `needsUser login-attempt-pending` until
  the person clears it.
- After a classified outcome a block trips the breaker (with the runner's cause), and only then is
  the marker cleared or replaced by a hold. These hold until the person clears them: `auth-failed`,
  a login after which the probe still says logged out, and `needsUser` `account-locked`,
  `captcha`, `terms-update` or `site-changed` (an automatic retry could extend a lockout or raise
  the bot score). Any other failure (`needsUser` `otp-required`, `other` or `login-required`, a
  failed handoff, any other failed class) holds for a backoff: 5 min, doubling per failure in a
  row, up to 6 h (`loginBackoff`). The hold keeps the `needsUser` reason, and while held `ensure()`
  returns `needsUser` with that reason, or `login-required` for a hold without one. A login that
  works clears the hold.
- A marker store that can't be written fails as `login/login-in-progress`.

Concurrent `ensure()`s from one call share one login.

## Redaction

Output, and every `request-blocked` target, is checked against:

- the session values `driver.sessionSecrets(cookieDomains, storage)` reports (cookie values and
  handed-off storage values), collected at the start of the call, after each `ensure()` and before
  the output leaves; values shorter than 8 characters are ignored;
- clones of the secrets the latest successful login registered, kept per adapter until the next
  successful login replaces (and disposes) them, so a later call's output (an account page with
  the username) is checked too. A login that fails keeps the earlier login's clones. A secret
  registered after it was disposed (or something that isn't a `SecretValue`), or an `ok` outcome
  whose `filledSecrets` exceeds what was registered, can't be matched, so everything then counts as
  sensitive and every output is withheld (`tool-output/internal`) until the next login.

Matching is exact substring matching, and any string that matches is replaced whole. For
`request-blocked` targets, session values also match case-insensitively, because URL parsing
lower-cases hostnames. Secrets can only be matched exactly without revealing them, so for the
guarded page the target is also redacted when what tool code passed contains a secret as written.
A secret lower-cased into a hostname by the driver's own parsing is not caught.

## Known gaps

- **Site protection sees only what the runtime sends.** What a `click()` loads, a navigation's
  status (a 403 or 429 HTML page other than Akamai's), and what `evaluate()`d code or the page's
  own scripts send are not checked for block signatures, and only `fetch`, `goto` and `click` are
  paced. Closing this needs core's `goto()` to report the main-frame status and content type, or a
  driver hook reporting main-frame responses during a run.
- **`evaluate()`d code is indistinguishable from the page.** It can try off-list hosts and
  undeclared endpoints without failing the call (the driver refuses each, and they are recorded,
  up to 50 per call). Treating those as violations needs a driver that can tell isolated-world
  requests from the page's.
- **Redaction depends on the `AuthRunner`.** It works only if the runner calls
  `registerForRedaction` for every secret it fills (and reports `filledSecrets` so the runtime can
  fail closed); auth-flow's `runAuthFlow` does neither yet. Clones live in memory until the next
  login; the runtime has no hook for the driver closing.
