# Round 2 test: P6, Claude the calling agent

This is a simulated review of `wireframes/index.html` against IA section 7 (shared vocabulary) and
the result strings I proposed in `round1-P6-agent.md`. I check the words, not the layout. For every
hand-off, the Needs you title, the menu bar row, the notification, the window and the call ref must
match the tool result word for word.

I grepped all ten frame files for each title and ref. I screenshotted `needs-you`,
`menubar-waiting` and `activity-call-failed`.

## Part 1. Walkthrough of the agent's hand-offs

| #   | Situation, and what I relay                                                                                                       | Frames the person passes                                                                                                                                 | Result                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Login with a verification check. I relay: Open Valet, Needs you, "Log in to Woolworths (verification check)", open until 10:03 pm | Notification and popover row (`menubar-icon-notification`, `menubar-waiting`), Needs you row (`needs-you`), `login-handoff`                              | **Works** on the title, which is identical in all four places. **Broken** on the call ref: the window says call 7F2A (9:47 pm, get_cart), but the same call is 9A71 in Activity (`activity-calls`, `activity-audit`).                                                                                                                                                                                                                |
| 2   | One-time code. I relay: "Log in to Woolworths (one-time code)"                                                                    | `login-handoff-code`                                                                                                                                     | **Works.** The title matches, and "Set up one-time codes…" is the lasting fix I couldn't offer before. Friction: the countdown reads 9:05 to 10:03 pm for a call made at 9:53, but a 15-minute window should end at 10:08.                                                                                                                                                                                                           |
| 3   | Confirmation. Before the call, I relay: Valet shows it as "Confirm: Remove from cart (Woolworths)" until 9:50 pm                  | `confirm-arming`, `confirm-ready`, Needs you row, popover row, notification                                                                              | **Works.** The title is identical in all five. The strip says "1 of 3 waiting" while Needs you says 4 (the update review isn't timed, so the strip may be right, but say which count).                                                                                                                                                                                                                                               |
| 4   | Missed confirmation. The result says nobody answered by 9:50 pm (confirm: timed-out)                                              | `confirm-missed`, `menubar-missed`, `needs-you` (Missed section)                                                                                         | **Friction.** The Needs you row and the notification say "Missed: Confirm: Remove from cart (Woolworths)", but the popover's Missed line drops the site: "Confirm: Remove from cart, 9:50 pm". The retry note says "The Valet confirmation for Remove from cart timed out…", which is neither the title nor my result. The note also has no call ref, so I can't match it to my call.                                                |
| 5   | Update waiting. I relay: Needs you, "Review the Woolworths update (0.4.0)"                                                        | `needs-you` (button "Review update"), `site-overview-update` (button "Review Woolworths update"), `site-versions` (same), `global-palette` (both labels) | **Friction.** The title is right, but one action has three labels: Review update, Review Woolworths update, Review Woolworths.                                                                                                                                                                                                                                                                                                       |
| 6   | Missing login. I relay: "Give Valet your Woolworths login"                                                                        | `site-overview-needs-login`, `site-grant-sheet`                                                                                                          | **Works on the sheet.** The header badge says "Needs a login". No Needs you frame shows this item.                                                                                                                                                                                                                                                                                                                                   |
| 7   | Missing store. I relay: "Choose your Woolworths store"                                                                            | `site-store-sheet`                                                                                                                                       | **Works.** The open buttons vary: "Choose store…" (IA), "Change store…" (frame desc) and "Change…" (Overview card). No Needs you frame shows this item.                                                                                                                                                                                                                                                                              |
| 8   | Site limiting. I relay: "Woolworths is limiting requests; calls resume at 9:52 pm"                                                | `site-overview-limited`, `needs-you-empty`, `menubar-normal`, `activity-audit`                                                                           | **Friction.** Four forms of the same sentence: "Woolworths is limiting requests. Calls resume at 9:52 pm" (Overview), "Yahoo is limiting requests · calls resume at 9:52 pm" (Needs you, empty state), "Yahoo is limiting requests · resumes 9:52 pm" (menu bar), "Yahoo Finance is limiting requests…" (Sites list). The site's name changes too: Yahoo vs Yahoo Finance.                                                           |
| 9   | Paused. I relay: "Valet is paused, nothing was sent; resume from the menu bar or the Valet window"                                | `menubar-paused`, `global-pause-undo`                                                                                                                    | **Works.** The banner even quotes my result.                                                                                                                                                                                                                                                                                                                                                                                         |
| 10  | One site paused                                                                                                                   | `site-overview-paused`                                                                                                                                   | **Broken for me.** This is a new state: "Woolworths is paused… Resume Woolworths". It has no vocabulary row and no result string. I'd get "Valet is paused" (wrong), or a code.                                                                                                                                                                                                                                                      |
| 11  | Locked down                                                                                                                       | `global-lockdown`                                                                                                                                        | **Broken for me.** The dialog turns the endpoint off, so I get a transport error, not "Valet is locked down by the person" as IA section 7 claims.                                                                                                                                                                                                                                                                                   |
| 12  | Remote connection                                                                                                                 | `needs-you-approve-connection`, notification                                                                                                             | **Works.** "Type the code your browser shows" matches the browser page. The browser waiting page itself isn't drawn.                                                                                                                                                                                                                                                                                                                 |
| 13  | Failed call. I relay: "The person can see it in Valet, Activity, call 6B3E"                                                       | `activity-call-failed`                                                                                                                                   | **Friction.** The ref works and the trace even has a "Told Claude Code" step. But that step says "Failed · see call 6B3E", which isn't the text I received. The badge says "Failed · site changed" while the inspector's error class is `unexpected-response`. That code doesn't exist (core has `unexpected-shape`), and it isn't `site-changed`, which is what my result would say. So the person and I disagree on why it failed. |
| 14  | Login given up. The window says "Give up … tells Claude you didn't log in"                                                        | `login-handoff`                                                                                                                                          | **Broken in the spec.** Nothing tells me: my call returned needsUser at once. I only learn on my next call, and no result string exists for "the person gave up".                                                                                                                                                                                                                                                                    |

## Part 2. Round 1 pain points

1. **Updates invisible to the agent: partly fixed.** The IA says calls keep using 0.3.0 and the
   Needs you item has the right title (`needs-you`, `site-overview-update`). It is still unspecified
   what I'm told when I call a tool that only 0.4.0 adds (`get_rewards_balance`, shown waiting in
   `site-tools`).
