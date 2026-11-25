import SwiftUI
import UIKit
import UserNotifications
import ValetPhoneCore

@main
struct ValetPhoneApp: App {
  @UIApplicationDelegateAdaptor(PushDelegate.self) private var push
  @State private var host = AppHost()

  var body: some Scene {
    WindowGroup {
      AppRoot(host: host)
        .task { push.host = host }
        .onChange(of: host.isPaired, initial: true) { _, paired in push.askIfPaired(paired) }
    }
  }
}

/// Notifications (docs/ios-app.md#notifications). The Mac wakes the phone through Apple with fixed
/// text only; tapping opens the app, which reconnects and fetches the sealed card as before.
@MainActor
final class PushDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
  var host: AppHost? {
    didSet { if let token { host?.model.pushToken = token } }
  }
  private var token: String?
  private var asked = false

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    UNUserNotificationCenter.current().delegate = self
    return true
  }

  /// Asks once a phone is paired: before then there is no Mac to wake it.
  func askIfPaired(_ paired: Bool) {
    // The fakes build has no push entitlement, and the system's permission alert would sit over
    // the screens its UI tests drive.
    #if VALET_FAKES
      return
    #endif
    guard paired, !asked else { return }
    asked = true
    Task {
      let granted = (try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])) ?? false
      if granted { UIApplication.shared.registerForRemoteNotifications() }
    }
  }

  func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
    let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
    token = hex
    host?.model.pushToken = hex
  }

  func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
    // A build signed without push (the free account) lands here; cards still arrive on open.
  }

  /// While the app is open the card is on screen already: no banner on top of it.
  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter, willPresent notification: UNNotification
  ) async -> UNNotificationPresentationOptions {
    []
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
      case .active:
        host.model.connect()
        // What woke the phone is on screen now.
        UNUserNotificationCenter.current().removeAllDeliveredNotifications()
      default: break
      }
    }
  }
}

extension AppHost {
  var isPaired: Bool {
    if case .paired = model.phase { return true }
    return false
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
