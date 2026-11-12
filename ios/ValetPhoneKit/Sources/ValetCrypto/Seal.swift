// The end-to-end channel and the pairing seal (docs/ios-app.md, Pairing and The channel).
//
// Envelopes: RFC 9180 HPKE, DHKEM(P-256, HKDF-SHA256), HKDF-SHA256, AES-256-GCM, auth mode, one
// single-shot seal per envelope. `info` is the two key ids' 32 bytes, sender first.
//
// Pairing: the reply and the result are sealed with AES-256-GCM under a key derived from the QR's
// one-time secret, and the code both screens show is derived from the secret, the transcript and a
// nonce the Mac sends only after it accepted the reply.

import CryptoKit
import Foundation
import ValetProtocol

public enum SealError: Error, Equatable {
  case badEnvelope
  case wrongParty
  case openFailed
  case tooLarge
}

public enum ChannelSeal {
  /// `envelopeInfo`: the sender's then the recipient's key id, 16 bytes each.
  public static func info(from: String, to: String) throws -> Data {
    guard let a = Hex.decode(from), a.count == 16, let b = Hex.decode(to), b.count == 16 else {
      throw SealError.badEnvelope
    }
    return a + b
  }

  public static func seal(
    _ plaintext: String, from: String, to: String, senderKey: P256.KeyAgreement.PrivateKey,
    recipientKey: P256.KeyAgreement.PublicKey
  ) throws -> Envelope {
    var sender = try HPKE.Sender(
      recipientKey: recipientKey, ciphersuite: .P256_SHA256_AES_GCM_256, info: try info(from: from, to: to),
      authenticatedBy: senderKey
    )
    let ct = try sender.seal(Data(plaintext.utf8))
    return Envelope(from: from, to: to, enc: Base64URL.encode(sender.encapsulatedKey), ct: Base64URL.encode(ct))
  }

  /// Opens an envelope addressed to `me` from `expectedSender`, sealed by that sender's pinned key.
  public static func open(
    _ envelope: Envelope, me: String, expectedSender: String, myKey: P256.KeyAgreement.PrivateKey,
    senderKey: P256.KeyAgreement.PublicKey
  ) throws -> String {
    guard envelope.to == me, envelope.from == expectedSender else { throw SealError.wrongParty }
    guard let enc = Base64URL.decode(envelope.enc), enc.count == 65, let ct = Base64URL.decode(envelope.ct) else {
      throw SealError.badEnvelope
    }
    if ct.count > RelayProtocol.maxEnvelopeBytes { throw SealError.tooLarge }
    do {
      var recipient = try HPKE.Recipient(
        privateKey: myKey, ciphersuite: .P256_SHA256_AES_GCM_256, info: try info(from: envelope.from, to: envelope.to),
        encapsulatedKey: enc, authenticatedBy: senderKey
      )
      let plaintext = try recipient.open(ct)
      guard let text = String(data: plaintext, encoding: .utf8) else { throw SealError.openFailed }
      return text
    } catch {
      throw SealError.openFailed
    }
  }
}

/// `pairing.ts` in core: the offer id, the seal key, the sealed reply and result, and the code.
public enum PairingCrypto {
  /// `pairingChallengePayload` (CR-11): what the Mac signs when it accepts a reply, naming that reply
  /// by its hash, so a challenge for someone else's reply doesn't verify on this phone.
  public static func challengePayload(offerId: String, macNonce: String, replyPlaintext: String) -> String {
    JSON.serialize(.object([
      ("offerId", .string(offerId)), ("macNonce", .string(macNonce)),
      ("reply", .string(Hex.encode(SHA256.hash(data: Data(replyPlaintext.utf8))))),
    ]))
  }

