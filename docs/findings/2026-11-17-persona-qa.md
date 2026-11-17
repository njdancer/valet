# Persona QA round (2026-11-17)

Four personas drove the demo build (fake Woolworths, fake 1Password "Keyhold", real MCP clients),
each as a scratch Playwright spec run side by side. Nothing touched a real site, 1Password, the
Keychain or Messages. Each failure became a fix with a regression test; an adversarial review of
the critical-path changes followed (its findings are fixed too). The scratch specs are kept in the
project files (`qa/2026-11-17-personas/`), not in the repo.

| Persona                  | Goal                                                                               |
| ------------------------ | ---------------------------------------------------------------------------------- |
| Priya, first-time user   | Setup end to end: 1Password, approve, login, store, connect Claude; ordinary slips |
| Sam's agent, shopper     | A weekly shop over MCP with messy queries, edits, retries and parallel calls       |
| Builder, authoring agent | Add a no-login tool to Valet from the tool texts alone, through to approval        |
| Morgan, cautious user    | Approvals, audit, pause, lock down, revoke; then the Mac's approval keys are lost  |

## Fixed

### Setup

- An app that connected stayed "Not connected yet" until it called a site tool. A client now counts
  as connected once it opens an MCP session.
- A wrong 1Password account name, or a declined Keyhold prompt, both read "Couldn't list the vault.
  Is 1Password set up?". The grant sheet now names the account it couldn't open, or says 1Password
  said no and offers Ask again. The account field's placeholder is an account name, not a URL.
- Turning the site down in setup was a dead end. A turned-down version can be reviewed again.
- The sidebar numbered 1 to 7 against "Step N of 5"; setup reopened at the welcome after an account
  name was typed; the Done page's grammar for one step left.
- The Claude Code command lacked `--scope user` although its text says "for your user".
- Store search: a postcode with spaces finds stores, no result hints what to type, focus stays put.
- In e2e mode "Add to Claude Desktop" wrote the developer's real Claude Desktop config.

### Authoring (agents writing adapters)

- The Mac's review of an agent's draft didn't show who asked, their note, the ref they were told,
  Valet's checks or their test counts; it said "Imported" at the app's launch time; a no-login
  adapter's review spoke of logins and session cookies; an update's Needs you card said its tools
  were off while the old version kept serving. The person can give a reason when turning one down.
- Manifest errors came one at a time with an empty path; JSON errors gave no position; a missing
  input schema said "convert: not representable"; failing cases hid what the tool produced or threw;
  the check budget gave no wait time; the guide and lint disagreed with the runtime about `page.goto`;
  live trials couldn't reach the demo shop, and a refused port read as a refused host.

### Shopping agents (Woolworths 0.5.0)

- `add_to_cart {"qty": 3}` silently added 1: unknown argument keys were stripped. Every site tool
  now refuses an undeclared key by name and advertises `additionalProperties: false`.
- Input refusals now say where and why from a fixed vocabulary (`items[1].stockcode: duplicate`).
- An unknown product id read as the site being unavailable; it is now an input refusal.
- A call queued behind a login waited 30 s to be told "busy"; it is now answered at once, "still
  logging in".
- Field descriptions, honest `remove_from_cart` (`wasInCart`), an out-of-stock notice, and a fake
  shop that stems plurals and suggests spellings.

### Control and audit

- Losing the Mac's approval keys looked like a first install. Old approvals still don't count, but
  Needs you now says the keys changed and lists what to approve and grant again; the review says
  "Approve again"; a grant that no longer counts no longer shows Ready.
- The person's own controls are audited: adding, resetting and revoking an app, changing its access,
  Pause Valet. A person's Decline is recorded as declined; a revoke or cancel as cancelled. Calls the
  MCP library refuses (unknown tool, bad arguments) are recorded, with a per-client budget.
- A revoked agent's open request is answered at once rather than hanging.
- The app page said "Has access" while locked down, counted sessions as apps, and listed a host twice.

### Also

- The nightly full run had failed every night since 12 Nov: `update.spec` still expected grants not
  to carry over an update that widens nothing (D47).

## For Nick's review

- Woolworths moves to 0.5.0 (stricter inputs, honest removals), so the Mac asks for a review of it.
- A Decline in the confirmation panel now counts toward the agent's decline cooldown.
- Revoking an app from the Mac now also withdraws its pending requests.
- Protocol refusals are recorded by wrapping the MCP library's `tools/call` handler (private API);
  the mcp-server tests catch it if a library update breaks that.

## Not done

- A local agent can't have one tool turned off by the person (only by itself, or the whole site).
- Shopping agents see Valet's ~40 admin and authoring tools before any site tool.
- Wording polish on setup and review screens ("manifest", "87 login steps", "0 irreversible" in red)
  was passed to the UI review thread.
- A decline sent from a paired phone still doesn't settle an open Mac confirmation panel.
