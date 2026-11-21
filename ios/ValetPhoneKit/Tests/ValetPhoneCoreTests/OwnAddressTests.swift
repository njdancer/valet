import XCTest

@testable import ValetCrypto
@testable import ValetFakes
@testable import ValetPhoneCore
@testable import ValetProtocol

/// The phone reaching its Mac at the Mac's own address at the blind relay (docs/blind-relay.md#phones),
/// `https://<macId>.<macDomain>`, with the relay it paired through as the fallback.
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
    XCTAssertTrue(model.dialledOwnAddress)
    world.mac.ask(.install(id: "7B3Fxxxxxxxxxxxxxxxxxx"))
    world.relay.drain()
    time.advance(2)
    let entry = try XCTUnwrap(model.cards.first { $0.id.hasPrefix("7B3F") })
    try await model.approve(entry.id)
    world.relay.drain()
    XCTAssertEqual(model.cards.first { $0.id.hasPrefix("7B3F") }?.state, .approvedHere)
  }

  func testFallsBackToThePairedRelayWhenTheOwnAddressDoesntAnswer() {
    setUp(ownReachable: false)
    model.connect()
    world.relay.drain()
    XCTAssertFalse(model.connected)
    model.connect()
    world.relay.drain()
    XCTAssertEqual(dialledSinceReopen(), [own, world.relay.origin])
    XCTAssertTrue(model.connected)
    XCTAssertFalse(model.dialledOwnAddress)
  }

  func testGoesBackToTheOwnAddressWhenThePairedRelayHasntSeenTheMac() {
    setUp(ownReachable: false)
    model.connect()
    world.relay.drain()
    model.connect()
    world.relay.drain()
    XCTAssertTrue(model.connected)
    // The Mac leaves the old relay for the blind one: the old relay says it's gone.
    world.mac.setOnline(false)
    world.relay.drain()
    XCTAssertFalse(model.macOnline)
    world.relay.alsoAnswers = [own]
    time.advance(PhoneModel.retryOwnAddressAfter - 1)
    model.connect()
    world.relay.drain()
    XCTAssertFalse(model.dialledOwnAddress, "not before the wait")
    time.advance(2)
    model.connect()
    world.relay.drain()
    XCTAssertTrue(model.dialledOwnAddress)
    XCTAssertTrue(model.connected)
    XCTAssertEqual(dialledSinceReopen().last, own)
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
    XCTAssertNil(model.ownAddress)
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
    XCTAssertNil(model.ownAddress, "the address it paired through is the Mac's own")
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
