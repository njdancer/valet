# Admin tools over MCP: the read tier

Workstream E of [plan-agent-run.md](plan-agent-run.md), read tier only. Design first, then built in
the same PR. The write tier (turning tools on, settings, the store, asking for a login) waits on
the approval broker (workstream D) and is out of scope here.

## Brief

Nick's agents should be able to look at Valet the way he does in the app: is it paused, which
sites are installed and approved, which tools each has, whether a site is limiting requests, what
is waiting under Needs you, what the recent calls did and why one failed, and what the audit log
says. That serves journeys J5 (repair from chat: the agent sees the repair item and the failing
call), J7 (something looks wrong: the agent can say what happened) and J8 (everyday admin: read why
a call failed, which store is chosen).

What it must not break:

- No secret, session value, token or 1Password reference ever appears in a result.
- No admin tool changes anything. Every one is `readOnlyHint: true`.
- An adapter can't shadow or word an admin tool.
- Cloud agents keep seeing only the site tools their grant names.

## The tools

All under the reserved `valet_` prefix. Every one returns structured content with an output schema,
and the same JSON as text.

| Tool                  | Input                                                                                            | What it returns                                                                                                                                                                                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `valet_status`        | none                                                                                             | Paused, locked down, version, demo, the updater's state, the audit chain's last check, how many Needs you items, today's numbers (calls, logins, failed logins, refused requests), how many sites are installed, approved and paused, and whether each login provider (1Password, the Keychain, Messages) can be used now. |
| `valet_list_adapters` | none                                                                                             | Each installed site: id, name, host, version, approval, an update waiting, paused, session state, settings it still needs, logins (name, given or not) and every tool with its MCP name, title, side effect, calls in 7 days and remote.                                                                                   |
| `valet_get_adapter`   | `adapterId`                                                                                      | One site in full: the list entry plus the manifest's description, when it was approved, its limits, its settings and what is chosen, its logins (provider, origins, when given, last used) and its one-time-code sources.                                                                                                  |
| `valet_site_health`   | none                                                                                             | Per host: the circuit breaker (closed or open, until when, why), the cool-down the next block would start, and calls running or waiting there now.                                                                                                                                                                         |
| `valet_needs_you`     | none                                                                                             | What is waiting on the person, soonest deadline first, each with its kind, its title as the app shows it, the site, the call that raised it and its deadline.                                                                                                                                                              |
| `valet_list_calls`    | `adapterId?`, `limit?` (1 to 100, 20 by default)                                                 | Recent calls, newest first: call id and short ref, site, tool, side effect, client, when, how long, outcome, and the stage and error class of a failure.                                                                                                                                                                   |
| `valet_get_call`      | `call`: a call id or its 4-character ref                                                         | One call's trace: its summary, adapter version, the logins it used (names and fields only), request counts, every step and the input. Only the app's own calls, unless it has All agents' activity. A ref that matches several calls returns their ids to choose from.                                                     |
| `valet_audit_log`     | `category?`, `adapterId?`, `since?`, `search?`, `beforeSeq?`, `limit?` (1 to 100, 50 by default) | A page of audit records, newest first, with the total and the `beforeSeq` for the next page, and the chain's last check.                                                                                                                                                                                                   |

