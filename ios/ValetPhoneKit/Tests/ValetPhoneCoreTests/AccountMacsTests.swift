import XCTest

@testable import ValetCrypto
@testable import ValetFakes
@testable import ValetPhoneCore
@testable import ValetProtocol

/// The phone reaching every Mac on the Valet account (docs/relay-hub.md, step 4c): it pairs with
/// one Mac, adds a second that asked to join, and then answers that Mac's requests on a channel of
/// its own, with no second pairing.
@MainActor
final class AccountMacsTests: XCTestCase {
  var laptop: FakeMac!
  var mini: FakeMac!
  var relays: FakeRelays!
  var hub: FakeHub!
  var model: PhoneModel!
  var store: MemoryPhoneStore!
  var macStores: [String: MemoryPhoneStore] = [:]
  var keys: SoftwareDeviceKeys!
  var time: TestClock!

  override func setUp() async throws {
    let origin = "https://relay.valet.test"
    laptop = FakeMac(name: "Nick\u{2019}s MacBook Pro")
    mini = FakeMac(name: "Nick\u{2019}s Mac mini")
    relays = FakeRelays([
      FakeRelay(origin: origin, mac: laptop, autoDeliver: false), FakeRelay(origin: origin, mac: mini, autoDeliver: false),
    ])
    hub = FakeHub(relay: origin)
    store = MemoryPhoneStore()
    keys = SoftwareDeviceKeys()
    time = TestClock()
    model = makeModel()
    model.pair(qr: laptop.pairingQR(relay: origin), name: "iPhone")
    relays.drain()
    XCTAssertEqual(model.phase, .paired)
  }

  func makeModel() -> PhoneModel {
    let keys = self.keys!
    return PhoneModel(
      transport: relays, store: store, clock: time.clock, keys: PhoneModel.Keys(make: { keys }, load: { _ in keys }), hub: hub,
      macStore: { [unowned self] id in
        if let existing = self.macStores[id] { return existing }
        let made = MemoryPhoneStore()
        self.macStores[id] = made
        return made
      }
    )
  }

  var me: RosterDevice { RosterDevice(keys: keys.publicKeys, name: "iPhone") }

  /// The laptop starts the list with the phone; the mini asks to join and the phone adds it.
  func addMini() async throws -> PhoneModel {
    hub.start(by: laptop)
    laptop.account = hub.account
    laptop.sendStatus()
    relays.drain()
    let account = try XCTUnwrap(model.account)
    hub.askToJoin(mini)
    await account.refresh()
    XCTAssertEqual(model.otherMacs.count, 0)
    try await account.add(mini.macId)
    // The mini hears the list from the hub and trusts the phone on it.
    mini.trust(phone: me)
    relays.drain()
    let other = try XCTUnwrap(model.otherMacs.first)
    XCTAssertEqual(other.macId, mini.macId)
    return other
  }

  func testAnswersASecondMacsRequestWithoutPairingAgain() async throws {
    let other = try await addMini()
    XCTAssertEqual(other.phase, .paired)
    XCTAssertTrue(other.connected)
    XCTAssertTrue(other.macOnline)
    XCTAssertEqual(other.macName, mini.name)
    XCTAssertEqual(model.allMacs.map(\.macId), [laptop.macId, mini.macId])
    let id = mini.ask(.install())
    relays.drain()
    time.advance(2)
    XCTAssertEqual(other.openCards.map(\.id), [id])
    XCTAssertEqual(model.openCards, [], "the laptop's inbox doesn't get the mini's cards")
    try await other.approve(id)
    relays.drain()
    XCTAssertEqual(mini.events.last, .approved(requestId: id, deviceId: keys.publicKeys.deviceId, choice: nil))
    XCTAssertEqual(other.cards.first?.state, .approvedHere)
    // The laptop's channel is unaffected.
    let laptopId = laptop.ask(.install())
    relays.drain()
    time.advance(2)
    try await model.approve(laptopId)
    relays.drain()
    XCTAssertEqual(laptop.events.last, .approved(requestId: laptopId, deviceId: keys.publicKeys.deviceId, choice: nil))
  }

  func testForgetsAMacTheListDrops() async throws {
    let other = try await addMini()
    XCTAssertNotNil(macStores[mini.macId]?.state)
    hub.append(by: laptop, .remove(mini.macId))
    await model.account?.refresh()
    XCTAssertEqual(model.otherMacs.count, 0)
    XCTAssertFalse(other.connected)
    XCTAssertNil(macStores[mini.macId]?.state)
    XCTAssertEqual(model.allMacs.map(\.macId), [laptop.macId])
  }

  func testComesBackAfterARelaunchWithItsChannelState() async throws {
    let other = try await addMini()
    let id = mini.ask(.install())
    relays.drain()
    XCTAssertEqual(other.cards.count, 1)
    model.disconnect()
    model = makeModel()
    model.connect()
    await model.account?.refresh()
    relays.drain()
    let again = try XCTUnwrap(model.otherMacs.first)
    XCTAssertEqual(again.cards.map(\.id), [id])
    XCTAssertTrue(again.connected)
  }

  func testUnpairForgetsEveryMac() async throws {
    _ = try await addMini()
    model.unpair()
    XCTAssertEqual(model.otherMacs.count, 0)
    XCTAssertNil(macStores[mini.macId]?.state)
    XCTAssertNil(store.state)
  }

  func testAMacThatDropsThePhoneStopsOnlyItself() async throws {
    let other = try await addMini()
    mini.revokePhone()
    relays.drain()
    XCTAssertNotEqual(other.phase, .paired)
    XCTAssertEqual(model.phase, .paired)
    XCTAssertEqual(model.allMacs.map(\.macId), [laptop.macId])
  }
}
