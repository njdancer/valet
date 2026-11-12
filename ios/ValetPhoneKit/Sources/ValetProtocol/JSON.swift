// A strict JSON parser and the canonical serialiser (packages/core/src/hash.ts, canonicalJson).
//
// Strict because the Mac's zod schemas are `.strict()`: unknown keys are refused, and Foundation's
// JSONDecoder silently ignores them. This parser also refuses duplicate keys, which JSON.parse
// would resolve by taking the last; a phone that rendered the first would show something other than
// what the Mac checks. It keeps object keys in order and numbers as their source text.

import Foundation

public indirect enum JSONValue: Equatable, Sendable {
  case null
  case bool(Bool)
  /// The number as written, so integers survive exactly. `int` reads it.
  case number(String)
  case string(String)
  case array([JSONValue])
  /// Keys in source order. Never two equal keys.
  case object([(String, JSONValue)])

  public static func == (lhs: JSONValue, rhs: JSONValue) -> Bool {
    switch (lhs, rhs) {
    case (.null, .null): return true
    case let (.bool(a), .bool(b)): return a == b
    case let (.number(a), .number(b)): return a == b
    case let (.string(a), .string(b)): return a == b
    case let (.array(a), .array(b)): return a == b
    case let (.object(a), .object(b)):
      return a.count == b.count && zip(a, b).allSatisfy { $0.0 == $1.0 && $0.1 == $1.1 }
    default: return false
    }
  }

  public var string: String? { if case let .string(s) = self { return s } else { return nil } }
  public var bool: Bool? { if case let .bool(b) = self { return b } else { return nil } }
  public var array: [JSONValue]? { if case let .array(a) = self { return a } else { return nil } }
  public var object: [(String, JSONValue)]? { if case let .object(o) = self { return o } else { return nil } }
  public var isNull: Bool { if case .null = self { return true } else { return false } }

  /// An integer with no fraction or exponent, within ±2^53, as JavaScript would hold it exactly.
  public var int: Int? {
    guard case let .number(text) = self else { return nil }
    guard text.allSatisfy({ $0 == "-" || $0.isASCII && $0.isNumber }) else { return nil }
    guard let value = Int(text), abs(value) <= 9_007_199_254_740_991 else { return nil }
    return value
  }
}

public enum JSONError: Error, Equatable {
  case syntax(offset: Int)
  case duplicateKey(String)
  case tooDeep
  case tooLarge
}

public enum JSON {
  public static let maxDepth = 32
  public static let maxBytes = 256 * 1024

  public static func parse(_ text: String) throws -> JSONValue {
    let bytes = Array(text.utf8)
    if bytes.count > maxBytes { throw JSONError.tooLarge }
    var parser = Parser(bytes: bytes)
    parser.skipWhitespace()
    let value = try parser.value(depth: 0)
    parser.skipWhitespace()
    if parser.index != bytes.count { throw JSONError.syntax(offset: parser.index) }
    return value
  }

  /// JSON.stringify of the value with object keys sorted, as canonicalJson does in core.
  public static func canonical(_ value: JSONValue) -> String {
    var out = ""
    write(value, sorted: true, into: &out)
    return out
  }

  /// JSON.stringify of the value with keys in their given order.
  public static func serialize(_ value: JSONValue) -> String {
    var out = ""
    write(value, sorted: false, into: &out)
    return out
  }

  private static func write(_ value: JSONValue, sorted: Bool, into out: inout String) {
    switch value {
    case .null: out += "null"
    case let .bool(b): out += b ? "true" : "false"
    case let .number(n): out += n
    case let .string(s): writeString(s, into: &out)
    case let .array(items):
      out += "["
      for (i, item) in items.enumerated() {
        if i > 0 { out += "," }
        write(item, sorted: sorted, into: &out)
      }
      out += "]"
    case let .object(entries):
      // JavaScript's default sort compares UTF-16 code units.
      let ordered = sorted ? entries.sorted { Array($0.0.utf16).lexicographicallyPrecedes(Array($1.0.utf16)) } : entries
      out += "{"
      for (i, entry) in ordered.enumerated() {
        if i > 0 { out += "," }
        writeString(entry.0, into: &out)
        out += ":"
        write(entry.1, sorted: sorted, into: &out)
      }
      out += "}"
    }
  }

