// What valet-approver signs for the phone channel besides decisions (docs/phone-channel.md): the
// relay binding, the pairing challenge, and the two device records a pairing ends with. Each is
// checked here before any prompt, and the prompt's reason is written here, never by the caller.
//
// The transport key signs only relay sign-ins as this Mac (`relayAuthToSign`); the approval key
// signs only what `channelApprovalToSign` lets through, after Touch ID.

import CryptoKit
import Foundation

public let relayAuthDomain = "valet/relay-auth/v1"
public let relayBindingDomain = "valet/relay-binding/v1"
public let deviceRecordDomain = "valet/device-record/v1"
public let pairingChallengeDomain = "valet/pairing/v1 challenge"
public let rosterChangeDomain = "valet/roster-change/v1"
public let hubGrantDomain = "valet/hub-grant/v1"

/// Changes to the account's device list signed at once: the first one (this Mac adding itself)
/// plus the phones it already paired, so joining needs one Touch ID prompt.
let maxRosterChanges = 9

public struct ChannelApprovalToSign: Equatable {
  /// One input per payload: the domain, a newline, the payload.
  public let inputs: [Data]
  /// The OS prompt's reason, after "Valet is trying to".
  public let reason: String
}

/// This Mac's own public keys, base64url SPKI DER, and its id (keyId of the approval key).
public struct OwnKeys: Equatable {
  public let macId: String
  public let approvalKey: String
  public let transportKey: String
  public let agreementKey: String

  public init(macId: String, approvalKey: String, transportKey: String, agreementKey: String) {
    self.macId = macId
    self.approvalKey = approvalKey
    self.transportKey = transportKey
    self.agreementKey = agreementKey
  }
}

let maxPayloadBytes = 8192

/// Nil unless every payload is something the phone channel has the approval key sign.
public func channelApprovalToSign(domain: String, payloads: [String], own: OwnKeys) -> ChannelApprovalToSign? {
  let most = domain == rosterChangeDomain ? maxRosterChanges : 2
  guard (1...most).contains(payloads.count), payloads.allSatisfy({ $0.utf8.count <= maxPayloadBytes }) else {
    return nil
  }
  let reason: String
  switch domain {
  case relayBindingDomain:
    // Once per transport key: the approval key vouching for this Mac's own transport key.
    guard payloads == [own.transportKey] else { return nil }
    reason = "connect to Valet's relay"
  case pairingChallengeDomain:
    guard payloads.count == 1, isPairingChallenge(payloads[0]) else { return nil }
    reason = "pair a new iPhone"
  case deviceRecordDomain:
    var phones = 0
    for payload in payloads {
      guard let role = deviceRecordRole(payload, own: own) else { return nil }
      if role == "phone" { phones += 1 }
    }
    guard phones <= 1 else { return nil }
    reason = phones == 1 ? "pair a new iPhone" : "update this Mac's device record"
  case rosterChangeDomain:
    guard let kinds = rosterChangeKinds(payloads, own: own) else { return nil }
    reason =
      kinds.contains(.start)
      ? "put this Mac and its iPhones on your Valet account"
      : kinds.contains(.remove) ? "remove a device from your Valet account" : "add an iPhone to your Valet account"
  case hubGrantDomain:
    guard payloads.count == 1, let host = hubGrantHost(payloads[0], own: own) else { return nil }
    reason = "let an agent at \(host) use your Valet tools through your Valet account"
  default:
    return nil
  }
  return ChannelApprovalToSign(inputs: payloads.map { Data("\(domain)\n\($0)".utf8) }, reason: reason)
}

/// `{"offerId","macNonce","reply"}`, as core's pairingChallengePayload writes it.
func isPairingChallenge(_ payload: String) -> Bool {
  guard let object = jsonObject(payload), Set(object.keys) == ["offerId", "macNonce", "reply"],
    let offerId = object["offerId"] as? String, isBase64url(offerId, max: 64),
    let nonce = object["macNonce"] as? String, isBase64url(nonce, max: 64),
    let reply = object["reply"] as? String, reply.utf8.count == 64,
    reply.utf8.allSatisfy({ ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x66) })
  else { return false }
  return true
}

