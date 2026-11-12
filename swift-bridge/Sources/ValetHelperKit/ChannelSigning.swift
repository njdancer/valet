// What valet-approver signs for the phone channel besides decisions (docs/phone-channel.md): the
// relay binding, the pairing challenge, and the two device records a pairing ends with. Each is
// checked here before any prompt, and the prompt's reason is written here, never by the caller.
//
// The transport key signs only relay sign-ins as this Mac (`relayAuthToSign`); the approval key
// signs only what `channelApprovalToSign` lets through, after Touch ID.

import Foundation

public let relayAuthDomain = "valet/relay-auth/v1"
public let relayBindingDomain = "valet/relay-binding/v1"
public let deviceRecordDomain = "valet/device-record/v1"
public let pairingChallengeDomain = "valet/pairing/v1 challenge"

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
  guard (1...2).contains(payloads.count), payloads.allSatisfy({ $0.utf8.count <= maxPayloadBytes }) else {
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
