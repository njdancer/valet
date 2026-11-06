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

- **After every step, and on every poll:** every committed URL must be on `navigation`
  (`navigate: navigation-escaped`), then `isBlockedPage()` (`blocked`), then the flow deadline
  (`timeout: timed-out`). A fresh page's `about:blank` is allowed in the history.
- **Secret fill order:** grant (`not-granted`) → manifest field (`invalid`) → element visible
  (`element-missing`) → frame origin, then page origin, in granted ∩ requested
  (`origin-mismatch`) → element suits field (`element-unsuitable`) → password form action
  (`form-action-mismatch`) → resolve (`credential: <failure>`) → **the element checks again** →
  focus → audit `secret-used` → type → dispose. Auditing comes before typing, so a fill that
  can't be audited doesn't happen.
- **`retry: { times: n }`** runs its steps up to `n + 1` times. Only `condition-timeout`,
  `element-missing`, `auth-failed` and `not-logged-in` are retried; guard failures, blocks,
  `needsUser` and timeouts never are.
- **`urlMatches`** tests the URL's path and query, never its host. A pattern wrapped in slashes
  (`/^\/account$/`) is a regular expression; anything else is a substring.
- **Messages OTP** has no secret request, so the code may be typed on any `navigation` origin;
  the element checks still apply. It polls every second until the flow deadline, asking only for
  codes newer than the flow's start, then fails `otp: not-found`. It is audited as secret
  `messages`.
- **`blocked`** is audited as `login-finished { outcome: 'failed', errorClass: 'blocked-by-site' }`
  until the audit vocabulary has a `blocked` outcome.
- **Timeouts are cooperative.** The deadline is checked between steps and on every poll. A driver
  primitive that hangs is bounded by the driver's own per-primitive timeout, not by this package.

## Tests

`test/fake-auth-page.ts` is a scriptable page: states keyed by URL, with elements, frames, forms,
text, click targets, server redirects and block pages, a committed-URL history, and a record of
everything typed and whether it arrived as a `SecretValue`. `test/fixtures.ts` has the example
site; tests copy it and change one thing. `test/canary.test.ts` seeds unique secrets and scans
every outcome, audit event and console call for them.
