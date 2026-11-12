// The phone's state: pairing, the channel to the Mac, the inbox of cards, and the tightening
// commands. Views read it and call its methods; nothing here draws anything.
//
// The rules it keeps (docs/ios-app.md):
// - Messages from the Mac are accepted only in order (seq == last + 1). Duplicates are acked again
//   and dropped; a gap is held and shown until the missing message arrives. Acks sit outside the
//   order and are never acked.
// - Every message to the Mac stays in the outbox until the Mac acks it, across restarts.
// - A card is rendered from, and signed over, the exact request text received. A second, different
//   text for the same request id is refused.
// - Deadlines run on the monotonic clock from arrival, so a phone with a wrong clock can still
//   answer; the Mac decides.
// - Keys are deleted only when the Mac says this phone was removed, or the person unpairs.

import Foundation
import Observation
import ValetCrypto
import ValetProtocol

public enum PairingStep: Equatable, Sendable {
  case sending
  case code(String)
  case waitingForMac(code: String)
  case failed(PairingFailure)
}

public enum PairingFailure: String, Equatable, Sendable {
  case notACode = "That isn't a Valet pairing code. Scan the code on your Mac."
  case expired = "That code has run out. Show a new code on your Mac."
  case abandoned = "Nothing was paired. Someone may have shown you a different code."
  case noSecureEnclave = "This iPhone can't keep Valet's keys safe, so it can't pair."
  case badRecord = "Your Mac's answer didn't check out. Nothing was paired."
}

public enum Phase: Equatable, Sendable {
  case unpaired(notice: String?)
  case pairing(PairingStep)
  case paired
}

public enum CardState: Equatable, Sendable {
  case waiting
  /// Face ID is up.
  case signing
  /// Sent; no ack yet.
  case sending
  /// No ack within 30 seconds. "Check again" resends the same signed text.
  case notConfirmed
  /// The Mac acked; it hasn't closed the request yet.
  case macChecking
  case approvedHere
  case declinedHere
  /// Answered on another device.
  case answeredElsewhere(CloseOutcome)
  /// This phone answered, and another device's answer won.
  case notUsed
  case expired
  case withdrawn
  case lockedDown
  /// The Mac didn't accept this phone's approval, with core's refusal reason.
  case refused(String)

  public var isOpen: Bool {
    switch self {
    case .waiting, .signing, .sending, .notConfirmed, .macChecking: return true
    default: return false
    }
  }
}

public struct CardEntry: Identifiable, Equatable, Sendable {
  public var id: String { card.requestId }
  public var card: Card
  public let text: String
  public var state: CardState
  /// Monotonic time the card arrived, and how long it lives from then.
  public let arrivedUptime: TimeInterval
  public let lifetime: TimeInterval
  /// What this phone sent for it, if anything.
  public var sentSeq: Int?
  public var sentApproval: Bool
  public var sentAt: TimeInterval?
  public var signedDecision: SignedText?
  /// The name of the device that answered, from the Mac's closing.
  public var answeredBy: String?
}

public struct HandoffEntry: Identifiable, Equatable, Sendable {
  public let handoff: Handoff
  public let arrivedUptime: TimeInterval
  public let lifetime: TimeInterval
  public var sentSeq: Int?
  public var confirmed: Bool
  public var id: String { handoff.handoffId }
}

public struct PendingCommand: Identifiable, Equatable, Sendable {
  public let seq: Int
  public let command: PhoneCommand
  public let sentAt: TimeInterval
  public var confirmed: Bool
  public var id: Int { seq }
}

public struct AlertEntry: Identifiable, Equatable, Sendable {
  public let id: Int
  public let kind: MacAlertKind
  public let title: String
  public let body: String
  public let at: Date
}

public enum ApproveRefusal: Error, Equatable {
  case notOpen
  case expired
  case macOnly
  case needsReadTick
  case wrongCode
  case faceIDFailed
  case faceIDChanged
  case notPaired
  /// Approve is held for a moment after anything on the card changed (review finding 8).
  case tooSoon
  case needsChoice
}

@MainActor
@Observable
public final class PhoneModel {
  public static let notConfirmedAfter: TimeInterval = 30
  public static let settleTime: TimeInterval = 1
  public static let maxHeld = 64

