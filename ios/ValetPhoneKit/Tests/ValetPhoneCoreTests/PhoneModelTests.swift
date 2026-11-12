import XCTest

@testable import ValetCrypto
@testable import ValetFakes
@testable import ValetPhoneCore
@testable import ValetProtocol

final class TestClock: @unchecked Sendable {
  var now = Date()
  var uptime: TimeInterval = 1000
  var clock: PhoneClock { PhoneClock(now: { [unowned self] in self.now }, uptime: { [unowned self] in self.uptime }) }
  func advance(_ seconds: TimeInterval) {
    now = now.addingTimeInterval(seconds)
    uptime += seconds
  }
}

@MainActor
final class PhoneModelTests: XCTestCase {
  var world: FakeWorld!
  var model: PhoneModel!
  var store: MemoryPhoneStore!
  var time: TestClock!
  var keys: SoftwareDeviceKeys!

  func setUp(_ scenario: FakeWorld.Scenario, pair: Bool = true) {
    world = FakeWorld(scenario, autoDeliver: false)
    store = MemoryPhoneStore()
    time = TestClock()
    keys = SoftwareDeviceKeys()
    let keys = self.keys!
    model = PhoneModel(
      transport: world.relay, store: store, clock: time.clock,
      keys: PhoneModel.Keys(make: { keys }, load: { _ in keys })
    )
    if pair {
      world.pair(model)
      world.relay.drain()
      world.post()
      world.relay.drain()
      time.advance(2)
    }
  }

  func card(_ prefix: String) -> CardEntry? { model.cards.first { $0.id.hasPrefix(prefix) } }

  // MARK: J1

  func testPairsEndToEnd() throws {
    setUp(.quiet)
    XCTAssertEqual(model.phase, .paired)
    XCTAssertEqual(world.mac.events, [.paired(deviceId: keys.publicKeys.deviceId)])
    XCTAssertTrue(model.connected)
    XCTAssertTrue(model.macOnline)
    XCTAssertEqual(model.macName, world.mac.name)
    XCTAssertEqual(model.status?.agents.map(\.label), ["Claude Code", "Claude app"])
    XCTAssertNotNil(store.state?.recordPayload)
  }

  func testShowsTheSameCodeAsTheMac() {
    setUp(.quiet, pair: false)
    world.mac.autoConfirmPairing = false
    world.pair(model)
    world.relay.drain()
    guard case let .pairing(.code(code)) = model.phase else { return XCTFail("no code: \(model.phase)") }
    XCTAssertEqual(code, world.mac.pairingCode)
    world.mac.confirmPairingAtMac()
    world.relay.drain()
    XCTAssertEqual(model.phase, .paired)
  }

  func testWrongCodeAtTheMacPairsNothing() {
    setUp(.quiet, pair: false)
    world.mac.autoConfirmPairing = false
    world.pair(model)
    world.relay.drain()
    world.mac.rejectPairingAtMac()
    world.relay.drain()
    XCTAssertEqual(model.phase, .pairing(.failed(.abandoned)))
    XCTAssertNil(store.state)
  }

  func testRefusesAnExpiredOrForeignCode() {
    setUp(.quiet, pair: false)
    model.pair(qr: "https://example.com/not-valet", name: "iPhone")
    XCTAssertEqual(model.phase, .pairing(.failed(.notACode)))
    model.pair(qr: world.mac.pairingQR(relay: world.relay.origin, expiresIn: -120), name: "iPhone")
    XCTAssertEqual(model.phase, .pairing(.failed(.expired)))
  }

  func testAForgedPairingResultIsRefused() {
    setUp(.quiet, pair: false)
    world.relay.tamperToPhone = { text in
      guard text.contains("pairing-result") else { return text }
      // A relay can't seal for the QR's secret: swap in its own bytes.
      return text.replacingOccurrences(of: "\"ct\":\"", with: "\"ct\":\"AAAA")
    }
    world.pair(model)
    world.relay.drain()
    XCTAssertEqual(model.phase, .pairing(.failed(.abandoned)))
  }

  // MARK: J4

