# Test protocol, round 2: persona walkthrough of the wireframes

The wireframes are one page: `docs/ux/wireframes/index.html` (73 frames, each with an id). Read
`docs/ux/information-architecture.md` first. To look at a frame, screenshot it:

```
cd /home/user/valet && export PATH=/opt/node24/bin:$PATH
node /tmp/claude-0/-home-user/1fccf96c-41d8-510b-9eca-c97d63a5ec7f/scratchpad/wfshot.mjs \
  /home/user/valet/docs/ux/wireframes/index.html <out.png> <frame-id>
```

then Read the PNG. Frame ids are listed with `grep -o "id: '[^']*'" docs/ux/wireframes/frames/*.js`.
Notes for each frame are in the same files (`notes:`).

## Part 1. Scenario walkthrough on the wireframes

Walk S1 to S10 from `research/brief.md`, plus your own persona scenarios from round 1, through the
frames. For each step: the frame you're on, what you'd click, the frame that follows, and whether the
step works (works / friction / broken). Say when a needed frame or state is missing.

## Part 2. Did the redesign fix your round 1 pain points?

Your top 5 pain points from the interview, each: fixed / partly / not fixed, with the frame id.

## Part 3. New problems

Anything in the wireframes that is wrong, confusing, inconsistent between frames (words, counts,
names, ids), too dense, or missing. Severity (blocker / major / minor) and the frame id. Be harsh:
these go to the design thread next.

## Part 4. Verdict

One line: would this persona sign off on the IA and the wireframes, with which must-fix changes.

Write to `tests/round2-<your persona file name>.md`, 800 to 1800 words. Don't edit other files.
