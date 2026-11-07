// swift-tools-version:5.9
// The stdio bridge the packaged app ships in Contents/MacOS (D60): a port of
// packages/mcp-server/src/bridge.ts with no runtime to install or patch. One shared suite,
// packages/mcp-server/test/bridge-contract.ts, runs against both bridges.

import PackageDescription

let package = Package(
  name: "valet-bridge",
  platforms: [.macOS(.v13)],
  targets: [
    .executableTarget(name: "valet-bridge", path: "Sources/valet-bridge")
  ]
)
