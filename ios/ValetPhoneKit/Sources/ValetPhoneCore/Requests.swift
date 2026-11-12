import Foundation
import ValetCrypto
import ValetProtocol

/// A request as the phone holds it: the parsed fields, the exact text, and that text's digest.
public struct ParsedRequest: Equatable, Sendable {
  public let request: ApprovalRequest
  public let text: String
  public let digest: String
}

public enum RequestParseFailure: Error, Equatable {
  /// A kind or version this build doesn't know: the person should update the app.
  case unknownKindOrVersion
  case malformed(String)
}

public enum Requests {
  /// `parseRequestText` in core: strict JSON, the schema, and the digest over the exact bytes.
  public static func parse(_ text: String) -> Result<ParsedRequest, RequestParseFailure> {
    let value: JSONValue
    do { value = try JSON.parse(text) } catch { return .failure(.malformed("json: \(error)")) }
    if let object = value.object {
      let v = object.first(where: { $0.0 == "v" })?.1.int
      let kind = object.first(where: { $0.0 == "kind" })?.1.string
      if v != 1 || (kind.map { ApprovalKind(rawValue: $0) == nil } ?? false) {
        return .failure(.unknownKindOrVersion)
      }
    }
    do {
      let request = try ApprovalRequest.parse(value)
      return .success(ParsedRequest(request: request, text: text, digest: Signing.digest(.approvalRequest, text)))
    } catch {
      return .failure(.malformed("\(error)"))
    }
  }
}
