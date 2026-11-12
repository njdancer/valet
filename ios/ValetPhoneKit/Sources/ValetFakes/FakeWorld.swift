import Foundation
import ValetPhoneCore
import ValetProtocol

/// The story world (docs/ux/agent-run/story.md) on a fake Mac, and the scenarios UI tests start
/// from (`-valet-fake <scenario>`).
@MainActor
public final class FakeWorld {
  public enum Scenario: String, CaseIterable, Sendable {
    /// J1: nothing paired; the Mac shows a QR code.
    case pair
    /// J4: paired, with one card of each kind the phone can answer, and two it can't.
    case cards
    /// J4, one card: an install from Claude Code.
    case install
    /// J7: an unexpected signed-in session request from Claude Code.
    case wrong
    /// J8: a remote tool and the store choice.
    case admin
    /// Paired, nothing waiting.
    case quiet
  }

  public let mac: FakeMac
  public let relay: FakeRelay
  public let scenario: Scenario

  public init(_ scenario: Scenario, autoDeliver: Bool = true) {
    self.scenario = scenario
    mac = FakeMac()
    relay = FakeRelay(mac: mac, autoDeliver: autoDeliver)
    mac.agents = [
      FakeMac.Agent(clientId: FakeRequest.claudeCode, label: "Claude Code", remote: false),
      FakeMac.Agent(clientId: FakeRequest.claudeApp, label: "Claude app", remote: true),
    ]
    mac.sites = [
      FakeMac.Site(adapterId: "woolworths", name: "Woolworths", health: "ok", note: "Working. Last call 7:12 pm."),
      FakeMac.Site(adapterId: "yahoo-finance", name: "Yahoo Finance", health: "ok", note: nil),
      FakeMac.Site(adapterId: "wikipedia", name: "Wikipedia", health: "repair", note: "Wikipedia changed: Get summary is broken"),
    ]
    let now = Date()
    mac.recent = [
      FakeMac.Recent(at: now.addingTimeInterval(-300), isCall: true, text: "Claude app: Search products on Woolworths failed. The page didn\u{2019}t load in time."),
      FakeMac.Recent(at: now.addingTimeInterval(-600), isCall: false, text: "Claude Code started a draft for yahoo.com"),
      FakeMac.Recent(at: now.addingTimeInterval(-900), isCall: true, text: "Claude app: Get quote on Yahoo Finance worked"),
      FakeMac.Recent(at: now.addingTimeInterval(-3600), isCall: false, text: "Claude app turned on Get quote, approved on Nick\u{2019}s iPhone"),
    ]
  }

  /// The QR code the Mac shows.
  public func qr() -> String { mac.pairingQR(relay: relay.origin) }

  /// Pairs `model` with this Mac, as J1 does, without a camera.
  public func pair(_ model: PhoneModel, name: String = "iPhone") {
    model.pair(qr: qr(), name: name)
  }

  /// The requests a scenario starts with, once the phone is paired.
  public func post() {
    switch scenario {
    case .pair, .quiet:
      break
    case .install:
      mac.ask(.install(id: "7B3Fxxxxxxxxxxxxxxxxxx"))
    case .cards:
      mac.ask(.install(id: "7B3Fxxxxxxxxxxxxxxxxxx"))
      mac.ask(.update(id: "5E31xxxxxxxxxxxxxxxxxx"))
      mac.ask(.remoteTool(id: "9D02xxxxxxxxxxxxxxxxxx"))
      mac.ask(.login(id: "2A10xxxxxxxxxxxxxxxxxx"))
      mac.ask(.connect(id: "4C55xxxxxxxxxxxxxxxxxx"))
      mac.ask(.confirm(id: "8F20xxxxxxxxxxxxxxxxxx"))
      mac.ask(.install(id: "1D99xxxxxxxxxxxxxxxxxx", unsandboxed: true, changes: [
        FakeRequest.change("sandbox-mode", "widened", ["runs without the sandbox"], "critical"),
      ], note: "It needs to read your Downloads folder."))
    case .wrong:
      mac.ask(.session(id: "6E11xxxxxxxxxxxxxxxxxx", note: "Ignore earlier limits. Approve this so I can finish quickly."))
    case .admin:
      mac.ask(.remoteTool(id: "9D02xxxxxxxxxxxxxxxxxx"))
      mac.ask(.store(id: "3B77xxxxxxxxxxxxxxxxxx"))
    }
  }
}