  func testApprovesAnInstallWithASignatureTheMacAccepts() async throws {
    setUp(.install)
    let entry = try XCTUnwrap(card("7B3F"))
    XCTAssertEqual(entry.card.title, "Install an adapter for yahoo.com")
    XCTAssertEqual(entry.card.askedBy, "Asked by Claude Code")
    XCTAssertEqual(entry.card.because, "Draft draft-7b3f")
    try await model.approve(entry.id)
    XCTAssertEqual(keys.reasons, [entry.card.faceIDReason])
    XCTAssertFalse(entry.card.faceIDReason.contains("Yahoo Finance"), "the agent's adapter name never reaches Face ID")
    XCTAssertEqual(card("7B3F")?.state, .sending)
    world.relay.drain()
    XCTAssertEqual(card("7B3F")?.state, .approvedHere)
    XCTAssertEqual(world.mac.events.last, .approved(requestId: entry.id, deviceId: keys.publicKeys.deviceId, choice: nil))
  }

  func testFaceIDFailureSendsNothing() async throws {
    setUp(.install)
    keys.presence = { _ in false }
    let entry = try XCTUnwrap(card("7B3F"))
    do {
      try await model.approve(entry.id)
      XCTFail("approved without Face ID")
    } catch {
      XCTAssertEqual(error as? ApproveRefusal, .faceIDFailed)
    }
    world.relay.drain()
    XCTAssertEqual(card("7B3F")?.state, .waiting)
    XCTAssertFalse(world.mac.events.contains { if case .approved = $0 { return true } else { return false } })
  }

  func testDeclineIsOneTapWithANote() throws {
    setUp(.install)
    let entry = try XCTUnwrap(card("7B3F"))
    model.decline(entry.id, note: "Not now")
    world.relay.drain()
    XCTAssertEqual(card("7B3F")?.state, .declinedHere)
    XCTAssertEqual(world.mac.events.last, .declined(requestId: entry.id, note: "Not now"))
    XCTAssertTrue(keys.reasons.isEmpty, "declining never asks for Face ID")
  }

  func testMacOnlyCardsCantBeApprovedHere() async throws {
    setUp(.cards)
    let unsandboxed = try XCTUnwrap(card("1D99"))
    XCTAssertEqual(unsandboxed.card.tone, .strong)
    XCTAssertNotNil(unsandboxed.card.macOnlyReason)
    XCTAssertEqual(model.approveBlocker(unsandboxed.id, readTicked: true, typedCode: nil), .macOnly)
    do {
      try await model.approve(unsandboxed.id, readTicked: true)
      XCTFail("approved a Mac-only card")
    } catch {
      XCTAssertEqual(error as? ApproveRefusal, .macOnly)
    }
    XCTAssertTrue(keys.reasons.isEmpty)
  }

  func testStrongCardsNeedTheReadTick() async throws {
    setUp(.cards)
    let confirm = try XCTUnwrap(card("8F20"))
    XCTAssertEqual(confirm.card.tone, .strong)
    XCTAssertEqual(confirm.card.approveLabel, "Confirm with Face ID")
    XCTAssertEqual(model.approveBlocker(confirm.id, readTicked: false, typedCode: nil), .needsReadTick)
    try await model.approve(confirm.id, readTicked: true)
    world.relay.drain()
    XCTAssertEqual(card("8F20")?.state, .approvedHere)
  }

  func testConnectNeedsTheTypedCodeAndTheMacChecksIt() async throws {
    setUp(.cards)
    let connect = try XCTUnwrap(card("4C55"))
    XCTAssertTrue(connect.card.needsTypedCode)
    XCTAssertEqual(model.approveBlocker(connect.id, readTicked: true, typedCode: "KQX"), .wrongCode)
    // A well-formed but wrong code reaches the Mac, which refuses it.
    try await model.approve(connect.id, readTicked: true, typedCode: "abcd efgh")
    world.relay.drain()
    XCTAssertEqual(card("4C55")?.state, .refused("wrong-code"))
    XCTAssertEqual(world.mac.events.last, .refused(requestId: connect.id, reason: "wrong-code"))
  }

  func testConnectWithTheRightCode() async throws {
    setUp(.cards)
    let connect = try XCTUnwrap(card("4C55"))
    try await model.approve(connect.id, readTicked: true, typedCode: "kqxm-rpdt")
    world.relay.drain()
    XCTAssertEqual(card("4C55")?.state, .approvedHere)
  }

  func testAnswerOnTheMacClosesTheCardHere() throws {
    setUp(.install)
    let entry = try XCTUnwrap(card("7B3F"))
    world.mac.answerAtMac(entry.id, approve: true)
    world.relay.drain()
    XCTAssertEqual(card("7B3F")?.state, .answeredElsewhere(.approved))
    XCTAssertEqual(card("7B3F")?.answeredBy, world.mac.name)
  }

