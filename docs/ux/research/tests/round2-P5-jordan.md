# Round 2 test: P5 Jordan (keyboard, VoiceOver, low vision)

Walkthrough of `docs/ux/wireframes/index.html` against `information-architecture.md`, in character.
About 25 frames were screenshotted in light mode and three in dark: confirm-ready, needs-you and
global-200-text. Jordan "hears" each frame through the focus targets and accessible names given in
its notes. Where a note says nothing, that is recorded as a gap. Contrast figures are computed from
the wireframe tokens in `index.html`: they are the tokens the design thread will inherit.

## Part 1. Scenario walkthrough

| Step                                | Frame                                                    | Action (keyboard)                                                                                                                       | Next frame           | Result                                                                                                                       |
| ----------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **S1** Approve 0.4.0 from the site  | site-overview-update                                     | Focus on h1 "Woolworths"; Tab: "Review Woolworths update" is the first button after the heading                                         | site-review-update   | works                                                                                                                        |
|                                     | site-review-update                                       | Focus on h1 "Review the Woolworths update (0.4.0)"; Tab to the acknowledgement, Space, then Approve                                     | (none)               | **friction**: there's no frame for the state after Approve, so the focus target and announcement aren't specified            |
| **S2** Log in when asked            | menubar-waiting                                          | The popover opens with focus on the first Needs you row; Down twice reaches "Log in to Woolworths (verification check), until 10:03 pm" | login-handoff        | works                                                                                                                        |
|                                     | login-handoff                                            | Where focus lands isn't stated for the verification check. login-handoff-code says "first field", so I assume the site page             | (done)               | **friction**: Give up still comes before I'm done in reading order; the banner landmark shortcut ⌘⌥↑ is only an "assumption" |
| **S3** Confirm a removal            | confirm-arming                                           | Focus on "Don't remove"; Remove is disabled with a described reason                                                                     | confirm-ready        | works                                                                                                                        |
|                                     | confirm-ready                                            | Tab order: Details, Don't remove, Remove; Escape and Return both decline                                                                | (done)               | works, but the dialog's name is adapter-written text (Part 3)                                                                |
| **S4** Why get_cart failed          | activity-calls                                           | ⌘3; the ref "6B3E" is a link                                                                                                            | activity-call-failed | works: focus on h1, then the failing step pre-selected                                                                       |
| **S5** Connect Claude Desktop       | connections                                              | ⌘4; "Add an app…"                                                                                                                       | connections-add-app  | works: Escape returns focus to "Add an app…"; "live tick" is announced? Not stated: **friction**                             |
| **S6** Cut off Claude Code          | connections-app                                          | "Revoke…"                                                                                                                               | connections-revoke   | works: alertdialog, focus on Cancel, focus returns. The best frame in the set for me                                         |
| **S7** Site blocking us             | site-overview-limited                                    | Health line with clock time, "Try now" and "Pause site"                                                                                 | (toast)              | works; the Pause site toast is the same pattern as global-pause-undo                                                         |
| **S8** First launch                 | setup-welcome … setup-test                               | Step list of links; setup-test's live region announces each line once                                                                   | setup-done           | works                                                                                                                        |
| **S9** Remote access                | connections-remote-on, then needs-you-approve-connection | Turn on; the code sheet's Approve stays focusable with "Type the code first"                                                            | (done)               | works                                                                                                                        |
| **S10** Audit untampered            | activity-audit                                           | ⇧⌘3; h1 "Audit log"; "Check now"                                                                                                        | (result)             | **friction**: no announcement is specified for the Check now result (the broken frame is fine)                               |
| **J1** Pause everything by keyboard | global-pause-undo                                        | ⇧⌘P; the button becomes "Resume Valet"; a polite toast that F6 reaches                                                                  | (done)               | works                                                                                                                        |
| **J2** Use the app at 200% text     | global-200-text                                          | The sidebar folds behind ☰                                                                                                             | (none)               | **friction**: only Overview is drawn at 200% (Part 3)                                                                        |
| **J3** Find something by name       | global-palette                                           | ⌘K; the results listbox announces its count                                                                                             | (any)                | works                                                                                                                        |

