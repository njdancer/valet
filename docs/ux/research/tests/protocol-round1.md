# Test protocol, round 1: tree test, first-click and hypothesis feedback

Read `../hypotheses-round1.md` first.

## Part 1. Tree test (three navigation candidates)

For each task, for each tree, say the path you'd click, whether you're confident (sure / unsure /
lost), and any second guesses. Answer for IA-A first, then IA-B, then IA-C. Don't let your answer on
one tree change the next; the order is fixed so you'll naturally learn, so say if you did.

### Tree IA-A

- Needs you
- Sites
  - Woolworths: Overview · Tools · Permissions · Versions · Activity
  - Yahoo Finance: (same tabs)
- Activity
  - Calls (filters: site, tool, client, outcome, time) → a call's trace
  - Audit log
- Connections
  - MCP endpoint · Apps on this Mac · Remote clients · Remote access settings → a client's page
- Secrets
  - Password sources · One-time codes · Grants
- Settings
  - General · Notifications · Data and privacy · Updates · Reset

### Tree IA-B

- Needs you
- Sites (same as IA-A)
- Calls → a call's trace
- Audit log
- Connections (same as IA-A)
- Secrets (same as IA-A)
- Settings (same as IA-A)

### Tree IA-C

- Home (Needs you, each site's health, today's numbers)
- Sites (same as IA-A)
- History
  - Calls → trace
  - Audit log
- Access
  - Connections (endpoint, apps, remote)
  - Secrets (sources, codes, grants)
- Settings (same as IA-A)

### Tasks

T1. Approve the Woolworths 0.4.0 update.
T2. Find why the last get_cart call failed.
T3. Revoke Claude Code.
T4. Turn on remote access for a cloud agent.
T5. Change the Woolworths store.
T6. See which calls used the Woolworths login password.
T7. Verify the audit log hasn't been tampered with.
T8. Turn on SMS codes from Messages.
T9. Woolworths seems to be blocking you: find out until when.
T10. See what Claude Desktop can call.
T11. Change how long traces are kept.
T12. Approve a cloud agent that's waiting with a code.

## Part 2. Label preference

Pick and justify: Sites vs Adapters; Connections vs Clients vs Connected apps; Secrets vs Passwords vs
Credentials; Activity vs History; Needs you vs Inbox vs Waiting.

## Part 3. Hypothesis feedback

For each of E1 to E11 and P1 to P11 (and the vocabulary table): accept / refine / reject, with one or
two sentences in the persona's voice and the concrete change you'd want. For E1 say whether E1 or E1b
would have let you find the update review. For P8 pick P8a, P8b or P8c.

## Part 4. Anything the hypotheses missed

The persona's biggest remaining worry if all hypotheses shipped.

Write the answers to `tests/round1-<persona file name>.md`, 1000 to 2000 words.
