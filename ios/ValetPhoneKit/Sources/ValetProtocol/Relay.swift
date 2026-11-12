// A port of the phone's half of packages/core/src/relay-protocol.ts, pairing.ts and devices.ts
// (contracts v2): the frames a phone sends to and receives from the relay, the messages inside
// sealed envelopes, the pairing offer, reply and result, and the device record.

import Foundation

public enum RelayProtocol {
  public static let version = 1
  public static let suite = "hpke-auth-p256-sha256-aes256gcm"
  public static let maxEnvelopeBytes = 128 * 1024
  public static let nonce = "[A-Za-z0-9_-]{43}"
  public static let handoffId = "[A-Za-z0-9_-]{8,40}"
  public static let decisionRefusals = [
    "malformed", "unknown-device", "device-revoked", "bad-signature", "wrong-mac", "wrong-request", "not-pending",
    "expired", "not-allowed-on-device", "bad-choice", "wrong-code",
  ]
}

public struct Envelope: Equatable, Sendable {
  public let from: String
  public let to: String
  /// Base64url of the 65-byte encapsulated key.
  public let enc: String
  public let ct: String

  public init(from: String, to: String, enc: String, ct: String) {
    self.from = from
    self.to = to
    self.enc = enc
    self.ct = ct
  }

  public var json: JSONValue {
    .object([
      ("v", .number("1")), ("suite", .string(RelayProtocol.suite)), ("from", .string(from)), ("to", .string(to)),
      ("enc", .string(enc)), ("ct", .string(ct)),
    ])
  }

  public static func parse(_ value: JSONValue, _ path: String) throws -> Envelope {
    let f = try Fields(value, path: path, required: ["v", "suite", "from", "to", "enc", "ct"])
    try f.literal("v", 1)
    try f.literal("suite", RelayProtocol.suite)
    return Envelope(
      from: try f.string("from", pattern: Patterns.keyId),
      to: try f.string("to", pattern: Patterns.keyId),
      enc: try f.string("enc", pattern: "[A-Za-z0-9_-]{87}"),
      ct: try f.string("ct", pattern: Patterns.base64url, max: 174_000)
    )
  }
}

/// AES-256-GCM for pairing (`sealedSchema`): a 12-byte IV, and the ciphertext with its tag.
public struct Sealed: Equatable, Sendable {
  public let iv: String
  public let ct: String

  public init(iv: String, ct: String) {
    self.iv = iv
    self.ct = ct
  }

  public var json: JSONValue { .object([("iv", .string(iv)), ("ct", .string(ct))]) }

  public static func parse(_ value: JSONValue, _ path: String) throws -> Sealed {
    let f = try Fields(value, path: path, required: ["iv", "ct"])
    return Sealed(iv: try f.string("iv", pattern: "[A-Za-z0-9_-]{16}"), ct: try f.string("ct", pattern: Patterns.base64url, max: 16_000))
  }
}

func frameType(_ value: JSONValue, _ what: String) throws -> String {
  guard let type = value.object?.first(where: { $0.0 == "type" })?.1.string else { throw SchemaError(what, "no type") }
  return type
}

// MARK: Relay frames

public enum RelayToPhone: Equatable, Sendable {
  case challenge(nonce: String, relay: String)
  case ready(macOnline: Bool)
  case envelope(Envelope)
  case macOnline(Bool)
  /// The Mac accepted this reply and sends the nonce the code is derived from.
  case pairingChallenge(offerId: String, macNonce: String)
  /// The Mac's sealed answer: the signed records, or why not.
  case pairingResult(offerId: String, sealed: Sealed)
  /// The relay stopped (or resumed) forwarding remote traffic to the Mac.
  case relayLocked(locked: Bool, by: String)

