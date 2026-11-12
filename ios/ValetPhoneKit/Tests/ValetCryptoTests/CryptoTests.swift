import CryptoKit
import XCTest

@testable import ValetCrypto
import ValetFakes
@testable import ValetProtocol

/// The vectors core wrote (packages/core/test/ios-interop.test.ts). If these fail, the phone and
/// the Mac disagree about a contract.
final class CoreVectorTests: XCTestCase {
  struct Vectors: Decodable {
    struct Request: Decodable { let kind: String; let text: String; let digest: String }
    struct Invalid: Decodable { let why: String; let text: String }
    struct Signed: Decodable { let payload: String; let signature: String }
    struct Record: Decodable { let signed: Signed; let deviceId: String }
    struct Hello: Decodable { let id: String; let nonce: String; let relay: String; let payload: String }
    struct Decision: Decodable {
      let macId, requestId, requestDigest, deviceId, decidedAt, payload: String
      let choice: String?
    }
    struct SealedValue: Decodable { let iv: String; let ct: String }
    struct Pairing: Decodable {
      let offerQr, offerId, reply, resultPlaintext, macNonce, code: String
      let sealedResult: SealedValue
      let challenge: Signed
    }
    struct Info: Decodable { let from, to, info: String }
    struct Display: Decodable { let value: String; let valid: Bool }
    let macId: String
    let macApprovalKey: String
    let requests: [Request]
    let invalidRequests: [Invalid]
    let deviceRecord: Record
    let hello: Hello
    let decision: Decision
    let pairing: Pairing
    let envelopeInfo: Info
    let displayText: [Display]
  }

  func vectors() throws -> Vectors {
    let url = try XCTUnwrap(Bundle.module.url(forResource: "core-vectors", withExtension: "json", subdirectory: "Vectors"))
    return try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
  }

  func testRequestsParseWithTheSameDigest() throws {
    let v = try vectors()
    XCTAssertEqual(Set(v.requests.map(\.kind)).count, ApprovalKind.allCases.count)
    for r in v.requests {
      let value = try JSON.parse(r.text)
      let request = try ApprovalRequest.parse(value)
      XCTAssertEqual(request.kind.rawValue, r.kind)
      XCTAssertEqual(Signing.digest(.approvalRequest, r.text), r.digest, r.kind)
      // The Swift serialiser writes exactly what canonicalJson wrote.
      XCTAssertEqual(JSON.canonical(value), r.text, r.kind)
    }
  }

  func testInvalidRequestsAreRefused() throws {
    for r in try vectors().invalidRequests {
      XCTAssertThrowsError(try ApprovalRequest.parse(try JSON.parse(r.text)), r.why)
    }
  }

  func testDeviceRecordVerifies() throws {
    let v = try vectors()
    let signed = SignedText(payload: v.deviceRecord.signed.payload, signature: v.deviceRecord.signed.signature)
    let record = try XCTUnwrap(Signing.verifyDeviceRecord(signed, macApprovalKey: v.macApprovalKey))
    XCTAssertEqual(record.deviceId, v.deviceRecord.deviceId)
    XCTAssertEqual(Signing.keyId(v.macApprovalKey), v.macId)
    // Any change to the payload breaks it.
    let tampered = SignedText(payload: signed.payload.replacingOccurrences(of: "iPhone", with: "iPhonf"), signature: signed.signature)
    XCTAssertNil(Signing.verifyDeviceRecord(tampered, macApprovalKey: v.macApprovalKey))
  }

  func testHelloAndDecisionPayloadsMatchCore() throws {
    let v = try vectors()
    XCTAssertEqual(PhoneToRelay.helloPayload(id: v.hello.id, nonce: v.hello.nonce, relay: v.hello.relay), v.hello.payload)
    let decision = ApprovalDecision(
      macId: v.decision.macId, requestId: v.decision.requestId, requestDigest: v.decision.requestDigest,
      deviceId: v.decision.deviceId, decidedAt: try XCTUnwrap(ISOTime.parse(v.decision.decidedAt)), choice: v.decision.choice
    )
    XCTAssertEqual(decision.payload, v.decision.payload)
  }

