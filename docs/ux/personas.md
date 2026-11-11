# Valet personas

These personas drive the 2026-11 UX review and the QA rounds that follow it. Each QA round should
walk the app as every persona below, using the persona's own scenarios. They were written from the
plan (docs/plan.md), the security model, Nick's own first use of the app (2026-11-11), and the
earlier UI review. They are assumptions, not research with real people: the interviews in
`research/interviews/` were run with simulated persona agents.

Valet's people fall into two groups: the **person who owns the Mac** (who installs Valet, grants
secrets, approves adapters and answers prompts) and the **agents** that call Valet's tools. The
agent never sees the app, but everything it is told ("the person has been asked to act in the
Valet app") sends a human into the app with a job to do, so the agent's experience shapes the
human's.

| ID  | Persona                                     | One line                                                                                     | Primary surfaces                              |
| --- | ------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------- |
| P1  | Nick, the owner and power user              | Built Valet, runs it daily for his own agents, wants speed and depth                         | Menu bar, Adapters, Activity, traces          |
| P2  | Sam, the first-time non-technical installer | Was told "install this so Claude can do the groceries"                                       | Setup, menu bar, prompts                      |
| P3  | Morgan, the security-minded reviewer        | Will only trust Valet after checking what it can touch                                       | Review, Permissions, Audit log, Credentials   |
| P4  | Alex, the adapter author                    | Writes and fixes adapters, reads traces to debug                                             | Review update, Activity trace, Adapter detail |
| P5  | Jordan, the keyboard and VoiceOver user     | Low vision, uses VoiceOver and the keyboard, larger text                                     | Every surface                                 |
| P6  | Claude, the calling agent (indirect user)   | Calls tools over MCP, relays "needs you" moments to a human                                  | Tool results, which send a human to Prompts   |
| P7  | Nick away from the Mac (interrupted owner)  | Mid-task in Claude on a phone or another machine, comes back to the Mac to unblock something | Notifications, menu bar, Needs you            |

## P1. Nick, the owner and power user

- **Who:** software developer, built Valet, runs it on his MacBook every day. Uses Claude Code,
  Claude Desktop and cloud agents (through remote mode). Shops at Woolworths weekly.
- **Goals:** get his agents doing the shopping with as little of his attention as possible; see at a
  glance that everything is healthy; get to the thing that needs him in one click from wherever he
  is.
- **Frustrations (observed, 2026-11-11):** layout glitches and odd gaps; a lot of UI that only shows
  things when he expected to act on them (status pills, counts, names that aren't links); all text
  selectable like a web page; the adapter update review reachable only from the menu bar panel,
  not from the adapter that needed approval.
- **Mental model:** a desktop utility like 1Password, Tailscale or Little Snitch: a menu bar item for
  the glance, a window for the detail, behaves like an app and nothing web-like. The visual style
  should suit any OS rather than imitate macOS (project direction, 2026-11-11).
- **Tech:** expert. Keyboard first. Reads traces and hashes happily but doesn't want them in the way.
- **Key scenarios:** approve a new adapter version from the adapter page; see why the last cart call
  failed; reset a client's access; turn on remote access; pause everything quickly.

## P2. Sam, the first-time non-technical installer

- **Who:** Nick's partner (or any household member), comfortable with a Mac and 1Password, has never
  heard of MCP, adapters, hashes or partitions.
- **Goals:** finish setup without help; know whether it's working; answer a prompt (log in, confirm a
  purchase) without fear of doing the wrong thing.
- **Frustrations to expect:** jargon (adapter, egress, manifest, hash, partition, probe); walls of
  detail; not knowing what "done" looks like; worrying that a click spends money.
- **Mental model:** "an app that lets Claude use the Woolworths website for me". Thinks in sites
  (Woolworths), not adapters; in "Claude" not "clients".
- **Tech:** average. Mouse first. Reads the first line of anything and skips the rest.
- **Key scenarios:** first-run setup end to end; answer "Valet needs you to log in to Woolworths";
  check the trolley before checkout; find out if it's working at all.

## P3. Morgan, the security-minded reviewer

- **Who:** security engineer, a friend Nick asked to review Valet, or Nick himself in a suspicious
  mood. Reads the security model.
- **Goals:** verify what each adapter may reach and which secret it may fill where; confirm nothing
  leaks; check the audit chain; revoke anything at once.
- **Frustrations to expect:** a permission shown without its consequence; a revoke with no undo or
  no confirmation; status that can't be verified ("intact" with no way to re-check); evidence in
  one place and the control in another.
- **Mental model:** capabilities and blast radius. Wants "what can this touch" per adapter, per
  secret and per client, and an audit trail with links back to the thing.
- **Key scenarios:** review an update that adds a host; trace which calls used the login secret;
  verify the audit chain and export it; revoke a client and a grant.

## P4. Alex, the adapter author

- **Who:** developer writing or fixing an adapter, often with an authoring agent in the IDE.
- **Goals:** iterate fast: edit, review, approve, run, read the trace, fix. Wants the shortest loop
  from a failed call to the request or step that failed.
- **Frustrations to expect:** reviewing their own trivial change through the same heavy flow; hash
  noise; traces that don't link to the adapter version, request surface or manifest line.
- **Key scenarios:** approve a dev build; find the failing step of a run; see which requests were
  blocked and why; compare two versions.

## P5. Jordan, the keyboard and VoiceOver user

- **Who:** low-vision Mac user with VoiceOver, larger text and Reduce Motion on, keyboard only.
- **Goals:** do every task above without a mouse; hear what changed; never lose focus in a sheet.
- **Frustrations to expect:** icon-only buttons with no label; colour-only status; focus lost after a
  dialog closes; tables read cell by cell with no headers; selectable text making the cursor jump;
  content clipped below the fold with no scroll.
- **Key scenarios:** answer a confirmation with the keyboard; review and approve an update; find a
  failed call.

## P6. Claude, the calling agent (indirect user)

- **Who:** Claude (or any MCP client) calling Valet's tools for the person.
- **Goals:** finish the person's task; know when to wait, retry, or hand to the person; tell the
  person exactly what to do and where.
- **What it needs from the app:** a stable, nameable place to send the person ("open Valet, Needs
  you, Log in to Woolworths"), wording in tool results that matches the words on screen, and a
  hand-off that tells it when the person is done.
- **Key scenarios:** a call needs a login; a call needs a confirmation; a site is rate limiting; the
  adapter version changed under it.

## P7. Nick away from the Mac (interrupted owner)

- **Who:** P1, but working in Claude from a phone or another machine through remote mode, or
  away from the desk. Comes back to the Mac because Claude said Valet needs him.
- **Goals:** get from the notification to the exact prompt in one click, act, and get back to work.
  Know whether anything else is waiting.
- **Frustrations to expect:** a notification that opens the app at its home page; a prompt that timed
  out while he walked over; several things waiting with no order.
- **Key scenarios:** a 2-minute confirmation; a login hand-off with a 15-minute window; a remote
  consent request with a code.