  func testNotConfirmedThenCheckAgainResendsTheSameSignature() async throws {
    setUp(.install)
    let entry = try XCTUnwrap(card("7B3F"))
    world.relay.tamperToMac = { _ in nil }
    try await model.approve(entry.id)
    world.relay.drain()
    XCTAssertEqual(card("7B3F")?.state, .sending)
    time.advance(31)
    model.tick()
    XCTAssertEqual(card("7B3F")?.state, .notConfirmed)
    let first = card("7B3F")?.signedDecision
    world.relay.tamperToMac = nil
    try await model.approve(entry.id)
    XCTAssertEqual(keys.reasons.count, 1, "a resend doesn't sign again")
    world.relay.drain()
    XCTAssertEqual(card("7B3F")?.state, .approvedHere)
    XCTAssertEqual(card("7B3F")?.signedDecision, first)
  }

  func testExpiryRunsOnTheMonotonicClock() throws {
    setUp(.cards)
    // The wall clock jumping a day doesn't expire anything.
    time.now = time.now.addingTimeInterval(86_400 * 2)
    model.tick()
    XCTAssertEqual(card("8F20")?.state, .waiting)
    time.uptime += 121
    model.tick()
    XCTAssertEqual(card("8F20")?.state, .expired)
    XCTAssertEqual(card("7B3F")?.state, .waiting)
  }

  func testApproveWaitsAMomentAfterTheScreenChanged() throws {
    setUp(.install)
    world.mac.alert(kind: .notify, title: "Claude Code started a draft", body: "For yahoo.com")
    world.relay.drain()
    XCTAssertEqual(model.approveBlocker(try XCTUnwrap(card("7B3F")).id, readTicked: false, typedCode: nil), .tooSoon)
    time.advance(1.5)
    XCTAssertNil(model.approveBlocker(try XCTUnwrap(card("7B3F")).id, readTicked: false, typedCode: nil))
  }

  // MARK: J7

  func testLockDownDeclinesEverythingAndIsConfirmed() throws {
    setUp(.wrong)
    let session = try XCTUnwrap(card("6E11"))
    XCTAssertEqual(session.card.tone, .strong)
    XCTAssertTrue(session.card.becauseIsCaution, "a session not linked to anything is flagged")
    model.send(command: .lockdown)
    XCTAssertEqual(model.commands.first?.confirmed, false)
    world.relay.drain()
    XCTAssertEqual(model.commands.first?.confirmed, true)
    XCTAssertEqual(model.status?.safety, .lockdown)
    XCTAssertFalse(card("6E11")?.state.isOpen ?? true)
    XCTAssertTrue(keys.reasons.isEmpty, "lock down needs no Face ID")
  }

  func testRevokeAnAgentWithdrawsItsRequests() throws {
    setUp(.wrong)
    model.send(command: .revokeClient(FakeRequest.claudeCode))
    world.relay.drain()
    XCTAssertEqual(card("6E11")?.state, .withdrawn)
    XCTAssertFalse(model.status?.agents.contains { $0.clientId == FakeRequest.claudeCode } ?? true)
  }

  func testCantRevokeTheMacOrItself() {
    setUp(.quiet)
    model.send(command: .revokeDevice(world.mac.macId))
    model.send(command: .revokeDevice(keys.publicKeys.deviceId))
    XCTAssertTrue(model.commands.isEmpty)
  }

  func testLockAtTheRelay() {
    setUp(.quiet)
    model.lockAtRelay()
    world.relay.drain()
    XCTAssertTrue(world.relay.locked)
    XCTAssertTrue(model.relayLocked)
  }

  func testUnpairedByTheMacDeletesTheKeys() {
    setUp(.quiet)
    world.mac.revokePhone()
    world.relay.drain()
    guard case .unpaired(notice: .some) = model.phase else { return XCTFail("still \(model.phase)") }
    XCTAssertNil(store.state)
  }

  func testARelayRefusalAloneDoesntUnpair() {
    setUp(.quiet)
    world.relay.reachable = false
    model.disconnect()
    model.connect()
    world.relay.drain()
    XCTAssertEqual(model.phase, .paired)
    XCTAssertFalse(model.connected)
    XCTAssertNotNil(store.state)
  }

  // MARK: J8

