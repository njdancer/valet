// The Mac's `status` message (contracts v2, H's CR-3): what the Activity, Sites, Agents and Valet
// tabs show. It replaces the last one. Every text is the Mac's own wording; agent labels are the
// names the person gave them.

import Foundation

public struct MacStatus: Equatable, Sendable {
  public enum Safety: String, Sendable, CaseIterable { case running, paused, remotePaused = "remote-paused", lockdown }
  public enum Health: String, Sendable, CaseIterable { case ok, needsYou = "needs-you", paused, blocked, repair, off }

  public struct Site: Equatable, Sendable, Identifiable {
    public let adapterId: String
    public let name: String
    public let health: Health
    public let note: String?
    public var id: String { adapterId }
  }

  public struct Agent: Equatable, Sendable, Identifiable {
    public let clientId: String
    public let label: String
    public let remote: Bool
    public let lastCallAt: Date?
    public var id: String { clientId }
  }

  public struct Device: Equatable, Sendable, Identifiable {
    public let deviceId: String
    public let name: String
    public let platform: String
    public let lastSeenAt: Date?
    public var id: String { deviceId }
  }

  public struct Recent: Equatable, Sendable, Identifiable {
    public let index: Int
    public let at: Date
    public let isCall: Bool
    public let text: String
    public var id: Int { index }
  }

  public let at: Date
  public let safety: Safety
  public let sites: [Site]
  public let agents: [Agent]
  public let devices: [Device]
  public let recent: [Recent]

  /// Parses the whole `status` message (its `type` and `seq` included).
  public static func parse(_ value: JSONValue) throws -> MacStatus {
    let f = try Fields(value, path: "status", required: ["type", "seq", "at", "safety", "sites", "agents", "devices", "recent"])
    let optionalDate = { (fields: Fields, key: String) throws -> Date? in
      try (fields.raw(key).isNull ? nil : fields.dateTime(key))
    }
    return MacStatus(
      at: try f.dateTime("at"),
      safety: Safety(rawValue: try f.oneOf("safety", Safety.allCases.map(\.rawValue)))!,
      sites: try f.array("sites", max: 50) { value, at in
        let s = try Fields(value, path: at, required: ["adapterId", "name", "health"], optional: ["note"])
        return Site(
          adapterId: try s.string("adapterId", pattern: Patterns.adapterId),
          name: try s.display("name", max: 80),
          health: Health(rawValue: try s.oneOf("health", Health.allCases.map(\.rawValue)))!,
          note: try (s.has("note") ? s.display("note", max: 200) : nil)
        )
      },
      agents: try f.array("agents", max: 50) { value, at in
        let a = try Fields(value, path: at, required: ["clientId", "label", "transport", "lastCallAt"])
        return Agent(
          clientId: try a.string("clientId", pattern: Patterns.clientId),
          label: try a.display("label", max: 100),
          remote: try a.oneOf("transport", ["local", "remote"]) == "remote",
          lastCallAt: try optionalDate(a, "lastCallAt")
        )
      },
      devices: try f.array("devices", max: 10) { value, at in
        let d = try Fields(value, path: at, required: ["deviceId", "name", "platform", "lastSeenAt"])
        return Device(
          deviceId: try d.string("deviceId", pattern: Patterns.keyId),
          name: try d.display("name", max: 60),
          platform: try d.oneOf("platform", ["macos", "ios"]),
          lastSeenAt: try optionalDate(d, "lastSeenAt")
        )
      },
      recent: try f.array("recent", max: 50) { value, at in
        let r = try Fields(value, path: at, required: ["at", "kind", "text"])
        return Recent(
          index: Int(at.split(separator: "[").last?.dropLast() ?? "0") ?? 0,
          at: try r.dateTime("at"),
          isCall: try r.oneOf("kind", ["call", "change"]) == "call",
          text: try r.display("text", max: 200)
        )
      }
    )
  }
}
