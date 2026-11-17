import XCTest

@testable import ValetCrypto
@testable import ValetFakes
@testable import ValetPhoneCore
@testable import ValetProtocol

/// The phone on the Valet account (docs/relay-hub.md, step 4c), against a fake hub that keeps the
/// list the way apps/relay's hub does. The phone pairs with a fake Mac first, as a person would.
@MainActor
final class AccountTests: XCTestCase {
  var world: FakeWorld!
  var hub: FakeHub!
  var model: PhoneModel!
  var store: MemoryPhoneStore!
  var keys: SoftwareDeviceKeys!

  override func setUp() async throws {
    world = FakeWorld(.quiet, autoDeliver: false)
    hub = FakeHub(relay: world.relay.origin)
    store = MemoryPhoneStore()
    keys = SoftwareDeviceKeys()
    model = makeModel()
    world.pair(model)
    world.relay.drain()
    XCTAssertEqual(model.phase, .paired)
  }

  func makeModel() -> PhoneModel {
    let keys = self.keys!
    return PhoneModel(transport: world.relay, store: store, keys: PhoneModel.Keys(make: { keys }, load: { _ in keys }), hub: hub)
  }

  var me: String { keys.publicKeys.deviceId }

  /// The Mac links to the hub, starts the list with the phone on it, and tells the phone.
  func linkMac() throws -> AccountModel {
    hub.start(by: world.mac)
    world.mac.account = hub.account
    world.mac.sendStatus()
    world.relay.drain()
    return try XCTUnwrap(model.account)
  }

  func ready() async throws -> AccountModel {
    let account = try linkMac()
    await account.refresh()
    XCTAssertEqual(account.state, .ready)
    return account
  }

  func phoneDevice() -> RosterDevice { RosterDevice(keys: keys.publicKeys, name: "iPhone") }

  func testSignsInReadsTheListAndPinsIt() async throws {
    XCTAssertNil(model.account)
    let account = try await ready()
    XCTAssertEqual(account.devices.map(\.deviceId), [world.mac.macId, me])
    XCTAssertEqual(account.relay, world.relay.origin)
    XCTAssertEqual(account.name(world.mac.macId), world.mac.name)
    XCTAssertTrue(account.online(world.mac.macId))
    XCTAssertEqual(hub.calls, ["/phone/challenge", "/phone/account"])
    let pin = try XCTUnwrap(store.state?.account)
    XCTAssertEqual(pin.genesis, hub.roster?.genesis)
    XCTAssertEqual(pin.seq, 1)
    XCTAssertEqual(pin.head, hub.roster?.head)
    // No Face ID to read the list: only the transport key signs.
    XCTAssertEqual(keys.reasons, [])
  }

  func testAddsAWaitingMacWithTheKeysItsOwnRecordNames() async throws {
    let account = try await ready()
    let mini = FakeMac(name: "Nick\u{2019}s Mac mini")
    hub.askToJoin(mini)
    await account.refresh()
    XCTAssertEqual(account.waiting.map(\.id), [mini.macId])
    XCTAssertEqual(account.waiting.first?.name, mini.name)
    try await account.add(mini.macId)
    XCTAssertEqual(keys.reasons, ["Add \(mini.name) to your Valet account"])
    XCTAssertEqual(account.devices.map(\.deviceId), [world.mac.macId, me, mini.macId])
    XCTAssertEqual(account.waiting, [])
    XCTAssertEqual(hub.roster?.devices[mini.macId], mini.rosterDevice)
    XCTAssertEqual(store.state?.account?.seq, 2)
  }

  func testAddsNothingWhenFaceIDFails() async throws {
    let account = try await ready()
    let mini = FakeMac(name: "Mac mini")
    hub.askToJoin(mini)
    await account.refresh()
    keys.presence = { _ in false }
    do {
      try await account.add(mini.macId)
      XCTFail("added without Face ID")
    } catch let refusal as AccountChangeRefusal {
      XCTAssertEqual(refusal, .faceIDFailed)
    }
    XCTAssertEqual(hub.roster?.devices.count, 2)
    XCTAssertEqual(account.waiting.map(\.id), [mini.macId])
  }

  func testOnlyOffersAMacWhoseOwnRecordSaysSo() async throws {
    let account = try await ready()
    let mini = FakeMac(name: "Mac mini")
    let other = FakeMac(name: "Someone else\u{2019}s Mac")
    // The hub names one Mac but hands over another's record, or one whose payload it edited.
    hub.joining.append(FakeHub.Join(macId: mini.macId, record: other.joinRecord(), at: Date()))
    let record = mini.joinRecord()
    let edited = SignedText(payload: record.payload.replacingOccurrences(of: "Mac mini", with: "Mac maxi"), signature: record.signature)
    hub.joining.append(FakeHub.Join(macId: mini.macId, record: edited, at: Date()))
    await account.refresh()
    XCTAssertEqual(account.state, .ready)
    XCTAssertEqual(account.waiting, [])
    do {
      try await account.add(mini.macId)
      XCTFail("added a Mac nobody offered")
    } catch let refusal as AccountChangeRefusal {
      XCTAssertEqual(refusal, .unknownDevice)
    }
  }

