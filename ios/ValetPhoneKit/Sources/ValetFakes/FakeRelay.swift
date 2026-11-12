// An in-process relay and Mac for previews, UI tests and unit tests (docs/ios-app.md,
// Architecture). The relay routes frames the way G's Worker will; the Mac builds requests, seals
// envelopes and checks signed decisions the way D will. The phone code above `RelayTransport`
// can't tell it from the real thing, so its crypto runs for real.
//
// Frames are queued, not delivered inside `send`, as a network would. With `autoDeliver` they go
// out on the next main-queue turn; tests turn it off and call `drain()`.

import CryptoKit
import Foundation
import ValetCrypto
import ValetPhoneCore
import ValetProtocol

@MainActor
public final class FakeRelay: RelayTransport {
  public let origin: String
  public let mac: FakeMac
  public var autoDeliver: Bool
  /// When false, the relay refuses phone connections (the "can't reach the relay" case).
  public var reachable = true
  /// A phone asked the relay to stop forwarding remote traffic to the Mac.
  public private(set) var locked = false
  /// A hook for hostile-relay tests: return nil to drop a frame to the phone, or a changed frame.
  public var tamperToPhone: ((String) -> String?)?
  public var tamperToMac: ((String) -> String?)?

  private var queue: [() -> Void] = []
  private var scheduled = false
  fileprivate var phone: FakeConnection?
  fileprivate var pairing: FakeConnection?
  private var challengeNonce: String?

  public init(origin: String = "https://relay.valet.test", mac: FakeMac, autoDeliver: Bool = true) {
    self.origin = origin
    self.mac = mac
    self.autoDeliver = autoDeliver
    mac.relay = self
  }

  public func connect(
    relay: String, macId: String, path: RelayPath, onFrame: @escaping @MainActor (String) -> Void, onClose: @escaping @MainActor () -> Void
  ) -> RelayConnection {
    let connection = FakeConnection(relay: self, path: path, onFrame: onFrame, onClose: onClose)
    enqueue { [weak self] in
      guard let self else { return }
      guard self.reachable, relay == self.origin, macId == self.mac.macId else { return connection.closeFromRelay() }
      switch path {
      case .pair:
        self.pairing = connection
      case .phone:
        self.phone?.closeFromRelay()
        self.phone = connection
        var bytes = Data(count: 32)
        for i in 0..<32 { bytes[i] = UInt8.random(in: 0...255) }
        let nonce = Base64URL.encode(bytes)
        self.challengeNonce = nonce
        connection.deliver(JSON.serialize(.object([
          ("type", .string("challenge")), ("v", .number("1")), ("nonce", .string(nonce)), ("relay", .string(self.origin)),
        ])))
      }
    }
    return connection
  }

  /// Delivers everything queued, including what that delivery queues in turn.
  public func drain() {
    var rounds = 0
    while !queue.isEmpty, rounds < 10_000 {
      let next = queue.removeFirst()
      next()
      rounds += 1
    }
  }

  func enqueue(_ work: @escaping () -> Void) {
    queue.append(work)
    guard autoDeliver, !scheduled else { return }
    scheduled = true
    DispatchQueue.main.async { [weak self] in
      self?.scheduled = false
      self?.drain()
    }
  }

  // MARK: From the phone

