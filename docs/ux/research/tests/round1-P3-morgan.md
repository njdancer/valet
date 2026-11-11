# Round 1 test: P3 Morgan, the security-minded reviewer

Simulated persona test against `../hypotheses-round1.md`, following `protocol-round1.md`. Morgan's
answers are first person; researcher notes are marked **R**. This test is consistent with the
interview in `../interviews/P3-morgan.md`, whose sketch was: Needs you / Overview / Adapters /
Access (Clients, Secrets) / Evidence (Activity, Audit log) / Settings, plus a Lockdown button that
is always visible.

## Part 1. Tree test

Confidence: **sure**, **unsure**, **lost**. The trees were presented in a fixed order (A, then B,
then C).

| Task                                  | IA-A                                                                                            | IA-B                                            | IA-C                                                               |
| ------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------ |
| T1 Approve Woolworths 0.4.0           | Needs you → review (sure); alt Sites → Woolworths → Versions                                    | same (sure)                                     | Home → Needs you item (sure); alt Sites → Versions                 |
| T2 Why last get_cart failed           | Activity → Calls → filter tool + outcome → trace (sure)                                         | Calls → trace (sure)                            | History → Calls → trace (sure)                                     |
| T3 Revoke Claude Code                 | Connections → Apps on this Mac → Claude Code → Revoke (sure)                                    | same (sure)                                     | Access → Connections → Claude Code (sure)                          |
| T4 Turn on remote access              | Connections → Remote access settings (sure)                                                     | same (sure)                                     | Access → Connections → remote (sure)                               |
| T5 Change the store                   | Sites → Woolworths → Overview (unsure: Overview or Permissions? A store is a setting)           | same (unsure)                                   | same (unsure)                                                      |
| T6 Calls that used the login password | Secrets → Grants → Woolworths login → its calls (unsure); alt Activity → Audit log → Secret use | Secrets → Grants (unsure); alt Audit log (sure) | Access → Secrets → Grants (sure, learned); alt History → Audit log |
| T7 Verify the audit log               | Activity → Audit log (unsure: I wouldn't look for tamper evidence under "Activity")             | Audit log (sure, one click)                     | History → Audit log (sure)                                         |
| T8 SMS codes from Messages            | Secrets → One-time codes (sure); 2nd guess Settings → Data and privacy                          | same (sure)                                     | Access → Secrets → One-time codes (sure)                           |
| T9 Woolworths blocking, until when    | Sites → Woolworths → Overview (sure); alt Needs you                                             | same (sure)                                     | Home, the site health line (sure, fastest)                         |
| T10 What Claude Desktop can call      | Connections → Claude Desktop → its page (sure, if the page lists tools)                         | same (sure)                                     | Access → Connections → Claude Desktop (sure)                       |
| T11 Trace retention                   | Settings → Data and privacy (sure)                                                              | same (sure)                                     | same (sure)                                                        |
| T12 Approve a cloud agent with a code | Needs you (sure); alt Connections → Remote clients                                              | same (sure)                                     | Home (sure)                                                        |

**R: tally.** IA-A: 9 sure, 3 unsure. IA-B: 10 sure, 2 unsure. IA-C: 11 sure, 1 unsure. Morgan
said: "By C I'd learned the trees, so discount C a bit. T6 only went 'sure' in C because I'd
already seen Grants twice."

**Winner for Morgan: IA-C**, with one change: keep "Needs you" as its own sidebar item above
Home instead of only inside it. IA-C's groups are the ones I drew myself: Access is the
principals-and-capabilities half, History is the evidence half. IA-A loses because "Activity"
undersells the audit log, so I hesitated on T7. That task is about integrity, not about activity.
IA-B is the fastest tree for T7, but it splits the evidence into two places I'll always cross
between, and it gives Access no home.

## Part 2. Label preference

- **Sites vs Adapters: "Sites" for the nav, "adapter" inside the page.** I review adapters (code,
  hash, versions), but I navigate to a site. On the Versions tab, call it "adapter 0.4.0" so I
  know it's the code being approved.
- **Connections vs Clients vs Connected apps: "Connections"**, but each item should be a
  "client", with a kind (this Mac / remote). "Connected apps" hides that a cloud connector is
  something outside this Mac.
- **Secrets vs Passwords vs Credentials: "Secrets".** It covers one-time codes and the
  service-account token, and it's the manifest's word, so the review screen and this page match.
  "Passwords" is too narrow.
- **Activity vs History: "History"**, if it holds the audit log. "Activity" suggests a feed. My
  real preference is "Evidence", but I accept that would scare Sam.
- **Needs you vs Inbox vs Waiting: "Needs you".** It's already the agent's wording, and "Inbox"
  suggests I can leave things there.

## Part 3. Hypothesis feedback

**E1. Accept E1 over E1b.** With E1 I'd have found the review on the first try: a "Review update"
button beside the badge is unambiguous. E1b would have repeated today's problem, because I hovered
the green "Approved" pill first. Change I want: when a status has evidence rather than a next step
(for example "chain intact"), put a quiet "Details" or "Re-check" button beside it, not nothing.

**E2. Accept; it's my top need.** Change I want: the hover card for a client, a secret or a site
shows a three-line "Can reach" summary and an "Open" link, so I can see the blast radius without
leaving the page.

**E3. Accept.** Values selectable with copy buttons, interface text not. Change I want: hashes
show in full when selected or copied (the audit head hash especially), never only "e73a…b69d".

**E4. Refine.** Accept the confirm dialog with its consequence. Change I want: the dialog also
shows evidence: "Claude Code made 141 calls in 7 days; last 1 min ago (View calls)". The undo toast
must never cover anything that sends data (revoke, a remote decline). Treat Reset access as
destructive too, because it ends live sessions.

**E5. Accept.** Countdowns plus the clock time. Change I want: a remote request's countdown shows
its source IP and the code next to it.

**E6. Refine.** The plain health line is fine for Sam. Change I want: the Details section is a
checklist with "last checked" times ("Probe 9:47 pm: signed out"; "Breaker opened 9:44 pm by call
c_9a71d0") and links.

**E7. Accept.** "12 blocked requests" must open the filtered list. Change I want: counts on grants
and clients follow the same rule ("Last used 9:47 pm" opens those uses).

**E8. Accept with a guard.** Plain first is fine, provided Details is one click and never hides
something security-relevant. A new egress host is never a Details-only item.

**E9. Accept.** No opinion beyond "nothing clipped": the update review must not clip its
permission list.

**E10. Refine; it isn't a lockdown.** Pause stops calls. A suspected leak needs more. Change I
want: next to Pause, a **Lock down…** action (window toolbar, menu bar, shortcut) whose dialog lists
and does:

- pause every adapter;
- turn the MCP endpoint off;
- turn remote access off and revoke every remote client;
- optionally reset every local token;
- optionally revoke every grant.

It ends with "Undo what can be undone" for the pause and endpoint steps and an honest list of what
can't be undone. It should also add one audit record per step.

**E11. Accept.** Today's "37" on Activity reads like an alert.

**P1. Accept.** Change I want: the Missed section keeps each item's audit link ("Timed out,
declined at 9:52 pm, record 4820").

**P2. Refine.** Add a **"Can reach"** block at the top of Permissions: hosts it may contact, origins
where a secret may be filled, which clients have called it, and which secrets it holds, each
linked. Without it, Permissions is a manifest dump.

**P3. Accept.** Changes I want: the review lists "Who will be able to call the new tool" (every
connected client, unless scoped), and the changed code files open in a viewer.

**P4. Accept.** Changes I want: an adapter-hash filter, and a "records for this call" link.

**P5. Refine; this is where the blast-radius view must live.** "What it can call" has to be
computed, not just listed: tools → sites → hosts → secrets that a call may trigger a login to
fill. Local clients currently get every tool. Say so plainly ("Can call all 9 tools of 2 sites"),
and ideally offer per-client tool scopes locally as well as remotely.

**P6. Accept with an addition.** Each grant shows "Can be triggered by" (the tools whose
`session.ensure` may run the login) and "Used by", with links to the calls.

**P7. Accept.** Nothing security-relevant should live only in Settings. SMS codes belong under
Secrets, and Settings links to it.

**P8. Pick P8b (Home), refined.** Home's health section must cover the system, not only sites:

- chain verified at …, with Re-check;
- endpoint on 127.0.0.1 only;
- N local clients, M remote clients;
- K grants;
- open breakers;
- Paused state.

Each line is a link. P8a would make the window jump around, which unsettles me. P8c hides the
system's state.

**P9. Accept.** Change I want: the test call shows up in History with a link, so a new user sees
the evidence loop on day one.

**P10. Refine.** Leading with the sentence is fine, but keep it visibly in the "Shown by the
adapter, not verified" box. The verbs ("Remove") come from the adapter's text, so the buttons should
be Valet's words: "Allow remove_from_cart" / "Decline". Don't let adapter text label the buttons.

**P11. Accept.** Add Lock down under Pause.

**Vocabulary table: accept, with one fix.** "Confirm: Remove Cavendish Bananas" uses
adapter-supplied text in a place the security model keeps clean, because notifications don't carry
adapter text. Use "Confirm a Woolworths change" in notifications and tool results, and show the
item name only inside the app.

## Part 4. What the hypotheses missed

- **Blast radius is only half there.** E2, P2 (with my "Can reach"), P5 and P6 together could
  produce it, but no hypothesis owns it. If nobody builds the join, I'll still be doing it by hand.
  I want one hypothesis that says: every site, client and secret page has a computed **Can reach**
  panel, and hovering any reference shows it.
- **There is no lockdown, only Pause.** E10 is a convenience switch. Responding to an incident
  means revoke plus pause plus endpoint off in one audited step.
- **Verifiable status is missing.** None of E1 to E11 says "every status shows when it was last
  checked and lets me re-check it". That's my biggest remaining worry: a redesigned app with
  prettier green dots I still can't verify.
- **Inventory consistency.** Every list of tools must come from one source: the remote scope list,
  the sidebar, Sites and Connections. The Wikipedia tool under Remote while Sites showed none
  is the kind of mismatch that makes me distrust the rest.
