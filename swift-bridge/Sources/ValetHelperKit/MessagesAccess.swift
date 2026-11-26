// What the reader helper does for the built-in Messages tools (docs/messages.md): narrow, read-only
// access to the Messages database (~/Library/Messages/chat.db), the attachments Messages keeps
// beside it, and the Contacts databases that put names to handles. Only a process with Full Disk
// Access can open them. As for Mail (MailAccess.swift), everything that understands the tables lives
// in Valet's main process (packages/native-messages), so it is tested there; the helper answers
// three questions:
//
// - messages.info   whether chat.db is there and which Contacts sources exist
// - messages.query  one read-only SELECT (or PRAGMA table_info) against chat.db or one Contacts
//                   source. An authorizer allows reading only the message, chat and attachment
//                   tables (or the contact name, phone and email tables), one statement, nothing
//                   written, nothing attached. On chat.db a `message_text(text, attributedBody)`
//                   function gives a message's text however Messages stored it.
// - messages.file   the bytes of one file under ~/Library/Messages/Attachments, at most 25 MB
//
// Nothing here writes. Paths are resolved and must stay inside the folder they belong to.

import Foundation
import SQLite3

public enum MessagesDatabase: String {
  case chat
  case contacts
}

public enum MessagesRequest: Equatable {
  case info
  case query(MessagesDatabase, String?, String, [MailValue])
  case file(String)
}

/// Where the helper finds the files. `messagesDir` is ~/Library/Messages; `addressBookDir` is
/// ~/Library/Application Support/AddressBook.
public struct MessagesRoots {
  public let messagesDir: String
  public let addressBookDir: String

  public init(messagesDir: String, addressBookDir: String) {
    self.messagesDir = messagesDir
    self.addressBookDir = addressBookDir
  }

  public static func standard(home: String) -> MessagesRoots {
    MessagesRoots(
      messagesDir: home + "/Library/Messages",
      addressBookDir: home + "/Library/Application Support/AddressBook")
  }

  var chatDB: String { messagesDir + "/chat.db" }
  var attachmentsDir: String { messagesDir + "/Attachments" }
}

let addressBookFile = "AddressBook-v22.abcddb"
/// The Contacts database at the top of the AddressBook folder; each account's is in Sources/<id>.
public let mainContactSource = "main"

let messagesTables: [MessagesDatabase: Set<String>] = [
  .chat: [
    "message", "chat", "handle", "chat_message_join", "chat_handle_join", "attachment",
    "message_attachment_join",
  ],
  .contacts: ["ZABCDRECORD", "ZABCDPHONENUMBER", "ZABCDEMAILADDRESS"],
]

public func isMessagesRequest(_ data: Data) -> Bool {
  guard let json = try? JSONSerialization.jsonObject(with: data), let object = json as? [String: Any],
    let op = object["op"] as? String
  else { return false }
  return op.hasPrefix("messages.")
}

func isSourceName(_ value: String) -> Bool {
  (1...64).contains(value.utf8.count)
    && value.utf8.allSatisfy {
      ($0 >= 0x41 && $0 <= 0x5A) || ($0 >= 0x61 && $0 <= 0x7A) || ($0 >= 0x30 && $0 <= 0x39) || $0 == 0x2D
    }
}

/// Parses `{"v":1,"op":"messages.…",…}`. Unknown keys or ops are refused.
public func parseMessagesRequest(_ data: Data) throws -> MessagesRequest {
  guard let json = try? JSONSerialization.jsonObject(with: data), let object = json as? [String: Any],
    (object["v"] as? NSNumber)?.intValue == 1, let op = object["op"] as? String
  else { throw MailFailure.invalid }
  let keys = Set(object.keys)
  switch op {
  case "messages.info":
    guard keys == ["v", "op"] else { throw MailFailure.invalid }
    return .info
  case "messages.query":
    guard keys == ["v", "op", "db", "sql", "params"] || keys == ["v", "op", "db", "source", "sql", "params"],
      let dbName = object["db"] as? String, let db = MessagesDatabase(rawValue: dbName),
      let sql = object["sql"] as? String, !sql.isEmpty, sql.utf8.count <= maxSQLBytes,
      let raw = object["params"] as? [Any], raw.count <= maxParams
    else { throw MailFailure.invalid }
    var source: String?
    if keys.contains("source") {
      guard db == .contacts, let name = object["source"] as? String, isSourceName(name) else {
        throw MailFailure.invalid
      }
      source = name
    } else if db == .contacts {
      throw MailFailure.invalid
    }
    return .query(db, source, sql, try queryParams(raw))
  case "messages.file":
    guard keys == ["v", "op", "path"], let path = object["path"] as? String, !path.isEmpty,
      path.utf8.count <= 1_024
    else { throw MailFailure.invalid }
    return .file(path)
  default:
    throw MailFailure.invalid
  }
}

