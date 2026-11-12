// A port of packages/core/src/approvals.ts, phone side: parse the request text the Mac sent, and
// build the decision the phone signs. The phone never builds or re-serialises a request; it renders
// from the parsed text and signs over that text's digest (docs/agent-run-security.md#what-a-card-shows).

import Foundation

public enum ApprovalKind: String, CaseIterable, Sendable {
  case adapterInstall = "adapter-install"
  case secretGrant = "secret-grant"
  case toolEnable = "tool-enable"
  case remoteClient = "remote-client"
  case setting
  case authoringSession = "authoring-session"
  case privateNetwork = "private-network"
  case irreversibleCall = "irreversible-call"
  case resume
  case devicePair = "device-pair"

  /// KIND_TIER in core.
  public var tier: String { self == .irreversibleCall ? "approve-each-use" : "approve" }

  /// APPROVAL_TTL_MS in core, in seconds.
  public var ttl: TimeInterval {
    switch self {
    case .adapterInstall, .secretGrant, .toolEnable, .setting: return 24 * 3600
    case .remoteClient, .resume: return 10 * 60
    case .authoringSession, .privateNetwork: return 30 * 60
    case .irreversibleCall: return 2 * 60
    case .devicePair: return 5 * 60
    }
  }
}

public enum Risk: String, Sendable, Comparable {
  case low, medium, high, critical
  var rank: Int { [.low: 0, .medium: 1, .high: 2, .critical: 3][self]! }
  public static func < (a: Risk, b: Risk) -> Bool { a.rank < b.rank }
}

public struct PermissionChange: Equatable, Sendable {
  public static let areas = [
    "navigation", "egress", "auth-frames", "secret", "secret-origins", "messages-sender", "requests", "tool",
    "side-effect", "session-cookies", "session-storage", "setting", "limits", "sandbox-mode", "sandbox-exception",
  ]
  public let area: String
  public let change: String
  public let items: [String]
  public let risk: Risk

  static func parse(_ value: JSONValue, _ path: String) throws -> PermissionChange {
    let f = try Fields(value, path: path, required: ["area", "change", "items", "risk"])
    return PermissionChange(
      area: try f.oneOf("area", areas),
      change: try f.oneOf("change", ["added", "removed", "widened", "narrowed"]),
      items: try f.displays("items", min: 1, max: 50, itemMax: 200),
      risk: Risk(rawValue: try f.oneOf("risk", ["low", "medium", "high", "critical"]))!
    )
  }
}

public enum ApprovalSubject: Equatable, Sendable {
  public struct AdapterInstall: Equatable, Sendable {
    public let adapterId, adapterName, version, adapterHash, packageHash: String
    public let previousHash: String?
    public let source: String
    public let inheritsSession: Bool
    public let references: [String]
    public let changes: [PermissionChange]
    public let unsandboxed: Bool
  }
  public struct SecretGrant: Equatable, Sendable {
    public let adapterId, adapterHash, secret: String
    public let fields: [String]
    public let provider, itemTitle, itemFingerprint: String
    public let origins: [String]
  }
  public struct ToolEnable: Equatable, Sendable {
    public let adapterId, adapterHash, tool, scope: String
    public let clientId: String?
    public let sideEffect: String
  }
  public struct RemoteClient: Equatable, Sendable {
    public let clientId, host: String
    public let sourceAddress: String?
    public let tools: [String]
  }
  public struct Choice: Equatable, Sendable, Identifiable {
    public let value: String
    public let label: String
    public var id: String { value }
  }
  public struct Setting: Equatable, Sendable {
    public let scope: String
    public let adapterId: String?
    public let setting, label, from, to: String
    /// When the person picks the value on the card; the signed decision names the pick.
    public let choices: [Choice]?
  }
  public struct PrivateNetwork: Equatable, Sendable {
    public let adapterId, draftId, address: String
    public let port: Int?
    public let minutes: Int
  }
  public struct AuthoringSession: Equatable, Sendable {
    public let adapterId, draftId: String
    public let origins: [String]
    public let minutes: Int
  }
  public struct IrreversibleCall: Equatable, Sendable {
    public let adapterId, adapterHash, tool, callId: String
    /// Which confirmation in the call this is: two in one call never share a request.
    public let confirmationId: String
    public let preview: [String]
  }
  public struct DevicePair: Equatable, Sendable {
    public let deviceId, deviceName, platform, confirmation: String
  }

