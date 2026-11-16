// Unit tests for the pieces of the helpers that need no Keychain, database or socket. The binaries
// themselves run under the TypeScript contract suites (packages/credentials/test/*-contract.ts),
// against the same cases as the TypeScript implementations.

import CryptoKit
import Foundation
import XCTest

@testable import ValetHelperKit

final class KeychainNameTests: XCTestCase {
  func testServicesAreValetOnly() {
    XCTAssertTrue(isAllowedService("valet"))
    XCTAssertTrue(isAllowedService("valet.copy"))
    XCTAssertTrue(isAllowedService("valet.copy.dev"))
    XCTAssertFalse(isAllowedService("valetx"))
    XCTAssertFalse(isAllowedService("com.apple.account"))
    XCTAssertFalse(isAllowedService("valet."))
    XCTAssertFalse(isAllowedService("valet.Copy"))
    XCTAssertFalse(isAllowedService("valet.a.b.c.d"))
  }

  func testAccountsArePrintable() {
    XCTAssertTrue(isAllowedAccount("op://abc/def#password"))
    XCTAssertFalse(isAllowedAccount(""))
    XCTAssertFalse(isAllowedAccount("a\nb"))
    XCTAssertFalse(isAllowedAccount(String(repeating: "a", count: 513)))
    XCTAssertNil(KeychainItem(service: "login", account: "x"))
  }
}

final class TypedStreamTests: XCTestCase {
  func archived(_ text: String) -> [UInt8] {
    let payload = Array(text.utf8)
    var bytes: [UInt8] = [0x04, 0x0B] + Array("streamtyped".utf8) + [0x81, 0xE8, 0x03, 0x84, 0x01, 0x40, 0x84, 0x84, 0x84]
    bytes += [0x12] + Array("NSAttributedString".utf8) + [0x00, 0x84, 0x84, 0x08] + Array("NSObject".utf8) + [0x00, 0x85]
    bytes += [0x92, 0x84, 0x84, 0x84, 0x08] + Array("NSString".utf8) + [0x01, 0x94, 0x84, 0x01, 0x2B]
    if payload.count < 0x80 {
      bytes.append(UInt8(payload.count))
    } else {
      bytes += [0x81, UInt8(payload.count & 0xFF), UInt8(payload.count >> 8)]
    }
    return bytes + payload + [0x86]
  }

  func testShortAndLongStrings() {
    XCTAssertEqual(attributedBodyText(archived("Your code is 123456")), "Your code is 123456")
    let long = String(repeating: "x", count: 300) + " 654321"
    XCTAssertEqual(attributedBodyText(archived(long)), long)
  }

  func testMalformed() {
    XCTAssertNil(attributedBodyText([]))
    XCTAssertNil(attributedBodyText(Array("NSString".utf8)))
    var cut = archived("Your code is 123456")
    cut.removeLast(8)
    XCTAssertNil(attributedBodyText(cut))
  }
}

final class CodeTests: XCTestCase {
  func testFirstCaptureWins() throws {
    XCTAssertEqual(try firstCode(pattern: "code is (\\d{6})", texts: ["no", "code is 111111", "code is 222222"]), "111111")
  }

  func testWholeMatchWhenNoGroup() throws {
    XCTAssertEqual(try firstCode(pattern: "\\d{6}", texts: ["use 123456 now"]), "123456")
  }

  func testCaptureMustLookLikeACode() throws {
    XCTAssertNil(try firstCode(pattern: "(.*)", texts: ["a whole private message"]))
    XCTAssertEqual(try firstCode(pattern: "is (\\w+)", texts: ["is x", "is ab12"]), "ab12")
  }

  func testBadPattern() {
    XCTAssertThrowsError(try firstCode(pattern: "(", texts: ["x"]))
  }
}

final class RequestTests: XCTestCase {
  let now: Int64 = 1_793_000_000_000

  func line(_ object: [String: Any]) -> Data {
    try! JSONSerialization.data(withJSONObject: object)
  }

  var valid: [String: Any] {
    ["v": 1, "handle": "woolworths", "services": ["SMS", "RCS"], "pattern": "(\\d{6})", "sinceMs": now - 60_000]
  }

  func testValid() throws {
    let request = try parseOtpRequest(line(valid), nowMs: now)
    XCTAssertEqual(request.handle, "woolworths")
    XCTAssertEqual(request.services, ["SMS", "RCS"])
  }

