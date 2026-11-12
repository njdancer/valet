import XCTest

/// The journeys (docs/ux/agent-run/journeys.md) on the simulator, against the fake Mac and relay in
/// the ValetPhoneDev build. Face ID is the fake's: it succeeds unless `-valet-faceid-fails`.
final class JourneyTests: XCTestCase {
  var app: XCUIApplication!

  override func setUp() {
    continueAfterFailure = false
  }

  func launch(_ scenario: String, _ extra: [String] = []) {
    app = XCUIApplication()
    app.launchArguments = ["-valet-fake", scenario] + extra
    app.launch()
  }

  func element(_ id: String) -> XCUIElement { app.descendants(matching: .any)[id].firstMatch }

  func waitFor(_ id: String, timeout: TimeInterval = 10) -> XCUIElement {
    let e = element(id)
    XCTAssertTrue(e.waitForExistence(timeout: timeout), "\(id) never appeared")
    return e
  }

  func openCard(_ ref: String) {
    // Cards further down the list may not exist until scrolled to.
    var tries = 0
    while !element("card.\(ref)").waitForExistence(timeout: 3) && tries < 4 {
      app.swipeUp()
      tries += 1
    }
    waitFor("card.\(ref)").tap()
    _ = waitFor("card.title")
    // Valet won't take an approval in the first second after a card changes (the settle time).
    Thread.sleep(forTimeInterval: 1.2)
  }

  // MARK: J1

  func testJ1PairsWhenTheCodesMatch() {
    launch("pair")
    waitFor("pair.fake").tap()
    let code = waitFor("pair.code")
    XCTAssertEqual(code.label.replacingOccurrences(of: " ", with: "").count, 6)
    waitFor("fake.mac.confirm").tap()
    XCTAssertTrue(app.tabBars.buttons["Needs you"].waitForExistence(timeout: 10))
    XCTAssertTrue(element("needs.empty").exists)
  }

  func testJ1NothingPairsWhenTheMacSaysNoneMatch() {
    launch("pair")
    waitFor("pair.fake").tap()
    _ = waitFor("pair.code")
    waitFor("fake.mac.reject").tap()
    XCTAssertTrue(waitFor("pair.failed").label.contains("Nothing was paired"))
  }

  // MARK: J4

  func testJ4ApprovesAnInstall() {
    launch("install")
    openCard("7B3F")
    // The tone word may come first ("Check this."); the title itself follows.
    XCTAssertTrue(element("card.title").label.hasSuffix("Install an adapter for yahoo.com"), element("card.title").label)
    waitFor("card.approve").tap()
    if element("card.problem").waitForExistence(timeout: 2) {
      XCTFail("approve refused: \(element("card.problem").label)")
    }
    XCTAssertTrue(waitFor("card.state").label.contains("Approved with Face ID"))
  }

  func testJ4FaceIDFailureApprovesNothing() {
    launch("install", ["-valet-faceid-fails"])
    openCard("7B3F")
    waitFor("card.approve").tap()
    XCTAssertTrue(waitFor("card.problem").label.contains("Nothing was approved"))
  }

  func testJ4DeclinesWithANote() {
    launch("install")
    openCard("7B3F")
    waitFor("card.decline").tap()
    let note = waitFor("decline.note")
    note.tap()
    note.typeText("Not this week")
    waitFor("decline.confirm").tap()
    XCTAssertTrue(waitFor("card.state").label.contains("Declined"))
  }

  func testJ4ConnectNeedsTheCodeTheAgentShows() {
    launch("cards")
    openCard("4C55")
    let approve = waitFor("card.approve")
    XCTAssertFalse(approve.isEnabled, "Approve before a code is typed")
    let field = waitFor("card.code")
    field.tap()
    field.typeText("kqxm rpdt")
    if element("card.readTick").exists { element("card.readTick").switches.firstMatch.tap() }
    XCTAssertTrue(approve.isEnabled)
    approve.tap()
    XCTAssertTrue(waitFor("card.state").label.contains("Approved"))
  }