  public private(set) var phase: Phase = .unpaired(notice: nil)
  public private(set) var cards: [CardEntry] = []
  public private(set) var status: MacStatus?
  public private(set) var alerts: [AlertEntry] = []
  public private(set) var commands: [PendingCommand] = []
  public private(set) var connected = false
  public private(set) var macOnline = false
  public private(set) var macLastSeen: Date?
  /// Messages from the Mac are missing (a gap in seq).
  public private(set) var missingMessages = false
  /// Requests that failed to parse; and how many of those were a kind this build doesn't know.
  public private(set) var unreadable = 0
  public private(set) var needsUpdate = false
  /// Envelopes dropped for a bad seal, wrong party or bad shape. Diagnostics only.
  public private(set) var dropped = 0
  public private(set) var hardwareKeys = true
  /// When anything on screen last changed, monotonic. Approve waits `settleTime` after it.
  public private(set) var lastChange: TimeInterval = 0
  /// The relay stopped forwarding remote traffic to the Mac (a phone or the recovery page asked).
  public private(set) var relayLocked = false
  public private(set) var handoffs: [HandoffEntry] = []

  private let transport: RelayTransport
  private let store: PhoneStore
  private let clock: PhoneClock
  private var persisted: PersistedPhone?
  private var keys: DeviceKeys?
  private var connection: RelayConnection?
  private var pairingConnection: RelayConnection?
  private var pendingOffer: PairingOffer?
  private var pendingReply: String?
  private var held: [Int: MacToPhone] = [:]
  private var alertCounter = 0

  /// How the model makes and loads keys. Tests pass their own, so they hold the software keys.
  public struct Keys {
    public var make: () throws -> DeviceKeys
    public var load: (StoredKeys) throws -> DeviceKeys

    public init(make: @escaping () throws -> DeviceKeys, load: @escaping (StoredKeys) throws -> DeviceKeys) {
      self.make = make
      self.load = load
    }

    public static func system(allowSoftware: Bool) -> Keys {
      Keys(
        make: { try DeviceKeyFactory.make(allowSoftware: allowSoftware) },
        load: { try DeviceKeyFactory.load($0, allowSoftware: allowSoftware) }
      )
    }
  }

  private let keyFactory: Keys

  public init(transport: RelayTransport, store: PhoneStore, clock: PhoneClock = .system, keys keyFactory: Keys) {
    self.transport = transport
    self.store = store
    self.clock = clock
    self.keyFactory = keyFactory
    if let saved = store.load(), saved.paired, let keys = try? keyFactory.load(saved.keys) {
      persisted = saved
      self.keys = keys
      hardwareKeys = keys.hardwareBacked
      phase = .paired
      for text in saved.requests { accept(requestText: text) }
    } else if store.load() != nil {
      // A pairing that never finished: start again.
      store.wipe()
    }
  }

  // MARK: Identity

  public var deviceId: String? { keys?.publicKeys.deviceId }
  public var macId: String? { persisted?.macId }
  public var deviceName: String? { persisted?.name }
  public var macName: String { persisted?.macName ?? "your Mac" }
  public var openCards: [CardEntry] { cards.filter { $0.state.isOpen } }

  // MARK: Pairing

