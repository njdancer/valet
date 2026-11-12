import Foundation
import ValetCrypto
import ValetProtocol

/// One WebSocket-like connection to the relay: text frames in and out.
@MainActor
public protocol RelayConnection: AnyObject {
  func send(_ text: String)
  func close()
}

/// How the phone reaches the relay. `FakeRelay` (ValetFakes) in previews and UI tests; a WebSocket
/// transport once G's relay exists. Callbacks arrive on the main actor.
@MainActor
public protocol RelayTransport: AnyObject {
  /// `macId` names the Mac whose channel this is: the relay routes phones by it.
  func connect(
    relay: String, macId: String, path: RelayPath, onFrame: @escaping @MainActor (String) -> Void,
    onClose: @escaping @MainActor () -> Void
  ) -> RelayConnection
}

/// What the connection is for. Both dial the same address, `/v1/phone/<macId>` (the relay's
/// DEVICE_PATH): a pairing connection sends its one sealed reply after the challenge, instead of a
/// hello; the device channel answers the challenge with a hello once the Mac registered the phone.
public enum RelayPath: String, Sendable {
  case phone
  case pair

  /// The path on the relay for this Mac.
  public static func url(macId: String) -> String { "/v1/phone/\(macId)" }
}

/// What the phone keeps between launches. On a phone it lives in the Keychain, this device only
/// (`KeychainPhoneStore` in the app); tests use `MemoryPhoneStore`.
public struct PersistedPhone: Codable, Equatable, Sendable {
  public var macId: String
  public var macApprovalKey: String
  public var macAgreementKey: String
  public var relay: String
  public var keys: StoredKeys
  public var name: String
  public var macName: String?
  /// The device record the Mac signed, once pairing finished.
  public var recordPayload: String?
  public var recordSignature: String?
  public var lastInbound: Int
  public var nextOutbound: Int
  /// Unacknowledged messages, by seq, as the exact text sent.
  public var outbox: [Int: String]
  /// Open request texts, so cards survive a restart. Re-parsed on load.
  public var requests: [String]

  public var paired: Bool { recordPayload != nil }
}

public protocol PhoneStore: AnyObject {
  func load() -> PersistedPhone?
  func save(_ state: PersistedPhone)
  func wipe()
}

public final class MemoryPhoneStore: PhoneStore {
  public var state: PersistedPhone?
  public init(_ state: PersistedPhone? = nil) { self.state = state }
  public func load() -> PersistedPhone? { state }
  public func save(_ state: PersistedPhone) { self.state = state }
  public func wipe() { state = nil }
}

/// Wall time for display, and monotonic time for deadlines (review finding 10).
public struct PhoneClock: Sendable {
  public var now: @Sendable () -> Date
  public var uptime: @Sendable () -> TimeInterval

  public init(now: @escaping @Sendable () -> Date, uptime: @escaping @Sendable () -> TimeInterval) {
    self.now = now
    self.uptime = uptime
  }

  public static let system = PhoneClock(now: { Date() }, uptime: { ProcessInfo.processInfo.systemUptime })
}