  case adapterInstall(AdapterInstall)
  case secretGrant(SecretGrant)
  case toolEnable(ToolEnable)
  case remoteClient(RemoteClient)
  case setting(Setting)
  case authoringSession(AuthoringSession)
  case privateNetwork(PrivateNetwork)
  case irreversibleCall(IrreversibleCall)
  case resume(from: String)
  case devicePair(DevicePair)

  static func parse(kind: ApprovalKind, _ value: JSONValue, _ path: String) throws -> ApprovalSubject {
    switch kind {
    case .adapterInstall:
      let f = try Fields(value, path: path, required: [
        "adapterId", "adapterName", "version", "adapterHash", "packageHash", "previousHash", "source",
        "inheritsSession", "references", "changes", "unsandboxed",
      ])
      let changes = try f.array("changes", max: 200, PermissionChange.parse)
      let references = try f.array("references", max: 10) { item, at -> String in
        guard let text = item.string else { throw SchemaError(at, "expected a string") }
        try Fields.check(text, at: at, pattern: nil, min: 0, max: 500)
        try Fields.checkHTTPS(text, at: at)
        return text
      }
      let subject = AdapterInstall(
        adapterId: try f.string("adapterId", pattern: Patterns.adapterId),
        adapterName: try f.display("adapterName", max: 80),
        version: try f.string("version", pattern: Patterns.version),
        adapterHash: try f.string("adapterHash", pattern: Patterns.hash),
        packageHash: try f.string("packageHash", pattern: Patterns.hash),
        previousHash: try f.nullableString("previousHash", pattern: Patterns.hash),
        source: try f.oneOf("source", ["draft", "local-folder", "rollback", "builtin"]),
        inheritsSession: try f.bool("inheritsSession"),
        references: references,
        changes: changes,
        unsandboxed: try f.bool("unsandboxed")
      )
      // The refinement in core: a critical sandbox-mode line means unsandboxed.
      if !subject.unsandboxed, changes.contains(where: { $0.area == "sandbox-mode" && $0.risk == .critical }) {
        throw SchemaError(path, "a critical sandbox-mode line means unsandboxed")
      }
      return .adapterInstall(subject)
    case .secretGrant:
      let f = try Fields(value, path: path, required: [
        "adapterId", "adapterHash", "secret", "fields", "provider", "itemTitle", "itemFingerprint", "origins",
      ])
      let fields = try f.strings("fields", min: 1, max: 3)
      guard fields.allSatisfy({ ["username", "password", "otp"].contains($0) }) else {
        throw SchemaError("\(path).fields", "unknown field")
      }
      return .secretGrant(SecretGrant(
        adapterId: try f.string("adapterId", pattern: Patterns.adapterId),
        adapterHash: try f.string("adapterHash", pattern: Patterns.hash),
        secret: try f.string("secret", pattern: Patterns.name),
        fields: fields,
        provider: try f.oneOf("provider", [
          "keychain-copy", "onepassword-service-account", "onepassword-desktop", "messages",
        ]),
        itemTitle: try f.display("itemTitle", max: 120),
        itemFingerprint: try f.string("itemFingerprint", pattern: "[0-9a-f]{16}"),
        origins: try f.strings("origins", min: 1, max: 10, pattern: Patterns.origin)
      ))
    case .toolEnable:
      let f = try Fields(value, path: path, required: [
        "adapterId", "adapterHash", "tool", "scope", "clientId", "sideEffect",
      ])
      return .toolEnable(ToolEnable(
        adapterId: try f.string("adapterId", pattern: Patterns.adapterId),
        adapterHash: try f.string("adapterHash", pattern: Patterns.hash),
        tool: try f.string("tool", pattern: Patterns.name),
        scope: try f.oneOf("scope", ["local", "remote"]),
        clientId: try f.nullableString("clientId", pattern: Patterns.clientId),
        sideEffect: try f.oneOf("sideEffect", ["read", "write", "irreversible"])
      ))
    case .remoteClient:
      let f = try Fields(value, path: path, required: ["clientId", "host", "sourceAddress", "tools"])
      return .remoteClient(RemoteClient(
        clientId: try f.string("clientId", pattern: Patterns.clientId),
        host: try f.string("host", pattern: "[a-z0-9.-]{1,253}"),
        sourceAddress: try f.nullableString("sourceAddress", pattern: Patterns.address),
        tools: try f.strings("tools", max: 200, pattern: Patterns.qualifiedTool)
      ))
    case .setting:
      let f = try Fields(value, path: path, required: ["scope", "adapterId", "setting", "label", "from", "to"], optional: ["choices"])
      let choices: [Choice]? = try (f.has("choices") ? f.array("choices", min: 2, max: 50) { item, at in
        let c = try Fields(item, path: at, required: ["value", "label"])
        return Choice(value: try c.string("value", min: 1, max: 200), label: try c.display("label", max: 120))
      } : nil)
      return .setting(Setting(
        scope: try f.oneOf("scope", ["valet", "adapter"]),
        adapterId: try f.nullableString("adapterId", pattern: Patterns.adapterId),
        setting: try f.string("setting", pattern: Patterns.name),
        label: try f.display("label", max: 80),
        from: try f.display("from", max: 120),
        to: try f.display("to", max: 120),
        choices: choices
      ))
    case .authoringSession:
      let f = try Fields(value, path: path, required: ["adapterId", "draftId", "origins", "minutes"])
      return .authoringSession(AuthoringSession(
        adapterId: try f.string("adapterId", pattern: Patterns.adapterId),
        draftId: try f.string("draftId", pattern: "[A-Za-z0-9_-]{1,40}"),
        origins: try f.strings("origins", min: 1, max: 10, pattern: Patterns.origin),
        minutes: try f.int("minutes", min: 1, max: 60)
      ))
    case .privateNetwork:
      let f = try Fields(value, path: path, required: ["adapterId", "draftId", "address", "port", "minutes"])
      return .privateNetwork(PrivateNetwork(
        adapterId: try f.string("adapterId", pattern: Patterns.adapterId),
        draftId: try f.string("draftId", pattern: "[A-Za-z0-9_-]{1,40}"),
        address: try f.string("address", pattern: Patterns.address),
        port: try (f.raw("port").isNull ? nil : f.int("port", min: 1, max: 65535)),
        minutes: try f.int("minutes", min: 1, max: 60)
      ))
    case .irreversibleCall:
      let f = try Fields(value, path: path, required: ["adapterId", "adapterHash", "tool", "callId", "confirmationId", "preview"])
      return .irreversibleCall(IrreversibleCall(
        adapterId: try f.string("adapterId", pattern: Patterns.adapterId),
        adapterHash: try f.string("adapterHash", pattern: Patterns.hash),
        tool: try f.string("tool", pattern: Patterns.name),
        callId: try f.string("callId", pattern: "[A-Za-z0-9_-]{1,80}"),
        confirmationId: try f.string("confirmationId", pattern: "cf_[A-Za-z0-9_-]{1,60}"),
        preview: try f.displays("preview", max: 20, itemMax: 200)
      ))
    case .resume:
      let f = try Fields(value, path: path, required: ["from"])
      return .resume(from: try f.oneOf("from", ["paused", "lockdown"]))
    case .devicePair:
      let f = try Fields(value, path: path, required: ["deviceId", "deviceName", "platform", "confirmation"])
      return .devicePair(DevicePair(
        deviceId: try f.string("deviceId", pattern: Patterns.keyId),
        deviceName: try f.display("deviceName", max: 60),
        platform: try f.oneOf("platform", ["ios", "macos"]),
        confirmation: try f.string("confirmation", pattern: "[0-9]{6}")
      ))
    }
  }
}