/// The Contacts sources that have a database: "main" for the top one, then each Sources/<id>.
public func contactSources(_ roots: MessagesRoots) -> [String] {
  let manager = FileManager.default
  var sources: [String] = []
  if manager.fileExists(atPath: roots.addressBookDir + "/" + addressBookFile) { sources.append(mainContactSource) }
  let names = (try? manager.contentsOfDirectory(atPath: roots.addressBookDir + "/Sources")) ?? []
  for name in names.sorted() where isSourceName(name) && name != mainContactSource {
    if manager.fileExists(atPath: roots.addressBookDir + "/Sources/" + name + "/" + addressBookFile) {
      sources.append(name)
    }
  }
  return sources
}

func contactsPath(_ roots: MessagesRoots, source: String) -> String? {
  guard contactSources(roots).contains(source) else { return nil }
  return source == mainContactSource
    ? roots.addressBookDir + "/" + addressBookFile
    : roots.addressBookDir + "/Sources/" + source + "/" + addressBookFile
}

/// Answers one request as a JSON object: the answer's keys, or `error`.
public func answerMessages(_ request: MessagesRequest, roots: MessagesRoots) -> [String: Any] {
  do {
    switch request {
    case .info:
      return [
        "chat": FileManager.default.isReadableFile(atPath: roots.chatDB),
        "contactSources": contactSources(roots),
      ]
    case .query(let db, let source, let sql, let params):
      let path: String
      var configure: ((OpaquePointer) -> Void)?
      switch db {
      case .chat:
        path = roots.chatDB
        configure = addMessageTextFunction
      case .contacts:
        guard let source, let found = contactsPath(roots, source: source) else { throw MailFailure.notFound }
        path = found
      }
      let (columns, rows) = try runQuery(
        path: path, sql: sql, params: params, tables: messagesTables[db] ?? [], configure: configure)
      return ["columns": columns, "rows": rows]
    case .file(let relative):
      let path = try insideAttachments(roots, relative: relative)
      var info = stat()
      guard stat(path, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG else { throw MailFailure.notFound }
      guard info.st_size <= maxFileBytes else { throw MailFailure.tooLarge }
      guard let data = FileManager.default.contents(atPath: path) else { throw MailFailure.notFound }
      return ["base64": data.base64EncodedString()]
    }
  } catch {
    return ["error": ((error as? MailFailure) ?? .unavailable).rawValue]
  }
}

/// `relative` resolved inside ~/Library/Messages/Attachments, links followed; anything else refused.
func insideAttachments(_ roots: MessagesRoots, relative: String) throws -> String {
  for part in relative.split(separator: "/", omittingEmptySubsequences: false)
  where part.isEmpty || part == "." || part == ".." || part.contains("\0") {
    throw MailFailure.invalid
  }
  guard let root = realpath(roots.attachmentsDir, nil) else { throw MailFailure.unavailable }
  let rootPath = String(cString: root)
  free(root)
  guard let resolved = realpath(rootPath + "/" + relative, nil) else { throw MailFailure.notFound }
  let resolvedPath = String(cString: resolved)
  free(resolved)
  guard resolvedPath.hasPrefix(rootPath + "/") else { throw MailFailure.invalid }
  return resolvedPath
}

/// `message_text(text, attributedBody)`: the text column when it has text, else the string in the
/// attributedBody archive (Messages.swift), else null.
let messageTextFunction: @convention(c) (OpaquePointer?, Int32, UnsafeMutablePointer<OpaquePointer?>?) -> Void = {
  context, count, values in
  let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
  guard let values, count == 2 else {
    sqlite3_result_null(context)
    return
  }
  if sqlite3_value_type(values[0]) == SQLITE_TEXT, let raw = sqlite3_value_text(values[0]), raw.pointee != 0 {
    sqlite3_result_text(context, UnsafeRawPointer(raw).assumingMemoryBound(to: CChar.self), -1, transient)
    return
  }
  if sqlite3_value_type(values[1]) == SQLITE_BLOB, let blob = sqlite3_value_blob(values[1]) {
    let length = Int(sqlite3_value_bytes(values[1]))
    if let text = attributedBodyText([UInt8](UnsafeRawBufferPointer(start: blob, count: length))) {
      sqlite3_result_text(context, text, -1, transient)
      return
    }
  }
  sqlite3_result_null(context)
}

func addMessageTextFunction(_ db: OpaquePointer) {
  sqlite3_create_function_v2(
    db, "message_text", 2, SQLITE_UTF8 | SQLITE_DETERMINISTIC, nil, messageTextFunction, nil, nil, nil)
}