Missing frames or states: the result after Approve or Reject (S1); after "Check now" (S10); the
menu bar popover, confirmation window, sheets and Needs you at 200% text; a focus-visible state
on any list or table row; Increase Contrast or forced colours; any Reduce Motion spec beyond one
line in confirm-urgent.

## Part 2. My round 1 pain points

1. **Focus dropped to the document on every navigation.** **Fixed in principle**
   (IA principle 11; site-review-update, activity-call-failed, connections-revoke and
   site-grant-sheet all name a focus target). **Partly** in practice, because the result states
   after an action (approve, check now, add app done) don't say where focus goes.
2. **Silent permanent revokes.** **Fixed** (connections-revoke: alertdialog, consequence, Cancel
   focused, focus restored). Reset access with Undo plus a live region (connections-reset-undo)
   is also right.
3. **No headings.** **Fixed in principle**: every page has an h1, and Activity has real tabs that
   change the h1 (activity-calls, activity-audit). Nothing yet says card titles are h2, and no
   frame annotates a heading outline.
4. **Small fixed text, and clipping at zoom.** **Partly.** global-200-text and global-min-window are
   good (one column, wrapping tabs, vertical scroll only). But the wireframe kit still uses 10 and
   11px for deadlines, attributions, hints and the confirmation's id line, and faint text fails
   contrast (Part 3, B2). The popover's "no scroll area inside a popover" rule can't hold at 200%.
5. **Verb-only buttons and hidden disabled buttons.** **Mostly fixed.** "Review Woolworths update",
   "Revoke Claude Code" and "Use this login" (focusable while disabled) are right. But the menu bar
   rows say "Answer ›", "Approve ›" and "Show ›", and the Needs you page says "Show login window"
   for the same item.

## Part 3. New problems

**Blockers**

- **B1. The confirmation's accessible name is adapter-written text** (confirm-arming,
  confirm-ready, confirm-urgent). The h1 and dialog name is "Remove Cavendish Bananas (2 × $0.79)
  from your trolley?", which the adapter wrote. The "Valet can't check its wording" line is 11px
  faint grey that VoiceOver reads _after_ it. That breaks the IA's own rule in section 10 (product
  names only in the body, under "From the site"). Sighted people get the visual attribution; I
  don't. A hostile adapter's sentence becomes the whole dialog for me. Fix: dialog name =
  Valet's title "Confirm: Remove from cart (Woolworths)"; description = "Woolworths says: Remove
  Cavendish Bananas…", then what Valet checked. Keep the big sentence visually, attributed.
- **B2. Faint text fails contrast in light mode, and the primary button fails in dark mode.**
  `--wf-ink-3 #8f99a3` on white is **2.9:1** (2.7:1 on paper-2). It's used for "until 9:50 pm",
  "then this window closes", the confirmation attribution, "Remove is ready in a moment…", palette
  key hints, "+1 more … Review the update" and the Missed rows (confirm-*, menubar-waiting,
  login-handoff, needs-you). In dark mode, white on `--wf-act #5c82f0` is **3.56:1** at 13px
  (needs-you-dark, confirm-ready-dark: "Remove", "Answer…", "Review update"). Fix: faint at least
  4.5:1 in both themes, and dark primary at least 4.5:1 with its label. This goes to the design
  thread's tokens.

**Major**

- **M1. "Calls ↗" is a link inside the tablist** (site-overview, global-200-text,
  global-min-window). VoiceOver announces "Calls, tab 5 of 5", then Space navigates me to another
  section. A tab must show a panel. Fix: either a real Calls tab on the site (filtered list,
  inline) or a "Calls for Woolworths" link outside the tablist.
- **M2. Menu bar popover at 200% text isn't designed.** menubar-waiting says "no scroll area
  inside a popover" and three full rows. At 200% three rows plus Sites plus Today won't fit in
  640px. Fix: draw it; at 200% show Needs you plus "+N more" and allow vertical scroll.
