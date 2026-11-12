# The approval broker

Workstream D of [plan-agent-run.md](plan-agent-run.md). Draft, 2026-11-12. It builds what
[agent-run-security.md](agent-run-security.md) (B) calls the approvals flow and the trusted stores,
against B's contracts in `packages/core` (`approvals.ts`, `trusted-store.ts`, `devices.ts`,
`signing.ts`, `relay-protocol.ts`), and renders A's card spec
([ux/agent-run/approval-cards.md](ux/agent-run/approval-cards.md)). Status marks are the security
model's: **Built** has code and tests, **Designed** is decided here and not yet built.

## What it does

One service in the Mac app's main process through which every widening passes (D74's `approve`
and `approve-each-use` tiers). It:

1. builds each request from the Mac's own knowledge (`serializeRequest`), with the tier from
   `KIND_TIER` and the life from `APPROVAL_TTL_MS`;
2. holds it as pending in a trusted store, so it survives a restart, and audits
   `approval-requested`;
3. shows it in the Mac's Needs you and sends it to every paired phone that may approve it;
4. accepts an approval only as a signed decision that passes `verifyDecision` in `live` mode,
   whether it came from the Mac's own Touch ID or a phone's Face ID;
5. moves the request from pending to evidence in one anchored write, and only then acts;
6. enforces the fatigue limits (`APPROVAL_LIMITS`), expiry, withdrawal and lockdown;
7. answers "is this approved?" for every widening record from that evidence, checked again on
   every load (`verifyEvidence` in `stored` mode).

It never decides a tier from what a caller says, and it offers nothing over MCP that answers a
request (`NEVER_OVER_MCP`). Workstream E's write tools call `broker.request(...)` and read the
outcome back; they can withdraw their own requests and nothing else.

## Options considered

### Where an approval on the Mac comes from

| Option                                                                                                | Verdict                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keep today's click on an armed panel (the confirmation broker's `CONFIRM_ARM_MS`)                     | Refused. A synthetic click (Accessibility, a hostile renderer, a script) approves. Stores would hold a bare `true` anyone who writes the file can forge.                            |
| `LAContext.evaluatePolicy` in a helper, which answers "yes" to Electron                               | Refused. The proof is a boolean on a pipe; nothing a store can keep and re-check later, and a stolen helper socket says "yes".                                                      |
| **The Mac's own Secure Enclave approval key, `.userPresence`, signs the same decision a phone signs** | **Chosen.** One verification path for both devices. The gesture is in the signature: no finger, no signature. Stored evidence is uniform, and the Swift helper never returns a key. |

### Where evidence lives

| Option                                                                                                                    | Verdict                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add an `evidence` field to every existing store (runtime approvals, grants, remote policy)                                | Six schemas change, each store needs its own anchor and its own crash handling, and a pending request and the record it creates are in different files, so a crash between them loses one or doubles the other.                                |
| **One anchored ledger, `trusted.json`, holding pending requests, evidence, device records, revocations and safety state** | **Chosen.** Approving is one anchored write that removes the pending request and adds its evidence together. Today's stores keep their data; every read that would widen asks the ledger too, and a record the ledger doesn't back is ignored. |

The second meets B's rule in substance (every widening record is honoured only with valid
evidence; the file is anchored; tightening records are covered by the anchor) with one file and one
anchor. B is told (see "Contract changes asked of B").

## Components

All in `apps/desktop/src/main/core/approvals/`, plain TypeScript with ports, so tests run in Node
with fakes. **Built** in the first PR unless marked.

| Module             | Does                                                                                                                                                                                          |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `anchored-file.ts` | A JSON file under a `StoreAnchor`: `checkAnchor` on load, two-phase `beginWrite` / write and fsync / `commitWrite`, `advance` recovery, and `interrupted` or `mismatch` reported, not hidden. |
| `ledger.ts`        | The trusted ledger's schema and its operations, serialised through one queue.                                                                                                                 |
| `devices.ts`       | The Mac's self-signed record, phones' Mac-signed records, revocations; implements `DeviceLookup`. Refuses to revoke the Mac.                                                                  |
| `broker.ts`        | Requests, limits, live decisions, declines, withdrawal, expiry, lockdown, and `honoured(kind, matches)` for stored evidence.                                                                  |
| `signer.ts`        | The `MacSigner` port and a software signer for tests and dev builds.                                                                                                                          |
| `phone-inbox.ts`   | Every message from a phone, through `parsePhoneToMac`, then to the broker or the safety switches.                                                                                             |
| `prompts.ts`       | The words the OS prompt and the tool results use, in the app's wording from A's spec.                                                                                                         |