/// The record's role if it is a device record for this Mac: its own (with its own keys), or a
/// phone's (any other id). Nil for anything else.
func deviceRecordRole(_ payload: String, own: OwnKeys) -> String? {
  let fields: Set<String> = [
    "v", "deviceId", "macId", "role", "platform", "name", "approvalKey", "transportKey", "agreementKey", "pairedAt",
  ]
  guard let object = jsonObject(payload), Set(object.keys) == fields, object["v"] as? Int == 1,
    object["macId"] as? String == own.macId,
    let deviceId = object["deviceId"] as? String, deviceId.utf8.count == 32,
    let role = object["role"] as? String, let platform = object["platform"] as? String,
    let name = object["name"] as? String, !name.isEmpty, name.utf8.count <= 240,
    object["approvalKey"] is String, object["transportKey"] is String, object["agreementKey"] is String,
    object["pairedAt"] is String
  else { return nil }
  switch (role, platform) {
  case ("mac", "macos"):
    guard deviceId == own.macId, object["approvalKey"] as? String == own.approvalKey,
      object["transportKey"] as? String == own.transportKey,
      object["agreementKey"] as? String == own.agreementKey
    else { return nil }
    return role
  case ("phone", "ios"):
    guard deviceId != own.macId, object["approvalKey"] as? String != own.approvalKey else { return nil }
    return role
  default:
    return nil
  }
}

enum RosterChangeKind { case start, addPhone, remove }

/// What each change does, if every payload is a change to the account's device list that this Mac
/// may sign (core's roster.ts): made by this Mac, numbered one after another, each naming the hash
/// of the one before it. This Mac only adds itself as the very first change, and otherwise adds
/// phones or removes other devices. Nil for anything else.
func rosterChangeKinds(_ payloads: [String], own: OwnKeys) -> [RosterChangeKind]? {
  var kinds: [RosterChangeKind] = []
  var account: String?
  var previous: (seq: Int, hash: String)?
  for payload in payloads {
    guard let object = jsonObject(payload),
      Set(object.keys) == ["v", "account", "seq", "prev", "at", "by", "change"], object["v"] as? Int == 1,
      object["by"] as? String == own.macId,
      let name = object["account"] as? String, isBase64url(name, max: 64), name.utf8.count >= 16,
      let seq = object["seq"] as? Int, seq >= 0, object["at"] is String,
      let change = object["change"] as? [String: Any], let op = change["op"] as? String
    else { return nil }
    if let account, account != name { return nil }
    account = name
    let prev = object["prev"] as? String
    if let previous {
      guard seq == previous.seq + 1, prev == previous.hash else { return nil }
    } else if seq == 0 {
      guard object["prev"] is NSNull else { return nil }
    } else {
      guard let prev, prev.utf8.count == 64, isLowerHex(prev) else { return nil }
    }
    switch op {
    case "add":
      guard Set(change.keys) == ["op", "device"], let device = change["device"] as? [String: Any],
        let role = rosterDeviceRole(device, own: own)
      else { return nil }
      if role == "mac" {
        // This Mac adds itself only as the account's first change.
        guard seq == 0 else { return nil }
        kinds.append(.start)
      } else {
        kinds.append(.addPhone)
      }
    case "remove":
      guard Set(change.keys) == ["op", "deviceId"], let id = change["deviceId"] as? String, id.utf8.count == 32,
        id != own.macId
      else { return nil }
      kinds.append(.remove)
    default:
      return nil
    }
    previous = (seq, SHA256.hash(data: Data(payload.utf8)).map { String(format: "%02x", $0) }.joined())
  }
  return kinds
}

