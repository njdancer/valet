// Unit tests for the pieces of the helpers that need no Keychain, database or socket. The binaries
// themselves run under the TypeScript contract suites (packages/credentials/test/*-contract.ts),
// against the same cases as the TypeScript implementations.

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
