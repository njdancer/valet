// The phone on the Valet account (docs/relay-hub.md, step 4c). The Mac the phone paired with
// says which account they are on; the phone signs in to that account's hub with its transport
// key, reads the account's device list and checks every change on it itself, and adds a Mac that
// asked to join with a change signed by its approval key (Face ID).
//
// What the phone trusts:
// - The first list it accepts must be the account the paired Mac named, with that Mac and this
//   phone (all three keys) on it. The phone then pins the list's first change, as the Mac does.
// - Every later list must start with the pinned change and still hold the last head the phone
//   saw, so a hub can't swap the list or roll it back.
// - A Mac waiting to join is added with the keys in its own signed record, never the hub's word.

import Foundation
import Observation
import ValetCrypto
import ValetProtocol

/// One HTTPS answer from the hub.
public struct HubResponse: Equatable, Sendable {
  public let status: Int
  public let body: String

  public init(status: Int, body: String) {
    self.status = status
    self.body = body
  }
}

/// How the phone reaches the hub: URLSession in the app, `FakeHub` (ValetFakes) in tests.
@MainActor
public protocol HubTransport: AnyObject {
  /// POSTs JSON to `url`. Throws only when the hub can't be reached.
  func post(_ url: String, body: String) async throws -> HubResponse
}

/// What the phone keeps about the account between launches.
public struct AccountPin: Codable, Equatable, Sendable {
  public var hub: String
  public var accountId: String
  /// The hash of the list's first change.
  public var genesis: String
  /// The last list the phone accepted.
  public var seq: Int
  public var head: String
}

public enum AccountProblem: String, Error, Equatable, Sendable {
  case unreachable = "Valet can\u{2019}t reach your account right now. It tries again when you come back."
  case notOnList = "This iPhone isn\u{2019}t on your Valet account. Pair it again at your Mac."
  case doesntCheck = "Your account\u{2019}s device list didn\u{2019}t check out, so this iPhone isn\u{2019}t using it."
}

public enum AccountState: Equatable, Sendable {
  /// Not read yet.
  case unknown
  case checking
  case ready
  case failed(AccountProblem)
}

public enum AccountChangeRefusal: Error, Equatable {
  /// The list isn't read and checked yet.
  case notReady
  /// No such Mac waiting, or no such device on the list.
  case unknownDevice
  /// This phone can't remove itself here.
  case isThisPhone
  /// The account can't have more devices.
  case full
  case faceIDFailed
  /// The list changed at the hub first. It is read again; try again.
  case changed
  /// The hub didn't keep the change.
  case refused
  case unreachable
}

/// A Mac that asked to join the account's list, with the keys its own record names.
public struct WaitingMac: Identifiable, Equatable, Sendable {
  public let device: RosterDevice
  public let askedAt: Date
  public var id: String { device.deviceId }
  public var name: String { device.name }
}

@MainActor
@Observable
public final class AccountModel {
  public let hub: String
  public let accountId: String
  public private(set) var state: AccountState = .unknown
  /// The devices on the list, in the order they were added.
  public private(set) var devices: [RosterDevice] = []
  public private(set) var waiting: [WaitingMac] = []
  /// The account's Macs at the hub, for their names and whether they are online.
  public private(set) var nodes: [HubPhone.Node] = []
  /// The relay every Mac on the account dials.
  public private(set) var relay: String?
  public private(set) var roster: Roster?
  public private(set) var pin: AccountPin?

  private let transport: HubTransport
  private let keys: DeviceKeys
  private let pairedMac: (id: String, approvalKey: String)
  private let clock: PhoneClock
  private let onPin: (AccountPin) -> Void
  private var chain: [SignedText] = []
  private var busy = false

  public init(
    hub: String, accountId: String, transport: HubTransport, keys: DeviceKeys, pairedMac: (id: String, approvalKey: String),
    pin: AccountPin?, clock: PhoneClock = .system, onPin: @escaping (AccountPin) -> Void
  ) {
    self.hub = hub
    self.accountId = accountId
    self.transport = transport
    self.keys = keys
    self.pairedMac = pairedMac
    self.clock = clock
    self.onPin = onPin
    // A pin for another account (the Mac moved) doesn't count here.
    self.pin = pin.flatMap { $0.hub == hub && $0.accountId == accountId ? $0 : nil }
  }

  public var me: String { keys.publicKeys.deviceId }

  /// The name a device on the list goes by: the hub's name for a linked Mac, else its own.
  public func name(_ deviceId: String) -> String {
    nodes.first { $0.macId == deviceId }?.name ?? roster?.devices[deviceId]?.name ?? "A device"
  }

  /// Whether a Mac on the list is linked to the hub and online.
  public func online(_ deviceId: String) -> Bool { nodes.first { $0.macId == deviceId }?.online ?? false }

  /// Reads the account again. Safe to call often; a call while another runs does nothing.
  public func refresh() async {
    guard !busy else { return }
    busy = true
    defer { busy = false }
    if state != .ready { state = .checking }
    switch await signIn(append: []) {
    case let .success(account): _ = accept(account)
    case let .failure(problem): state = .failed(problem)
    }
  }

