// The bridge itself: a port of packages/mcp-server/src/bridge.ts. It relays JSON-RPC unchanged in
// both directions, so the client's own initialize (and its name) reach the endpoint, and adds only
// the bearer token and the transport label. When the session ends under a running client, it
// re-reads the config file, replays the client's initialize into a new session, and tells the
// client to re-list its tools. Every client request gets exactly one answer.

import Foundation

/// JSON-RPC's implementation-defined server error range starts here.
private let bridgeErrorCode = -32000
private let reconnectTimeout: Duration = .seconds(10)
/// Ids for the bridge's own requests; answers to them are never passed to the client.
private let ownIdPrefix = "valet-bridge-"
private let sessionEnded = "the Valet session ended before this request was answered"
let transportHeader = "x-valet-transport"
let bridgeTransport = "stdio-bridge"

/// An HTTP status the endpoint answered with, or nil when it couldn't be reached at all.
struct UpstreamError: Error {
  let status: Int?
}

struct ReconnectFailed: Error {}

/// Writes whole lines to stdout, one at a time. Stdout is for protocol messages only.
final class Output: @unchecked Sendable {
  private let lock = NSLock()

  func write(_ data: Data) {
    lock.lock()
    defer { lock.unlock() }
    try? FileHandle.standardOutput.write(contentsOf: data)
  }
}

