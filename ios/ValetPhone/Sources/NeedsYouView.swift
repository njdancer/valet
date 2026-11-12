import SwiftUI
import ValetPhoneCore
import ValetProtocol

/// The first tab: open cards, logins that need a code, and the Mac's alerts.
struct NeedsYouView: View {
  let model: PhoneModel
  @State private var selected: String?

  var body: some View {
    NavigationStack {
      List {
        if !model.macOnline {
          Section {
            Label {
              Text(verbatim: offlineLine)
            } icon: {
              Image(systemName: "wifi.slash")
            }
            .accessibilityIdentifier("needs.offline")
          }
        }
        if model.needsUpdate {
          Section {
            Text("Your Mac sent something this version of Valet doesn\u{2019}t understand. Update the app, then look on your Mac.")
          }
        }
        if !model.handoffs.isEmpty {
          Section("Logins") {
            ForEach(model.handoffs) { entry in
              HandoffRow(model: model, entry: entry)
            }
          }
        }
        if model.openCards.isEmpty && model.handoffs.isEmpty {
          ContentUnavailableView(
            "Nothing needs you", systemImage: "checkmark.circle",
            description: Text("When an agent asks for something that matters, it shows up here.")
          )
          .accessibilityIdentifier("needs.empty")
        }
        if !model.openCards.isEmpty {
          Section("Waiting for you") {
            ForEach(model.openCards) { entry in
              Button {
                selected = entry.id
              } label: {
                CardRowView(entry: entry, remaining: model.remaining(entry))
              }
              .accessibilityIdentifier("card.\(entry.card.ref)")
            }
          }
        }
        let answered = model.cards.filter { !$0.state.isOpen }
        if !answered.isEmpty {
          Section("Answered") {
            ForEach(answered.reversed()) { entry in
              Button {
                selected = entry.id
              } label: {
                VStack(alignment: .leading, spacing: 4) {
                  Text(verbatim: entry.card.title).foregroundStyle(.primary)
                  Text(verbatim: CardStateText.short(entry.state, macName: model.macName)).font(.footnote)
                    .foregroundStyle(.secondary)
                }
              }
              .accessibilityIdentifier("answered.\(entry.card.ref)")
            }
          }
        }
        if !model.alerts.isEmpty {
          Section("From your Mac") {
            ForEach(model.alerts.reversed()) { alert in
              VStack(alignment: .leading, spacing: 4) {
                Text(verbatim: alert.title).font(.headline)
                Text(verbatim: alert.body).font(.subheadline)
                Text(alert.at, style: .time).font(.caption).foregroundStyle(.secondary)
              }
              .accessibilityElement(children: .combine)
            }
          }
        }
      }
      .navigationTitle("Needs you")
      .sheet(item: Binding(get: { selected.map(SheetID.init) }, set: { selected = $0?.id })) { sheet in
        CardSheet(model: model, requestId: sheet.id)
      }
    }
  }

  private var offlineLine: String {
    if let seen = model.macLastSeen {
      return "Your Mac is offline. Last seen \(seen.formatted(date: .omitted, time: .shortened))."
    }
    return "Your Mac is offline."
  }
}

struct SheetID: Identifiable {
  let id: String
}

struct CardRowView: View {
  let entry: CardEntry
  let remaining: TimeInterval

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack {
        Text(verbatim: "\(entry.card.kindWord) \u{00b7} \(entry.card.ref)").font(.caption.monospaced())
        Spacer()
        Text(verbatim: Deadline.text(remaining)).font(.caption).foregroundStyle(.secondary)
      }
      TitleText(card: entry.card).font(.headline)
      Text(verbatim: entry.card.askedBy).font(.subheadline).foregroundStyle(.secondary)
    }
    .foregroundStyle(.primary)
    .accessibilityElement(children: .combine)
  }
}

/// The title, with the tone word first on caution and strong cards. Always verbatim: a title is
/// built from Mac-written fields, but it is never read as Markdown.
struct TitleText: View {
  let card: Card

  var body: some View {
    if let word = card.tone.word {
      (Text(verbatim: word + " ").foregroundStyle(card.tone == .strong ? Color.red : Color.orange) + Text(verbatim: card.title))
    } else {
      Text(verbatim: card.title)
    }
  }
}

enum Deadline {
  static func text(_ remaining: TimeInterval) -> String {
    if remaining <= 0 { return "Expired" }
    let minutes = Int(remaining / 60)
    if minutes >= 120 { return "\(minutes / 60) h left" }
    if minutes >= 1 { return "\(minutes) min left" }
    return "\(Int(remaining)) s left"
  }
}

struct HandoffRow: View {
  let model: PhoneModel
  let entry: HandoffEntry
  @State private var code = ""
  @State private var refused = false

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(verbatim: "\(entry.handoff.domain) wants a sign-in code").font(.headline)
      if entry.sentSeq != nil {
        Text(entry.confirmed ? "Sent to your Mac." : "Sending to your Mac\u{2026}").foregroundStyle(.secondary)
          .accessibilityIdentifier("handoff.sent")
      } else {
        Text("Type the code the site sent you. It goes only into this login on your Mac.")
          .font(.subheadline)
        HStack {
          TextField("Code", text: $code)
            .textContentType(.oneTimeCode)
            .keyboardType(.asciiCapable)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .textFieldStyle(.roundedBorder)
            .accessibilityIdentifier("handoff.code")
          Button("Send") { refused = !model.sendLoginCode(entry.id, code: code) }
            .buttonStyle(.borderedProminent)
            .accessibilityIdentifier("handoff.send")
        }
        if refused { Text("That doesn\u{2019}t look like a code.").font(.footnote).foregroundStyle(.red) }
      }
    }
  }
}