  func testJ4UnsandboxedInstallIsMacOnly() {
    launch("cards")
    openCard("1D99")
    XCTAssertTrue(waitFor("card.macOnly").exists)
    XCTAssertFalse(element("card.approve").exists)
  }

  // MARK: J7

  func testJ7SeesTheAgentsWordsAsAClaimAndDeclines() {
    launch("wrong")
    openCard("6E11")
    XCTAssertTrue(waitFor("card.words").label.contains("Ignore earlier limits"))
    XCTAssertFalse(element("card.title").label.contains("Ignore"))
    waitFor("card.decline").tap()
    waitFor("decline.confirm").tap()
    XCTAssertTrue(waitFor("card.state").label.contains("Declined"))
  }

  func testJ7LocksDown() {
    launch("wrong")
    _ = waitFor("card.6E11")
    app.tabBars.buttons["Valet"].tap()
    waitFor("valet.lockdown").tap()
    app.buttons["valet.lockdown.confirm"].firstMatch.tap()
    XCTAssertTrue(waitFor("valet.safety").label.contains("locked down"))
  }

  // MARK: J8

  func testJ8PicksAStore() {
    launch("admin")
    openCard("3B77")
    let approve = waitFor("card.approve")
    XCTAssertFalse(approve.isEnabled, "Approve before a store is picked")
    waitFor("choice.2050").tap()
    XCTAssertTrue(approve.isEnabled)
    approve.tap()
    XCTAssertTrue(waitFor("card.state").label.contains("Approved"))
  }

  // MARK: Every screen, for accessibility

  func testAccessibilityAuditOnEveryTab() throws {
    launch("cards")
    // The newest card is at the top; the rest may be below the fold.
    _ = waitFor("card.1D99")
    var issues: [String] = []
    func audit(_ screen: String) throws {
      try app.performAccessibilityAudit(for: [.dynamicType, .contrast, .elementDetection, .hitRegion, .sufficientElementDescription]) { issue in
        issues.append("\(screen): \(issue.auditType) \(issue.compactDescription) on \(issue.element?.debugDescription.prefix(160) ?? "?")")
        return true
      }
    }
    try audit("Needs you")
    openCard("1D99")
    try audit("Card")
    waitFor("card.close").tap()
    for tab in ["Activity", "Sites", "Agents", "Valet"] {
      app.tabBars.buttons[tab].tap()
      try audit(tab)
    }
    XCTAssertTrue(issues.isEmpty, issues.joined(separator: "\n"))
  }

  func testCardAtTheLargestTextSizeInDarkMode() {
    XCUIDevice.shared.appearance = .dark
    defer { XCUIDevice.shared.appearance = .light }
    launch("install", ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"])
    openCard("7B3F")
    // The approve button stays reachable: the action bar is pinned.
    XCTAssertTrue(waitFor("card.approve").isHittable)
    let shot = XCTAttachment(screenshot: app.screenshot())
    shot.name = "install card, AX5, dark"
    shot.lifetime = .keepAlways
    add(shot)
  }

  // MARK: Screens for review (persona QA reads these from the CI artifact)

  func shot(_ name: String) {
    let shot = XCTAttachment(screenshot: app.screenshot())
    shot.name = name
    shot.lifetime = .keepAlways
    add(shot)
  }

  func testScreensForReview() {
    launch("pair")
    shot("01 pair start")
    waitFor("pair.fake").tap()
    _ = waitFor("pair.code")
    shot("02 pair code")
    launch("cards")
    _ = waitFor("card.1D99")
    shot("03 needs you")
    for (ref, name) in [("7B3F", "04 install"), ("1D99", "05 unsandboxed install"), ("4C55", "06 connect"), ("8F20", "07 confirm")] {
      openCard(ref)
      shot(name)
      app.swipeUp()
      shot(name + " lower")
      waitFor("card.close").tap()
    }
    launch("wrong")
    openCard("6E11")
    shot("08 signed-in session")
    launch("admin")
    openCard("3B77")
    shot("09 store choice")
    waitFor("card.close").tap()
    for tab in ["Activity", "Sites", "Agents", "Valet"] {
      app.tabBars.buttons[tab].tap()
      shot("10 \(tab.lowercased())")
    }
  }
}