2. **Paused read as unavailable: fixed** for Valet-wide pause (`menubar-paused`). **Not fixed** for
   per-site pause (`site-overview-paused`).
3. **No completion signal: not fixed.** "I'm done" and "Give up" (`login-handoff`) still don't
   reach me. No frame or IA section mentions a status tool or a waitable item.
4. **Raw codes instead of words: mostly fixed.** Titles are shared across Needs you, the popover,
   notifications and windows. It breaks at the edges: Missed lines, limiting lines, button labels,
   and the trace's error class.
5. **Fixes with no item or link: partly fixed.** The sheets exist with the right titles
   (`site-grant-sheet`, `site-store-sheet`), but no frame shows the Needs you rows "Give Valet your
   Woolworths login", "Choose your Woolworths store" or "Unlock 1Password". These are exactly the
   items I'd point at.

## Part 3. New problems

### Blockers

- **B1. One call ref is used for six different calls** (`needs-you`, `site-overview`,
  `site-overview-limited`, `login-handoff`, `menubar-missed`, `confirm-missed`, `global-palette`,
  `setup-test`):
  - remove_from_cart at 9:48 pm (`needs-you`, `confirm-*`, `connections-app`)
  - get_cart at 9:47 pm (`site-overview`, `login-handoff`; the same call is 9A71 in Activity)
  - a "too many requests" at 9:22 pm (`site-overview-limited`)
  - an ok get_cart at 9:53 pm (`global-palette`)
  - the setup test (`setup-test`)
  - the missed confirmation at 9:50 pm (`menubar-missed`)

  The call ref is the one thing I hand the person to type into ⌘K. If the wireframes don't hold it
  to one call, the build won't either. Make one table of refs and use it in every frame.
- **B2. Per-site pause has no agent wording** (`site-overview-paused`, also "Pause site" on
  `needs-you-empty`, `site-overview`, `site-overview-limited`). Add a vocabulary row and a result
  string: `{site} is paused in Valet, so this call was not started and nothing was sent (config: site-paused). Ask the person to open Valet, Sites, {site} and press Resume {site}.`