  /// Starts pairing from a scanned QR code.
  public func pair(qr: String, name: String) {
    let offer: PairingOffer
    do { offer = try PairingOffer.parse(qr: qr) } catch { return fail(.notACode) }
    guard Signing.keyId(offer.macApprovalKey) == offer.macId, Signing.signingKey(offer.macApprovalKey) != nil,
      Signing.agreementKey(offer.macAgreementKey) != nil
    else { return fail(.notACode) }
    guard offer.expiresAt.addingTimeInterval(60) > clock.now() else { return fail(.expired) }
    let newKeys: DeviceKeys
    do { newKeys = try keyFactory.make() } catch { return fail(.noSecureEnclave) }
    let publicKeys = newKeys.publicKeys
    let cleanName = DisplayText.isValid(name, max: 60) ? name : "iPhone"
    let reply = PairingReply(
      deviceName: cleanName, approvalKey: publicKeys.approval, transportKey: publicKeys.transport,
      agreementKey: publicKeys.agreement
    ).text
    let sealed: Sealed
    let offerId: String
    do {
      sealed = try PairingCrypto.seal(reply, kind: "reply", offer: offer)
      offerId = try PairingCrypto.offerId(offer)
    } catch { return fail(.notACode) }

    keys = newKeys
    hardwareKeys = newKeys.hardwareBacked
    pendingOffer = offer
    pendingReply = reply
    persisted = PersistedPhone(
      macId: offer.macId, macApprovalKey: offer.macApprovalKey, macAgreementKey: offer.macAgreementKey,
      relay: offer.relay, keys: newKeys.stored, name: cleanName, macName: nil, recordPayload: nil, recordSignature: nil,
      lastInbound: 0, nextOutbound: 1, outbox: [:], requests: []
    )
    phase = .pairing(.sending)
    touch()
    let conn = transport.connect(relay: offer.relay, path: .pair, onFrame: { [weak self] text in
      self?.receivePairingFrame(text)
    }, onClose: { [weak self] in
      self?.pairingClosed()
    })
    pairingConnection = conn
    conn.send(PhoneToRelay.pairingReply(macId: offer.macId, offerId: offerId, sealed: sealed).text)
  }

  public func cancelPairing() {
    pairingConnection?.close()
    pairingConnection = nil
    connection?.close()
    connection = nil
    resetToUnpaired(notice: nil)
  }

  private func fail(_ failure: PairingFailure) {
    pairingConnection?.close()
    pairingConnection = nil
    connection?.close()
    connection = nil
    keys = nil
    persisted = nil
    pendingOffer = nil
    pendingReply = nil
    store.wipe()
    phase = .pairing(.failed(failure))
    touch()
  }

  private func receivePairingFrame(_ text: String) {
    guard case .pairing = phase, let offer = pendingOffer, let reply = pendingReply,
      let offerId = try? PairingCrypto.offerId(offer)
    else { return }
    guard let frame = try? RelayToPhone.parse(text) else { return }
    switch frame {
    case let .pairingChallenge(id, macNonce):
      // One challenge per offer: a second one could only come from a relay trying its luck.
      guard id == offerId, case .pairing(.sending) = phase else { return }
      guard let nonce = Base64URL.decode(macNonce),
        let code = try? PairingCrypto.code(offer: offer, replyPlaintext: reply, macNonce: nonce)
      else { return fail(.abandoned) }
      phase = .pairing(.code(code))
      touch()
    case let .pairingResult(id, sealed):
      guard id == offerId else { return }
      // Sealed with the QR's secret: the relay can't forge a result, only drop it.
      guard let text = PairingCrypto.open(sealed, kind: "result", offer: offer), let result = try? PairingResult.parse(text) else {
        return fail(.abandoned)
      }
      switch result {
      case let .paired(deviceRecord, macRecord):
        guard case .pairing(.code) = phase else { return fail(.abandoned) }
        finishPairing(deviceRecord: deviceRecord, macRecord: macRecord)
      case .expired: fail(.expired)
      case .declined, .tooManyAttempts: fail(.abandoned)
      }
    default:
      break
    }
  }

  private func pairingClosed() {
    pairingConnection = nil
    if case .pairing(.sending) = phase { fail(.abandoned) }
    if case .pairing(.code) = phase { fail(.abandoned) }
  }

  private func finishPairing(deviceRecord: SignedText, macRecord: SignedText) {
    guard let persisted, let keys else { return }
    guard let record = Signing.verifyDeviceRecord(deviceRecord, macApprovalKey: persisted.macApprovalKey),
      record.role == "phone", record.platform == "ios", record.deviceId == keys.publicKeys.deviceId,
      record.approvalKey == keys.publicKeys.approval, record.transportKey == keys.publicKeys.transport,
      record.agreementKey == keys.publicKeys.agreement,
      let mac = Signing.verifyDeviceRecord(macRecord, macApprovalKey: persisted.macApprovalKey),
      mac.role == "mac", mac.deviceId == persisted.macId, mac.approvalKey == persisted.macApprovalKey,
      mac.agreementKey == persisted.macAgreementKey
    else { return fail(.badRecord) }
    pairingConnection?.close()
    pairingConnection = nil
    self.persisted?.recordPayload = deviceRecord.payload
    self.persisted?.recordSignature = deviceRecord.signature
    self.persisted?.macName = mac.name
    pendingOffer = nil
    pendingReply = nil
    phase = .paired
    save()
    connect()
  }

