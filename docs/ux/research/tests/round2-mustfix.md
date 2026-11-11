# Round 2 must-fix list (wireframes v1 → v2)

From the seven persona walkthroughs (`round2-*.md`). Every persona signs off on the IA (six places,
Calls and Audit log as real tabs, Needs you first, P8a). The wireframes are signed off subject to the
fixes below. Consistency fixes all follow `../../wireframes/story.md` (one world: 9:48 pm, 4
waiting, fixed call refs, counts, dates and words).

## Decisions taken to resolve conflicts

- **Reset access asks first and has no Undo** (P3 over P1): the token may be reset because it leaked,
  so it must stop at once. Undo stays for Pause, turning the endpoint off and tool switches.
- **Notifications never approve.** They offer Open, and Decline for confirmations and connections.
  The settings frame says the same.
- **Approve a connection:** no tools are pre-ticked (remote tools are off by default); the sheet
  shows who is asking (IP, time, the name it calls itself, marked unverified) and a prominent "If
  you didn't start this, decline". Decline and Approve have equal weight; Approve stays disabled
  until a code is typed.
- **Quick review compares with the live approved version**, never a waiting one. If another update
  is still waiting, quick review is off and the full review applies.
- **"Keep using your login for this version" is unticked whenever the update widens reach** (new
  host, path or secret), and the new-host row warns that session cookies may go there.
- **One retry action:** "Ask Claude to try again…" opens a small popover showing the sentence to send,
  with Copy (works when Claude is on a phone).
- **Confirmation window's accessible name is Valet's title**; the site's own sentence is its
  attributed description.
- **Lock down is visible**, not only inside Pause's menu: a row in the menu bar popover and an item
  in the window's titlebar Pause menu plus the app menu. A locked-down state and Unlock are drawn.
- **Site tabs:** "Calls" leaves the tablist and becomes a header link ("All calls").
- **Rows that hold their own buttons are not whole-row targets;** their title is the link.
- **Longer confirmation time** (2 min default, 5 min option) is a setting in Notifications and an
  open question for Nick.
- **Contrast:** faint text and primary buttons move to ≥ 4.5:1 in both themes (kit tokens changed).

## Fixes by frame file

### 10-needs-you.js (UX thread)

- Story counts and refs; repair item; missing-login, store and Unlock 1Password rows (new frame
  `needs-you-more`); retry action; approve-connection sheet per the decisions; keyboard focus shown
  on the first row (P1 M7).

### 20-sites.js

- `site-review-quick`: compare with 0.3.0; off while 0.4.0 waits (P1 B1, P4 blocker).
- `site-review-update`: keep-login unticked, new-host cookie warning (P3 blocker); author is "the
  authoring agent (IDE)" with no Connections link (P4); provenance line (repro check) (P4).
- `site-overview*`: Woolworths today = 21 calls; Cursor out of Called by and counts; one review entry
  in the header plus the banner, no third (P1 M6); "All calls" header link instead of a Calls tab
  (P5 M1); call refs per story.
- `site-versions`: 0.4.0 as a row; Compare says what with; origin of 0.3.0 "Comes with Valet".
- New frames: `site-compare` (result), `site-review-restore`, `site-approved` (after Approve: toast
  "Woolworths 0.4.0 approved; the next call uses it", focus on the page heading) (P4, P5).
- `site-grant-sheet`: same vault as setup (Personal vault via Keychain copy, per D6); warn when an
  item is saved for another site; bring back "It can / It can't" (P3).
- `sites-list`: row title is the link, not the whole row (P5 M3).

### 30-activity.js / 40-connections.js / 50-secrets.js / 60-settings.js

- Call refs and times per story everywhere (7F2A, 9A71, 8F2E, 4C21, 6B3E, 5C10).
- `activity-call-ok-blocked`: header counts match the timeline; inspector shows the tool-code line
  that made the request; "Show in adapter declaration" only on declared requests (P4).
- `activity-call-failed`: the "Told Claude Code" text is the real result string from IA section 7
  (P6 M2); its error class is `site-changed`.
- New frame `activity-call-keyboard` or a note set showing arrow-key row movement and Return (P1 M7).
- `activity-audit-broken`: fix the "after the break" contradiction (P3).
- `connections-app`: Reset/Revoke once (P1 M8); Reset asks first (decision above); new
  `connections-reset` dialog replaces `connections-reset-undo`.
- New frame `connections-agent` (a cloud agent's page) (P3).
- New frame `secrets-revoke-login` (grant revoke dialog) (P3).
- `settings-notifications`: notification rule per the decisions; confirmation time setting.
- "Since" filter must not wrap (P1 minor).

### 70-menubar.js / 80-windows.js / 90-setup.js / 95-global.js

- Counts per story: icon 4, "1 of 4" (P7 must-fix 2).
- `menubar-icon-notification`: actions Open / Decline only (P7 must-fix 1).
- `menubar-waiting`: "+1 more" is a link; Missed keeps "(Woolworths)"; Lock down row.
- `confirm-*`: accessible name note (P5 B1); "1 of 4"; state after answering (P7).
- `login-handoff*`: until 10:02 pm; focus starts on "I'm done", which comes first; "5 more minutes"
  button; new frames `login-handoff-success` (what Claude is told on its next call) and
  `login-handoff-expired` (P7, P6).
- `setup-*`: draw the finished state `setup-done` as "You're set up" and move "Almost set up" to
  `setup-done-partial`; `setup-test-failed` (P2 B1); counts per story; first install "Comes with
  Valet" (P2 M5); `setup-connect` hides remote access behind "Other ways" (P2 M8); same vault as the
  grant sheet.
- `global-lockdown`: say what happens to calls in progress and waiting confirmations; new
  `global-locked` (window locked down, Unlock) (P3).
- `global-pause-undo`: Woolworths 21 calls; no "Add a site…" (P1 M5).
- `global-app-menu`: "Needs you", not "Needs You".
- Popover at 200% text: one frame `menubar-200-text` (P5 M2).
