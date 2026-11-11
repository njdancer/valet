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
3. [`wireframes/`](wireframes/): every page and state (87 frames), as one page. Open
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
