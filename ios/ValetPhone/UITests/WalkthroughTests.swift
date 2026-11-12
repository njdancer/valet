import XCTest

/// The pairing walkthrough (docs/phone-channel.md#the-walkthrough): the ValetPhoneDev build against
/// the real Mac app and the real relay in a local Workers runtime, not the fakes. Skipped unless
/// the walkthrough's driver runs it, which passes VALET_WALKTHROUGH_CUES (TEST_RUNNER_ prefixed):
/// the address of the driver's small cue server, which this test and the Mac side use to take
/// turns, and which matches Face ID in the simulator when asked.
final class WalkthroughTests: XCTestCase {
  var app: XCUIApplication!
  var cues: URL!

  override func setUpWithError() throws {
    continueAfterFailure = false
    guard let value = ProcessInfo.processInfo.environment["VALET_WALKTHROUGH_CUES"], let url = URL(string: value) else {
      throw XCTSkip("run by the walkthrough driver only")
    }
    cues = url
  }

  func element(_ id: String) -> XCUIElement { app.descendants(matching: .any)[id].firstMatch }

  func waitFor(_ id: String, timeout: TimeInterval = 30) -> XCUIElement {
    let e = element(id)
    XCTAssertTrue(e.waitForExistence(timeout: timeout), "\(id) never appeared")
    return e
  }

  /// Tells the driver something happened, with an optional value.
  func mark(_ name: String, _ value: String = "") {
    var components = URLComponents(url: cues.appendingPathComponent("mark/\(name)"), resolvingAgainstBaseURL: false)!
    components.queryItems = [URLQueryItem(name: "v", value: value)]
    request(components.url!, method: "POST")
  }

  /// Waits until the driver says `name` happened on the Mac side.
  func cue(_ name: String, timeout: TimeInterval = 180) {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      if request(cues.appendingPathComponent("cue/\(name)"), method: "GET") == 200 { return }
      Thread.sleep(forTimeInterval: 0.5)
    }
    XCTFail("cue \(name) never came")
  }

  @discardableResult
  func request(_ url: URL, method: String) -> Int {
    var req = URLRequest(url: url)
    req.httpMethod = method
    req.timeoutInterval = 10
    let done = expectation(description: url.path)
    var status = 0
    URLSession.shared.dataTask(with: req) { _, response, _ in
      status = (response as? HTTPURLResponse)?.statusCode ?? 0
      done.fulfill()
    }.resume()
    wait(for: [done], timeout: 15)
    return status
  }

  /// The first waiting card in Needs you, opened.
  func openFirstCard() {
    let rows = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'card.'"))
    let row = rows.firstMatch
    XCTAssertTrue(row.waitForExistence(timeout: 120), "no card arrived")
    Thread.sleep(forTimeInterval: 1.5)
    row.tap()
    _ = waitFor("card.title")
    // Valet won't take an approval in the first second after a card changes (the settle time).
    Thread.sleep(forTimeInterval: 2.5)
  }

  /// Approve, then Face ID: the driver matches the simulator's face once the prompt is up.
  func approveWithFaceID() {
    waitFor("card.approve").tap()
    Thread.sleep(forTimeInterval: 1.5)
    mark("faceid")
    // The state line exists from the tap ("Waiting for Face ID…"), so wait for its words to change.
    let approved = expectation(for: NSPredicate(format: "label CONTAINS 'Approved'"), evaluatedWith: waitFor("card.state"))
    XCTAssertEqual(XCTWaiter.wait(for: [approved], timeout: 60), .completed, element("card.state").label)
    Thread.sleep(forTimeInterval: 2.5)
    if element("card.close").exists { element("card.close").tap() }
  }

  func testWalkthrough() {
    app = XCUIApplication()
    app.launchArguments = [
      "-valet-relay-connect", ProcessInfo.processInfo.environment["VALET_WALKTHROUGH_RELAY"] ?? "http://127.0.0.1:8787",
      "-valet-pair-from", cues.appendingPathComponent("qr").absoluteString,
    ]
    app.launch()
    mark("launched")

    // J1: the Mac shows its QR code; the phone takes it, and both show the codes.
    let name = waitFor("pair.name")
    cue("qr")
    name.tap()
    if let current = name.value as? String, !current.isEmpty {
      name.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count))
    }
    name.typeText("Nick\u{2019}s iPhone\n")
    Thread.sleep(forTimeInterval: 1)
    waitFor("pair.fromMac").tap()
    let code = waitFor("pair.code")
    mark("code", code.label.replacingOccurrences(of: " ", with: ""))
    XCTAssertTrue(app.tabBars.buttons["Needs you"].waitForExistence(timeout: 120), "never paired")
    mark("paired")
    Thread.sleep(forTimeInterval: 3)

    // J4: the agent's install request arrives; approved with Face ID.
    cue("install-asked")
    openFirstCard()
    mark("card-open", element("card.title").label)
    Thread.sleep(forTimeInterval: 3)
    approveWithFaceID()
    mark("approved")

    // A request declined, with a note for the agent.
    cue("setting-asked")
    openFirstCard()
    mark("card-open", element("card.title").label)
    Thread.sleep(forTimeInterval: 3)
    waitFor("card.decline").tap()
    let note = waitFor("decline.note")
    note.tap()
    note.typeText("Not now, keep two weeks.")
    Thread.sleep(forTimeInterval: 1)
    waitFor("decline.confirm").tap()
    Thread.sleep(forTimeInterval: 2.5)
    if element("card.close").exists { element("card.close").tap() }
    mark("declined")

    // No push without Nick's paid Apple account: the phone is closed while the agent asks, and the
    // card is there when he opens Valet.
    XCUIDevice.shared.press(.home)
    mark("backgrounded")
    cue("closed-asked")
    Thread.sleep(forTimeInterval: 4)
    app.activate()
    mark("reopened")
    openFirstCard()
    mark("card-open", element("card.title").label)
    Thread.sleep(forTimeInterval: 2)
    approveWithFaceID()
    mark("approved-after-open")
    Thread.sleep(forTimeInterval: 3)
    mark("done")
  }
}