  public static func parse(_ text: String) throws -> RelayToPhone {
    let value = try JSON.parse(text)
    let type = try frameType(value, "frame")
    switch type {
    case "challenge":
      let f = try Fields(value, path: type, required: ["type", "v", "nonce", "relay"])
      try f.literal("v", RelayProtocol.version)
      return .challenge(nonce: try f.string("nonce", pattern: RelayProtocol.nonce), relay: try f.httpsURL("relay"))
    case "ready":
      let f = try Fields(value, path: type, required: ["type", "macOnline"])
      return .ready(macOnline: try f.bool("macOnline"))
    case "envelope":
      let f = try Fields(value, path: type, required: ["type", "envelope"])
      return .envelope(try Envelope.parse(try f.raw("envelope"), "envelope.envelope"))
    case "mac-online":
      let f = try Fields(value, path: type, required: ["type", "online"])
      return .macOnline(try f.bool("online"))
    case "pairing-challenge":
      let f = try Fields(value, path: type, required: ["type", "offerId", "macNonce"])
      return .pairingChallenge(
        offerId: try f.string("offerId", pattern: Patterns.keyId),
        macNonce: try f.string("macNonce", pattern: RelayProtocol.nonce)
      )
    case "pairing-result":
      let f = try Fields(value, path: type, required: ["type", "offerId", "sealed"])
      return .pairingResult(offerId: try f.string("offerId", pattern: Patterns.keyId), sealed: try Sealed.parse(try f.raw("sealed"), "sealed"))
    case "relay-locked":
      let f = try Fields(value, path: type, required: ["type", "locked", "by"])
      return .relayLocked(locked: try f.bool("locked"), by: try f.oneOf("by", ["phone", "recovery", "mac"]))
    default:
      throw SchemaError("frame", "unknown type \(type)")
    }
  }
}

public enum PhoneToRelay: Equatable, Sendable {
  case hello(id: String, signature: String)
  case envelope(Envelope)
  case pushToken(String)
  /// The sealed pairing reply: the only frame a phone sends before a hello.
  case pairingReply(macId: String, offerId: String, sealed: Sealed)
  /// Stop forwarding remote traffic to my Mac (J7). Only the Mac lifts it.
  case relayLock

  public var text: String {
    switch self {
    case let .hello(id, signature):
      return JSON.serialize(.object([
        ("type", .string("hello")), ("role", .string("phone")), ("id", .string(id)), ("signature", .string(signature)),
      ]))
    case let .envelope(envelope):
      return JSON.serialize(.object([("type", .string("envelope")), ("envelope", envelope.json)]))
    case let .pushToken(token):
      return JSON.serialize(.object([("type", .string("push-token")), ("token", .string(token))]))
    case let .pairingReply(macId, offerId, sealed):
      return JSON.serialize(.object([
        ("type", .string("pairing-reply")), ("macId", .string(macId)), ("offerId", .string(offerId)), ("sealed", sealed.json),
      ]))
    case .relayLock:
      return JSON.serialize(.object([("type", .string("relay-lock"))]))
    }
  }

  /// `relayAuthPayload` in core: JSON.stringify of exactly nonce, relay, role, id, in that order.
  public static func helloPayload(id: String, nonce: String, relay: String) -> String {
    JSON.serialize(.object([
      ("nonce", .string(nonce)), ("relay", .string(relay)), ("role", .string("phone")), ("id", .string(id)),
    ]))
  }
}

// MARK: Messages inside envelopes

public enum MacAlertKind: String, Sendable, CaseIterable {
  case needsYou = "needs-you"
  case loginHandedOver = "login-handed-over"
  case breakerOpened = "breaker-opened"
  case repair
  case notify
  case storeRefused = "store-refused"
}

public enum CloseOutcome: String, Sendable, CaseIterable {
  case approved, declined, expired, withdrawn, refused
}

public struct Handoff: Equatable, Sendable {
  public let handoffId, adapterId, domain, kind: String
  public let expiresAt: Date
}

public enum MacToPhone: Equatable, Sendable {
  case approvalRequest(seq: Int, requestText: String)
  case approvalClosed(seq: Int, requestId: String, outcome: CloseOutcome, reason: String?, deviceId: String?)
  case alert(seq: Int, kind: MacAlertKind, title: String, body: String, at: Date)
  case ack(seq: Int, ackSeq: Int)
  case status(seq: Int, status: MacStatus)
  /// The Mac removed this phone: delete the keys and unpair.
  case unpaired(seq: Int)
  /// A login needs the person (J6).
  case handoff(seq: Int, handoff: Handoff)