  /// `verifyPairingChallenge`: signed by the QR's Mac approval key, over this phone's own reply.
  public static func verifyChallenge(offer: PairingOffer, offerId: String, macNonce: String, replyPlaintext: String, signature: String) -> Bool {
    Signing.verify(
      publicKey: offer.macApprovalKey, domain: .pairingChallenge,
      payload: challengePayload(offerId: offerId, macNonce: macNonce, replyPlaintext: replyPlaintext), signature: signature
    )
  }

  static let idInfo = "valet/pairing/v1 id"
  static let sealInfo = "valet/pairing/v1 seal"
  static let codeInfo = "valet/pairing/v1 sas"

  public static func secret(_ offer: PairingOffer) throws -> Data {
    guard let secret = Base64URL.decode(offer.secret), secret.count == 32 else { throw SealError.badEnvelope }
    return secret
  }

  /// `pairingOfferId`: the first 128 bits of SHA-256("valet/pairing/v1 id\n" || secret), hex.
  public static func offerId(_ offer: PairingOffer) throws -> String {
    let digest = SHA256.hash(data: Data("\(idInfo)\n".utf8) + (try secret(offer)))
    return String(Hex.encode(digest).prefix(32))
  }

  /// `pairingSealKey`: HKDF-SHA256 of the secret, salt the Mac's id as its ASCII text.
  static func sealKey(_ offer: PairingOffer) throws -> SymmetricKey {
    HKDF<SHA256>.deriveKey(
      inputKeyMaterial: SymmetricKey(data: try secret(offer)), salt: Data(offer.macId.utf8), info: Data(sealInfo.utf8),
      outputByteCount: 32
    )
  }

  /// `pairingAad`.
  public static func aad(_ kind: String, offerId: String) -> Data { Data("valet/pairing/v1 \(kind) \(offerId)".utf8) }

  public static func seal(_ plaintext: String, kind: String, offer: PairingOffer) throws -> Sealed {
    let box = try AES.GCM.seal(Data(plaintext.utf8), using: try sealKey(offer), authenticating: aad(kind, offerId: try offerId(offer)))
    return Sealed(iv: Base64URL.encode(Data(box.nonce)), ct: Base64URL.encode(box.ciphertext + box.tag))
  }

  /// `openSealed`: nil if the key, the bytes or the AAD are wrong.
  public static func open(_ sealed: Sealed, kind: String, offer: PairingOffer) -> String? {
    guard let iv = Base64URL.decode(sealed.iv), iv.count == 12, let data = Base64URL.decode(sealed.ct), data.count >= 17,
      let key = try? sealKey(offer), let id = try? offerId(offer),
      let nonce = try? AES.GCM.Nonce(data: iv),
      let box = try? AES.GCM.SealedBox(nonce: nonce, ciphertext: data.prefix(data.count - 16), tag: data.suffix(16)),
      let plaintext = try? AES.GCM.open(box, using: key, authenticating: aad(kind, offerId: id))
    else { return nil }
    return String(data: plaintext, encoding: .utf8)
  }

  /// `pairingCode`: six digits from the secret, the offer text, the reply and the Mac's nonce.
  public static func code(offer: PairingOffer, replyPlaintext: String, macNonce: Data) throws -> String {
    guard macNonce.count == 32 else { throw SealError.badEnvelope }
    var info = Data("\(codeInfo)\n".utf8)
    let offerBytes = Data(offer.text.utf8)
    let replyBytes = Data(replyPlaintext.utf8)
    info += Data("\(offerBytes.count):".utf8) + offerBytes
    info += Data("\(replyBytes.count):".utf8) + replyBytes
    info += macNonce
    let key = HKDF<SHA256>.deriveKey(
      inputKeyMaterial: SymmetricKey(data: try secret(offer)), salt: Data(offer.macId.utf8), info: info, outputByteCount: 4
    )
    let bytes = key.withUnsafeBytes { Data($0) }
    let value = bytes.reduce(UInt32(0)) { $0 << 8 | UInt32($1) }
    return String(format: "%06u", value % 1_000_000)
  }
}
