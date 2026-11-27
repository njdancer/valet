# Per-agent access to Mail, Calendar and Reminders

Each agent, whether an app on this Mac (`local:<id>`) or a cloud agent (`remote:<id>`), has its
own record of what it may use in the Mac's own apps. It covers each Mail account, calendar and
reminder list, at one of three levels (and, for a cloud agent, its tools: see below):

| Level | Mail                                            | Calendar                                        | Reminders                                  |
| ----- | ----------------------------------------------- | ----------------------------------------------- | ------------------------------------------ |
| Off   | The account doesn't exist for this agent        | The calendar doesn't exist for this agent       | The list doesn't exist for this agent      |
| Read  | Search, read and thread its messages            | See its events                                  | See its reminders                          |
| Edit  | Read, plus drafts, moves and marks. Never sends | Read, plus adding, changing and deleting events | Read, plus adding, changing and completing |

The person chooses these on the agent's page in Connections (the **What it may use** card). Settings › Mail, Calendar and Reminders only set the apps up and list what is on the Mac.
Nothing there gives any agent anything (Nick, 2026-11-25: one access tree per agent, replacing the
per-app pickers, the Writes and Drafts switches, and the per-agent switches on those pages).

## A cloud agent's tools

The same card lists, for a cloud agent, every tool it could be given: each approved site's, then
Valet's own that remote access offers (the agents' browser's `browser_` tools, Messages'). Each is
Off or On, and every one is Off until the person turns it on. Its grant still holds them
(`remote-clients.json`), so a tool is callable only while it is in the grant and on for cloud
agents. A tool the grant names that Valet no longer offers (a site since removed) is shown, and
can only be taken away. An app on this Mac has no tools here: it has every approved site's tools
unless it turned one off for itself.

## One Touch ID per Save

Changes on the page are a draft until **Save**. A Save that adds anything is one `agent-access`
approval listing every item it adds, at the level it adds it, and every tool it turns on, at the
site's version and the tool's side effect, so one Save is one Touch ID however many items and
tools it changes. A Save that only takes things away needs no prompt. If the prompt is
cancelled, nothing changes, the narrowing parts included.

The broker's `agent-access` handler re-checks the subject before applying it: the agent still
exists (an approved cloud agent, or a local app that isn't revoked), and each item is still on the
Mac, with Edit only on one that can change (not a subscribed calendar). Each tool must be a cloud agent's, at the version and
side effect signed for (`BUILTIN_TOOLS_HASH` for Valet's own), and never one of Mail's, Calendar's
or Reminders' own, which follow from the items. It then raises only what was signed: a tool is
turned on for cloud agents if it wasn't, then added to this agent's grant. The Save writes the rest
of the change, which only narrows.

`agent-access` also carries `full` and `capabilities` fields for later steps (adding and removing
whole calendars, See Valet and Ask for changes). Nothing asks for them yet, and the handler refuses
a subject that names any.

## Agents ask, with a reason

An agent asks for more with `valet_request_access`: Read or Edit on one account, calendar or list,
named by its id or by its exact name (any case), and always with its reason. The person gets an
`agent-access` request for that agent alone, on the Mac's Needs you and the phone, with the
agent's reason under "The agent says". Every item with that name is on the one request, so an
agent never needs an id it can't see. Approved, the agent has it, and its tool list refreshes. An
agent already at that level is told nothing changed, and an item that isn't on the Mac (or Edit on
one that can't change) is refused without asking.

Valet never asks on an agent's behalf. A refused call names the request to make instead: a change
to a list the agent may only read says to ask for Edit, and the listing tools say to ask for an
account, calendar or list the person names that isn't there.

## Which tools an agent holds

Mail, Calendar and Reminders list every tool while the app is on. Which of them an agent holds
follows from its record, not from per-tool switches:

- the reading tools while it may read anything in that app;
- the changing tools while it has Edit on at least one item there.

A local app's missing tools are added to its turned-off set (`localToolsOff`). A cloud agent's are
answered by `RemoteAccess.allows` through the `appTool` hook, and a revoked cloud agent holds none
whatever its record still says. Every call is checked again against the calling agent's own
record, so an agent can't reach another agent's calendar by naming its id. A list an agent may only
read answers a change with `read-access-only`, rather than that the list doesn't exist.

When an agent's record changes, the tool lists refresh and a cloud agent's open sessions close,
so its next session lists the new tools (claude.ai never reads the list-changed notice).

## Storage and migration

The records live in `agent-access.json`, as JSON that isn't signed, like the per-app pickers they
replace. A file that doesn't validate reads as nobody having anything. Revoking an agent forgets
its record, so an agent added again starts with none.

The first start with per-agent records seeds them once from what each agent could reach before:
the picked items, at Edit where the app let agents change things and the agent held a changing
tool, otherwise at Read. Nothing widens, so nothing is signed. After that the seed never runs again.
