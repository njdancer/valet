# @siteadapter/auth-flow

The declarative auth interpreter and the privileged secret filler. `runAuthFlow(input)` runs a
manifest's `auth.steps` against an `AuthPage` and returns `ok`, `needsUser(reason)`,
`failed(stage, errorClass)` or `blocked(stage, errorClass)`. It never throws. The rules it enforces
are in [docs/security-model.md](../../docs/security-model.md).

## Modules

| File            | What it holds                                                                        |
| --------------- | ------------------------------------------------------------------------------------ |
| `run-auth-flow` | The entry point: audit `login-started` / `login-finished`, the final probe, outcomes |
| `interpreter`   | One function per step, `retry`, `waitFor` polling                                    |
| `conditions`    | `visible`, `urlContains`, `urlRegex`, `textPresent`, `not`, `any`, `all`             |
| `url-matcher`   | `WorkerUrlMatcher`: runs `urlRegex` patterns in a worker thread under a deadline     |
| `probe`         | Reads the manifest's session probe through the `AuthProbe` hook                      |
| `secret-fill`   | Grant, manifest and element checks, just-in-time resolve, audit, type, dispose       |
| `guards`        | Pure checks: field suitability, granted ∩ bound origins                              |
| `context`       | Per-run state, the after-step checks, `guarded()` for injected effects               |

## Wiring it up

`AuthFlowInput` is everything the flow touches. Besides the page, grants, providers and the
Messages reader, the caller supplies:

- **`probe: AuthProbe`**, two hooks that fetch evidence from the **auth** partition:
  `fetch(url)` (a GET with the auth session's cookies) and `cookieNames(cookieDomains)`. The flow
  reads the manifest's probe itself; the hooks never decide. `fetch` returns what the site said:
  the flow reads a 429 as `rate-limited` and an HTML 403 or Akamai's "Access Denied" page as
  `blocked-by-site`, as the runtime's `looksBlocked` does for the tool partition. It may also
  throw `SiteAdapterError('probe', 'blocked-by-site' | 'rate-limited')` itself (an open breaker),
  and should obey the site's rate budget.
- **`rememberSecret(copy)`**, called with an independent `clone()` of every secret just before it
  is typed. The runtime keeps it to redact tool output for the rest of the run, and disposes it.
  If it throws, the secret isn't typed.
- **`isBlockedPage()`**, the clock, `sleep`, `typingDelayMs` and `flowTimeoutMs`.
- **`urlMatcher?`**, optional. By default each run starts a `WorkerUrlMatcher` on its first
  `urlRegex` test and closes it when the run ends. One passed in is the caller's to close.

### The audit log: this package owns the login events

`runAuthFlow` appends `login-started` before the first step and `login-finished` (with the
outcome, the needsUser reason or the stage and class) after the last, and `secret-used` before
every secret is typed. The caller must not append its own `login-started` or `login-finished`
around `runAuthFlow`: two finish records for one login, which disagree (only this one knows the
reason, and records a block as `blocked`), would end up in a hash-chained log that can't be
corrected. Today `packages/runtime/src/session.ts` does append both around its `AuthRunner`; that
needs to go, or become a runtime-only marker event, when the app wires this package in.

## Outcomes

| Outcome     | Fields                                     | Audited `login-finished`                    |
| ----------- | ------------------------------------------ | ------------------------------------------- |
| `ok`        |                                            | `outcome: 'ok'`                             |
| `needsUser` | `reason` (a `NeedsUserReason`), `appNote?` | `outcome: 'needsUser'`, `needsUser: reason` |
| `failed`    | `stage`, `errorClass`, `appNote?`          | `outcome: 'failed'`, stage and class        |
| `blocked`   | `stage`, `errorClass`, `appNote?`          | `outcome: 'blocked'`, stage and class       |

- **`appNote`** is the manifest step's `note`: free text the person may see in the app. Never send
  it to an MCP client, and it never goes in the audit log. `reason`, `stage` and `errorClass` come
  from core's fixed vocabularies and may.
- **`blocked`** is any error whose class is `blocked-by-site` or `rate-limited`: the block page
  (`auth-step`), the probe hook, or a `fail` step with `errorClass: 'blocked-by-site'`. The
  caller cools down rather than retrying. A block is never retried inside the flow either.
- The flow doesn't call `handToUser`; the caller does that on `needsUser`.

## Behaviour worth knowing

- **Before anything else:** `typingDelayMs` must be a finite number ≥ 0 and `flowTimeoutMs` a
  finite number > 0 (`auth-step: invalid`), so no deadline can be `NaN` and no poll endless. A
  clock that throws or returns an invalid date ends the flow as `auth-step: internal`; nothing
  escapes `runAuthFlow`.
- **After every step, and on every poll:** every committed URL must be on `navigation`
  (`navigate: navigation-escaped`), then `isBlockedPage()` (`blocked`), then the flow deadline
  (`timeout: timed-out`). A fresh page's `about:blank` is allowed in the history.
- **The flow always finishes with the probe.** If the last thing it did wasn't a passing
  `assertLoggedIn` (including one that ended a `when` branch), it runs the probe once more before
  reporting `ok`, then the after-step checks. A flow that just ran out of steps hasn't shown it is
  logged in.
- **The probe** runs against the auth partition, before anything has been copied to the tool
  partition; the caller copies the session auth → tool only after `ok`.
  - A cookie probe asks `cookieNames(session.cookieDomains)` and looks for the exact name.
  - A fetch probe GETs `probe.path` resolved against `home`, and refuses (`probe: host-not-allowed`,
    nothing fetched) unless that stays on `home`'s origin, which must be https and on `navigation`.
  - First, whatever the manifest says: a 429 is `blocked` with `probe: rate-limited`, and an HTML
    403, or an HTML page that is Akamai's "Access Denied" with its reference number, is `blocked`
    with `probe: blocked-by-site`. A refusal is never an answer about the session.
  - The expected status is logged in (subject to `jsonPath`/`equals`); a status in
    `loggedOutStatuses` (default `[401]`) is `probe: not-logged-in`, which `retry` may retry; any
    other status, or HTML where `jsonPath` expected JSON, is `probe: unavailable`, never retried.
    `jsonPath` follows own properties only.
- **Secret fill order:** reserved name `messages` (`invalid`) → grant for this adapter and hash,
  not a `messages` grant (`not-granted`) → manifest field (`invalid`) → every committed URL on
  `navigation` (`navigate: navigation-escaped`) → not a block page (`blocked`) → element visible
  (`element-missing`) → frame origin, then page origin, in granted ∩ requested
  (`origin-mismatch`) → `inputReachable` strictly true (`input-unreachable`) → element suits field
  (`element-unsuitable`) → password form action (`form-action-mismatch`) → resolve
  (`credential: <failure>`) → **the history, block and element checks again** → focus → **every
  check once more, on what the selector finds now** → hand the runtime its copy → audit
  `secret-used` → `type(secret, { delayMs, allowedOrigins })` → dispose. The check after focus is
  for an SPA that re-renders as focus lands (say, swapping the login form for a search form):
  the checks then describe the element that has focus. Auditing comes before typing, so a fill
  that can't be audited doesn't happen. `allowedOrigins` is granted ∩ requested in normalised
  origin form; the driver types only into the focused element, checks its frame against
  `allowedOrigins` before every keystroke, and stops with `secret-fill: origin-mismatch` if the
  page or frame navigates or focus moves. **Known gap:** the checks and `focus()` each resolve
  the selector, so a selector matching two elements could, in principle, check one and focus the
  other. Closing it needs core's `focus()` to return the `ElementInfo` of what it focused.
- **`auth.frameOrigins`** never widens where a secret goes: a CAPTCHA frame's origin gets a
  secret only if it is also granted and requested.
- **`retry: { times: n }`** runs its steps up to `n + 1` times. Retryability is stage and class
  together: only `auth-step: condition-timeout`, `auth-step: element-missing`,
  `auth-step: auth-failed` and `probe: not-logged-in` are retried. Anything from `secret-fill`,
  `otp`, `grant` or `credential` never is, so a fill guard that fired after Touch ID can't be
  given a second chance (or a second Touch ID prompt). Blocks, `needsUser` and timeouts never are.
- **`needsUser` and `fail`** are checked against `NEEDS_USER_REASONS` and `FAIL_CLASSES` again
  at run time (`manifest: invalid` otherwise), since the reason reaches the MCP client and the flow
  can't know its manifest went through the schema.
- **`urlContains`** is a substring of the URL's path and query, never its host or fragment.
  **`urlRegex`** tests the same path and query. Every `urlRegex` in every branch is compiled once,
  before the first step, and must pass core's `isScreenedPattern` (`manifest: invalid`
  otherwise, before anything is audited or fetched). The screen only refuses exponential shapes;
  a polynomial one like `\d*\d*\d*!` passes it and can backtrack for minutes on a long query an
  adapter chose. So the pattern never runs on the main thread: `WorkerUrlMatcher` runs it in a
  worker (one per flow, started on first use) and terminates the worker after 500 ms, which
  ends the flow as `auth-step: invalid`. A regex is never run on a path and query longer than
  `MAX_REGEX_INPUT` (2048) characters; such a URL simply doesn't match.
