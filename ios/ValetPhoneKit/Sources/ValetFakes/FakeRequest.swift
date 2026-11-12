import Foundation
import ValetProtocol

/// An approval request the fake Mac builds, one per kind, with the story's fixtures
/// (docs/ux/agent-run/story.md): Claude app (remote) and Claude Code (on the Mac).
public struct FakeRequest: Sendable {
  public var id: String?
  public var kind: ApprovalKind
  public var subject: JSONValue
  public var requester: JSONValue
  public var agentNote: String?
  public var ttl: TimeInterval?
  /// Fields of the Mac's display block (CR-4), and the request's context.
  public var display: [(String, JSONValue)]
  public var context: JSONValue?
  /// For a remote client's consent: the code the browser shows, which the Mac keeps beside the
  /// request (it is never in the request text).
  public var consentCode: String?

  public init(
    id: String? = nil, kind: ApprovalKind, subject: JSONValue, requester: JSONValue, agentNote: String? = nil,
    ttl: TimeInterval? = nil, display: [(String, JSONValue)] = [], context: JSONValue? = nil, consentCode: String? = nil
  ) {
    self.display = display
    self.context = context
    self.consentCode = consentCode
    self.id = id
    self.kind = kind
    self.subject = subject
    self.requester = requester
    self.agentNote = agentNote
    self.ttl = ttl
  }

  /// The request text, as the Mac serialises it: canonical JSON of a valid ApprovalRequest.
  public func text(id: String, macId: String, now: Date) -> String {
    var entries: [(String, JSONValue)] = [
      ("v", .number("1")), ("id", .string(id)), ("macId", .string(macId)), ("requester", requester),
      ("agentNote", agentNote.map { .string($0) } ?? .null),
      ("createdAt", .string(ISOTime.format(now))),
      ("expiresAt", .string(ISOTime.format(now.addingTimeInterval(ttl ?? kind.ttl)))),
      ("kind", .string(kind.rawValue)), ("tier", .string(kind.tier)), ("subject", subject),
    ]
    if !display.isEmpty { entries.append(("display", .object(display))) }
    if let context { entries.append(("context", context)) }
    return JSON.canonical(.object(entries))
  }

  public static let claudeApp = "remote:claude-app"
  public static let claudeCode = "local:claude-code"

  public static func agent(_ clientId: String, _ name: String) -> JSONValue {
    .object([("kind", .string("agent")), ("clientId", .string(clientId)), ("clientName", .string(name))])
  }

  static func client(_ label: String, _ badge: String) -> (String, JSONValue) {
    ("client", .object([("label", .string(label)), ("badge", .string(badge))]))
  }

  static func repair(_ id: String) -> JSONValue { .object([("kind", .string("repair")), ("repairId", .string(id))]) }
  static func draft(_ id: String) -> JSONValue { .object([("kind", .string("draft")), ("draftId", .string(id))]) }

  static let hashA = String(repeating: "a1", count: 32)
  static let hashB = String(repeating: "b2", count: 32)
  static let hashC = String(repeating: "c3", count: 32)

  static func change(_ area: String, _ change: String, _ items: [String], _ risk: String) -> JSONValue {
    .object([
      ("area", .string(area)), ("change", .string(change)), ("items", .array(items.map { .string($0) })),
      ("risk", .string(risk)),
    ])
  }

  public static func install(
    id: String? = nil, unsandboxed: Bool = false, changes: [JSONValue]? = nil, note: String? = "You asked for stock quotes."
  ) -> FakeRequest {
    FakeRequest(id: id, kind: .adapterInstall, subject: .object([
      ("adapterId", .string("yahoo-finance")), ("adapterName", .string("Yahoo Finance")), ("version", .string("1.0.0")),
      ("adapterHash", .string(hashA)), ("packageHash", .string(hashB)), ("previousHash", .null),
      ("source", .string("draft")), ("inheritsSession", .bool(false)),
      ("references", .array([.string("https://github.com/example/yahoo-adapter")])),
      ("changes", .array(changes ?? [
        change("egress", "added", ["query1.finance.yahoo.com"], "low"),
        change("tool", "added", ["get_quote (read)", "search_symbols (read)"], "low"),
      ])),
      ("unsandboxed", .bool(unsandboxed)),
    ]), requester: agent(claudeCode, "Claude Code"), agentNote: note, display: [
      client("Claude Code", "local"), ("domain", .string("yahoo.com")),
      ("checks", .array([.string("Valet built it"), .string("Manifest checked"), .string("Live trial: 3 of 3 reads worked")])),
      ("fromAdapter", .object([("siteName", .string("Yahoo Finance"))])),
    ], context: draft("draft-7b3f"))
  }

