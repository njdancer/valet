// The one question the Messages helper answers: the newest code-shaped capture of `pattern` in a
// message from exactly `handle`, over one of `services`, received since `sinceMs`. A port of
// packages/credentials/src/messages-otp.ts; packages/credentials/test/otp-contract.ts runs the same
// cases against both. The database is opened read-only per lookup.
//
// The caller (Valet's main process) has already parsed the sender and screened the pattern; the
// helper re-checks only shapes and bounds, so a caller can't widen the question: the handle must be
// one exact handle, at most 50 recent messages are looked at, no further back than 30 minutes, and
// only the first 2,000 characters of each.

import Foundation
import SQLite3

public struct OtpRequest: Equatable {
  public let handle: String
  public let services: [String]
  public let pattern: String
  public let sinceMs: Int64

  public init(handle: String, services: [String], pattern: String, sinceMs: Int64) {
    self.handle = handle
    self.services = services
    self.pattern = pattern
    self.sinceMs = sinceMs
  }
}

public enum OtpFailure: String, Error {
  case invalid
  case notFound = "not-found"
  case unavailable
}

/// Messages counts time from 2001-01-01 UTC.
let appleEpochMs: Int64 = 978_307_200_000
/// Older databases store seconds, newer ones nanoseconds.
let nanosecondThreshold: Int64 = 100_000_000_000
let recentLimit = 50
let maxScannedChars = 2_000
let maxPatternChars = 512
public let maxLookbackMs: Int64 = 30 * 60_000
let knownServices: Set<String> = ["SMS", "RCS", "iMessage"]

/// Parses the request line Valet sends: `{"v":1,"handle":…,"services":[…],"pattern":…,"sinceMs":…}`.
public func parseOtpRequest(_ data: Data, nowMs: Int64) throws -> OtpRequest {
  guard let json = try? JSONSerialization.jsonObject(with: data), let object = json as? [String: Any],
    Set(object.keys) == ["v", "handle", "services", "pattern", "sinceMs"],
    (object["v"] as? NSNumber)?.intValue == 1,
    let handle = object["handle"] as? String,
    let services = object["services"] as? [String],
    let pattern = object["pattern"] as? String,
    let since = object["sinceMs"] as? NSNumber
  else { throw OtpFailure.invalid }
  let sinceMs = since.int64Value
  guard isHandle(handle), !services.isEmpty, services.count <= knownServices.count,
    services.allSatisfy({ knownServices.contains($0) }),
    !pattern.isEmpty, pattern.count <= maxPatternChars,
    // A minute of slack for the two clocks reading "now" a moment apart.
    sinceMs <= nowMs, sinceMs >= nowMs - maxLookbackMs - 60_000
  else { throw OtpFailure.invalid }
  return OtpRequest(handle: handle, services: services, pattern: pattern, sinceMs: sinceMs)
}

/// One handle as parseOtpSender normalises it: E.164 or digits, or a lowercased sender ID or email.
func isHandle(_ handle: String) -> Bool {
  guard (3...254).contains(handle.utf8.count) else { return false }
  return handle.utf8.allSatisfy { byte in
    (byte >= 0x61 && byte <= 0x7A) || (byte >= 0x30 && byte <= 0x39)
      || [0x2B, 0x40, 0x2E, 0x5F, 0x25, 0x2D, 0x26, 0x20].contains(byte)  // + @ . _ % - & space
  }
}

let recentMessagesSQL = """
  SELECT m.text, m.attributedBody, m.date
  FROM message m JOIN handle h ON h.ROWID = m.handle_id
  WHERE m.is_from_me = 0
    AND (m.date >= ? OR (m.date < ? AND m.date >= ?))
    AND lower(h.id) = ?
    AND instr(?, ',' || h.service || ',') > 0
  ORDER BY m.date DESC
  LIMIT ?
  """

/// The texts of matching messages, newest first, each cut to its first 2,000 characters.
public func recentTexts(databasePath: String, request: OtpRequest) throws -> [String] {
  var db: OpaquePointer?
  // SQLITE_OPEN_READONLY, and never create: a missing file is missing Full Disk Access or Messages.
  guard sqlite3_open_v2(databasePath, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK, let db else {
    sqlite3_close(db)
    throw OtpFailure.unavailable
  }
  defer { sqlite3_close(db) }
  sqlite3_busy_timeout(db, 1_000)
  var statement: OpaquePointer?
  guard sqlite3_prepare_v2(db, recentMessagesSQL, -1, &statement, nil) == SQLITE_OK, let statement else {
    throw OtpFailure.unavailable
  }
  defer { sqlite3_finalize(statement) }
  let sinceApple = request.sinceMs - appleEpochMs
  let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
  sqlite3_bind_int64(statement, 1, sinceApple * 1_000_000)
  sqlite3_bind_int64(statement, 2, nanosecondThreshold)
  sqlite3_bind_int64(statement, 3, floorDiv(sinceApple, 1000))
  sqlite3_bind_text(statement, 4, request.handle, -1, transient)
  sqlite3_bind_text(statement, 5, "," + request.services.joined(separator: ",") + ",", -1, transient)
  sqlite3_bind_int64(statement, 6, Int64(recentLimit))
  var texts: [String] = []
  while true {
    let step = sqlite3_step(statement)
    if step == SQLITE_DONE { break }
    guard step == SQLITE_ROW else { throw OtpFailure.unavailable }
    let date = sqlite3_column_int64(statement, 2)
    // SQL bounds whole seconds for old rows; this keeps the cut-off exact.
    if unixMs(date) < request.sinceMs { continue }
    var text: String?
    if sqlite3_column_type(statement, 0) == SQLITE_TEXT, let raw = sqlite3_column_text(statement, 0) {
      text = String(cString: raw)
    } else if sqlite3_column_type(statement, 1) == SQLITE_BLOB, let blob = sqlite3_column_blob(statement, 1) {
      let count = Int(sqlite3_column_bytes(statement, 1))
      text = attributedBodyText([UInt8](UnsafeRawBufferPointer(start: blob, count: count)))
    }
    if let text { texts.append(String(text.prefix(maxScannedChars))) }
  }
  return texts
}

func floorDiv(_ a: Int64, _ b: Int64) -> Int64 {
  let q = a / b
  return (a % b != 0 && (a < 0) != (b < 0)) ? q - 1 : q
}

func unixMs(_ date: Int64) -> Int64 {
  date >= nanosecondThreshold ? date / 1_000_000 + appleEpochMs : date * 1000 + appleEpochMs
}

/// The first code-shaped capture across `texts`, in order: group 1 if it took part, else the whole
/// match. Codes are 4 to 10 ASCII letters or digits; anything else is skipped.
public func firstCode(pattern: String, texts: [String]) throws -> String? {
  guard let regex = try? NSRegularExpression(pattern: pattern) else { throw OtpFailure.invalid }
  for text in texts {
    let range = NSRange(text.startIndex..., in: text)
    guard let match = regex.firstMatch(in: text, range: range) else { continue }
    var captured = match.range(at: 0)
    if match.numberOfRanges > 1, match.range(at: 1).location != NSNotFound { captured = match.range(at: 1) }
    guard let swiftRange = Range(captured, in: text) else { continue }
    let capture = String(text[swiftRange])
    if isCodeShaped(capture) { return capture }
  }
  return nil
}

func isCodeShaped(_ value: String) -> Bool {
  (4...10).contains(value.utf8.count)
    && value.utf8.allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x41 && $0 <= 0x5A) || ($0 >= 0x61 && $0 <= 0x7A) }
}

