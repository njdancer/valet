// What the Mac's approval helper (valet-approver) will sign, checked before the Touch ID prompt is
// shown (docs/approval-broker.md#approving-at-the-mac).
//
// The helper is told the request text and the decision payload. It refuses unless the payload is
// an approval of exactly that request (its id and its digest), and it writes the prompt's reason
// itself from the request, in the app's words: a caller can't put words of its own in front of the
// person's finger. The wording matches apps/desktop/src/main/core/approvals/prompts.ts; one contract
// suite runs against both.

import CryptoKit
import Foundation

public let approvalRequestDomain = "valet/approval-request/v1"
public let approvalDecisionDomain = "valet/approval-decision/v1"

/// macOS shows the reason after "Valet is trying to", so each starts with a verb.
let approvalActions: [String: String] = [
  "adapter-install": "approve an adapter",
  "secret-grant": "let an adapter use your login",
  "tool-enable": "turn on a tool",
  "remote-client": "let a remote agent connect",
  "setting": "change a setting",
  "authoring-session": "let an agent use a signed-in session",
  "private-network": "let an agent's scratch browser reach your home network",
  "irreversible-call": "confirm something that can't be undone",
  "resume": "resume Valet",
  "device-pair": "pair a new device",
]

/// SHA-256 hex of `<domain>\n<payload>`, as core's domainDigest.
public func domainDigest(_ domain: String, _ payload: String) -> String {
  SHA256.hash(data: Data("\(domain)\n\(payload)".utf8)).map { String(format: "%02x", $0) }.joined()
}

public struct ApprovalToSign: Equatable {
  /// The bytes to sign: the decision domain, a newline, the payload.
  public let input: Data
  /// The OS prompt's reason.
  public let reason: String
}

/// Nil unless `payload` approves exactly the request `requestText` is, on this Mac, by this device.
public func approvalToSign(requestText: String, payload: String, deviceId: String) -> ApprovalToSign? {
  guard
    let request = jsonObject(requestText),
    let decision = jsonObject(payload),
    let kind = request["kind"] as? String,
    let action = approvalActions[kind],
    let requestId = request["id"] as? String,
    let macId = request["macId"] as? String,
    decision["v"] as? Int == 1,
    decision["decision"] as? String == "approve",
    decision["requestId"] as? String == requestId,
    decision["macId"] as? String == macId,
    decision["deviceId"] as? String == deviceId,
    macId == deviceId
  else { return nil }
  let digest = domainDigest(approvalRequestDomain, requestText)
  guard decision["requestDigest"] as? String == digest else { return nil }
  let ref = String(digest.prefix(4)).uppercased()
  let subject = request["subject"] as? [String: Any] ?? [:]
  let reason = "\(action)\(detail(kind: kind, subject: subject)) (request \(ref))"
  return ApprovalToSign(input: Data("\(approvalDecisionDomain)\n\(payload)".utf8), reason: reason)
}

func detail(kind: String, subject: [String: Any]) -> String {
  switch kind {
  case "adapter-install":
    if subject["unsandboxed"] as? Bool == true { return " that runs without the sandbox" }
    let changes = subject["changes"] as? [[String: Any]] ?? []
    for change in changes {
      guard let area = change["area"] as? String, area == "navigation" || area == "egress",
        change["change"] as? String != "removed"
      else { continue }
      for item in change["items"] as? [String] ?? [] {
        if let host = hostOf(item) { return " that reaches \(host)" }
      }
    }
    return ""
  case "tool-enable":
    let tool = subject["tool"] as? String ?? ""
    let scope = subject["scope"] as? String == "remote" ? "for remote use" : "on this Mac"
    return " (\(tool), \(scope))"
  case "private-network":
    let address = subject["address"] as? String ?? ""
    if let port = subject["port"] as? Int { return " (\(address) port \(port))" }
    return " (\(address))"
  case "secret-grant":
    let hosts = (subject["origins"] as? [String] ?? []).compactMap(hostOf)
    return " on \(hosts.joined(separator: ", "))"
  default:
    return ""
  }
}

/// The host (and port) of an https origin or URL; a bare host name as it is; nil for anything else.
func hostOf(_ item: String) -> String? {
  if let components = URLComponents(string: item), components.scheme != nil {
    guard components.scheme == "https", let host = components.host, !host.isEmpty else { return nil }
    if let port = components.port, port != 443 { return "\(host):\(port)" }
    return host
  }
  let allowed = item.utf8.allSatisfy {
    ($0 >= 0x61 && $0 <= 0x7A) || ($0 >= 0x30 && $0 <= 0x39) || $0 == 0x2E || $0 == 0x2D
  }
  return allowed && (1...253).contains(item.utf8.count) ? item : nil
}

func jsonObject(_ text: String) -> [String: Any]? {
  guard let data = text.data(using: .utf8) else { return nil }
  return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
}

/// base64url without padding, as core's keys and signatures.
public func base64url(_ data: Data) -> String {
  data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
    .replacingOccurrences(of: "=", with: "")
}

/// The first 128 bits of the SHA-256 of a key's SPKI DER, in hex, as core's keyId.
public func keyId(spki: Data) -> String {
  SHA256.hash(data: spki).prefix(16).map { String(format: "%02x", $0) }.joined()
}