  /// The escaping JSON.stringify uses: the short escapes, \u00XX for other controls, nothing else.
  private static func writeString(_ s: String, into out: inout String) {
    out += "\""
    for scalar in s.unicodeScalars {
      switch scalar {
      case "\"": out += "\\\""
      case "\\": out += "\\\\"
      case "\u{08}": out += "\\b"
      case "\u{0C}": out += "\\f"
      case "\n": out += "\\n"
      case "\r": out += "\\r"
      case "\t": out += "\\t"
      default:
        if scalar.value < 0x20 {
          out += String(format: "\\u%04x", scalar.value)
        } else {
          out.unicodeScalars.append(scalar)
        }
      }
    }
    out += "\""
  }

  private struct Parser {
    let bytes: [UInt8]
    var index = 0

    init(bytes: [UInt8]) { self.bytes = bytes }

    mutating func skipWhitespace() {
      while index < bytes.count, [0x20, 0x09, 0x0A, 0x0D].contains(bytes[index]) { index += 1 }
    }

    func fail() -> JSONError { .syntax(offset: index) }

    mutating func expect(_ literal: String) throws {
      for byte in literal.utf8 {
        guard index < bytes.count, bytes[index] == byte else { throw fail() }
        index += 1
      }
    }

    mutating func value(depth: Int) throws -> JSONValue {
      if depth > JSON.maxDepth { throw JSONError.tooDeep }
      guard index < bytes.count else { throw fail() }
      switch bytes[index] {
      case UInt8(ascii: "{"): return try object(depth: depth)
      case UInt8(ascii: "["): return try array(depth: depth)
      case UInt8(ascii: "\""): return .string(try string())
      case UInt8(ascii: "t"): try expect("true"); return .bool(true)
      case UInt8(ascii: "f"): try expect("false"); return .bool(false)
      case UInt8(ascii: "n"): try expect("null"); return .null
      default: return .number(try number())
      }
    }

    mutating func object(depth: Int) throws -> JSONValue {
      index += 1
      var entries: [(String, JSONValue)] = []
      var seen = Set<[UInt16]>()
      skipWhitespace()
      if index < bytes.count, bytes[index] == UInt8(ascii: "}") { index += 1; return .object([]) }
      while true {
        skipWhitespace()
        guard index < bytes.count, bytes[index] == UInt8(ascii: "\"") else { throw fail() }
        let key = try string()
        // Compare as JavaScript does: by code units, so precomposed and decomposed forms differ.
        if !seen.insert(Array(key.utf16)).inserted { throw JSONError.duplicateKey(key) }
        skipWhitespace()
        try expect(":")
        skipWhitespace()
        entries.append((key, try value(depth: depth + 1)))
        skipWhitespace()
        guard index < bytes.count else { throw fail() }
        if bytes[index] == UInt8(ascii: ",") { index += 1; continue }
        if bytes[index] == UInt8(ascii: "}") { index += 1; return .object(entries) }
        throw fail()
      }
    }

    mutating func array(depth: Int) throws -> JSONValue {
      index += 1
      var items: [JSONValue] = []
      skipWhitespace()
      if index < bytes.count, bytes[index] == UInt8(ascii: "]") { index += 1; return .array([]) }
      while true {
        skipWhitespace()
        items.append(try value(depth: depth + 1))
        skipWhitespace()
        guard index < bytes.count else { throw fail() }
        if bytes[index] == UInt8(ascii: ",") { index += 1; continue }
        if bytes[index] == UInt8(ascii: "]") { index += 1; return .array(items) }
        throw fail()
      }
    }

