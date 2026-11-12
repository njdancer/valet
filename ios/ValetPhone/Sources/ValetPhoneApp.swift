import SwiftUI
import ValetPhoneCore

@main
struct ValetPhoneApp: App {
  @State private var host = AppHost()

  var body: some Scene {
    WindowGroup {
      AppRoot(host: host)
    }
  }
}

/// A cover over the app switcher snapshot, and the one-second clock that moves deadlines along.
/// No Face ID to open: approvals exist to limit what agents can do, and an agent can't open the
/// phone (Nick, 2026-11-12). Each approval still asks for Face ID or the passcode.
struct AppRoot: View {
  let host: AppHost
  @Environment(\.scenePhase) private var scenePhase

  var body: some View {
    ZStack {
      RootView(model: host.model, host: host)
        .opacity(scenePhase == .active ? 1 : 0)
      if scenePhase != .active {
        Color(.systemBackground).ignoresSafeArea()
      }
    }
    .task {
      var seconds = 0
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(1))
        host.model.tick()
        seconds += 1
        // Reconnect after the relay dropped us; connect() does nothing while a connection is open.
        if seconds % 5 == 0, scenePhase == .active { host.model.connect() }
      }
    }
    .onChange(of: scenePhase) { _, phase in
      switch phase {
      case .background: host.model.disconnect()
      case .active: host.model.connect()
      default: break
      }
    }
  }
}

struct RootView: View {
  let model: PhoneModel
  let host: AppHost

  var body: some View {
    switch model.phase {
    case let .unpaired(notice):
      PairStartView(model: model, host: host, notice: notice)
    case let .pairing(step):
      PairingView(model: model, host: host, step: step)
    case .paired:
      MainTabs(model: model)
    }
  }
}