  // MARK: Connection

  /// Opens the device channel. Called at launch when paired, and after the Mac registered us.
  public func connect() {
    guard let persisted, connection == nil else { return }
    let conn = transport.connect(relay: persisted.relay, path: .phone, onFrame: { [weak self] text in
      self?.receive(frame: text)
    }, onClose: { [weak self] in
      self?.closed()
    })
    connection = conn
  }

  public func disconnect() {
    connection?.close()
    connection = nil
    connected = false
  }

  private func closed() {
    connection = nil
    connected = false
    if macOnline { macLastSeen = clock.now() }
    macOnline = false
    touch()
  }

  private func receive(frame text: String) {
    guard let persisted, let keys else { return }
    guard let frame = try? RelayToPhone.parse(text) else { dropped += 1; return }
    switch frame {
    case let .challenge(nonce, relay):
      // A challenge for another relay is someone else's; never sign it.
      guard relay == persisted.relay else { dropped += 1; return }
      let payload = PhoneToRelay.helloPayload(id: keys.publicKeys.deviceId, nonce: nonce, relay: relay)
      guard let signature = try? keys.signTransport(Signing.input(.relayAuth, payload)) else { return }
      connection?.send(PhoneToRelay.hello(id: keys.publicKeys.deviceId, signature: Base64URL.encode(signature)).text)
    case let .ready(online):
      connected = true
      setMacOnline(online)
      flushOutbox()
    case let .macOnline(online):
      setMacOnline(online)
      if online { flushOutbox() }
    case let .envelope(envelope):
      receive(envelope: envelope)
    case let .relayLocked(locked, _):
      relayLocked = locked
      touch()
    case .pairingChallenge, .pairingResult:
      dropped += 1
    }
  }

  private func setMacOnline(_ online: Bool) {
    if macOnline && !online { macLastSeen = clock.now() }
    macOnline = online
    if online { macLastSeen = nil }
    touch()
  }

  private func receive(envelope: Envelope) {
    guard let persisted, let keys, let macKey = Signing.agreementKey(persisted.macAgreementKey),
      let myKey = try? keys.agreementKey()
    else { return }
    guard let plaintext = try? ChannelSeal.open(
      envelope, me: keys.publicKeys.deviceId, expectedSender: persisted.macId, myKey: myKey, senderKey: macKey
    ), let message = try? MacToPhone.parse(plaintext) else {
      dropped += 1
      return
    }
    receive(message: message)
  }

  /// The ordering rule. Internal so tests can drive it without crypto.
  func receive(message: MacToPhone) {
    guard var state = persisted else { return }
    if case let .ack(_, ackSeq) = message {
      acked(ackSeq)
      return
    }
    let seq = message.seq
    switch SeqVerdict.of(last: state.lastInbound, seq: seq) {
    case .duplicate:
      sendAck(seq)
      return
    case .gap:
      if held.count < Self.maxHeld { held[seq] = message }
      missingMessages = true
      sendAck(seq)
      touch()
      return
    case .accept:
      break
    }
    state.lastInbound = seq
    persisted = state
    handle(message)
    sendAck(seq)
    while let next = held.removeValue(forKey: (persisted?.lastInbound ?? 0) + 1) {
      persisted?.lastInbound = next.seq
      handle(next)
    }
    missingMessages = !held.isEmpty
    save()
  }

  private func handle(_ message: MacToPhone) {
    switch message {
    case let .approvalRequest(_, text):
      accept(requestText: text)
    case let .approvalClosed(_, requestId, outcome, reason, deviceId):
      close(requestId: requestId, outcome: outcome, reason: reason, by: deviceId)
    case let .alert(_, kind, title, body, at):
      alertCounter += 1
      alerts.insert(AlertEntry(id: alertCounter, kind: kind, title: title, body: body, at: at), at: 0)
      if alerts.count > 50 { alerts.removeLast() }
    case let .status(_, status):
      self.status = status
      if status.safety == .lockdown {
        for i in cards.indices where cards[i].state.isOpen { cards[i].state = .lockedDown }
      }
      refreshCards()
    case .unpaired:
      disconnect()
      resetToUnpaired(notice: "This iPhone was removed from Valet. Pair it again at your Mac to use it.")
    case let .handoff(_, handoff):
      handoffs.removeAll { $0.handoff.handoffId == handoff.handoffId }
      handoffs.insert(HandoffEntry(handoff: handoff, arrivedUptime: clock.uptime(), lifetime: handoff.expiresAt.timeIntervalSince(clock.now()), sentSeq: nil, confirmed: false), at: 0)
    case .ack:
      break
    }
    touch()
  }