  public var seq: Int {
    switch self {
    case let .approvalRequest(seq, _), let .approvalClosed(seq, _, _, _, _), let .alert(seq, _, _, _, _),
      let .ack(seq, _), let .status(seq, _), let .unpaired(seq), let .handoff(seq, _):
      return seq
    }
  }

  public static func parse(_ text: String) throws -> MacToPhone {
    let value = try JSON.parse(text)
    let type = try frameType(value, "message")
    switch type {
    case "approval-request":
      let f = try Fields(value, path: type, required: ["type", "seq", "requestText"])
      return .approvalRequest(seq: try f.int("seq", min: 1), requestText: try f.string("requestText", max: 64 * 1024))
    case "approval-closed":
      let f = try Fields(value, path: type, required: ["type", "seq", "requestId", "outcome"], optional: ["reason", "deviceId"])
      let outcome = CloseOutcome(rawValue: try f.oneOf("outcome", CloseOutcome.allCases.map(\.rawValue)))!
      let reason = try (f.has("reason") ? f.oneOf("reason", RelayProtocol.decisionRefusals) : nil)
      let deviceId = try (f.has("deviceId") ? f.nullableString("deviceId", pattern: Patterns.keyId) : nil)
      return .approvalClosed(
        seq: try f.int("seq", min: 1), requestId: try f.string("requestId", pattern: Patterns.requestId),
        outcome: outcome, reason: reason, deviceId: deviceId
      )
    case "alert":
      let f = try Fields(value, path: type, required: ["type", "seq", "kind", "title", "body", "at"])
      return .alert(
        seq: try f.int("seq", min: 1),
        kind: MacAlertKind(rawValue: try f.oneOf("kind", MacAlertKind.allCases.map(\.rawValue)))!,
        title: try f.display("title", max: 80),
        body: try f.display("body", max: 300),
        at: try f.dateTime("at")
      )
    case "ack":
      let f = try Fields(value, path: type, required: ["type", "seq", "ackSeq"])
      return .ack(seq: try f.int("seq", min: 1), ackSeq: try f.int("ackSeq", min: 1))
    case "status":
      return .status(seq: try Fields(value, path: type, required: ["type", "seq", "at", "safety", "sites", "agents", "devices", "recent"]).int("seq", min: 1),
                     status: try MacStatus.parse(value))
    case "unpaired":
      let f = try Fields(value, path: type, required: ["type", "seq", "at"])
      _ = try f.dateTime("at")
      return .unpaired(seq: try f.int("seq", min: 1))
    case "handoff":
      let f = try Fields(value, path: type, required: ["type", "seq", "handoffId", "adapterId", "domain", "kind", "expiresAt"])
      return .handoff(seq: try f.int("seq", min: 1), handoff: Handoff(
        handoffId: try f.string("handoffId", pattern: RelayProtocol.handoffId),
        adapterId: try f.string("adapterId", pattern: Patterns.adapterId),
        domain: try f.string("domain", pattern: "[a-z0-9.-]{1,253}"),
        kind: try f.oneOf("kind", ["code", "captcha", "other"]),
        expiresAt: try f.dateTime("expiresAt")
      ))
    default:
      throw SchemaError("message", "unknown type \(type)")
    }
  }
}

public enum PhoneCommand: Equatable, Sendable {
  case pauseRemote
  case lockdown
  case revokeClient(String)
  case revokeDevice(String)

  var json: JSONValue {
    switch self {
    case .pauseRemote: return .object([("kind", .string("pause-remote"))])
    case .lockdown: return .object([("kind", .string("lockdown"))])
    case let .revokeClient(id): return .object([("kind", .string("revoke-client")), ("clientId", .string(id))])
    case let .revokeDevice(id): return .object([("kind", .string("revoke-device")), ("deviceId", .string(id))])
    }
  }

