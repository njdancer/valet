// The reader helper's Mail questions against a made-up Mail library in a temporary folder. The
// TypeScript side (packages/native-mail) runs its own contract suite against the built helper.

import Foundation
import SQLite3
import XCTest

@testable import ValetHelperKit

final class MailAccessTests: XCTestCase {
  var root = ""
  var roots: MailRoots { MailRoots(mailDir: root + "/Mail", accountsDB: root + "/Accounts4.sqlite") }

  override func setUpWithError() throws {
    root = NSTemporaryDirectory() + "valet-mail-" + UUID().uuidString
    let library = root + "/Mail/V10"
    try FileManager.default.createDirectory(atPath: library + "/MailData", withIntermediateDirectories: true)
    try FileManager.default.createDirectory(
      atPath: library + "/ACCT/INBOX.mbox/UUID/Data/Messages", withIntermediateDirectories: true)
    try "From: a@example.com\r\n\r\nhello".write(
      toFile: library + "/ACCT/INBOX.mbox/UUID/Data/Messages/7.emlx", atomically: true, encoding: .utf8)
    try "secret".write(toFile: root + "/outside.emlx", atomically: true, encoding: .utf8)
    var db: OpaquePointer?
    XCTAssertEqual(sqlite3_open(library + "/MailData/Envelope Index", &db), SQLITE_OK)
    let setup = """
      CREATE TABLE messages (ROWID INTEGER PRIMARY KEY, subject INTEGER, mailbox INTEGER);
      CREATE TABLE subjects (ROWID INTEGER PRIMARY KEY, subject TEXT);
      CREATE TABLE secrets (ROWID INTEGER PRIMARY KEY, value TEXT);
      INSERT INTO subjects VALUES (1, 'Hello');
      INSERT INTO messages VALUES (7, 1, 1);
      INSERT INTO secrets VALUES (1, 'no');
      """
    XCTAssertEqual(sqlite3_exec(db, setup, nil, nil, nil), SQLITE_OK)
    sqlite3_close(db)
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(atPath: root)
  }

  func request(_ object: [String: Any]) throws -> MailRequest {
    try parseMailRequest(try JSONSerialization.data(withJSONObject: object))
  }

  func ask(_ object: [String: Any]) throws -> [String: Any] {
    answerMail(try request(object), roots: roots)
  }

  func testFindsTheLibrary() throws {
    XCTAssertEqual(try ask(["v": 1, "op": "mail.info"])["library"] as? String, "V10")
    try FileManager.default.createDirectory(atPath: root + "/Mail/V11", withIntermediateDirectories: true)
    // A newer folder without an index is not the library.
    XCTAssertEqual(try ask(["v": 1, "op": "mail.info"])["library"] as? String, "V10")
  }

  func testReadsMessageTables() throws {
    let answer = try ask([
      "v": 1, "op": "mail.query", "db": "envelope",
      "sql": "SELECT m.ROWID, s.subject FROM messages m JOIN subjects s ON s.ROWID = m.subject WHERE m.ROWID = ?",
      "params": [7],
    ])
    XCTAssertEqual(answer["columns"] as? [String], ["ROWID", "subject"])
    let rows = answer["rows"] as? [[Any]]
    XCTAssertEqual(rows?.count, 1)
    XCTAssertEqual(rows?[0][1] as? String, "Hello")
  }

  func testTableInfoOnlyOnMailTables() throws {
    let info = try ask(["v": 1, "op": "mail.query", "db": "envelope", "sql": "PRAGMA table_info(messages)", "params": []])
    XCTAssertEqual((info["rows"] as? [[Any]])?.count, 3)
    let other = try ask(["v": 1, "op": "mail.query", "db": "envelope", "sql": "PRAGMA table_info(secrets)", "params": []])
    XCTAssertEqual(other["error"] as? String, "invalid")
  }

  func testRefusesAnythingButReadingMailTables() throws {
    for sql in [
      "SELECT value FROM secrets",
      "SELECT * FROM sqlite_master",
      "DELETE FROM messages",
      "UPDATE subjects SET subject = 'x'",
      "INSERT INTO subjects VALUES (2, 'x')",
      "SELECT 1; SELECT 2",
      "ATTACH DATABASE '/tmp/x' AS x",
      "PRAGMA journal_mode = DELETE",
      "CREATE TABLE x (a)",
    ] {
      let answer = try ask(["v": 1, "op": "mail.query", "db": "envelope", "sql": sql, "params": []])
      XCTAssertEqual(answer["error"] as? String, "invalid", sql)
    }
    // Parameters must match the statement's.
    let short = try ask(["v": 1, "op": "mail.query", "db": "envelope", "sql": "SELECT ? ", "params": []])
    XCTAssertEqual(short["error"] as? String, "invalid")
  }

  func testAccountsDatabaseOnlyItsTables() throws {
    var db: OpaquePointer?
    XCTAssertEqual(sqlite3_open(roots.accountsDB, &db), SQLITE_OK)
    sqlite3_exec(
      db, "CREATE TABLE ZACCOUNT (ZIDENTIFIER TEXT, ZUSERNAME TEXT); CREATE TABLE ZCREDENTIAL (Z TEXT);"
        + "INSERT INTO ZACCOUNT VALUES ('ACCT', 'me@example.com');", nil, nil, nil)
    sqlite3_close(db)
    let ok = try ask(["v": 1, "op": "mail.query", "db": "accounts", "sql": "SELECT ZUSERNAME FROM ZACCOUNT", "params": []])
    XCTAssertEqual((ok["rows"] as? [[Any]])?[0][0] as? String, "me@example.com")
    let no = try ask(["v": 1, "op": "mail.query", "db": "accounts", "sql": "SELECT Z FROM ZCREDENTIAL", "params": []])
    XCTAssertEqual(no["error"] as? String, "invalid")
  }