  fileprivate func received(_ text: String, from connection: FakeConnection) {
    let forwarded: String
    if let tamperToMac {
      guard let changed = tamperToMac(text) else { return }
      forwarded = changed
    } else {
      forwarded = text
    }
    guard let value = try? JSON.parse(forwarded), let type = value.object?.first(where: { $0.0 == "type" })?.1.string else { return }
    switch (connection.path, type) {
    case (.pair, "pairing-reply"):
      guard let f = try? Fields(value, path: "reply", required: ["type", "macId", "offerId", "sealed"]),
        let raw = try? f.raw("sealed"), let sealed = try? Sealed.parse(raw, "sealed"), let offerId = try? f.string("offerId"),
        (try? f.string("macId")) == mac.macId
      else { return }
      mac.receivePairingReply(sealed: sealed, offerId: offerId)
    case (.phone, "hello"):
      guard let f = try? Fields(value, path: "hello", required: ["type", "role", "id", "signature"]),
        let id = try? f.string("id"), let signature = try? f.string("signature"), let nonce = challengeNonce,
        let transportKey = mac.registeredTransportKey(id)
      else { return connection.closeFromRelay() }
      let payload = PhoneToRelay.helloPayload(id: id, nonce: nonce, relay: origin)
      guard Signing.verify(publicKey: transportKey, domain: .relayAuth, payload: payload, signature: signature) else {
        return connection.closeFromRelay()
      }
      connection.authenticated = true
      connection.deliver(JSON.serialize(.object([("type", .string("ready")), ("macOnline", .bool(mac.online))])))
      mac.phoneOnline(id)
    case (.phone, "envelope"):
      guard connection.authenticated,
        let f = try? Fields(value, path: "frame", required: ["type", "envelope"]),
        let raw = try? f.raw("envelope"), let envelope = try? Envelope.parse(raw, "envelope")
      else { return }
      if mac.online { mac.receive(envelope: envelope) }
    case (.phone, "push-token"):
      break
    case (.phone, "relay-lock"):
      guard connection.authenticated else { return }
      locked = true
      connection.deliver(JSON.serialize(.object([("type", .string("relay-locked")), ("locked", .bool(true)), ("by", .string("phone"))])))
    default:
      connection.closeFromRelay()
    }
  }

  fileprivate func closed(_ connection: FakeConnection) {
    if phone === connection { phone = nil }
    if pairing === connection { pairing = nil }
  }

  // MARK: From the Mac

  func toPairing(_ text: String) {
    enqueue { [weak self] in self?.pairing?.deliver(text) }
  }

  func toPhone(envelope: Envelope) {
    let text = JSON.serialize(.object([("type", .string("envelope")), ("envelope", envelope.json)]))
    enqueue { [weak self] in
      guard let self, let phone = self.phone, phone.authenticated else { return }
      phone.deliver(text)
    }
  }

  func macOnlineChanged(_ online: Bool) {
    let text = JSON.serialize(.object([("type", .string("mac-online")), ("online", .bool(online))]))
    enqueue { [weak self] in
      guard let phone = self?.phone, phone.authenticated else { return }
      phone.deliver(text)
    }
  }

  /// The relay drops a phone the Mac unregistered.
  func dropPhone() {
    enqueue { [weak self] in self?.phone?.closeFromRelay() }
  }

  fileprivate func deliverToPhone(_ text: String, on connection: FakeConnection) {
    if let tamperToPhone {
      guard let changed = tamperToPhone(text) else { return }
      connection.onFrame(changed)
    } else {
      connection.onFrame(text)
    }
  }
}

@MainActor
final class FakeConnection: RelayConnection {
  weak var relay: FakeRelay?
  let path: RelayPath
  let onFrame: @MainActor (String) -> Void
  let onClose: @MainActor () -> Void
  var open = true
  var authenticated = false

  init(relay: FakeRelay, path: RelayPath, onFrame: @escaping @MainActor (String) -> Void, onClose: @escaping @MainActor () -> Void) {
    self.relay = relay
    self.path = path
    self.onFrame = onFrame
    self.onClose = onClose
  }

  func send(_ text: String) {
    guard open, let relay else { return }
    relay.enqueue { [weak self] in
      guard let self, self.open else { return }
      relay.received(text, from: self)
    }
  }

  func close() {
    guard open else { return }
    open = false
    relay?.closed(self)
  }

  func deliver(_ text: String) {
    guard open else { return }
    relay?.deliverToPhone(text, on: self)
  }

  func closeFromRelay() {
    guard open else { return }
    open = false
    relay?.closed(self)
    onClose()
  }
}
