// The one attributedBody decoder in the helper: the text out of a Messages message that newer macOS
// stores only as an archived NSAttributedString. MessagesAccess.swift's `message_text` SQL function
// uses it, and that function is how every read of a message's text goes, Valet's own one-time-code
// lookup included (packages/native-messages, otp.ts). A port of
// packages/native-messages/src/typedstream.ts.

import Foundation

/// The text out of an `attributedBody` (an NSAttributedString in typedstream form): the string
/// payload follows the first NSString class name as a '+' tag and a typedstream integer length.
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
