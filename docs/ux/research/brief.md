# Research brief for persona interviews and audits (round 1)

## What Valet is

Valet is a macOS menu-bar app (Electron, React renderer) that turns per-site browser automation
"adapters" into MCP tools for AI agents. First target: Woolworths (Australian supermarket) login and
trolley management. Login is a declarative flow in an isolated auth partition; adapter code never
sees secrets; secrets come from 1Password (or a Keychain copy); 2FA from 1Password TOTP or the
Messages database. Every call is audited in a hash-chained log. Site calls are paced (10 s apart)
behind a circuit breaker. Adapter updates must be reviewed and approved by the person (new version
= new content hash; grants don't carry over). Irreversible tool calls ask the person to confirm on
the Mac. Remote mode lets cloud agents reach Valet over an HTTPS tunnel after a consent with a code.

Surfaces:

- **Menu bar popover** (`tray.png`, first run `fr-tray.png`): status, MCP address, today's stats,
  Needs you list, adapters, menu.
- **Control panel window** (1180 x 780 default, 880 x 560 min) with a sidebar: Adapters, Activity,
  Audit log, Clients, Remote sign-in, Credentials, Settings; a "Sites" list of adapters below;
  a footer with Run setup again, MCP status, audit chain status.
- **Chromeless windows** the app opens on its own: Review update (`review.png`), Confirmation
  (`confirm.png`), Login hand-off banner (`needs-user.png`).
- **First-run setup** in the control panel window: welcome, 1Password, approve, grant, store,
  clients (`setup-*.png`).

## Screenshots of the current app

`docs/ux/research/current-screens/` (rendered on fake data at 1180 x 780; `*-full.png` is the
whole scrollable page; `fr-*` is a first launch):

adapters, adapter-wow (Woolworths detail), adapter-yahoo, review (update review), grant (grant
sheet over the adapter page), activity, activity-call (run trace), audit, clients, settings (shares
a page with clients), remote, credentials, confirm (irreversible confirmation), needs-user (login
hand-off), tray, fr-adapters, fr-adapter, fr-review, fr-tray, setup-welcome, setup-onepassword,
setup-approve, setup-approve-review, setup-grant, setup-store, setup-clients.

Code: `apps/desktop/src/renderer/` (screens/, control/, tray/, lib/routes.ts, styles/).
Shared API: `apps/desktop/src/shared/api.ts`. Plan and security model: `docs/plan.md`,
`docs/security-model.md`.

## Nick's complaints after first use (2026-11-11)

1. Little glitches; things not laid out properly; weird gaps in parts of the UI.
2. A lot of UI is purely presentational where there should be ways to interact.
3. All the text is selectable, which feels weird for a Mac app.
4. Things aren't where you'd expect and you can't logically get to them. Example: to approve an
   adapter update, the only route he found to the review screen was the menu bar panel; from the
   adapter that needed approval there was no way.

## Card list for the open card sort

Group these into sections you'd expect in the app, name each group, and say where you'd expect
to start for each. Cards:

1. Approve an adapter update
2. See what an adapter is allowed to reach (hosts, paths)
3. See an adapter's tools and what they do
4. Choose the Woolworths store
5. Give an adapter a password from 1Password
6. Revoke a password grant
7. Re-sync a Keychain copy from 1Password
8. Log in to a site when asked
9. Confirm or decline an irreversible action (remove from trolley, checkout)
10. Open my Woolworths trolley in the browser
11. See today's calls
12. See why a call failed (trace)
13. See which requests were blocked
14. Verify the audit chain
15. Export the audit log
16. Add Claude Desktop as a client
17. Reset a client's access
18. Revoke a client
19. Turn on remote access for cloud agents
20. Approve a remote sign-in (code)
21. Turn a tool on or off for remote clients
22. See the MCP address
23. Turn the MCP endpoint off
24. Pause all adapters
25. See whether a site is blocking us (circuit breaker)
26. Set up 1Password
27. Turn on SMS codes from Messages
28. Change how long traces are kept
29. Check for app updates
30. Run setup again
31. Reset or uninstall Valet
32. Open Valet at login
33. Notifications on or off
34. Uninstall or remove an adapter
35. See what needs me right now

## Common scenarios for the cognitive walkthrough

S1. Woolworths 0.4.0 is waiting for review. You're on the Woolworths adapter page. Approve it.
S2. Claude says "Valet needs you to log in to Woolworths". Do it.
S3. Claude wants to remove an item from the trolley and Valet asks you to confirm.
S4. The last get_cart call failed. Find out why.
S5. Connect Claude Desktop to Valet.
S6. You think Claude Code's token leaked. Cut it off.
S7. Woolworths seems to be blocking you. Find out and decide what to do.
S8. First launch: set Valet up from scratch.
S9. Turn on remote access so a cloud agent can shop.
S10. Check that nothing has tampered with the audit log.
