import Foundation
import SwiftUI
import ValetPhoneCore
import ValetProtocol

#if VALET_FAKES
  import LocalAuthentication
  import ValetCrypto
  import ValetFakes
#endif

/// Builds the phone model the app runs on. A release build talks to a real relay and keeps its
/// state in the Keychain. A fakes build (`VALET_FAKES`, simulator and UI tests only, never shipped)
/// runs the story world against an in-process fake Mac and relay, chosen by `-valet-fake <scenario>`.
@MainActor
final class AppHost {
  let model: PhoneModel
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
      // The real relay and Mac, from the simulator (docs/phone-channel.md#running-it-locally): a
      // local relay to dial, and software keys whose every signature still waits for Face ID or
      // the passcode, since the simulator has no Secure Enclave.
      if let connect = Self.argument("-valet-relay-connect", in: arguments).flatMap(URL.init(string:)) {
        pairFrom = Self.argument("-valet-pair-from", in: arguments).flatMap(URL.init(string:))
        let presence: @Sendable (String) async -> Bool = { reason in await Self.deviceOwner(reason) }
        model = PhoneModel(
          // In memory: an unsigned simulator build may not reach the Keychain. Backgrounding
          // keeps the pairing; quitting the app forgets it.
          transport: WebSocketRelayTransport(connectOverride: connect), store: MemoryPhoneStore(),
          keys: PhoneModel.Keys(
            make: {
              let keys = SoftwareDeviceKeys()
              keys.presence = presence
              return keys
            },
            load: {
              let keys = try SoftwareDeviceKeys(stored: $0)
              keys.presence = presence
              return keys
            }
          )
        )
        model.connect()
        return
      }
    #endif
    model = PhoneModel(
      transport: WebSocketRelayTransport(), store: KeychainPhoneStore(), keys: .system
    )
    model.connect()
  }

  #if VALET_FAKES
    /// Where the simulator reads the QR text the Mac shows (`-valet-pair-from`): it has no camera.
    private(set) var pairFrom: URL?

    /// Fetches the Mac's current QR text, for the simulator's stand-in for the camera.
    func pairingTextFromMac() async -> String? {
      guard let pairFrom, let (data, _) = try? await URLSession.shared.data(from: pairFrom),
        let text = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
        text.hasPrefix("valet-pair:")
      else { return nil }
      return text
    }

    private static func argument(_ name: String, in arguments: [String]) -> String? {
      guard let i = arguments.firstIndex(of: name), i + 1 < arguments.count else { return nil }
      return arguments[i + 1]
    }

    /// Face ID, or the passcode: what the Secure Enclave key's `.userPresence` would ask for.
    private static func deviceOwner(_ reason: String) async -> Bool {
      let context = LAContext()
      return (try? await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)) ?? false
    }
  #endif

  #if VALET_FAKES
    /// A new QR code from the fake Mac, for the simulator, which has no camera.
    var fakeQR: String? { world?.qr() }

    /// The person confirms at the Mac that the codes match.
    func confirmAtFakeMac() { world?.mac.confirmPairingAtMac() }
    func rejectAtFakeMac() { world?.mac.rejectPairingAtMac() }
  #endif
}