  func testPairingMatchesCore() throws {
    let p = try vectors().pairing
    let offer = try PairingOffer.parse(qr: p.offerQr)
    XCTAssertEqual(try PairingCrypto.offerId(offer), p.offerId)
    XCTAssertEqual(try PairingCrypto.code(offer: offer, replyPlaintext: p.reply, macNonce: try XCTUnwrap(Base64URL.decode(p.macNonce))), p.code)
    let sealed = Sealed(iv: p.sealedResult.iv, ct: p.sealedResult.ct)
    XCTAssertEqual(PairingCrypto.open(sealed, kind: "result", offer: offer), p.resultPlaintext)
    // The AAD binds the kind: a result can't be passed off as a reply.
    XCTAssertNil(PairingCrypto.open(sealed, kind: "reply", offer: offer))
    XCTAssertEqual(try PairingResult.parse(p.resultPlaintext), .declined)
    XCTAssertNoThrow(try PairingReply.parse(p.reply))
    // CR-11: the Mac's signed challenge verifies over this reply, and over no other.
    XCTAssertEqual(PairingCrypto.challengePayload(offerId: p.offerId, macNonce: p.macNonce, replyPlaintext: p.reply), p.challenge.payload)
    XCTAssertTrue(PairingCrypto.verifyChallenge(offer: offer, offerId: p.offerId, macNonce: p.macNonce, replyPlaintext: p.reply, signature: p.challenge.signature))
    XCTAssertFalse(PairingCrypto.verifyChallenge(offer: offer, offerId: p.offerId, macNonce: p.macNonce, replyPlaintext: p.reply + " ", signature: p.challenge.signature))
  }

  func testEnvelopeInfoMatchesCore() throws {
    let i = try vectors().envelopeInfo
    XCTAssertEqual(Hex.encode(try ChannelSeal.info(from: i.from, to: i.to)), i.info)
  }

  func testDisplayTextAgreesWithCore() throws {
    for c in try vectors().displayText {
      XCTAssertEqual(DisplayText.isValid(c.value), c.valid, "\(c.value.unicodeScalars.map { String($0.value, radix: 16) })")
    }
  }

  /// Signs a decision with Swift for the TypeScript side to check (VALET_IOS_SWIFT_OUT).
  func testWritesASwiftSignedDecisionForCore() async throws {
    let v = try vectors()
    let request = try XCTUnwrap(v.requests.first)
    let keys = SoftwareDeviceKeys()
    let decision = ApprovalDecision(
      macId: v.macId, requestId: try ApprovalRequest.parse(try JSON.parse(request.text)).id,
      requestDigest: Signing.digest(.approvalRequest, request.text), deviceId: keys.publicKeys.deviceId,
      decidedAt: Date()
    )
    let signature = try await keys.signApproval(Signing.input(.approvalDecision, decision.payload), reason: "test")
    let signed = SignedText(payload: decision.payload, signature: Base64URL.encode(signature))
    XCTAssertTrue(Signing.verify(publicKey: keys.publicKeys.approval, domain: .approvalDecision, payload: signed.payload, signature: signed.signature))
    XCTAssertFalse(Signing.verify(publicKey: keys.publicKeys.approval, domain: .approvalRequest, payload: signed.payload, signature: signed.signature))
    // And a sealed pairing reply for the vectors' offer, with the code the phone computes.
    let offer = try PairingOffer.parse(qr: v.pairing.offerQr)
    let reply = PairingReply(
      deviceName: "iPhone", approvalKey: keys.publicKeys.approval, transportKey: keys.publicKeys.transport,
      agreementKey: keys.publicKeys.agreement
    ).text
    let sealedReply = try PairingCrypto.seal(reply, kind: "reply", offer: offer)
    XCTAssertEqual(PairingCrypto.open(sealedReply, kind: "reply", offer: offer), reply)
    let code = try PairingCrypto.code(offer: offer, replyPlaintext: reply, macNonce: try XCTUnwrap(Base64URL.decode(v.pairing.macNonce)))
    guard let out = ProcessInfo.processInfo.environment["VALET_IOS_SWIFT_OUT"], !out.isEmpty else { return }
    let json = JSON.serialize(.object([
      ("macId", .string(v.macId)), ("phoneApprovalKey", .string(keys.publicKeys.approval)),
      ("phoneDeviceId", .string(keys.publicKeys.deviceId)), ("requestText", .string(request.text)), ("decision", signed.json),
      ("pairing", .object([("sealedReply", sealedReply.json), ("reply", .string(reply)), ("code", .string(code))])),
    ]))
    try Data(json.utf8).write(to: URL(fileURLWithPath: out))
  }
}

