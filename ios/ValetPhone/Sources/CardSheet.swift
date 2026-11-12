import SwiftUI
import UIKit
import ValetPhoneCore
import ValetProtocol

/// One approval card, in the order of approval-cards.md section 2, with the actions pinned at the
/// bottom. Everything shown is `Text(verbatim:)`: nothing a request carries is read as Markdown or
/// as a link (review finding 15).
struct CardSheet: View {
  let model: PhoneModel
  let requestId: String
  @Environment(\.dismiss) private var dismiss
  @State private var readTicked = false
  @State private var typedCode = ""
  @State private var choice: String?
  @State private var problem: String?
  @State private var declining = false
  @Environment(\.dynamicTypeSize) private var typeSize

  private var entry: CardEntry? { model.cards.first { $0.id == requestId } }

  var body: some View {
    NavigationStack {
      Group {
        if let entry {
          content(entry)
        } else {
          Text("This request is no longer here.")
        }
      }
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Close") { dismiss() }.accessibilityIdentifier("card.close")
        }
      }
    }
  }

  @ViewBuilder
  private func content(_ entry: CardEntry) -> some View {
    let card = entry.card
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        ViewThatFits(in: .horizontal) {
          HStack {
            Text(verbatim: "\(card.kindWord) \u{00b7} \(card.ref)").font(.footnote.weight(.semibold).monospacedDigit())
            Spacer()
            Text(verbatim: Deadline.text(model.remaining(entry))).font(.caption).foregroundStyle(Color.secondary)
          }
          VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: card.kindWord).font(.footnote.weight(.semibold).monospacedDigit())
            Text(verbatim: card.ref).font(.footnote.weight(.semibold).monospacedDigit())
            Text(verbatim: Deadline.text(model.remaining(entry))).font(.caption).foregroundStyle(Color.secondary)
          }
        }
        .padding(.top, 8)
        .background(Color(uiColor: .systemBackground))
        .accessibilityElement(children: .combine)
        TitleText(card: card).font(.title2.bold()).accessibilityAddTraits(.isHeader)
          .accessibilityIdentifier("card.title")
        VStack(alignment: .leading, spacing: 2) {
          Text(verbatim: card.askedBy).font(.subheadline)
          if let claim = card.askedByClaim {
            Text(verbatim: claim).font(.footnote).foregroundStyle(.secondary)
          }
        }
        .accessibilityElement(children: .combine)
        risk(card)
        if !card.rows.isEmpty {
          VStack(alignment: .leading, spacing: 8) {
            Text("What changes").font(.headline)
            ForEach(card.rows) { row in
              HStack(alignment: .firstTextBaseline) {
                Text(verbatim: row.marker).font(.subheadline.bold()).foregroundStyle(color(row.tone))
                  .frame(minWidth: 70, alignment: .leading)
                Text(verbatim: row.text).italic(row.isClaim)
              }
              .accessibilityElement(children: .combine)
            }
          }
        }
        Label {
          Text(verbatim: card.because)
        } icon: {
          Image(systemName: card.becauseIsCaution ? "exclamationmark.triangle" : "link")
        }
        .foregroundStyle(card.becauseIsCaution ? Palette.caution : Color.primary)
        .accessibilityIdentifier("card.because")
        if !card.checks.isEmpty {
          VStack(alignment: .leading, spacing: 4) {
            Text("Checks Valet ran").font(.headline)
            ForEach(card.checks, id: \.self) { Text(verbatim: $0).font(.subheadline) }
          }
        }
        if !card.followOns.isEmpty {
          VStack(alignment: .leading, spacing: 4) {
            Text("Asked for next").font(.headline)
            ForEach(card.followOns, id: \.self) { Text(verbatim: $0).font(.subheadline) }
            Text("Each comes as its own request after this one.").font(.footnote).foregroundStyle(.secondary)
          }
        }
        if let choices = card.choices, entry.state == .waiting {
          VStack(alignment: .leading, spacing: 8) {
            Text("Pick one").font(.headline)
            ForEach(choices) { option in
              Button {
                choice = option.value
              } label: {
                HStack {
                  Image(systemName: choice == option.value ? "largecircle.fill.circle" : "circle")
                  Text(verbatim: option.label).foregroundStyle(Color.primary)
                  Spacer()
                }
              }
              .accessibilityAddTraits(choice == option.value ? .isSelected : [])
              .accessibilityIdentifier("choice.\(option.value)")
            }
          }
        }
        if let words = card.agentWords {
          VStack(alignment: .leading, spacing: 4) {
            Text(verbatim: card.agentWordsHeading).font(.headline)
            Text(verbatim: "\u{201c}\(words)\u{201d}").font(.body).italic()
              .padding(10)
              .frame(maxWidth: .infinity, alignment: .leading)
              .background(Color(.secondarySystemBackground), in: .rect(cornerRadius: 8))
              .accessibilityIdentifier("card.words")
          }
        }
        if !card.details.isEmpty {
          DisclosureGroup("Details") {
            VStack(alignment: .leading, spacing: 6) {
              ForEach(card.details) { detail in
                VStack(alignment: .leading) {
                  Text(verbatim: detail.label).font(.caption).foregroundStyle(.secondary)
                  Text(verbatim: detail.value).font(.footnote.weight(.semibold).monospacedDigit()).italic(detail.isClaim)
                    .textSelection(.enabled)
                }
              }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
          }
        }
        VStack(alignment: .leading, spacing: 2) {
          Text(verbatim: "Expires \(card.expiresAt.formatted(date: .abbreviated, time: .shortened)) if nobody answers.")
          Text("Only you can approve this. Claude can\u{2019}t approve its own requests.")
        }
        .font(.footnote).foregroundStyle(.secondary)
      }
      .padding()
    }
    .modifier(HardTopEdge())
    .safeAreaInset(edge: .bottom) { actions(entry) }
    .sheet(isPresented: $declining) {
      DeclineSheet(card: card) { note, stopAsking in
        model.decline(requestId, note: note, stopAsking: stopAsking)
        declining = false
      }
      .presentationDetents([.medium, .large])
    }
  }

  @ViewBuilder
  private func risk(_ card: Card) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(verbatim: card.riskLine).font(.body.weight(.medium)).foregroundStyle(color(card.tone))
      if card.moreRisks > 0 {
        Text(verbatim: "and \(card.moreRisks) more \(card.moreRisks == 1 ? "risk" : "risks")").font(.footnote)
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("card.risk")
  }

  @ViewBuilder
  private func actions(_ entry: CardEntry) -> some View {
    let card = entry.card
    VStack(spacing: 10) {
      if entry.state.isOpen && entry.state != .waiting && entry.state != .notConfirmed {
        Text(verbatim: CardStateText.long(entry, macName: model.macName)).accessibilityIdentifier("card.state")
      } else if entry.state == .notConfirmed {
        Text(verbatim: CardStateText.long(entry, macName: model.macName)).accessibilityIdentifier("card.state")
        Button("Check again") { approve(entry) }.buttonStyle(.bordered).accessibilityIdentifier("card.retry")
      } else if !entry.state.isOpen {
        Text(verbatim: CardStateText.long(entry, macName: model.macName)).accessibilityIdentifier("card.state")
      } else if let reason = card.macOnlyReason {
        Text(verbatim: reason).accessibilityIdentifier("card.macOnly")
        Button("Decline", role: .destructive) { declining = true }.accessibilityIdentifier("card.decline")
      } else {
        if card.needsTypedCode {
          VStack(alignment: .leading, spacing: 4) {
            Text("Type the code your agent shows you").font(.subheadline)
            TextField("XXXX-XXXX", text: $typedCode)
              .textInputAutocapitalization(.characters)
              .autocorrectionDisabled()
              .keyboardType(.asciiCapable)
              .font(.title3.monospaced())
              .textFieldStyle(.roundedBorder)
              .accessibilityIdentifier("card.code")
          }
        }
        if card.needsReadTick {
          Toggle("I\u{2019}ve read what this does", isOn: $readTicked)
            .accessibilityIdentifier("card.readTick")
        }
        if let problem {
          Text(verbatim: problem).font(.footnote).foregroundStyle(Palette.strong).accessibilityIdentifier("card.problem")
        }
        // At the accessibility text sizes the two buttons stack, Approve on top, so neither word
        // breaks across lines and the bar stays a sensible share of the screen.
        let layout = typeSize.isAccessibilitySize
          ? AnyLayout(VStackLayout(spacing: 8)) : AnyLayout(HStackLayout())
        layout {
          if typeSize.isAccessibilitySize { approveButton(entry, card: card) }
          Button {
            declining = true
          } label: {
            Text("Decline").lineLimit(1).frame(maxWidth: typeSize.isAccessibilitySize ? .infinity : nil)
          }
          .buttonStyle(.bordered).controlSize(.large)
          .accessibilityIdentifier("card.decline")
          if !typeSize.isAccessibilitySize { approveButton(entry, card: card) }
        }
      }
    }
    .dynamicTypeSize(...DynamicTypeSize.accessibility2)
    .padding()
    .frame(maxWidth: .infinity)
    .background(.bar)
  }

  private func approveButton(_ entry: CardEntry, card: Card) -> some View {
    Button {
      approve(entry)
    } label: {
      Text(verbatim: card.approveLabel).lineLimit(2).minimumScaleFactor(0.8).frame(maxWidth: .infinity)
    }
    .buttonStyle(.borderedProminent).controlSize(.large)
    .disabled(!canApprove)
    .accessibilityIdentifier("card.approve")
  }

  private var canApprove: Bool {
    switch model.approveBlocker(requestId, readTicked: readTicked, typedCode: typedCode, choice: choice) {
    case nil, .tooSoon: return true
    default: return false
    }
  }

  private func approve(_ entry: CardEntry) {
    problem = nil
    Task {
      do {
        try await model.approve(requestId, readTicked: readTicked, typedCode: typedCode, choice: choice)
      } catch let refusal as ApproveRefusal {
        problem = CardStateText.refusal(refusal)
      } catch {
        problem = "Nothing was approved."
      }
    }
  }

  private func color(_ tone: Tone) -> Color {
    switch tone {
    case .neutral: return .primary
    case .caution: return Palette.caution
    case .strong: return Palette.strong
    }
  }
}

