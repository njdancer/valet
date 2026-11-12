import Foundation
import ValetPhoneCore

/// The relay over a WebSocket (URLSessionWebSocketTask). The relay only forwards sealed envelopes;
/// everything that matters is checked by PhoneModel. Until G's relay exists this is untested against
/// a real server, so the app's journeys run on the fake relay.
@MainActor
final class WebSocketRelayTransport: RelayTransport {
  func connect(
    relay: String, path: RelayPath, onFrame: @escaping @MainActor (String) -> Void,
    onClose: @escaping @MainActor () -> Void
  ) -> RelayConnection {
    WebSocketConnection(relay: relay, path: path, onFrame: onFrame, onClose: onClose)
  }
}

@MainActor
final class WebSocketConnection: RelayConnection {
  private var task: URLSessionWebSocketTask?
  private let onFrame: @MainActor (String) -> Void
  private let onClose: @MainActor () -> Void
  private var closed = false

  init(relay: String, path: RelayPath, onFrame: @escaping @MainActor (String) -> Void, onClose: @escaping @MainActor () -> Void) {
    self.onFrame = onFrame
    self.onClose = onClose
    // Only https relays: the pairing offer refuses anything else, so this is wss.
    guard var components = URLComponents(string: relay), components.scheme == "https" else {
      closed = true
      Task { @MainActor in onClose() }
      return
    }
    components.scheme = "wss"
    components.path = path.rawValue
    guard let url = components.url else {
      closed = true
      Task { @MainActor in onClose() }
      return
    }
    let task = URLSession.shared.webSocketTask(with: url)
    task.maximumMessageSize = 512 * 1024
    self.task = task
    task.resume()
    receive()
  }

  private func receive() {
    task?.receive { [weak self] result in
      Task { @MainActor in
        guard let self, !self.closed else { return }
        switch result {
        case let .success(.string(text)):
          self.onFrame(text)
          self.receive()
        case .success:
          // Binary frames aren't part of the protocol.
          self.receive()
        case .failure:
          self.finish()
        }
      }
    }
  }

  func send(_ text: String) {
    task?.send(.string(text)) { [weak self] error in
      guard error != nil else { return }
      Task { @MainActor in self?.finish() }
    }
  }

  func close() {
    closed = true
    task?.cancel(with: .normalClosure, reason: nil)
    task = nil
  }

  private func finish() {
    guard !closed else { return }
    closed = true
    task?.cancel()
    task = nil
    onClose()
  }
}