/// "mac" for this Mac with its own keys, "phone" for an iPhone that isn't this Mac; nil otherwise.
func rosterDeviceRole(_ device: [String: Any], own: OwnKeys) -> String? {
  guard Set(device.keys) == ["deviceId", "role", "platform", "name", "approvalKey", "transportKey", "agreementKey"],
    let deviceId = device["deviceId"] as? String, deviceId.utf8.count == 32,
    let role = device["role"] as? String, let platform = device["platform"] as? String,
    let name = device["name"] as? String, !name.isEmpty, name.utf8.count <= 240,
    let approval = device["approvalKey"] as? String, device["transportKey"] is String,
    device["agreementKey"] is String
  else { return nil }
  switch (role, platform) {
  case ("mac", "macos"):
    guard deviceId == own.macId, approval == own.approvalKey,
      device["transportKey"] as? String == own.transportKey,
      device["agreementKey"] as? String == own.agreementKey
    else { return nil }
    return role
  case ("phone", "ios"):
    guard deviceId != own.macId, approval != own.approvalKey else { return nil }
    return role
  default:
    return nil
  }
}

/// The agent's host if the payload is a grant this Mac may sign (core's hub-grant.ts): in this
/// Mac's name, for the tools remote agents may use and nothing wider, for at most 90 days.
func hubGrantHost(_ payload: String, own: OwnKeys) -> String? {
  let fields: Set<String> = [
    "v", "account", "consentId", "clientId", "clientName", "host", "scope", "at", "expiresAt", "by",
  ]
  guard let object = jsonObject(payload), Set(object.keys) == fields, object["v"] as? Int == 1,
    object["by"] as? String == own.macId, object["scope"] as? String == "remote-tools",
    let account = object["account"] as? String, isBase64url(account, max: 64), account.utf8.count >= 16,
    let consent = object["consentId"] as? String, isBase64url(consent, max: 40), consent.utf8.count >= 10,
    let client = object["clientId"] as? String, client.hasPrefix("hc"), isBase64url(client, max: 42),
    client.utf8.count >= 12,
    let name = object["clientName"] as? String, !name.isEmpty, name.utf8.count <= 240,
    let host = object["host"] as? String, (1...253).contains(host.utf8.count),
    host.utf8.allSatisfy({ ($0 >= 0x61 && $0 <= 0x7A) || ($0 >= 0x30 && $0 <= 0x39) || $0 == 0x2E || $0 == 0x2D }),
    let at = object["at"] as? String, let expires = object["expiresAt"] as? String,
    let start = isoDate(at), let end = isoDate(expires),
    end > start, end.timeIntervalSince(start) <= 90 * 24 * 60 * 60
  else { return nil }
  return host
}

func isoDate(_ text: String) -> Date? {
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  if let date = formatter.date(from: text) { return date }
  formatter.formatOptions = [.withInternetDateTime]
  return formatter.date(from: text)
}

func isLowerHex(_ text: String) -> Bool {
  text.utf8.allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x66) }
}

/// The bytes the transport key signs: a relay sign-in as this Mac, and nothing else.
public func relayAuthToSign(payload: String, macId: String) -> Data? {
  guard payload.utf8.count <= 1024, let object = jsonObject(payload),
    Set(object.keys) == ["nonce", "relay", "role", "id"],
    object["role"] as? String == "mac", object["id"] as? String == macId,
    let nonce = object["nonce"] as? String, isBase64url(nonce, max: 128),
    let relay = object["relay"] as? String, relay.hasPrefix("https://"), relay.utf8.count <= 300
  else { return nil }
  return Data("\(relayAuthDomain)\n\(payload)".utf8)
}

func isBase64url(_ text: String, max: Int) -> Bool {
  (1...max).contains(text.utf8.count)
    && text.utf8.allSatisfy {
      ($0 >= 0x41 && $0 <= 0x5A) || ($0 >= 0x61 && $0 <= 0x7A) || ($0 >= 0x30 && $0 <= 0x39) || $0 == 0x2D
        || $0 == 0x5F
    }
}

/// base64url (padding optional) to bytes.
public func fromBase64url(_ text: String) -> Data? {
  var s = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
  while s.count % 4 != 0 { s += "=" }
  return Data(base64Encoded: s)
}