final class SealTests: XCTestCase {
  let macId = String(repeating: "ab", count: 16)
  let phoneId = String(repeating: "cd", count: 16)

  func testEnvelopeRoundTripAndAuthentication() throws {
    let mac = P256.KeyAgreement.PrivateKey()
    let phone = P256.KeyAgreement.PrivateKey()
    let other = P256.KeyAgreement.PrivateKey()
    let envelope = try ChannelSeal.seal("hello", from: macId, to: phoneId, senderKey: mac, recipientKey: phone.publicKey)
    XCTAssertEqual(envelope.enc.count, 87)
    XCTAssertNoThrow(try Envelope.parse(envelope.json, "e"))
    XCTAssertEqual(try ChannelSeal.open(envelope, me: phoneId, expectedSender: macId, myKey: phone, senderKey: mac.publicKey), "hello")
    // Sealed by someone else's key: auth mode refuses it.
    let forged = try ChannelSeal.seal("hello", from: macId, to: phoneId, senderKey: other, recipientKey: phone.publicKey)
    XCTAssertThrowsError(try ChannelSeal.open(forged, me: phoneId, expectedSender: macId, myKey: phone, senderKey: mac.publicKey))
    // Re-addressed: info binds the ids.
    let readdressed = Envelope(from: macId, to: macId, enc: envelope.enc, ct: envelope.ct)
    XCTAssertThrowsError(try ChannelSeal.open(readdressed, me: macId, expectedSender: macId, myKey: phone, senderKey: mac.publicKey))
    // A flipped ciphertext byte.
    var ct = Base64URL.decode(envelope.ct)!
    ct[0] ^= 1
    let flipped = Envelope(from: macId, to: phoneId, enc: envelope.enc, ct: Base64URL.encode(ct))
    XCTAssertThrowsError(try ChannelSeal.open(flipped, me: phoneId, expectedSender: macId, myKey: phone, senderKey: mac.publicKey))
    // From the wrong sender id.
    XCTAssertThrowsError(try ChannelSeal.open(envelope, me: phoneId, expectedSender: phoneId, myKey: phone, senderKey: mac.publicKey)) {
      XCTAssertEqual($0 as? SealError, .wrongParty)
    }
  }

  func offer(secret: Data = Data(repeating: 7, count: 32)) throws -> PairingOffer {
    let approval = P256.Signing.PrivateKey()
    let agreement = P256.KeyAgreement.PrivateKey()
    let spki = Signing.spki(approval.publicKey)
    let text = JSON.serialize(.object([
      ("v", .number("1")), ("macId", .string(Signing.keyId(spki)!)), ("macApprovalKey", .string(spki)),
      ("macAgreementKey", .string(Signing.spki(agreement.publicKey))), ("relay", .string("https://relay.valet.test")),
      ("secret", .string(Base64URL.encode(secret))), ("expiresAt", .string("2026-11-12T08:45:00.000Z")),
    ]))
    return try PairingOffer.parse(qr: PairingOffer.prefix + Base64URL.encode(Data(text.utf8)))
  }

