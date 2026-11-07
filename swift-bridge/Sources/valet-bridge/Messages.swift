// JSON-RPC messages as the bridge sees them: parsed only enough to route them. Client messages go
// upstream as the exact bytes the client wrote, so nothing (an id's number form, say) is changed.

import Foundation

/// A JSON-RPC id: a string or a number. Numbers are compared by their JSON text.
enum RequestId: Hashable {
  case string(String)
  case number(String)

  init?(_ value: Any?) {
    if let text = value as? String {
      self = .string(text)
    } else if let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() {
      self = .number(number.stringValue)
    } else {
      return nil
    }
  }
}

struct Message: @unchecked Sendable {
  /// The message as it arrived, without a trailing newline.
  let raw: Data
  let object: [String: Any]

  init?(raw: Data) {
    guard let parsed = try? JSONSerialization.jsonObject(with: raw), let object = parsed as? [String: Any],
      object["jsonrpc"] as? String == "2.0"
    else { return nil }
    self.raw = raw
    self.object = object
  }

  init(object: [String: Any]) {
    self.object = object
    self.raw = encode(object)
  }

  var method: String? { object["method"] as? String }
  var id: RequestId? { RequestId(object["id"]) }
  var isRequest: Bool { method != nil && object["id"] != nil }
  var isNotification: Bool { method != nil && object["id"] == nil }
  var isResponse: Bool { method == nil && (object["result"] != nil || object["error"] != nil) }
  var isResult: Bool { method == nil && object["result"] != nil }
  var isInitialize: Bool { isRequest && method == "initialize" }

  /// For notifications/cancelled: the request the client gave up on.
  var cancelledRequestId: RequestId? {
    guard method == "notifications/cancelled", let params = object["params"] as? [String: Any] else {
      return nil
    }
    return RequestId(params["requestId"])
  }

  var protocolVersion: String? {
    (object["result"] as? [String: Any])?["protocolVersion"] as? String
  }

  /// One line for a stdio client: the raw text when it has no newline, otherwise re-encoded.
  var line: Data {
    var data = raw.contains(0x0A) || raw.contains(0x0D) ? encode(object) : raw
    data.append(0x0A)
    return data
  }
}

func encode(_ object: Any) -> Data {
  (try? JSONSerialization.data(withJSONObject: object, options: [.withoutEscapingSlashes])) ?? Data("{}".utf8)
}

/// The messages in a body the endpoint sent as application/json: one message or a batch.
func messagesIn(json data: Data) -> [Message] {
  guard let parsed = try? JSONSerialization.jsonObject(with: data) else { return [] }
  let objects: [Any] = (parsed as? [Any]) ?? [parsed]
  return objects.compactMap { object in
    guard let dictionary = object as? [String: Any], dictionary["jsonrpc"] as? String == "2.0" else { return nil }
    return Message(object: dictionary)
  }
}

/// Server-sent events: `data:` lines joined by newlines, dispatched at a blank line.
struct EventParser {
  private var data: [String] = []
  private var event = ""
  private var pending = [UInt8]()

  /// Feeds bytes; returns the data of every complete `message` event.
  mutating func feed(_ bytes: [UInt8]) -> [Data] {
    var out: [Data] = []
    for byte in bytes {
      if byte == 0x0A {
        if pending.last == 0x0D { pending.removeLast() }
        let line = String(decoding: pending, as: UTF8.self)
        pending.removeAll(keepingCapacity: true)
        if let ready = take(line) { out.append(ready) }
      } else {
        pending.append(byte)
      }
    }
    return out
  }

  private mutating func take(_ line: String) -> Data? {
    if line.isEmpty {
      defer {
        data = []
        event = ""
      }
      guard !data.isEmpty, event.isEmpty || event == "message" else { return nil }
      return Data(data.joined(separator: "\n").utf8)
    }
    if line.hasPrefix(":") { return nil }
    let field: Substring
    var value: Substring
    if let colon = line.firstIndex(of: ":") {
      field = line[..<colon]
      value = line[line.index(after: colon)...]
      if value.hasPrefix(" ") { value = value.dropFirst() }
    } else {
      field = Substring(line)
      value = ""
    }
    switch field {
    case "data": data.append(String(value))
    case "event": event = String(value)
    default: break
    }
    return nil
  }
}
