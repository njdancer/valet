# The Valet iPhone app

Workstream H of [plan-agent-run.md](plan-agent-run.md). Draft, 2026-11-12. The phone is where the
person answers what Valet asks, sees that things are fine, and stops things fast (D72, answered:
native, iOS first). It builds to workstream A's journeys, card spec and wireframes
([`ux/agent-run/`](ux/agent-run/), PR #73) and to B's contracts
([agent-run-security.md](agent-run-security.md), `packages/core`). Until G's relay lands it talks to
an in-process fake Mac and relay that speak the same frames.

Status marks follow the security model: **Built**, **Designed** (decided here, not built),
**Proposed** (needs a contract change from B before it is final).

## Contents

- [Brief](#brief)
- [Options considered](#options-considered)
- [Architecture](#architecture)
- [Keys on the phone](#keys-on-the-phone)
- [Pairing](#pairing)
- [The channel](#the-channel)
- [Rendering a card](#rendering-a-card)
- [Approving and declining](#approving-and-declining)
- [Tightening commands](#tightening-commands)
- [Push notifications](#push-notifications)
- [Screens](#screens)
- [Failure cases](#failure-cases)
- [Contract change requests](#contract-change-requests)
- [Where H departs from A's wireframes](#where-h-departs-from-as-wireframes)
- [Testing](#testing)
- [Design review](#design-review)
- [What needs Nick](#what-needs-nick)

## Brief

- **Journeys served:** J1 (pair), J4 (approve on the phone), J7 (something looks wrong), J8
  (everyday admin, the phone side), and J6's code entry once its contract exists.
- **Scope:** a SwiftUI app with five tabs (Needs you, Activity, Sites, Agents, Valet), pairing by QR,
  approval cards with Face ID signing, content-free push, pause and lock down, consent for remote
  clients, the Mac's status and health.
- **Must not break:** guarantees 3 to 6 of the security design. In particular the phone renders a
  card only from the exact request text it hashes, never re-serialises it, signs only with a key
  that needs a fresh biometric check, and never puts card content where Apple or the relay can read
  it.
- **Definition of done** (plan): simulator UI tests cover J1, J4, J7 and J8 on the phone;
  accessibility and dark mode pass; a TestFlight build installs on Nick's phone (needs Nick).

## Options considered

| Question             | Options                                                                    | Chosen, and why                                                                                                                                                                                                                                               |
| -------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI framework         | SwiftUI; UIKit; React Native / Expo sharing TypeScript with the Mac        | **SwiftUI.** Nick chose native (D72). Secure Enclave, LocalAuthentication, notification service extensions and Liquid Glass are first-class there. React Native would share the zod schemas but wrap every security API.                                      |
| Minimum iOS          | 17; 18; 26                                                                 | **iOS 18.** CryptoKit's HPKE needs 17; 18 gives the current SwiftUI navigation and Observation APIs. Liquid Glass (iOS 26) is used where available (`if #available`) and falls back to materials.                                                             |
| Project generation   | A checked-in `.xcodeproj`; XcodeGen; Tuist; Swift Playgrounds app package  | **XcodeGen** (`ios/project.yml`). A `.pbxproj` can't be reviewed or merged by hand, and the container has no Xcode. Tuist is heavier than needed.                                                                                                             |
| Logic placement      | In the app target; in a Swift package the app depends on                   | **A Swift package, `ValetPhoneKit`.** Its unit tests run with `swift test` on the macOS runner in seconds, without a simulator. The app target is views only.                                                                                                 |
| JSON                 | `Codable` with `JSONDecoder`; a strict parser                              | **A strict parser** that refuses duplicate keys, unknown keys, and anything but the schema's shape. `JSONDecoder` ignores unknown keys, and B requires them refused.                                                                                          |
| Talking to a fake    | A Node fake relay over WebSocket in CI; an in-process fake Mac and relay   | **Both, in order.** The in-process fake (`FakeMac`) drives UI tests deterministically with no network. A WebSocket transport follows once G publishes a local Workers runtime the CI job can start.                                                           |
| Key for approvals    | `.userPresence` (biometrics or passcode); `.biometryCurrentSet`; two keys  | **`.biometryCurrentSet` (Proposed, CR-1).** A's card spec needs "a thief who knows the passcode can't approve", which only a key that needs the current Face ID enrolment can enforce. See below.                                                             |
| Interop with the Mac | Port the zod schemas by hand; generate Swift from zod; shared test vectors | **Hand port plus shared vectors.** Generation from zod loses the refinements. A TypeScript script writes vectors (request texts, digests, Mac-signed device records); Swift checks them, and Swift's signed decisions go back through `verifyDecision` in CI. |

## Architecture

```
ios/
  project.yml                 XcodeGen spec: app, notification service extension, UI tests
  ValetPhone/                 SwiftUI app target (views, app lifecycle, LocalAuthentication)
  ValetPhoneUITests/          XCUITest: J1, J4, J7, J8 against FakeMac scenarios
  ValetPhoneKit/              Swift package
    Sources/ValetProtocol     strict JSON, base64url, display text, the core schemas in Swift
    Sources/ValetCrypto       key store, signing domains, keyId, HPKE channel, pairing seal
    Sources/ValetPhoneCore    pairing flow, inbox, channel state (seq, ack, "not confirmed"),
                              card model (request text to what the card shows), gesture policy
    Sources/ValetFakes        FakeMac and FakeRelay, in process, used by previews and UI tests
    Tests/                    unit tests and the TypeScript interop vectors
```

- The app target holds no protocol or crypto code. Every decision about what a card says, which
  gesture it needs and whether a message is accepted lives in `ValetPhoneCore` and is unit tested.
- **One transport seam.** `RelayTransport` sends and receives the frames of `phoneToRelaySchema`
  and `relayToPhoneSchema`. `FakeRelayTransport` connects to `FakeMac` in process; the WebSocket
  transport (G) replaces it with no change above the seam.
- **The fake Mac is honest about the contract.** `FakeMac` builds requests the same way D will
  (sorted-key JSON of a valid `ApprovalRequest`), seals with HPKE auth mode from its own agreement
  key, verifies the phone's signed decisions with the Mac-side rules (`verifyDecision`, ported for
  the fake only), and acks. A UI test therefore exercises the real phone-side crypto end to end.
- **Launch arguments pick a scenario** (`-valet-fake scenario=j4-install`), so a UI test starts in a
  known state. Without one, a debug build shows a demo Mac; a release build has no fake at all
  (`#if VALET_FAKES`).

## Keys on the phone

Three P-256 keys, as B's table says, made at pairing and never exported.

| Key       | Where and access control                                                                                                                                                                                | Used for                                    |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Approval  | Secure Enclave, `.privateKeyUsage` + `.biometryCurrentSet` (CR-1)                                                                                                                                       | Signing `ApprovalDecision` only             |
| Transport | Secure Enclave, `.privateKeyUsage`, `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`                                                                                                                  | Answering the relay's challenge             |
| Agreement | A CryptoKit P-256 key in the Keychain, after first unlock, this device only (B allows "or Keychain"; moves into the Secure Enclave once a spike shows CryptoKit HPKE takes an enclave key in auth mode) | HPKE auth mode with the Mac's agreement key |

- The key blobs (`dataRepresentation`) are stored in the Keychain, `ThisDeviceOnly`, so a backup
  restored to another phone pairs nothing.
- The simulator has no Secure Enclave. `SoftwareKeyStore` (CryptoKit software keys) is used there
  and in tests, and the app says "Simulator keys, for testing" on the Valet tab. A release build
  refuses to pair if the Secure Enclave isn't available.
- **Why `.biometryCurrentSet`.** With B's `.userPresence`, the passcode unlocks the key, so a thief
  who watched the passcode can approve anything. A's spec (§6, R1) wants every card that widens
  access to need Face ID with the current enrolment. The cost: adding a face or fingerprint, or
  turning Face ID off, destroys the key, and the phone must pair again at the Mac. The app checks
  `LAContext.evaluatedPolicyDomainState` at launch and says so before the person meets a failed
  approval ("Face ID changed on this iPhone. Pair it again at your Mac to approve.").
- **The passcode fallback on neutral cards** (A §6) would need a second approval key with
  `.userPresence` and a field in the device record naming which key may sign which cards. Not in
  the first version: neutral cards also need Face ID, and the person can approve at the Mac. Listed
  as CR-1b if Nick wants it.
- **A fresh check for every signature.** Each approval builds a new `LAContext` with
  `touchIDAuthenticationAllowableReuseDuration = 0`, loads the key from its blob with that context,
  signs, and drops both. Nothing caches a key or a context, and the "Face ID to open" context is
  never reused (review finding 4).
- The Face ID reason string uses only Mac-written values: the kind and ids ("Approve installing an
  adapter for yahoo-finance"), never the agent's adapter name. On Face ID iPhones the system shows
  the reason only after a failed match, so the card itself must carry the meaning.
- Data at rest: keys and pairing state in the Keychain, `ThisDeviceOnly`; request texts and the
  outbox in files with `.completeUntilFirstUserAuthentication` protection.

## Pairing

B's flow ([Pairing](agent-run-security.md#pairing)) with the phone's half spelled out. The phone
side is **Designed**; the reply's wire format and the confirmation code's derivation are
**Proposed** (CR-2), because core doesn't define them yet.

1. **Scan.** The QR holds `valet-pair:` followed by the base64url of the `PairingOffer` JSON. The
   phone parses it strictly, checks `macId == keyId(macApprovalKey)`, checks `expiresAt` against
   its own clock with 60 seconds of slack, and refuses an offer whose relay isn't `https`.
2. **Make keys.** Approval, transport and agreement keys as above. The person names the device
   (default: the iPhone's model name, "iPhone"; iOS no longer gives apps the user's device name).
3. **Reply.** The phone builds a `PairingReply` `{ v, macId, name, platform: 'ios', approvalKey,
   transportKey, agreementKey, nonce }` and seals it with AES-256-GCM under
   `HKDF-SHA256(ikm: secret, salt: macId bytes, info: "valet/pairing/v1 reply")`, nonce random,
   associated data `macId`. It sends the sealed reply to the relay on the unauthenticated pairing
   path (`pairing-reply`, CR-2), addressed by `macId` and `offerId = HKDF(secret, info: "valet/pairing/v1 offer-id")` (16 bytes, hex), since the
   phone can't authenticate to the relay until the Mac registers it.
4. **Confirm.** After the Mac accepts the first reply for an offer (and refuses any later one), it
   sends a fresh random 32-byte `macNonce` in a `pairing-challenge` frame. Only then do both sides
   compute `HKDF-SHA256(ikm: secret, salt: macId as its 16 decoded bytes, info: "valet/pairing/v1
   sas" || len‖offer text || len‖reply plaintext || len‖macNonce)`, lengths as 4-byte big-endian.
   Because `macNonce` comes after the reply is fixed, nobody holding the QR can search for a reply
   whose code collides with the real one (review finding 1). The first 4 bytes, as a big-endian
   integer mod 1,000,000, give six digits (B's `device-pair.confirmation`; the bias is under 2^-12).
   A's four words (R39) would take 44 bits from a fixed 2,048-word list, if B extends the code
   (CR-2). The phone shows the code and "Check your Mac shows the same", with **Cancel**.
5. **Approved at the Mac.** The Mac registers the phone's transport key with the relay and sends
   the signed device record in the first sealed envelope, as a new `device-record` message (CR-2). The phone checks it with the pinned Mac
   approval key (`verifyDeviceRecord`): it must name this phone's keys exactly, this Mac, role
   `phone`. Only then does the phone call itself paired and show the recovery-code screen.
6. **Abandoned.** If no record arrives within the offer's life, or the Mac says the offer was
   abandoned (wrong code three times), the phone deletes the three keys and says "Nothing was
   paired."

The phone stores the Mac's id, approval key, agreement key, relay origin, its own device record (as
signed text), and the last seq numbers. All in the Keychain, this device only.

## The channel

- **Connect.** The phone opens a WebSocket to `<relay>/v1/phone` (path is G's), answers
  `challenge` with a `hello` signed by the transport key over `valet/relay-auth/v1\n` + canonical
  JSON of `{ id, nonce, relay, role }`, and waits for `ready`. A challenge whose `relay` isn't the
  pinned origin is refused.
- **Open an envelope.** Accept only `to == myDeviceId`, `from == macId`, the one suite; open with
  HPKE auth mode (recipient: my agreement key; sender's static key: the pinned Mac agreement key;
  `info` = the 32 bytes of the two key ids, hex-decoded, sender first; to be pinned with G and D
  by shared vectors). Parse the plaintext with `macToPhoneMessageSchema`.
- **Sequence numbers.** Accept only `seq == last + 1`. A duplicate (`seq <= last`) is acked again
  but not acted on. A gap is held, not skipped, and shown ("Some messages from your Mac are missing")
  until the missing one arrives; otherwise a relay could hold back a lockdown and deliver the next
  message, after which every resend of the lockdown would look old (review finding 2). `ack`
  messages take a seq but are never acked themselves. The same rule is proposed for the Mac's side
  of the phone channel (CR-2).
- **Send.** Every phone message gets the next seq and is kept in an outbox until the Mac acks it.
  The outbox survives restarts. That's what drives "Not confirmed yet" on cards and commands.
- **Reconnect** with backoff (1, 2, 4 … 60 s); `mac-online` frames drive the "Mac last seen" line.
- **Mac state for the other tabs** (Activity, Sites, Agents, the Valet tab) needs a message the
  contract doesn't have yet: `status` (CR-3). Until it exists those tabs show what the fake sends,
  behind the proposed schema.

## Rendering a card

1. `parseRequestText` in Swift: strict JSON, then the schema for that kind, then the same
   refinements as zod (display text, patterns, `expiresAt > createdAt`, the sandbox-mode rule).
   Anything that fails is not shown; the phone says "Your Mac sent a request this iPhone couldn't
   read" and acks it, so it isn't resent forever.
2. The digest is `SHA-256("valet/approval-request/v1\n" + text)`, over the exact bytes received.
3. The card model maps the parsed request to the parts of A's anatomy (§2): kind strip, title,
   asked by, risk line, what changes, the agent's words, details, actions, footer. Titles and risk
   lines are A's templates (§3, §4), filled only from Mac-written fields. Agent-written fields
   (`agentNote`, `adapterName`, exception purposes) appear only in their labelled sections.
4. **Who wrote each field.** The card treats these as claims and never puts them in a headline,
   a notification or the Face ID reason: `agentNote`, `adapterName`, `references`, every
   `PermissionChange.items` line that quotes a manifest purpose, `requester.clientName` (the
   agent's self-reported name), a setting's `label`, `from` and `to`, a remote client's `host` and
   `sourceAddress`, an irreversible call's `preview`, and a device-pair's `deviceName`. Headlines use
   the kind, ids and, once CR-4 lands, the Mac's display block. All text is drawn with
   `Text(verbatim:)` (never Markdown or links), and agent spans are wrapped in Unicode isolates in
   the view only.
5. **Tone comes only from structured fields:** the kind, `risk` on change lines, `unsandboxed`,
   `sideEffect`, `scope`, `inheritsSession`. When the phone can't tell (no registrable domain yet), it
   rounds up to caution. CR-4's display block is text only and never changes the tone, the "I've
   read" tick or `approvableOn`.
6. **Gaps.** Several of A's parts need data B's subjects don't carry: tool display names, the
   registrable domain, Because, follow-ons, checks Valet ran, a client's badge and given name. The
   phone renders what the subject has and falls back to ids ("Turn on yahoo-finance.search_symbols
   for Claude app"). CR-4 proposes a Mac-written `display` block so the phone can show A's titles.
7. Rendering is tested per kind with snapshot-free assertions on the card model, and the views are
   checked in UI tests at the default and AX5 text sizes.

## Approving and declining

- **Approve** builds `ApprovalDecision { v: 1, decision: 'approve', macId, requestId, requestDigest,
  deviceId, decidedAt }`, serialises it with sorted keys, and signs `valet/approval-decision/v1\n`
  - that text with the approval key. The signing call is what raises Face ID; there is no separate
    LocalAuthentication check that could be skipped. The phone sends `approval-decision` with the
    exact text and signature.
- Before signing, the phone re-checks that the request is still the one on screen (same digest),
  unexpired by its clock, allowed on a phone (`approvableOn`), and not closed. A card for a kind the
  phone may not approve shows "Do this on your Mac" in place of Approve.
- **Strong cards** need the "I've read what this does" tick first (A rule 11).
- **Decline** is one tap, no Face ID, sent as `approval-decline`. A's optional note to the agent
  needs a field (CR-5).
- **States** follow A §9: Checking until the ack, Not confirmed yet after 30 s (with **Check
  again**, which resends the same signed text), then Approved, Declined, Not used, Expired, or
  Refused by the Mac when an `approval-closed` arrives. Refused needs an outcome the contract
  doesn't have yet (CR-6); until then an approval the Mac acked but hasn't closed shows "Your Mac
  is checking this", and only an unacked one shows "Not confirmed yet".
- **Connect cards** keep Approve disabled until the person types the code their browser shows and
  it equals `subject.code` (A's risk line).
- **Mac offline:** Approve is still possible; the signed approval waits in the outbox and the card
  says "Your Mac is offline. This will be sent when it's back", since the Mac checks it against its
  own pending set and clock when it arrives.
- **Choosing a value on the card** (the store, J8b): the person's choice must be inside what they
  sign, or the Mac can't tell it from a forged one. CR-7 proposes `choice` in the decision.

## Tightening commands

Pause remote use, Lock down, Revoke an agent, Remove a device: `command` messages, no Face ID, as B
designed. Each shows "Not confirmed yet" until acked. Remove a device asks for Face ID anyway as a
UI step (A §6; it can't be the last device and costs a re-pair), but the protocol doesn't need it.
The phone never offers to revoke the Mac. Unlock is not on the phone (A's recommendation, open as a
question for Nick), even though B's `approvableOn` would allow a `resume` card; the phone shows a
`resume` card's "Do this on your Mac".

## Push notifications

- The relay's push carries only "Valet needs you" or "Something changed in Valet"
  (`pushPayloadSchema`), no actions, no reply. A tap opens Valet, which asks for Face ID to open
  (on by default), then reconnects and shows whatever arrived.
- A's richer titles ("Install an adapter for yahoo.com") need the content inside the push, which
  B's payload forbids. Choice: keep B's fixed text in the first version; a notification service
  extension that decrypts a sealed title is CR-8, for later.
- Grouping and time-sensitive interruption level follow A §10 once titles exist; with fixed text
  every push is one thread, and only "Valet needs you" is time-sensitive.
- The APNs token goes to the relay in `push-token`. In the simulator and CI, pushes are simulated
  by the fake (`xcrun simctl push` in one UI test).

## Screens

From A's iOS IA (section 3) and frames. Native components throughout: `TabView`, `NavigationStack`,
`List` with inset-grouped style, `.sheet` for cards opened from a notification, system materials or
Liquid Glass for the pinned action bar. Colours and type come from the design system's tokens
(`docs/design-system.md`) mapped to semantic SwiftUI colours, so dark mode and increased contrast
follow the system.

| Tab       | First version                                                                                                                      |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Needs you | Inbox of open cards, newest first, badge count; Pause and Lock down in the navigation menu; empty state with the Mac's status line |
| Activity  | Changes and Calls from `status` (CR-3); read only; no Undo in the first version (Undo is loosening and needs CR-9)                 |
| Sites     | Sites with health lines; a site's tools and versions; read only                                                                    |
| Agents    | Agents with badges; an agent's waiting requests; **Revoke…**                                                                       |
| Valet     | The Mac's status, Pause Valet, Lock down…, Devices (Remove other devices), About, Unpair this iPhone                               |

Also: Welcome, Scan, Check the code, Recovery code (once B designs it), Notifications prompt,
Paired, Face ID to open, the app-switcher privacy cover, Unpaired.

Accessibility: Dynamic Type to AX5 with rows that stack; the card's tone word and risk line move
into the pinned bar at accessibility sizes (A rule 6); VoiceOver order is A §2's; hosts get the
"owned by" label (A rule 8); every control has a label; Reduce Motion respected.

## Failure cases

| Case                                          | What the phone does                                                                                                                                                                                   |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Envelope fails to open, wrong sender, old seq | Dropped silently and counted on the Valet tab's diagnostics; never shown                                                                                                                              |
| Request text fails the schema                 | Not shown; "couldn't read" row; acked                                                                                                                                                                 |
| Request expired on arrival                    | Shown as Expired                                                                                                                                                                                      |
| Face ID fails or is cancelled                 | "Face ID didn't work. Try again, or approve on your Mac." Nothing sent                                                                                                                                |
| Face ID enrolment changed (key gone)          | Approve disabled; "Pair this iPhone again at your Mac"                                                                                                                                                |
| Phone offline                                 | "No connection. Nothing was sent." Card stays                                                                                                                                                         |
| Mac offline (from `mac-online`)               | Kind strip "Mac last seen 7:39 pm"; approvals queue in the outbox and say so                                                                                                                          |
| No ack within 30 s                            | Not confirmed yet, with Check again                                                                                                                                                                   |
| Device record from the Mac fails to verify    | Pairing fails; keys deleted                                                                                                                                                                           |
| Relay refuses the hello                       | "Can't reach Valet's relay." Keys are kept: a relay's refusal isn't authenticated. Keys are deleted only on a sealed `revoked` notice from the Mac (CR-3) or when the person picks Unpair this iPhone |
| Clock skew                                    | The phone counts a card's life from its own monotonic clock at arrival plus `expiresAt − createdAt`, never its wall clock, so a fast phone can still approve; the Mac decides                         |
| A new card arrives while one is open          | Shown as a banner, never swapped into the open sheet; Approve is disabled for 1 s after anything on screen changes                                                                                    |
| Same request id, different text               | The second text is refused and counted; cards are keyed by id and digest                                                                                                                              |
| Unknown kind or version                       | "Update Valet on this iPhone to see this request"                                                                                                                                                     |
| App reinstalled                               | No install marker in UserDefaults: the Keychain items from the earlier install are wiped first                                                                                                        |

## Contract change requests

Sent to B on 2026-11-12. None is built into core by H; the phone implements each behind the
proposed shape and adapts to B's answer.

| CR    | Change                                                                                                                                                          | Why                                                                       |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| CR-1  | iPhone approval key uses `.biometryCurrentSet`, not `.userPresence`                                                                                             | A §6, R1: a thief with the passcode can't approve                         |
| CR-1b | Optional second approval key with `.userPresence` for neutral cards                                                                                             | A's passcode fallback; deferred                                           |
| CR-2  | Pairing wire format: a sealed `PairingReply`, the relay's `pairing-reply` / `pairing-result` frames, the code's derivation (and 44 bits if A's four words stay) | Not defined in core; the phone can't reach the Mac before it's registered |
| CR-3  | Mac-to-phone `status`: Mac state (paused, locked down), sites and health, agents, recent changes and calls, devices, all display text                           | Activity, Sites, Agents and Valet tabs have no data otherwise             |
| CR-4  | A Mac-written `display` block on requests: tool titles, site name, registrable domain, Because, client name and badge, follow-ons, checks                       | A's card titles and parts                                                 |
| CR-5  | `approval-decline` carries an optional note (display text, 280)                                                                                                 | A rule 9                                                                  |
| CR-6  | `approval-closed` outcome `refused` with the refusal reason, and the device that answered                                                                       | A §9 "Refused by the Mac", "Approved on Nick's iPhone", "Not used"        |
| CR-7  | `ApprovalDecision.choice` for Setting cards where the person picks the value                                                                                    | J8b: the store choice must be signed                                      |
| CR-8  | A sealed notification title for a service extension                                                                                                             | A §10 titles without the relay or Apple seeing them                       |
| CR-9  | A phone-to-Mac `ask` message ("make me a card for X"), for loosening on the phone (Undo, a tool on)                                                             | The Mac builds every request; the phone can only ask it to                |
| CR-10 | J6: a phone-to-Mac `login-code` message and a `login-handoff` request from the Mac                                                                              | Typing a login code on the phone                                          |

## Where H departs from A's wireframes

- No route for someone who can't use Face ID to approve on the phone (R35), until B's
  accessibility exception exists; they approve at the Mac.
- Lock at the relay while the Mac is offline (J7 F1), the recovery code and its web page, Pause
  this site, Secrets, Add an agent and A's separate control key wait for B and G's designs.
- `valet://` links open a list or a card read-only; a link can never land on a card with Approve
  armed, since Approve always needs the card on screen for 1 s and a Face ID match.
- Neutral cards also need Face ID (no passcode fallback) until CR-1b.
- Pairing shows B's six digits until CR-2 settles A's four words; no typed 8-character code (it
  can't carry the Mac's keys without the relay holding the offer).
- No Undo, and no loosening from the phone, until CR-9.
- Notification titles are B's fixed text until CR-8.
- These go back to A's sign-off table (IA section 11) with H's sign-off.

## Testing

- **Unit (`swift test`, macOS runner):** strict JSON (duplicates, unknown keys, depth, numbers),
  display-text rules against the TypeScript cases, every request kind's schema, digest and decision
  bytes, keyId, HPKE round trip and RFC 9180 test vectors for the suite, pairing seal and code,
  seq and ack, outbox persistence, card model per kind and per state, gesture policy.
- **Interop:** `packages/core/scripts/ios-vectors.ts` writes request texts, digests, a Mac-signed
  device record and the relay `hello` bytes; Swift checks them. HPKE envelopes and the pairing seal
  and code get shared vectors once D or G write the Mac's side (until then CryptoKit on both ends of
  the fake). Swift writes signed decisions; a vitest suite checks
  them with `verifyDecision`. Both run in the iOS CI job.
- **UI (XCUITest, iPhone simulator):** J1 pair, J4 approve and decline for each kind, J7 revoke and
  lock down, J8 a remote-tool card and the store card, each against a `FakeMac` scenario; dark
  mode; AX5 text; VoiceOver labels via accessibility identifiers and the accessibility audit
  (`performAccessibilityAudit`, Xcode 15+).
- **Adversarial:** a hostile `FakeMac` that sends tampered text, wrong seals, replays, unknown
  fields, invisible characters and Mac-only kinds; the phone must show none of them as approvable.
- **Simulator limits:** the QR is injected by launch argument (fakes builds only); the biometric
  gate is driven with an enrolled simulator and `notifyutil` match and non-match events; access
  control flags are asserted in a unit test, since software keys don't have them.
- **Fakes stay out of release:** `ValetFakes` and `SoftwareKeyStore` compile only with
  `VALET_FAKES`, and CI checks the release binary has no `FakeMac` symbol.
- **CI:** an `ios` job in `ci.yml` on `macos-latest`, run only when `ios/`, `packages/core/` or the
  workflow changed (the job reports success otherwise, so the required `ci` check still gates).

## Design review

A fresh adversarial reviewer read this doc against B's contracts and A's spec on 2026-11-12 and
raised 23 findings (7 must fix). All are taken: the macNonce in the pairing code (1), strict
next-seq (2), no unpairing on a relay's word (3), a fresh `LAContext` per signature (4), the
claims table and Mac-written Face ID reasons (5), tone from structured fields only (6), cross-
language vectors (7), card swap and Markdown guards (8, 9), monotonic expiry (10), "checking" after
an ack (11), reinstall wipe and data protection (13), the `device-record` message and offer-id
derivation (14), the extra departures and simulator limits (15, 16), and fakes out of release (18).
Partly open: re-pairing after a Face ID change must revoke the old record first, which needs the Mac
side (12); the definition of done counts against `FakeMac` until B accepts CR-2, CR-3 and CR-7 (17).

## What needs Nick

Batched for the coordinator, asked once when H reaches it: an Apple Developer Program membership,
the team id, an App ID (`me.dncr.valet` suggested) with push, an APNs auth key for G's relay, and
installing a TestFlight build. Nothing is signed or uploaded without him.