  func testPairingSealAndCode() throws {
    let o = try offer()
    let sealed = try PairingCrypto.seal("{\"v\":1}", kind: "reply", offer: o)
    XCTAssertEqual(PairingCrypto.open(sealed, kind: "reply", offer: o), "{\"v\":1}")
    XCTAssertNil(PairingCrypto.open(sealed, kind: "reply", offer: try offer(secret: Data(repeating: 8, count: 32))))
    let nonce = Data(repeating: 1, count: 32)
    let code = try PairingCrypto.code(offer: o, replyPlaintext: "{\"v\":1}", macNonce: nonce)
    XCTAssertTrue(matches(code, "[0-9]{6}"))
    XCTAssertEqual(code, try PairingCrypto.code(offer: o, replyPlaintext: "{\"v\":1}", macNonce: nonce))
    XCTAssertNotEqual(code, try PairingCrypto.code(offer: o, replyPlaintext: "{\"v\":1}", macNonce: Data(repeating: 2, count: 32)))
    XCTAssertNotEqual(code, try PairingCrypto.code(offer: o, replyPlaintext: "{\"v\":2}", macNonce: nonce))
    XCTAssertThrowsError(try PairingCrypto.code(offer: o, replyPlaintext: "{}", macNonce: Data(repeating: 1, count: 31)))
  }

  func testOfferIsStrict() throws {
    XCTAssertThrowsError(try PairingOffer.parse(qr: "https://example.com"))
    XCTAssertThrowsError(try PairingOffer.parse(qr: PairingOffer.prefix + Base64URL.encode(Data("{\"v\":1}".utf8))))
    let o = try offer()
    let http = o.text.replacingOccurrences(of: "https://", with: "http://")
    XCTAssertThrowsError(try PairingOffer.parse(text: http))
  }

  func testSoftwareKeysReportPresenceFailure() async throws {
    let keys = SoftwareDeviceKeys()
    keys.presence = { _ in false }
    do {
      _ = try await keys.signApproval(Data("x".utf8), reason: "Approve")
      XCTFail("signed without presence")
    } catch {
      XCTAssertEqual(error as? KeyError, .userCancelled)
    }
    XCTAssertEqual(keys.reasons, ["Approve"])
    let restored = try SoftwareDeviceKeys(stored: keys.stored)
    XCTAssertEqual(restored.publicKeys, keys.publicKeys)
  }

  #if canImport(LocalAuthentication)
    /// Software keys can't show the Secure Enclave flags hold, so pin them here (review finding 16).
    func testApprovalKeyNeedsCurrentBiometrics() {
      XCTAssertTrue(KeyPolicy.approvalFlags.contains(.biometryCurrentSet))
      XCTAssertTrue(KeyPolicy.approvalFlags.contains(.privateKeyUsage))
      XCTAssertFalse(KeyPolicy.approvalFlags.contains(.userPresence))
      XCTAssertFalse(KeyPolicy.approvalFlags.contains(.devicePasscode))
      XCTAssertEqual(KeyPolicy.approvalAccessible, kSecAttrAccessibleWhenUnlockedThisDeviceOnly)
      XCTAssertFalse(KeyPolicy.transportFlags.contains(.userPresence))
      XCTAssertEqual(KeyPolicy.transportAccessible, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly)
    }
  #endif

  func testKeyIdMatchesCoreRule() {
    let key = P256.Signing.PrivateKey()
    let spki = Signing.spki(key.publicKey)
    let digest = Hex.encode(SHA256.hash(data: key.publicKey.derRepresentation))
    XCTAssertEqual(Signing.keyId(spki), String(digest.prefix(32)))
    XCTAssertEqual(Base64URL.decode(spki)?.count, 91)
  }
}
