# Whole-project review: what was missing

2026-11-10. One pass over the repo, the plan, the project files, CI and the open threads, looking
for what nobody had covered. The plan is thorough on the security model and on the live Woolworths
risks. What it under-serves is everything around a working app: what the agent is told, what
happens when the app misbehaves with nobody watching, and who keeps it current.

Each item says what was checked. "Not in the plan" means a search of `docs/` found nothing.

## Fixed in this pass

1. **Nothing told the agent how Valet behaves.** Calls are paced 10 s apart
   ([D28](../plan.md#d28-rate-budget-defaults), answered) and run one per site at a time, but the
   MCP server sent no `instructions` and no progress. An agent that calls in parallel queues
   behind itself, and one whose call timed out may repeat a write. Now `initialize` carries fixed
   instructions, and a running call sends a fixed progress notification every 10 s to a client
   that asked (PR #28; WS4 item 5 and part of
   [D50](../plan.md#d50-confirmation-and-hand-off-timeouts), which Nick hasn't answered).
2. **The app left no trace of its own failures.** Everything the main process said went to stderr,
   which a packaged menu-bar app doesn't have, and nothing handled an uncaught exception. The
   plan puts "local crash reports" in M4, after M3's two weeks of real use, which is the period
   that needs them. Now `logs/valet.log` records starts, stops, updater states, runtime
   diagnostics, dead processes and crashes, as fixed text and stack frames with no error
   messages; and after an uncaught exception the app stops (and restarts once if it had been up a
   minute) instead of running on.
3. **CI trusted moving tags and brand-new packages.** The workflow's actions were pinned to tags,
   which can be moved, in the jobs that build what the release command signs. They are now pinned
   to commits. `pnpm` now refuses a version younger than three days when the lockfile changes.

## Not fixed: needs Nick

4. **"Merge on green" isn't mechanical.** Threads merge by remembering to. PR #17 sat green for
   three days because one didn't. Two repository settings fix the cause: a branch protection rule
   on `main` requiring the four CI jobs (`check`, `e2e`, `swift-bridge`, `release-dry-run`), and
   "Allow auto-merge". Then every thread turns auto-merge on when it opens a PR and GitHub merges
   it. About two minutes in Settings; a thread can't change repository settings.
5. **Which store are the tools quoting?** Woolworths prices, specials and availability follow the
   delivery address or pick-up store. Valet's browser profile is a new device to the site. Not in
   the plan, the runbook or the adapter. If the automated session has no store, or a default one,
   `search_products` and `get_cart` can disagree with what Nick sees in Chrome. Added to Session 3
   of the [M2 runbook](../m2-runbook.md) as a check; it may need a read tool for the current
   fulfilment and a line in the instructions.
6. **A sleeping Mac.** AC8 covers a locked Mac. A Mac that is asleep runs nothing, and with remote
   mode the agent is in the cloud and can't tell. Not in the plan beyond the relay's error text.
   The choice: accept it, or keep the Mac awake on mains power while remote access is on (one
   `powerSaveBlocker` call), with a setting.
7. **R13's mitigation has lapsed.** The risk register answers "agent-built code nobody fully read"
   with Nick reading `core`, the guards and the secret filler line by line. The project rule since
   2026-11-07 is that PRs merge without his review. Both can't hold. Either that read happens once
   before the first live automated login (Session 3), or the register should say the security
   suites and an agent red-team pass are the mitigation.

## Not fixed: buildable without Nick

8. **A queued call waits without bound.** `ToolHost.execute` waits for the adapter lock with no
   limit, then each request waits for its 10 s slot. Six parallel calls put the last one more than
   a minute behind, past any 60 s client timeout, and the cancelled call's slot is still spent.
   The instructions now ask for serial calls; the fix is a bounded wait that answers "try again in
   N seconds" with the real queue length.
9. **The rate budget forgets across a restart.** The breaker is persisted; the budget's next slot
   is in memory. A restart (an update, or the new crash restart) can put two requests under 10 s
   apart. Persist the last request time beside the breaker.
10. **Nothing notifies Nick.** A hand-off, a confirmation, an opened breaker and a waiting update
    all show a window or a tray state. There is no system notification anywhere in the app
    ([D52](../plan.md#d52-confirmation-panel-placement) recommended one that only opens the
    window; unanswered). With him at another screen, a `needsUser` waits until the hand-off
    window times out.
11. **Nobody owns staying current.** No Dependabot, no scheduled audit, and Electron ships a major
    every eight weeks (R16). For Valet this is more than hygiene: the user agent carries the real
    Chromium major, so an old Electron is an old Chrome, which is itself a bot-detection signal
    (R1), in a browser holding a logged-in session. Suggest a monthly thread that bumps Electron
    and dependencies in one reviewed PR, not auto-merged bot PRs.
12. **The MVP bar is unmeasured.** The MVP is done when Nick prefers Valet to his existing grocery
    skill, but nothing times a whole shop. At 10 s a request, thirty items is thirty searches and
    a write: six minutes at best. A benchmark of a thirty-item shop against the fake site at real
    pacing gives the number today, and the cheapest speed-up is fewer calls: saved lists or past
    orders (`list_past_orders` is a stretch goal), not a shorter gap.
13. **Client timeouts are still a guess** (D50 says to measure them in M2; the runbook has no step).
    Claude Code's and Claude Desktop's tool-call timeouts decide whether a cold `get_cart` with a
    login (30–40 s) and an SMS code (up to 60 s more) can finish in one call.
14. **No way out.** No uninstall or reset: the login item, the Messages helper's launch agent, the
    Keychain copies, the data folder and the entries in Claude's config all stay behind. Needed by
    M8, and useful sooner for a clean re-test of first-run setup.
15. **Smaller.** The diagnostics log has no "show in Finder" in Settings. The audit page reads only
    the live file after a rotation (known, D27). The plan's AC2 still describes pasting a
    service-account token, which D6's answer (the Keychain copy) replaced.
