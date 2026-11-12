import Foundation

public enum Base64URL {
  /// Unpadded base64url, as Node's `toString('base64url')` writes it.
  public static func encode(_ data: Data) -> String {
    data.base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  /// Decodes unpadded base64url. Nil for padding, the standard alphabet, or a length no encoder
  /// writes, so one value has one spelling.
  public static func decode(_ text: String) -> Data? {
    guard !text.isEmpty, text.utf8.allSatisfy(isAlphabet), text.count % 4 != 1 else { return nil }
    var standard = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    while standard.count % 4 != 0 { standard += "=" }
    guard let data = Data(base64Encoded: standard) else { return nil }
    // Refuse non-zero trailing bits: re-encoding must give the same text.
    return encode(data) == text ? data : nil
  }

  public static func isAlphabet(_ byte: UInt8) -> Bool {
    (byte >= 0x41 && byte <= 0x5A) || (byte >= 0x61 && byte <= 0x7A) || (byte >= 0x30 && byte <= 0x39)
      || byte == UInt8(ascii: "-") || byte == UInt8(ascii: "_")
  }
}

public enum Hex {
  public static func encode(_ data: some Sequence<UInt8>) -> String {
    data.map { String(format: "%02x", $0) }.joined()
  }

  public static func decode(_ text: String) -> Data? {
    let bytes = Array(text.utf8)
    guard bytes.count % 2 == 0 else { return nil }
    var out = Data(capacity: bytes.count / 2)
    var i = 0
    while i < bytes.count {
      guard let hi = nibble(bytes[i]), let lo = nibble(bytes[i + 1]) else { return nil }
      out.append(hi << 4 | lo)
      i += 2
    }
    return out
  }

  private static func nibble(_ b: UInt8) -> UInt8? {
    switch b {
    case 0x30...0x39: return b - 0x30
    case 0x61...0x66: return b - 0x61 + 10
    default: return nil
    }
  }
}

/// A whole-string match against an ASCII pattern, as the zod regexes in core anchor theirs.
public func matches(_ value: String, _ pattern: String) -> Bool {
  // \A and \z, because ICU's $ also matches before a final line terminator and JavaScript's doesn't.
  value.range(of: "\\A(?:\(pattern))\\z", options: .regularExpression) != nil
}
