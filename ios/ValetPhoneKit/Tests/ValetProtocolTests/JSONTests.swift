import XCTest

@testable import ValetProtocol

final class JSONTests: XCTestCase {
  func testParsesAndKeepsOrder() throws {
    let value = try JSON.parse(#"{"b":1,"a":[true,false,null,"x"],"c":{"d":-2.5e3}}"#)
    XCTAssertEqual(value.object?.map(\.0), ["b", "a", "c"])
    XCTAssertEqual(JSON.serialize(value), #"{"b":1,"a":[true,false,null,"x"],"c":{"d":-2.5e3}}"#)
    XCTAssertEqual(JSON.canonical(value), #"{"a":[true,false,null,"x"],"b":1,"c":{"d":-2.5e3}}"#)
  }

  func testRefusesDuplicateKeys() {
    XCTAssertThrowsError(try JSON.parse(#"{"a":1,"a":2}"#)) { XCTAssertEqual($0 as? JSONError, .duplicateKey("a")) }
    XCTAssertThrowsError(try JSON.parse(#"{"x":{"a":1,"\u0061":2}}"#))
  }

  func testTellsPrecomposedAndDecomposedKeysApart() throws {
    // JavaScript compares keys by code units; Swift's String == would call these equal.
    let value = try JSON.parse("{\"caf\u{e9}\":1,\"cafe\u{301}\":2}")
    XCTAssertEqual(value.object?.count, 2)
  }

  func testRefusesBadSyntax() {
    for text in [
      "", "{", "{\"a\":}", "[1,]", "{\"a\":1,}", "01", "1.", "-", "\"\\x\"", "\"a", "{'a':1}", "nul", "1 2",
      "\"\u{1}\"", "\"\\ud800\"", "\"\\udc00\"", "+1", "NaN",
    ] {
      XCTAssertThrowsError(try JSON.parse(text), text)
    }
  }

  func testRefusesDeepNesting() {
    let text = String(repeating: "[", count: 40) + String(repeating: "]", count: 40)
    XCTAssertThrowsError(try JSON.parse(text)) { XCTAssertEqual($0 as? JSONError, .tooDeep) }
  }

  func testEscapesAsJSONStringifyDoes() throws {
    let value = JSONValue.string("q\"b\\n\n\t\u{1}\u{7f}\u{2028}é😀/")
    XCTAssertEqual(JSON.serialize(value), "\"q\\\"b\\\\n\\n\\t\\u0001\u{7f}\u{2028}é😀/\"")
    XCTAssertEqual(try JSON.parse(JSON.serialize(value)), value)
  }

  func testDecodesSurrogatePairs() throws {
    XCTAssertEqual(try JSON.parse(#""\ud83d\ude00""#), .string("😀"))
  }

  func testIntegers() throws {
    XCTAssertEqual(try JSON.parse("42").int, 42)
    XCTAssertNil(try JSON.parse("4.2").int)
    XCTAssertNil(try JSON.parse("1e3").int)
    XCTAssertNil(try JSON.parse("9007199254740993").int)
    // Int.min has no magnitude as an Int: abs() would trap (red team 2).
    XCTAssertNil(try JSON.parse("-9223372036854775808").int)
  }

  func testKeysCompareByCodeUnitsInFields() throws {
    // A Kelvin sign is canonically equivalent to K; JavaScript would call this an unknown key.
    let value = try JSON.parse("{\"approval\u{212A}ey\":\"x\"}")
    XCTAssertThrowsError(try Fields(value, path: "t", required: ["approvalKey"]))
  }

  func testBase64URL() {
    XCTAssertEqual(Base64URL.encode(Data([0xfb, 0xff])), "-_8")
    XCTAssertEqual(Base64URL.decode("-_8"), Data([0xfb, 0xff]))
    XCTAssertNil(Base64URL.decode("-_8="))
    XCTAssertNil(Base64URL.decode("+/8"))
    XCTAssertNil(Base64URL.decode("-_9"), "non-zero trailing bits")
    XCTAssertNil(Base64URL.decode("A"))
  }

  func testPatternsAnchorLikeJavaScript() {
    XCTAssertTrue(matches("abc", "[a-c]+"))
    XCTAssertFalse(matches("abc\n", "[a-c]+"))
    XCTAssertFalse(matches("xabc", "[a-c]+"))
  }

  func testStrictFields() throws {
    let value = try JSON.parse(#"{"a":"x","b":1}"#)
    XCTAssertThrowsError(try Fields(value, path: "t", required: ["a"]))
    XCTAssertThrowsError(try Fields(value, path: "t", required: ["a", "b", "c"]))
    let f = try Fields(value, path: "t", required: ["a"], optional: ["b"])
    XCTAssertEqual(try f.string("a"), "x")
    XCTAssertThrowsError(try f.string("b"))
  }

  func testISOTime() {
    XCTAssertNotNil(ISOTime.parse("2026-11-12T08:40:00.000Z"))
    XCTAssertNotNil(ISOTime.parse("2026-11-12T08:40:00Z"))
    XCTAssertNil(ISOTime.parse("2026-11-12T08:40:00+10:00"))
    XCTAssertNil(ISOTime.parse("2026-11-12 08:40:00Z"))
    XCTAssertEqual(ISOTime.format(ISOTime.parse("2026-11-12T08:40:00.000Z")!), "2026-11-12T08:40:00.000Z")
  }
}