public enum Requester: Equatable, Sendable {
  case agent(clientId: String, clientName: String)
  case person
  case app

  static func parse(_ value: JSONValue, _ path: String) throws -> Requester {
    guard let object = value.object, let kind = object.first(where: { $0.0 == "kind" })?.1.string else {
      throw SchemaError(path, "expected a requester")
    }
    switch kind {
    case "agent":
      let f = try Fields(value, path: path, required: ["kind", "clientId", "clientName"])
      return .agent(
        clientId: try f.string("clientId", pattern: Patterns.clientId),
        clientName: try f.display("clientName", max: 100)
      )
    case "person":
      _ = try Fields(value, path: path, required: ["kind"])
      return .person
    case "app":
      _ = try Fields(value, path: path, required: ["kind"])
      return .app
    default: throw SchemaError(path, "unknown requester kind")
    }
  }
}

/// Why a request exists, in the Mac's terms: the card's Because row.
public enum RequestContext: Equatable, Sendable {
  case repair(String), draft(String), follows(String), replaces(String)

  static func parse(_ value: JSONValue, _ path: String) throws -> RequestContext {
    guard let kind = value.object?.first(where: { $0.0 == "kind" })?.1.string else { throw SchemaError(path, "no kind") }
    switch kind {
    case "repair":
      return .repair(try Fields(value, path: path, required: ["kind", "repairId"]).string("repairId", pattern: "[A-Za-z0-9_-]{1,40}"))
    case "draft":
      return .draft(try Fields(value, path: path, required: ["kind", "draftId"]).string("draftId", pattern: "[A-Za-z0-9_-]{1,40}"))
    case "follows":
      return .follows(try Fields(value, path: path, required: ["kind", "requestId"]).string("requestId", pattern: Patterns.requestId))
    case "replaces":
      return .replaces(try Fields(value, path: path, required: ["kind", "requestId"]).string("requestId", pattern: Patterns.requestId))
    default: throw SchemaError(path, "unknown context")
    }
  }
}

