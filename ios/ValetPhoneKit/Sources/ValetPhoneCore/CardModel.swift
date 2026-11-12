// What an approval card shows (docs/ux/agent-run/approval-cards.md, docs/ios-app.md, Rendering a
// card), as a pure function of the parsed request and the Mac's status. Views only lay it out.
//
// Rules this file keeps:
// - The title, risk line and tone come only from Mac-written, structured fields. Agent-written text
//   (the agent's note, the adapter's name, the agent's self-reported name, setting labels and
//   values, a client's host and address, a call's preview, a device's name) is a claim: shown in
//   its own labelled place, never in the title, the risk line or the Face ID reason.
// - When the phone can't tell how risky something is, it rounds up to caution.
// - Strong cards need the "I've read what this does" tick.

import Foundation
import ValetProtocol

public enum Tone: String, Sendable, Comparable {
  case neutral, caution, strong
  var rank: Int { [.neutral: 0, .caution: 1, .strong: 2][self]! }
  public static func < (a: Tone, b: Tone) -> Bool { a.rank < b.rank }

  /// The word shown before the title on caution and strong cards (approval-cards.md, rule 6).
  public var word: String? {
    switch self {
    case .neutral: return nil
    case .caution: return "Check this."
    case .strong: return "Read carefully."
    }
  }
}

public struct CardRow: Equatable, Sendable, Identifiable {
  public let id: Int
  /// "Adds", "Removes", "Uses"… Words, not colour (rule 7).
  public let marker: String
  public let text: String
  public let tone: Tone
  /// True when the text came from the agent or the adapter's manifest.
  public let isClaim: Bool
}

public struct CardDetail: Equatable, Sendable, Identifiable {
  public let label: String
  public let value: String
  public let isClaim: Bool
  public var id: String { label }
}

public struct Card: Equatable, Sendable {
  public let requestId: String
  public let digest: String
  public let kind: ApprovalKind
  /// "Install · 1.0.0", "Remote tool"…
  public let kindWord: String
  /// A short reference the Mac shows too: the request id's first four characters, upper case.
  public let ref: String
  public let title: String
  public let tone: Tone
  /// "Asked by Claude app", or "Raised by Valet".
  public let askedBy: String
  /// The agent's own name for itself, when the Mac has no name the person gave it.
  public let askedByClaim: String?
  public let riskLine: String
  public let moreRisks: Int
  public let rows: [CardRow]
  /// The agent's note: shown as a quote under "In {agent}'s words".
  public let agentWords: String?
  public let agentWordsHeading: String
  public let details: [CardDetail]
  public let approveLabel: String
  public let needsReadTick: Bool
  /// Nil when the phone may approve; otherwise why not ("Do this on your Mac").
  public let macOnlyReason: String?
  /// Connect cards: the person types the code their browser shows; it goes in the signature.
  public let needsTypedCode: Bool
  /// Setting cards where the person picks the value; the pick goes in the signature.
  public let choices: [ApprovalSubject.Choice]?
  /// The Because row, from the Mac's display block or the request's context.
  public let because: String
  public let becauseIsCaution: Bool
  /// Checks Valet ran, and follow-on requests, from the Mac's display block.
  public let checks: [String]
  public let followOns: [String]
  /// What the Face ID prompt says. Mac-written words only.
  public let faceIDReason: String
  public let createdAt: Date
  public let expiresAt: Date
}

