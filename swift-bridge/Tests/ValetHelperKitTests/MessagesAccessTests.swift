// The reader helper's Messages questions against a made-up Messages folder and Contacts folder in
// a temporary directory. packages/native-messages runs its own contract suite against the built
// helper.

import Foundation
import SQLite3
import XCTest

@testable import ValetHelperKit

final class MessagesAccessTests: XCTestCase {
  var root = ""
  var roots: MessagesRoots {
    MessagesRoots(messagesDir: root + "/Messages", addressBookDir: root + "/AddressBook")
  }

  func exec(_ path: String, _ sql: String) {
    var db: OpaquePointer?
    XCTAssertEqual(sqlite3_open(path, &db), SQLITE_OK)
    XCTAssertEqual(sqlite3_exec(db, sql, nil, nil, nil), SQLITE_OK)
    sqlite3_close(db)
  }

  override func setUpWithError() throws {
    root = NSTemporaryDirectory() + "valet-messages-" + UUID().uuidString
    let manager = FileManager.default
    try manager.createDirectory(atPath: root + "/Messages/Attachments/ab/01", withIntermediateDirectories: true)
    try manager.createDirectory(atPath: root + "/AddressBook/Sources/ABCD-1", withIntermediateDirectories: true)
    try "photo".write(toFile: root + "/Messages/Attachments/ab/01/a.png", atomically: true, encoding: .utf8)
    try "secret".write(toFile: root + "/Messages/outside.txt", atomically: true, encoding: .utf8)
    exec(
      root + "/Messages/chat.db",
      """
      CREATE TABLE message (ROWID INTEGER PRIMARY KEY, text TEXT, attributedBody BLOB, date INTEGER);
      CREATE TABLE kvtable (key TEXT, value TEXT);
      INSERT INTO message VALUES (1, 'hello', NULL, 817275600000000000);
      INSERT INTO message VALUES (2, NULL, NULL, 0);
      INSERT INTO kvtable VALUES ('k', 'no');
      """)
    exec(
      root + "/AddressBook/Sources/ABCD-1/AddressBook-v22.abcddb",
      """
      CREATE TABLE ZABCDRECORD (Z_PK INTEGER PRIMARY KEY, ZFIRSTNAME TEXT);
      CREATE TABLE ZABCDNOTE (Z_PK INTEGER PRIMARY KEY, ZTEXT TEXT);
      INSERT INTO ZABCDRECORD VALUES (1, 'Ada');
      """)
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(atPath: root)
  }

  func ask(_ object: [String: Any]) throws -> [String: Any] {
    answerMessages(try parseMessagesRequest(try JSONSerialization.data(withJSONObject: object)), roots: roots)
  }

  func testInfo() throws {
    let answer = try ask(["v": 1, "op": "messages.info"])
    XCTAssertEqual(answer["chat"] as? Bool, true)
    XCTAssertEqual(answer["contactSources"] as? [String], ["ABCD-1"])
  }

  func testReadsMessagesWithTheTextFunction() throws {
    let answer = try ask([
      "v": 1, "op": "messages.query", "db": "chat",
      "sql": "SELECT ROWID, message_text(text, attributedBody) AS body, date / 1000000 AS ms FROM message ORDER BY ROWID",
      "params": [],
    ])
    let rows = answer["rows"] as? [[Any]]
    XCTAssertEqual(rows?.count, 2)
    XCTAssertEqual(rows?[0][1] as? String, "hello")
    XCTAssertEqual((rows?[0][2] as? NSNumber)?.int64Value, 817_275_600_000)
    XCTAssertTrue(rows?[1][1] is NSNull)
  }

  func testTheTextFunctionReadsTheArchive() throws {
    let body = Array("streamtyped".utf8) + Array("NSString".utf8) + [0x01, 0x94, 0x84, 0x01, 0x2B, 0x02] + Array("hi".utf8)
    let hex = body.map { String(format: "%02x", $0) }.joined()
    exec(root + "/Messages/chat.db", "INSERT INTO message VALUES (3, '', x'\(hex)', 0);")
    let answer = try ask([
      "v": 1, "op": "messages.query", "db": "chat",
      "sql": "SELECT message_text(text, attributedBody) AS body FROM message WHERE ROWID = ?", "params": [3],
    ])
    XCTAssertEqual((answer["rows"] as? [[Any]])?.first?.first as? String, "hi")
  }

  func testRefusesOtherTablesAndWrites() throws {
    for sql in ["SELECT * FROM kvtable", "DELETE FROM message", "SELECT 1; SELECT 2", "SELECT * FROM sqlite_master"] {
      let answer = try ask(["v": 1, "op": "messages.query", "db": "chat", "sql": sql, "params": []])
      XCTAssertEqual(answer["error"] as? String, "invalid", sql)
    }
    let note = try ask([
      "v": 1, "op": "messages.query", "db": "contacts", "source": "ABCD-1", "sql": "SELECT ZTEXT FROM ZABCDNOTE",
      "params": [],
    ])
    XCTAssertEqual(note["error"] as? String, "invalid")
    let name = try ask([
      "v": 1, "op": "messages.query", "db": "contacts", "source": "ABCD-1",
      "sql": "SELECT ZFIRSTNAME FROM ZABCDRECORD", "params": [],
    ])
    XCTAssertEqual((name["rows"] as? [[Any]])?.first?.first as? String, "Ada")
    let missing = try ask([
      "v": 1, "op": "messages.query", "db": "contacts", "source": "main", "sql": "SELECT 1", "params": [],
    ])
    XCTAssertEqual(missing["error"] as? String, "not-found")
  }

  func testParsingRefusesOddShapes() {
    for object: [String: Any] in [
      ["v": 1, "op": "messages.query", "db": "contacts", "sql": "SELECT 1", "params": []],
      ["v": 1, "op": "messages.query", "db": "chat", "source": "main", "sql": "SELECT 1", "params": []],
      ["v": 1, "op": "messages.query", "db": "contacts", "source": "../x", "sql": "SELECT 1", "params": []],
      ["v": 1, "op": "messages.file", "path": ""],
      ["v": 1, "op": "messages.info", "extra": 1],
      ["v": 1, "op": "messages.delete"],
    ] {
      XCTAssertThrowsError(try parseMessagesRequest(try! JSONSerialization.data(withJSONObject: object)))
    }
  }

  func testFilesOnlyInsideAttachments() throws {
    XCTAssertEqual(
      try ask(["v": 1, "op": "messages.file", "path": "ab/01/a.png"])["base64"] as? String,
      Data("photo".utf8).base64EncodedString())
    XCTAssertEqual(try ask(["v": 1, "op": "messages.file", "path": "../outside.txt"])["error"] as? String, "invalid")
    try FileManager.default.createSymbolicLink(
      atPath: root + "/Messages/Attachments/link", withDestinationPath: root + "/Messages/chat.db")
    XCTAssertEqual(try ask(["v": 1, "op": "messages.file", "path": "link"])["error"] as? String, "invalid")
    XCTAssertEqual(try ask(["v": 1, "op": "messages.file", "path": "ab/01/none"])["error"] as? String, "not-found")
  }
}
