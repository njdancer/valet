import XCTest

/// The journeys (docs/ux/agent-run/journeys.md) on the simulator, against the fake Mac and relay in
/// the ValetPhoneDev build. Face ID is the fake's: it succeeds unless `-valet-faceid-fails`.
///
/// The tests are split into a class per journey, so a run can pick or skip whole classes (CI skips
/// ScreensForReviewTests outside the nightly run). This base class holds the helpers and no tests,
/// since a subclass would run any test it inherited.
class JourneyTestCase: XCTestCase {
  var app: XCUIApplication!

  /// Taps a text field until it has keyboard focus. A field near the bottom of
  /// the screen can sit under the tab bar, where a single tap doesn't focus it.
  func focus(_ field: XCUIElement) {
    for _ in 0..<3 {
      if !field.isHittable { app.swipeUp() }
      field.tap()
      let focused = NSPredicate(format: "hasKeyboardFocus == true")
      let wait = XCTNSPredicateExpectation(predicate: focused, object: field)
      if XCTWaiter().wait(for: [wait], timeout: 3) == .completed { return }
    }
  }

  /// Types `text` into `field` until `button` is enabled. A busy CI simulator's keyboard can drop
  /// a keystroke, leaving a code the card rightly refuses, so it clears the field and types again,
  /// up to three times.
  func type(_ text: String, into field: XCUIElement, until button: XCUIElement, then after: () -> Void = {}) {
    let enabled = NSPredicate(format: "isEnabled == true")
    for attempt in 0..<3 {
      if attempt > 0, let typed = field.value as? String, !typed.isEmpty {
        focus(field)
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: typed.count + 2))
      }
      focus(field)
      field.typeText(text)
      after()
      let wait = XCTNSPredicateExpectation(predicate: enabled, object: button)
      if XCTWaiter().wait(for: [wait], timeout: 3) == .completed { return }
    }
  }

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

  /// Taps `id` and waits for `shown`. A tap that lands while the screen is still settling (after a
  /// scroll or a launch) can be dropped on a busy CI simulator, which failed runs with "never
  /// appeared", so it taps again, up to three times, before failing.
  @discardableResult
  func tap(_ id: String, until shown: String) -> XCUIElement {
    let target = element(shown)
    for _ in 0..<3 {
      waitFor(id).tap()
      if target.waitForExistence(timeout: 10) { break }
    }
    return waitFor(shown)
  }

  func openCard(_ ref: String) {
    // Cards further down the list may not exist until scrolled to.
    // The list keeps its scroll position between cards, so look further down first, then back up.
    var tries = 0
    let row = element("card.\(ref)")
    while !(row.waitForExistence(timeout: 2) && row.isHittable) && tries < 10 {
      if tries < 4 { app.swipeUp() } else { app.swipeDown() }
      tries += 1
    }
    tap("card.\(ref)", until: "card.title")
    // Valet won't take an approval in the first second after a card changes (the settle time).
    Thread.sleep(forTimeInterval: 1.2)
  }

}

final class PairingJourneyTests: JourneyTestCase {
  // MARK: J1

  func testJ1PairsWhenTheCodesMatch() {
    launch("pair")
    let code = tap("pair.fake", until: "pair.code")
    XCTAssertEqual(code.label.replacingOccurrences(of: " ", with: "").count, 6)
    waitFor("fake.mac.confirm").tap()
    XCTAssertTrue(app.tabBars.buttons["Needs you"].waitForExistence(timeout: 10))
    XCTAssertTrue(element("needs.empty").exists)
  }

  func testJ1NothingPairsWhenTheMacSaysNoneMatch() {
    launch("pair")
    tap("pair.fake", until: "pair.code")
    waitFor("fake.mac.reject").tap()
    XCTAssertTrue(waitFor("pair.failed").label.contains("Nothing was paired"))
  }

}

final class InstallJourneyTests: JourneyTestCase {
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

}

final class ConnectJourneyTests: JourneyTestCase {
  func testJ4ConnectNeedsTheCodeTheAgentShows() {
    launch("cards")
    openCard("4C55")
    let approve = waitFor("card.approve")
    XCTAssertFalse(approve.isEnabled, "Approve before a code is typed")
    let field = waitFor("card.code")
    type("kqxm rpdt", into: field, until: approve) {
      let tick = self.element("card.readTick").switches.firstMatch
      if tick.exists, (tick.value as? String) != "1" { tick.tap() }
    }
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

}

final class RawConfirmJourneyTests: JourneyTestCase {
  /// The raw confirmation: a raw adapter's irreversible tool. The card shows its input and every
  /// server and credential the run can reach, says Valet can't see what it sends, and is confirmed
  /// with the read tick and Face ID.
  func testConfirmsARawAdaptersCallAfterSeeingWhatItReaches() {
    launch("raw")
    openCard("8F21")
    XCTAssertTrue(element("card.title").label.hasSuffix("Confirm: delete_folder (nas-files)"), element("card.title").label)
    XCTAssertTrue(waitFor("card.risk").label.contains("Valet can't see what this adapter sends"), element("card.risk").label)
    let reach = waitFor("card.row.Can reach")
    XCTAssertTrue(reach.label.contains("nas.example.com:443"), reach.label)
    XCTAssertTrue(reach.label.contains("192.168.1.20:5001"), reach.label)
    XCTAssertTrue(element("card.row.May get").label.contains("nas_token"))
    XCTAssertTrue(element("card.row.Input").exists)
    XCTAssertFalse(element("card.macOnly").exists)
    let approve = waitFor("card.approve")
    XCTAssertFalse(approve.isEnabled, "a strong card waits for the read tick")
    waitFor("card.readTick").switches.firstMatch.tap()
    XCTAssertTrue(approve.isEnabled)
    approve.tap()
    if element("card.problem").waitForExistence(timeout: 2) {
      XCTFail("confirm refused: \(element("card.problem").label)")
    }
    XCTAssertTrue(waitFor("card.state").label.contains("Approved"), element("card.state").label)
  }

