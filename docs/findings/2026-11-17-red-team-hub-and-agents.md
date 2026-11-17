# Red team: the hub, and agents using Valet's own tools

2026-11-17. One pass over `main` at 95ca411, playing the roles [red-team.md](../red-team.md) puts
first for agent-run Valet: a hostile or prompt-injected **agent** (any MCP client, local, through
the relay, or through the hub), and anyone on the internet who can reach the hub's open endpoints.
Nick's threat model ([agent-run-security.md](../agent-run-security.md#who-this-guards-against-first))
puts the agent first, so the stolen-phone and compromised-hub roles were not played.

Worked against code and local fakes only: no live Woolworths, no real 1Password, Keychain or
Messages, nothing on Nick's Mac, and the live hub only as its source. Out of scope because other
threads own them with their own red-team passes: the egress broker, secrets v2 and the Node
runtime.

## Summary

| #   | Severity | What                                                                        | State                                        |
| --- | -------- | --------------------------------------------------------------------------- | -------------------------------------------- |
| 1   | Medium   | Anyone could fill the hub's 100 client registrations for good               | Fixed, with tests                            |
| 2   | Medium   | One address could hold every waiting sign-in, and fill the person's list    | Fixed, with tests                            |
| 3   | Low      | An agent's feedback report could @mention anyone, in the person's name      | Fixed, with tests                            |
| 4   | High     | Agent feedback reaches Claude threads that can merge to main without review | Needs a decision                             |
| 5   | Low      | A draft's live trial sends requests from the person's own address           | Known and accepted (noted for the record)    |
| 6   | Low      | A sign-in code redeemed twice at once could mint two token pairs            | Not a hole: needs the client's PKCE verifier |

## 1. Medium: the hub's client registrations could be used up for good (fixed)

**Who:** anyone who knows the hub's address, an agent included (every agent signed in at the hub
has it).

`/register` (Dynamic Client Registration) takes anyone, up to 100 clients in all, and the hub
never forgot a client. The front door's sign-in limit is 20 requests a minute per address, so one
address could register 100 clients in five minutes, and from then on no new agent could ever
sign in at `valet.dncr.me` until someone cleared the table by hand. Agents already signed in kept
working; a new connector, or one that re-registers after losing its client id, could not.

The Mac's own authorisation server already guarded against this (`oauth-clients.ts`: unconsented
registrations expire after an hour, per-source and global limits); the hub's port of it didn't.

**Fix** (`apps/relay/src/hub/oauth.ts`):

- A registration with no token and no sign-in on record is forgotten an hour after it was made
  (`UNUSED_CLIENT_MS`), on the same sweep that drops expired tokens. A client with tokens stays.
- One address may register at most 20 clients an hour (`registrationsPerSourcePerHour`), so one
  address can't reach the cap at all.
- Registrations now record their source; a hub made before this gets the column on start.

Tests: "forgets unused registrations, and limits what one address registers" in
`apps/relay/test/hub-oauth.test.ts`, which failed before the fix.

## 2. Medium: one address could hold every waiting sign-in (fixed)

**Who:** as above.

At most 20 sign-ins may wait at once, across everyone. One registered client could open all 20
from one address, and open them again every ten minutes, so no real agent could start a sign-in.
Every one of them also went to each of the person's Macs as "asking to connect", under a client
name the attacker chose (`Claude`, `Valet security check`), which is the approval fatigue the
broker's limits exist to stop. Approving one still needs the code from the browser that opened it,
so this couldn't get an agent in; it could only lock agents out and nag.

**Fix:** at most 5 waiting sign-ins per address (`openConsentsPerSource`) and 3 per client
(`openConsentsPerClient`), under the old overall 20.

Test: "lets one address, and one client, hold only a few sign-ins open".

