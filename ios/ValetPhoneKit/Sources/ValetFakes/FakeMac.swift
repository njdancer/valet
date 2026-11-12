import CryptoKit
import Foundation
import ValetCrypto
import ValetPhoneCore
import ValetProtocol

/// The Mac half of the fake: pairing, requests, signed-decision checks and the tightening
/// commands, as D's broker will do them. Its checks follow `verifyDecision` in core (contracts v2).
@MainActor
public final class FakeMac {
  public enum Event: Equatable, Sendable {
    case paired(deviceId: String)
    case approved(requestId: String, deviceId: String, choice: String?)
    case declined(requestId: String, note: String?)
    case refused(requestId: String, reason: String)
    case command(PhoneCommand)
    case ask(PhoneAsk)
    case loginCode(handoffId: String, code: String)
  }

  public struct Site: Sendable {
    public var adapterId, name, health: String
    public var note: String?
  }

  public struct Agent: Sendable {
    public var clientId: String
    public var label: String
    public var remote: Bool
  }

  public struct Recent: Sendable {
    public var at: Date
    public var isCall: Bool
    public var text: String
  }

  weak var relay: FakeRelay?
  public let name: String
  public private(set) var online = true
  /// Pairing is confirmed at the Mac without anyone there: the fake's stand-in for the person
  /// picking the matching code and pressing Pair with Touch ID.
  public var autoConfirmPairing = true
  public var confirmDelay: TimeInterval = 0
  public private(set) var events: [Event] = []
  /// The code the Mac shows for the pairing in progress.
  public private(set) var pairingCode: String?

  public var safety: MacStatus.Safety = .running
  public var sites: [Site] = []
  public var agents: [Agent] = []
  public var recent: [Recent] = []

  private let approvalKey = P256.Signing.PrivateKey()
  private let transportKey = P256.Signing.PrivateKey()
  private let agreementKey = P256.KeyAgreement.PrivateKey()
  private var offer: PairingOffer?
  private var offerUsed = false
  private var phoneRecord: DeviceRecord?
  private var revoked: Set<String> = []
  private var nextSeq = 1
  private var outbox: [Int: String] = [:]
  private var lastInbound = 0
  private var pending: [String: (text: String, digest: String, request: ApprovalRequest, code: String?)] = [:]
  private let pairedAt = Date()
  private var pendingConfirm: (() -> Void)?

  public init(name: String = "Nick\u{2019}s MacBook Pro") {
    self.name = name
  }

  public var macId: String { Signing.keyId(Signing.spki(approvalKey.publicKey))! }
  public var phoneId: String? { phoneRecord?.deviceId }
  public var pendingIds: [String] { Array(pending.keys) }

  // MARK: Pairing

  /// The QR code the Mac's Pair a phone screen shows.
  public func pairingQR(relay origin: String, expiresIn: TimeInterval = PairingOffer.ttl, now: Date = Date()) -> String {
    let text = JSON.serialize(.object([
      ("v", .number("1")), ("macId", .string(macId)), ("macApprovalKey", .string(Signing.spki(approvalKey.publicKey))),
      ("macAgreementKey", .string(Signing.spki(agreementKey.publicKey))), ("relay", .string(origin)),
      ("secret", .string(Base64URL.encode(Self.random(32)))),
      ("expiresAt", .string(ISOTime.format(now.addingTimeInterval(expiresIn)))),
    ]))
    offer = try? PairingOffer.parse(text: text)
    offerUsed = false
    return PairingOffer.prefix + Base64URL.encode(Data(text.utf8))
  }

  func receivePairingReply(sealed: Sealed, offerId: String) {
    // The first reply spends the offer; any later one is refused.
    guard let offer, !offerUsed, (try? PairingCrypto.offerId(offer)) == offerId else { return }
    guard let replyText = PairingCrypto.open(sealed, kind: "reply", offer: offer), let reply = try? PairingReply.parse(replyText),
      Signing.signingKey(reply.approvalKey) != nil, Signing.signingKey(reply.transportKey) != nil,
      Signing.agreementKey(reply.agreementKey) != nil
    else { return sendResult(.declined, offer: offer) }
    offerUsed = true
    let nonce = Self.random(32)
    pairingCode = try? PairingCrypto.code(offer: offer, replyPlaintext: replyText, macNonce: nonce)
    relay?.toPairing(Self.frame("pairing-challenge", [("offerId", .string(offerId)), ("macNonce", .string(Base64URL.encode(nonce)))]))
    let confirm = { [weak self] in self?.confirmPairing(reply: reply, offer: offer) }
    if autoConfirmPairing {
      if confirmDelay > 0 {
        DispatchQueue.main.asyncAfter(deadline: .now() + confirmDelay) { MainActor.assumeIsolated { confirm() } }
      } else {
        confirm()
      }
    } else {
      pendingConfirm = confirm
    }
  }