  private func resetToUnpaired(notice: String?) {
    keys = nil
    persisted = nil
    cards = []
    status = nil
    alerts = []
    commands = []
    held = [:]
    connected = false
    macOnline = false
    store.wipe()
    phase = .unpaired(notice: notice)
    touch()
  }

  /// The person chose Unpair this iPhone. Forgets everything on this phone; the Mac still lists
  /// it until it's removed there.
  public func unpair() {
    disconnect()
    resetToUnpaired(notice: nil)
  }

  // MARK: Sending

  @discardableResult
  private func send(_ make: (Int) -> PhoneToMac) -> Int? {
    guard var state = persisted, let keys else { return nil }
    let seq = state.nextOutbound
    state.nextOutbound += 1
    let text = make(seq).text
    state.outbox[seq] = text
    persisted = state
    save()
    transmit(text, keys: keys, state: state)
    return seq
  }

  private func transmit(_ text: String, keys: DeviceKeys, state: PersistedPhone) {
    guard connected, let connection, let macKey = Signing.agreementKey(state.macAgreementKey),
      let myKey = try? keys.agreementKey(),
      let envelope = try? ChannelSeal.seal(text, from: keys.publicKeys.deviceId, to: state.macId, senderKey: myKey, recipientKey: macKey)
    else { return }
    connection.send(PhoneToRelay.envelope(envelope).text)
  }

  private func sendAck(_ seq: Int) {
    guard let state = persisted, let keys else { return }
    // Acks carry the last seq this phone sent, and never take a number of their own.
    let text = PhoneToMac.ack(seq: max(1, state.nextOutbound - 1), ackSeq: seq).text
    transmit(text, keys: keys, state: state)
  }

  private func flushOutbox() {
    guard let state = persisted, let keys else { return }
    for seq in state.outbox.keys.sorted() {
      if let text = state.outbox[seq] { transmit(text, keys: keys, state: state) }
    }
  }

  private func acked(_ seq: Int) {
    guard persisted?.outbox.removeValue(forKey: seq) != nil else { return }
    save()
    for i in cards.indices where cards[i].sentSeq == seq {
      if cards[i].state == .sending || cards[i].state == .notConfirmed { cards[i].state = .macChecking }
    }
    for i in commands.indices where commands[i].seq == seq { commands[i].confirmed = true }
    for i in handoffs.indices where handoffs[i].sentSeq == seq { handoffs[i].confirmed = true }
    touch()
  }

  // MARK: Cards

  private func accept(requestText text: String) {
    switch Requests.parse(text) {
    case .failure(.unknownKindOrVersion):
      unreadable += 1
      needsUpdate = true
    case .failure:
      unreadable += 1
    case let .success(parsed):
      guard parsed.request.macId == persisted?.macId else { unreadable += 1; return }
      if let existing = cards.first(where: { $0.id == parsed.request.id }) {
        // The same request again is a resend; a different text under the same id is refused.
        if existing.text != text { unreadable += 1 }
        return
      }
      let lifetime = parsed.request.expiresAt.timeIntervalSince(parsed.request.createdAt)
      let entry = CardEntry(
        card: CardModel.card(for: parsed, status: status), text: text,
        state: status?.safety == .lockdown ? .lockedDown : .waiting, arrivedUptime: clock.uptime(), lifetime: lifetime,
        sentSeq: nil, sentApproval: false, sentAt: nil, signedDecision: nil, answeredBy: nil
      )
      cards.insert(entry, at: 0)
      if !(persisted?.requests.contains(text) ?? true) { persisted?.requests.append(text) }
    }
  }

  private func refreshCards() {
    for i in cards.indices {
      if case let .success(parsed) = Requests.parse(cards[i].text) {
        cards[i].card = CardModel.card(for: parsed, status: status)
      }
    }
  }