  func testRefusesWiderQuestions() {
    var tooOld = valid
    tooOld["sinceMs"] = now - maxLookbackMs - 60_001
    var extra = valid
    extra["limit"] = 1000
    var unknownService = valid
    unknownService["services"] = ["SMS", "Fax"]
    var wildcard = valid
    wildcard["handle"] = "%"
    var future = valid
    future["sinceMs"] = now + 1
    for object in [tooOld, extra, unknownService, wildcard, future] {
      XCTAssertThrowsError(try parseOtpRequest(line(object), nowMs: now))
    }
    XCTAssertThrowsError(try parseOtpRequest(Data("not json".utf8), nowMs: now))
  }

  func testResponseLines() {
    XCTAssertEqual(String(decoding: responseLine(.success("123456")), as: UTF8.self), "{\"code\":\"123456\"}\n")
    XCTAssertEqual(String(decoding: responseLine(.failure(.notFound)), as: UTF8.self), "{\"error\":\"not-found\"}\n")
  }
}

final class ApprovalTests: XCTestCase {
  let macId = String(repeating: "a", count: 32)

  func request(_ subject: String, kind: String = "tool-enable") -> String {
    "{\"id\":\"rrrrrrrrrrrrrrrrrrrrrr\",\"kind\":\"\(kind)\",\"macId\":\"\(macId)\",\"subject\":\(subject)}"
  }

  func payload(for requestText: String, digest: String? = nil, deviceId: String? = nil) -> String {
    let digest = digest ?? domainDigest(approvalRequestDomain, requestText)
    return "{\"decidedAt\":\"2026-11-12T03:00:00.000Z\",\"decision\":\"approve\",\"deviceId\":\"\(deviceId ?? macId)\","
      + "\"macId\":\"\(macId)\",\"requestDigest\":\"\(digest)\",\"requestId\":\"rrrrrrrrrrrrrrrrrrrrrr\",\"v\":1}"
  }

  func testSignsOnlyAnApprovalOfTheRequestShown() {
    let text = request("{\"scope\":\"local\",\"tool\":\"get_quote\"}")
    let toSign = approvalToSign(requestText: text, payload: payload(for: text), deviceId: macId)
    XCTAssertNotNil(toSign)
    let ref = String(domainDigest(approvalRequestDomain, text).prefix(4)).uppercased()
    XCTAssertEqual(toSign?.reason, "turn on a tool (get_quote, on this Mac) (request \(ref))")
    XCTAssertEqual(toSign?.input, Data("\(approvalDecisionDomain)\n\(payload(for: text))".utf8))
    XCTAssertNil(approvalToSign(requestText: text, payload: payload(for: text, digest: String(repeating: "0", count: 64)), deviceId: macId))
    XCTAssertNil(approvalToSign(requestText: text, payload: payload(for: text, deviceId: String(repeating: "b", count: 32)), deviceId: String(repeating: "b", count: 32)))
    XCTAssertNil(approvalToSign(requestText: text, payload: "{}", deviceId: macId))
    XCTAssertNil(approvalToSign(requestText: request("{}", kind: "approve-everything"), payload: payload(for: request("{}", kind: "approve-everything")), deviceId: macId))
  }

  func testReasonsNameTheMacsOwnFacts() {
    let install = request(
      "{\"changes\":[{\"area\":\"navigation\",\"change\":\"added\",\"items\":[\"https://finance.yahoo.com\"]}],\"unsandboxed\":false}",
      kind: "adapter-install")
    XCTAssertTrue(approvalToSign(requestText: install, payload: payload(for: install), deviceId: macId)?.reason.hasPrefix("approve an adapter that reaches finance.yahoo.com (") ?? false)
    let loose = request("{\"changes\":[],\"unsandboxed\":true}", kind: "adapter-install")
    XCTAssertTrue(approvalToSign(requestText: loose, payload: payload(for: loose), deviceId: macId)?.reason.hasPrefix("approve an adapter that runs without the sandbox (") ?? false)
    XCTAssertEqual(hostOf("https://www.woolworths.com.au:8443"), "www.woolworths.com.au:8443")
    XCTAssertEqual(hostOf("https://auth.woolworths.com.au:443"), "auth.woolworths.com.au")
    XCTAssertNil(hostOf("http://example.com"))
  }
}

final class ChannelSigningTests: XCTestCase {
  let own = OwnKeys(
    macId: String(repeating: "a", count: 32), approvalKey: "MAC-APPROVAL", transportKey: "MAC-TRANSPORT",
    agreementKey: "MAC-AGREEMENT")

