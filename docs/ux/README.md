# Valet UX: research, information architecture and wireframes

The 2026-11 redesign of the Valet app, started after Nick's first real use of it (layout gaps and
glitches, status that couldn't be acted on, selectable text everywhere, and the update review
reachable only from the menu bar). Everything here was produced overnight on 2026-11-11 by a
multi-persona review with simulated persona agents; nothing in it has been tested with real people
yet, and every choice Nick hasn't answered is marked as an assumption.

## Read in this order

1. [`personas.md`](personas.md): the seven personas (P1 to P7). QA rounds walk the app as each one.
2. [`information-architecture.md`](information-architecture.md): the decided IA: six places, routes,
   principles, Needs you item types, shared vocabulary with tool results, link matrix, navigation
   map, assumptions and open questions for Nick.
3. [`wireframes/`](wireframes/): every page and state (100 frames), as one page. Open
   `wireframes/index.html`, or the published copy. `wireframes/story.md` is the one consistent world
   all frames share.
4. [`component-inventory.md`](component-inventory.md): every wireframe element mapped to the
   `@valet/ui` component and states it needs.

## Research trail

| Step                                                                       | Files                                                                   |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Current app rendered at its real window size                               | `research/current-screens/`                                             |
| Layout audit (50 measured findings, 15 layout principles)                  | `research/audit/layout.md`, `research/audit/shots/`                     |
| Navigation and interactivity audit (47 findings, graph of today's app)     | `research/audit/navigation.md`                                          |
| Persona interviews: interview, open card sort, walkthrough of 10 scenarios | `research/interviews/P1-nick.md` … `P7-away.md`                         |
| Hypotheses (elements E1–E11, pages P1–P11, three IA candidates)            | `research/hypotheses-round1.md`                                         |
| Round 1 tests: tree test, label preference, hypothesis feedback            | `research/tests/protocol-round1.md`, `round1-*.md`                      |
| Round 2 tests: persona walkthrough of the wireframes                       | `research/tests/protocol-round2.md`, `round2-*.md`, `round2-mustfix.md` |

## Rebuilding the wireframes

```
node docs/ux/wireframes/build.mjs     # template.html + kit + intro + frames/*.js -> index.html
```

Each frame file pushes frames with notes; `kit.js` and `kit.css` are the shared vocabulary.

## v3 (aligned with the design system)

After the design thread mapped v2 onto `@valet/ui` (`docs/design-system-mapping.md`), the
wireframes take the library's answer wherever the two disagreed:

- Reassurance lists ("It can't…", "Never shows it to Claude") and "can't" rows in Permissions use a
  neutral mark, not red (M24).
- Sizes: setup rail 224 and column 760 (M34); Settings 760 (M26); sheets 560 and 720; palette 600 (M2).
- The code diff is a page inside the review (`#/sites/<id>/versions/<hash>/review/diff`), not a
  window-wide sheet (M2).
- Danger: `K.danger` is solid and only confirms what can't be undone (Reset access, Revoke, Reset
  Valet); the buttons that open those dialogs are `K.dangerSoft` (M17, M31).
- "Limited by site" is a warning, not a failure (M32).
- Totals and counts are text, not badges; the Needs you deadline is a deadline chip (M21, M22); the
  0.4.0 login row is full contrast with "Not given yet" (M20); "Traces kept 14 days" is text with a
  Change link (M29).
- Deadlines use the library's words: "2 min · until 9:50 pm", then seconds when urgent (M19).
- One toast rule: 10 s, held while hovered or focused, Alt+T reaches it, ⌘Z while an Undo toast
  shows (M15).

New frames for the order path (G5): `setup-1password-waiting`, `setup-login-locked`,
`setup-login-waiting`, `setup-login-none`, `setup-store-states`, `setup-connect-failed`,
`confirm-allow-failed`, `confirm-answered-elsewhere`, `login-handoff-checking`. The setup dead ends
(G8) now go somewhere: `setup-approve-requests`, `setup-which-one`, `setup-choose-item`,
`setup-test-how`.

## Agent-run Valet (2026-11-12)

[`agent-run/`](agent-run/) extends this redesign for Valet run by your own agents, with approvals on
a paired iPhone: personas P8 and P9, journeys J1 to J8, the approval-card spec, the Mac IA changes,
the iPhone app's IA and their wireframes.
