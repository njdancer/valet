import LocalAuthentication
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

/// Face ID to open, a cover over the app switcher snapshot, and the one-second clock that moves
/// deadlines along.
struct AppRoot: View {
  let host: AppHost
  @Environment(\.scenePhase) private var scenePhase
  @State private var unlocked = false
  @State private var unlockFailed = false

  var body: some View {
    ZStack {
      RootView(model: host.model, host: host)
        .opacity(showsCover ? 0 : 1)
        .accessibilityHidden(showsCover)
      if showsCover {
        LockCover(failed: unlockFailed, unlock: unlock)
      }
    }
    .task {
      if host.locksOnOpen { unlock() } else { unlocked = true }
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
      case .background:
        if host.locksOnOpen { unlocked = false }
        host.model.disconnect()
      case .active:
        host.model.connect()
        if !unlocked { unlock() }
      default:
        break
      }
    }
  }

  private var showsCover: Bool { !unlocked || scenePhase != .active }

  private func unlock() {
    guard host.locksOnOpen else {
      unlocked = true
      return
    }
    let context = LAContext()
    context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Open Valet") { ok, _ in
      Task { @MainActor in
        unlocked = ok
        unlockFailed = !ok
      }
    }
  }
}

struct LockCover: View {
  let failed: Bool
  let unlock: () -> Void

  var body: some View {
    VStack(spacing: 16) {
      Image(systemName: "lock.fill").font(.largeTitle).accessibilityHidden(true)
      Text("Valet is locked").font(.title2.bold())
      if failed {
        Button("Unlock with Face ID", action: unlock).buttonStyle(.borderedProminent)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Color(.systemBackground))
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
