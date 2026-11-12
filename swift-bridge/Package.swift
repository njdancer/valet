// swift-tools-version:5.9
// Valet's native binaries, all shipped in Valet.app/Contents/MacOS and signed with the app:
//
// - valet-bridge: the stdio bridge (D60), a port of packages/mcp-server/src/bridge.ts with no
//   runtime to install or patch. One shared suite, packages/mcp-server/test/bridge-contract.ts,
//   runs against both bridges.
// - valet-keychain: reads and writes Valet's own Keychain items in process (SecItem), so the
//   Keychain's ACL names a binary signed with Valet's Team ID instead of /usr/bin/security (D6).
// - valet-approver: the Mac's Secure Enclave device keys; signs approvals after Touch ID (D,
//   docs/approval-broker.md).
// - valet-messages-helper: the launch agent that alone holds Full Disk Access and answers "the
//   latest code from this sender since this time" (D8).

import PackageDescription

let package = Package(
  name: "valet-native",
  platforms: [.macOS(.v13)],
  targets: [
    .executableTarget(name: "valet-bridge", path: "Sources/valet-bridge"),
    .target(
      name: "ValetHelperKit",
      path: "Sources/ValetHelperKit",
      linkerSettings: [.linkedLibrary("sqlite3")]
    ),
    .executableTarget(
      name: "valet-keychain",
      dependencies: ["ValetHelperKit"],
      path: "Sources/valet-keychain"
    ),
    .executableTarget(
      name: "valet-approver",
      dependencies: ["ValetHelperKit"],
      path: "Sources/valet-approver",
      linkerSettings: [.linkedFramework("LocalAuthentication")]
    ),
    .executableTarget(
      name: "valet-messages-helper",
      dependencies: ["ValetHelperKit"],
      path: "Sources/valet-messages-helper",
      linkerSettings: [.linkedFramework("ServiceManagement")]
    ),
    .testTarget(
      name: "ValetHelperKitTests",
      dependencies: ["ValetHelperKit"],
      path: "Tests/ValetHelperKitTests"
    ),
  ]
)