struct DeclineSheet: View {
  let card: Card
  let done: (String?, Bool) -> Void
  @State private var note = ""
  @State private var stopAsking = false

  var body: some View {
    NavigationStack {
      Form {
        Section {
          TextField("Tell the agent why (optional)", text: $note, axis: .vertical)
            .lineLimit(3...6)
            .accessibilityIdentifier("decline.note")
        } footer: {
          Text("Only the agent that asked sees this.")
        }
        Section {
          Toggle("Stop it asking for this again", isOn: $stopAsking)
        }
      }
      .navigationTitle("Decline")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .confirmationAction) {
          Button("Decline") { done(note.isEmpty ? nil : note, stopAsking) }
            .accessibilityIdentifier("decline.confirm")
        }
      }
    }
  }
}

enum CardStateText {
  static func short(_ state: CardState, macName: String) -> String {
    switch state {
    case .approvedHere: return "Approved on this iPhone"
    case .declinedHere: return "Declined on this iPhone"
    case let .answeredElsewhere(outcome):
      switch outcome {
      case .approved: return "Approved on \(macName)"
      case .declined: return "Declined on \(macName)"
      case .expired: return "Expired"
      case .withdrawn: return "Withdrawn"
      case .refused: return "Not accepted"
      }
    case .notUsed: return "Answered elsewhere first"
    case .expired: return "Expired"
    case .withdrawn: return "Withdrawn by the agent"
    case .lockedDown: return "Declined: Valet locked down"
    case .refused: return "Your Mac didn\u{2019}t accept this"
    default: return "Waiting"
    }
  }

