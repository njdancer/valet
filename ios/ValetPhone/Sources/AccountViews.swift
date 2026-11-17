import SwiftUI
import ValetCrypto
import ValetPhoneCore

/// The Valet account (docs/relay-hub.md, step 4c): the devices on it, as this iPhone checked
/// them, and the Macs waiting to join. Adding a Mac is signed with Face ID.
struct AccountSection: View {
  let account: AccountModel
  @State private var adding: WaitingMac?
  @State private var removing: RosterDevice?
  @State private var problem: String?

  var body: some View {
    Section {
      if let line = stateLine {
        Text(verbatim: line).foregroundStyle(.secondary).accessibilityIdentifier("valet.account.state")
      }
      ForEach(account.devices, id: \.deviceId) { device in
        HStack {
          Text(verbatim: account.name(device.deviceId))
          Spacer()
          if device.deviceId == account.me {
            Text("This iPhone").font(.caption).foregroundStyle(.secondary)
          } else {
            if device.role == "mac" {
              Text(account.online(device.deviceId) ? "Online" : "Offline").font(.caption).foregroundStyle(.secondary)
            }
            Button("Remove", role: .destructive) { removing = device }
              .buttonStyle(.bordered)
              .accessibilityIdentifier("valet.account.remove")
          }
        }
      }
      ForEach(account.waiting) { mac in
        HStack {
          VStack(alignment: .leading) {
            Text(verbatim: mac.name)
            Text("Wants to join your account").font(.caption).foregroundStyle(.secondary)
          }
          Spacer()
          Button("Add") { adding = mac }
            .buttonStyle(.borderedProminent)
            .accessibilityIdentifier("valet.account.add")
        }
      }
      if let problem {
        Text(verbatim: problem).foregroundStyle(.red).accessibilityIdentifier("valet.account.problem")
      }
    } header: {
      SectionHeader("Your Valet account")
    } footer: {
      Text("Only devices on this list can approve for Valet. This iPhone checks the list itself.")
    }
    .task(id: account.accountId) { await account.refresh() }
    .confirmationDialog(
      adding.map { "Add \($0.name)?" } ?? "", isPresented: Binding(get: { adding != nil }, set: { if !$0 { adding = nil } }),
      titleVisibility: .visible, presenting: adding
    ) { mac in
      Button("Add with Face ID") { Task { await run { try await account.add(mac.id) } } }
        .accessibilityIdentifier("valet.account.add.confirm")
    } message: { _ in
      Text("Add it only if it\u{2019}s your Mac and you just set it up. It can then ask this iPhone to approve.")
    }
    .confirmationDialog(
      removing.map { "Remove \($0.name)?" } ?? "",
      isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), titleVisibility: .visible,
      presenting: removing
    ) { device in
      Button("Remove with Face ID", role: .destructive) { Task { await run { try await account.remove(device.deviceId) } } }
    } message: { _ in
      Text("It comes off your Valet account and can\u{2019}t approve anything until it\u{2019}s added again.")
    }
  }

  private var stateLine: String? {
    switch account.state {
    case .unknown, .checking: return account.devices.isEmpty ? "Checking your account\u{2026}" : nil
    case .ready: return nil
    case let .failed(problem): return problem.rawValue
    }
  }

  private func run(_ change: () async throws -> Void) async {
    problem = nil
    do { try await change() } catch let refusal as AccountChangeRefusal {
      problem = Self.text(refusal)
    } catch {
      problem = "That didn\u{2019}t work. Try again."
    }
  }

  static func text(_ refusal: AccountChangeRefusal) -> String? {
    switch refusal {
    case .faceIDFailed: return nil
    case .changed: return "Your account changed just now. Check the list and try again."
    case .unreachable: return "Valet can\u{2019}t reach your account right now. Try again in a moment."
    case .full: return "Your account has as many devices as it can hold. Remove one first."
    case .notReady, .unknownDevice, .isThisPhone, .refused: return "That didn\u{2019}t work. Try again."
    }
  }
}