  public static func parse(_ value: JSONValue, _ path: String) throws -> PhoneCommand {
    guard let kind = value.object?.first(where: { $0.0 == "kind" })?.1.string else { throw SchemaError(path, "no kind") }
    switch kind {
    case "pause-remote": _ = try Fields(value, path: path, required: ["kind"]); return .pauseRemote
    case "lockdown": _ = try Fields(value, path: path, required: ["kind"]); return .lockdown
    case "revoke-client":
      let f = try Fields(value, path: path, required: ["kind", "clientId"])
      return .revokeClient(try f.string("clientId", pattern: Patterns.clientId))
    case "revoke-device":
      let f = try Fields(value, path: path, required: ["kind", "deviceId"])
      return .revokeDevice(try f.string("deviceId", pattern: Patterns.keyId))
    default: throw SchemaError(path, "unknown command")
    }
  }
}

/// What a phone may ask the Mac to start (`PHONE_ASKS`). The Mac builds the request; an ask
/// approves nothing.
public struct PhoneAsk: Equatable, Sendable {
  public static let actions = ["tool.enable", "tool.remote-enable", "setting.adapter-choice", "setting.loosen", "adapter.rollback"]
  public let action: String
  public let adapterId: String?
  public let tool: String?
  public let setting: String?
  public let value: String?

  public init(action: String, adapterId: String? = nil, tool: String? = nil, setting: String? = nil, value: String? = nil) {
    self.action = action
    self.adapterId = adapterId
    self.tool = tool
    self.setting = setting
    self.value = value
  }
}

public enum PhoneToMac: Equatable, Sendable {
  case approvalDecision(seq: Int, decision: SignedText)
  case approvalDecline(seq: Int, requestId: String, note: String?, stopAsking: Bool)
  case ask(seq: Int, ask: PhoneAsk)
  case loginCode(seq: Int, handoffId: String, code: String)
  case command(seq: Int, command: PhoneCommand)
  case ack(seq: Int, ackSeq: Int)

  public var seq: Int {
    switch self {
    case let .approvalDecision(seq, _), let .approvalDecline(seq, _, _, _), let .ask(seq, _), let .loginCode(seq, _, _),
      let .command(seq, _), let .ack(seq, _):
      return seq
    }
  }

  public var text: String {
    let n = { (v: Int) in JSONValue.number(String(v)) }
    switch self {
    case let .approvalDecision(seq, decision):
      return JSON.serialize(.object([("type", .string("approval-decision")), ("seq", n(seq)), ("decision", decision.json)]))
    case let .approvalDecline(seq, requestId, note, stopAsking):
      var entries: [(String, JSONValue)] = [("type", .string("approval-decline")), ("seq", n(seq)), ("requestId", .string(requestId))]
      if let note { entries.append(("note", .string(note))) }
      if stopAsking { entries.append(("stopAsking", .bool(true))) }
      return JSON.serialize(.object(entries))
    case let .ask(seq, ask):
      var entries: [(String, JSONValue)] = [("type", .string("ask")), ("seq", n(seq)), ("action", .string(ask.action))]
      if let v = ask.adapterId { entries.append(("adapterId", .string(v))) }
      if let v = ask.tool { entries.append(("tool", .string(v))) }
      if let v = ask.setting { entries.append(("setting", .string(v))) }
      if let v = ask.value { entries.append(("value", .string(v))) }
      return JSON.serialize(.object(entries))
    case let .loginCode(seq, handoffId, code):
      return JSON.serialize(.object([
        ("type", .string("login-code")), ("seq", n(seq)), ("handoffId", .string(handoffId)), ("code", .string(code)),
      ]))
    case let .command(seq, command):
      return JSON.serialize(.object([("type", .string("command")), ("seq", n(seq)), ("command", command.json)]))
    case let .ack(seq, ackSeq):
      return JSON.serialize(.object([("type", .string("ack")), ("seq", n(seq)), ("ackSeq", n(ackSeq))]))
    }
  }