  func record(_ fields: [String: Any]) -> String {
    var base: [String: Any] = [
      "v": 1, "deviceId": String(repeating: "b", count: 32), "macId": own.macId, "role": "phone", "platform": "ios",
      "name": "Nick’s iPhone", "approvalKey": "P-A", "transportKey": "P-T", "agreementKey": "P-G",
      "pairedAt": "2026-11-12T03:00:00.000Z",
    ]
    for (k, v) in fields { base[k] = v }
    return String(decoding: try! JSONSerialization.data(withJSONObject: base, options: [.sortedKeys]), as: UTF8.self)
  }

  func testRelayBindingIsOnlyTheMacsOwnTransportKey() {
    XCTAssertEqual(
      channelApprovalToSign(domain: relayBindingDomain, payloads: ["MAC-TRANSPORT"], own: own)?.reason,
      "connect to Valet's relay")
    XCTAssertNil(channelApprovalToSign(domain: relayBindingDomain, payloads: ["SOMEONE-ELSE"], own: own))
  }

  func testDeviceRecordsSignedTogether() {
    let mac = record([
      "deviceId": own.macId, "role": "mac", "platform": "macos", "approvalKey": "MAC-APPROVAL",
      "transportKey": "MAC-TRANSPORT", "agreementKey": "MAC-AGREEMENT",
    ])
    let both = channelApprovalToSign(domain: deviceRecordDomain, payloads: [record([:]), mac], own: own)
    XCTAssertEqual(both?.inputs.count, 2)
    XCTAssertEqual(both?.reason, "pair a new iPhone")
    // A record for another Mac, a phone claiming the Mac's id, two phones, or the wrong keys: refused.
    XCTAssertNil(channelApprovalToSign(domain: deviceRecordDomain, payloads: [record(["macId": "c"])], own: own))
    XCTAssertNil(
      channelApprovalToSign(domain: deviceRecordDomain, payloads: [record(["deviceId": own.macId])], own: own))
    XCTAssertNil(channelApprovalToSign(domain: deviceRecordDomain, payloads: [record([:]), record([:])], own: own))
    XCTAssertNil(
      channelApprovalToSign(
        domain: deviceRecordDomain,
        payloads: [record(["deviceId": own.macId, "role": "mac", "platform": "macos"])], own: own))
    XCTAssertNil(channelApprovalToSign(domain: deviceRecordDomain, payloads: [record(["extra": 1])], own: own))
  }

  func testPairingChallengeShape() {
    let ok = #"{"offerId":"abc","macNonce":"def","reply":"\#(String(repeating: "0", count: 64))"}"#
    XCTAssertEqual(channelApprovalToSign(domain: pairingChallengeDomain, payloads: [ok], own: own)?.reason, "pair a new iPhone")
    XCTAssertNil(channelApprovalToSign(domain: pairingChallengeDomain, payloads: ["{}"], own: own))
    XCTAssertNil(channelApprovalToSign(domain: "valet/approval-decision/v1", payloads: [ok], own: own))
  }

  func rosterDevice(_ fields: [String: Any] = [:]) -> [String: Any] {
    var base: [String: Any] = [
      "deviceId": String(repeating: "b", count: 32), "role": "phone", "platform": "ios", "name": "iPhone",
      "approvalKey": "P-A", "transportKey": "P-T", "agreementKey": "P-G",
    ]
    for (k, v) in fields { base[k] = v }
    return base
  }

  var macDevice: [String: Any] {
    rosterDevice([
      "deviceId": own.macId, "role": "mac", "platform": "macos", "approvalKey": "MAC-APPROVAL",
      "transportKey": "MAC-TRANSPORT", "agreementKey": "MAC-AGREEMENT",
    ])
  }

