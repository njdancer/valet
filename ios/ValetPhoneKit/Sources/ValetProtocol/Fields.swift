// Reading a JSON object the way a `.strict()` zod schema does: exactly the listed keys (optional
// ones may be absent), each with its type, pattern and length. Every failure names its path, for
// tests and diagnostics only; the person never sees it.

import Foundation

public struct SchemaError: Error, Equatable, CustomStringConvertible {
  public let path: String
  public let reason: String
  public init(_ path: String, _ reason: String) {
    self.path = path
    self.reason = reason
  }
  public var description: String { "\(path): \(reason)" }
}

public enum Patterns {
  public static let keyId = "[0-9a-f]{32}"
  public static let hash = "[0-9a-f]{64}"
  public static let base64url = "[A-Za-z0-9_-]+"
  public static let requestId = "[A-Za-z0-9_-]{22}"
  public static let adapterId = "[a-z][a-z0-9-]{1,63}"
  public static let name = "[a-z][a-z0-9_]{0,63}"
  public static let origin = "https://[a-z0-9.-]+(?::[0-9]{1,5})?"
  public static let clientId = "(?:local|remote):[A-Za-z0-9_-]{1,64}"
  public static let qualifiedTool = "[a-z][a-z0-9-]{1,63}\\.[a-z][a-z0-9_]{0,63}"
  public static let address = "[0-9A-Fa-f:.]{2,45}"
  public static let version = "[0-9]+\\.[0-9]+\\.[0-9]+"
  /// Eight letters from 24 (no I or O), with a hyphen in the middle (`consentCodeSchema`).
  public static let consentCode = "[A-HJ-NP-Z]{4}-[A-HJ-NP-Z]{4}"
  /// z.iso.datetime(): UTC with a Z, optional fraction, no offset.
  public static let isoDateTime = "[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]+)?Z"
}

public enum ISOTime {
  public static func parse(_ text: String) -> Date? {
    guard matches(text, Patterns.isoDateTime) else { return nil }
    let withFraction = ISO8601DateFormatter()
    withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let plain = ISO8601DateFormatter()
    plain.formatOptions = [.withInternetDateTime]
    return withFraction.date(from: text) ?? plain.date(from: text)
  }

  /// As JavaScript's `toISOString`: milliseconds and a Z.
  public static func format(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: date)
  }
}

public struct Fields {
  public let path: String
  private let entries: [String: JSONValue]

  public init(_ value: JSONValue, path: String, required: [String], optional: [String] = []) throws {
    guard let object = value.object else { throw SchemaError(path, "expected an object") }
    // Keys compare by UTF-16 code units, as JavaScript does: Swift's String == would take a
    // canonically equivalent spelling (a Kelvin sign for K) as the same key (red team 10).
    var map: [String: JSONValue] = [:]
    let allowed = Dictionary(uniqueKeysWithValues: (required + optional).map { (Array($0.utf16), $0) })
    for (key, item) in object {
      guard let name = allowed[Array(key.utf16)] else { throw SchemaError(path, "unknown key \(key)") }
      map[name] = item
    }
    for key in required where map[key] == nil { throw SchemaError(path, "missing \(key)") }
    self.path = path
    self.entries = map
  }

  public func has(_ key: String) -> Bool { entries[key] != nil }

  public func raw(_ key: String) throws -> JSONValue {
    guard let value = entries[key] else { throw SchemaError("\(path).\(key)", "missing") }
    return value
  }

  public func string(_ key: String, pattern: String? = nil, min: Int = 0, max: Int? = nil) throws -> String {
    guard let value = try raw(key).string else { throw SchemaError("\(path).\(key)", "expected a string") }
    try Fields.check(value, at: "\(path).\(key)", pattern: pattern, min: min, max: max)
    return value
  }

  public static func check(_ value: String, at path: String, pattern: String?, min: Int, max: Int?) throws {
    let length = value.utf16.count
    if length < min { throw SchemaError(path, "too short") }
    if let max, length > max { throw SchemaError(path, "too long") }
    if let pattern, !matches(value, pattern) { throw SchemaError(path, "doesn't match \(pattern)") }
  }

