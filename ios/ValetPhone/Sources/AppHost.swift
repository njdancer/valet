import Foundation
import SwiftUI
import ValetPhoneCore
import ValetProtocol

#if VALET_FAKES
  import ValetCrypto
  import ValetFakes
#endif

/// Builds the phone model the app runs on. A release build talks to a real relay and keeps its
/// state in the Keychain. A fakes build (`VALET_FAKES`, simulator and UI tests only, never shipped)
/// runs the story world against an in-process fake Mac and relay, chosen by `-valet-fake <scenario>`.
@MainActor
final class AppHost {
  let model: PhoneModel
  /// Whether opening the app asks for Face ID first (docs/ios-app.md, Screens).
  let locksOnOpen: Bool
  #if VALET_FAKES
    let world: FakeWorld?
  #endif

  init(arguments: [String] = ProcessInfo.processInfo.arguments) {
    #if VALET_FAKES
      if let i = arguments.firstIndex(of: "-valet-fake"), i + 1 < arguments.count,
        let scenario = FakeWorld.Scenario(rawValue: arguments[i + 1])
      {
        let world = FakeWorld(scenario)
        let faceIDFails = arguments.contains("-valet-faceid-fails")
        let model = PhoneModel(
          transport: world.relay, store: MemoryPhoneStore(),
          keys: PhoneModel.Keys(
            make: {
              let keys = SoftwareDeviceKeys()
              keys.presence = { _ in !faceIDFails }
              return keys
            },
            load: { try SoftwareDeviceKeys(stored: $0) }
          )
        )
        self.world = world
        self.model = model
        locksOnOpen = false
        if scenario == .pair {
          // The person confirms the code at the Mac: in the simulator, a button stands in for it.
          world.mac.autoConfirmPairing = false
        } else {
          world.pair(model, name: "Nick\u{2019}s iPhone")
          world.post()
        }
        return
      }
      world = nil
    #endif
    model = PhoneModel(
      transport: WebSocketRelayTransport(), store: KeychainPhoneStore(), keys: .system
    )
    locksOnOpen = true
    model.connect()
  }

  #if VALET_FAKES
    /// A new QR code from the fake Mac, for the simulator, which has no camera.
    var fakeQR: String? { world?.qr() }

    /// The person confirms at the Mac that the codes match.
    func confirmAtFakeMac() { world?.mac.confirmPairingAtMac() }
    func rejectAtFakeMac() { world?.mac.rejectPairingAtMac() }
  #endif
}