  /// When the phone can't show the input whole, only the Mac may confirm it: no Approve, but Decline.
  func testARawCallThePhoneCantShowWholeIsMacOnly() {
    launch("raw")
    openCard("8F22")
    XCTAssertTrue(waitFor("card.macOnly").label.contains("Only your Mac can show this input whole"))
    XCTAssertFalse(element("card.approve").exists)
    XCTAssertTrue(element("card.row.Not shown").exists)
    waitFor("card.decline").tap()
    waitFor("decline.confirm").tap()
    XCTAssertTrue(waitFor("card.state").label.contains("Declined"))
  }
}

final class SafetyJourneyTests: JourneyTestCase {
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

}

final class AccessibilityTests: JourneyTestCase {
  // MARK: Every screen, for accessibility

  func testAccessibilityAuditOnEveryTab() throws {
    launch("cards")
    // The newest card is at the top; the rest may be below the fold.
    _ = waitFor("card.1D99")
    var issues: [String] = []
    // Bands at the top and bottom of a screen where the system's own glass and scroll-edge effects
    // lie over the content (iOS 26). Text there is drawn in the label colours; the audit reads the
    // overlay, not the text, and flips between runs.
    var overlayBands: (top: CGFloat, bottom: CGFloat)?
    func underOverlay(_ element: XCUIElement?) -> Bool {
      guard let bands = overlayBands, let frame = element?.frame else { return false }
      return frame.minY < bands.top || frame.maxY > bands.bottom
    }
    func audit(_ screen: String) throws {
      try app.performAccessibilityAudit(for: [.dynamicType, .contrast, .elementDetection, .hitRegion, .sufficientElementDescription]) { issue in
        let line = "\(screen): \(issue.auditType) \(issue.compactDescription) on \(issue.element?.debugDescription.prefix(160) ?? "?")"
        // Two kinds are noted but don't fail the test (docs/ios-app.md, accessibility audit):
        // "nearly passed" contrast is the system's own secondary label colours, and "partially
        // unsupported" Dynamic Type is the deliberate cap on the action bar and the system's toolbar.
        // A contrast issue with no element is the system's own scroll-edge fade under the tab bar.
        if issue.compactDescription.contains("nearly passed") || issue.compactDescription.contains("partially unsupported")
          || (issue.auditType == .contrast && (issue.element == nil || underOverlay(issue.element))) {
          print("audit note: " + line)
        } else {
          issues.append(line)
        }
        return true
      }
    }
    // On the tabs, the tab bar's glass and the scroll-edge fade above it lie over the last rows.
    let tabBand = { (top: CGFloat(0), bottom: self.app.tabBars.firstMatch.frame.minY - 24) }
    overlayBands = tabBand()
    try audit("Needs you")
    overlayBands = nil
    openCard("1D99")
    // The action bar starts at its first control: the Mac-only reason, the code field, or Decline.
    let barTop = ["card.macOnly", "card.code", "card.readTick", "card.state", "card.decline"]
      .map { element($0) }.filter { $0.exists }.map { $0.frame.minY }.min() ?? app.frame.maxY
    overlayBands = (element("card.close").frame.maxY + 48, barTop - 24)
    try audit("Card")
    overlayBands = nil
    waitFor("card.close").tap()
    for tab in ["Activity", "Sites", "Agents", "Valet"] {
      app.tabBars.buttons[tab].tap()
      overlayBands = tabBand()
      try audit(tab)
    }
    overlayBands = nil
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

}

/// Screenshots only, no assertions beyond the journeys'. CI takes them in the nightly full run and on
/// a pull request labelled ios-screens (.github/workflows/ios-screens.yml), not on every push.
final class ScreensForReviewTests: JourneyTestCase {
  // MARK: Screens for review (persona QA reads these from the CI artifact)

  func shot(_ name: String) {
    let shot = XCTAttachment(screenshot: app.screenshot())
    shot.name = name
    shot.lifetime = .keepAlways
    add(shot)
  }

  func testScreensForReview() {
    launch("raw")
    for (ref, name) in [("8F21", "11 raw confirm"), ("8F22", "12 raw confirm, Mac only")] {
      openCard(ref)
      shot(name)
      app.swipeUp()
      shot(name + " lower")
      waitFor("card.close").tap()
    }
    launch("pair")
    shot("01 pair start")
    tap("pair.fake", until: "pair.code")
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
      app.swipeUp()
      shot("10 \(tab.lowercased()) lower")
    }
  }
}
