// A port of packages/core/src/roster.ts: the account's device list, a hash-chained list of signed
// changes (docs/relay-hub.md, step 4). Each change is signed by the approval key of a device
// already on the list, so the hub stores and hands it out but can't add a device by itself. The
// phone checks the whole chain itself before it trusts any device on it, and only signs a change
// on top of a chain that checked.

import CryptoKit
import Foundation
import ValetProtocol

public struct RosterDevice: Equatable, Sendable {
  public let deviceId, role, platform, name: String
  public let approvalKey, transportKey, agreementKey: String

  public init(
    deviceId: String, role: String, platform: String, name: String, approvalKey: String, transportKey: String,
    agreementKey: String
  ) {
    self.deviceId = deviceId
    self.role = role
    self.platform = platform
    self.name = name
    self.approvalKey = approvalKey
    self.transportKey = transportKey
    self.agreementKey = agreementKey
  }

  /// This phone, as it adds itself to a list it starts or is added by a Mac.
  public init(keys: DevicePublicKeys, name: String) {
    self.init(
      deviceId: keys.deviceId, role: "phone", platform: "ios", name: name, approvalKey: keys.approval,
      transportKey: keys.transport, agreementKey: keys.agreement
    )
  }

  /// In `rosterDeviceSchema`'s key order, which is what JSON.stringify writes in core.
  public var json: JSONValue {
    .object([
      ("deviceId", .string(deviceId)), ("role", .string(role)), ("platform", .string(platform)),
      ("name", .string(name)), ("approvalKey", .string(approvalKey)), ("transportKey", .string(transportKey)),
      ("agreementKey", .string(agreementKey)),
    ])
  }

  /// `rosterDeviceSchema`: the shape, valid P-256 keys, and the id is its approval key's.
  static func parse(_ value: JSONValue, _ path: String) throws -> RosterDevice {
    let f = try Fields(value, path: path, required: [
      "deviceId", "role", "platform", "name", "approvalKey", "transportKey", "agreementKey",
    ])
    let device = RosterDevice(
      deviceId: try f.string("deviceId", pattern: Patterns.keyId),
      role: try f.oneOf("role", ["mac", "phone"]),
      platform: try f.oneOf("platform", ["macos", "ios"]),
      name: try f.display("name", max: 60),
      approvalKey: try Roster.publicKey(f, "approvalKey"),
      transportKey: try Roster.publicKey(f, "transportKey"),
      agreementKey: try Roster.publicKey(f, "agreementKey")
    )
    guard Signing.keyId(device.approvalKey) == device.deviceId else {
      throw SchemaError(path, "deviceId must be keyId(approvalKey)")
    }
    guard device.approvalKey != device.transportKey, device.approvalKey != device.agreementKey else {
      throw SchemaError(path, "keys must differ")
    }
    return device
  }
}

public enum RosterOp: Equatable, Sendable {
  case add(RosterDevice)
  case remove(String)

  var json: JSONValue {
    switch self {
    case let .add(device): return .object([("op", .string("add")), ("device", device.json)])
    case let .remove(deviceId): return .object([("op", .string("remove")), ("deviceId", .string(deviceId))])
    }
  }
}

public struct RosterChange: Equatable, Sendable {
  public let account: String
  public let seq: Int
  public let prev: String?
  public let at: String
  public let by: String
  public let change: RosterOp

  /// `rosterChangeSchema`, strict.
  public static func parse(_ text: String) throws -> RosterChange {
    let f = try Fields(try JSON.parse(text), path: "change", required: ["v", "account", "seq", "prev", "at", "by", "change"])
    try f.literal("v", 1)
    let at = try f.string("at", pattern: Patterns.isoDateTime)
    guard ISOTime.parse(at) != nil else { throw SchemaError("change.at", "not an ISO date-time") }
    let op = try f.raw("change")
    let opFields = try Fields(op, path: "change.change", required: ["op"], optional: ["device", "deviceId"])
    let change: RosterOp
    switch try opFields.oneOf("op", ["add", "remove"]) {
    case "add":
      let add = try Fields(op, path: "change.change", required: ["op", "device"])
      change = .add(try RosterDevice.parse(try add.raw("device"), "change.change.device"))
    default:
      let remove = try Fields(op, path: "change.change", required: ["op", "deviceId"])
      change = .remove(try remove.string("deviceId", pattern: Patterns.keyId))
    }
    return RosterChange(
      account: try f.string("account", pattern: Patterns.accountId),
      seq: try f.int("seq", min: 0, max: Roster.maxChanges),
      prev: try f.nullableString("prev", pattern: Patterns.hash),
      at: at,
      by: try f.string("by", pattern: Patterns.keyId),
      change: change
    )
  }
}

public struct Roster: Equatable, Sendable {
  /// Devices an account may have at once.
  public static let maxDevices = 32
  /// Changes a chain may hold.
  public static let maxChanges = 512
  /// `signedRosterChangeSchema` and `signedJoinRecordSchema`'s payload limit.
  public static let maxPayload = 4096

  public let account: String
  /// rosterChangeHash of the first change.
  public let genesis: String
  /// rosterChangeHash of the last change: what the next change names as `prev`.
  public let head: String
  public let seq: Int
  public let devices: [String: RosterDevice]
  /// The devices' ids in the order they were added, for a stable list on screen.
  public let order: [String]

  public enum Failure: String, Error, Sendable {
    case empty, tooLong = "too-long", malformed, badSignature = "bad-signature", notAMember = "not-a-member"
    case brokenChain = "broken-chain", wrongGenesis = "wrong-genesis", wrongAccount = "wrong-account"
    case duplicate, unknownDevice = "unknown-device", lastDevice = "last-device"
    case tooManyDevices = "too-many-devices", stale
  }