/// The text out of an `attributedBody` (an NSAttributedString in typedstream form): the string
/// payload follows the first NSString class name as a '+' tag and a typedstream integer length.
/// A port of packages/credentials/src/typedstream.ts.
public func attributedBodyText(_ bytes: [UInt8]) -> String? {
  let marker = Array("NSString".utf8)
  guard let markerAt = indexOf(marker, in: bytes, from: 0) else { return nil }
  let searchFrom = markerAt + marker.count
  let windowEnd = min(bytes.count, searchFrom + 16)
  guard searchFrom < windowEnd, let tagAt = bytes[searchFrom..<windowEnd].firstIndex(of: 0x2B) else { return nil }
  var at = tagAt + 1
  guard at < bytes.count else { return nil }
  let lengthTag = bytes[at]
  let length: Int
  if lengthTag < 0x80 {
    length = Int(lengthTag)
    at += 1
  } else if lengthTag == 0x81 {
    guard at + 3 <= bytes.count else { return nil }
    length = Int(bytes[at + 1]) | Int(bytes[at + 2]) << 8
    at += 3
  } else if lengthTag == 0x82 {
    guard at + 5 <= bytes.count else { return nil }
    length = Int(bytes[at + 1]) | Int(bytes[at + 2]) << 8 | Int(bytes[at + 3]) << 16 | Int(bytes[at + 4]) << 24
    at += 5
  } else {
    return nil
  }
  guard at + length <= bytes.count else { return nil }
  return String(decoding: bytes[at..<(at + length)], as: UTF8.self)
}

func indexOf(_ needle: [UInt8], in haystack: [UInt8], from start: Int) -> Int? {
  guard needle.count <= haystack.count else { return nil }
  var i = start
  while i + needle.count <= haystack.count {
    if haystack[i] == needle[0], Array(haystack[i..<(i + needle.count)]) == needle { return i }
    i += 1
  }
  return nil
}

/// Answers one request, with matching under `deadline` seconds. Past the deadline the answer is
/// `invalid`, and `onOverrun` runs (the agent exits there, so launchd restarts it and the runaway
/// match goes with the process).
public func answer(
  _ request: OtpRequest, databasePath: String, deadline: TimeInterval = 0.5, onOverrun: () -> Void = {}
) -> Result<String, OtpFailure> {
  let texts: [String]
  do {
    texts = try recentTexts(databasePath: databasePath, request: request)
  } catch {
    return .failure((error as? OtpFailure) ?? .unavailable)
  }
  if texts.isEmpty { return .failure(.notFound) }
  let done = DispatchSemaphore(value: 0)
  let box = ResultBox()
  DispatchQueue.global().async {
    box.set(Result { try firstCode(pattern: request.pattern, texts: texts) })
    done.signal()
  }
  if done.wait(timeout: .now() + deadline) == .timedOut {
    onOverrun()
    return .failure(.invalid)
  }
  switch box.get() {
  case .some(.success(.some(let code))): return .success(code)
  case .some(.success(.none)): return .failure(.notFound)
  default: return .failure(.invalid)
  }
}

final class ResultBox: @unchecked Sendable {
  private let lock = NSLock()
  private var value: Result<String?, Error>?
  func set(_ result: Result<String?, Error>) {
    lock.lock()
    value = result
    lock.unlock()
  }
  func get() -> Result<String?, Error>? {
    lock.lock()
    defer { lock.unlock() }
    return value
  }
}

/// The response line: `{"code":"…"}` or `{"error":"invalid|not-found|unavailable"}`.
public func responseLine(_ result: Result<String, OtpFailure>) -> Data {
  let object: [String: String]
  switch result {
  case .success(let code): object = ["code": code]
  case .failure(let failure): object = ["error": failure.rawValue]
  }
  var data = (try? JSONSerialization.data(withJSONObject: object)) ?? Data("{\"error\":\"unavailable\"}".utf8)
  data.append(0x0A)
  return data
}