    mutating func number() throws -> String {
      let start = index
      if index < bytes.count, bytes[index] == UInt8(ascii: "-") { index += 1 }
      guard index < bytes.count, isDigit(bytes[index]) else { throw fail() }
      if bytes[index] == UInt8(ascii: "0") {
        index += 1
      } else {
        while index < bytes.count, isDigit(bytes[index]) { index += 1 }
      }
      if index < bytes.count, bytes[index] == UInt8(ascii: ".") {
        index += 1
        guard index < bytes.count, isDigit(bytes[index]) else { throw fail() }
        while index < bytes.count, isDigit(bytes[index]) { index += 1 }
      }
      if index < bytes.count, bytes[index] == UInt8(ascii: "e") || bytes[index] == UInt8(ascii: "E") {
        index += 1
        if index < bytes.count, bytes[index] == UInt8(ascii: "+") || bytes[index] == UInt8(ascii: "-") { index += 1 }
        guard index < bytes.count, isDigit(bytes[index]) else { throw fail() }
        while index < bytes.count, isDigit(bytes[index]) { index += 1 }
      }
      return String(decoding: bytes[start..<index], as: UTF8.self)
    }

    func isDigit(_ b: UInt8) -> Bool { b >= 0x30 && b <= 0x39 }

    mutating func hex4() throws -> UInt32 {
      guard index + 4 <= bytes.count else { throw fail() }
      var value: UInt32 = 0
      for _ in 0..<4 {
        let b = bytes[index]
        let digit: UInt32
        switch b {
        case 0x30...0x39: digit = UInt32(b - 0x30)
        case 0x41...0x46: digit = UInt32(b - 0x41 + 10)
        case 0x61...0x66: digit = UInt32(b - 0x61 + 10)
        default: throw fail()
        }
        value = value * 16 + digit
        index += 1
      }
      return value
    }

    mutating func string() throws -> String {
      index += 1
      var scalars = String.UnicodeScalarView()
      var run: [UInt8] = []
      func flush() throws {
        if run.isEmpty { return }
        guard let text = String(bytes: run, encoding: .utf8) else { throw JSONError.syntax(offset: -1) }
        scalars.append(contentsOf: text.unicodeScalars)
        run.removeAll(keepingCapacity: true)
      }
      while true {
        guard index < bytes.count else { throw fail() }
        let b = bytes[index]
        if b == UInt8(ascii: "\"") {
          try flush()
          index += 1
          return String(scalars)
        }
        if b < 0x20 { throw fail() }
        if b != UInt8(ascii: "\\") {
          run.append(b)
          index += 1
          continue
        }
        try flush()
        index += 1
        guard index < bytes.count else { throw fail() }
        let escape = bytes[index]
        index += 1
        switch escape {
        case UInt8(ascii: "\""): scalars.append("\"")
        case UInt8(ascii: "\\"): scalars.append("\\")
        case UInt8(ascii: "/"): scalars.append("/")
        case UInt8(ascii: "b"): scalars.append("\u{08}")
        case UInt8(ascii: "f"): scalars.append("\u{0C}")
        case UInt8(ascii: "n"): scalars.append("\n")
        case UInt8(ascii: "r"): scalars.append("\r")
        case UInt8(ascii: "t"): scalars.append("\t")
        case UInt8(ascii: "u"):
          let first = try hex4()
          if (0xD800...0xDBFF).contains(first) {
            // A high surrogate must be followed by an escaped low one; lone surrogates are refused.
            guard index + 2 <= bytes.count, bytes[index] == UInt8(ascii: "\\"), bytes[index + 1] == UInt8(ascii: "u") else {
              throw fail()
            }
            index += 2
            let second = try hex4()
            guard (0xDC00...0xDFFF).contains(second) else { throw fail() }
            let combined = 0x10000 + ((first - 0xD800) << 10) + (second - 0xDC00)
            guard let scalar = Unicode.Scalar(combined) else { throw fail() }
            scalars.append(scalar)
          } else {
            guard let scalar = Unicode.Scalar(first) else { throw fail() }
            scalars.append(scalar)
          }
        default: throw fail()
        }
      }
    }
  }
}
