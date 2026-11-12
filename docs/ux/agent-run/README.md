# Agent-run Valet: journeys, IA, wireframes and approval cards

Workstream A of the agent-run plan, `docs/plan-agent-run.md` (it lands with PR #70; until then the copy is
`/mnt/project-files/plans/2026-11-12-agent-run-valet.md`), 2026-11-12. Nick's
direction: you install Valet, grant it 1Password, pair your phone and connect your own agents; from
then on the agents configure Valet and write and repair its adapters through Valet's MCP tools, and
anything sensitive asks you first, on the Mac or the iPhone, with Face ID or Touch ID.

This folder turns that into what workstreams D (approval broker), E (admin tools), F (authoring
tools) and H (iOS app) build against. It extends the v3 redesign in [`../`](../): those personas,
IA and wireframes still hold wherever this folder says nothing.

Like the v3 work, every choice Nick hasn't answered is an assumption. They're listed in
`information-architecture.md`, section 8, and the questions for him in section 9.

## Read in this order

1. [`personas.md`](personas.md): P8 Riley, the phone-first owner; P9 the agent as administrator and
   author; X1 a hostile page and X2 a rogue agent, which the adversarial reviews walk too.
2. [`story.md`](story.md): the one world every frame shows (Thursday 19 November 2026, 7:40 pm).
3. [`journeys.md`](journeys.md): J1 to J8 with happy paths, failures and dead ends, each step naming
   its frame. J6 answers the plan's open question about logins while away.
4. [`approval-cards.md`](approval-cards.md): the content spec for every approval card: rules,
   anatomy, kinds and tiers, risk lines, change rows, gestures, states, notifications, what the agent
   is told, and where each card can be answered.
5. [`information-architecture.md`](information-architecture.md): what changes in the Mac app, the
   iPhone app's IA, new vocabulary, admin tool wording, assumptions, questions for Nick, and the
   sign-off table for the other workstreams.
6. [`wireframes/`](wireframes/): every journey's frames, phone (393 x 852) and Mac (1180 x 780).
   Open `wireframes/index.html`, or the published copy.
7. [`review.md`](review.md): the adversarial persona review of these designs and what changed.

## Rebuilding the wireframes

```
node docs/ux/agent-run/wireframes/build.mjs
```

It reuses the v3 kit (`../wireframes/kit.css`, `kit.js`, `template.html`) and adds the phone kit
(`phone.css`, `phone.js`). Each file in `frames/` is one journey.

## For the workstreams that build on this

| Stream | Start from                                                                                                 |
| ------ | ---------------------------------------------------------------------------------------------------------- |
| B      | approval-cards.md sections 1, 6, 7, 8, 12; journeys J1 (pairing words), J6 (codes), J7 (lock at the relay) |
| D      | approval-cards.md in full; J4 frames                                                                       |
| E      | information-architecture.md sections 4 and 5; approval-cards.md section 11; J8                             |
| F      | journeys J3 and J5; approval-cards.md sections 5 and 7                                                     |
| G      | journeys J2 and J7; approval-cards.md section 9 ("Mac didn't answer")                                      |
| H      | information-architecture.md section 3; every `ph-` frame                                                   |