  func testReadsOnlyEmlxInsideTheLibrary() throws {
    let file = try ask(["v": 1, "op": "mail.file", "path": "ACCT/INBOX.mbox/UUID/Data/Messages/7.emlx"])
    let data = Data(base64Encoded: file["base64"] as? String ?? "")
    XCTAssertEqual(data.map { String(decoding: $0, as: UTF8.self) }, "From: a@example.com\r\n\r\nhello")
    for path in ["../../outside.emlx", "/etc/passwd", "ACCT/../../../outside.emlx", "MailData/Envelope Index", ""] {
      let answer = try ask(["v": 1, "op": "mail.file", "path": path])
      XCTAssertNotNil(answer["error"], path)
      XCTAssertNil(answer["base64"], path)
    }
    // A link out of the library is followed and refused.
    try FileManager.default.createSymbolicLink(
      atPath: root + "/Mail/V10/ACCT/link.emlx", withDestinationPath: root + "/outside.emlx")
    XCTAssertEqual(try ask(["v": 1, "op": "mail.file", "path": "ACCT/link.emlx"])["error"] as? String, "invalid")
  }

  func testReadsAttachmentFilesBesideMessagesOnly() throws {
    let dir = root + "/Mail/V10/ACCT/INBOX.mbox/UUID/Attachments/7/2"
    try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    try "a,b\n1,2".write(toFile: dir + "/report.csv", atomically: true, encoding: .utf8)
    let file = try ask(["v": 1, "op": "mail.file", "path": "ACCT/INBOX.mbox/UUID/Attachments/7/2/report.csv"])
    XCTAssertEqual(Data(base64Encoded: file["base64"] as? String ?? "").map { String(decoding: $0, as: UTF8.self) }, "a,b\n1,2")
    for path in [
      "MailData/Attachments/7/2/x", "ACCT/Attachments/7/2/x", "ACCT/INBOX.mbox/UUID/Attachments/7/report.csv",
      "ACCT/INBOX.mbox/UUID/Attachments/seven/2/report.csv", "ACCT/INBOX.mbox/UUID/Data/Messages/7.txt",
    ] {
      XCTAssertEqual(try ask(["v": 1, "op": "mail.file", "path": path])["error"] as? String, "invalid", path)
    }
    // An attachment-shaped link to Mail's database is followed and refused.
    try FileManager.default.createSymbolicLink(
      atPath: dir + "/index.csv", withDestinationPath: root + "/Mail/V10/MailData/Envelope Index")
    XCTAssertEqual(
      try ask(["v": 1, "op": "mail.file", "path": "ACCT/INBOX.mbox/UUID/Attachments/7/2/index.csv"])["error"] as? String,
      "invalid")
    XCTAssertTrue(isMailMessageFile("ACCT/INBOX.mbox/UUID/Attachments/7/1.2/a.pdf"))
    XCTAssertFalse(isMailMessageFile("ACCT/INBOX.mbox/UUID/Attachments/7/2/x/y"))
  }

  func testListsFolders() throws {
    let answer = try ask(["v": 1, "op": "mail.list", "path": "ACCT/INBOX.mbox/UUID/Data/Messages"])
    let entries = answer["entries"] as? [[String: Any]]
    XCTAssertEqual(entries?.first?["name"] as? String, "7.emlx")
    XCTAssertEqual(entries?.first?["dir"] as? Bool, false)
    XCTAssertEqual(try ask(["v": 1, "op": "mail.list", "path": ".."])["error"] as? String, "invalid")
  }

  func testRefusesMalformedRequests() {
    let bad: [[String: Any]] = [
      ["v": 2, "op": "mail.info"],
      ["v": 1, "op": "mail.info", "extra": 1],
      ["v": 1, "op": "mail.query", "db": "other", "sql": "SELECT 1", "params": []],
      ["v": 1, "op": "mail.query", "db": "envelope", "sql": "SELECT ?", "params": [true]],
      ["v": 1, "op": "mail.query", "db": "envelope", "sql": "SELECT ?", "params": [["a"]]],
      ["v": 1, "op": "mail.spotlight", "term": "a"],
      ["v": 1, "op": "mail.write", "path": "x"],
    ]
    for object in bad {
      XCTAssertThrowsError(try request(object), "\(object)")
    }
  }

  func testSpotlightTermsAreScrubbed() {
    XCTAssertEqual(spotlightTerm("  invoice  "), "invoice")
    XCTAssertEqual(spotlightTerm("a\"*b\\c'"), "abc")
    XCTAssertNil(spotlightTerm("\"*"))
    XCTAssertNil(spotlightTerm(String(repeating: "x", count: 101)))
  }

  func testMailRequestsAreToldApart() {
    XCTAssertTrue(isMailRequest(Data("{\"v\":1,\"op\":\"mail.info\"}".utf8)))
    XCTAssertFalse(isMailRequest(Data("{\"v\":1,\"handle\":\"x\"}".utf8)))
  }
}
