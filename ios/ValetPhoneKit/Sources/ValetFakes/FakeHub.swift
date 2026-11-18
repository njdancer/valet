// An in-process hub for the phone's account (docs/relay-hub.md, step 4c), as apps/relay's hub
// answers /phone/challenge and /phone/account: a nonce, the transport key's answer checked
// against the account's verified list, appends kept only if the whole chain still checks.
// Tests reach in to fork, roll back or rewrite the list, as a hostile hub would.

import CryptoKit
import Foundation
import ValetCrypto
import ValetPhoneCore
import ValetProtocol

@MainActor
public final class FakeHub: HubTransport {
  public struct Join: Sendable {
    public var macId: String
    public var record: SignedText
    public var at: Date
  }

  public let origin: String
  public let relay: String
  public let accountId: String
  /// The account's list, as the hub holds it. Tests may rewrite it.
  public var chain: [SignedText] = []
  public var joining: [Join] = []
  public var nodes: [HubPhone.Node] = []
  /// False: every call throws, as if the hub were unreachable.
  public var reachable = true
  /// What the phone asked, for tests: each path in order.
  public private(set) var calls: [String] = []
  private var nonces: Set<String> = []

  public init(origin: String = "https://hub.valet.test", relay: String = "https://relay.valet.test", accountId: String = "acct_fakefakefake01") {
    self.origin = origin
    self.relay = relay
    self.accountId = accountId
  }

  public var account: (hub: String, accountId: String) { (origin, accountId) }

  /// The Mac starts the list with itself, then adds the phone it paired: what the Mac does once
  /// it links to the hub with a phone paired (step 4b).
  public func start(by mac: FakeMac, at: Date = Date()) {
    let first = mac.signRoster(Roster.next(nil, account: accountId, by: mac.macId, change: .add(mac.rosterDevice), at: at))
    chain = [first]
    if let phone = mac.phoneDevice { append(by: mac, .add(phone), at: at) }
    nodes.append(HubPhone.Node(macId: mac.macId, slug: "mac", name: mac.name, online: true))
  }

  /// A change a Mac on the list signs.
  public func append(by mac: FakeMac, _ op: RosterOp, at: Date = Date()) {
    guard case let .success(roster) = Roster.verify(chain) else { return }
    chain.append(mac.signRoster(Roster.next(roster, account: accountId, by: mac.macId, change: op, at: at)))
  }

  /// A Mac at the hub asks to join the list.
  public func askToJoin(_ mac: FakeMac, at: Date = Date()) {
    joining.append(Join(macId: mac.macId, record: mac.joinRecord(), at: at))
    nodes.append(HubPhone.Node(macId: mac.macId, slug: "mac-\(nodes.count + 1)", name: mac.name, online: true))
  }

  public var roster: Roster? { try? Roster.verify(chain).get() }

  // MARK: The person's passkey (step 4d)

  /// The account's passkey, as the person's iPhone holds it for the hub's site.
  public let passkeyKey = P256.Signing.PrivateKey()
  public static let passkeyCredential = "ZmFrZS1wYXNza2V5LWNyZWRlbnRpYWw"

  public var rpId: String { URL(string: origin)?.host ?? "hub.valet.test" }

  public var passkey: RosterPasskey {
    let spki = Signing.spki(passkeyKey.publicKey)
    return RosterPasskey(
      passkeyId: Signing.keyId(spki) ?? "", credentialId: Self.passkeyCredential, publicKey: spki, rpId: rpId,
      name: "iCloud Keychain"
    )
  }

  /// What the person does on the hub's page: their passkey signs the change adding this phone.
  /// False if the list has no passkey on it, or the change isn't kept.
  @discardableResult
  public func signInWithPasskey(_ device: RosterDevice, at: Date = Date()) -> Bool {
    guard let roster, roster.passkeys[passkey.passkeyId] != nil else { return false }
    if roster.devices[device.deviceId] != nil { return true }
    let payload = Roster.next(roster, account: accountId, by: Roster.passkeySigner, change: .add(device), at: at)
    let signed = passkeyAssertion(payload)
    guard case .success = Roster.verify(chain + [signed]) else { return false }
    chain.append(signed)
    return true
  }