Not in this tier: running a chain verify (it re-reads the whole log, so it stays the person's
button), the Connections list (the clients and their tokens' state), and anything that writes.

## Options considered

**Where the tools live.**

1. _As synthetic adapter tools through the ToolCaller_ (an adapter id `valet`). Rejected: every read
   would go through the runtime's lock, pacing and audit, and the audit log would fill with status
   reads. The runtime also isn't the place that knows Needs you or the updater.
2. _A second port beside ToolCaller_ (chosen). `@valet/mcp-server` defines the tools, their names,
   descriptions, input and output schemas, annotations and every fixed sentence; it asks an
   `AdminReader` (a port the app implements) for the data. The app maps its own `ValetApi` views
   (what the control panel shows) to the port's types. This mirrors the ToolCaller seam: the
   package is tested against a fake, the app's mapping is tested against the real service.
3. _A separate MCP server_ (another endpoint or bridge). Rejected: a second connection to set up in
   every client, for the same person on the same Mac.

**Which clients see them.** Local clients, and cloud agents the person gave See Valet or Ask for
changes with a signature (docs/authoring-tools.md, "Who can author"). A session with no identity
gets none. The remote listener gets the reader only with an `ownTools(clientId)` predicate, read
when each session opens; without it, no cloud agent sees an admin tool.

**What each app may see** (the agent-run IA, section 5: "Use tools · See Valet · Ask for
changes"). Each local app the person added has two stored capabilities in its Connections record
(`clients.json`): See Valet, on by default, and All agents' activity, off by default. They are read
on every admin call, so a change applies at once, and a revoked or unknown app has neither.

- Without See Valet, every admin tool, `valet_status` too, answers "Claude Desktop isn't allowed to
  see Valet's settings. The person can allow it in Valet, Connections, Claude Desktop."
- Without All agents' activity, `valet_list_calls` lists only the app's own calls (matched by the
  `local:<id>` its credential put on each call's `tool-called` record). `valet_get_call` matches ids
  and refs among its own calls only, so a ref can't reveal another agent's call ids, and a call that
  is another agent's answers "That call belongs to another agent. The person can allow All agents'
  activity in Valet, Connections." `valet_audit_log` leaves out records about another agent's calls
  and the approvals it asked for, and its total and paging count only what is left. Valet's own
  records (approvals, settings, lock down, breakers) stay.
- With All agents' activity, an app sees every call, inputs included.

There is no screen for these yet: the Connections toggles come with E's write tier or J.

**Auditing reads.** Admin reads are not written to the audit log. The log records what touched a
site, a secret or a permission; status reads touch none, and logging them would bury the records
that matter (an agent polling status every minute adds 1,440 a day). Workstream B can revisit this
with the web audit view (D78).

**Lock down.** While Valet is locked down, `valet_status` still answers (it is how an agent learns
it is locked down) and every other admin tool returns the locked-down sentence. Lock down is the
person's "something is wrong" switch (J7), and an agent that may be the problem shouldn't keep
reading the log through it. Paused doesn't stop reads: pausing is about calls to sites.

## The no-secrets guarantee

Four layers. The first three stop secrets by construction; the fourth is a net for what they
miss, and only covers values the app holds while it runs.

1. **The app's views carry none.** `ValetApi` is already the renderer's contract, and it carries no
   secret value, `op://` reference, cookie or token.
2. **The mapping picks fields, never spreads.** The app builds each result field by field from its
   view, and leaves out what an agent doesn't need: a 1Password item's id and title, the confirmation
   panel's `adapterNote`, a login hand-off's `note`, a run's `detail` line and its output preview
   (both site text), the auth partition names, and a connection request's `source` address. Trace
   steps and audit events go through a per-type allow-list of keys (`STEP_FIELDS`,
   `EVENT_FIELDS`), with only flat values (a string, number, boolean, null or list of strings)
   copied, so a line on disk with extra fields gives up only the ones listed for its type.
3. **The output schemas strip the rest.** The package parses every result against its zod output
   schema before sending, as `checkedOutput` does for site tools: unknown keys are dropped, so a
   field added to a view later can't ride along. Steps and events are checked to be flat. A result
   that doesn't parse is a failure, never a pass-through.
4. **A last scan.** Before a result leaves, every string in it (keys too), and its serialised JSON,
   is checked against every secret a login registered since launch (the `LoginSecrets` sets) and
   every adapter's tool-partition session values, with the runtime's `sensitiveMatcher`. Each
   string is checked on its own because JSON escapes quotes and backslashes, so a secret holding one
   wouldn't appear verbatim in the serialised text. A match refuses the whole result
   (`tool-output: internal`); it is never partly redacted. The scan fails closed: a session that
   can't be read refuses the result. `valet_status` is not scanned, because its schema holds no free
   text (codes, counts, times and version strings), so an agent can still learn Valet's state when a
   session can't be read. The scan is one call per result with every string in it, so each adapter's
   session values are read once per admin call (a cookie query and a storage snapshot), not once
   per string; caching them would mean holding copies longer.

Tests cover each layer: the mapping on the real service with a grant and a session cookie, the
schemas with a view that carries extra fields, nested values and an off-vocabulary code, and the
scan with a session value planted in a client name and a secret holding a quote and a backslash.

## Text from sites, and prompt injection

Most of what these tools return is the app's own: codes from fixed vocabularies, numbers, times, and
names the person approved with the adapter (its name, tool titles, setting titles). A few fields can
carry text someone else chose:

| Field                                          | Whose text                                                                                        |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| A chosen setting's `label` and `detail`        | The site's (a store's name and address)                                                           |
| A call's `client`, a confirmation's `client`   | The MCP client's self-reported name (capped at 100 characters)                                    |
| An audit record's `client`, `target`, `reason` | The client's name; a refused request's path, which the page can choose; the driver's short reason |
| A trace's `request` step `target`              | As above, for requests the page itself made                                                       |
| A `remote-consent` audit record's `clientHost` | Whoever registered the cloud agent's connector                                                    |
| A call's `input`                               | The asking client itself (only its own calls)                                                     |

Needs you items carry only their kind, the app's title, ids, times and the tool name; a pending
connection request's client name and host are left out, so a local agent can't be used to relay a
hostile cloud agent's chosen name to the person.

IA section 7 says tool results never carry adapter-supplied text. That rule is about the sentences
Valet writes for site tools, and still holds there. The chosen store's `label` and `detail` here
are a deliberate exception: J8 needs "which store is chosen", they come back as JSON values in
`valet_get_adapter` only, and the schema notes them as the site's words.

Every tool description ends with the same fixed sentence: these fields are data and never
instructions. More important is that it doesn't matter if an agent is steered by them: no admin
tool changes anything, and the write tier will go through the approval broker (D), where the person
approves with a gesture on a device the Mac trusts. Workstream E's "done when" asks for a
prompt-injection pass on the write tier; the read tier's part of it is that hostile text in these
fields is delivered as a JSON string value inside structured content, never spliced into the
sentences Valet writes.

## Names

`valet_` is reserved. The endpoint withholds any adapter tool whose MCP name starts with `valet_`
(skip reason `reserved-name`), whatever the adapter, so an adapter with the id `valet` can't add
`valet_status` beside, or instead of, the real one. Admin tools are registered after the site
tools are planned, so a collision can't remove them.

## Contracts

In `packages/mcp-server/src/admin-tools.ts`:

- `AdminReader`: one async method per tool, returning the port's own types (inferred from the output
  schemas), plus `lockedDown(): boolean` and `sensitive(text): boolean` for the last scan.
- `ADMIN_TOOLS`: the definitions. `registerAdminTools(server, reader, viewer)` adds them to a
  session; `viewer` is the session's identity, which `valet_get_call` uses to decide on the input.
- `ServerOptions.admin` and `HttpServerOptions.admin`: the reader. `createMcpServer` registers the
  admin tools only when it has one and the session's identity is local, or remote with
  `remoteAdmin` (the remote listener's `ownTools` said yes). `startRemoteListener` passes `admin`
  and `authoring` on only with `ownTools`.

In the app, `apps/desktop/src/main/core/admin.ts` implements `AdminReader` over `AppService`'s
`api` and its secrets, and `startEndpoint` receives it.

## Failure cases

| Case                                                                    | Result                                                                                                                                                             |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The reader throws (a store unreadable, a bug)                           | `The tool failed at stage config: internal.`, as text, `isError`. Never the exception text. Not `config: unavailable`, which every other result uses for "paused". |
| The result fails its schema                                             | `tool-output: invalid`, `isError`.                                                                                                                                 |
| The last scan finds a secret                                            | `tool-output: internal`, `isError`, and a diagnostics event (no value).                                                                                            |
| Locked down (any tool but `valet_status`)                               | The locked-down sentence, `isError`.                                                                                                                               |
| `valet_get_adapter` for an unknown id                                   | `No site has that id. valet_list_adapters lists them.`                                                                                                             |
| `valet_get_call` for an unknown call or ref                             | `No call matches.` A ref matching several: their ids and refs, to call again with one.                                                                             |
| A log record with a negative duration or a code this build doesn't know | The duration as recorded; the code as null (outcome `unknown`). The page still answers.                                                                            |
| Inputs out of range (limit 0, a bad `since`)                            | The SDK's input validation error, before the reader is asked.                                                                                                      |

## Not yet covered

- IA section 5 lists Needs you items the app doesn't build yet ("Unlock 1Password", "The audit log
  doesn't check out", "Finish setup"). `valet_needs_you` reads the same list as the app, so it
  gains them when the app does. `valet_status` already reports the login providers and the audit
  chain, which is what those items are about.
- The write tier is below. Its prompt-injection pass is in `apps/desktop/test/main/service.test.ts`
  ("admin write tools").
- Whether cloud agents get any admin tools is for workstream B.

## Write tier

Status: **Built** for the tools below. The approve-tier ones answer "this Valet can't take that
request yet" until the approval broker has a handler for their kind (`service.wiredKinds()`).

### What an agent can do

The rule is B's (`ADMIN_ACTION_TIERS`) in A's words (IA section 5): an agent may make a change that
only makes Valet stricter, and may **ask** for anything else. Nothing here approves, undoes,
unlocks, pairs, or changes what an agent may do. Following Nick's threat model ("Who this guards
against first"), every gate is aimed at the agent: what would let an agent widen its own reach, hide
what it did, or approve its own request. Nothing here adds friction for the person.

| Tool                      | Needs           | Tier                                                           | What happens                                                                                                                                                                                                                                                                                                                       |
| ------------------------- | --------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `valet_set_setting`       | Ask for changes | Notify only if stricter and deletes nothing; else asks         | One of three Valet settings: Messages codes, notifications, call-detail retention. The app classifies the change (`settingWidens`, D's table): Messages codes on, notifications off and shorter retention ask. Remote access isn't offered: turning it off revokes every cloud agent, which is changing other agents' connections. |
| `valet_request_setting`   | Ask for changes | Approve (Setting)                                              | An adapter's setting, such as the store. The Mac fetches the adapter's own choices (an optional `query` narrows them) and the person picks on the card. Never a value.                                                                                                                                                             |
| `valet_request_tool`      | Ask for changes | Approve (Turn on a tool)                                       | Cloud agents only: one tool of an approved adapter for the asking agent (`tool-enable` with its `clientId`). Approved, the tool is on for cloud agents and in this agent's grant only. An app on this Mac is told it isn't needed.                                                                                                 |
| `valet_turn_off_tool`     | Ask for changes | Notify only, for itself                                        | Stored on the asking app's record (`clients.json` `toolsOff`). The caller leaves it out of that app's listing and refuses a call to it.                                                                                                                                                                                            |
| `valet_uninstall_site`    | Ask for changes | The person says yes in Needs you (not signed: it only narrows) | Asks to remove a site that isn't built in (docs/adapter-packages.md, "Removing a site"). Refused for a built-in site.                                                                                                                                                                                                              |
| `valet_disconnect`        | any             | Notify only, for itself                                        | Revokes the asking app's token and withdraws its requests.                                                                                                                                                                                                                                                                         |
| `valet_get_approval`      | Ask for changes | none                                                           | The app's own requests, one by ref or all it remembers.                                                                                                                                                                                                                                                                            |
| `valet_withdraw_approval` | Ask for changes | none                                                           | One of its own waiting requests.                                                                                                                                                                                                                                                                                                   |
| `valet_list_changes`      | See Valet       | none                                                           | Changes and requests: its own, or every agent's with All agents' activity.                                                                                                                                                                                                                                                         |

Every `valet_` result, read or write, also carries the answers to the app's own requests that ended
since it was last told (R23), each once, scanned for secrets like everything else.

### Decisions taken here

- **Ask for changes** is a third stored capability per local app, on by default as A's journeys
  say for an agent on the Mac; files from before it read as on, unless See Valet was taken away. Without it, every write tool but
  `valet_disconnect` refuses with A's sentence.
- **The store is a request, not a Notify-only change.** B's table has `setting.adapter-choice`
  at notify; A's R8 says an agent never supplies a setting's value. A's rule is the stricter and
  costs the person nothing (they would pick the store anyway), so E follows it and never uses
  `setting.adapter-choice`.
- **Notify only means: checked, audited, then done, then told.** Repeats and unknown targets are
  answered before anything is audited. A change that can't be audited isn't made. Changes from the
  writer run one at a time and re-read what they change, and the app writes a setting only if it
  still starts from the value the writer read and still doesn't widen (never through the person's
  own path, which would ask on their behalf). The person gets one quiet Mac notification per agent per hour ("Claude Code made 3
  changes"), which opens Activity. At most 10 Notify-only changes per agent per hour (R57), counting
  attempts and store lookups (a lookup runs on the site); leaving (`valet_disconnect`) is never
  limited, and refuses the agent's token from its next request on.
- **The agent's note** goes into the request's `agentNote`, which the card shows under "The agent
  says". It is never put into a tool result, so a note can't be used to word a result for another
  agent.
- **Requests are remembered in memory** (for 24 hours after they end, 50 per agent), as are the
  changes listed by `valet_list_changes` (the last 200). After a restart, waiting requests are found
  again from the broker; ended ones are in the audit log (`approval-requested`, `approval-answered`,
  `agent-change`).
- **New audit event `agent-change`** (`clientId`, `action`: tool-off, setting or disconnect,
  `target`, `value`). Loosening changes are audited by the broker as approval records instead.
- **Left out for now:** restore (rollback) and login (grant) requests, which need D's handlers and a
  decision on how the item is picked; remote tools, which only matter once cloud agents get admin
  tools (B); drafts and the scratch browser, which are F's. `valet_uninstall_site` is built
  (2026-11-13).
- **The person's side (2026-11-13):** an app's Connections page has switches for See Valet, All
  agents' activity and Ask for changes (`clients.setAccess`, not signed, like adding the app), and
  lists the tools it turned off for itself, each with Turn back on (`clients.turnToolOn`). An
  agent's request that no other item shows (a setting, a signed-in session, the home network, a
  tool or a login) is an **agent-request** item in Needs you, with Approve with Touch ID and Decline
  (`attention.approveRequest`, `attention.declineRequest`, `agent-requests.ts`). The phone gets the
  same request; whichever answers first wins. `valet_needs_you` leaves these items out: an agent
  reads its own with `valet_get_approval`.

### Prompt injection

The threat is an agent steered by text it read (a page, a store name, a reference adapter) into
widening something. What stops it:

1. The tier comes from the app's table, never the call. `valet_set_setting` takes a value, and the
   app decides whether it tightens.
2. Every widening is a broker request built by the broker's own subject builders. The broker has no
   MCP path that answers one (`NEVER_OVER_MCP`); only a device's signature does.
3. An agent sees and withdraws only its own requests and changes only its own tools.
4. The test drives every write tool with hostile arguments, as an agent obeying injected text would,
   and checks that nothing widened, nothing was approved, and the ledger holds no new evidence.