  /// A run of changes as core's nextRosterChange writes them, each naming the one before.
  func rosterChain(_ changes: [[String: Any]], from seq: Int = 0, prev: String? = nil, by: String? = nil,
                   tweak: (Int, inout [String: Any]) -> Void = { _, _ in }) -> [String] {
    var out: [String] = []
    var prev: Any = prev ?? NSNull()
    for (i, change) in changes.enumerated() {
      var object: [String: Any] = [
        "v": 1, "account": "acct_0123456789abcdef", "seq": seq + i, "prev": prev,
        "at": "2026-11-16T00:00:00.000Z", "by": by ?? own.macId, "change": change,
      ]
      tweak(i, &object)
      let text = String(decoding: try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]), as: UTF8.self)
      out.append(text)
      prev = SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
    }
    return out
  }

  func testRosterStartsWithThisMacThenItsPhones() {
    let phone2 = rosterDevice(["deviceId": String(repeating: "c", count: 32), "approvalKey": "P2-A"])
    let start = rosterChain([["op": "add", "device": macDevice], ["op": "add", "device": rosterDevice()],
                             ["op": "add", "device": phone2]])
    let signed = channelApprovalToSign(domain: rosterChangeDomain, payloads: start, own: own)
    XCTAssertEqual(signed?.inputs.count, 3)
    XCTAssertEqual(signed?.reason, "put this Mac and its iPhones on your Valet account")
    XCTAssertEqual(signed?.inputs.first, Data("\(rosterChangeDomain)\n\(start[0])".utf8))

    let later = rosterChain([["op": "add", "device": rosterDevice()]], from: 4, prev: String(repeating: "0", count: 64))
    XCTAssertEqual(channelApprovalToSign(domain: rosterChangeDomain, payloads: later, own: own)?.reason,
                   "add an iPhone to your Valet account")
    let remove = rosterChain([["op": "remove", "deviceId": String(repeating: "b", count: 32)]], from: 2,
                             prev: String(repeating: "0", count: 64))
    XCTAssertEqual(channelApprovalToSign(domain: rosterChangeDomain, payloads: remove, own: own)?.reason,
                   "remove a device from your Valet account")
  }

  func testRosterRefusesWhatThisMacMustNotSign() {
    let prev = String(repeating: "0", count: 64)
    func refused(_ payloads: [String], _ line: UInt = #line) {
      XCTAssertNil(channelApprovalToSign(domain: rosterChangeDomain, payloads: payloads, own: own), line: line)
    }
    // Signed in another device's name.
    refused(rosterChain([["op": "add", "device": rosterDevice()]], from: 1, prev: prev, by: String(repeating: "c", count: 32)))
    // This Mac adding itself anywhere but first, or with keys that aren't its own.
    refused(rosterChain([["op": "add", "device": macDevice]], from: 1, prev: prev))
    var wrongKeys = macDevice
    wrongKeys["transportKey"] = "SOMEONE-ELSE"
    refused(rosterChain([["op": "add", "device": wrongKeys]]))
    // Another Mac, a phone using this Mac's id, this Mac removing itself.
    refused(rosterChain([["op": "add", "device": rosterDevice(["role": "mac", "platform": "macos"])]], from: 1, prev: prev))
    refused(rosterChain([["op": "add", "device": rosterDevice(["deviceId": own.macId])]], from: 1, prev: prev))
    refused(rosterChain([["op": "remove", "deviceId": own.macId]], from: 1, prev: prev))
    // A batch whose changes don't follow one another, or switch account.
    var broken = rosterChain([["op": "add", "device": macDevice], ["op": "add", "device": rosterDevice()]])
    broken[1] = broken[1].replacingOccurrences(of: "\"seq\":1", with: "\"seq\":2")
    refused(broken)
    refused(rosterChain([["op": "add", "device": macDevice], ["op": "add", "device": rosterDevice()]]) { i, o in
      if i == 1 { o["prev"] = prev }
    })
    refused(rosterChain([["op": "add", "device": macDevice], ["op": "add", "device": rosterDevice()]]) { i, o in
      if i == 1 { o["account"] = "acct_another_account_0" }
    })
    // A first change with a prev, extra fields, too many at once, or another domain's limit.
    refused(rosterChain([["op": "add", "device": macDevice]]) { _, o in o["prev"] = prev })
    refused(rosterChain([["op": "add", "device": rosterDevice()]], from: 1, prev: prev) { _, o in o["extra"] = 1 })
    refused(rosterChain([["op": "add", "device": rosterDevice(["extra": 1])]], from: 1, prev: prev))
    let many = (0..<10).map { i in
      ["op": "add", "device": rosterDevice(["deviceId": String(format: "%032d", i + 1), "approvalKey": "P\(i)"])]
        as [String: Any]
    }
    refused(rosterChain(many, from: 1, prev: prev))
    XCTAssertNotNil(channelApprovalToSign(domain: rosterChangeDomain, payloads: rosterChain(Array(many.prefix(9)), from: 1, prev: prev), own: own))
    XCTAssertNil(channelApprovalToSign(domain: deviceRecordDomain, payloads: Array(repeating: record([:]), count: 3), own: own))
  }

  func testTransportSignsOnlyThisMacsSignIn() {
    let payload = #"{"nonce":"n0","relay":"https://relay.example.com","role":"mac","id":"\#(own.macId)"}"#
    XCTAssertNotNil(relayAuthToSign(payload: payload, macId: own.macId))
    XCTAssertNil(relayAuthToSign(payload: payload.replacingOccurrences(of: "\"mac\"", with: "\"phone\""), macId: own.macId))
    XCTAssertNil(relayAuthToSign(payload: payload, macId: String(repeating: "c", count: 32)))
  }
}
