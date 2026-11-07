# M2 runbook: live Woolworths

This is how [M2](plan.md#m2-electron-driver-and-live-woolworths) gets from "the code is in place"
to its exit: from Claude Code, Nick adds a real item to his real trolley through a dev build, with
the login automated end to end.

It has two parts. **Part 1** is solo work that needs nothing live and must land first. **Part 2**
is three sessions on Nick's Mac with Nick present, spread over at least two days so live contact
stays sparse.

Decisions are cited by number, with whether Nick has answered them. The four that matter here (D10, D24a, D66, D67) were answered on 2026-11-07; they're collected in [Open decisions](#decisions-for-nick), with
the session each one is needed by.

## Rules for every live step

These come from the project rules, [D5](plan.md#d5-which-woolworths-account) (answered),
[D24](plan.md#d24-bot-detection-posture) (answered) and [D28](plan.md#d28-rate-budget-defaults)
(answered).

- **Nothing logged in happens without Nick present.** Anonymous requests outside the sessions are
  limited to what Part 1 lists, and there are almost none.
- **Pacing.** At least 10 s between direct API calls, at most 2 per page view, at most 4 a minute.
  Run 1's pattern (a homepage, then 4 scripted calls 2.5 s apart) is the known-bad baseline and is
  never repeated, by hand or by script.
- **Stop on the first sign of a block.** A 403, Akamai's "Access Denied … Reference #" page, a 429
  or a "Pardon our interruption" page ends the session for the day. No retry, no fresh partition,
  no other UA. Note the time and the URL path, and wait out at least the 30-minute cool-down
  before any other contact; the next session moves to another day.
- **No CAPTCHAs, no challenge bypasses.** If one appears, Nick decides whether to solve it himself
  in the window. Claude never does, and nothing is built to.
- **One automated password submit, ever, per login.** Session 3 can't start until
  [AC10](plan.md#acceptance-criteria) is met (Part 1, step 3).
- **No "Place order", no payment, no delivery-slot booking.** Session 2 stops at the checkout page.
- **What gets recorded.** Methods, hosts, URL paths, resource types, status codes, response key
  shapes, cookie names and domains, form field names and types. Never cookie values, query strings,
  request or response bodies, the Auth0 `state`, Nick's email, codes, or trolley contents. Raw
  results stay in the gitignored `results/` folders; only scrubbed findings go in
  `docs/findings/`.
- **Where it runs.** On Nick's Mac in `~/Code/valet`. Nick runs the commands, or Claude drives them
  over Remote Control with Nick watching.

## Part 1: solo pre-work

All of this runs against the fake site and lands on `main` with `pnpm check` green before
Session 1, except step 5, which can land between sessions.

### 1. D55: pacing and block detection inside the login

[D55](plan.md#d55-driver-level-budget-and-block-detection) (answered: accepted, the split
design, C16). Today the app's own login steps go through `ToolHost.runLoginStep`, but the
automated login inside a tool call and the person's own login window are neither paced nor watched.

- The driver reports block signatures (403 HTML, Akamai's "Access Denied … Reference #", 429) on
  main-frame navigations and API calls in **both** partitions to the runtime's breaker. A block
  during a login ends it as `login/blocked-by-site` and opens the site's breaker; an open breaker
  cancels every request to that host in the tool partition.
- The driver waits on the runtime's budget before each main-frame navigation it or the auth flow
  starts, in both partitions. A server redirect chain counts as one navigation. The gap is D28's
  10 s, so an automated identifier-first login (login link, email submit, password submit,
  callback) takes about 30–40 s, which is about a person's pace.
- The person's own clicks in the login window are watched for block pages but not paced: the
  person is the pace, and a 10 s hold on every click would read as the app hanging. (A detail
  inside D55; flagged below in case Nick wants it otherwise.)
- Tests: AC7's request count moves to the fake site, not the capability API. Replay the run 1
  pattern through the auth partition and through `evaluate()`, and assert it is spaced out. A block
  served to the fake's password POST ends the login as `blocked` with the breaker open, and the
  next call fails fast without reaching the fake (AC9).

### 2. D67: stopping a login when the call is cancelled

[D67](plan.md#d67-stopping-a-login-when-the-call-is-cancelled) was answered on 2026-11-07: build the core
change (it changes the `AuthRunner` contract in core).

- `runAuthFlow` takes an `AbortSignal`, checked between steps and before each keystroke batch.
- The outcome reports `secretFilled: boolean` (true once any secret's typing has started). The
  runtime clears the attempt marker by itself after a cancel with no fill; with a fill, it stays
  for the person, as now.
- Tests: cancel before the email page, after the email but before the password, and mid-password.
  Only the last needs the person.

### 3. The AC10 one-attempt check

[AC10](plan.md#acceptance-criteria) is the hard gate before Session 3
([D5](plan.md#d5-which-woolworths-account), answered). Reading the code, two answered decisions it
depends on aren't built yet:

- **[D32](plan.md#d32-which-failures-retry) (answered: accepted).** `RETRYABLE` in
  `packages/auth-flow/src/interpreter.ts` still includes `auth-step/auth-failed` and
  `probe/not-logged-in`, so a `retry` around the fill can submit the password twice. Drop both.
  The filler counts password fills per login and refuses a second, ending the login as
  `needsUser(login-required)`, whatever the steps say.
- **[D35](plan.md#d35-the-attempt-marker-after-a-timeout) (answered: accepted).** The marker in
  `packages/runtime/src/login-marker.ts` doesn't record whether a password fill started. The filler
  tells the runtime before typing, and the marker records it, fsynced. A marker with no fill
  becomes a backoff hold that clears itself; with a fill, the tray offers Clear (the wording is in
  D35). This shares the "fill started" signal with D67.

Then the check itself, as one test file that has to pass before Session 3:

- Against the fake site's wrong-password variant, a manifest that wraps the password fill and
  submit in `retry: { times: 5 }` produces exactly **one** password POST, counted at the fake site.
  The login ends `auth-failed`, the marker is held, and the next call returns `needsUser` without
  touching the fake.
- The same with a crash simulated after typing started: the marker stays, and only Clear lifts it.
- The same with a timeout before typing: a self-clearing hold, no password POST.
- A dry run of the dev app against the fake with a wrong password, watched once by Claude, to
  confirm the tray shows the held state.

### 4. Session tooling

Small changes so the sessions spend Nick's time on the site, not on setup.

- **Spike 1** (`spikes/01-woolworths-electron`). Make the clean Chrome UA the default and require
  `SPIKE_UA=electron` to get Electron's (that UA is flagged from Nick's IP, run 4). Space its two
  trolley fetches (main world, isolated world) 10 s apart; today they run back to back. On each
  auth page, record the shape: path, form field names, types and `autocomplete`, the form action's
  origin, button labels, and whether a "remember this device" control exists. Record cookie names
  and domains in both partitions after login. Never values.
- **A record mode** in the same spike (`SPIKE_MODE=record`), so it reuses spike 1's persisted
  partitions and Auth0 session. It logs every request in the window: method, host, path, resource
  type, initiator (main frame, subframe, worker), status, and whether the path touches a deny
  segment. It also cancels and logs, as a belt-and-braces guard, any non-GET whose path matches
  `order`, `payment` or `place` once the window is on a checkout path, and every request to a
  payment host. Output is grouped by page view, for D58's counts.
- **A silent-redirect mode** (`SPIKE_MODE=silent`): clear the www cookies only (domains
  `www.woolworths.com.au` and `.woolworths.com.au`, in both partitions), open `/auth/login`, and
  record whether the password page appears or the callback arrives without one.
- **A probe mode** (`SPIKE_MODE=probe`): one `GET /api/ui/v2/bootstrap` in the tool partition, and
  the key shape of its response, to compare with the anonymous fixture already in
  `fakes/woolworths-site/fixtures/`.
- A `scrub` script that turns `results/*.json` into a findings draft and fails if it sees anything
  shaped like a cookie value, an email address, a `state` or a code.

No live request is needed to build any of this. The fake site covers the code paths.

### 5. Between sessions

- **After Session 1:** set the real password page, MFA page and "remember this device" selectors in
  the fake Auth0 and the Woolworths manifest. If SMS, record the sender handle in the manifest's
  `otp` step ([D4](plan.md#d4-woolworths-2fa), answered: SMS via Messages unless TOTP is offered).
  Write `docs/findings/<date>-woolworths-logged-in.md`.
- **After Session 2:** the probe endpoint in the manifest; the real checkout and payment paths as
  deny fixtures in the adapter's tests and as routes on the fake (AC13); the two ceilings, `host`
  on declarations and the `telemetry` declarations from the measured traffic
  ([D58](plan.md#d58-page-initiated-traffic), answered: accepted, C17); R17's deny segments limited
  to the resource types that need them; the egress set per D10's answer. Then rerun Part 1's tests.

## Part 2: sessions with Nick

Three sessions, each on its own day by default. Sessions 2 and 3 may share a day only if Session 2
saw no block and they're at least three hours apart. Times are Nick's time at the keyboard.

### Before Session 1 (Nick, 5 minutes)

- `git pull` on `main` in `~/Code/valet`, `mise install`, `pnpm install`, `pnpm check` green.
- At home, on the same network as the probe runs.
- His phone to hand, for an SMS code.
- Close any woolworths.com.au tabs in Chrome, so his own browsing doesn't add to the traffic.

### Session 1: spike 1 and the Auth0 flow (day 1, about 20–30 minutes)

Answers the spike's questions and records the assumed parts of the Auth0 flow in a single manual
login. Everything in the window is typed by Nick.

1. `cd spikes/01-woolworths-electron && pnpm start` (clean Chrome UA by default after Part 1).
2. In the window: Login, email, Continue, password, Continue. Nick types everything; the spike only
   watches. It records the password page's path and fields, and whether an MFA page follows.
3. If there's an MFA page, note which factor it asks for (SMS, authenticator, email, push). For
   SMS, note the sender as it shows in Messages (the name or number, not the code). If an
   authenticator factor is offered, stop there and decide whether to enrol one in 1Password; D4
   prefers TOTP if it's available.
4. If a "remember this device" box appears, tick it. The spike's partition persists, so this
   tells us whether Session 2 is challenged again. (The app's own partition is separate and will
   be challenged once in Session 3.)
5. Close the window once the trolley or home page shows logged in. The spike copies the cookies
   to the tool partition, waits 5 s, and calls the trolley from the main world and then, 10 s
   later, the isolated world.
6. Read `results/chrome.json` together. It answers spike 1's three questions: does the clean UA
   hold while logged in, does `_abck` survive the copy, does an isolated-world `fetch` carry
   same-origin credentials. It also lists cookie names and domains: no Auth0 or session cookie may
   be on `.woolworths.com.au` (M2's cookie check).

Stop if: a block page at any step, or anything asking for a CAPTCHA that Nick doesn't want to do.
D24a comes up here only if the block appears after login (see below).

Live contact: one manual login, one homepage load, two API calls 10 s apart.

### Session 2: silent redirect, probe, checkout path and traffic (day 2, about 45–60 minutes)

Uses spike 1's persisted partitions, so it starts from yesterday's Auth0 session.

1. **Silent redirect** (`SPIKE_MODE=silent`). Clears only the www cookies and opens `/auth/login`.
   Record whether Auth0 returned straight to the callback (the hoped-for case: re-login with no
   secret fill, AC4), or showed the password page. If the Auth0 session had expired overnight,
   that's a finding too: Nick logs in by hand, and the silent check runs again at the end of the
   session, at least 10 minutes later.
2. **Probe** (`SPIKE_MODE=probe`). One `GET /api/ui/v2/bootstrap`, logged in. Compare its key
   shape with the anonymous fixture. Wait at least 10 s before the next step.
3. **Traffic and checkout path** (`SPIKE_MODE=record`). Nick drives at his normal pace, waiting
   for each page to settle:
   1. The home page.
   2. A search (anything; nothing is added to the trolley in this session).
   3. A product page.
   4. The trolley.
   5. Checkout, as far as the page before "Place order". No slot booking, no payment details, no
      "Place order". If the site wants a slot before it shows the checkout page, stop there; the
      path up to that point still counts.
   6. Back to the trolley, then close the window.

   This one walk gives: the real checkout and payment request paths (method, host, path) for AC13;
   per page view, the site's own navigations and API calls and its non-GET background calls by
   host for D58; and which requests touch a deny segment, by resource type, for R17.
4. **Strict egress check** (D10, answered: ideally strict). One more trolley page load with only the
   strict hosts allowed (www, `cdn0.woolworths.media`, `acs.woolworths.com.au`). Does the trolley
   render, does Akamai object. Skip it if Session 2 has shown anything odd.
5. Read the results together and agree the scrubbed finding.

Stop if: a block page at any step; anything on the checkout page that looks like it would commit
an order or a slot.

Live contact: possibly one manual login, about 6–8 page views by hand, one direct API call.

### Session 3: the first automated login and the M2 exit (day 3, about 30–45 minutes)

Needs Part 1 merged, including AC10, and the Session 1 and 2 findings in the manifest and the fake.

Before it starts:

- **Credentials.** M2 can use 1Password's desktop-app path (D6, answered in part: Nick prefers
  authorising once from his own vaults; whether his plan has service accounts is open, and being
  checked in another thread). Either way Nick enters nothing in chat or in a file; the app's own
  onboarding takes it.
- **The SMS code.** Full Disk Access is M3 work ([D8](plan.md#d8-full-disk-access-for-messages),
  answered: build the helper). For M2, if Auth0 challenges, the app hands the login window to Nick
  and he types the code. That's also a test of the `needsUser` hand-off.

Steps:

1. `pnpm --filter @valet/desktop dev`. The dev build has fresh partitions, so it starts logged out.
2. Approve the bundled Woolworths adapter and grant the `login` secret to the 1Password item.
   Check the grant's origins are exactly `https://auth.woolworths.com.au` (AC2).
3. Connect Claude Code over HTTP with the bearer token the app shows.
4. From Claude Code, call `woolworths_get_cart`. Nick watches the login: one email fill, one
   password fill, about 30–40 s with the D55 pacing. If MFA appears, the login window comes forward
   and Nick types the code. The tool returns the trolley, or `needsUser` within the client's
   timeout.
5. Call `woolworths_get_cart` again: no login this time, served from the session.
6. Nick picks one cheap item. Claude calls `woolworths_search_products`, then
   `woolworths_add_to_cart` for one unit. Nick refreshes woolworths.com.au in Chrome and sees it
   (AC6). If he doesn't want to keep it, `woolworths_set_cart_quantity` to 0, and check again.
   This is the M2 exit.
7. Afterwards: verify the audit log from the control panel (AC14's CLI isn't built yet); check it shows one secret use per field
   for the login; grep the app's logs, traces and audit log for the password (a first pass at
   AC16).

Stop if: a block page; `auth-failed` (the marker holds, Nick checks he can log in from Chrome,
then clears it in the app; no second automated attempt that day); any login that types the
password twice, which is a bug that stops M2 until fixed.

Live contact: one automated login, two or three page views, about four direct API calls, all at
the D28 pacing.

## Decisions for Nick

| Decision | Question | Recommendation | Needed by |
| --- | --- | --- | --- |
| [D10](plan.md#d10-analytics-hosts) (answered 2026-11-07: ideally yes) | Block the ~40 analytics and ad hosts in the tool partition, or allow them? | Strict by default (www, `cdn0.woolworths.media`, `acs.woolworths.com.au`), with Session 2's strict check as the evidence. Add hosts only if the site breaks without them. | Session 2, step 4 |
| [D24a](plan.md#d24a-client-hint-brands) (answered 2026-11-07, in the bot-detection thread) | Send `Google Chrome` rather than `Chromium` in the client-hint brands? | Nick chose to match Chrome: the default flips to `clientHints: 'chrome'`. Nothing left here. | Done |
| [D66](plan.md#d66-a-block-page-in-the-persons-login-window) (answered 2026-11-07: accepted) | When the person's login window opens on a block page, keep closing it silently, show the page, or explain in the app? | Explain in the app, with the time the breaker reopens. | Before Session 3, which is the first time the app's own login window meets the live site |
| [D67](plan.md#d67-stopping-a-login-when-the-call-is-cancelled) (answered 2026-11-07: accepted) | Let `runAuthFlow` take a signal and report whether a secret was filled, so a cancel before any fill clears the marker by itself? | Yes, the core change, built in Part 1 step 2 on a branch. | Merge before Session 3 |

Smaller calls this runbook makes, which Nick can overrule:

- The person's own clicks in the login window are watched for blocks but not paced (Part 1,
  step 1).
- In M2, an SMS code is typed by Nick through the hand-off rather than read from Messages, so no
  Full Disk Access is granted to a dev build.
- Session 1 ticks "remember this device" if it's offered.
- Sessions 2 and 3 can share a day only after a clean Session 2, three or more hours apart.