  private func close(requestId: String, outcome: CloseOutcome, reason: String?, by deviceId: String?) {
    guard let i = cards.firstIndex(where: { $0.id == requestId }) else { return }
    let entry = cards[i]
    let byMe = deviceId.map { $0 == self.deviceId } ?? (entry.sentSeq != nil)
    cards[i].answeredBy = deviceId.flatMap { id in status?.devices.first { $0.deviceId == id }?.name }
    switch outcome {
    case .approved:
      cards[i].state = byMe && entry.sentApproval ? .approvedHere : (entry.sentSeq != nil ? .notUsed : .answeredElsewhere(.approved))
    case .declined:
      if entry.sentSeq == nil || !byMe {
        cards[i].state = status?.safety == .lockdown ? .lockedDown : (entry.sentSeq != nil ? .notUsed : .answeredElsewhere(.declined))
      } else {
        cards[i].state = entry.sentApproval ? .notUsed : .declinedHere
      }
    case .expired: cards[i].state = .expired
    case .withdrawn: cards[i].state = .withdrawn
    case .refused: cards[i].state = .refused(reason ?? "malformed")
    }
    persisted?.requests.removeAll { $0 == entry.text }
  }

  /// Seconds left before the card's deadline, by the monotonic clock.
  public func remaining(_ entry: CardEntry) -> TimeInterval {
    entry.arrivedUptime + entry.lifetime - clock.uptime()
  }

  /// Whether Approve can be pressed now, and if not, why.
  public func approveBlocker(_ id: String, readTicked: Bool, typedCode: String?, choice: String? = nil) -> ApproveRefusal? {
    guard let entry = cards.first(where: { $0.id == id }) else { return .notOpen }
    guard entry.state == .waiting || entry.state == .notConfirmed else { return .notOpen }
    if entry.card.macOnlyReason != nil { return .macOnly }
    if remaining(entry) <= 0 { return .expired }
    if entry.card.needsReadTick && !readTicked { return .needsReadTick }
    if entry.card.needsTypedCode, Self.normaliseCode(typedCode) == nil { return .wrongCode }
    if let choices = entry.card.choices, !choices.contains(where: { $0.value == choice }) { return .needsChoice }
    if clock.uptime() - lastChange < Self.settleTime { return .tooSoon }
    return nil
  }

  /// Approves with Face ID: signs the decision over the exact request text on screen and sends it.
  /// "abcd efgh", "ABCD-EFGH" → "ABCD-EFGH"; nil unless eight letters from the consent alphabet.
  public static func normaliseCode(_ typed: String?) -> String? {
    guard let typed else { return nil }
    let letters = typed.uppercased().filter { $0.isLetter }
    guard letters.count == 8 else { return nil }
    let code = "\(letters.prefix(4))-\(letters.suffix(4))"
    return matches(code, Patterns.consentCode) ? code : nil
  }

  public func approve(_ id: String, readTicked: Bool = false, typedCode: String? = nil, choice: String? = nil) async throws {
    if let blocker = approveBlocker(id, readTicked: readTicked, typedCode: typedCode, choice: choice) {
      // "Check again" on an unconfirmed approval resends the same signed text.
      if blocker == .notOpen, let entry = cards.first(where: { $0.id == id }), entry.state == .notConfirmed {
        return resend(id)
      }
      throw blocker
    }
    guard let state = persisted, let keys, let i = cards.firstIndex(where: { $0.id == id }) else { throw ApproveRefusal.notPaired }
    if cards[i].state == .notConfirmed { return resend(id) }
    let entry = cards[i]
    let decision = ApprovalDecision(
      macId: state.macId, requestId: entry.card.requestId, requestDigest: entry.card.digest,
      deviceId: keys.publicKeys.deviceId, decidedAt: clock.now(),
      choice: entry.card.choices == nil ? nil : choice,
      typedCode: entry.card.needsTypedCode ? Self.normaliseCode(typedCode) : nil
    )
    let payload = decision.payload
    cards[i].state = .signing
    let signature: Data
    do {
      signature = try await keys.signApproval(Signing.input(.approvalDecision, payload), reason: entry.card.faceIDReason)
    } catch KeyError.biometryChanged {
      setState(id, .waiting)
      throw ApproveRefusal.faceIDChanged
    } catch {
      setState(id, .waiting)
      throw ApproveRefusal.faceIDFailed
    }
    // The card may have closed while Face ID was up.
    guard let j = cards.firstIndex(where: { $0.id == id }), cards[j].state == .signing, cards[j].card.digest == entry.card.digest else {
      return
    }
    let signed = SignedText(payload: payload, signature: Base64URL.encode(signature))
    cards[j].signedDecision = signed
    cards[j].sentApproval = true
    cards[j].sentAt = clock.uptime()
    cards[j].state = .sending
    cards[j].sentSeq = send { .approvalDecision(seq: $0, decision: signed) }
    touch()
  }

