import XCTest

@testable import ValetCrypto
@testable import ValetFakes
@testable import ValetPhoneCore
@testable import ValetProtocol

/// Signing the phone in to the Valet account with a passkey (docs/relay-hub.md, step 4d): no QR
/// code and no pairing. The Mac put the account's passkey on the list; the passkey adds the phone
/// on the hub's page; the phone then reads the account, pins it and reaches its Macs.
@MainActor
final class SignInTests: XCTestCase {
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
    hub.start(by: laptop)
    hub.append(by: laptop, .addPasskey(hub.passkey))
    laptop.account = hub.account
    store = MemoryPhoneStore()
    keys = SoftwareDeviceKeys()
    time = TestClock()
    model = makeModel()
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

  var me: RosterDevice { RosterDevice(keys: keys.publicKeys, name: "Nick\u{2019}s iPhone") }

  /// The page the app opens, and the device it carries in its fragment.
  func startSignIn() throws -> RosterDevice {
    let url = try XCTUnwrap(model.startSignIn(hub: hub.origin, name: "Nick\u{2019}s iPhone"))
    XCTAssertEqual(url.path, "/phone")
    XCTAssertEqual(model.signIn, .inBrowser)
    let fragment = try XCTUnwrap(url.fragment)
    let items = URLComponents(string: "x:?\(fragment)")?.queryItems ?? []
    XCTAssertEqual(items.first { $0.name == "return" }?.value, "valet")
    let encoded = try XCTUnwrap(items.first { $0.name == "device" }?.value)
    let json = try XCTUnwrap(Base64URL.decode(encoded))
    return try RosterDevice.parse(try JSON.parse(String(decoding: json, as: UTF8.self)), "device")
  }

  func testSignsInWithThePasskeyAndAnswersTheMacWithoutPairing() async throws {
    let device = try startSignIn()
    XCTAssertEqual(device, me)
    XCTAssertTrue(hub.signInWithPasskey(device))
    await model.finishSignIn()
    XCTAssertEqual(model.signIn, .idle)
    XCTAssertEqual(model.phase, .paired)
    XCTAssertEqual(model.macId, laptop.macId)
    XCTAssertEqual(store.state?.viaAccount, true)
    XCTAssertEqual(store.state?.account?.accountId, hub.accountId)
    XCTAssertEqual(store.state?.account?.genesis, hub.roster?.genesis)
    let account = try XCTUnwrap(model.account)
    await account.refresh()
    XCTAssertEqual(account.state, .ready)

    // The Mac knows the phone from the list, not from pairing: its approval counts.
    laptop.trust(phone: me)
    model.connect()
    relays.drain()
    XCTAssertTrue(model.connected)
    let id = laptop.ask(.install())
    relays.drain()
    time.advance(2)
    try await model.approve(id)
    relays.drain()
    XCTAssertEqual(laptop.events.last, .approved(requestId: id, deviceId: keys.publicKeys.deviceId, choice: nil))

    // After a relaunch it's still signed in, on the same pinned list.
    model.disconnect()
    model = makeModel()
    XCTAssertEqual(model.phase, .paired)
    await model.account?.refresh()
    XCTAssertEqual(model.account?.state, .ready)
  }

  func testRefusesAListThatDoesntHoldThisPhoneAddedByAPasskey() async throws {
    // Back from the page without the passkey having signed anything.
    _ = try startSignIn()
    await model.finishSignIn()
    XCTAssertEqual(model.signIn, .failed("This iPhone isn\u{2019}t on your Valet account yet. Try signing in again."))
    XCTAssertNotEqual(model.phase, .paired)
    XCTAssertNil(store.state)

    // A hub that added the phone with a Mac's signature instead: not a passkey sign-in, so not taken.
    model = makeModel()
    let device = try startSignIn()
    hub.append(by: laptop, .add(device))
    await model.finishSignIn()
    XCTAssertEqual(model.signIn, .failed(AccountProblem.doesntCheck.rawValue))
    XCTAssertNotEqual(model.phase, .paired)
  }

  func testAPasskeyCantAddAMacOrSignForAnotherSite() throws {
    guard let roster = hub.roster else { return XCTFail("no list") }
    let addMac = Roster.next(roster, account: hub.accountId, by: Roster.passkeySigner, change: .add(mini.rosterDevice), at: Date())
    XCTAssertEqual(Self.failure(Roster.verify(hub.chain + [hub.passkeyAssertion(addMac)]))?.reason, .notAllowed)
    let addPhone = Roster.next(roster, account: hub.accountId, by: Roster.passkeySigner, change: .add(me), at: Date())
    XCTAssertEqual(
      Self.failure(Roster.verify(hub.chain + [hub.passkeyAssertion(addPhone, origin: "https://evil.example")]))?.reason,
      .badSignature
    )
    XCTAssertNoThrow(try Roster.verify(hub.chain + [hub.passkeyAssertion(addPhone)]).get())
    // A device's change can't carry an assertion, and a passkey's must.
    let bare = hub.passkeyAssertion(addPhone)
    XCTAssertEqual(
      Self.failure(Roster.verify(hub.chain + [SignedText(payload: addPhone, signature: bare.signature)]))?.reason, .malformed
    )
  }

  func testMovesToAnotherMacWhenTheListDropsTheFirstOne() async throws {
    let device = try startSignIn()
    hub.signInWithPasskey(device)
    await model.finishSignIn()
    XCTAssertEqual(model.macId, laptop.macId)
    // The laptop lost its keys: the mini is on the list, and the laptop is taken off it.
    hub.append(by: laptop, .add(mini.rosterDevice))
    hub.append(by: mini, .remove(laptop.macId))
    hub.nodes = [HubPhone.Node(macId: mini.macId, slug: "mini", name: mini.name, online: true)]
    await model.account?.refresh()
    XCTAssertEqual(model.macId, mini.macId)
    XCTAssertEqual(model.otherMacs.count, 0)
    mini.trust(phone: me)
    relays.drain()
    XCTAssertTrue(model.connected)
  }

  func testRefusesAnAddressThatIsntAHub() {
    XCTAssertNil(model.startSignIn(hub: "valet.dncr.me", name: "iPhone"))
    XCTAssertEqual(model.signIn, .failed("That isn\u{2019}t a Valet account address."))
  }

  static func failure(_ result: Result<Roster, Roster.CheckError>) -> Roster.CheckError? {
    if case let .failure(error) = result { return error }
    return nil
  }
}