- **B3. IA section 7's Lock down row can't be true** (`global-lockdown`). With the endpoint off I
  get a connection error. Either keep the endpoint up, answering every call with `Valet is locked down by the person, so nothing was sent (config: locked-down). Ask them to unlock it in Valet.`,
  or delete the row and accept that a lockdown looks like "Valet isn't running". I'd keep the
  endpoint up for local apps. A refusal is safe, and it is the only way I can tell the person why.

### Major

- **M1. "Give up" and "I'm done" promise to tell me something nothing tells me** (`login-handoff`,
  `login-handoff-not-yet`). Change the line to "Claude finds out on its next call". Add result
  strings for the next call: `The person gave up logging in to {site} at {time} (needs-user: given-up). Ask them before trying again.`
  and `The login window for {site} closed at {time} without a login (needs-user: missed).`
- **M2. The trace's "Told Claude Code" step isn't what I was told** (`activity-call-failed`). Show
  the exact result text, copyable. This is the one place P1 and P4 can check the shared vocabulary
  against reality. Also fix the error class: `unexpected-response` isn't a code, and the badge
  ("site changed") disagrees with it.
- **M3. One action, three labels** for the update review: "Review update" (`needs-you`,
  `menubar-waiting`), "Review Woolworths update" (`site-overview-update`, `site-versions`,
  `global-palette`) and "Review Woolworths" (first install). Pick "Review update" on a row whose
  title already names the site, and "Review the Woolworths update" everywhere else.
- **M4. The limiting sentence has four forms and two site names** (`site-overview-limited`,
  `needs-you-empty`, `menubar-normal`, `sites-list`, `activity-audit`). Use one template:
  "{site} is limiting requests · calls resume at {time}", with the full site name.
- **M5. Missed lines drop the site and the retry note uses other words** (`menubar-waiting`,
  `menubar-missed`, `confirm-missed`, `needs-you`):
  - The popover's Missed line should read "Missed: Confirm: Remove from cart (Woolworths) · 9:50 pm".
  - The retry note should read "In Valet, 'Confirm: Remove from cart (Woolworths)' was missed at 9:50 pm (call 7F2A). Please try again; I'm at the Mac now."
  - Use one label for the button: "Copy a retry note for Claude". The popover says "Copy a retry
    note", and the trace's similar button is "Copy a repair note".
- **M6. Needs you rows for three item kinds aren't drawn** ("Give Valet your Woolworths login",
  "Choose your Woolworths store", "Unlock 1Password"). Add them to `needs-you` (or a second state of
  it) so their titles, main actions and links are fixed.
- **M7. The icon count disagrees with the Needs you count** (`menubar-icon-notification`). The icon
  shows "3" and says "Same number as the sidebar and the popover", but those say 4 in the same
  moment (`menubar-waiting`, `needs-you`). If the review doesn't count, say so in every count.

### Minor

- **m1.** The Needs you header says "4 waiting", the popover says "4 things need you", and the frame
  title says "three things waiting" (`needs-you`). Pick one wording.
- **m2.** "Needs a login" (badge) vs "Give Valet your Woolworths login" (title)
  (`site-overview-needs-login`). The badge is fine as a status, but the Sites list row should use
  the title.
- **m3.** The site row in the popover says "Needs you: log in · 0.4.0 waiting for review"
  (`menubar-waiting`). Use the Needs you titles, shortened only by dropping the site name.
- **m4.** Notifications carry Answer, Decline and Approve… buttons (`menubar-icon-notification`).
  Today's code allows no notification actions. That's fine as a decision, but record it, since a
  Decline from the lock screen reaches me as "the person declined".
- **m5.** The approve-connection sheet's tool names ("Change cart (asks you to confirm removals)")
  aren't tool titles (`needs-you-approve-connection`). Use the titles shown in `site-tools`.
- **m6.** The IA's "Failure" example uses 7F2A, which the frames use for a confirmation.

## Part 4. Verdict

**I'd sign off on the IA with conditions, but not on the wireframes yet.** The shared titles hold
across Needs you, the menu bar, notifications and both windows, which is the core of what I asked
for. Before the design thread maps components onto the frames, it must fix:

- **Blockers:** B1 (one ref per call), B2 (per-site pause wording), B3 (Lock down result).
- **Major:** M1 (Give up and missed login reach me), M2 (exact result text in the trace), M3 and M4
  (one label each), M5 (Missed lines and the retry note), M6 (the three undrawn Needs you rows), M7
  (counts).