public enum CardModel {
  public static func card(for parsed: ParsedRequest, status: MacStatus?) -> Card {
    let request = parsed.request
    var agent = agentName(request.requester, status: status)
    if let label = request.display.clientLabel, case .agent = request.requester {
      // The Mac's own label for the asker (the name the person gave it) wins over the status list.
      agent = AgentLabel(name: label, askedBy: "Asked by \(label)", claim: nil)
    }
    var risks: [(Tone, String)] = []
    var rows: [CardRow] = []
    var details: [CardDetail] = []
    let title: String
    var kindWord: String
    var approveLabel = "Approve with Face ID"
    var needsTypedCode = false
    var choices: [ApprovalSubject.Choice]?
    let display = request.display
    let site = { (adapterId: String) in display.domain ?? adapterId }
    // A tool is named by its id in titles: the adapter's own title for it is the author's text, shown
    // only as a labelled detail (red team 4).
    let toolName = { (tool: String) in tool }
    func toolTitleDetail(_ tool: String) {
      if let given = display.toolTitles[tool] {
        details.append(CardDetail(label: "The adapter calls this tool", value: given, isClaim: true))
      }
    }
    let faceIDReason: String

    func row(_ marker: String, _ text: String, _ tone: Tone, claim: Bool = false) {
      rows.append(CardRow(id: rows.count, marker: marker, text: text, tone: tone, isClaim: claim))
    }

    switch request.subject {
    case let .adapterInstall(s):
      switch (s.source, s.previousHash) {
      case ("rollback", _):
        kindWord = "Restore · \(s.version)"
        title = "Go back to \(s.adapterId) \(s.version)"
      case (_, nil):
        kindWord = "Install · \(s.version)"
        title = display.domain.map { "Install an adapter for \($0)" } ?? "Install the \(s.adapterId) adapter"
      default:
        kindWord = "Update · \(s.version)"
        title = "Update \(s.adapterId) to \(s.version)"
      }
      faceIDReason = "Approve \(kindWord.lowercased()) of \(s.adapterId)"
      if s.unsandboxed {
        risks.append((.strong, "Runs without the sandbox: it can reach anything you can on this Mac."))
      }
      if s.inheritsSession {
        risks.append((.strong, "Takes over your signed-in \(s.adapterId) and its logins."))
      }
      for change in s.changes.sorted(by: { $0.risk > $1.risk }) {
        let tone = tone(for: change.risk)
        row(marker(change.change), "\(areaLabel(change.area)): \(change.items.map(isolate).joined(separator: ", "))", tone, claim: true)
        switch (change.area, change.risk) {
        case (_, .critical), (_, .high):
          risks.append((.strong, riskLine(change)))
        case (_, .medium):
          risks.append((.caution, riskLine(change)))
        default: break
        }
      }
      if s.previousHash == nil, display.domain == nil {
        // No registrable domain from the Mac: the phone can't check the install stays on one site,
        // so it rounds up (review finding 6).
        risks.append((.caution, "Valet didn't say which site this is for. Check it on your Mac."))
      }
      if s.changes.isEmpty {
        if s.previousHash == nil {
          // A first install with no lines is odd; the phone can't name its domain yet, so it
          // rounds up (review finding 6).
          risks.append((.caution, "Valet listed no permissions for this adapter. Check it on your Mac."))
        } else {
          risks.append((.neutral, "No new permissions. Code and tests only."))
        }
      } else if risks.isEmpty {
        risks.append(s.previousHash == nil
          ? (.caution, "A new adapter. Check what it reaches below.")
          : (.neutral, "Only low-risk changes."))
      }
      if s.source == "local-folder" { row("From", "a folder on your Mac, not a draft", .caution) }
      details.append(CardDetail(label: "The adapter calls itself", value: display.siteName ?? s.adapterName, isClaim: true))
      for (i, reference) in s.references.enumerated() {
        details.append(CardDetail(label: i == 0 ? "References the agent says it read" : "Reference \(i + 1)", value: reference, isClaim: true))
      }
      details.append(CardDetail(label: "Adapter hash", value: String(s.adapterHash.prefix(16)), isClaim: false))
      if let previous = s.previousHash {
        details.append(CardDetail(label: "Replaces", value: String(previous.prefix(16)), isClaim: false))
      }
    case let .secretGrant(s):
      kindWord = "Login"
      title = "Let \(site(s.adapterId)) use your login"
      faceIDReason = "Let \(s.adapterId) use a login"
      risks.append((.strong, "\(s.adapterId) can log in as you on \(s.origins.joined(separator: ", "))."))
      row("Uses", "\(providerName(s.provider)) item \u{201C}\(isolate(s.itemTitle))\u{201D}", .strong, claim: true)
      row("Typed only on", s.origins.joined(separator: ", "), .strong)
      row("Fields", s.fields.joined(separator: ", "), .neutral)
      details.append(CardDetail(label: "Item fingerprint", value: s.itemFingerprint, isClaim: false))
    case let .toolEnable(s):
      let tool = "\(s.adapterId).\(s.tool)"
      if s.scope == "remote" {
        kindWord = "Remote tool"
        let who = s.clientId.map { agentName(clientId: $0, status: status) } ?? "every remote agent"
        title = "Turn on \(toolName(s.tool)) for \(who)"
        risks.append((.caution, "\(who) could use it from anywhere."))
      } else {
        kindWord = "Local tool"
        title = "Turn on \(toolName(s.tool)) on this Mac"
      }
      faceIDReason = "Turn on \(tool)"
      toolTitleDetail(s.tool)
      switch s.sideEffect {
      case "irreversible": risks.append((.strong, "It can't be undone. You'll still confirm each use."))
      case "write": risks.append((.caution, "Can change things on \(s.adapterId)."))
      default: if s.scope == "local" { risks.append((.neutral, "Reads only.")) }
      }
      row("Turns on", tool, s.sideEffect == "read" ? .neutral : .caution)
      row("Can", s.sideEffect == "read" ? "read only" : s.sideEffect == "write" ? "change things" : "do things that can't be undone",
          s.sideEffect == "irreversible" ? .strong : s.sideEffect == "write" ? .caution : .neutral)
    case let .remoteClient(s):
      kindWord = "Connect"
      title = "Did you just add Valet to an agent?"
      faceIDReason = "Connect an agent to Valet"
      needsTypedCode = true
      risks.append((.strong, "Only approve if you started this. Type the code the page shows you."))
      row("Sees", s.tools.isEmpty ? "no tools yet" : "\(s.tools.count) tools: \(s.tools.joined(separator: ", "))", .caution)
      details.append(CardDetail(label: "Returns to (the agent says)", value: s.host, isClaim: true))
      if let address = s.sourceAddress {
        details.append(CardDetail(label: "From address (as reported)", value: address, isClaim: true))
      }
      details.append(CardDetail(label: "Client", value: s.clientId, isClaim: false))
    case let .setting(s):
      kindWord = "Setting"
      faceIDReason = "Change the setting \(s.setting)"
      if let offered = s.choices {
        // The person picks; nothing the agent wrote is the value (J8b).
        choices = offered
        title = s.adapterId.map { "Choose a \(site($0)) setting" } ?? "Choose a Valet setting"
        risks.append((.neutral, "You choose; the agent only asked."))
        row("Now", "\(isolate(s.label)): \(isolate(s.from))", .neutral, claim: s.scope == "adapter")
      } else {
        title = s.adapterId.map { "Change a \(site($0)) setting" } ?? "Change a Valet setting"
        risks.append((.caution, "This loosens what Valet allows. Check the change below."))
        row("Changes", "\(isolate(s.label)): \(isolate(s.from)) \u{2192} \(isolate(s.to))", .caution, claim: s.scope == "adapter")
      }
      details.append(CardDetail(label: "Setting", value: s.setting, isClaim: false))
    case let .authoringSession(s):
      kindWord = "Signed-in session"
      title = "Let \(agent.name) use your signed-in \(s.adapterId)"
      faceIDReason = "Open your signed-in \(s.adapterId) to an agent"
      risks.append((.strong, "\(agent.name) can act as you on \(s.origins.joined(separator: ", ")) for \(s.minutes) minutes."))
      row("Opens", "your signed-in \(s.adapterId) for \(s.minutes) minutes", .strong)
      row("On", s.origins.joined(separator: ", "), .strong)
      details.append(CardDetail(label: "Draft", value: s.draftId, isClaim: false))
    case let .privateNetwork(s):
      kindWord = "Private network"
      let target = s.port.map { "\(s.address):\($0)" } ?? s.address
      title = "Let \(agent.name)\u{2019}s scratch browser reach \(target)"
      faceIDReason = "Let a scratch browser reach your home network"
      risks.append((.strong, "Can open \(target) on your home network for \(s.minutes) minutes."))
      row("Opens", target, .strong)
      details.append(CardDetail(label: "Draft", value: s.draftId, isClaim: false))
    case let .irreversibleCall(s):
      kindWord = "Confirm"
      title = "Confirm: \(toolName(s.tool)) (\(site(s.adapterId)))"
      faceIDReason = "Confirm \(s.tool) on \(s.adapterId). This can't be undone."
      approveLabel = "Confirm with Face ID"
      toolTitleDetail(s.tool)
      risks.append((.strong, "This can't be undone."))
      for line in s.preview { row("Sends", line, .strong, claim: true) }
      details.append(CardDetail(label: "Call", value: s.callId, isClaim: false))
    case let .resume(from):
      kindWord = "Unlock"
      title = from == "lockdown" ? "Unlock Valet" : "Resume Valet"
      faceIDReason = title
      risks.append((.caution, "Agents can use Valet again."))
    case let .devicePair(s):
      kindWord = "Pair"
      title = "Pair a new device"
      faceIDReason = title
      risks.append((.strong, "A new device could approve requests."))
      row("Code", s.confirmation, .strong)
      details.append(CardDetail(label: "The device calls itself", value: s.deviceName, isClaim: true))
    }

    let macOnly: String? = request.approvableOnPhone ? nil : "Do this on your Mac. A phone can't approve this."
    let because: String
    var becauseIsCaution = false
    if let text = display.because {
      because = text
    } else {
      switch request.context {
      case let .repair(id): because = "Repair \(id)"
      case let .draft(id): because = "Draft \(id)"
      case let .follows(id): because = "Follows approval \(id.prefix(4).uppercased())"
      case let .replaces(id): because = "Replaces approval \(id.prefix(4).uppercased())"
      case nil:
        if case .agent = request.requester {
          because = "Not linked to anything Valet knows about"
          becauseIsCaution = true
        } else {
          because = request.kind == .remoteClient ? "Started in a browser" : "Asked on your Mac"
        }
      }
    }
    if becauseIsCaution {
      risks.append((.caution, "Not linked to anything Valet knows about."))
    }

    let strongest = risks.map(\.0).max() ?? .caution
    let first = risks.first(where: { $0.0 == strongest }) ?? (.caution, "")
    return Card(
      requestId: request.id,
      digest: parsed.digest,
      kind: request.kind,
      kindWord: kindWord,
      ref: String(request.id.prefix(4)).uppercased(),
      title: title,
      tone: strongest,
      askedBy: agent.askedBy,
      askedByClaim: agent.claim,
      riskLine: first.1,
      moreRisks: max(0, risks.filter { $0.0 != .neutral }.count - 1),
      rows: rows,
      agentWords: request.agentNote,
      agentWordsHeading: "In \(agent.name)\u{2019}s words",
      details: details,
      approveLabel: approveLabel,
      needsReadTick: strongest == .strong,
      macOnlyReason: macOnly,
      needsTypedCode: needsTypedCode,
      choices: choices,
      because: because,
      becauseIsCaution: becauseIsCaution,
      checks: display.checks,
      followOns: display.followOns,
      faceIDReason: faceIDReason,
      createdAt: request.createdAt,
      expiresAt: request.expiresAt
    )
  }