  /// The Mac's reading, used by the fake Mac (the real one uses `parsePhoneToMac` in core).
  public static func parse(_ text: String, macId: String) throws -> PhoneToMac {
    let value = try JSON.parse(text)
    let type = try frameType(value, "message")
    switch type {
    case "approval-decision":
      let f = try Fields(value, path: type, required: ["type", "seq", "decision"])
      return .approvalDecision(seq: try f.int("seq", min: 1), decision: try SignedText.parse(try f.raw("decision"), "decision"))
    case "approval-decline":
      let f = try Fields(value, path: type, required: ["type", "seq", "requestId"], optional: ["note", "stopAsking"])
      let note = try (f.has("note") ? f.display("note", max: 280) : nil)
      let stop = try (f.has("stopAsking") ? f.bool("stopAsking") : false)
      return .approvalDecline(seq: try f.int("seq", min: 1), requestId: try f.string("requestId", pattern: Patterns.requestId), note: note, stopAsking: stop)
    case "ask":
      let f = try Fields(value, path: type, required: ["type", "seq", "action"], optional: ["adapterId", "tool", "setting", "value"])
      return .ask(seq: try f.int("seq", min: 1), ask: PhoneAsk(
        action: try f.oneOf("action", PhoneAsk.actions),
        adapterId: try f.optionalString("adapterId", pattern: Patterns.adapterId),
        tool: try f.optionalString("tool", pattern: Patterns.name),
        setting: try f.optionalString("setting", pattern: Patterns.name),
        value: try f.optionalString("value", max: 200)
      ))
    case "login-code":
      let f = try Fields(value, path: type, required: ["type", "seq", "handoffId", "code"])
      return .loginCode(
        seq: try f.int("seq", min: 1), handoffId: try f.string("handoffId", pattern: RelayProtocol.handoffId),
        code: try f.string("code", pattern: "[A-Za-z0-9-]{4,12}")
      )
    case "command":
      let f = try Fields(value, path: type, required: ["type", "seq", "command"])
      let command = try PhoneCommand.parse(try f.raw("command"), "command.command")
      if case let .revokeDevice(id) = command, id == macId { throw SchemaError("command", "the Mac can't be revoked") }
      return .command(seq: try f.int("seq", min: 1), command: command)
    case "ack":
      let f = try Fields(value, path: type, required: ["type", "seq", "ackSeq"])
      return .ack(seq: try f.int("seq", min: 1), ackSeq: try f.int("ackSeq", min: 1))
    default: throw SchemaError("message", "unknown type \(type)")
    }
  }
}

/// `seqVerdict` in core.
public enum SeqVerdict: Equatable, Sendable {
  case accept, duplicate, gap

  public static func of(last: Int, seq: Int) -> SeqVerdict {
    if seq == last + 1 { return .accept }
    return seq <= last ? .duplicate : .gap
  }
}

// MARK: Devices and pairing

public struct DeviceRecord: Equatable, Sendable {
  public let deviceId, macId, role, platform, name: String
  public let approvalKey, transportKey, agreementKey: String
  public let pairedAt: Date

  /// The record's shape (`deviceRecordSchema`). The key-derived refinements are checked by
  /// ValetCrypto, which can compute keyId.
  public static func parse(_ text: String) throws -> DeviceRecord {
    let f = try Fields(try JSON.parse(text), path: "record", required: [
      "v", "deviceId", "macId", "role", "platform", "name", "approvalKey", "transportKey", "agreementKey", "pairedAt",
    ])
    try f.literal("v", 1)
    let record = DeviceRecord(
      deviceId: try f.string("deviceId", pattern: Patterns.keyId),
      macId: try f.string("macId", pattern: Patterns.keyId),
      role: try f.oneOf("role", ["mac", "phone"]),
      platform: try f.oneOf("platform", ["macos", "ios"]),
      name: try f.display("name", max: 60),
      approvalKey: try f.string("approvalKey", pattern: Patterns.base64url, max: 200),
      transportKey: try f.string("transportKey", pattern: Patterns.base64url, max: 200),
      agreementKey: try f.string("agreementKey", pattern: Patterns.base64url, max: 200),
      pairedAt: try f.dateTime("pairedAt")
    )
    if (record.role == "mac") != (record.deviceId == record.macId) {
      throw SchemaError("record", "only the Mac record names itself")
    }
    if record.approvalKey == record.transportKey || record.approvalKey == record.agreementKey {
      throw SchemaError("record", "keys must differ")
    }
    return record
  }
}

public struct PairingOffer: Equatable, Sendable {
  public static let prefix = "valet-pair:"
  public static let ttl: TimeInterval = 5 * 60
  public let text: String
  public let macId, macApprovalKey, macAgreementKey, relay, secret: String
  public let expiresAt: Date