  /// The person picked the matching code at the Mac (when `autoConfirmPairing` is off).
  public func confirmPairingAtMac() {
    pendingConfirm?()
    pendingConfirm = nil
  }

  /// The person picked "None of these" at the Mac.
  public func rejectPairingAtMac() {
    pendingConfirm = nil
    if let offer { sendResult(.declined, offer: offer) }
  }

  private func record(role: String, deviceId: String, name: String, approval: String, transport: String, agreement: String) -> SignedText {
    let text = JSON.canonical(.object([
      ("v", .number("1")), ("deviceId", .string(deviceId)), ("macId", .string(macId)), ("role", .string(role)),
      ("platform", .string(role == "mac" ? "macos" : "ios")), ("name", .string(name)), ("approvalKey", .string(approval)),
      ("transportKey", .string(transport)), ("agreementKey", .string(agreement)), ("pairedAt", .string(ISOTime.format(pairedAt))),
    ]))
    let signature = try! approvalKey.signature(for: Signing.input(.deviceRecord, text))
    return SignedText(payload: text, signature: Base64URL.encode(signature.rawRepresentation))
  }

  private func confirmPairing(reply: PairingReply, offer: PairingOffer) {
    guard let deviceId = Signing.keyId(reply.approvalKey) else { return }
    let phone = record(role: "phone", deviceId: deviceId, name: reply.deviceName, approval: reply.approvalKey,
                       transport: reply.transportKey, agreement: reply.agreementKey)
    let mac = record(role: "mac", deviceId: macId, name: name, approval: Signing.spki(approvalKey.publicKey),
                     transport: Signing.spki(transportKey.publicKey), agreement: Signing.spki(agreementKey.publicKey))
    phoneRecord = try? DeviceRecord.parse(phone.payload)
    events.append(.paired(deviceId: deviceId))
    sendResult(.paired(deviceRecord: phone, macRecord: mac), offer: offer)
    sendStatus()
  }

  private func sendResult(_ result: PairingResult, offer: PairingOffer) {
    guard let sealed = try? PairingCrypto.seal(JSON.serialize(result.json), kind: "result", offer: offer),
      let offerId = try? PairingCrypto.offerId(offer)
    else { return }
    relay?.toPairing(Self.frame("pairing-result", [("offerId", .string(offerId)), ("sealed", sealed.json)]))
  }

  func registeredTransportKey(_ deviceId: String) -> String? {
    guard let phoneRecord, phoneRecord.deviceId == deviceId, !revoked.contains(deviceId) else { return nil }
    return phoneRecord.transportKey
  }

  func phoneOnline(_ deviceId: String) {
    for seq in outbox.keys.sorted() { if let text = outbox[seq] { transmit(text) } }
  }

  // MARK: Sending

  /// Seals and sends one message, numbering it.
  private func send(_ type: String, _ fields: [(String, JSONValue)]) {
    let seq = nextSeq
    nextSeq += 1
    let text = JSON.serialize(.object([("type", .string(type)), ("seq", .number(String(seq)))] + fields))
    outbox[seq] = text
    transmit(text)
  }

  private func transmit(_ text: String) {
    guard online, let phoneRecord, let key = Signing.agreementKey(phoneRecord.agreementKey),
      let envelope = try? ChannelSeal.seal(text, from: macId, to: phoneRecord.deviceId, senderKey: agreementKey, recipientKey: key)
    else { return }
    relay?.toPhone(envelope: envelope)
  }

  /// Seals and sends a raw message text, for hostile and ordering tests. Not numbered.
  public func sendRaw(_ text: String) {
    transmit(text)
  }

  /// Skips a seq number, as if the relay had dropped a message: what the next send will be numbered.
  public func skipSeq() -> Int {
    nextSeq += 1
    return nextSeq - 2
  }

  public var lastSentSeq: Int { nextSeq - 1 }