  func testRefusesAListThatDoesntStartWhereItsPinDoes() async throws {
    let account = try await ready()
    // The hub swaps in a list of its own making: the same Mac and phone, a new first change.
    let pinned = store.state?.account
    hub.start(by: world.mac, at: Date().addingTimeInterval(5))
    await account.refresh()
    XCTAssertEqual(account.state, .failed(.doesntCheck))
    XCTAssertEqual(store.state?.account, pinned)
  }

  func testRefusesAListRolledBack() async throws {
    let account = try await ready()
    let mini = FakeMac(name: "Mac mini")
    hub.askToJoin(mini)
    await account.refresh()
    let before = hub.chain
    try await account.add(mini.macId)
    hub.chain = before
    await account.refresh()
    XCTAssertEqual(account.state, .failed(.doesntCheck))
    XCTAssertEqual(account.devices.count, 3)
  }

  func testTheFirstListMustHaveTheMacThisPhonePairedWith() async throws {
    // Another Mac started a list and put this phone on it; the paired Mac isn't there.
    let stranger = FakeMac(name: "Stranger")
    hub.chain = [stranger.signRoster(Roster.next(nil, account: hub.accountId, by: stranger.macId, change: .add(stranger.rosterDevice), at: Date()))]
    hub.append(by: stranger, .add(phoneDevice()))
    world.mac.account = hub.account
    world.mac.sendStatus()
    world.relay.drain()
    let account = try XCTUnwrap(model.account)
    await account.refresh()
    XCTAssertEqual(account.state, .failed(.doesntCheck))
    XCTAssertNil(store.state?.account)
    XCTAssertEqual(account.devices, [])
  }

  func testSaysSoWhenThisPhoneWasTakenOffTheList() async throws {
    let account = try await ready()
    hub.append(by: world.mac, .remove(me))
    await account.refresh()
    XCTAssertEqual(account.state, .failed(.notOnList))
  }

  func testSaysSoWhenTheHubCantBeReached() async throws {
    let account = try linkMac()
    hub.reachable = false
    await account.refresh()
    XCTAssertEqual(account.state, .failed(.unreachable))
    hub.reachable = true
    await account.refresh()
    XCTAssertEqual(account.state, .ready)
  }

  func testTakesTheNewListWhenItChangedFirstThenAddsOnTop() async throws {
    let account = try await ready()
    let mini = FakeMac(name: "Mac mini")
    hub.askToJoin(mini)
    await account.refresh()
    // The Mac adds another device while the person looks at the list.
    let studio = FakeMac(name: "Mac Studio")
    hub.append(by: world.mac, .add(studio.rosterDevice))
    do {
      try await account.add(mini.macId)
      XCTFail("added on top of an old list")
    } catch let refusal as AccountChangeRefusal {
      XCTAssertEqual(refusal, .changed)
    }
    XCTAssertEqual(account.state, .ready)
    XCTAssertEqual(account.devices.map(\.deviceId), [world.mac.macId, me, studio.macId])
    try await account.add(mini.macId)
    XCTAssertEqual(hub.roster?.devices.count, 4)
  }

  func testRemovesAnotherDeviceButNotItself() async throws {
    let account = try await ready()
    let mini = FakeMac(name: "Mac mini")
    hub.append(by: world.mac, .add(mini.rosterDevice))
    await account.refresh()
    try await account.remove(mini.macId)
    XCTAssertEqual(keys.reasons, ["Remove Mac mini from your Valet account"])
    XCTAssertNil(hub.roster?.devices[mini.macId])
    do {
      try await account.remove(me)
      XCTFail("removed itself")
    } catch let refusal as AccountChangeRefusal {
      XCTAssertEqual(refusal, .isThisPhone)
    }
  }

  func testKeepsThePinAcrossLaunches() async throws {
    _ = try await ready()
    let pinned = try XCTUnwrap(store.state?.account)
    model.disconnect()
    model = makeModel()
    let account = try XCTUnwrap(model.account)
    XCTAssertEqual(account.pin, pinned)
    await account.refresh()
    XCTAssertEqual(account.state, .ready)
    // And a swapped list is still refused after the restart.
    hub.start(by: world.mac, at: Date().addingTimeInterval(5))
    await account.refresh()
    XCTAssertEqual(account.state, .failed(.doesntCheck))
  }

  func testForgetsTheAccountWhenUnpaired() async throws {
    _ = try await ready()
    model.unpair()
    XCTAssertNil(model.account)
    XCTAssertNil(store.state)
  }
}
