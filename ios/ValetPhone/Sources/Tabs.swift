import SwiftUI
import ValetPhoneCore
import ValetProtocol

struct MainTabs: View {
  let model: PhoneModel

  var body: some View {
    TabView {
      Tab("Needs you", systemImage: "bell.badge") { NeedsYouView(model: model) }
        .badge(model.openCards.count)
      Tab("Activity", systemImage: "list.bullet.rectangle") { ActivityView(model: model) }
      Tab("Sites", systemImage: "globe") { SitesView(model: model) }
      Tab("Agents", systemImage: "person.2") { AgentsView(model: model) }
      Tab("Valet", systemImage: "shield.lefthalf.filled") { ValetView(model: model) }
    }
  }
}

/// A line under each list saying how fresh the Mac's picture is.
struct StatusFooter: View {
  let model: PhoneModel
  var body: some View {
    if let status = model.status {
      Text(verbatim: "As of \(status.at.formatted(date: .omitted, time: .shortened)), from \(model.macName).")
    } else {
      Text("Waiting to hear from your Mac.")
    }
  }
}

struct ActivityView: View {
  let model: PhoneModel

  var body: some View {
    NavigationStack {
      List {
        Section {
          ForEach(model.status?.recent ?? []) { item in
            VStack(alignment: .leading, spacing: 4) {
              Text(verbatim: item.text)
              Text(item.at, style: .relative).font(.caption).foregroundStyle(.secondary)
            }
            .accessibilityElement(children: .combine)
          }
        } footer: {
          VStack(alignment: .leading) {
            StatusFooter(model: model)
            Text("The full record of every call is on your Mac.")
          }
        }
      }
      .navigationTitle("Activity")
    }
  }
}

struct SitesView: View {
  let model: PhoneModel

  var body: some View {
    NavigationStack {
      List {
        Section {
          ForEach(model.status?.sites ?? []) { site in
            VStack(alignment: .leading, spacing: 4) {
              HStack {
                Text(verbatim: site.name).font(.headline)
                Spacer()
                Text(verbatim: health(site.health)).font(.caption.bold()).foregroundStyle(healthColor(site.health))
              }
              if let note = site.note { Text(verbatim: note).font(.subheadline).foregroundStyle(.secondary) }
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("site.\(site.adapterId)")
          }
        } footer: {
          StatusFooter(model: model)
        }
      }
      .navigationTitle("Sites")
    }
  }

  private func health(_ h: MacStatus.Health) -> String {
    switch h {
    case .ok: return "Working"
    case .needsYou: return "Needs you"
    case .paused: return "Paused"
    case .blocked: return "Blocked"
    case .repair: return "Needs repair"
    case .off: return "Off"
    }
  }

  private func healthColor(_ h: MacStatus.Health) -> Color {
    switch h {
    case .ok: return Palette.ok
    case .off, .paused: return .secondary
    default: return Palette.caution
    }
  }
}

struct AgentsView: View {
  let model: PhoneModel
  @State private var revoking: MacStatus.Agent?

  var body: some View {
    NavigationStack {
      List {
        Section {
          ForEach(model.status?.agents ?? []) { agent in
            HStack {
              VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: agent.label).font(.headline)
                Text(agent.remote ? "Remote" : "On your Mac").font(.caption).foregroundStyle(.secondary)
              }
              Spacer()
              Button("Revoke", role: .destructive) { revoking = agent }
                .buttonStyle(.bordered)
                .accessibilityIdentifier("agent.revoke.\(agent.label)")
            }
          }
        } footer: {
          StatusFooter(model: model)
        }
        CommandsSection(model: model)
      }
      .navigationTitle("Agents")
      .confirmationDialog(
        revoking.map { "Revoke \($0.label)?" } ?? "", isPresented: Binding(get: { revoking != nil }, set: { if !$0 { revoking = nil } }),
        titleVisibility: .visible, presenting: revoking
      ) { agent in
        Button("Revoke", role: .destructive) { model.send(command: .revokeClient(agent.clientId)) }
          .accessibilityIdentifier("agent.revoke.confirm")
      } message: { _ in
        Text("It can\u{2019}t use Valet again until you connect it again on your Mac.")
      }
    }
  }
}

/// What the phone asked the Mac to do, and whether the Mac said it was done.
struct CommandsSection: View {
  let model: PhoneModel

