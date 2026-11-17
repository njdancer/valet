// A port of packages/core/src/hub-phone.ts: the phone talking to the hub (docs/relay-hub.md, step
// 4c). The phone has no session cookie. It asks for a challenge, signs it with its transport key
// over the same relay-auth payload it signs for a Mac's relay object (with the hub's origin), and
// gets back the account: the device list, the Macs waiting to join it, and the account's Macs.

import Foundation

public enum HubPhone {
  /// HUB_PHONE_CHALLENGE_MS, in seconds.
  public static let challengeTTL: TimeInterval = 60
  static let nonce = "[A-Za-z0-9_-]{22,64}"
  /// `hubNodeSlugSchema`.
  static let slug = "[a-z0-9](?:-?[a-z0-9]){0,15}"

  /// What POST /phone/challenge answers with.
  public struct Challenge: Equatable, Sendable {
    public let nonce: String
    public let expiresAt: Date

    public static func parse(_ text: String) throws -> Challenge {
      let f = try Fields(try JSON.parse(text), path: "challenge", required: ["nonce", "expiresAt"])
      return Challenge(nonce: try f.string("nonce", pattern: HubPhone.nonce), expiresAt: try f.dateTime("expiresAt"))
    }
  }

  /// The body of POST /phone/account (`hubPhoneRequestSchema`). `signature` is the transport key
  /// over PhoneToRelay.helloPayload with the hub's origin as the relay.
  public static func request(deviceId: String, nonce: String, signature: String, append: [SignedText] = []) -> String {
    var fields: [(String, JSONValue)] = [
      ("deviceId", .string(deviceId)), ("nonce", .string(nonce)), ("signature", .string(signature)),
    ]
    if !append.isEmpty { fields.append(("append", .array(append.map(\.json)))) }
    return JSON.serialize(.object(fields))
  }

  public struct Joining: Equatable, Sendable {
    public let macId: String
    public let record: SignedText
    public let at: Date
  }

  public struct Node: Equatable, Sendable {
    public let macId, slug, name: String
    public let online: Bool
  }

  /// What POST /phone/account answers with (`hubPhoneAccountSchema`). Only the shape is checked
  /// here: the chain and each join record are checked by ValetCrypto's Roster.
  public struct Account: Equatable, Sendable {
    public let account: String
    /// The relay every Mac on the account dials.
    public let relay: String
    public let changes: [SignedText]
    /// Set when the append wasn't kept: "conflict" or "invalid".
    public let refused: String?
    public let joining: [Joining]
    public let nodes: [Node]

    public static func parse(_ text: String) throws -> Account {
      let f = try Fields(
        try JSON.parse(text), path: "account", required: ["account", "relay", "changes", "joining", "nodes"],
        optional: ["refused"]
      )
      return Account(
        account: try f.string("account", pattern: Patterns.accountId),
        relay: try f.httpsURL("relay", max: 200),
        changes: try f.array("changes", max: 512) { try signed($0, $1) },
        refused: try f.has("refused") ? f.oneOf("refused", ["conflict", "invalid"]) : nil,
        joining: try f.array("joining", max: 16) { value, at in
          let j = try Fields(value, path: at, required: ["macId", "record", "at"])
          return Joining(
            macId: try j.string("macId", pattern: Patterns.keyId), record: try signed(try j.raw("record"), "\(at).record"),
            at: try j.dateTime("at")
          )
        },
        nodes: try f.array("nodes", max: 64) { value, at in
          let n = try Fields(value, path: at, required: ["macId", "slug", "name", "online"])
          let name = try n.string("name", min: 1, max: 64)
          let banned: Set<Unicode.GeneralCategory> = [.control, .format]
          guard name.unicodeScalars.allSatisfy({ !banned.contains($0.properties.generalCategory) }) else {
            throw SchemaError("\(at).name", "has control characters")
          }
          return Node(
            macId: try n.string("macId", pattern: Patterns.keyId), slug: try n.string("slug", pattern: HubPhone.slug),
            name: name, online: try n.bool("online")
          )
        }
      )
    }

    /// `signedRosterChangeSchema` and `signedJoinRecordSchema`: a signed text of at most 4096 characters.
    static func signed(_ value: JSONValue, _ path: String) throws -> SignedText {
      let signed = try SignedText.parse(value, path)
      if signed.payload.utf16.count > 4096 { throw SchemaError("\(path).payload", "too long") }
      return signed
    }
  }
}