/// What the card shows besides the subject, written by the Mac (CR-4). Inside the signed text.
/// `fromAdapter` is the adapter author's text: shown as "the adapter says", never as a headline.
public struct RequestDisplay: Equatable, Sendable {
  public var because: String?
  public var clientLabel: String?
  public var clientBadge: String?
  public var domain: String?
  public var followOns: [String]
  public var checks: [String]
  public var siteName: String?
  public var toolTitles: [String: String]
  /// The tests the agent wrote, as Valet ran them. Counted apart from `checks`, which are Valet's
  /// own, so an agent's passing tests never read as Valet's checks.
  public var agentTests: AgentTests?

  public struct AgentTests: Equatable, Sendable {
    public let passed: Int
    public let failed: Int

    public init(passed: Int, failed: Int) {
      self.passed = passed
      self.failed = failed
    }
  }

  public static let empty = RequestDisplay(
    because: nil, clientLabel: nil, clientBadge: nil, domain: nil, followOns: [], checks: [], siteName: nil, toolTitles: [:],
    agentTests: nil
  )

  static func parse(_ value: JSONValue, _ path: String) throws -> RequestDisplay {
    let f = try Fields(value, path: path, required: [], optional: ["because", "client", "domain", "followOns", "checks", "agentTests", "fromAdapter"])
    var d = RequestDisplay.empty
    if f.has("because") { d.because = try f.display("because", max: 200) }
    if f.has("client") {
      let c = try Fields(try f.raw("client"), path: "\(path).client", required: ["label", "badge"])
      d.clientLabel = try c.display("label", max: 100)
      d.clientBadge = try c.oneOf("badge", ["local", "remote", "app", "person"])
    }
    if f.has("domain") { d.domain = try f.string("domain", pattern: "[a-z0-9.-]{1,253}") }
    if f.has("followOns") { d.followOns = try f.displays("followOns", max: 10, itemMax: 120) }
    if f.has("checks") { d.checks = try f.displays("checks", max: 20, itemMax: 200) }
    if f.has("agentTests") {
      let t = try Fields(try f.raw("agentTests"), path: "\(path).agentTests", required: ["passed", "failed"])
      d.agentTests = AgentTests(passed: try t.int("passed", min: 0, max: 10_000), failed: try t.int("failed", min: 0, max: 10_000))
    }
    if f.has("fromAdapter") {
      let a = try Fields(try f.raw("fromAdapter"), path: "\(path).fromAdapter", required: [], optional: ["siteName", "toolTitles"])
      if a.has("siteName") { d.siteName = try a.display("siteName", max: 80) }
      if a.has("toolTitles") {
        guard let entries = try a.raw("toolTitles").object else { throw SchemaError("\(path).toolTitles", "expected an object") }
        for (key, item) in entries {
          guard matches(key, Patterns.name), let title = item.string, DisplayText.isValid(title, max: 80) else {
            throw SchemaError("\(path).toolTitles", "bad entry")
          }
          d.toolTitles[key] = title
        }
      }
    }
    return d
  }
}

public struct ApprovalRequest: Equatable, Sendable {
  public let id: String
  public let macId: String
  public let kind: ApprovalKind
  public let requester: Requester
  public let agentNote: String?
  public let createdAt: Date
  public let expiresAt: Date
  public let subject: ApprovalSubject
  public let context: RequestContext?
  public let display: RequestDisplay