  func testTheStoreIsPickedOnTheCardAndSigned() async throws {
    setUp(.admin)
    let store = try XCTUnwrap(card("3B77"))
    XCTAssertEqual(store.card.choices?.count, 4)
    XCTAssertEqual(store.card.tone, .neutral)
    XCTAssertEqual(model.approveBlocker(store.id, readTicked: false, typedCode: nil, choice: nil), .needsChoice)
    try await model.approve(store.id, choice: "2050")
    world.relay.drain()
    XCTAssertEqual(world.mac.events.last, .approved(requestId: store.id, deviceId: keys.publicKeys.deviceId, choice: "2050"))
  }

  func testRemoteToolCardUsesTheMacsNames() throws {
    setUp(.admin)
    let tool = try XCTUnwrap(card("9D02"))
    XCTAssertEqual(tool.card.title, "Turn on \u{201C}Search symbols\u{201D} for Claude app")
    XCTAssertEqual(tool.card.tone, .caution)
  }

  func testAsksTheMacToBuildACard() {
    setUp(.quiet)
    model.ask(PhoneAsk(action: "tool.remote-enable", adapterId: "yahoo-finance", tool: "search_symbols"))
    world.relay.drain()
    XCTAssertEqual(world.mac.events.last, .ask(PhoneAsk(action: "tool.remote-enable", adapterId: "yahoo-finance", tool: "search_symbols")))
  }

  func testLoginCodeForAHandoff() {
    setUp(.quiet)
    world.mac.handoff()
    world.relay.drain()
    XCTAssertEqual(model.handoffs.count, 1)
    XCTAssertTrue(model.sendLoginCode("handoff-woolworths-1", code: "482 913"))
    XCTAssertFalse(model.sendLoginCode("handoff-woolworths-1", code: "482913"), "one code per hand-off")
    world.relay.drain()
    XCTAssertEqual(world.mac.events.last, .loginCode(handoffId: "handoff-woolworths-1", code: "482913"))
    XCTAssertEqual(model.handoffs.first?.confirmed, true)
  }

  // MARK: The channel

  func testHoldsAGapUntilTheMissingMessageArrives() {
    setUp(.quiet)
    let last = store.state!.lastInbound
    model.receive(message: .alert(seq: last + 2, kind: .notify, title: "Second", body: "B", at: Date()))
    XCTAssertTrue(model.missingMessages)
    XCTAssertTrue(model.alerts.isEmpty, "a message after a gap waits")
    model.receive(message: .alert(seq: last + 1, kind: .notify, title: "First", body: "A", at: Date()))
    XCTAssertFalse(model.missingMessages)
    XCTAssertEqual(model.alerts.map(\.title), ["Second", "First"])
    // A replay of either does nothing.
    model.receive(message: .alert(seq: last + 1, kind: .notify, title: "First", body: "A", at: Date()))
    XCTAssertEqual(model.alerts.count, 2)
  }

  func testDropsTamperedEnvelopes() {
    setUp(.quiet)
    world.relay.tamperToPhone = { text in
      // Flip one character inside the ciphertext.
      guard text.contains("\"envelope\""), let ct = text.range(of: "\"ct\":\"") else { return text }
      var chars = Array(text)
      let i = text.distance(from: text.startIndex, to: ct.upperBound) + 5
      chars[i] = chars[i] == "A" ? "B" : "A"
      return String(chars)
    }
    let before = model.dropped
    for i in 0..<10 { world.mac.alert(kind: .notify, title: "T\(i)", body: "B") }
    world.relay.drain()
    world.relay.tamperToPhone = nil
    XCTAssertEqual(model.dropped, before + 10)
    XCTAssertTrue(model.alerts.isEmpty)
  }

  func testRefusesASecondTextForTheSameRequest() {
    setUp(.install)
    let unreadable = model.unreadable
    world.mac.ask(.install(id: "7B3Fxxxxxxxxxxxxxxxxxx", note: "A different note"))
    world.relay.drain()
    XCTAssertEqual(model.unreadable, unreadable + 1)
    XCTAssertEqual(model.cards.filter { $0.id.hasPrefix("7B3F") }.count, 1)
  }

  func testSurvivesARestart() {
    setUp(.cards)
    let ids = Set(model.cards.map(\.id))
    let keys = self.keys!
    let again = PhoneModel(transport: world.relay, store: store, clock: time.clock, keys: PhoneModel.Keys(make: { keys }, load: { _ in keys }))
    XCTAssertEqual(again.phase, .paired)
    XCTAssertEqual(Set(again.cards.map(\.id)), ids)
  }
}
