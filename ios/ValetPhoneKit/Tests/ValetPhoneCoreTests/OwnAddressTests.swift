import XCTest

@testable import ValetCrypto
@testable import ValetFakes
@testable import ValetPhoneCore
@testable import ValetProtocol

/// The phone reaching its Mac at the Mac's own address at the blind relay (docs/blind-relay.md#phones),
/// `https://<macId>.<macDomain>`, and nowhere else: the Worker relay and the hub closed (2026-11-22).
@MainActor
final class OwnAddressTests: XCTestCase {
  var world: FakeWorld!
  var model: PhoneModel!
  var store: MemoryPhoneStore!
  var time: TestClock!
  var keys: SoftwareDeviceKeys!
  var base = 0

  var own: String { "https://\(world.mac.macId).macs.test" }

  /// Pairs through the fake relay, then reopens the phone as a new launch would, knowing the
  /// Macs' domain. `ownReachable` says whether the Mac answers at its own address.
  func setUp(ownReachable: Bool, macDomain: String? = "macs.test") {
    world = FakeWorld(.quiet, autoDeliver: false)
    store = MemoryPhoneStore()
    time = TestClock()
    keys = SoftwareDeviceKeys()
    let keys = self.keys!
    let factory = PhoneModel.Keys(make: { keys }, load: { _ in keys })
    let first = PhoneModel(transport: world.relay, store: store, clock: time.clock, keys: factory)
    world.pair(first)
    world.relay.drain()
    XCTAssertEqual(first.phase, .paired)
    first.disconnect()
    world.relay.drain()
    base = world.relay.dialled.count
    if ownReachable { world.relay.alsoAnswers = [own] }
    model = PhoneModel(transport: world.relay, store: store, clock: time.clock, keys: factory, macDomain: macDomain)
    XCTAssertEqual(model.phase, .paired)
  }

  func dialledSinceReopen() -> [String] { Array(world.relay.dialled.dropFirst(base)) }

  func testDialsTheMacsOwnAddressFirstAndApprovesThere() async throws {
    setUp(ownReachable: true)
    model.connect()
    world.relay.drain()
    XCTAssertEqual(dialledSinceReopen(), [own])
    XCTAssertTrue(model.connected)
    XCTAssertEqual(model.macAddress, own)
    world.mac.ask(.install(id: "7B3Fxxxxxxxxxxxxxxxxxx"))
    world.relay.drain()
    time.advance(2)
    let entry = try XCTUnwrap(model.cards.first { $0.id.hasPrefix("7B3F") })
    try await model.approve(entry.id)
    world.relay.drain()
    XCTAssertEqual(model.cards.first { $0.id.hasPrefix("7B3F") }?.state, .approvedHere)
  }

  func testNeverFallsBackToTheRelayItPairedThrough() {
    setUp(ownReachable: false)
    for _ in 0..<3 {
      model.connect()
      world.relay.drain()
      XCTAssertFalse(model.connected)
    }
    XCTAssertEqual(dialledSinceReopen(), [own, own, own])
  }

  func testAPhoneAnOlderBuildSignedInToTheAccountIsAskedToPair() {
    let keys = SoftwareDeviceKeys()
    let store = MemoryPhoneStore(PersistedPhone(
      macId: "mac_0123456789abcdef", macApprovalKey: "k", macAgreementKey: "k", relay: "https://valet.example",
      keys: keys.stored, name: "iPhone", macName: "Mac", recordPayload: nil, recordSignature: nil, lastInbound: 3,
      nextOutbound: 2, outbox: [:], requests: [], viaAccount: true
    ))
    let relay = FakeRelay(mac: FakeMac(), autoDeliver: false)
    let model = PhoneModel(
      transport: relay, store: store, keys: PhoneModel.Keys(make: { keys }, load: { _ in keys }), macDomain: "macs.test")
    XCTAssertEqual(model.phase, .unpaired(notice: PhoneModel.accountClosedNotice))
    XCTAssertNil(store.state, "the account's state is forgotten")
    model.connect()
    relay.drain()
    XCTAssertTrue(relay.dialled.isEmpty, "nothing to dial until it pairs")
  }

  func testNeverSignsAChallengeForAnotherOrigin() {
    setUp(ownReachable: true)
    world.relay.tamperToPhone = { text in
      text.contains("\"challenge\"") ? text.replacingOccurrences(of: self.own, with: "https://evil.example") : text
    }
    model.connect()
    world.relay.drain()
    XCTAssertFalse(model.connected)
    XCTAssertGreaterThan(model.dropped, 0)
  }

  func testWithoutADomainDialsOnlyThePairedRelay() {
    setUp(ownReachable: true, macDomain: nil)
    XCTAssertEqual(model.macAddress, world.relay.origin)
    model.connect()
    world.relay.drain()
    XCTAssertEqual(dialledSinceReopen(), [world.relay.origin])
    XCTAssertTrue(model.connected)
  }

  func testAPhonePairedAtTheOwnAddressDialsOnlyThat() {
    world = FakeWorld(.quiet, autoDeliver: false)
    let own = "https://\(world.mac.macId).macs.test"
    store = MemoryPhoneStore()
    time = TestClock()
    keys = SoftwareDeviceKeys()
    let keys = self.keys!
    let fake = FakeRelay(origin: own, mac: world.mac, autoDeliver: false)
    model = PhoneModel(
      transport: fake, store: store, clock: time.clock, keys: PhoneModel.Keys(make: { keys }, load: { _ in keys }),
      macDomain: "macs.test")
    model.pair(qr: world.mac.pairingQR(relay: own), name: "iPhone")
    fake.drain()
    XCTAssertEqual(model.phase, .paired)
    XCTAssertTrue(model.connected)
    XCTAssertEqual(model.macAddress, own, "the address it paired through is the Mac's own")
    XCTAssertTrue(fake.dialled.allSatisfy { $0 == own })
  }

  func testRefusesADomainThatIsntOne() {
    XCTAssertTrue(PhoneModel.validDomain("valet.dncr.me"))
    XCTAssertFalse(PhoneModel.validDomain("localhost"))
    XCTAssertFalse(PhoneModel.validDomain("evil.example/path"))
    XCTAssertFalse(PhoneModel.validDomain("-bad.example"))
    XCTAssertFalse(PhoneModel.validDomain("a..b"))
  }
}