actor Bridge {
  private let output: Output
  private let reconnect: () throws -> BridgeTarget
  private let session: URLSession

  private var target: BridgeTarget
  private var sessionId: String?
  private var protocolVersion: String?
  /// Bumped for every new upstream session, so a listener of an old one stops.
  private var generation = 0
  private var closing = false

  /// Client requests relayed upstream and not yet answered, with the id as the client wrote it.
  private var pending: [RequestId: Any] = [:]
  private var initializeIds = Set<RequestId>()
  /// The bridge's own requests, waiting for their answer.
  private var own: [RequestId: Waiter] = [:]
  private var ownCount = 0
  private var clientInitialize: Message?
  /// Set while the upstream session is not one the client's initialize set up: a reopen that failed
  /// part-way leaves a session nothing has initialized, which must not be sent to.
  private var stale = false

  init(target: BridgeTarget, output: Output, reconnect: @escaping () throws -> BridgeTarget) {
    self.target = target
    self.output = output
    self.reconnect = reconnect
    let configuration = URLSessionConfiguration.ephemeral
    // Never a proxy: the token goes to 127.0.0.1 and nowhere else.
    configuration.connectionProxyDictionary = [:]
    configuration.httpCookieStorage = nil
    configuration.urlCache = nil
    configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
    // A tool call can wait minutes for the person (a login, a confirmation) with no bytes sent.
    configuration.timeoutIntervalForRequest = 24 * 60 * 60
    configuration.timeoutIntervalForResource = 7 * 24 * 60 * 60
    configuration.httpMaximumConnectionsPerHost = 16
    self.session = URLSession(configuration: configuration)
  }

  // MARK: From the client

  /// One line from the client. Lines are handled one at a time, in order.
  func relayUp(_ line: Data) async {
    // A malformed line has no id to answer, and stdout is not for diagnostics.
    guard let message = Message(raw: line) else { return }
    let requestId = message.isRequest ? message.id : nil
    if let requestId { pending[requestId] = message.object["id"] }
    if message.isInitialize, let requestId { initializeIds.insert(requestId) }
    // A cancelled request gets no answer from the endpoint, and must not get one from here later.
    if let cancelled = message.cancelledRequestId { pending.removeValue(forKey: cancelled) }
    do {
      if stale && !message.isInitialize { _ = try await tryReopen(retrying: requestId) }
      do {
        try await send(message)
      } catch {
        if message.isInitialize || !restartLike(error) { throw error }
        guard try await tryReopen(retrying: requestId) else { throw error }
        try await send(message)
      }
      if message.isInitialize { clientInitialize = message }
    } catch {
      // A notification has no one to answer; a request must get a reply or the client hangs.
      if let requestId { failRequest(requestId, describeFailure(error)) }
    }
  }

  /// The client went away: end the session upstream and answer anything still waiting.
  func close() async {
    closing = true
    generation += 1
    if let sessionId {
      var request = baseRequest(method: "DELETE")
      request.setValue(sessionId, forHTTPHeaderField: "mcp-session-id")
      _ = try? await session.data(for: request)
    }
    failPending(except: nil)
    session.invalidateAndCancel()
  }

  // MARK: To the endpoint

  private func send(_ message: Message) async throws {
    let ids = message.isRequest ? [message.id].compactMap { $0 } : []
    try await post(message.raw, ids: ids)
    if message.method == "notifications/initialized" { listen() }
  }

  /// POSTs one message. Returns once the response has started: results stream back over SSE, so a
  /// slow tool call doesn't hold up the next message.
  private func post(_ body: Data, ids: [RequestId]) async throws {
    var request = baseRequest(method: "POST")
    request.httpBody = body
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    request.setValue("application/json, text/event-stream", forHTTPHeaderField: "accept")
    if let sessionId { request.setValue(sessionId, forHTTPHeaderField: "mcp-session-id") }
    let bytes: URLSession.AsyncBytes
    let response: URLResponse
    do {
      (bytes, response) = try await session.bytes(for: request)
    } catch {
      throw UpstreamError(status: nil)
    }
    guard let http = response as? HTTPURLResponse else { throw UpstreamError(status: nil) }
    if let id = http.value(forHTTPHeaderField: "mcp-session-id") { sessionId = id }
    guard (200..<300).contains(http.statusCode) else {
      bytes.task.cancel()
      throw UpstreamError(status: http.statusCode)
    }
    let type = http.value(forHTTPHeaderField: "content-type") ?? ""
    if type.contains("text/event-stream") {
      Task { await self.read(events: bytes, answering: ids, generation: nil) }
    } else if type.contains("application/json") {
      var data = Data()
      do {
        for try await byte in bytes { data.append(byte) }
      } catch {}
      for message in messagesIn(json: data) { deliver(message) }
      streamEnded(ids)
    } else {
      bytes.task.cancel()
    }
  }

  /// Opens the session's standalone event stream, for notifications that answer no request (the
  /// endpoint's tools/list_changed). Retried a little when it drops; a refusal ends it.
  private func listen() {
    let mine = generation
    Task {
      var failures = 0
      while await self.isCurrent(mine), failures <= 2 {
        guard let request = await self.listenRequest() else { return }
        do {
          let (bytes, response) = try await self.session.bytes(for: request)
          guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            bytes.task.cancel()
            return
          }
          failures = 0
          await self.read(events: bytes, answering: [], generation: mine)
        } catch {
          failures += 1
        }
        try? await Task.sleep(for: .seconds(1))
      }
    }
  }

  private func isCurrent(_ mine: Int) -> Bool { !closing && generation == mine }

  private func listenRequest() -> URLRequest? {
    guard let sessionId else { return nil }
    var request = baseRequest(method: "GET")
    request.setValue("text/event-stream", forHTTPHeaderField: "accept")
    request.setValue(sessionId, forHTTPHeaderField: "mcp-session-id")
    return request
  }

  /// Reads a response stream's events until it ends, then answers whatever it was opened for and
  /// never answered.
  private nonisolated func read(events bytes: URLSession.AsyncBytes, answering ids: [RequestId], generation: Int?)
    async
  {
    var parser = EventParser()
    do {
      for try await byte in bytes {
        if let mine = generation, await !isCurrent(mine) { break }
        for data in parser.feed([byte]) {
          if let message = Message(raw: data) { await deliver(message) }
        }
      }
    } catch {}
    bytes.task.cancel()
    await streamEnded(ids)
  }

  private func baseRequest(method: String) -> URLRequest {
    var request = URLRequest(url: target.url)
    request.httpMethod = method
    request.setValue("Bearer \(target.token)", forHTTPHeaderField: "authorization")
    // A label for the person: it changes nothing the endpoint allows.
    request.setValue(bridgeTransport, forHTTPHeaderField: transportHeader)
    if let protocolVersion { request.setValue(protocolVersion, forHTTPHeaderField: "mcp-protocol-version") }
    return request
  }

  // MARK: From the endpoint

  private func deliver(_ message: Message) {
    if message.isResponse {
      // Without an id nothing can be matched, and the client asked for nothing it could match.
      guard let id = message.id else { return }
      if let waiting = own.removeValue(forKey: id) { return waiting.settle(.success(message)) }
      // Already answered with an error; a second answer would confuse the client.
      guard pending.removeValue(forKey: id) != nil else { return }
      if message.isResult, initializeIds.remove(id) != nil, let version = message.protocolVersion {
        protocolVersion = version
      }
    }
    sendDown(message.line)
  }

  private func streamEnded(_ ids: [RequestId]) {
    for id in ids {
      own.removeValue(forKey: id)?.settle(.failure(ReconnectFailed()))
      failRequest(id, sessionEnded)
    }
  }

  private func sendDown(_ line: Data) {
    output.write(line)
  }

  /// Answers a client request with fixed text, unless it has been answered already.
  private func failRequest(_ id: RequestId, _ text: String) {
    guard let original = pending.removeValue(forKey: id) else { return }
    let error: [String: Any] = ["code": bridgeErrorCode, "message": text]
    var line = encode(["jsonrpc": "2.0", "id": original, "error": error])
    line.append(0x0A)
    sendDown(line)
  }

  /// The session these requests went to is gone, so nothing upstream will answer them.
  private func failPending(except retrying: RequestId?) {
    for id in pending.keys where id != retrying { failRequest(id, sessionEnded) }
  }

  // MARK: Reconnecting

  /// Reopens when the client has a session to rebuild. False when there is none.
  private func tryReopen(retrying: RequestId?) async throws -> Bool {
    guard let initialize = clientInitialize else { return false }
    try await reopen(initialize, retrying: retrying)
    return true
  }

  /// Starts a new upstream session that looks, to the endpoint, like the client's own.
  private func reopen(_ initialize: Message, retrying: RequestId?) async throws {
    stale = true
    // Whatever else was in flight went to the old session; only the request being retried lives on.
    failPending(except: retrying)
    let next = try reconnect()
    generation += 1
    target = next
    sessionId = nil
    protocolVersion = nil
    let response = try await ownRequest(initialize)
    guard response.isResult else { throw ReconnectFailed() }
    if let version = response.protocolVersion { protocolVersion = version }
    try await post(encode(["jsonrpc": "2.0", "method": "notifications/initialized"]), ids: [])
    listen()
    stale = false
    // The new session may offer different tools; the client must not trust its cached list.
    var line = encode(["jsonrpc": "2.0", "method": "notifications/tools/list_changed"])
    line.append(0x0A)
    sendDown(line)
  }

  /// Sends a request of the bridge's own and waits, within the reconnect timeout, for its answer.
  private func ownRequest(_ request: Message) async throws -> Message {
    ownCount += 1
    let idText = "\(ownIdPrefix)\(ownCount)"
    let id = RequestId.string(idText)
    var object = request.object
    object["id"] = idText
    let body = encode(object)
    let waiter = Waiter()
    own[id] = waiter
    Task {
      do {
        try await self.post(body, ids: [id])
      } catch {
        waiter.settle(.failure(error))
      }
    }
    Task {
      try? await Task.sleep(for: reconnectTimeout)
      waiter.settle(.failure(ReconnectFailed()))
    }
    let result = await waiter.wait()
    own.removeValue(forKey: id)
    return try result.get()
  }
}