  public static func update(id: String? = nil) -> FakeRequest {
    FakeRequest(id: id, kind: .adapterInstall, subject: .object([
      ("adapterId", .string("woolworths")), ("adapterName", .string("Woolworths")), ("version", .string("0.3.1")),
      ("adapterHash", .string(hashC)), ("packageHash", .string(hashB)), ("previousHash", .string(hashA)),
      ("source", .string("draft")), ("inheritsSession", .bool(false)), ("references", .array([])),
      ("changes", .array([])), ("unsandboxed", .bool(false)),
    ]), requester: agent(claudeCode, "Claude Code"), agentNote: "Fixes search after the site changed (R-4E1C).", display: [
      client("Claude Code", "local"), ("domain", .string("woolworths.com.au")), ("because", .string("Repair R-4E1C: Search products is broken")),
    ], context: repair("R-4E1C"))
  }

  public static func remoteTool(id: String? = nil, sideEffect: String = "read") -> FakeRequest {
    FakeRequest(id: id, kind: .toolEnable, subject: .object([
      ("adapterId", .string("yahoo-finance")), ("adapterHash", .string(hashA)), ("tool", .string("search_symbols")),
      ("scope", .string("remote")), ("clientId", .string(claudeApp)), ("sideEffect", .string(sideEffect)),
    ]), requester: agent(claudeApp, "Claude"), agentNote: "So I can look up tickers for you.", display: [
      client("Claude app", "remote"), ("domain", .string("yahoo.com")),
      ("fromAdapter", .object([("toolTitles", .object([("search_symbols", .string("Search symbols"))]))])),
    ], context: draft("draft-7b3f"))
  }

  public static func store(id: String? = nil) -> FakeRequest {
    FakeRequest(id: id, kind: .setting, subject: .object([
      ("scope", .string("adapter")), ("adapterId", .string("woolworths")), ("setting", .string("store")),
      ("label", .string("Woolworths store")), ("from", .string("Woolworths Town Hall")),
      ("to", .string("Woolworths Town Hall")),
      ("choices", .array([
        ("1234", "Woolworths Town Hall"), ("2050", "Woolworths Bondi Junction"), ("2060", "Woolworths Double Bay"),
        ("2070", "Woolworths Paddington"),
      ].map { (choice: (String, String)) -> JSONValue in .object([("value", .string(choice.0)), ("label", .string(choice.1))]) })),
    ]), requester: agent(claudeApp, "Claude"), agentNote: "Change my store to Bondi Junction.", display: [
      client("Claude app", "remote"), ("domain", .string("woolworths.com.au")), ("because", .string("You asked Claude app to change your store")),
    ])
  }

  public static func session(id: String? = nil, note: String? = "Repair R-4E1C needs the signed-in search page.") -> FakeRequest {
    FakeRequest(id: id, kind: .authoringSession, subject: .object([
      ("adapterId", .string("woolworths")), ("draftId", .string("draft-4e1c")),
      ("origins", .array([.string("https://www.woolworths.com.au")])), ("minutes", .number("30")),
    ]), requester: agent(claudeCode, "Claude Code"), agentNote: note, display: [client("Claude Code", "local"), ("domain", .string("woolworths.com.au"))])
  }

  public static func login(id: String? = nil) -> FakeRequest {
    FakeRequest(id: id, kind: .secretGrant, subject: .object([
      ("adapterId", .string("woolworths")), ("adapterHash", .string(hashA)), ("secret", .string("account")),
      ("fields", .array([.string("username"), .string("password")])), ("provider", .string("onepassword-service-account")),
      ("itemTitle", .string("Woolworths")), ("itemFingerprint", .string("0123456789abcdef")),
      ("origins", .array([.string("https://auth.woolworths.com.au")])),
    ]), requester: agent(claudeCode, "Claude Code"), agentNote: nil, display: [
      client("Claude Code", "local"), ("domain", .string("woolworths.com.au")), ("because", .string("Woolworths needs a login to manage your trolley")),
    ])
  }

  /// The browser that started the flow shows `code`; the person types it on the card.
  public static func connect(id: String? = nil, code: String = "KQXM-RPDT") -> FakeRequest {
    FakeRequest(id: id, kind: .remoteClient, subject: .object([
      ("clientId", .string("remote:new-client")), ("host", .string("claude.ai")), ("sourceAddress", .string("203.0.113.7")),
      ("tools", .array([.string("yahoo-finance.get_quote")])),
    ]), requester: .object([("kind", .string("person"))]), agentNote: nil, consentCode: code)
  }

  public static func confirm(id: String? = nil) -> FakeRequest {
    FakeRequest(id: id, kind: .irreversibleCall, subject: .object([
      ("adapterId", .string("woolworths")), ("adapterHash", .string(hashA)), ("tool", .string("checkout")),
      ("callId", .string("call-6b3e")),
      ("preview", .array([.string("12 items, $84.20"), .string("Woolworths Bondi Junction, delivery 6 to 7 pm"), .string("Card ending 4421")])),
    ]), requester: agent(claudeApp, "Claude"), agentNote: nil, display: [
      client("Claude app", "remote"), ("domain", .string("woolworths.com.au")),
      ("fromAdapter", .object([("toolTitles", .object([("checkout", .string("Check out"))]))])),
    ])
  }

  public static func resume(id: String? = nil) -> FakeRequest {
    FakeRequest(id: id, kind: .resume, subject: .object([("from", .string("lockdown"))]), requester: .object([("kind", .string("person"))]))
  }
}
