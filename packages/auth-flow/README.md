# @siteadapter/auth-flow

The declarative auth interpreter and the privileged secret filler. `runAuthFlow(input)` runs a
manifest's `auth.steps` against an `AuthPage` and returns `ok`, `needsUser(reason)`,
`failed(stage, errorClass)` or `blocked`. It never throws. The rules it enforces are in
[docs/security-model.md](../../docs/security-model.md).

## Modules

| File            | What it holds                                                                     |
| --------------- | --------------------------------------------------------------------------------- |
| `run-auth-flow` | The entry point: audit `login-started` / `login-finished`, map errors to outcomes |
| `interpreter`   | One function per step, `retry`, `waitFor` polling                                 |
| `conditions`    | `visible`, `urlMatches`, `textPresent`, `not`, `any`, `all`                       |
| `secret-fill`   | Grant, manifest and element checks, just-in-time resolve, audit, type, dispose    |
| `guards`        | Pure checks: field suitability, granted ∩ requested origins                       |
| `context`       | Per-run state, the after-step checks, `guarded()` for injected effects            |

## Behaviour worth knowing

- **Before anything else:** `typingDelayMs` must be a finite number ≥ 0 and `flowTimeoutMs` a
  finite number > 0 (`auth-step: invalid`), so no deadline can be `NaN` and no poll endless. A
  clock that throws or returns an invalid date ends the flow as `auth-step: internal`; nothing
  escapes `runAuthFlow`.
- **After every step, and on every poll:** every committed URL must be on `navigation`
  (`navigate: navigation-escaped`), then `isBlockedPage()` (`blocked`), then the flow deadline
  (`timeout: timed-out`). A fresh page's `about:blank` is allowed in the history.
- **Secret fill order:** grant (`not-granted`) → manifest field (`invalid`) → every committed
  URL on `navigation` (`navigate: navigation-escaped`) → not a block page (`blocked`) → element
  visible (`element-missing`) → frame origin, then page origin, in granted ∩ requested
  (`origin-mismatch`) → element suits field (`element-unsuitable`) → password form action
  (`form-action-mismatch`) → resolve (`credential: <failure>`) → **the history, block and element checks again** →
  focus → audit `secret-used` → type → dispose. Auditing comes before typing, so a fill that
  can't be audited doesn't happen.
- **`retry: { times: n }`** runs its steps up to `n + 1` times. Retryability is stage and class
  together: only `auth-step: condition-timeout`, `auth-step: element-missing`,
  `auth-step: auth-failed` and `probe: not-logged-in` are retried. Anything from `secret-fill`,
  `otp`, `grant` or `credential` never is, so a fill guard that fired after Touch ID can't be
  given a second chance (or a second Touch ID prompt). Blocks, `needsUser` and timeouts never are.
- **`urlMatches`** tests the URL's path and query, never its host. A pattern wrapped in slashes
  (`/^\/account$/`) is a regular expression; anything else is a substring. Every pattern in every
  branch is compiled before the first step, so a bad one fails `manifest: invalid` up front. A
  regex is never run on a path and query longer than `MAX_REGEX_INPUT` (2048) characters; such a
  URL simply doesn't match. Beware that `/account/` is read as the regex `account`.
- **Messages OTP** needs a grant, as a 1Password secret does: until core has a grant kind for
  it, a `Grant` whose `secret` is `messages` (`MESSAGES_SECRET`), for this adapter and hash; its
  `provider` and `itemRef` are unused. The source must name a `sender` (`secret-fill: invalid`
  otherwise), a manifest may not declare its own secret called `messages`, and the code may be
  typed only on origins in that grant that some secret request also asked for, not on the whole
  `navigation` list. It polls every second until the flow deadline, asking only for codes newer
  than the flow's start, then fails `otp: not-found`. It is audited as secret `messages`.
- **`blocked`** is audited as `login-finished { outcome: 'failed', errorClass: 'blocked-by-site' }`
  until the audit vocabulary has a `blocked` outcome.
- **`assertLoggedIn`** calls `input.probe`, which runs against the **auth** partition (a cookie
  read from the auth session, or a fetch from the auth page). Nothing has been copied to the
  tool partition while the flow runs; the caller copies cookies auth → tool only after an `ok`
  outcome, so a failed or half-finished login never reaches tool code.
- **Timeouts are cooperative.** The deadline is checked between steps and on every poll. A driver
  primitive that hangs is bounded by the driver's own per-primitive timeout, not by this package.

## Tests

`test/fake-auth-page.ts` is a scriptable page: states keyed by URL, with elements, frames, forms,
text, click targets, server redirects and block pages, a committed-URL history, and a record of
everything typed and whether it arrived as a `SecretValue`. `test/fixtures.ts` has the example
site; tests copy it and change one thing. `test/canary.test.ts` seeds unique secrets and scans
every outcome, audit event and console call for them.