- **Messages OTP** needs a grant with `provider: 'messages'` under `MESSAGES_SECRET` (core's), for
  this adapter and hash, whose `itemRef` is exactly the step's `sender`. The code may be typed only
  on the grant's origins that are also on `navigation`. It polls every second until the flow
  deadline, asking only for codes newer than the flow's start, then fails `otp: not-found`. It is
  audited as secret `messages`.
- **Timeouts are cooperative.** The deadline is checked between steps and on every poll. A driver
  primitive that hangs is bounded by the driver's own per-primitive timeout, not by this package.

## Tests

`test/fake-auth-page.ts` is a scriptable page: states keyed by URL, with elements, frames, forms,
text, click targets, server redirects and block pages, a committed-URL history, and a record of
everything typed, against the element it actually reached, whether it arrived as a
`SecretValue` and with which `allowedOrigins`. Its `type` behaves as the driver is specified to:
it types only into the element `focus()` targeted, stops if focus moves, the element is replaced,
or the page or frame navigates (same origin or not), and checks the element's frame against
`allowedOrigins` before each keystroke. `beforeKeystroke` and `navigateFrame` let a test move the
page mid-secret. Flow tests run `urlRegex` through `InProcessUrlMatcher`, on the test's thread;
`url-matcher.test.ts` runs the real worker, including against `\d*\d*\d*!` on a 2000-digit
query under a fixed time budget. `FakeProbe` answers the
probe hooks from the page's cookie jar or a scripted response. `test/fixtures.ts` has the example
site; tests copy it and change one thing, and `unparsedWithSteps` builds a manifest the schema
never saw. Every flow finishes with the probe, so tests of a step that doesn't itself log in
start with the session cookie already set. `test/canary.test.ts` seeds unique secrets and scans
every outcome, audit event and console call for them.

Coverage from the repo root reports nothing for files under `.claude/worktrees` (a hidden
directory); run it from the package to check a worktree:
`mise exec -- pnpm exec vitest run --coverage.enabled --coverage.include='src/**'`.
