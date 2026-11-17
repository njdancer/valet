import Foundation
import ValetPhoneCore

/// The hub over HTTPS (URLSession). The hub only stores and hands out the account's list; the
/// phone checks every change on it itself (AccountModel).
@MainActor
final class URLSessionHubTransport: HubTransport {
  private let session: URLSession

  init() {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = 20
    configuration.httpCookieAcceptPolicy = .never
    configuration.httpShouldSetCookies = false
    session = URLSession(configuration: configuration)
  }

  func post(_ url: String, body: String) async throws -> HubResponse {
    guard let target = URL(string: url) else { throw URLError(.badURL) }
    var request = URLRequest(url: target)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    request.httpBody = Data(body.utf8)
    let (data, response) = try await session.data(for: request)
    guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
    // The hub's answers are small; anything bigger isn't one.
    guard data.count <= 512 * 1024 else { throw URLError(.dataLengthExceedsMaximum) }
    return HubResponse(status: http.statusCode, body: String(decoding: data, as: UTF8.self))
  }
}
