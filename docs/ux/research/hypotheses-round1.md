# Hypotheses, round 1 (for persona testing)

Formed from the seven persona interviews (`interviews/`) and the navigation audit
(`audit/navigation.md`). Each hypothesis is something we believe will fix an observed problem. The
persona tests in `tests/` accept, reject or refine them. IDs are stable: QA rounds cite them.

## What the research agreed on

1. **Every persona built a "Needs you" group first** (cards 1, 8, 9, 20, 35) and wanted it at the top
   of the window as well as in the menu bar. Today it exists only in the menu bar popover, which
   clips it to one row, and remote sign-in isn't in it at all.
2. **Every persona built a "one page per site" group** (2, 3, 4, 10, 25, 34, and often 5 and 6). The
   sidebar today has both "Adapters" and a "Sites" list of the same things.
3. **Local and remote clients are one concept** ("remote is just another kind of client") for
   P1, P3, P4, P5 and P7. Today they are two top-level pages, and Clients shares a page with Settings.
4. **Calls and the audit log are "what happened"** for P2, P5 and P7, and two views of "evidence" for
   P3. P1 and P4 want them separate but linked both ways.
5. **Status that can't be acted on** was the most cited problem (Nick's complaint 2). The review link
   exists on the adapter page but looks like a static pill, so nobody found it (complaint 4).
6. **Kill switches** (pause all, MCP off) live only in the menu bar; P1, P3 and P5 want them in the
   window too, with a shortcut.
7. **Missing object links:** run to adapter, client, secret and audit record; audit record to run;
   client to its calls; grant to the calls that used it; adapter page "All activity" to a filtered
   list.
8. **Revokes are one click, permanent and silent.**
9. **Focus, headings, scrolling:** no headings on most pages, focus lost on every navigation, windows
   clip instead of scrolling, text scale fixed.
10. **Words:** P2 didn't understand about 30 terms; the agent and the app use different words for the
    same thing (otp-required vs One-time code; paused vs unavailable; Remote sign-in vs remote access
    vs connector).

## Element hypotheses (E)

- **E1. Status and action are separate things.** A status badge is never clickable. When a status
  has a next step, a real button sits beside it ("0.4.0 waiting for review" + **Review update**).
  Variant E1b: the badge itself is a button with a chevron. We expect E1 to win: P5 and P2 can't tell
  a clickable pill from a static one.
- **E2. Every object reference is a link.** Adapter/site, client, secret, call id, audit seq, host
  names: one link style everywhere, with a hover card or context menu (Copy, Open). Links go both ways.
- **E3. Text selection policy.** Interface text (labels, headings, buttons, descriptions) can't be
  selected. Values (hashes, URLs, ids, JSON, code, addresses) can, and carry a copy button on hover.
- **E4. Destructive actions confirm with the consequence**, in a small dialog that names what stops
  working ("Claude Code can't call any tool until you add it again"). Reversible actions (pause,
  turn off) act at once with an Undo toast.
