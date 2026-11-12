// A port of packages/core/src/signing.ts. Keys travel as base64url SPKI DER (CryptoKit's
// `derRepresentation`), signatures as base64url raw r||s (`rawRepresentation`). Every signature is
// over `<domain>\n<payload>`, and whoever signs sends the exact payload text.

import CryptoKit
import Foundation
import ValetProtocol

public enum SigningDomain: String, Sendable {
  case approvalRequest = "valet/approval-request/v1"
  case approvalDecision = "valet/approval-decision/v1"
  case deviceRecord = "valet/device-record/v1"
  case relayAuth = "valet/relay-auth/v1"
  case pairing = "valet/pairing/v1"
}

public enum Signing {
  static let spkiLength = 91

  public static func input(_ domain: SigningDomain, _ payload: String) -> Data {
    Data("\(domain.rawValue)\n\(payload)".utf8)
  }

  /// SHA-256 hex of a payload under its domain: what a decision names its request by.
  public static func digest(_ domain: SigningDomain, _ payload: String) -> String {
    Hex.encode(SHA256.hash(data: input(domain, payload)))
  }

  /// First 128 bits of the SHA-256 of the key's DER, hex. Nil if `spki` isn't base64url.
  public static func keyId(_ spki: String) -> String? {
    guard let der = Base64URL.decode(spki) else { return nil }
    return String(Hex.encode(SHA256.hash(data: der)).prefix(32))
  }

  public static func signingKey(_ spki: String) -> P256.Signing.PublicKey? {
    guard let der = Base64URL.decode(spki), der.count == spkiLength else { return nil }
    return try? P256.Signing.PublicKey(derRepresentation: der)
  }

  public static func agreementKey(_ spki: String) -> P256.KeyAgreement.PublicKey? {
    guard let der = Base64URL.decode(spki), der.count == spkiLength else { return nil }
    return try? P256.KeyAgreement.PublicKey(derRepresentation: der)
  }

  public static func spki(_ key: P256.Signing.PublicKey) -> String { Base64URL.encode(key.derRepresentation) }
  public static func spki(_ key: P256.KeyAgreement.PublicKey) -> String { Base64URL.encode(key.derRepresentation) }

  /// True only for a valid signature by this key over this domain and payload. Never throws.
  public static func verify(publicKey: String, domain: SigningDomain, payload: String, signature: String) -> Bool {
    guard let key = signingKey(publicKey), let raw = Base64URL.decode(signature), raw.count == 64,
      let sig = try? P256.Signing.ECDSASignature(rawRepresentation: raw)
    else { return false }
    return key.isValidSignature(sig, for: input(domain, payload))
  }

  /// `verifyDeviceRecord` in core: the signature, then the shape, then that it names this Mac and
  /// that its id is its approval key's.
  public static func verifyDeviceRecord(_ signed: SignedText, macApprovalKey: String) -> DeviceRecord? {
    guard verify(publicKey: macApprovalKey, domain: .deviceRecord, payload: signed.payload, signature: signed.signature),
      let record = try? DeviceRecord.parse(signed.payload),
      record.macId == keyId(macApprovalKey),
      keyId(record.approvalKey) == record.deviceId,
      signingKey(record.approvalKey) != nil, signingKey(record.transportKey) != nil,
      agreementKey(record.agreementKey) != nil
    else { return nil }
    return record
  }
}