  /// Adds a waiting Mac with a change this phone signs (Face ID).
  public func add(_ macId: String) async throws {
    guard let entry = waiting.first(where: { $0.device.deviceId == macId }) else { throw AccountChangeRefusal.unknownDevice }
    guard let roster, roster.devices.count < Roster.maxDevices else {
      throw roster == nil ? AccountChangeRefusal.notReady : AccountChangeRefusal.full
    }
    try await change(.add(entry.device), reason: "Add \(entry.name) to your Valet account")
  }

  /// Takes a device off the list with a change this phone signs (Face ID).
  public func remove(_ deviceId: String) async throws {
    guard deviceId != me else { throw AccountChangeRefusal.isThisPhone }
    guard let device = roster?.devices[deviceId] else {
      throw roster == nil ? AccountChangeRefusal.notReady : AccountChangeRefusal.unknownDevice
    }
    try await change(.remove(deviceId), reason: "Remove \(device.name) from your Valet account")
  }

  private func change(_ op: RosterOp, reason: String) async throws {
    guard state == .ready, let roster, !busy else { throw AccountChangeRefusal.notReady }
    busy = true
    defer { busy = false }
    let payload = Roster.next(roster, account: roster.account, by: me, change: op, at: clock.now())
    let signature: Data
    do { signature = try await keys.signApproval(Signing.input(.rosterChange, payload), reason: reason) } catch {
      throw AccountChangeRefusal.faceIDFailed
    }
    let signed = SignedText(payload: payload, signature: Base64URL.encode(signature))
    // Checked here before it goes: the hub would refuse it anyway, but this catches a list that
    // changed under the person's tap.
    guard case .success = Roster.verify(chain + [signed]) else { throw AccountChangeRefusal.changed }
    switch await signIn(append: [signed]) {
    case let .failure(problem):
      if problem != .unreachable { state = .failed(problem) }
      throw problem == .unreachable ? AccountChangeRefusal.unreachable : AccountChangeRefusal.refused
    case let .success(account):
      guard accept(account) else { throw AccountChangeRefusal.refused }
      if account.refused == "conflict" { throw AccountChangeRefusal.changed }
      if account.refused != nil || !account.changes.contains(signed) { throw AccountChangeRefusal.refused }
    }
  }

  private func signIn(append: [SignedText]) async -> Result<HubPhone.Account, AccountProblem> {
    do {
      let challengeAnswer = try await transport.post("\(hub)/phone/challenge", body: "{}")
      guard challengeAnswer.status == 200, let challenge = try? HubPhone.Challenge.parse(challengeAnswer.body) else {
        return .failure(.unreachable)
      }
      let payload = PhoneToRelay.helloPayload(id: me, nonce: challenge.nonce, relay: hub)
      guard let signature = try? keys.signTransport(Signing.input(.relayAuth, payload)) else { return .failure(.unreachable) }
      let answer = try await transport.post(
        "\(hub)/phone/account",
        body: HubPhone.request(deviceId: me, nonce: challenge.nonce, signature: Base64URL.encode(signature), append: append)
      )
      if answer.status == 401 { return .failure(.notOnList) }
      guard answer.status == 200 else { return .failure(.unreachable) }
      guard let account = try? HubPhone.Account.parse(answer.body) else { return .failure(.doesntCheck) }
      return .success(account)
    } catch {
      return .failure(.unreachable)
    }
  }

  /// Checks the hub's answer and, if it holds, takes it. False if it didn't check.
  private func accept(_ account: HubPhone.Account) -> Bool {
    let known = pin.map { (seq: $0.seq, head: $0.head) }
    guard account.account == accountId,
      case let .success(checked) = Roster.verify(account.changes, pinned: pin?.genesis, known: known),
      checked.account == accountId
    else {
      state = .failed(.doesntCheck)
      return false
    }
    let mine = checked.devices[me]
    guard let mine, mine.approvalKey == keys.publicKeys.approval, mine.transportKey == keys.publicKeys.transport,
      mine.agreementKey == keys.publicKeys.agreement
    else {
      state = .failed(pin == nil ? .doesntCheck : .notOnList)
      return false
    }
    // The first list: only one that has the Mac this phone paired with, as that Mac signed itself.
    if pin == nil, checked.devices[pairedMac.id]?.approvalKey != pairedMac.approvalKey {
      state = .failed(.doesntCheck)
      return false
    }
    chain = account.changes
    roster = checked
    devices = checked.order.compactMap { checked.devices[$0] }
    relay = account.relay
    nodes = account.nodes
    waiting = account.joining.compactMap { join in
      guard checked.devices[join.macId] == nil, let device = Roster.joinDevice(join.record, macId: join.macId) else { return nil }
      return WaitingMac(device: device, askedAt: join.at)
    }
    let next = AccountPin(hub: hub, accountId: accountId, genesis: checked.genesis, seq: checked.seq, head: checked.head)
    if next != pin {
      pin = next
      onPin(next)
    }
    state = .ready
    return true
  }
}