  private func resend(_ id: String) {
    guard let i = cards.firstIndex(where: { $0.id == id }), let seq = cards[i].sentSeq,
      let state = persisted, let keys, let text = state.outbox[seq]
    else { return }
    cards[i].state = .sending
    cards[i].sentAt = clock.uptime()
    transmit(text, keys: keys, state: state)
  }

  /// Declines. One tap, no Face ID. The note goes only to the asking agent.
  public func decline(_ id: String, note: String? = nil, stopAsking: Bool = false) {
    guard let i = cards.firstIndex(where: { $0.id == id }), cards[i].state == .waiting || cards[i].state == .lockedDown else { return }
    let cleanNote = note.flatMap { DisplayText.isValid($0, max: 280) ? $0 : nil }
    cards[i].sentAt = clock.uptime()
    cards[i].state = .sending
    cards[i].sentSeq = send { .approvalDecline(seq: $0, requestId: id, note: cleanNote, stopAsking: stopAsking) }
    touch()
  }

  /// Asks the Mac to start something that needs approval; the Mac builds the card.
  public func ask(_ ask: PhoneAsk) {
    send { .ask(seq: $0, ask: ask) }
  }

  /// Sends a one-time code the person typed for a login hand-off (J6). No Face ID: it goes only into
  /// that login's code step.
  public func sendLoginCode(_ handoffId: String, code: String) -> Bool {
    let clean = code.filter { !$0.isWhitespace }
    guard matches(clean, "[A-Za-z0-9-]{4,12}"), let i = handoffs.firstIndex(where: { $0.id == handoffId }), handoffs[i].sentSeq == nil else {
      return false
    }
    handoffs[i].sentSeq = send { .loginCode(seq: $0, handoffId: handoffId, code: clean) }
    touch()
    return true
  }

  /// J7 F1: asks the relay itself to stop forwarding to the Mac, which works while the Mac is away.
  public func lockAtRelay() {
    connection?.send(PhoneToRelay.relayLock.text)
  }

  private func setState(_ id: String, _ state: CardState) {
    if let i = cards.firstIndex(where: { $0.id == id }) { cards[i].state = state }
  }

  // MARK: Commands

  /// Pause remote use, Lock down, Revoke an agent, Remove a device. No Face ID: each only tightens.
  public func send(command: PhoneCommand) {
    if case let .revokeDevice(id) = command, id == persisted?.macId || id == deviceId { return }
    guard let seq = send({ .command(seq: $0, command: command) }) else { return }
    commands.append(PendingCommand(seq: seq, command: command, sentAt: clock.uptime(), confirmed: false))
    touch()
  }

  public func isUnconfirmed(_ command: PendingCommand) -> Bool {
    !command.confirmed && clock.uptime() - command.sentAt >= Self.notConfirmedAfter
  }

  // MARK: Time

  /// Re-checks deadlines. The app calls this every second; tests call it after moving the clock.
  public func tick() {
    let now = clock.uptime()
    for i in cards.indices {
      let entry = cards[i]
      if entry.state == .waiting, remaining(entry) <= 0 { cards[i].state = .expired }
      if entry.state == .sending, let sentAt = entry.sentAt, now - sentAt >= Self.notConfirmedAfter {
        cards[i].state = .notConfirmed
      }
    }
  }

  private func touch() { lastChange = clock.uptime() }

  private func save() {
    if let persisted, persisted.recordPayload != nil || isPairing { store.save(persisted) }
  }

  private var isPairing: Bool { if case .pairing = phase { return true } else { return false } }
}
