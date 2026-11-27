# Per-agent access to Mail, Calendar and Reminders

Each agent, whether an app on this Mac (`local:<id>`) or a cloud agent (`remote:<id>`), has its
own record of what it may use in the Mac's own apps. It covers each Mail account, calendar and
reminder list, at one of three levels:

| Level | Mail                                         | Calendar                                              | Reminders                                    |
| ----- | -------------------------------------------- | ----------------------------------------------------- | -------------------------------------------- |
| Off   | The account doesn't exist for this agent     | The calendar doesn't exist for this agent             | The list doesn't exist for this agent        |
| Read  | Search, read and thread its messages         | See its events                                        | See its reminders                            |
| Edit  | Read, plus drafts, moves and marks. Never sends | Read, plus adding, changing and deleting events    | Read, plus adding, changing and completing   |

The person chooses these on the agent's page in Connections (the **Mail, Calendar and Reminders**
card). Settings › Mail, Calendar and Reminders only set the apps up and list what is on the Mac.
Nothing there gives any agent anything (Nick, 2026-11-25: one access tree per agent, replacing the
per-app pickers, the Writes and Drafts switches, and the per-agent switches on those pages).

## One Touch ID per Save

Changes on the page are a draft until **Save**. A Save that adds anything is one `agent-access`
approval listing every item it adds, at the level it adds it, so one Save is one Touch ID however
many items it changes. A Save that only takes things away needs no prompt. If the prompt is
cancelled, nothing changes, the narrowing parts included.

The broker's `agent-access` handler re-checks the subject before applying it: the agent still
exists (an approved cloud agent, or a local app that isn't revoked), and each item is still on the
Mac, with Edit only on one that can change (not a subscribed calendar). It then raises only what
was signed. The Save writes the rest of the change, which only narrows.

`agent-access` also carries `full`, `tools` and `capabilities` fields for later steps (adding
and removing whole calendars, site tools, See Valet and Ask for changes). Nothing asks for them
yet, and the handler refuses a subject that names any.

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
