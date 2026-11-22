// What the reader helper does for Mail (docs/mail.md): narrow, read-only access to the files Mail
// keeps under ~/Library/Mail, which only a process with Full Disk Access can open. Everything that
// understands those files (which tables to read, how a row finds its .emlx, parsing the message)
// lives in Valet's main process (packages/native-mail), so it is tested there; the helper only
// answers four questions:
//
// - mail.info       the library folder in use (the highest V<n> with an Envelope Index)
// - mail.query      one read-only SELECT (or PRAGMA table_info) against Mail's Envelope Index or the
//                   Internet Accounts database. An authorizer allows reading only Mail's message
//                   tables (or the account table), one statement, nothing written, nothing attached.
// - mail.file       the bytes of one .emlx file inside the library
// - mail.list       the names in one folder inside the library
// - mail.spotlight  the .emlx files Spotlight finds for a word, inside the library
//
// Nothing here writes to Mail's folders. Paths are resolved and must stay inside the library.

import Foundation
import SQLite3

public enum MailFailure: String, Error {
  case invalid
  case notFound = "not-found"
  case unavailable
  case tooLarge = "too-large"
}

public enum MailDatabase: String {
  case envelope
  case accounts
}

public enum MailValue: Equatable {
  case text(String)
  case integer(Int64)
  case real(Double)
  case null
}

public enum MailRequest: Equatable {
  case info
  case query(MailDatabase, String, [MailValue])
  case file(String)
  case list(String)
  case spotlight(String)
}

/// Where the helper finds Mail's files. `mailDir` is ~/Library/Mail; `accountsDB` is Internet
/// Accounts' database, which names the accounts.
public struct MailRoots {
  public let mailDir: String
  public let accountsDB: String

  public init(mailDir: String, accountsDB: String) {
    self.mailDir = mailDir
    self.accountsDB = accountsDB
  }

  public static func standard(home: String) -> MailRoots {
    MailRoots(mailDir: home + "/Library/Mail", accountsDB: home + "/Library/Accounts/Accounts4.sqlite")
  }
}

let maxSQLBytes = 8 * 1024
let maxParams = 1_000
let maxRows = 5_000
let maxFileBytes = 25 * 1024 * 1024
let maxListEntries = 5_000
let maxSpotlightResults = 500
let spotlightSeconds: TimeInterval = 5

/// The tables each database may be read from.
let readableTables: [MailDatabase: Set<String>] = [
  .envelope: [
    "messages", "subjects", "addresses", "recipients", "mailboxes", "summaries", "attachments",
    "conversations", "message_global_data",
  ],
  .accounts: ["ZACCOUNT", "ZACCOUNTTYPE"],
]

public func isMailRequest(_ data: Data) -> Bool {
  guard let json = try? JSONSerialization.jsonObject(with: data), let object = json as? [String: Any],
    let op = object["op"] as? String
  else { return false }
  return op.hasPrefix("mail.")
}

/// Parses `{"v":1,"op":"mail.…",…}`. Unknown keys or ops are refused.
public func parseMailRequest(_ data: Data) throws -> MailRequest {
  guard let json = try? JSONSerialization.jsonObject(with: data), let object = json as? [String: Any],
    (object["v"] as? NSNumber)?.intValue == 1, let op = object["op"] as? String
  else { throw MailFailure.invalid }
  let keys = Set(object.keys)
  switch op {
  case "mail.info":
    guard keys == ["v", "op"] else { throw MailFailure.invalid }
    return .info
  case "mail.query":
    guard keys == ["v", "op", "db", "sql", "params"], let dbName = object["db"] as? String,
      let db = MailDatabase(rawValue: dbName), let sql = object["sql"] as? String,
      !sql.isEmpty, sql.utf8.count <= maxSQLBytes, let raw = object["params"] as? [Any], raw.count <= maxParams
    else { throw MailFailure.invalid }
    var params: [MailValue] = []
    for value in raw {
      if value is NSNull {
        params.append(.null)
      } else if let text = value as? String {
        params.append(.text(text))
      } else if let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() {
        let double = number.doubleValue
        if double.rounded() == double, abs(double) < 9.0e15 {
          params.append(.integer(number.int64Value))
        } else {
          params.append(.real(double))
        }
      } else {
        throw MailFailure.invalid
      }
    }
    return .query(db, sql, params)
  case "mail.file", "mail.list":
    guard keys == ["v", "op", "path"], let path = object["path"] as? String, path.utf8.count <= 1_024
    else { throw MailFailure.invalid }
    return op == "mail.file" ? .file(path) : .list(path)
  case "mail.spotlight":
    guard keys == ["v", "op", "term"], let term = object["term"] as? String, let clean = spotlightTerm(term)
    else { throw MailFailure.invalid }
    return .spotlight(clean)
  default:
    throw MailFailure.invalid
  }
}

