// swift-tools-version:6.0
// The iPhone app's logic (docs/ios-app.md). The app target in ../ValetPhone is views only; every
// decision about what a card says, which gesture it needs and whether a message is accepted lives
// here, so `swift test` covers it on a Mac without a simulator.
//
// - ValetProtocol: strict JSON, base64url, display text, and the packages/core schemas in Swift.
// - ValetCrypto: device keys (Secure Enclave on a phone, software keys in the simulator and tests),
//   signing domains, keyId, the HPKE channel and the pairing seal.
// - ValetPhoneCore: pairing, the channel's seq and ack, the inbox, and the card model.
// - ValetFakes: an in-process fake Mac and relay for previews and UI tests. Never in a release build.

import PackageDescription

let package = Package(
  name: "ValetPhoneKit",
  platforms: [.iOS(.v18), .macOS(.v15)],
  products: [
    .library(name: "ValetProtocol", targets: ["ValetProtocol"]),
    .library(name: "ValetCrypto", targets: ["ValetCrypto"]),
    .library(name: "ValetPhoneCore", targets: ["ValetPhoneCore"]),
    .library(name: "ValetFakes", targets: ["ValetFakes"]),
  ],
  targets: [
    .target(name: "ValetProtocol"),
    .target(name: "ValetCrypto", dependencies: ["ValetProtocol"]),
    .target(name: "ValetPhoneCore", dependencies: ["ValetProtocol", "ValetCrypto"]),
    .target(name: "ValetFakes", dependencies: ["ValetProtocol", "ValetCrypto", "ValetPhoneCore"]),
    .testTarget(name: "ValetProtocolTests", dependencies: ["ValetProtocol"]),
    .testTarget(
      name: "ValetCryptoTests",
      dependencies: ["ValetCrypto", "ValetProtocol", "ValetFakes"],
      resources: [.copy("Vectors")]
    ),
    .testTarget(
      name: "ValetPhoneCoreTests",
      dependencies: ["ValetPhoneCore", "ValetFakes", "ValetCrypto", "ValetProtocol"]
    ),
  ],
  swiftLanguageModes: [.v5]
)