  public func sendStatus() {
    let iso = { (date: Date?) in date.map { JSONValue.string(ISOTime.format($0)) } ?? .null }
    var devices: [JSONValue] = [
      .object([("deviceId", .string(macId)), ("name", .string(name)), ("platform", .string("macos")), ("lastSeenAt", iso(Date()))]),
    ]
    if let phoneRecord {
      devices.append(.object([
        ("deviceId", .string(phoneRecord.deviceId)), ("name", .string(phoneRecord.name)), ("platform", .string("ios")),
        ("lastSeenAt", iso(Date())),
      ]))
    }
    send("status", [
      ("at", .string(ISOTime.format(Date()))), ("safety", .string(safety.rawValue)),
      ("sites", .array(sites.map { site -> JSONValue in
        var entries: [(String, JSONValue)] = [
          ("adapterId", .string(site.adapterId)), ("name", .string(site.name)), ("health", .string(site.health)),
        ]
        if let note = site.note { entries.append(("note", .string(note))) }
        return .object(entries)
      })),
      ("agents", .array(agents.map { agent -> JSONValue in
        .object([
          ("clientId", .string(agent.clientId)), ("label", .string(agent.label)),
          ("transport", .string(agent.remote ? "remote" : "local")), ("lastCallAt", iso(Date().addingTimeInterval(-300))),
        ])
      })),
      ("devices", .array(devices)),
      ("recent", .array(recent.map { r -> JSONValue in
        .object([("at", .string(ISOTime.format(r.at))), ("kind", .string(r.isCall ? "call" : "change")), ("text", .string(r.text))])
      })),
    ])
  }

  /// Sends a request to the phone and holds it as pending. Returns its id.
  @discardableResult
  public func ask(_ request: FakeRequest, now: Date = Date()) -> String {
    let id = request.id ?? Self.randomId()
    let text = request.text(id: id, macId: macId, now: now)
    if let parsed = try? ApprovalRequest.parse(try JSON.parse(text)) {
      pending[id] = (text, Signing.digest(.approvalRequest, text), parsed, request.consentCode)
    }
    send("approval-request", [("requestText", .string(text))])
    return id
  }

  public func alert(kind: MacAlertKind, title: String, body: String) {
    send("alert", [
      ("kind", .string(kind.rawValue)), ("title", .string(title)), ("body", .string(body)), ("at", .string(ISOTime.format(Date()))),
    ])
  }

  public func handoff(id: String = "handoff-woolworths-1", kind: String = "code", expiresIn: TimeInterval = 300) {
    send("handoff", [
      ("handoffId", .string(id)), ("adapterId", .string("woolworths")), ("domain", .string("woolworths.com.au")),
      ("kind", .string(kind)), ("expiresAt", .string(ISOTime.format(Date().addingTimeInterval(expiresIn)))),
    ])
  }

  private func closed(_ id: String, _ outcome: String, reason: String? = nil, by deviceId: String? = nil) {
    var fields: [(String, JSONValue)] = [("requestId", .string(id)), ("outcome", .string(outcome))]
    if let reason { fields.append(("reason", .string(reason))) }
    fields.append(("deviceId", deviceId.map { .string($0) } ?? .null))
    send("approval-closed", fields)
  }

  /// The person answered at the Mac.
  public func answerAtMac(_ id: String, approve: Bool) {
    guard pending.removeValue(forKey: id) != nil else { return }
    closed(id, approve ? "approved" : "declined", by: macId)
  }

  public func withdraw(_ id: String) {
    guard pending.removeValue(forKey: id) != nil else { return }
    closed(id, "withdrawn")
  }

  /// The person removed this phone at the Mac.
  public func revokePhone() {
    guard let id = phoneRecord?.deviceId else { return }
    send("unpaired", [("at", .string(ISOTime.format(Date())))])
    revoked.insert(id)
    relay?.dropPhone()
  }

  public func setOnline(_ value: Bool) {
    online = value
    relay?.macOnlineChanged(value)
    if value { phoneOnline(phoneRecord?.deviceId ?? "") }
  }

  // MARK: Receiving

  func receive(envelope: Envelope) {
    guard let phoneRecord, !revoked.contains(phoneRecord.deviceId),
      let phoneKey = Signing.agreementKey(phoneRecord.agreementKey),
      let text = try? ChannelSeal.open(envelope, me: macId, expectedSender: phoneRecord.deviceId, myKey: agreementKey, senderKey: phoneKey),
      let message = try? PhoneToMac.parse(text, macId: macId)
    else { return }
    if case let .ack(_, ackSeq) = message {
      outbox.removeValue(forKey: ackSeq)
      return
    }
    switch SeqVerdict.of(last: lastInbound, seq: message.seq) {
    case .duplicate: return ack(message.seq)
    // The fake doesn't hold gaps; it waits for the resend, which is enough to test the phone.
    case .gap: return
    case .accept: break
    }
    lastInbound = message.seq
    ack(message.seq)
    handle(message, from: phoneRecord)
  }