  struct AgentLabel {
    let name: String
    let askedBy: String
    let claim: String?
  }

  static func agentName(_ requester: Requester, status: MacStatus?) -> AgentLabel {
    switch requester {
    case let .agent(clientId, clientName):
      if let given = status?.agents.first(where: { $0.clientId == clientId }) {
        return AgentLabel(name: given.label, askedBy: "Asked by \(given.label)", claim: nil)
      }
      // No name the person gave it: name it by its credential, and show its own name as a claim.
      return AgentLabel(name: "an agent", askedBy: "Asked by \(clientId)", claim: "Calls itself \u{201C}\(isolate(clientName))\u{201D}")
    case .person: return AgentLabel(name: "you", askedBy: "Asked by you", claim: nil)
    case .app: return AgentLabel(name: "Valet", askedBy: "Raised by Valet", claim: nil)
    }
  }

  static func agentName(clientId: String, status: MacStatus?) -> String {
    status?.agents.first(where: { $0.clientId == clientId })?.label ?? clientId
  }

  static func tone(for risk: Risk) -> Tone {
    switch risk {
    case .low: return .neutral
    case .medium: return .caution
    case .high, .critical: return .strong
    }
  }

  static func marker(_ change: String) -> String {
    switch change {
    case "added": return "Adds"
    case "removed": return "Removes"
    case "widened": return "Widens"
    default: return "Narrows"
    }
  }

