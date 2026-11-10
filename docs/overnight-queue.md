# Overnight queue

Written 2026-11-07 for the night of 7–8 November. The ordered list of work that threads can do
without Nick, under the project rules: no logged-in or account actions on the live Woolworths
site, no code signing or notarisation, nothing released or published outside the repo. Every
item ends in a PR that is merged by the thread itself once macOS CI is green.

The long-term plan is unchanged: the milestones in [plan.md](plan.md#milestones), M3 (MVP) to
M10, in the order in [Order and overlap](plan.md#order-and-overlap), with the app-side remote
mode from [relay.md](relay.md) straight after M3. This queue only covers what can move tonight.

## How to run it

- **Already running, keep going.** Two threads own work that is not repeated here:
  - _Plan M2's live Woolworths sessions_: the rest of the solo M2 pre-work
    ([D55](plan.md#d55-driver-level-budget-and-block-detection) pacing of page-initiated
    main-frame navigations, AC7's request count at the fake site, the AC10 dry run of the dev app
    against the fake), and the [D58](plan.md#d58-page-initiated-traffic) manifest shape (C8, C17).
  - _Build Keychain, 1Password and Messages credentials_: the in-process Keychain read and the
    Keychain copy store ([D6](plan.md#d6-1password-setup)), 1Password `DesktopAuth` (C7,
    [D7](plan.md#d7-1password-fallback)), and the Swift Messages helper
    ([D8](plan.md#d8-full-disk-access-for-messages)).
- **Parallelism.** Items in different "area" columns can run at the same time. Items that share
  an area run one after another, or rebase on each other's merge. Never more than four new
  threads at once: CI runs on one macOS queue, and a long queue makes every thread wait.
- **Before merging,** rebase on `main`, run `pnpm check` locally where the Linux container allows
  (see the known environmental failures in the repo's CI notes), and treat macOS CI as the source
  of truth.
- **Stop rule.** A thread that hits a decision Nick hasn't answered builds the plan's
  recommendation only if it can be changed later without migrating anyone's data; otherwise it
  writes the question into plan.md under the decision, and stops that part.
- **Never** run anything against the live site while logged in, sign anything, touch real
  1Password, Keychain or Messages in a test, or name Nick's other projects or his bank.

## The queue

| #   | Work                                       | Milestone, criterion | Area                                | Size (agent-days) |
| --- | ------------------------------------------ | -------------------- | ----------------------------------- | ----------------- |
| 1   | Root-cause the restart flake               | M3, AC17             | `apps/desktop` e2e, runtime         | 0.5               |
| 2   | Audit-log verifier CLI                     | M3, AC14             | `packages/runtime`, root scripts    | 0.5               |
| 3   | Approval diff: one test per expanding kind | M3, AC15             | `apps/desktop/src/main/core`        | 0.5–1             |
| 4   | First-run onboarding                       | M3, AC2, AC3         | `apps/desktop` renderer and main    | 1.5–2             |
| 5   | Structured confirmations (C4)              | M3, G4               | `core`, runtime, confirmation panel | 1                 |
| 6   | Manifest-derived MCP annotations (C9)      | M2/M3, AC3           | `core`, `mcp-server`, adapter       | 0.5–1             |
| 7   | Tool code out of the main process          | M3                   | runtime, `apps/desktop` main        | 2–3               |
| 8   | Release command dry run                    | M3, AC18             | `apps/desktop/scripts`, CI          | 1                 |
| 9   | Drift detection against fixtures           | M4                   | adapter tests, `core` errors        | 1                 |
| 10  | Audit rotation and trace retention (D27)   | M4                   | runtime audit, settings             | 1                 |
| 11  | Remote mode, first slice                   | after M3, relay.md   | `mcp-server`, desktop main          | 2–3               |
| 12  | Woolworths terms read, for D25             | M8 prep              | docs only                           | 0.25              |

Items 1–3 are small, independent and unblock confidence in CI, so start them first, in parallel.
Item 4 is the largest MVP gap that needs no Nick. Items 5 and 6 both change `core`'s manifest
and adapter contract, so run them one after the other (5 first). Item 7 touches the same runtime
files as 5, so it starts after 5 merges. Items 9–12 are only for threads that finish early.

### 1. Root-cause the restart flake

`apps/desktop/e2e/update.spec.ts`, "a restart of the same build keeps the approval and the
grants", failed once on PR #6 (`get_cart` returned `needsUser` `login-required` about 9 s after
relaunch) and passed on the rerun. The test now prints recent audit events on failure. Reproduce
it by looping the spec on CI or locally under xvfb, find whether the session hand-off, the probe
or the approval reload is racing the relaunch, and fix the cause, not the timeout. Done when the
spec passes 20 runs in a row on macOS CI.

### 2. Audit-log verifier CLI

AC14 asks for a CLI command that verifies the audit log end to end. `verifyAuditLog` exists in
`packages/runtime/src/audit-log.ts`, but there is no command. Add one (for example
`pnpm valet:verify-audit [path]`, and the same entry point inside the packaged app's
`Contents/MacOS` for later), with a non-zero exit and the first bad line on failure. Tests:
tampering with any byte of any line, deleting a line, reordering two lines and truncating the
file each fail verification.

### 3. Approval diff: one test per expanding kind

AC15 lists every permission-expanding change the re-approval diff must highlight, and says each
kind has its own test. `apps/desktop/src/main/core/permission-diff.ts` and its test exist. Walk
the AC15 list (navigation origins, egress hosts, `auth.frameOrigins`, secrets and their fields
and origins, Messages senders, request declarations grouped by purpose, side-effect raises and
new destructive tools, `cookieDomains` and storage keys, every loosening of `limits`), add the
missing kinds and a test for each, and check `ReviewUpdate.tsx` shows each one.

### 4. First-run onboarding

AC2 and AC3 describe a first run that doesn't exist yet: there is no onboarding screen. Build
it against the fakes, following the [mockups](mockups/index.html):

1. paste the 1Password service-account token (to the Keychain through the existing credential
   path; the onboarding never writes it to disk), or choose the Keychain copy from D6 once the
   credentials thread merges;
2. choose the vault;
3. approve the bundled Woolworths adapter with its permission summary;
4. grant the `login` secret by picking an item, with origins exactly
   `https://auth.woolworths.com.au`;
5. connect Claude Code (HTTP and token) and Claude Desktop (the Swift stdio bridge), each with a
   copy button.

Every step uses the fake credential provider in tests; a desktop e2e spec walks the whole flow.
Coordinate with the credentials thread on step 1: build against the provider interface and the
service-account path first, and add the Keychain-copy choice when that thread's PR is merged.

### 5. Structured confirmations (C4)

`confirm(message: string)` in `packages/core/src/adapter.ts` still takes adapter-authored text
([gap G4](plan.md#g4-confirm-takes-adapter-authored-text)). Change it to a structured action
description the runtime renders, with free text as an optional, attributed note, bump the core
contract version, update the runtime's confirmation broker and `Confirmation.tsx`, and keep the
existing confirmation tests passing against the fake site. Not urgent for v1 (no irreversible
tools, D18) but it is M3 scope and it changes the adapter contract, so it is cheaper now.

### 6. Manifest-derived MCP annotations (C9)

Today `packages/mcp-server/src/server.ts` advertises every write as destructive and
non-idempotent. Add `destructive` and `idempotent` to tool declarations (C9), derive the MCP
annotations from them, and set them in the Woolworths manifest so `set_cart_quantity` is
`destructiveHint: true, idempotentHint: true` as AC3 says. Leave `add_to_cart` advertised as
destructive: whether to relax it is [D30](plan.md#d30-split-add-to-cart), which Nick hasn't
answered. The approval diff (item 3) must flag a tool that becomes destructive, so rebase on 3.

### 7. Tool code out of the main process

The plan's state table says tool code still runs in Electron's main process, behind the guarded
page, and moving it is M3 scope (the full sandbox is M7, [D12](plan.md#d12-sandbox-technology)).
Run each adapter's tool code in a `utilityProcess` with only the capability API over a message
port, so a crash or hang in tool code can't take down the app and tool code has no `require`,
no file system and no Electron. Keep the runtime free of Electron imports (the "only two modules
import Electron" rule), extend the hostile-adapter suite with escape attempts from the new
process, and keep both e2e suites green. Read
[registry-and-sandbox.md](registry-and-sandbox.md#the-sandbox) first so this is a step towards
M7's design, not a detour.

### 8. Release command dry run

AC18 asks for one command that builds, signs, notarises, staples and publishes. The release path
is written but has never run. Make it runnable end to end in CI with an ad-hoc signature, a
throwaway Ed25519 feed key generated in the job, and notarisation and publishing replaced by
explicit dry-run stubs that print what they would do. Real signing, notarisation and the feed
key ([D61](plan.md#d61-the-update-feeds-signing-key)) stay with Nick. Done when a CI job produces
an ad-hoc signed DMG and a verified feed envelope from the one command.

### 9. Drift detection against fixtures

M4's drift detection: parse every recorded Woolworths fixture and fake response with the
adapter's zod output schemas, add a "site changed" error class that a schema failure maps to,
and write the gated live smoke test that would run the same checks against the real site. The
gated test must skip unless an explicit environment flag is set, and is only run with Nick.

### 10. Audit rotation and trace retention (D27)

Build [D27](plan.md#d27-retention)'s recommendation, which Nick hasn't answered yet but which
loses nothing if he changes it: the audit log is never deleted; rotation starts a new file whose
first record commits to the previous file's last hash, and the verifier (item 2) follows the
chain across files. Traces and screenshots are kept 14 days by default, configurable in settings.

Built: see the note under [D27](plan.md#d27-retention).

### 11. Remote mode, first slice

Nick wants agents in the cloud to reach Valet, with remote mode straight after M3 and as little
duplicated code as possible. Build only the parts every option in [relay.md](relay.md) needs:
the separate listener with its own guards, the per-tool remote policy (default deny), remote
calls marked in the audit log, and the kill switch in the tray, all sharing the local server's
tool path. Don't build the OAuth authorisation server or any tunnel tonight; relay.md's open
questions about where it lives are still Nick's.

### 12. Woolworths terms read, for D25

[registry-and-sandbox.md](registry-and-sandbox.md#the-legal-shape-as-understood-not-advice)
marks Woolworths' terms on automated access _verify_. Read the current
`woolworths.com.au/shop/services/terms-and-conditions` page (one anonymous page load, not from
Nick's IP, or a search engine's copy) and record the exact clauses on robots, automated access
and personal use in `docs/findings/`, with the date. Note that the Woolworths Group corporate
site's terms (clause 1.3(b)(v), "any robot, spider, site search and retrieval application or
other mechanism") cover only `woolworthsgroup.com.au` and don't settle the question for the
shopping site.

## Waiting on Nick in the morning

Nothing above needs him. What does, in plan order:

- the three M2 live sessions in [m2-runbook.md](m2-runbook.md) (spike 1, the rest of the Auth0
  flow and the checkout paths, then the first automated login);
- the first Developer ID signed build and notarisation;
- answers on [D27](plan.md#d27-retention) (how long to keep traces), [D30](plan.md#d30-split-add-to-cart)
  (whether an add-only cart tool may be advertised as non-destructive so clients can auto-approve
  it) and [D68](plan.md#d68-what-the-tray-counts) (whether the tray counts clients or open
  sessions), each of which a thread above works around rather than decides.