/// The highest V<n> folder in `mailDir` that has an Envelope Index, or nil.
public func mailLibrary(_ roots: MailRoots) -> String? {
  let manager = FileManager.default
  guard let names = try? manager.contentsOfDirectory(atPath: roots.mailDir) else { return nil }
  var best: (Int, String)?
  for name in names where name.hasPrefix("V") {
    guard let number = Int(name.dropFirst()), number > 0, number < 1_000 else { continue }
    let path = roots.mailDir + "/" + name
    guard manager.fileExists(atPath: path + "/MailData/Envelope Index") else { continue }
    if best == nil || number > best!.0 { best = (number, path) }
  }
  return best?.1
}

/// A Spotlight search term: no quotes, backslashes, wildcards or control characters, 2 to 100 long.
public func spotlightTerm(_ term: String) -> String? {
  let kept = term.unicodeScalars.filter { scalar in
    !["\"", "\\", "*", "'"].contains(scalar) && !CharacterSet.controlCharacters.contains(scalar)
  }
  let clean = String(kept).trimmingCharacters(in: .whitespaces)
  guard (2...100).contains(clean.count) else { return nil }
  return clean
}

/// Answers one request as a JSON object: the answer's keys, or `error`.
public func answerMail(_ request: MailRequest, roots: MailRoots) -> [String: Any] {
  do {
    switch request {
    case .info:
      guard let library = mailLibrary(roots) else { throw MailFailure.unavailable }
      return ["library": (library as NSString).lastPathComponent]
    case .query(let db, let sql, let params):
      let path: String
      switch db {
      case .envelope:
        guard let library = mailLibrary(roots) else { throw MailFailure.unavailable }
        path = library + "/MailData/Envelope Index"
      case .accounts:
        path = roots.accountsDB
      }
      let (columns, rows) = try runQuery(path: path, sql: sql, params: params, tables: readableTables[db] ?? [])
      return ["columns": columns, "rows": rows]
    case .file(let relative):
      guard let library = mailLibrary(roots) else { throw MailFailure.unavailable }
      let path = try inside(library: library, relative: relative)
      guard path.hasSuffix(".emlx") else { throw MailFailure.invalid }
      var info = stat()
      guard stat(path, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG else { throw MailFailure.notFound }
      guard info.st_size <= maxFileBytes else { throw MailFailure.tooLarge }
      guard let data = FileManager.default.contents(atPath: path) else { throw MailFailure.notFound }
      return ["base64": data.base64EncodedString()]
    case .list(let relative):
      guard let library = mailLibrary(roots) else { throw MailFailure.unavailable }
      let path = try inside(library: library, relative: relative)
      guard let names = try? FileManager.default.contentsOfDirectory(atPath: path) else {
        throw MailFailure.notFound
      }
      var entries: [[String: Any]] = []
      for name in names.sorted().prefix(maxListEntries) {
        var info = stat()
        guard lstat(path + "/" + name, &info) == 0 else { continue }
        let kind = info.st_mode & S_IFMT
        if kind == S_IFDIR {
          entries.append(["name": name, "dir": true])
        } else if kind == S_IFREG {
          entries.append(["name": name, "dir": false])
        }
      }
      return ["entries": entries, "truncated": names.count > maxListEntries]
    case .spotlight(let term):
      guard let library = mailLibrary(roots) else { throw MailFailure.unavailable }
      return ["paths": try spotlight(term: term, library: library)]
    }
  } catch {
    return ["error": ((error as? MailFailure) ?? .unavailable).rawValue]
  }
}

/// `relative` resolved inside `library`, symlinks followed; anything that leaves it is refused.
func inside(library: String, relative: String) throws -> String {
  let parts = relative.split(separator: "/", omittingEmptySubsequences: false)
  if !relative.isEmpty {
    for part in parts where part.isEmpty || part == "." || part == ".." || part.contains("\0") {
      throw MailFailure.invalid
    }
  }
  guard let root = realpath(library, nil) else { throw MailFailure.unavailable }
  let rootPath = String(cString: root)
  free(root)
  let joined = relative.isEmpty ? rootPath : rootPath + "/" + relative
  guard let resolved = realpath(joined, nil) else { throw MailFailure.notFound }
  let resolvedPath = String(cString: resolved)
  free(resolved)
  guard resolvedPath == rootPath || resolvedPath.hasPrefix(rootPath + "/") else { throw MailFailure.invalid }
  return resolvedPath
}

final class AllowedTables {
  let names: Set<String>
  init(_ names: Set<String>) { self.names = names }
}

/// Allows reading the listed tables and PRAGMA table_info on them, and nothing else.
let mailAuthorizer:
  @convention(c) (
    UnsafeMutableRawPointer?, Int32, UnsafePointer<CChar>?, UnsafePointer<CChar>?, UnsafePointer<CChar>?,
    UnsafePointer<CChar>?
  ) -> Int32 = { context, action, first, second, _, _ in
    guard let context else { return SQLITE_DENY }
    let allowed = Unmanaged<AllowedTables>.fromOpaque(context).takeUnretainedValue().names
    switch action {
    case SQLITE_SELECT, SQLITE_FUNCTION:
      return SQLITE_OK
    case SQLITE_READ:
      guard let first else { return SQLITE_DENY }
      return allowed.contains(String(cString: first)) ? SQLITE_OK : SQLITE_DENY
    case SQLITE_PRAGMA:
      guard let first, let second, String(cString: first).lowercased() == "table_info" else { return SQLITE_DENY }
      return allowed.contains(String(cString: second)) ? SQLITE_OK : SQLITE_DENY
    default:
      return SQLITE_DENY
    }
  }

func openReadOnly(_ path: String, immutable: Bool) -> OpaquePointer? {
  var db: OpaquePointer?
  let result: Int32
  if immutable {
    guard let encoded = path.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) else { return nil }
    result = sqlite3_open_v2("file:\(encoded)?immutable=1", &db, SQLITE_OPEN_READONLY | SQLITE_OPEN_URI, nil)
  } else {
    result = sqlite3_open_v2(path, &db, SQLITE_OPEN_READONLY, nil)
  }
  guard result == SQLITE_OK, let db else {
    sqlite3_close(db)
    return nil
  }
  sqlite3_busy_timeout(db, 2_000)
  return db
}