  public static func parse(_ value: JSONValue) throws -> ApprovalRequest {
    let f = try Fields(value, path: "request", required: [
      "v", "id", "macId", "requester", "agentNote", "createdAt", "expiresAt", "kind", "tier", "subject",
    ], optional: ["context", "display"])
    try f.literal("v", 1)
    guard let kind = ApprovalKind(rawValue: try f.string("kind")) else { throw SchemaError("request.kind", "unknown") }
    try f.literal("tier", kind.tier)
    let createdAt = try f.dateTime("createdAt")
    let expiresAt = try f.dateTime("expiresAt")
    guard expiresAt > createdAt else { throw SchemaError("request", "expires before created") }
    return ApprovalRequest(
      id: try f.string("id", pattern: Patterns.requestId),
      macId: try f.string("macId", pattern: Patterns.keyId),
      kind: kind,
      requester: try Requester.parse(try f.raw("requester"), "request.requester"),
      agentNote: try f.nullableDisplay("agentNote", max: 280),
      createdAt: createdAt,
      expiresAt: expiresAt,
      subject: try ApprovalSubject.parse(kind: kind, try f.raw("subject"), "request.subject"),
      context: try (f.has("context") ? RequestContext.parse(f.raw("context"), "request.context") : nil),
      display: try (f.has("display") ? RequestDisplay.parse(f.raw("display"), "request.display") : .empty)
    )
  }

  /// `approvableOn` in core: pairing and anything critical in an install are Mac only.
  public var approvableOnPhone: Bool {
    switch subject {
    // Pairing, and lifting a pause or lockdown: a stolen phone must not undo the person's own stop.
    case .devicePair, .resume: return false
    case let .adapterInstall(install):
      return !(install.unsandboxed || install.changes.contains { $0.risk == .critical })
    default: return true
    }
  }
}

/// What a device signs to approve (`approvalDecisionSchema`). Only approvals are signed.
public struct ApprovalDecision: Equatable, Sendable {
  public let macId: String
  public let requestId: String
  public let requestDigest: String
  public let deviceId: String
  public let decidedAt: Date
  /// The value picked on a card that offers choices.
  public let choice: String?
  /// A remote client's consent: the code the person typed from their browser.
  public let typedCode: String?

  public init(
    macId: String, requestId: String, requestDigest: String, deviceId: String, decidedAt: Date, choice: String? = nil,
    typedCode: String? = nil
  ) {
    self.macId = macId
    self.requestId = requestId
    self.requestDigest = requestDigest
    self.deviceId = deviceId
    self.decidedAt = decidedAt
    self.choice = choice
    self.typedCode = typedCode
  }

  /// The payload text, in the same canonical form `decisionPayload` writes in core.
  public var payload: String {
    var entries: [(String, JSONValue)] = [
      ("v", .number("1")),
      ("decision", .string("approve")),
      ("macId", .string(macId)),
      ("requestId", .string(requestId)),
      ("requestDigest", .string(requestDigest)),
      ("deviceId", .string(deviceId)),
      ("decidedAt", .string(ISOTime.format(decidedAt))),
    ]
    if let choice { entries.append(("choice", .string(choice))) }
    if let typedCode { entries.append(("typedCode", .string(typedCode))) }
    return JSON.canonical(.object(entries))
  }

  public static func parse(_ text: String) throws -> ApprovalDecision {
    let f = try Fields(try JSON.parse(text), path: "decision", required: [
      "v", "decision", "macId", "requestId", "requestDigest", "deviceId", "decidedAt",
    ], optional: ["choice", "typedCode"])
    try f.literal("v", 1)
    try f.literal("decision", "approve")
    return ApprovalDecision(
      macId: try f.string("macId", pattern: Patterns.keyId),
      requestId: try f.string("requestId", pattern: Patterns.requestId),
      requestDigest: try f.string("requestDigest", pattern: Patterns.hash),
      deviceId: try f.string("deviceId", pattern: Patterns.keyId),
      decidedAt: try f.dateTime("decidedAt"),
      choice: try f.optionalString("choice", max: 200),
      typedCode: try f.optionalString("typedCode", pattern: Patterns.consentCode)
    )
  }
}

/// Text someone signed, with the signature over `<domain>\n<payload>` (`signedTextSchema`).
public struct SignedText: Equatable, Sendable {
  public let payload: String
  public let signature: String

  public init(payload: String, signature: String) {
    self.payload = payload
    self.signature = signature
  }

  public var json: JSONValue { .object([("payload", .string(payload)), ("signature", .string(signature))]) }

  public static func parse(_ value: JSONValue, _ path: String) throws -> SignedText {
    let f = try Fields(value, path: path, required: ["payload", "signature"])
    let signature = try f.string("signature", pattern: Patterns.base64url, max: 100)
    guard Base64URL.decode(signature)?.count == 64 else { throw SchemaError("\(path).signature", "must be 64 bytes") }
    return SignedText(payload: try f.string("payload", min: 2, max: 64 * 1024), signature: signature)
  }
}