- **M3. Nested interactive rows** (sites-list: "the whole row opens the site", and the row also
  holds "Review update", "Try now" and "N calls" links; needs-you rows likewise). A clickable row
  containing buttons is either unreachable or announced twice. Fix: the name is the link; the row
  isn't a control (pointer click delegation is fine, but not in the accessibility tree).
- **M4. One item, three or four names.** Grant: "Choose login…" (banner), "Give Valet your
  Woolworths login" (sheet title, whose note claims it's the Needs you title), "Connect your
  Woolworths login" (vocabulary table), "Use this login" (button). Login: "Show login window"
  (needs-you), "Show" (menu bar), "Log in to Woolworths" (title). Confirm: title "Remove from cart",
  sentence "from your trolley". VoiceOver's item chooser depends on one name per item. Fix:
  one title, and every action button named "verb + that title".
- **M5. Toast timing differs:** pause 8 s "longer while focused" (global-pause-undo), reset 10 s
  after last keyboard activity (connections-reset-undo). Fix: one rule. Toasts with Undo persist
  until dismissed or 10 s after the last input, reachable with F6, and Undo is also ⌘Z.
- **M6. Login hand-off order and focus** (login-handoff). Give up is first in reading and Tab order.
  The verification-check frame doesn't say where focus starts, and the banner landmark key is an
  assumption. Fix: focus on the site page's first control; the banner is a named `region` with a
  documented shortcut; I'm done comes before Give up in the DOM.
- **M7. Quick review puts focus on Approve, and Return approves** (site-review-quick). That
  contradicts "focus lands on the h1" everywhere else. A screen reader user pressing Return to
  start reading approves. Fix: focus on h1; Approve is the default button, activated only by
  ⌘Return.
- **M8. "Return approves when ticked"** (site-review-update). That's fine for the footer, but Return
  on "Open diff" or a link must not approve. Spec: Return approves only when focus is in the
  decision footer.

**Minor**

- m1. The confirmation's "1 of 3 waiting" vs Needs you "4 waiting" and menu bar "4 things need you".
  The review is counted in one and not the other. Say "1 of 3 timed items" or count the same way.
- m2. The confirm-urgent countdown "0:24" visually collides with "until 9:50 pm". The
  "nothing is removed" sentence is said twice (body and footer), so VoiceOver reads it twice.
- m3. "Ready" badge plus the "Ready · logged in" health line (site-overview, global-200-text) are
  heard twice. Make the badge decorative, or drop it when the health line says the same.
- m4. Icon-only controls need names in the notes: ☰ (global-200-text), the search button at 200%,
  the sheet "×" (site-grant-sheet), "⋯" (global-min-window). At 200% the ☰ and search glyphs look
  unscaled.
- m5. When the sidebar folds at 200%, say where focus goes on ⌃⌘S (into the sidebar's current
  item) and that ⌘1 to ⌘5 still work.
- m6. "Reads" vs "read" badges in site-review-update. "Add a site…" on Sites (global-pause-undo,
  sites-list), although the IA says adding a site is out of scope.
- m7. Two "Revoke…" buttons on connections-app (header and identity card). Same name twice in
  the rotor.
- m8. Reduce Motion appears in one note (confirm-urgent). Toasts, sheets sliding over, and the
  live tick in add-app need it too.

## Part 4. Verdict

**I'd sign off on the IA (IA-A, real tabs, Needs you first) and conditionally on the wireframes.**
Must-fix before the design thread builds components:

- **B1**, confirmation name: confirm-arming, confirm-ready and confirm-urgent.
- **B2**, faint text and dark primary contrast in the tokens: confirm-*, menubar-waiting,
  needs-you, login-handoff.
- **M1**, "Calls ↗" inside the tablist: site-overview, global-200-text.
- **M2**, the 200% popover: menubar-waiting.
- **M3**, nested interactive rows: sites-list, needs-you.
- **M4**, one name per item: site-grant-sheet, needs-you, menubar-waiting.
- **M7**, quick-review focus: site-review-quick.
- A post-action frame for S1 and S10 that names the focus target and the announcement.