**Residual:** an attacker with many addresses can still fill both caps. That costs them real
infrastructure, and the hub has one account. If it matters later: tie registration to something
the person did (a link from the Mac, or the claude.ai connector's redirect host on an allow-list).

## 3. Low: an agent's feedback could @mention anyone, in the person's name (fixed)

**Who:** any agent with Valet's own tools (every local client, and cloud agents with See Valet).

`valet_send_feedback` files a GitHub issue with a token Valet holds. With no Keychain token, that
is the person's own `gh` sign-in, so the issue is written as Nick. The report's body was scrubbed
for secrets but sent as Markdown, so `@someone` notified any GitHub user or team, and
`other/repo#1` or an issue URL left a "mentioned this" line on any public issue: a prompt-injected
agent could spam or harass in Nick's name, up to 50 reports a day.

**Fix:** `quietMentions` in `apps/desktop/src/main/core/feedback.ts` puts @mentions,
`owner/repo#N` references and GitHub issue and pull request URLs in code spans, where GitHub
neither notifies nor links. It runs on every title, body and follow-up.

Tests: `quietMentions` in `apps/desktop/test/main/feedback.test.ts`, including what reaches the
fake GitHub.

## 4. High (design): agent feedback reaches threads that merge without review

**Who:** any agent with Valet's own tools, or a page, adapter or site that steers one.

The path today: an agent files a report (`valet_send_feedback`) → an issue in `valet-feedback` →
a GitHub Action → a routine that posts "Agent feedback arrived" in the project chat → the
coordinator reads the issue and starts or messages a Claude thread to act on it. Those threads can
push to `njdancer/valet`, and PRs merge on green CI with no human review (D71). Valet then runs
that code on Nick's Mac.

So the report's text is the only thing between "an agent Nick connected" and "a code change that
ships", and report text is exactly what a prompt-injected agent controls. Each Claude here treats
issue text as data, which is the main defence and a real one; but it is the only one, and an
injected report doesn't need to give orders. It only needs to describe a plausible "bug" whose
"fix" weakens a check (an egress host check that "wrongly refuses" a host, a scrubber that "eats
legitimate text").

Nothing here is a code bug, so nothing was changed. Options, cheapest first:

1. **Label provenance and keep it in front of the threads.** The coordinator's note to a thread
   says the issue is untrusted agent text, and a fix that touches a critical path
   ([red-team.md](../red-team.md#the-critical-paths)) gets the adversarial review that page already
   requires. Mostly a routine and coordinator instruction; costs nothing.
2. **Don't auto-merge feedback-driven changes to critical paths.** A PR that says it came from
   agent feedback and touches a critical path waits for Nick, or for a second agent's review that
   is given the diff and not the issue.
3. **Stop the loop.** Feedback goes to Nick as a digest and threads start only when he says so.
   Safest, and it costs the hands-off loop Nick asked for.

Recommendation: 1 now, plus 2 for critical paths only.

## 5. Low: a draft's live trial runs from the person's own address (known)

An agent can write a draft whose manifest declares any public host, and run a paced live trial at
Notify tier. A trial runs read tools only, signed out, with no local access, behind the site's
own rate budget and breaker, at most 6 an hour per draft (`drafts/trial.ts`). What's left is that
the requests come from Nick's home address, so an agent in the cloud could use Valet to reach a
site that blocks cloud addresses. This is the design (trials are Notify tier in
[agent-run-security.md](../agent-run-security.md#approval-tiers)); it is recorded so a later pass
doesn't rediscover it. Whether a trial may reach private addresses was not checked in this pass.

## 6. Not a hole: a code redeemed twice at once

`redeemCode` checks a code is unused, awaits the PKCE hash, then marks it used, so two redemptions
racing in the same Durable Object could both succeed. Both need the client's PKCE verifier, which
only the real client has, so the "second" holder is the client itself. Refresh tokens are checked
and marked with no await between, so their reuse detection holds.

## Tried, and held

- **Hub, agent at `/mcp`:** a token for one grant used after the grant went (the hub checks the
  grant row on every request; the Mac checks the grant against its own verified device list on
  every forwarded request, `phones.ts`); a hub agent asking for Valet's own tools (hub clients have
  no registration on the Mac, so `remoteCapabilities` gives them none); a tool name that names
  another node (`<slug>__` is matched exactly; the node gets only its own tool name); an `id`
  chosen to collide with the hub's own `init` or `list-N` (each forwarded request is its own POST
  and session).
- **Hub, sign-in:** typing a code into another sign-in's card (the code picks the consent; it is
  never shown on the Mac); a consent's code collected by another browser (cookie-bound, hashed);
  a redirect outside the registered list, `http` off loopback, a fragment or userinfo; a client
  name with control or bidi characters (stripped, and checked again as display text in the grant);
  a resource other than `/mcp`; a reused code or refresh token (everything from that consent is
  revoked); hub API changes from another origin (Origin checked, JSON only).
- **Mac, admin writer:** an agent choosing its own tier (the Mac's `widens` decides); turning a
  tool off for another client; seeing or withdrawing another agent's requests; changing a setting
  that both tightens and loosens (refused unless it only tightens, checked again against the held
  value); the Notify limit (a slot is taken before anything runs).
- **Mac, scratch browser:** a manifest home of `127.0.0.1` or a LAN host (pages must be `https`
  on the draft's domains; every connection is refused after resolution if it is private); a form
  POST (only GET pages open); response bodies with tokens (keys hidden, cookie values replaced).

## Not tried yet

- The iOS app's rendering of agent-written card fields (needs a Mac and a simulator).
- The hub's passkey ceremony against a hostile authenticator.
- Slow or half-open sockets to the hub's `/mcp` from an agent (Workers limits apply, untested).
