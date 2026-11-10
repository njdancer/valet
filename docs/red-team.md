# Adversarial review and red-team passes

Nobody reads this code line by line ([D71](plan.md#d71-who-reviews-agent-built-code)). This is what
stands in for that: a brief an agent can pick up cold, the attacker roles to play, and a record of
each pass. The security model's two guarantees are the target:

1. Adapter code never obtains a secret's value.
2. Adapter code can't cause a secret, or a session a secret produced, to reach anything outside the
   hosts its manifest declares.

A third thing is worth attacking although the model doesn't number it: one MCP client must not be
able to act as, read from, or interfere with another.

## The critical paths

A change under any of these gets an adversarial review before it merges, by an agent that didn't
write it.

| Path                                                                       | What it holds                                       |
| -------------------------------------------------------------------------- | --------------------------------------------------- |
| `packages/auth-flow/src`                                                   | The secret filler and the checks before a fill      |
| `packages/credentials/src`, `swift-bridge/Sources`                         | The resolver, the grant store, the Swift helpers    |
| `packages/browser-electron/src`                                            | The request filter and the partitions               |
| `packages/runtime/src`                                                     | Redaction, the audit chain, rate budget and breaker |
| `packages/mcp-server/src`                                                  | The endpoint's auth, sessions and result shaping    |
| `packages/core/src`                                                        | The manifest parser and the fixed vocabularies      |
| `apps/desktop/src/main` (IPC, approvals, the permission diff, the updater) | What the person approves, and what the app installs |

## The roles

Each pass plays one role, against the fake site and the test doubles only.

| Role                  | Starts with                                    | Tries to                                                                                       |
| --------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Hostile adapter       | A manifest and tool code the person approved   | Read a canary secret; send a request to an undeclared host; get free text to the client or log |
| Hostile page          | Control of what the fake site serves           | Get a secret typed into the wrong field or origin; get instructions or a secret into a result  |
| Hostile MCP client    | One valid client token                         | Use or disturb another client's session; skip a confirmation; exhaust the site's rate budget   |
| Hostile local process | The person's user account, no token            | Read a token or secret from disk; talk to the endpoint; forge an audit entry                   |
| Hostile update feed   | Control of the feed's bytes                    | Get an unsigned or older build installed                                                       |
| Hostile remote client | A remote credential (once remote mode has one) | Reach a tool the person didn't enable remotely; outlive the kill switch                        |

## Rules

- Never the live site, a real account, real 1Password, Keychain or Messages. A canary secret stands
  in for the password.
- Read the security model's section for the role first, and its **Not caught** and **Out of scope**
  notes: a known gap is not a finding, though a cheaper way through one is.
- A finding is a test that fails. Write it, watch it fail, then fix the code and watch it pass.
  A suspicion that can't be turned into a test goes in the record as a suspicion.
- Fix what is small. What needs a design change becomes a decision in the plan.
- Add a row to the record below, even for a pass that found nothing: what was tried matters as much.

## When

- **On change:** any PR touching a critical path. The reviewing agent gets the diff and this brief,
  not the author's reasoning.
- **On a schedule:** one role each week, in the order of the table, so every role comes round about
  every six weeks. More often for a path that changed a lot.
- **Before M8:** every role, by agents that haven't worked on the project.

## Record

### 2026-11-10: hostile MCP client

Scope: `packages/mcp-server/src` (the HTTP handler, the local authenticator, result shaping, tool
names, the remote policy), read in full.

- **Found and fixed: one client could end another client's sessions.** Sessions were capped at 32
  across all clients and the least recently used was closed, whoever owned it. A client holding one
  valid token could open sessions in a loop and close every other client's, which also aborts
  whatever call was running in them, a half-finished write included. Now the client holding the
  most sessions loses its own oldest. Test: "closes a flooding client's own sessions, never another
  client's" in `packages/mcp-server/test/http.test.ts`.
- **Known, with another thread:** a client can start calls without limit and they queue on the
  adapter lock without bound. The local listener has no per-client cap; the remote policy has one.
- **Tried, held:** using another client's session id with one's own token (answers as not found);
  a token anywhere but the `Authorization` header (only that header is read);
  a `localhost` or rebinding `Host` (refused before the token is looked at); getting text of one's
  own into a result through the client name, a progress token or a tool argument (the name reaches
  only the audit log and the app, flattened and cut; results are built from fixed templates and the
  parsed output); a tool name that shadows another adapter's (both are withheld).
- **Not tried yet:** the Swift bridge's own parsing; the app's client-token files and "Reset
  access" ordering under a race; slow or half-open connections from a process with no token.