/// Runs one statement, read-only, under the authorizer. Mail keeps its index open while it runs;
/// if the ordinary read-only open can't share its write-ahead log, the file is read as it stands.
public func runQuery(path: String, sql: String, params: [MailValue], tables: Set<String>) throws -> (
  [String], [[Any]]
) {
  guard FileManager.default.fileExists(atPath: path) else { throw MailFailure.unavailable }
  do {
    return try runQuery(path: path, sql: sql, params: params, tables: tables, immutable: false)
  } catch MailFailure.unavailable {
    return try runQuery(path: path, sql: sql, params: params, tables: tables, immutable: true)
  }
}

func runQuery(path: String, sql: String, params: [MailValue], tables: Set<String>, immutable: Bool) throws -> (
  [String], [[Any]]
) {
  guard let db = openReadOnly(path, immutable: immutable) else { throw MailFailure.unavailable }
  defer { sqlite3_close(db) }
  let allowed = AllowedTables(tables)
  let context = Unmanaged.passUnretained(allowed).toOpaque()
  sqlite3_set_authorizer(db, mailAuthorizer, context)
  defer { withExtendedLifetime(allowed) {} }
  var statement: OpaquePointer?
  // The tail points into the C string, so it is read before withCString's copy goes away.
  var trailing = false
  let prepared = sql.withCString { text -> Int32 in
    var tail: UnsafePointer<CChar>?
    let code = sqlite3_prepare_v2(db, text, -1, &statement, &tail)
    if let tail { trailing = !String(cString: tail).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    return code
  }
  if prepared == SQLITE_AUTH { throw MailFailure.invalid }
  if prepared != SQLITE_OK || statement == nil {
    // A missing table or column is the caller's question, not the file: invalid. Anything about
    // opening the file is unavailable.
    let code = sqlite3_errcode(db)
    if code == SQLITE_ERROR { throw MailFailure.invalid }
    throw MailFailure.unavailable
  }
  defer { sqlite3_finalize(statement) }
  if trailing { throw MailFailure.invalid }
  guard sqlite3_stmt_readonly(statement) != 0 else { throw MailFailure.invalid }
  let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
  guard Int(sqlite3_bind_parameter_count(statement)) == params.count else { throw MailFailure.invalid }
  for (index, value) in params.enumerated() {
    let at = Int32(index + 1)
    switch value {
    case .text(let text): sqlite3_bind_text(statement, at, text, -1, transient)
    case .integer(let number): sqlite3_bind_int64(statement, at, number)
    case .real(let number): sqlite3_bind_double(statement, at, number)
    case .null: sqlite3_bind_null(statement, at)
    }
  }
  let count = Int(sqlite3_column_count(statement))
  var columns: [String] = []
  for index in 0..<count {
    columns.append(sqlite3_column_name(statement, Int32(index)).map { String(cString: $0) } ?? "")
  }
  var rows: [[Any]] = []
  while true {
    let step = sqlite3_step(statement)
    if step == SQLITE_DONE { break }
    guard step == SQLITE_ROW else { throw MailFailure.unavailable }
    guard rows.count < maxRows else { throw MailFailure.tooLarge }
    var row: [Any] = []
    for index in 0..<count {
      let column = Int32(index)
      switch sqlite3_column_type(statement, column) {
      case SQLITE_INTEGER: row.append(NSNumber(value: sqlite3_column_int64(statement, column)))
      case SQLITE_FLOAT: row.append(NSNumber(value: sqlite3_column_double(statement, column)))
      case SQLITE_TEXT:
        row.append(sqlite3_column_text(statement, column).map { String(cString: $0) } ?? NSNull())
      default: row.append(NSNull())
      }
    }
    rows.append(row)
  }
  return (columns, rows)
}

/// The .emlx files under `library` whose text Spotlight matches `term`, as paths relative to it.
func spotlight(term: String, library: String) throws -> [String] {
  let query =
    "(kMDItemContentType == \"com.apple.mail.emlx\" || kMDItemContentType == \"com.apple.mail.emlx.part\")"
    + " && kMDItemTextContent == \"*\(term)*\"cd"
  let process = Process()
  process.executableURL = URL(fileURLWithPath: "/usr/bin/mdfind")
  process.arguments = ["-onlyin", library, query]
  let output = Pipe()
  process.standardOutput = output
  process.standardError = FileHandle.nullDevice
  do { try process.run() } catch { throw MailFailure.unavailable }
  let reader = DispatchQueue(label: "valet.spotlight")
  let box = DataBox()
  let done = DispatchSemaphore(value: 0)
  reader.async {
    box.data = output.fileHandleForReading.readDataToEndOfFile()
    done.signal()
  }
  if done.wait(timeout: .now() + spotlightSeconds) == .timedOut {
    process.terminate()
    _ = done.wait(timeout: .now() + 1)
  }
  process.waitUntilExit()
  let prefix = library.hasSuffix("/") ? library : library + "/"
  var paths: [String] = []
  for line in String(decoding: box.data, as: UTF8.self).split(separator: "\n") {
    guard paths.count < maxSpotlightResults else { break }
    let path = String(line)
    guard path.hasPrefix(prefix), path.hasSuffix(".emlx") else { continue }
    paths.append(String(path.dropFirst(prefix.count)))
  }
  return paths
}

final class DataBox: @unchecked Sendable {
  var data = Data()
}

/// The response line for a mail answer.
public func mailResponseLine(_ object: [String: Any]) -> Data {
  var data =
    (try? JSONSerialization.data(withJSONObject: object)) ?? Data("{\"error\":\"unavailable\"}".utf8)
  data.append(0x0A)
  return data
}