  var body: some View {
    if !model.commands.isEmpty {
      Section("Sent to your Mac") {
        ForEach(model.commands.reversed()) { command in
          HStack {
            Text(verbatim: describe(command.command))
            Spacer()
            Text(command.confirmed ? "Done" : model.isUnconfirmed(command) ? "Not confirmed yet" : "Sending\u{2026}")
              .font(.caption).foregroundStyle(.secondary)
          }
          .accessibilityElement(children: .combine)
          .accessibilityIdentifier("command.\(command.seq)")
        }
      }
    }
  }

  private func describe(_ command: PhoneCommand) -> String {
    switch command {
    case .pauseRemote: return "Pause remote agents"
    case .lockdown: return "Lock down"
    case let .revokeClient(id): return "Revoke \(model.status?.agents.first { $0.clientId == id }?.label ?? "an agent")"
    case let .revokeDevice(id): return "Remove \(model.status?.devices.first { $0.deviceId == id }?.name ?? "a device")"
    }
  }
}

/// The safety controls (J7). Each only tightens, so none asks for Face ID.
struct ValetView: View {
  let model: PhoneModel
  @State private var confirmLockdown = false
  @State private var confirmUnpair = false
  @State private var removing: MacStatus.Device?

  var body: some View {
    NavigationStack {
      List {
        Section {
          Text(verbatim: safetyLine).accessibilityIdentifier("valet.safety")
          if model.relayLocked {
            Text("The relay has stopped passing anything to your Mac.").accessibilityIdentifier("valet.relayLocked")
          }
        }
        Section {
          Button("Pause remote agents") { model.send(command: .pauseRemote) }
            .accessibilityIdentifier("valet.pauseRemote")
          Button("Lock down", role: .destructive) { confirmLockdown = true }
            .accessibilityIdentifier("valet.lockdown")
        } footer: {
          Text("Lock down stops every agent and declines everything waiting. Only your Mac can unlock it.")
        }
        CommandsSection(model: model)
        if let devices = model.status?.devices, !devices.isEmpty {
          Section("Devices") {
            ForEach(devices) { device in
              HStack {
                Text(verbatim: device.name)
                Spacer()
                if device.deviceId == model.deviceId {
                  Text("This iPhone").font(.caption).foregroundStyle(.secondary)
                } else if device.deviceId != model.macId {
                  Button("Remove", role: .destructive) { removing = device }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("valet.removeDevice")
                }
              }
            }
          }
        }
        Section {
          Button("Unpair this iPhone", role: .destructive) { confirmUnpair = true }
            .accessibilityIdentifier("valet.unpair")
        } footer: {
          Text(verbatim: "Paired with \(model.macName).")
        }
      }
      .navigationTitle("Valet")
      .confirmationDialog("Lock Valet down?", isPresented: $confirmLockdown, titleVisibility: .visible) {
        Button("Lock down", role: .destructive) {
          model.send(command: .lockdown)
          // If the Mac is away, the relay can still stop forwarding (J7 F1).
          if !model.macOnline { model.lockAtRelay() }
        }
        .accessibilityIdentifier("valet.lockdown.confirm")
      } message: {
        Text("Every agent stops and everything waiting is declined.")
      }
      .confirmationDialog(
        removing.map { "Remove \($0.name)?" } ?? "", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
        titleVisibility: .visible, presenting: removing
      ) { device in
        // A.6: removing a device needs Face ID, so a thief with the passcode can't cut the owner's
        // other phone off (red team 11).
        Button("Remove with Face ID", role: .destructive) {
          Task {
            if await Biometrics.confirm("Remove \(device.name) from Valet") {
              model.send(command: .revokeDevice(device.deviceId))
            }
          }
        }
      } message: { _ in
        Text("It can\u{2019}t approve anything or see Valet again until it\u{2019}s paired again.")
      }
      .confirmationDialog("Unpair this iPhone?", isPresented: $confirmUnpair, titleVisibility: .visible) {
        Button("Unpair", role: .destructive) { model.unpair() }.accessibilityIdentifier("valet.unpair.confirm")
      } message: {
        Text("This iPhone forgets your Mac. Remove it on your Mac too.")
      }
    }
  }

  private var safetyLine: String {
    switch model.status?.safety {
    case .running?: return "Valet is running."
    case .paused?: return "Valet is paused."
    case .remotePaused?: return "Remote agents are paused."
    case .lockdown?: return "Valet is locked down. Unlock it on your Mac."
    case nil: return "Waiting to hear from your Mac."
    }
  }
}