  public func optionalString(_ key: String, pattern: String? = nil, max: Int? = nil) throws -> String? {
    try (has(key) ? string(key, pattern: pattern, max: max) : nil)
  }

  public func nullableString(_ key: String, pattern: String? = nil, max: Int? = nil) throws -> String? {
    if try raw(key).isNull { return nil }
    return try string(key, pattern: pattern, max: max)
  }

  public func display(_ key: String, max: Int) throws -> String {
    let value = try string(key)
    guard DisplayText.isValid(value, max: max) else { throw SchemaError("\(path).\(key)", "not display text") }
    return value
  }

  public func nullableDisplay(_ key: String, max: Int) throws -> String? {
    if try raw(key).isNull { return nil }
    return try display(key, max: max)
  }

  public func literal(_ key: String, _ expected: String) throws {
    guard try raw(key).string == expected else { throw SchemaError("\(path).\(key)", "expected \(expected)") }
  }

  public func literal(_ key: String, _ expected: Int) throws {
    guard try raw(key).int == expected else { throw SchemaError("\(path).\(key)", "expected \(expected)") }
  }

  public func oneOf(_ key: String, _ options: [String]) throws -> String {
    let value = try string(key)
    guard options.contains(value) else { throw SchemaError("\(path).\(key)", "not one of \(options)") }
    return value
  }

  public func int(_ key: String, min: Int? = nil, max: Int? = nil) throws -> Int {
    guard let value = try raw(key).int else { throw SchemaError("\(path).\(key)", "expected an integer") }
    if let min, value < min { throw SchemaError("\(path).\(key)", "below \(min)") }
    if let max, value > max { throw SchemaError("\(path).\(key)", "above \(max)") }
    return value
  }

  public func bool(_ key: String) throws -> Bool {
    guard let value = try raw(key).bool else { throw SchemaError("\(path).\(key)", "expected a boolean") }
    return value
  }

  public func dateTime(_ key: String) throws -> Date {
    let text = try string(key)
    guard let date = ISOTime.parse(text) else { throw SchemaError("\(path).\(key)", "not an ISO date-time") }
    return date
  }

  /// z.url({ protocol: /^https$/ }): parses as a URL with a host, scheme https.
  public func httpsURL(_ key: String, max: Int? = nil) throws -> String {
    let text = try string(key, max: max)
    try Fields.checkHTTPS(text, at: "\(path).\(key)")
    return text
  }

  public static func checkHTTPS(_ text: String, at path: String) throws {
    guard let url = URL(string: text), url.scheme == "https", let host = url.host, !host.isEmpty else {
      throw SchemaError(path, "not an https URL")
    }
  }

  public func array<T>(_ key: String, min: Int = 0, max: Int, _ item: (JSONValue, String) throws -> T) throws -> [T] {
    guard let items = try raw(key).array else { throw SchemaError("\(path).\(key)", "expected an array") }
    if items.count < min { throw SchemaError("\(path).\(key)", "too few") }
    if items.count > max { throw SchemaError("\(path).\(key)", "too many") }
    return try items.enumerated().map { try item($0.element, "\(path).\(key)[\($0.offset)]") }
  }

  public func strings(_ key: String, min: Int = 0, max: Int, pattern: String? = nil, itemMax: Int? = nil) throws -> [String] {
    try array(key, min: min, max: max) { value, at in
      guard let text = value.string else { throw SchemaError(at, "expected a string") }
      try Fields.check(text, at: at, pattern: pattern, min: 0, max: itemMax)
      return text
    }
  }

  public func displays(_ key: String, min: Int = 0, max: Int, itemMax: Int) throws -> [String] {
    try array(key, min: min, max: max) { value, at in
      guard let text = value.string, DisplayText.isValid(text, max: itemMax) else {
        throw SchemaError(at, "not display text")
      }
      return text
    }
  }
}