/// One answer, from whichever comes first: the endpoint, a failed send, or the timeout.
final class Waiter: @unchecked Sendable {
  private let lock = NSLock()
  private var result: Result<Message, Error>?
  private var waiting: CheckedContinuation<Result<Message, Error>, Never>?

  func settle(_ value: Result<Message, Error>) {
    lock.lock()
    guard result == nil else {
      lock.unlock()
      return
    }
    result = value
    let resume = waiting
    waiting = nil
    lock.unlock()
    resume?.resume(returning: value)
  }

  func wait() async -> Result<Message, Error> {
    await withCheckedContinuation { continuation in
      lock.lock()
      if let result {
        lock.unlock()
        continuation.resume(returning: result)
      } else {
        waiting = continuation
        lock.unlock()
      }
    }
  }
}

/// What an app restart looks like from here: the old port refuses connections, the session id is
/// unknown (404), or the token changed (401). A 403 is a refusal, not a restart.
func restartLike(_ error: Error) -> Bool {
  guard let upstream = error as? UpstreamError, let status = upstream.status else { return true }
  return status == 401 || status == 404
}

/// Fixed texts only: an upstream error message could carry anything the server sent.
func describeFailure(_ error: Error) -> String {
  if let upstream = error as? UpstreamError, let status = upstream.status {
    if status == 401 { return "valet refused the bridge token; check the bridge config" }
    if status == 403 { return "valet refused the request" }
    if status == 404 { return "the Valet session has ended; restart this MCP server" }
  }
  return "valet is not reachable; make sure the app is running"
}