  static func areaLabel(_ area: String) -> String {
    switch area {
    case "navigation": return "Pages it opens"
    case "egress": return "Hosts it reaches"
    case "auth-frames": return "Login pages"
    case "secret": return "Logins it uses"
    case "secret-origins": return "Where a login is typed"
    case "messages-sender": return "Messages it reads codes from"
    case "requests": return "Requests it makes"
    case "tool": return "Tools"
    case "side-effect": return "What a tool can change"
    case "session-cookies": return "Cookies it keeps"
    case "session-storage": return "Storage it keeps"
    case "setting": return "Settings"
    case "limits": return "Limits"
    case "sandbox-mode": return "The sandbox"
    case "sandbox-exception": return "Sandbox exceptions"
    default: return area
    }
  }

  /// The headline risk for one change, from its area alone. The items (hosts, origins, tool names
  /// from the manifest) stay in the change rows, where they are marked as the adapter's (red team 5).
  static func riskLine(_ change: PermissionChange) -> String {
    switch change.area {
    case "sandbox-mode": return "Runs without the sandbox: it can reach anything you can on this Mac."
    case "sandbox-exception": return "Adds a sandbox exception. See what changes below."
    case "secret", "secret-origins", "auth-frames": return "Changes where your password is typed. See below."
    case "side-effect": return "A tool can now do more than it could. See below."
    case "tool": return "Changes its tools. See below."
    case "egress", "navigation": return "Reaches more of the web. See below."
    default: return "Changes \(areaLabel(change.area).lowercased()). See below."
    }
  }

  /// Wraps text from outside the Mac in Unicode first-strong isolates, so a right-to-left value
  /// can't reorder the words around it (red team 6).
  static func isolate(_ text: String) -> String { "\u{2068}\(text)\u{2069}" }

  static func providerName(_ provider: String) -> String {
    switch provider {
    case "keychain-copy": return "Keychain copy of"
    case "onepassword-service-account", "onepassword-desktop": return "1Password"
    case "messages": return "Messages"
    default: return provider
    }
  }
}
