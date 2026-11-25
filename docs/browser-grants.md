# Browser grants

Plan and open decisions: the "Browser grants: scope and plan" doc (2026-11-25). Nick's direction:
an agent that needs a site asks for a signed-in browser for it, Nick approves from his phone, the
agent studies the site and builds tools, and Nick approves those tools as a versioned adapter. The
grant is the wide access used only to build the narrow one.

## What is built (first part, read only)

- **Approval kind `browser-grant`** (packages/core/src/approvals.ts): adapter id, draft id, the
  installed adapter's https origins, the agent's `purpose` (shown as its words), `mode: "read"`,
  at most 120 minutes. One confirm on the Mac or phone, like every other approval.
- **The ask**: `valet_request_signed_in_browser` (draft id, purpose, minutes). The tool's name
  avoids "grant" on purpose: no agent tool sounds like it approves anything. Same limits as
  `valet_request_session`: a draft started from `installed`, an adapter the person is signed in
  to, agents on the Mac only until a red team has tried it with cloud agents.
- **The browser**: once approved, the draft's scratch browser opens with the installed adapter's
  tool-partition cookies for its cookie domains, copied in one way into its in-memory partition
  (`ScratchRules.signedIn`, packages/browser-electron/src/scratch.ts). While signed in:
  - only GET, HEAD and OPTIONS requests leave it; anything else is refused and counted;
  - cookie values are replaced with `[cookie]` everywhere the agent reads, as for any scratch
    browser, and the seeded ones are scrubbed from the start;
  - a page that looks like payment, card, bank, payee, password, email, two-factor or account
    deletion settings closes the browser with a sentence saying why (sensitive-page.ts: the
    address's words and the form fields' types, autocomplete and names). It's a best guess; read
    only is what stops a change.
- **Ending**: at its time (the browser closes on a timer), from the draft's page (**End now**,
  which ends a lent session too), on lockdown, and when the draft is submitted for install: the
  tools are written, so the wide access ends then, a little before the person approves them.

## A site with no adapter yet

For now through what exists, so no new path ever handles a password: the agent writes a small
first version that only signs in (its declarative `auth` flow, its login credential, its session
cookies) and one read tool that proves it, such as the account name, and submits it. The person
approves the install and the login item as for any adapter; Valet signs in itself, in its auth
partition, and hands the session one way to the tool partition. The agent then starts a draft
from `installed` and asks for the signed-in browser. The authoring guide says so.

That is three approvals for a new site (the install, its login, the browsing). Folding them into
one card is the follow-up, in line with the permissions redesign's "one confirm".

## Not built yet

- One card for a new site's sign-in adapter, its login and the browsing.
- "Can act" grants with a card for each change.
- The phone's "Live now" bar and End button; today the grant shows on the Mac's draft page.
- Cloud agents (after a red team).
- Telling the agent which requests read only refused, beyond the count.
- Hiding sensitive API responses in the network log of a signed-in browser.