  /// A WebAuthn assertion over a change, as a browser's authenticator makes one.
  public func passkeyAssertion(_ payload: String, origin override: String? = nil) -> SignedText {
    let client = JSON.serialize(.object([
      ("type", .string("webauthn.get")), ("challenge", .string(Base64URL.encode(Roster.passkeyChallenge(payload)))),
      ("origin", .string(override ?? origin)), ("crossOrigin", .bool(false)),
    ]))
    let clientData = Data(client.utf8)
    let authenticatorData = Data(SHA256.hash(data: Data(rpId.utf8))) + Data([0x05, 0, 0, 0, 1])
    let signature = try! passkeyKey.signature(for: authenticatorData + Data(SHA256.hash(data: clientData)))
    return SignedText(
      payload: payload, signature: Base64URL.encode(signature.rawRepresentation),
      webauthn: WebAuthnAssertion(
        credentialId: Self.passkeyCredential, authenticatorData: Base64URL.encode(authenticatorData),
        clientDataJSON: Base64URL.encode(clientData)
      )
    )
  }

  public func post(_ url: String, body: String) async throws -> HubResponse {
    guard reachable else { throw URLError(.cannotConnectToHost) }
    guard url.hasPrefix(origin) else { return HubResponse(status: 404, body: "") }
    let path = String(url.dropFirst(origin.count))
    calls.append(path)
    switch path {
    case "/phone/challenge":
      let nonce = FakeMac.randomId()
      nonces.insert(nonce)
      let expires = ISOTime.format(Date().addingTimeInterval(HubPhone.challengeTTL))
      return HubResponse(status: 200, body: JSON.serialize(.object([("nonce", .string(nonce)), ("expiresAt", .string(expires))])))
    case "/phone/account":
      return answer(body)
    default:
      return HubResponse(status: 404, body: "")
    }
  }

  private func answer(_ body: String) -> HubResponse {
    let bad = HubResponse(status: 400, body: "")
    guard let value = try? JSON.parse(body),
      let f = try? Fields(value, path: "request", required: ["deviceId", "nonce", "signature"], optional: ["append"]),
      let deviceId = try? f.string("deviceId", pattern: Patterns.keyId), let nonce = try? f.string("nonce"),
      let signature = try? f.string("signature")
    else { return bad }
    let append = f.has("append") ? (try? f.array("append", min: 1, max: 8) { try SignedText.parse($0, $1, allowWebAuthn: true) }) : []
    guard let append else { return bad }
    // Each nonce works once.
    let known = nonces.remove(nonce) != nil
    let payload = PhoneToRelay.helloPayload(id: deviceId, nonce: nonce, relay: origin)
    guard known, let device = roster?.devices[deviceId], device.role == "phone",
      Signing.verify(publicKey: device.transportKey, domain: .relayAuth, payload: payload, signature: signature)
    else { return HubResponse(status: 401, body: "") }
    var refused: String?
    if !append.isEmpty {
      if case .success = Roster.verify(chain + append) {
        chain += append
        let listed = roster?.devices ?? [:]
        joining.removeAll { listed[$0.macId] != nil }
      } else {
        let head = roster?.head
        let prev = (try? RosterChange.parse(append[0].payload))?.prev
        refused = prev != head ? "conflict" : "invalid"
      }
    }
    var fields: [(String, JSONValue)] = [
      ("account", .string(accountId)), ("relay", .string(relay)), ("changes", .array(chain.map(\.json))),
    ]
    if let refused { fields.append(("refused", .string(refused))) }
    let listed = roster?.devices ?? [:]
    fields.append(("joining", .array(joining.filter { listed[$0.macId] == nil }.map { join in
      .object([("macId", .string(join.macId)), ("record", join.record.json), ("at", .string(ISOTime.format(join.at)))])
    })))
    fields.append(("nodes", .array(nodes.map { node in
      .object([("macId", .string(node.macId)), ("slug", .string(node.slug)), ("name", .string(node.name)), ("online", .bool(node.online))])
    })))
    return HubResponse(status: 200, body: JSON.serialize(.object(fields)))
  }
}
