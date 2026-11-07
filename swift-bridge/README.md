# Valet's native binaries (Swift)

One package, three binaries for `Valet.app/Contents/MacOS`, signed with the app:

- **valet-bridge**, the stdio bridge (below).
- **valet-keychain** (D6): Valet's own Keychain items through `SecItem`, so the ACL names a binary
  signed with Valet's Team ID. `read|info|write|delete <service> <account>`, secrets on stdin.
  See `packages/credentials/src/keychain-helper.ts`.
- **valet-messages-helper** (D8): the SMAppService launch agent that alone holds Full Disk Access
  (`serve <label>`, `register`, `unregister`, `status`). The plists are in
  `apps/desktop/build/launch-agents`. See `packages/credentials/src/messages-helper.ts`.

A signed helper answers only a caller signed by its own Team ID. Debug builds take a throwaway
keychain (`VALET_KEYCHAIN_PATH`) and a fixture database and socket (`serve <label> --db --socket`)
for the contract suites; release builds ignore both.

```bash
swift test --package-path swift-bridge
swift build --package-path swift-bridge
VALET_SWIFT_KEYCHAIN="$PWD/swift-bridge/.build/debug/valet-keychain" \
VALET_SWIFT_MESSAGES_HELPER="$PWD/swift-bridge/.build/debug/valet-messages-helper" \
  pnpm vitest run --project credentials test/keychain-contract test/otp-contract
```

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
