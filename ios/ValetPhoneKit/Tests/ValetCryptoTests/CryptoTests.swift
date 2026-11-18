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
    struct Device: Decodable {
      let deviceId, role, platform, name, approvalKey, transportKey, agreementKey: String
      var device: RosterDevice {
        RosterDevice(
          deviceId: deviceId, role: role, platform: platform, name: name, approvalKey: approvalKey,
          transportKey: transportKey, agreementKey: agreementKey
        )
      }
    }
    struct Join: Decodable { let macId: String; let record: Signed; let device: Device }
    struct RosterSet: Decodable {
      let account, genesis, head: String
      let chain: [Signed]
      let devices: [String]
      let join: Join
    }
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
    let permissionAreas: [String]
    let roster: RosterSet
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
      if r.kind == "setting" {
        XCTAssertEqual(request.display.agentTests, RequestDisplay.AgentTests(passed: 3, failed: 1))
      }
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

  /// An install line in an area the phone doesn't know fails the whole card, so the lists match.
  func testPermissionAreasMatchCore() throws {
    XCTAssertEqual(PermissionChange.areas, try vectors().permissionAreas)
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

final class RosterTests: XCTestCase {
  func roster() throws -> CoreVectorTests.Vectors.RosterSet {
    let url = try XCTUnwrap(Bundle.module.url(forResource: "core-vectors", withExtension: "json", subdirectory: "Vectors"))
    return try JSONDecoder().decode(CoreVectorTests.Vectors.self, from: Data(contentsOf: url)).roster
  }

  func chain(_ r: CoreVectorTests.Vectors.RosterSet) -> [SignedText] {
    r.chain.map { SignedText(payload: $0.payload, signature: $0.signature) }
  }

  func failure(_ result: Result<Roster, Roster.CheckError>) -> Roster.CheckError? {
    if case let .failure(error) = result { return error }
    return nil
  }

  func testChecksTheListCoreSigned() throws {
    let r = try roster()
    let checked = try Roster.verify(chain(r), pinned: r.genesis).get()
    XCTAssertEqual(checked.account, r.account)
    XCTAssertEqual(checked.genesis, r.genesis)
    XCTAssertEqual(checked.head, r.head)
    XCTAssertEqual(checked.seq, 1)
    XCTAssertEqual(checked.order, r.devices)
    XCTAssertEqual(Set(checked.devices.keys), Set(r.devices))
    XCTAssertNoThrow(try Roster.verify(chain(r), known: (seq: 0, head: r.genesis)).get())
    XCTAssertNoThrow(try Roster.verify(chain(r), known: (seq: 1, head: r.head)).get())
  }

  func testRefusesListsThatDontCheck() throws {
    let r = try roster()
    let good = chain(r)
    XCTAssertEqual(failure(Roster.verify([])), Roster.CheckError(at: -1, reason: .empty))
    XCTAssertEqual(failure(Roster.verify(good, pinned: String(repeating: "0", count: 64))), Roster.CheckError(at: 0, reason: .wrongGenesis))
    XCTAssertEqual(
      failure(Roster.verify(good, known: (seq: 0, head: String(repeating: "0", count: 64)))),
      Roster.CheckError(at: 0, reason: .brokenChain)
    )
    XCTAssertEqual(failure(Roster.verify(good, known: (seq: 2, head: r.head))), Roster.CheckError(at: -1, reason: .stale))
    // A hub that drops the first change, or reorders them.
    XCTAssertEqual(failure(Roster.verify([good[1]])), Roster.CheckError(at: 0, reason: .brokenChain))
    XCTAssertEqual(failure(Roster.verify([good[1], good[0]])), Roster.CheckError(at: 0, reason: .brokenChain))
    // A changed payload, the phone's name here, no longer has the signature.
    let renamed = SignedText(payload: good[1].payload.replacingOccurrences(of: "\"iPhone\"", with: "\"iPhonf\""), signature: good[1].signature)
    XCTAssertNotEqual(renamed.payload, good[1].payload)
    XCTAssertEqual(failure(Roster.verify([good[0], renamed])), Roster.CheckError(at: 1, reason: .badSignature))
    // A change with a key core's strict schema wouldn't take.
    let extra = SignedText(payload: good[1].payload.replacingOccurrences(of: "{\"v\":1,", with: "{\"v\":1,\"x\":1,"), signature: good[1].signature)
    XCTAssertEqual(failure(Roster.verify([good[0], extra])), Roster.CheckError(at: 1, reason: .malformed))
    // The same change twice.
    XCTAssertEqual(failure(Roster.verify([good[0], good[1], good[1]])), Roster.CheckError(at: 2, reason: .brokenChain))
    // A Mac's join record isn't a roster change.
    let join = SignedText(payload: r.join.record.payload, signature: r.join.record.signature)
    XCTAssertEqual(failure(Roster.verify([join])), Roster.CheckError(at: 0, reason: .malformed))
  }

  func testBuildsTheSameChangeTextAsCore() throws {
    let r = try roster()
    let good = chain(r)
    let first = try Roster.verify([good[0]]).get()
    let change = try RosterChange.parse(good[1].payload)
    let at = try XCTUnwrap(ISOTime.parse(change.at))
    XCTAssertEqual(Roster.next(first, account: "ignored", by: change.by, change: change.change, at: at), good[1].payload)
    let root = try RosterChange.parse(good[0].payload)
    XCTAssertEqual(
      Roster.next(nil, account: r.account, by: root.by, change: root.change, at: try XCTUnwrap(ISOTime.parse(root.at))),
      good[0].payload
    )
  }

  func testReadsAMacsRequestToJoin() throws {
    let r = try roster()
    let record = SignedText(payload: r.join.record.payload, signature: r.join.record.signature)
    XCTAssertEqual(Roster.joinDevice(record), r.join.device.device)
    XCTAssertEqual(Roster.joinDevice(record, macId: r.join.macId), r.join.device.device)
    XCTAssertNil(Roster.joinDevice(record, macId: String(repeating: "a", count: 32)))
    // Signed by someone else, or with the signature of another text.
    XCTAssertNil(Roster.joinDevice(SignedText(payload: record.payload, signature: r.chain[0].signature)))
    // A roster change isn't a join record.
    XCTAssertNil(Roster.joinDevice(SignedText(payload: r.chain[0].payload, signature: r.chain[0].signature)))
  }

  func testReadsTheAccountTheHubSends() throws {
    let r = try roster()
    let text = JSON.serialize(.object([
      ("account", .string(r.account)), ("relay", .string("https://relay.example")),
      ("changes", .array(chain(r).map(\.json))),
      ("joining", .array([.object([
        ("macId", .string(r.join.macId)),
        ("record", SignedText(payload: r.join.record.payload, signature: r.join.record.signature).json),
        ("at", .string("2026-11-17T00:00:00.000Z")),
      ])])),
      ("nodes", .array([.object([
        ("macId", .string(r.join.macId)), ("slug", .string("laptop")), ("name", .string("Laptop")), ("online", .bool(true)),
      ])])),
    ]))
    let account = try HubPhone.Account.parse(text)
    XCTAssertEqual(account.changes.count, 2)
    XCTAssertNil(account.refused)
    XCTAssertEqual(account.joining.first?.macId, r.join.macId)
    XCTAssertEqual(account.nodes.first?.slug, "laptop")
    XCTAssertNoThrow(try Roster.verify(account.changes, pinned: r.genesis).get())
    // Strict, as core's schema is.
    XCTAssertThrowsError(try HubPhone.Account.parse(text.replacingOccurrences(of: "\"nodes\"", with: "\"extra\":1,\"nodes\"")))
    XCTAssertThrowsError(try HubPhone.Account.parse(text.replacingOccurrences(of: "https://relay.example", with: "http://relay.example")))
    XCTAssertThrowsError(try HubPhone.Account.parse(text.replacingOccurrences(of: "\"Laptop\"", with: "\"Lap\\u0000top\"")))
    let challenge = try HubPhone.Challenge.parse(#"{"nonce":"abcdefghijklmnopqrstuv","expiresAt":"2026-11-17T00:01:00.000Z"}"#)
    XCTAssertEqual(challenge.nonce, "abcdefghijklmnopqrstuv")
    XCTAssertThrowsError(try HubPhone.Challenge.parse(#"{"nonce":"short","expiresAt":"2026-11-17T00:01:00.000Z"}"#))
    XCTAssertEqual(
      HubPhone.request(deviceId: r.join.macId, nonce: challenge.nonce, signature: "sig"),
      #"{"deviceId":"\#(r.join.macId)","nonce":"abcdefghijklmnopqrstuv","signature":"sig"}"#
    )
  }

  /// A phone starts a list, then adds the vectors' waiting Mac: for core to check (VALET_IOS_SWIFT_OUT).
  func testWritesASwiftSignedRosterForCore() async throws {
    let r = try roster()
    let keys = SoftwareDeviceKeys()
    let me = keys.publicKeys.deviceId
    func sign(_ payload: String) async throws -> SignedText {
      let signature = try await keys.signApproval(Signing.input(.rosterChange, payload), reason: "test")
      return SignedText(payload: payload, signature: Base64URL.encode(signature))
    }
    let genesis = try await sign(Roster.next(nil, account: r.account, by: me, change: .add(RosterDevice(keys: keys.publicKeys, name: "iPhone")), at: Date()))
    let started = try Roster.verify([genesis]).get()
    XCTAssertEqual(started.order, [me])
    let mac = try XCTUnwrap(Roster.joinDevice(SignedText(payload: r.join.record.payload, signature: r.join.record.signature)))
    let added = try await sign(Roster.next(started, account: r.account, by: me, change: .add(mac), at: Date()))
    let chain = [genesis, added]
    let checked = try Roster.verify(chain, pinned: started.genesis, known: (seq: 0, head: started.head)).get()
    XCTAssertEqual(checked.order, [me, r.join.macId])
    // Removing the Mac again is fine; removing the phone too would leave nobody.
    let removed = try await sign(Roster.next(checked, account: r.account, by: me, change: .remove(r.join.macId), at: Date()))
    let alone = try Roster.verify(chain + [removed]).get()
    let last = try await sign(Roster.next(alone, account: r.account, by: me, change: .remove(me), at: Date()))
    XCTAssertEqual(failure(Roster.verify(chain + [removed, last])), Roster.CheckError(at: 3, reason: .lastDevice))
    guard let out = ProcessInfo.processInfo.environment["VALET_IOS_SWIFT_OUT"], !out.isEmpty else { return }
    let json = JSON.serialize(.object([("chain", .array(chain.map(\.json)))]))
    try Data(json.utf8).write(to: URL(fileURLWithPath: "\(out).roster.json"))
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
    func testApprovalKeyNeedsThePerson() {
      // Face ID or the passcode (Nick, 2026-11-12), and never without the person.
      XCTAssertTrue(KeyPolicy.approvalFlags.contains(.userPresence))
      XCTAssertTrue(KeyPolicy.approvalFlags.contains(.privateKeyUsage))
      XCTAssertFalse(KeyPolicy.approvalFlags.contains(.biometryCurrentSet))
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

/// core's passkey vectors (packages/core/test/roster-passkey.test.ts): a list a Mac started and
/// put a passkey on, and the passkey's WebAuthn assertion adding a phone (step 4d).
final class PasskeyRosterTests: XCTestCase {
  struct Vectors: Decodable {
    struct Change: Decodable {
      struct Assertion: Decodable { let credentialId, authenticatorData, clientDataJSON: String }
      let payload, signature: String
      let webauthn: Assertion?
      var signed: SignedText {
        SignedText(payload: payload, signature: signature, webauthn: webauthn.map {
          WebAuthnAssertion(credentialId: $0.credentialId, authenticatorData: $0.authenticatorData, clientDataJSON: $0.clientDataJSON)
        })
      }
    }
    let chain: [Change]
    let passkeyId, phoneId, head: String
    let wrongOrigin: [Change]
  }

  func vectors() throws -> Vectors {
    let url = try XCTUnwrap(Bundle.module.url(forResource: "passkey-vectors", withExtension: "json", subdirectory: "Vectors"))
    return try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
  }

  func testChecksAPhoneThePasskeyAddedAsCoreDoes() throws {
    let v = try vectors()
    let checked = try Roster.verify(v.chain.map(\.signed)).get()
    XCTAssertEqual(checked.head, v.head)
    XCTAssertNotNil(checked.passkeys[v.passkeyId])
    XCTAssertEqual(checked.devices[v.phoneId]?.role, "phone")
    guard case let .failure(error) = Roster.verify(v.wrongOrigin.map(\.signed)) else { return XCTFail("took another site's assertion") }
    XCTAssertEqual(error, Roster.CheckError(at: 2, reason: .badSignature))
    // Without its assertion, the passkey's change doesn't parse as signed by anyone.
    var bare = v.chain.map(\.signed)
    bare[2] = SignedText(payload: bare[2].payload, signature: bare[2].signature)
    guard case let .failure(missing) = Roster.verify(bare) else { return XCTFail("took a bare passkey change") }
    XCTAssertEqual(missing.reason, .malformed)
  }

  func testReadsTheChangesFromTheHubsAnswer() throws {
    let v = try vectors()
    let body = JSON.serialize(.object([
      ("account", .string("acct_0123456789abcdef")), ("relay", .string("https://relay.valet.test")),
      ("changes", .array(v.chain.map(\.signed.json))), ("joining", .array([])), ("nodes", .array([])),
    ]))
    let account = try HubPhone.Account.parse(body)
    XCTAssertEqual(account.changes, v.chain.map(\.signed))
    XCTAssertNotNil(account.changes[2].webauthn)
  }
}