  public struct CheckError: Error, Equatable, Sendable {
    /// Index of the first change that failed, or -1 for the chain as a whole.
    public let at: Int
    public let reason: Failure
  }

  /// SHA-256 hex of the signed payload text.
  public static func hash(_ signed: SignedText) -> String {
    Hex.encode(SHA256.hash(data: Data(signed.payload.utf8)))
  }

  static func publicKey(_ f: Fields, _ key: String) throws -> String {
    let value = try f.string(key, pattern: Patterns.base64url, max: 200)
    guard Signing.signingKey(value) != nil else { throw SchemaError("\(f.path).\(key)", "not a P-256 public key") }
    return value
  }

  /// `verifyRoster`: the whole chain from its first change. `pinned` is a genesis the phone
  /// pinned; `known` a head it saw before, which must still be in the chain.
  public static func verify(
    _ chain: [SignedText], pinned: String? = nil, known: (seq: Int, head: String)? = nil
  ) -> Result<Roster, CheckError> {
    if chain.isEmpty { return .failure(CheckError(at: -1, reason: .empty)) }
    if chain.count > maxChanges { return .failure(CheckError(at: -1, reason: .tooLong)) }
    var devices: [String: RosterDevice] = [:]
    var order: [String] = []
    var account = ""
    var genesis = ""
    var head = ""
    for (index, signed) in chain.enumerated() {
      func fail(_ reason: Failure) -> Result<Roster, CheckError> { .failure(CheckError(at: index, reason: reason)) }
      guard signed.payload.utf16.count >= 2, signed.payload.utf16.count <= maxPayload,
        matches(signed.signature, Patterns.base64url), Base64URL.decode(signed.signature)?.count == 64,
        let change = try? RosterChange.parse(signed.payload)
      else { return fail(.malformed) }
      if change.seq != index { return fail(.brokenChain) }
      let signer: RosterDevice?
      if index == 0 {
        // The first device adds itself: that is the account's root.
        guard change.prev == nil, case let .add(device) = change.change, device.deviceId == change.by else {
          return fail(.brokenChain)
        }
        account = change.account
        signer = device
      } else {
        if change.prev != head { return fail(.brokenChain) }
        if change.account != account { return fail(.wrongAccount) }
        signer = devices[change.by]
      }
      guard let signer else { return fail(.notAMember) }
      guard Signing.verify(publicKey: signer.approvalKey, domain: .rosterChange, payload: signed.payload, signature: signed.signature)
      else { return fail(.badSignature) }
      switch change.change {
      case let .add(device):
        if devices[device.deviceId] != nil { return fail(.duplicate) }
        if devices.count >= maxDevices { return fail(.tooManyDevices) }
        devices[device.deviceId] = device
        order.append(device.deviceId)
      case let .remove(deviceId):
        if devices[deviceId] == nil { return fail(.unknownDevice) }
        // Never the last one: an account with no devices could only be refilled by the hub.
        if devices.count == 1 { return fail(.lastDevice) }
        devices[deviceId] = nil
        order.removeAll { $0 == deviceId }
      }
      head = hash(signed)
      if index == 0 { genesis = head }
      if let known, index == known.seq, head != known.head { return fail(.brokenChain) }
    }
    if let pinned, pinned != genesis { return .failure(CheckError(at: 0, reason: .wrongGenesis)) }
    if let known, chain.count - 1 < known.seq { return .failure(CheckError(at: -1, reason: .stale)) }
    return .success(Roster(account: account, genesis: genesis, head: head, seq: chain.count - 1, devices: devices, order: order))
  }

  /// `nextRosterChange`: the payload of the change after `roster` (or the first, with nil), for
  /// this device to sign with its approval key over the roster-change domain.
  public static func next(_ roster: Roster?, account: String, by: String, change: RosterOp, at: Date) -> String {
    let prev: JSONValue = roster.map { .string($0.head) } ?? .null
    return JSON.serialize(.object([
      ("v", .number("1")), ("account", .string(roster?.account ?? account)),
      ("seq", .number(String(roster.map { $0.seq + 1 } ?? 0))), ("prev", prev),
      ("at", .string(ISOTime.format(at))), ("by", .string(by)), ("change", change.json),
    ]))
  }

  /// `joinRecordDevice`: the Mac a join record asks to add, or nil if it isn't a Mac's own device
  /// record signed by its own approval key. `macId`, when given, is the Mac the hub says asked.
  public static func joinDevice(_ signed: SignedText, macId: String? = nil) -> RosterDevice? {
    guard signed.payload.utf16.count >= 2, signed.payload.utf16.count <= maxPayload,
      matches(signed.signature, Patterns.base64url), Base64URL.decode(signed.signature)?.count == 64,
      let record = try? DeviceRecord.parse(signed.payload),
      record.role == "mac", record.platform == "macos", record.macId == record.deviceId,
      macId == nil || record.deviceId == macId,
      Signing.keyId(record.approvalKey) == record.deviceId,
      Signing.signingKey(record.approvalKey) != nil, Signing.signingKey(record.transportKey) != nil,
      Signing.agreementKey(record.agreementKey) != nil,
      Signing.verify(publicKey: record.approvalKey, domain: .deviceRecord, payload: signed.payload, signature: signed.signature)
    else { return nil }
    return RosterDevice(
      deviceId: record.deviceId, role: "mac", platform: "macos", name: record.name, approvalKey: record.approvalKey,
      transportKey: record.transportKey, agreementKey: record.agreementKey
    )
  }
}