  private func ack(_ seq: Int) {
    // Acks never take a number: they carry the last seq the Mac sent.
    transmit(JSON.serialize(.object([
      ("type", .string("ack")), ("seq", .number(String(max(1, nextSeq - 1)))), ("ackSeq", .number(String(seq))),
    ])))
  }

  private func handle(_ message: PhoneToMac, from phone: DeviceRecord) {
    switch message {
    case let .approvalDecision(_, signed):
      // verifyDecision in core, live mode, in its order.
      guard let decision = try? ApprovalDecision.parse(signed.payload) else { return refuse("?", "malformed") }
      guard decision.deviceId == phone.deviceId else { return refuse(decision.requestId, "unknown-device") }
      guard Signing.verify(publicKey: phone.approvalKey, domain: .approvalDecision, payload: signed.payload, signature: signed.signature) else {
        return refuse(decision.requestId, "bad-signature")
      }
      guard decision.macId == macId else { return refuse(decision.requestId, "wrong-mac") }
      guard let entry = pending[decision.requestId] else { return refuse(decision.requestId, "not-pending", close: false) }
      guard decision.requestDigest == entry.digest else { return refuse(decision.requestId, "wrong-request") }
      guard entry.request.approvableOnPhone else { return refuse(decision.requestId, "not-allowed-on-device") }
      guard Date() < entry.request.expiresAt else { return refuse(decision.requestId, "expired") }
      if case let .setting(s) = entry.request.subject {
        let ok = s.choices.map { choices in choices.contains { $0.value == decision.choice } } ?? (decision.choice == nil)
        guard ok else { return refuse(decision.requestId, "bad-choice") }
      } else if decision.choice != nil {
        return refuse(decision.requestId, "bad-choice")
      }
      if entry.request.kind == .remoteClient {
        guard decision.typedCode != nil, decision.typedCode == entry.code else { return refuse(decision.requestId, "wrong-code") }
      } else if decision.typedCode != nil {
        return refuse(decision.requestId, "wrong-code")
      }
      pending.removeValue(forKey: decision.requestId)
      events.append(.approved(requestId: decision.requestId, deviceId: phone.deviceId, choice: decision.choice))
      closed(decision.requestId, "approved", by: phone.deviceId)
      sendStatus()
    case let .approvalDecline(_, requestId, note, _):
      guard pending.removeValue(forKey: requestId) != nil else { return }
      events.append(.declined(requestId: requestId, note: note))
      closed(requestId, "declined", by: phone.deviceId)
    case let .ask(_, ask):
      events.append(.ask(ask))
    case let .loginCode(_, handoffId, code):
      events.append(.loginCode(handoffId: handoffId, code: code))
    case let .command(_, command):
      events.append(.command(command))
      switch command {
      case .lockdown:
        safety = .lockdown
        for id in pending.keys.sorted() { closed(id, "declined") }
        pending.removeAll()
        agents.removeAll { $0.remote }
      case .pauseRemote:
        if safety == .running { safety = .remotePaused }
      case let .revokeClient(clientId):
        agents.removeAll { $0.clientId == clientId }
        for (id, entry) in pending {
          if case let .agent(asker, _) = entry.request.requester, asker == clientId {
            pending.removeValue(forKey: id)
            closed(id, "withdrawn")
          }
        }
      case .revokeDevice:
        break
      }
      sendStatus()
    case .ack:
      break
    }
  }

  private func refuse(_ requestId: String, _ reason: String, close: Bool = true) {
    events.append(.refused(requestId: requestId, reason: reason))
    // A refusal leaves the request pending for another answer, and tells the phone why.
    if close, pending[requestId] != nil { closed(requestId, "refused", reason: reason) }
  }

  // MARK: Builders

  static func frame(_ type: String, _ fields: [(String, JSONValue)]) -> String {
    JSON.serialize(.object([("type", .string(type))] + fields))
  }

  static func random(_ count: Int) -> Data {
    var bytes = Data(count: count)
    for i in 0..<count { bytes[i] = UInt8.random(in: 0...255) }
    return bytes
  }

  public static func randomId() -> String { Base64URL.encode(random(16)) }
}
