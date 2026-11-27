# Valet's native binaries (Swift)

One package, four binaries for `Valet.app/Contents/MacOS`, signed with the app:

- **valet-bridge**, the stdio bridge (below).
- **valet-keychain** (D6): Valet's own Keychain items through `SecItem`, so the ACL names a binary
  signed with Valet's Team ID. `read|info|write|delete <service> <account>`, secrets on stdin.
  See `packages/credentials/src/keychain-helper.ts`.
- **valet-approver** (workstream D, [docs/approval-broker.md](../docs/approval-broker.md)): the Mac's
  three device keys in the Secure Enclave (`keys`, `create`), and `sign-decision`, which signs an
  approval only of exactly the request it is shown (request text and payload on stdin) after
  Touch ID, with a prompt reason it writes itself. `keys` never creates. Debug builds take
  `VALET_KEYCHAIN_PATH`, `VALET_APPROVER_SOFTWARE=1` (software keys) and
  `VALET_APPROVER_PRESENT=0` (a cancelled prompt) for
  `apps/desktop/test/main/approver-contract.test.ts`; release builds ignore all three.
- **valet-messages-helper** (D8): the SMAppService launch agent that alone holds Full Disk Access
  (`serve <label>`, `register`, `unregister`, `status`). The plists are in
  `apps/desktop/build/launch-agents`. It answers Mail, Messages, Calendar and Reminders' read-only
  questions; Valet's own one-time-code lookup is a Messages read like any other
  (`packages/native-messages/src/otp.ts`).

A signed helper answers only a caller signed by its own Team ID. Debug builds take a throwaway
keychain (`VALET_KEYCHAIN_PATH`) and made-up folders and a socket (`serve <label> --socket
--messages-dir --address-book-dir --mail-dir --accounts-db`) for the contract suites; release builds
ignore both.

```bash
swift test --package-path swift-bridge
swift build --package-path swift-bridge
VALET_SWIFT_KEYCHAIN="$PWD/swift-bridge/.build/debug/valet-keychain" \
  pnpm vitest run --project credentials test/keychain-contract
VALET_SWIFT_MESSAGES_HELPER="$PWD/swift-bridge/.build/debug/valet-messages-helper" \
  pnpm vitest run --project native-messages test/helper-contract
```

## Valet's secure store

The helpers that keep Valet's secrets, valet-approver (the Mac's device keys) and valet-keychain
(the trusted-store anchor and Valet's copies of logins), keep them in the **data protection
Keychain**, in an access group only binaries signed by Valet's team can open
(`ValetHelperKit/Store.swift`). Access follows the signature, so there is no per-item prompt,
rebuilds included, and items work after the Mac's first unlock, so Valet keeps working while the
screen is locked. An item still in the classic Keychain moves across the first time it is read
(that one read may ask once).

The access group is a restricted entitlement: macOS kills a binary that claims it without a
provisioning profile. So for development the two helpers are built as small app bundles that carry
one (`apps/project.yml`):

```bash
# once: sign in under Xcode › Settings › Accounts, and set VALET_TEAM_ID in mise.local.toml
swift-bridge/build-helper-apps.sh     # Xcode makes the development App IDs and profiles itself
swift-bridge/check-secure-store.sh    # live check: protected store, no prompts, survives a re-sign
```

A development build of the app uses the bundles when they're there
(`apps/desktop/src/main/core/native-helpers.ts`) and the plain binaries otherwise. A helper with no
access group (the plain binaries, CI's unsigned bundles) uses the classic Keychain, and the
contract suites always use a throwaway keychain file. Release builds still ship the plain binaries
and the classic Keychain, whose Developer ID requirement doesn't change between releases, until a
Developer ID provisioning profile exists.

**Running the app from source.** An ad hoc signed helper is a new program to the Keychain after
every build, so macOS asks again before it can read the Mac's keys (and can't ask while the screen
is locked). Sign the debug helpers with your own certificate instead: put
`VALET_DEV_SIGN_IDENTITY = "<SHA-1 from security find-identity -v -p codesigning>"` under `[env]`
in `mise.local.toml` (git ignores it) and build with `swift-bridge/sign-dev-helpers.sh`. Allow the
Keychain prompt once, with Always Allow. Debug builds skip the caller check whatever they are
signed with, because the development Electron is unsigned; release builds keep it.

## valet-bridge

The stdio-to-HTTP bridge the packaged app ships at `Valet.app/Contents/MacOS/valet-bridge` (D60).
It is a port of [`packages/mcp-server/src/bridge.ts`](../packages/mcp-server/src/bridge.ts) and
behaves the same way:

- `valet-bridge <config file>` reads one client's bridge config: a regular file (never a
  symlink), owned by this user, mode 0600, holding exactly `{ "url": "http://127.0.0.1:<port>/mcp",
  "token": "<43 base64url characters>" }`. Anything else is refused on stderr, and nothing reaches
  stdout.
- It relays newline-delimited JSON-RPC between stdin/stdout and the endpoint's Streamable HTTP,
  adding the bearer token and `x-valet-transport: stdio-bridge`. Stdout carries protocol messages
  only.
- When the session ends under a running client (the app restarted, moved port, or the person reset
  this client's access), it re-reads the config file, replays the client's own initialize into a
  new session, and sends `notifications/tools/list_changed`.
- Every client request gets exactly one answer: a response stream that ends without one is answered
  at once with fixed text, and a late answer is dropped. Upstream errors become fixed texts.

Build and run the shared suite against it (macOS):

```bash
swift build -c release --arch arm64 --arch x86_64 --package-path swift-bridge
VALET_SWIFT_BRIDGE="$PWD/swift-bridge/.build/apple/Products/Release/valet-bridge" \
  pnpm vitest run --project mcp-server test/bridge-contract
```

CI does both on every PR. electron-builder copies that universal binary into
`Contents/MacOS/valet-bridge` (`SWIFT_BRIDGE_BUILD` in `apps/desktop/electron-builder.config.ts`),
where the app's signature covers it; a release refuses to build without it. A packaged app's setup
snippets name it by its absolute path in the installed app.