- **E5. Deadlines are visible.** Time-boxed items show a live countdown and the clock time ("1:42 left,
  until 9:50 pm"), ordered by what expires first.
- **E6. One plain health line per site** with its action: "Ready", "Needs you: log in", "Woolworths
  is limiting us, calls resume at 9:52 pm (Try now)", "Paused (Resume)". Technical detail is under
  Details.
- **E7. Numbers are doors.** Stat tiles, counts and sparklines open the list they summarise, filtered
  (e.g. "12 blocked requests" opens Activity filtered to blocked).
- **E8. Plain words first, technical words in Details** (D-words, already decided by Nick). Shared
  vocabulary between tool results and the app (see vocabulary table below).
- **E9. Every page has a title heading, a window title, and focus moves to the heading after
  navigation.** Results are announced (live region). Everything scrolls; nothing is clipped.
- **E10. Pause Valet is a global control** in the window toolbar, the menu bar, the app menu, and a
  shortcut, always showing its state.
- **E11. Badges count one thing.** A sidebar count means "items needing you in this section" (alert
  style) or nothing. Totals ("37 calls today") are not badges.

## Page hypotheses (P)

- **P1. A Needs you page** at the top of the sidebar: every waiting item (confirmation, remote
  sign-in, login, review, setting missing, grant missing), sorted by deadline, with a "Missed" section
  for items that timed out. Each item has its main action inline and opens the full sheet. The menu
  bar mirrors it.
- **P2. One page per site** (Woolworths) with tabs: Overview (health line, store, login and secret,
  trolley, today's calls), Tools, Permissions, Versions (pending review, history, compare), Activity
  (this site's calls). Review update opens from Overview's banner and from Versions.
- **P3. Review update is a full page inside the site** (sidebar stays, breadcrumb back, Escape goes
  back to where you came from). The first-install review is the same page with a summary first.
- **P4. Activity has filters in the URL** (site, tool, client, outcome, time) and a trace whose
  header fields are links. The audit log is a second tab of the same section, and a call links to its
  records and back.
- **P5. Connections is one page**: the MCP endpoint, apps on this Mac, remote (cloud) clients, and
  remote access settings. Each client has its own page: what it can call, its calls, reset, revoke.
- **P6. Secrets is one page**: password sources (1Password, Keychain copies), one-time codes
  (1Password TOTP, Messages), and every grant with its site and the calls that used it.
- **P7. Settings is its own page** (General, Notifications, Data and privacy, Updates, Reset), reached
  by Cmd/Ctrl+comma, separate from Connections.
- **P8. Home.** Variant P8a: the window opens on Needs you when anything waits, otherwise on Sites.
  Variant P8b: a Home page (Needs you on top, then each site's health line, then today). Variant P8c:
  the window always opens on Sites, with the Needs you count in the sidebar.
- **P9. Setup ends with a working test** ("Ask Claude: what's in my Woolworths trolley?") and every
  skipped step leaves a Needs you item rather than a dead end.
- **P10. The confirmation window leads with the sentence** ("Remove Cavendish Bananas from your
  trolley?"), then what Valet checked, with buttons named by verb ("Remove", "Don't remove").
- **P11. The menu bar popover** shows Needs you first (scrolls, sorted by deadline, countdowns), then
  one row per site (clickable, with its health line), then Pause and Open Valet. Stat tiles open
  Activity filtered.

## Navigation candidates (IA)

- **IA-A (six places):** Needs you · Sites · Activity (Calls, Audit log) · Connections · Secrets ·
  Settings.
- **IA-B (seven places, evidence split):** Needs you · Sites · Calls · Audit log · Connections ·
  Secrets · Settings.
- **IA-C (five places, merged access):** Home (Needs you + site health + today) · Sites · History
  (Calls, Audit log) · Access (Connections, Secrets) · Settings.

Label candidates to test: Sites vs Adapters; Connections vs Clients vs Connected apps; Secrets vs
Passwords vs Credentials; Activity vs History.

## Shared vocabulary candidates (agent and app say the same thing)

| Concept                         | App and tool result word                                 |
| ------------------------------- | -------------------------------------------------------- |
| A waiting item                  | Needs you                                                |
| Login hand-off                  | Log in to Woolworths                                     |
| 2FA code the app can't read     | Enter the one-time code for Woolworths                   |
| Irreversible step               | Confirm: Remove Cavendish Bananas                        |
| Remote client asking to connect | Approve a connection (code ABCD-1234)                    |
| Update waiting                  | Review the Woolworths update (0.4.0)                     |
| Paused                          | Paused (Resume in Valet)                                 |
| Site limiting                   | Woolworths is limiting requests; calls resume at 9:52 pm |
| Missing setting                 | Choose your Woolworths store                             |
| Missing secret                  | Connect your Woolworths login                            |