  /// The QR's contents: `valet-pair:` and the base64url of the offer's JSON text.
  public static func parse(qr: String) throws -> PairingOffer {
    guard qr.hasPrefix(prefix), let data = Base64URL.decode(String(qr.dropFirst(prefix.count))),
      let text = String(data: data, encoding: .utf8)
    else { throw SchemaError("offer", "not a Valet pairing code") }
    return try parse(text: text)
  }

  public static func parse(text: String) throws -> PairingOffer {
    let f = try Fields(try JSON.parse(text), path: "offer", required: [
      "v", "macId", "macApprovalKey", "macAgreementKey", "relay", "secret", "expiresAt",
    ])
    try f.literal("v", 1)
    return PairingOffer(
      text: text,
      macId: try f.string("macId", pattern: Patterns.keyId),
      macApprovalKey: try f.string("macApprovalKey", pattern: Patterns.base64url, max: 200),
      macAgreementKey: try f.string("macAgreementKey", pattern: Patterns.base64url, max: 200),
      relay: try f.httpsURL("relay"),
      secret: try f.string("secret", pattern: "[A-Za-z0-9_-]{43}"),
      expiresAt: try f.dateTime("expiresAt")
    )
  }
}

/// What the phone sends, sealed (`pairingReplySchema`).
public struct PairingReply: Equatable, Sendable {
  public let deviceName, approvalKey, transportKey, agreementKey: String

  public init(deviceName: String, approvalKey: String, transportKey: String, agreementKey: String) {
    self.deviceName = deviceName
    self.approvalKey = approvalKey
    self.transportKey = transportKey
    self.agreementKey = agreementKey
  }

  public var text: String {
    JSON.serialize(.object([
      ("v", .number("1")), ("deviceName", .string(deviceName)), ("platform", .string("ios")),
      ("approvalKey", .string(approvalKey)), ("transportKey", .string(transportKey)), ("agreementKey", .string(agreementKey)),
    ]))
  }

  public static func parse(_ text: String) throws -> PairingReply {
    let f = try Fields(try JSON.parse(text), path: "reply", required: [
      "v", "deviceName", "platform", "approvalKey", "transportKey", "agreementKey",
    ])
    try f.literal("v", 1)
    try f.literal("platform", "ios")
    return PairingReply(
      deviceName: try f.display("deviceName", max: 60),
      approvalKey: try f.string("approvalKey", pattern: Patterns.base64url, max: 200),
      transportKey: try f.string("transportKey", pattern: Patterns.base64url, max: 200),
      agreementKey: try f.string("agreementKey", pattern: Patterns.base64url, max: 200)
    )
  }
}

/// What the Mac sends back, sealed (`pairingResultSchema`).
public enum PairingResult: Equatable, Sendable {
  case paired(deviceRecord: SignedText, macRecord: SignedText)
  case declined, expired, tooManyAttempts

  public static func parse(_ text: String) throws -> PairingResult {
    let value = try JSON.parse(text)
    guard let outcome = value.object?.first(where: { $0.0 == "outcome" })?.1.string else { throw SchemaError("result", "no outcome") }
    switch outcome {
    case "paired":
      let f = try Fields(value, path: "result", required: ["outcome", "deviceRecord", "macRecord"])
      return .paired(
        deviceRecord: try SignedText.parse(try f.raw("deviceRecord"), "deviceRecord"),
        macRecord: try SignedText.parse(try f.raw("macRecord"), "macRecord")
      )
    case "declined", "expired", "too-many-attempts":
      _ = try Fields(value, path: "result", required: ["outcome"])
      return outcome == "declined" ? .declined : outcome == "expired" ? .expired : .tooManyAttempts
    default: throw SchemaError("result", "unknown outcome")
    }
  }

  public var json: JSONValue {
    switch self {
    case let .paired(device, mac):
      return .object([("outcome", .string("paired")), ("deviceRecord", device.json), ("macRecord", mac.json)])
    case .declined: return .object([("outcome", .string("declined"))])
    case .expired: return .object([("outcome", .string("expired"))])
    case .tooManyAttempts: return .object([("outcome", .string("too-many-attempts"))])
    }
  }
}