**Designed**, in later PRs:

- `swift-bridge`: an approval-key command in `valet-keychain` (create a Secure Enclave P-256 key
  with `.userPresence`, return its SPKI; sign a payload under the domain after Touch ID with a
  reason the app supplies; sign a batch under one `LAContext` for migration). Debug builds only may
  use a software key file, as the throwaway keychain does today. And the Keychain-backed
  `StoreAnchor` (a generic password item under the app's designated requirement).
- Wiring into `service.ts`: installs, updates and rollbacks; grants; local and remote tool enabling;
  remote consent; loosening settings; resume; the irreversible confirmation. The Mac card in Needs
  you and the Review page, from A's wireframes. Migration of today's records.

### Ports

```ts
interface MacSigner {
  /** Public keys, creating the device's keys on first use. Never a private key. */
  keys(): Promise<{
    approvalKey: string
    transportKey: string
    agreementKey: string
  }>
  /** Shows the OS prompt with `reason`; resolves the signature, or null if the person cancelled. */
  sign(domain: SigningDomain, payload: string, reason: string): Promise<string | null>
}
interface PhoneOutbox {
  /** Seals and sends one message to one phone (G and H). Absent until the relay exists. */
  send(deviceId: string, message: MacToPhoneMessageBody): void
}
```

`StoreAnchor`, `AuditSink` and `DeviceLookup` are B's. The clock and randomness are injected.

## The ledger

```ts
{
  v: 1,
  devices:     SignedText[],             // each verified by verifyDeviceRecord on load
  revocations: DeviceRevocation[],
  pending:     { requestText, requester, notified: deviceId[] }[],
  evidence:    Evidence[],                // B's evidenceSchema
  safety:      { lockdown: boolean, pausedRemote: boolean, since: string | null },
  declines:    { clientId, at }[],        // the fatigue window, pruned to the last two hours
  asks:        { clientId, at }[],        // requests agents made in the last day (the daily cap)
}
```

- **Load.** Read the file, `checkAnchor` it. `ok` and `fresh` load; `advance` loads and commits.
  `interrupted` loads the committed file (the anchor vouches for it) and locks down, because the
  lost write may have been a revocation; the person repeats the change and resumes at the Mac.
  `mismatch` (or a file that doesn't parse) loads nothing, locks down, audits `store-refused` with
  `anchor-mismatch`, and raises a Needs you item at the Mac. Nothing is written while the ledger is
  in either state, so the anchor can't move past the evidence of tampering; a `resume` approved at
  the Mac writes the in-memory ledger afresh and anchors it.
- **The Mac's own record isn't stored.** It's built at each launch from the signer's public keys,
  which are the root everything else is checked against, so a file can't swap the Mac's key and
  there is no Touch ID at first launch. (B's design has it self-signed; a stored self-signed copy
  adds nothing.)
- **Records.** A device record counts only if `verifyDeviceRecord` passes against the Mac's
  approval key; the Mac's own record must self-verify and its key must equal the signer's
  `approvalKey` (a file that swaps the Mac's key fails). A pending entry counts only if
  `parseRequestText` accepts it and it names this Mac. Evidence is checked lazily, per question,
  with `verifyEvidence` (stored mode), and a failure is audited once per load as `store-refused`
  with `evidence`.
- **Writes** go through one queue. Each is `beginWrite` → write the temp file, fsync, rename →
  `commitWrite`. A failure before the rename abandons the begun write and the change is not done.
  Once the rename succeeded the new file is the truth: a failed commit is retried, and if it still
  fails the next write (or load) completes it as `advance`, so the broker never reports a change
  as failed that will in fact stand. A tightening (a revocation, lockdown) that can't be written is
  held in memory for the rest of the run, so a failed write never loosens.

## A request's life

```
          request()                 decision passes verifyDecision (live)
 (none) ───────────▶ pending ───────────────────────────────────────────▶ approved ─▶ apply
                       │  │  decline from the Mac or a paired, unrevoked phone
                       │  └────────────────────────────────────────────▶ declined
                       │ expiresAt passes ─────────────────────────────▶ expired
                       │ the asker withdraws, a newer one replaces it,
                       └ lockdown, the client is revoked ──────────────▶ withdrawn
```

### `request(kind, subject, requester, agentNote)`

Refused, with a reason the tool result can say (A's section 11), when:

- Valet is locked down, unless the kind is `resume`;
- an agent asks for `device-pair` or `irreversible-call` (only the app raises those), or for
  `resume` (only the person);
- the agent has `pendingPerClient` (3) waiting, or all agents `pendingTotal` (10);
- the agent has `declinesBeforeCooldown` (3) declines within `declineWindowMs`; it is refused
  until `cooldownMs` after the last of them;
- the agent has made 20 requests in the last day, whatever became of them, so withdrawing and
  asking again can't push cards to a phone without end (A's number, pending B);
- an agent asks to turn a tool on remotely for anyone but itself, or names a client on a local
  request;
- the same requester already has a pending request of this kind for the same subject: that one is
  returned instead (idempotent, so a retrying agent doesn't fill its quota).

Otherwise the broker fills in `v`, a random 128-bit `id`, `macId`, `tier`, `createdAt` and
`expiresAt`, calls `serializeRequest` (which throws on anything malformed: a bug in the Mac's own
builder, never a refusal reason shown to the agent), writes the pending entry, audits
`approval-requested`, notifies the Mac window, and sends `approval-request` with the exact text to
each paired, unrevoked phone in `approvableOn`. An `irreversible-call` is never written to the
ledger (`NEVER_STORED`): it lives in memory for its 2 minutes and is lost on restart, as the call
that raised it is.

### `answer(signed, from)`

`from` is `{ via: 'mac' }` or `{ via: 'phone', deviceId }` (the envelope's sender). In order:

1. Find the pending entry named by the payload's `requestId` (parse only for that). None: audit
   `refused` / `not-pending` and stop.
2. `verifyDecision(signed, pending, { mode: 'live', isPending, now })`.
3. The decision's `deviceId` must be `from`'s device (the Mac's id for `via: 'mac'`). A phone can
   relay another phone's valid signature only as itself, and is refused as `wrong-device`. `from`
   is the HPKE-authenticated sender, not the envelope's unauthenticated `from` field.
   Then: a `resume` must be signed by the Mac (stricter than `approvableOn`: lockdown is what the
   person reaches for when a phone is lost); nothing but a `resume` is approved while locked down;
   and a decision is refused if the Mac receives it more than 5 minutes after the device dated it,
   or dated more than 2 minutes ahead (A's "Not confirmed yet" window). The device's clock is used
   only to refuse, so a relay holding an approval back for hours can't use it.
4. The kind's **precheck**: is the subject still true? An install's `previousHash` is still the
   active approved hash and its package is still stored; a grant's adapter hash is still
   installed; a tool's hash and side effect are unchanged; a consent's OAuth session is still
   open. A stale request is withdrawn (`stale`), never applied.
5. One ledger write: remove the pending entry, append `Evidence { requestText, decision,
receivedAt: now }` (not for `NEVER_STORED` kinds). If the write fails, nothing was approved.
6. Audit `approval-answered` / `approved` with the device id; close the card everywhere
   (`approval-closed`); then run the kind's **apply**. If apply throws, the evidence stays (the
   person did approve) and the failure is shown as a Needs you item with a retry that re-runs apply
   only, never a second approval.

Every refusal is audited with its reason, and the pending request stays pending: a forged or
stale signature must not be able to cancel a real request.

### Decline

A decline needs no signature (B). It's accepted from the Mac window, or from a phone message whose
envelope names a paired, unrevoked device. The request leaves pending, the decline counts towards
the requester's cooldown, and the card closes everywhere.

### Expiry, withdrawal, lockdown

A timer at the next `expiresAt` expires due requests; load also expires anything already past.
The asker may withdraw its own request; a newer draft submission withdraws the asker's own older
one for the same adapter (`replaced`), never another agent's (A's R41: both cards stand). A
request may name the asker's own waiting request it `replaces`: in one step of the broker's
queue, the new one is made and the old one withdrawn as `replaced`, and the old one doesn't count
against the asker's limits. Refused (cooling down, locked down, a limit), the old one stays. Lockdown
(from the Mac or a phone command) withdraws every pending request, removes all `remote-client`
and `authoring-session` evidence (B: lockdown revokes remote clients and ends sessions, and resume
brings none back), then sets `safety.lockdown`. It runs in the broker's one queue, so an approval
that arrives after it is refused. Revoking a client withdraws its requests.

## Approving at the Mac

The Needs you card's **Approve with Touch ID** sends `approve-on-mac(requestId)` over IPC from the
control panel. The main process looks up the pending request itself, builds the decision
(`macId`, `requestId`, `digest`, its own `deviceId`, now), and asks the `MacSigner` to sign
`decisionPayload(decision)` under `valet/approval-decision/v1`, with a reason from `prompts.ts`:
"approve installing an adapter for yahoo.com". The reason is built only from Mac-derived fields
(the hosts in the Mac's diff, whether code runs unsandboxed, a tool's identifier and scope, a
grant's origins, the kind) and the request's ref, never the adapter's display name or the agent's
note. The OS prompt is the one surface a compromised renderer can't draw, so it names the facts
that matter. Then it is `answer(signed, { via: 'mac' })` like any phone's.

- A synthetic click only raises the Touch ID prompt. Without the person's finger (or password),
  nothing is signed. One prompt at a time; a second click while one is open does nothing.
- The renderer never sees a signature or a key. IPC carries only the request id.
- `device-pair`, Mac-only installs and `resume` can be approved here and nowhere else.
- **Designed (PR 3):** the IPC handler accepts `approve-on-mac` only for the request the
  main-process-owned window it came from is showing (as today's confirmation panel checks
  `from.shows`), and rate-limits prompts per window. For critical and pairing cards the Swift
  helper draws its own native sheet from the request text before the Touch ID prompt.

## Approving on a phone

`phone-inbox.ts` takes `(fromDeviceId, plaintext)` from G's channel after it opened an envelope.
It parses with `parsePhoneToMac` only, and drops anything from a device that isn't paired or is
revoked. Then:

- `approval-decision` → `answer(decision, { via: 'phone', deviceId })`;
- `approval-decline` → `decline(requestId, deviceId)`;
- `command` → the tightening switches: pause remote, lockdown, revoke a client, revoke a device
  (never the Mac: `parsePhoneToMac` already refuses that, and the device store refuses it again);
- `ack` → G's channel.

Sequence numbers are G's: a replayed decision fails as `not-pending`, a replayed command only
tightens again.

## Asking "is this approved?"

`broker.honoured(kind, matches)` returns true only if some evidence of that kind passes
`verifyEvidence` against the current devices and `matches` its subject to the record in hand. The
service's gates use it:

| Gate                             | `matches`                                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| An adapter hash may run          | `adapter-install` with this `adapterId` and `adapterHash`, and no later install evidence for the same adapter      |
| A grant may be used              | `secret-grant` with the grant's adapter, hash, secret, provider, `itemFingerprint` of its `itemRef`, and origins ⊇ |
| A tool is on for a remote client | `tool-enable` with the adapter hash, tool, `scope: 'remote'`, and `clientId` null or this client                   |
| A remote client may connect      | `remote-client` with its client id                                                                                 |
| A loosened setting stands        | `setting` with the scope, adapter, setting and `to` value                                                          |

Revoking one of these removes its evidence from the ledger (a tightening, no signature).

## Migration

**Built** for installs and grants. The first launch of a signed build records, once, a `legacy`
list in the anchored ledger: the adapters approved in `approvals.json` whose active hash is the
one this app ships, and the grants for those hashes. "Built in" is always the shipped hash, never
the `source` tag in the store's `state.json`, which is a plain file anything can write. Each record
is honoured until the person confirms it with Touch ID or it is revoked or rejected, and the list
only ever shrinks: once any version of an adapter is approved with Touch ID, that adapter's legacy
records and its other versions' evidence go, so an old version put back as active by hand needs
Touch ID again. A later hand-written `approvals.json` approves nothing: the install gate needs the
applied mark there _and_ signed evidence (or the legacy record).

The migration never runs again. A ledger reset after a tamper (the person resuming at the Mac)
writes an empty `legacy`, so what `approvals.json` and the store hold after a tamper is never
carried over; the person approves each adapter again with Touch ID. B's condition for grants: a
legacy grant is honoured only for the origins and fields the built-in's own manifest declares.
The migration screen (one Touch ID per record) comes with the grants PR.

Accepted: a built-in update that ships with the first signed release (a new hash the store makes
active on launch) is not carried over, because nobody approved that hash. It asks for Touch ID
like any update.

Installs, updates and rollbacks are signed `adapter-install` requests at the Mac. The subject's
permission lines are the Mac's own diff in B's areas (`approvals/install-subject.ts`), with the
sandbox's own lines from `sandboxPermissionChanges` (a `command` exception reads "which can read
your files", critical). `unsandboxed` comes from the manifest's `sandbox.mode`, or, in a build
without the sandbox, from not being one of the app's shipped hashes; an unsandboxed version always
carries the critical sandbox-mode line, so it is Mac only. A line never
loses an item it can't print: hidden or control characters are written out as their codes, the
purpose of a request or tool is kept outside the cut, a secret's line says which origins it may be
typed into, and past 50 items the last one says how many were left out. The gate binds the sandbox
mode: evidence counts only if its `unsandboxed` matches how the hash would run now. A rollback asks
for Touch ID before anything is swapped, and the version it replaces keeps its approval until the
swap has worked, so a failed swap leaves the running version approved. A signed install whose apply
didn't finish (a crash after the evidence was written) is applied at the next launch without asking
again.

## Wiring into the app

The broker opens in `AppService.start()`, right after `app-state.json`, so a ledger that doesn't
match its anchor locks Valet down before the first call. Where its keys and anchor come from is
`approvals/mac-keys.ts` (**Built**):

| Build                                   | Signer                                                                                                                                                                     | Anchor                                                                     |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Packaged, not demo (a release)          | `valet-approver` only. Missing or failing: nothing can be approved                                                                                                         | Keychain, service `valet.anchor`. No Keychain helper: the ledger is locked |
| Dev, helper built and reaching the SE   | `valet-approver`                                                                                                                                                           | Keychain, service `valet-dev.anchor`, or a file when there's no helper     |
| Dev without a working helper, demo, e2e | Software keys kept in `dev-approval-keys.json` (0600), so a restart is the same Mac. A native dialog of the main process stands in for Touch ID; the e2e suite answers yes | A file in the data folder (`dev-anchor.json`): it only catches accidents   |

A reset or uninstall removes the anchor too (erase step `approvals-anchor`), or the next launch's
empty folder wouldn't match it.

### Every loosening path, and what it becomes

Each IPC path that widens what an adapter, a client or an agent can reach, mapped to a kind, or
marked as a tightening (no signature) or as not widening. **Built** rows are in this PR; the rest
are the next PRs of this workstream.

| IPC path                                     | Becomes                                                                                                                                                                              | Status             |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ |
| `answerConfirmation(id, true)`               | `irreversible-call` (app-raised, never stored), Touch ID from its own panel                                                                                                          | **Built**          |
| `answerConfirmation(id, false)`              | Decline: tightening, any app window                                                                                                                                                  | **Built**          |
| `app.setLockedDown(false)`                   | `resume { from: 'lockdown' }`, Mac only                                                                                                                                              | **Built**          |
| `app.setLockedDown(true)`                    | Tightening: app-state and the ledger                                                                                                                                                 | **Built**          |
| `app.setPaused(false)`                       | Not signed: Valet's own Pause is in memory and a restart lifts it anyway                                                                                                             | Decided            |
| `approvals.approve(id, hash)`                | `adapter-install`; the install gate asks `honoured`, bound to sandbox mode                                                                                                           | **Built**          |
| rollback (PR #77's `rollbackNow`)            | `adapter-install` with `source: 'rollback'`                                                                                                                                          | **Built**          |
| `approvals.reject`                           | Tightening                                                                                                                                                                           | **Built**          |
| `grants.make`                                | `secret-grant` (Touch ID); the grant gate hands out only signed grants, or legacy ones within the manifest's origins                                                                 | **Built**          |
| `grants.revoke`                              | Tightening: the evidence, the legacy record and the store                                                                                                                            | **Built**          |
| `grants.resync`                              | Not widening: the same item, origins and fields                                                                                                                                      | Decided            |
| `remote.setTool(…, true)`                    | `tool-enable { scope: 'remote', clientId: null }` (Touch ID)                                                                                                                         | **Built**          |
| an agent's own remote tool                   | `tool-enable { scope: 'remote', clientId: 'remote:<its id>' }`: a tool already on for remote clients, added to that client's grant only. It never turns a tool on for remote clients | **Built**          |
| `remote.setTool(…, false)`                   | Tightening                                                                                                                                                                           | **Built**          |
| `remote.setEnabled(true)`, `remote.setHosts` | `setting { scope: 'valet' }` (`remote_enabled`, `remote_hosts` adding a host); off and fewer hosts are clicks                                                                        | **Built**          |
| `remote.approveConsent(code, tools)`         | `remote-client`, app-raised, the typed code in the signed decision; a wrong code goes straight to the three tries                                                                    | **Built**          |
| `settings.set({ messagesOtpEnabled: true })` | `setting { scope: 'valet' }`: `messages_otp` on, `notifications` off, `trace_retention` shorter (A's R6); their opposites are clicks                                                 | **Built**          |
| other `settings.set` fields                  | Not widening                                                                                                                                                                         | Decided            |
| `adapters.setSetting` (a store)              | Not widening: a value the adapter declared (`setting.adapter-choice`)                                                                                                                | Decided            |
| `adapters.setPaused(…, false)`               | Not signed for now: the person's own per-site stop. Moves into the ledger                                                                                                            | Next (ledger only) |
| `clients.add`                                | Not signed: a local client the person configures at the Mac                                                                                                                          | Decided, told to B |
| `endpoint.setListening(true)`                | Not signed: local only, the person's own switch                                                                                                                                      | Decided, told to B |
| `app.erase`                                  | The main process's own native dialog decides                                                                                                                                         | Unchanged          |

Known gaps, next in this workstream:

- Settings, remote access and remote clients are gated where they change, not where they are read.
  An agent that can write `settings.json`, `remote.json` or the remote client file directly isn't
  stopped yet. Grants and installs are already checked against evidence when used. The plan is to
  check the stored widening values against `setting` and `tool-enable` evidence at launch, and to
  fall back to the narrow value when nothing matches.
- A legacy grant record names the adapter, the hash and the secret, but not the item or the
  provider. A hand-edited `itemRef` in an old grant would still be honoured within the manifest's
  origins until the person grants it again.

The confirmation panel keeps its short arm delay as a UI nicety, but the main process no longer
counts a click: `answerConfirmation(id, true)` from the panel opened for `id` only calls
`approveOnMac`, and resolves false if the person cancels Touch ID. The panel shows the request's
ref (`ConfirmationItem.ref`), which the Touch ID prompt names. A paired phone may approve the same
request; the broker's apply then lets the call go ahead. The confirmation request is app-raised,
so it never counts against an agent's limits. Its subject names the confirmation (`confirmationId`, B's contract v2.1), and its preview lists the requests it would make and the adapter's note, so two questions of one call never share a request and an approval applies only to the one it was signed for.

An adversarial review of this wiring found that sharing, a release build using the dev build's
anchor (`app.getName()` is "Valet", not "valet"; the same bug made release builds use the dev
Keychain-copy service and token ownership, fixed with it), the ledger's lockdown lost when the
keys can't be read at launch (the ledger now opens first and on its own), a double Unlock click
withdrawing the first prompt, and a timed-out confirmation reported as approved. All fixed.

## Failure cases

| Case                                                   | What happens                                                                                            |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| The same signed approval arrives twice                 | Second is `not-pending`, audited, nothing happens                                                       |
| A phone's approval for a request the Mac answered      | `not-pending`; the phone already has `approval-closed`, A's "Not used" state                            |
| A signature over another request, or this one changed  | `wrong-request`                                                                                         |
| A revoked phone approves                               | `device-revoked`                                                                                        |
| A phone approves a Mac-only kind                       | `not-allowed-on-device`                                                                                 |
| A process writes `trusted.json`                        | Anchor `mismatch`: lockdown, nothing in the file honoured, the person told                              |
| A process restores an old `trusted.json`               | Same: the anchor's hash and generation have moved on                                                    |
| A process adds evidence to a file and fixes the anchor | Dev builds only (any process can write the anchor there); the evidence still needs a device's signature |
| The app crashes between the two phases                 | `advance`: the new file is kept and the anchor moves                                                    |
| The old file comes back with a write begun             | `interrupted`: lockdown, as B decided                                                                   |
| The Mac's clock jumps back                             | Live checks use the Mac's clock; a request created "in the future" expires later. Accepted risk.        |
| An agent floods requests                               | Limits, then cooldown after declines                                                                    |
| The subject changed while the card was open            | Precheck fails: withdrawn as stale, the agent told                                                      |
| Apply fails after approval                             | Evidence kept, retry apply only                                                                         |

## Tests that show it's done

From the plan's definition of done, all in `apps/desktop/test/main/approvals-*.test.ts`:

- **A synthetic click fails:** `approve-on-mac` with a signer whose prompt is cancelled changes
  nothing; an `answer` with a decision signed by any key but a paired device's fails; there is no
  IPC or tool that answers without a signature.
- **A written file fails:** a record added to `trusted.json`, a pending entry edited, the file
  rolled back, and evidence copied between subjects all fail (anchor or evidence), and lockdown
  follows for the anchor cases.
- **A replayed approval fails:** the same signature twice; a signature from another Mac; one
  replayed after its request expired or was withdrawn; one relayed by a different phone.
- The limits, expiry, decline, withdrawal, lockdown and stale-precheck paths, one test each.

## Design review

A fresh adversarial reviewer read this design, B's contracts, A's spec and the first code on
2026-11-12. 25 findings; what became of each:

| #   | Finding                                                                                   | Disposition                                                                                                                                                                                               |
| --- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Revoking one piece of evidence lets an older one count again                              | Fixed: `revoke` removes every matching entry, and `supersedes` prunes older evidence on approval (one approved hash per adapter, one entry per tool scope). Removing an adapter revokes all its installs. |
| 2   | Tightening records outside the ledger (tool off, site paused, lockdown in app-state.json) | PR 3: every record whose removal would widen moves into the ledger; app-state's lockdown flag is retired (Valet is locked if either says so until then).                                                  |
| 3   | Migration bypassable or laundering                                                        | PR 3: the migrated marker lives in the Keychain anchor; old files' hashes are recorded at first launch and only their records migrate; critical records one by one, Mac only.                             |
| 4   | Lockdown incomplete and racy                                                              | Fixed: lockdown drops remote-client and authoring-session evidence; `answer` refuses all but `resume` while locked; both run in one queue.                                                                |
| 5   | The Mac can't tell Face ID from the passcode                                              | Closed: Nick decided the phone passcode always stands in for Face ID (B, PR #86). One `.userPresence` key per phone; nothing in the broker is Face ID only.                                               |
| 6   | Resume can be approved on a phone                                                         | Fixed: `resume` needs the Mac's signature. Asked B to drop `valet.resume` from the admin table.                                                                                                           |
| 7   | Consent code shown rather than typed                                                      | Asked of B: the typed code inside the signed decision, the request carrying none; consent gets its own bucket and per-source limit outside `pendingTotal`.                                                |
| 8   | A failed commit after the rename reports failure for a change that stands                 | Fixed in `AnchoredFile.write`, with a test.                                                                                                                                                               |
| 9   | The Touch ID prompt is too thin                                                           | Fixed in part: the prompt names Mac-derived facts. PR 3: approve only the request the owning window shows; native sheet for critical cards.                                                               |
| 10  | The helper signs whatever it is given                                                     | PR 2: the helper builds the reason itself from the payload per domain, signs device records only inside a pairing, checks its caller's signature, fresh `LAContext` each time.                            |
| 11  | No delivery window after signing                                                          | Fixed: 5 minutes after `decidedAt`, 2 minutes of skew.                                                                                                                                                    |
| 12  | Phone sequence numbers not persisted                                                      | For G: the last accepted seq per device goes in the ledger; commands dated before the last resume are ignored.                                                                                            |
| 13  | `interrupted` wipes everything                                                            | Fixed: the committed file loads, locked down.                                                                                                                                                             |
| 14  | Apply not durable, retry skips the precheck                                               | PR 3: an `applied` mark on evidence; unapplied evidence re-runs the precheck at load; time limits run from `receivedAt`; apply installs exactly the hashes in the request.                                |
| 15  | Check and write race                                                                      | Already so in the code: verify, precheck, write and apply run in the one queue. Missing prechecks (cart re-read, setting `from`, draft exists) are PR 3's.                                                |
| 16  | Limits gameable                                                                           | Fixed in part: a daily cap counts withdrawn and replaced requests. Push rate limits per client are G's.                                                                                                   |
| 17  | Replacement crosses agents                                                                | Already so: replacement is the same asker only. Doc corrected.                                                                                                                                            |
| 18  | Agents widen other agents' tools                                                          | Fixed: an agent's remote request must name itself; a local one names nobody.                                                                                                                              |
| 19  | Install gate doesn't bind the sandbox mode                                                | PR 3: the gate requires the evidence's `unsandboxed` to equal the run mode, and a Mac signature when true.                                                                                                |
| 20  | Existing IPC paths still loosen without a signature                                       | PR 3: a table maps each to a kind or to tightening, unmapped ones go to B, `answerConfirmation` is deleted, and a test checks no IPC handler writes a widening store.                                     |
| 21  | Audit after the action                                                                    | Already so in the code: `approval-answered` is appended before the ledger write.                                                                                                                          |
| 22  | No follow-up list after revoking a phone                                                  | PR 3 (Mac UI): everything the device approved, with one withdraw.                                                                                                                                         |
| 23  | A key hiccup could mint a new Mac identity                                                | PR 2: the helper splits get from create, and never creates while an anchor exists.                                                                                                                        |
| 24  | No file and no anchor reads as fresh                                                      | PR 2: a Keychain read error locks down; a missing anchor with a first-run marker present counts as tampering.                                                                                             |
| 25  | Implementation points                                                                     | Requester only inside the request text (done); prune before caps (done for declines and asks); evidence checks cached per device change (done).                                                           |

## Contracts v2

B accepted all seven asks below (PR #76), and the broker builds to the result:

- **Limits** are A's: 3 waiting per agent, 5 across agents, 20 requests per agent per day
  (`APPROVAL_LIMITS`).
- **Consent** (`remote-client`): the request carries no code. The Mac keeps the code the browser
  shows beside the pending request, in memory only, so a restart withdraws a waiting consent. The
  person types it on the card and the device signs it into the decision (`typedCode`);
  `verifyDecision` refuses a mismatch as `wrong-code`. Three wrong codes withdraw every waiting
  consent. Consents have their own bucket of 5, apart from agents' requests; the per-source limit
  on `/authorize` is the OAuth server's, before any card is made.
- **Setting choices:** a card that offers `choices` signs the one picked (`choice`), and the
  evidence carries it.
- **Context and display** (the Because row, the domain, follow-ons) are passed by the Mac with the
  request and signed with it.
- **Declines** carry an optional note, given to the asking agent only, and "stop asking". A decline
  with a note doesn't count towards the cooldown unless the person also said stop asking, which
  starts it at once.
- **Resume** is Mac only in `approvableOn` too, and off the admin table.
- **Private network** is a kind an agent may ask for, with its own prompt wording.
- **Phone asks and login codes** reach the service through `PhoneRequests`; the inbox drops them
  until it's wired.

## Contract changes asked of B

Sent to the security thread; the first PR builds without them.

1. **`context` on the request** (A rule 4 and R46): an optional, signed, Mac-filled field naming
   what the request serves (`{ repair: ref }`, `{ draft: id }`, `{ follows: requestId }`,
   `{ replaces: requestId }`). The card's Because row must be signed with the rest.
2. **A decline's note and "stop asking"** (A rule 9, section 8): `approval-decline` has neither.
3. **Limits differ:** A says 5 pending across all agents and 20 a day per agent; B's constants say
   10 and no daily cap. Built to B's constants until B decides.
4. **The ledger** in place of per-store evidence fields, as above.
5. **Face ID only** (review 5): dropped. Nick decided the passcode always stands in for Face ID, so
   each phone has one `.userPresence` key. Mac-only kinds are unchanged.
6. **Resume** (review 6): Mac only, and off the admin table.
7. **Consent code** (review 7): typed into the signed decision, not shown in the request.