  static func long(_ entry: CardEntry, macName: String) -> String {
    switch entry.state {
    case .signing: return "Waiting for Face ID\u{2026}"
    case .sending: return "Sending to your Mac\u{2026}"
    case .macChecking: return "Your Mac is checking it\u{2026}"
    case .notConfirmed:
      return "Not confirmed yet. If your Mac gets it before the request expires it will be used; after that it won\u{2019}t."
    case .approvedHere: return "Approved with Face ID on this iPhone. The agent will see this the next time it checks Valet."
    case .declinedHere: return "Declined on this iPhone."
    case let .answeredElsewhere(outcome):
      switch outcome {
      case .approved: return "Approved on \(macName)."
      case .declined: return "Declined on \(macName)."
      case .expired: return "Nobody answered in time, so nothing changed."
      case .withdrawn: return "The agent withdrew this request."
      case .refused: return "Your Mac didn\u{2019}t accept this approval."
      }
    case .notUsed: return "Answered on \(macName) first. Your answer wasn\u{2019}t used."
    case .expired: return "Nobody answered in time, so nothing changed."
    case .withdrawn: return "The agent withdrew this request."
    case .lockedDown: return "Declined: you locked Valet down."
    case let .refused(reason):
      if reason == "wrong-code" { return "That code didn\u{2019}t match what the agent showed. Nothing was approved." }
      return "Your Mac didn\u{2019}t accept this approval. This iPhone may have been removed from Valet."
    case .waiting: return ""
    }
  }

  static func refusal(_ refusal: ApproveRefusal) -> String {
    switch refusal {
    case .notOpen: return "This request isn\u{2019}t waiting any more."
    case .expired: return "This request has expired."
    case .macOnly: return "This can only be approved on your Mac."
    case .needsReadTick: return "Tick \u{201c}I\u{2019}ve read what this does\u{201d} first."
    case .wrongCode: return "Type the eight-letter code your agent shows you."
    case .faceIDFailed: return "Face ID or the passcode didn\u{2019}t work. Nothing was approved."
    case .notPaired: return "This iPhone isn\u{2019}t paired."
    case .tooSoon: return "This just changed. Read it again, then approve."
    case .needsChoice: return "Pick one first."
    }
  }
}

/// On iOS 26 a scroll view's edges fade the content under the toolbar and the action bar, which leaves the card's
/// first and last lines faded at rest. Hard edges keep them at full contrast.
private struct HardTopEdge: ViewModifier {
  func body(content: Content) -> some View {
    if #available(iOS 26.0, *) {
      content.scrollEdgeEffectStyle(.hard, for: .all)
    } else {
      content
    }
  }
}
