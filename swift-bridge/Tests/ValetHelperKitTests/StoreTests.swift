// The store logic with in-memory stores: which store answers, how an old item moves across, and
// that nothing is lost or resurrected on the way. The real data protection Keychain needs a
// provisioning profile, so it runs in the live check on a provisioned Mac (pnpm test:keystore-live).

import Foundation
import XCTest

@testable import ValetHelperKit

/// An in-memory store that records what was asked of it, and can be made to fail.
final class MemoryStore: SecretStore {
  var items: [String: (secret: [UInt8], comment: String)] = [:]
  var calls: [String] = []
  var failReads: KeychainFailure?
  var failDeletes: KeychainFailure?
  var failWrites: KeychainFailure?
  /// Deleting from this store also deletes from that one: the bug where a classic query reached
  /// the protected Keychain.
  weak var deletesAlsoIn: MemoryStore?

  private func key(_ item: KeychainItem) -> String { "\(item.service)/\(item.account)" }

  func read(_ item: KeychainItem) throws -> [UInt8] {
    calls.append("read \(key(item))")
    if let failReads { throw failReads }
    guard let found = items[key(item)] else { throw KeychainFailure.notFound }
    return found.secret
  }

  func comment(_ item: KeychainItem) throws -> String {
    calls.append("comment \(key(item))")
    guard let found = items[key(item)] else { throw KeychainFailure.notFound }
    return found.comment
  }

  func write(_ item: KeychainItem, secret: [UInt8], comment: String) throws {
    calls.append("write \(key(item))")
    if let failWrites { throw failWrites }
    items[key(item)] = (secret, comment)
  }

  func delete(_ item: KeychainItem) throws {
    calls.append("delete \(key(item))")
    if let failDeletes { throw failDeletes }
    deletesAlsoIn?.items.removeValue(forKey: key(item))
    guard items.removeValue(forKey: key(item)) != nil else { throw KeychainFailure.notFound }
  }

  func purge(service: String) throws -> Int {
    calls.append("purge \(service)")
    let before = items.count
    items = items.filter { !$0.key.hasPrefix("\(service)/") }
    return before == items.count ? 0 : 1
  }
}

final class MigratingStoreTests: XCTestCase {
  let item = KeychainItem(service: "valet.device", account: "transport")!
  var primary = MemoryStore()
  var legacy = MemoryStore()
  lazy var store = MigratingStore(primary: primary, legacy: legacy)

  override func setUp() {
    primary = MemoryStore()
    legacy = MemoryStore()
    store = MigratingStore(primary: primary, legacy: legacy)
  }

  func testReadsTheProtectedStoreWithoutTouchingTheOldOne() throws {
    try primary.write(item, secret: [1, 2], comment: "new")
    primary.calls = []
    XCTAssertEqual(try store.read(item), [1, 2])
    XCTAssertEqual(legacy.calls, [])
  }

  func testMovesAnOldItemAcrossOnFirstReadKeepingItsComment() throws {
    legacy.items["valet.device/transport"] = ([7, 8], "Valet device key, works while locked")
    XCTAssertEqual(try store.read(item), [7, 8])
    XCTAssertEqual(primary.items["valet.device/transport"]?.secret, [7, 8])
    XCTAssertEqual(primary.items["valet.device/transport"]?.comment, "Valet device key, works while locked")
    XCTAssertNil(legacy.items["valet.device/transport"])
    // Second read: the protected store only.
    legacy.calls = []
    XCTAssertEqual(try store.read(item), [7, 8])
    XCTAssertEqual(legacy.calls, [])
  }

  func testKeepsTheCopyWhenTheOldItemCantBeRemoved() throws {
    legacy.items["valet.device/transport"] = ([7], "c")
    legacy.failDeletes = .interaction
    XCTAssertEqual(try store.read(item), [7])
    XCTAssertEqual(primary.items["valet.device/transport"]?.secret, [7])
    // The protected copy answers from now on, whatever the old one does.
    legacy.failReads = .interaction
    XCTAssertEqual(try store.read(item), [7])
  }

  func testLeavesTheOldItemWhenTheCopyFails() {
    legacy.items["valet.device/transport"] = ([7], "c")
    primary.failWrites = .other(-34018)
    XCTAssertThrowsError(try store.read(item)) { XCTAssertEqual($0 as? KeychainFailure, .other(-34018)) }
    XCTAssertNotNil(legacy.items["valet.device/transport"], "never delete the only copy")
  }

  func testNeverLosesAKeyWhenRemovingTheOldCopyTakesTheNewOneToo() {
    legacy.items["valet.device/approval"] = ([5, 5], "Valet device key")
    legacy.deletesAlsoIn = primary
    let approval = KeychainItem(service: "valet.device", account: "approval")!
    XCTAssertThrowsError(try store.read(approval))
    XCTAssertEqual(primary.items["valet.device/approval"]?.secret, [5, 5], "the key was put back")
    // And a later read finds it.
    legacy.deletesAlsoIn = nil
    XCTAssertEqual(try store.read(approval), [5, 5])
  }

  func testAWriteThatLosesItsCopyIsRestoredAndReported() {
    legacy.items["valet.device/transport"] = ([1], "old")
    legacy.deletesAlsoIn = primary
    XCTAssertThrowsError(try store.write(item, secret: [9], comment: "new"))
    XCTAssertEqual(primary.items["valet.device/transport"]?.secret, [9])
  }

  func testNeverRemovesTheOldCopyUnlessTheNewOneReadsBackTheSame() {
    final class Forgetful: SecretStore {
      func read(_ item: KeychainItem) throws -> [UInt8] { throw KeychainFailure.notFound }
      func comment(_ item: KeychainItem) throws -> String { throw KeychainFailure.notFound }
      func write(_ item: KeychainItem, secret: [UInt8], comment: String) throws {}
      func delete(_ item: KeychainItem) throws { throw KeychainFailure.notFound }
      func purge(service: String) throws -> Int { 0 }
    }
    legacy.items["valet.device/transport"] = ([7], "c")
    let store = MigratingStore(primary: Forgetful(), legacy: legacy)
    XCTAssertThrowsError(try store.read(item))
    XCTAssertEqual(legacy.items["valet.device/transport"]?.secret, [7], "the only copy stays")
  }

  func testMissingEverywhereIsNotFound() {
    XCTAssertThrowsError(try store.read(item)) { XCTAssertEqual($0 as? KeychainFailure, .notFound) }
  }

  func testAnOldItemTheKeychainWontGiveUpSaysSo() {
    legacy.items["valet.device/transport"] = ([7], "c")
    legacy.failReads = .interaction
    XCTAssertThrowsError(try store.read(item)) { XCTAssertEqual($0 as? KeychainFailure, .interaction) }
  }

  func testCommentsComeFromWhereTheItemIsWithoutMovingIt() throws {
    legacy.items["valet.device/transport"] = ([7], "old")
    XCTAssertEqual(try store.comment(item), "old")
    XCTAssertFalse(legacy.calls.contains { $0.hasPrefix("read") }, "a comment never reads a secret")
    XCTAssertTrue(primary.items.isEmpty)
    try primary.write(item, secret: [1], comment: "new")
    XCTAssertEqual(try store.comment(item), "new")
  }

  func testWritesGoToTheProtectedStoreAndRetireTheOldCopy() throws {
    legacy.items["valet.device/transport"] = ([7], "old")
    try store.write(item, secret: [9], comment: "new")
    XCTAssertEqual(primary.items["valet.device/transport"]?.secret, [9])
    XCTAssertNil(legacy.items["valet.device/transport"], "an old copy would come back after a delete")
  }

  func testAWriteSucceedsEvenWhenThereIsNoOldCopy() throws {
    try store.write(item, secret: [9], comment: "new")
    XCTAssertEqual(primary.items["valet.device/transport"]?.secret, [9])
  }

  func testDeletesFromBothAndNotFoundOnlyWhenInNeither() throws {
    primary.items["valet.device/transport"] = ([1], "")
    legacy.items["valet.device/transport"] = ([2], "")
    try store.delete(item)
    XCTAssertTrue(primary.items.isEmpty)
    XCTAssertTrue(legacy.items.isEmpty)
    XCTAssertThrowsError(try store.delete(item)) { XCTAssertEqual($0 as? KeychainFailure, .notFound) }
    legacy.items["valet.device/transport"] = ([2], "")
    try store.delete(item)
    XCTAssertTrue(legacy.items.isEmpty)
  }

  func testADeleteThatFailsIsAnError() {
    primary.items["valet.device/transport"] = ([1], "")
    primary.failDeletes = .other(-1)
    XCTAssertThrowsError(try store.delete(item))
  }

  func testPurgesBoth() throws {
    primary.items["valet.copy/a"] = ([1], "")
    legacy.items["valet.copy/b"] = ([2], "")
    legacy.items["valet.device/transport"] = ([3], "")
    XCTAssertEqual(try store.purge(service: "valet.copy"), 2)
    XCTAssertTrue(primary.items.isEmpty)
    XCTAssertEqual(Array(legacy.items.keys), ["valet.device/transport"])
  }
}

final class AccessGroupTests: XCTestCase {
  func testGroupsAreTeamPrefixed() {
    XCTAssertTrue(isAccessGroup("ABCDE12345.me.example.valet.keys"))
    XCTAssertFalse(isAccessGroup("me.example.valet.keys"))
    XCTAssertFalse(isAccessGroup("abcde12345.me.example"))
    XCTAssertFalse(isAccessGroup("ABCDE12345."))
    XCTAssertFalse(isAccessGroup("ABCDE12345.a/b"))
    XCTAssertFalse(isAccessGroup("ABCDE12345." + String(repeating: "a", count: 201)))
  }

  func testAThrowawayKeychainAlwaysWins() throws {
    let path = NSTemporaryDirectory() + "store-tests-\(UUID().uuidString).keychain-db"
    let made = Process()
    made.executableURL = URL(fileURLWithPath: "/usr/bin/security")
    made.arguments = ["create-keychain", "-p", "t", path]
    try made.run()
    made.waitUntilExit()
    defer { try? FileManager.default.removeItem(atPath: path) }
    XCTAssertTrue(try makeSecretStore(keychainPath: path, accessGroup: "ABCDE12345.me.example") is KeychainStore)
  }

  func testAnAccessGroupMeansTheProtectedStoreFirst() throws {
    let store = try makeSecretStore(keychainPath: nil, accessGroup: "ABCDE12345.me.example")
    let migrating = try XCTUnwrap(store as? MigratingStore)
    XCTAssertEqual((migrating.primary as? ProtectedStore)?.accessGroup, "ABCDE12345.me.example")
    XCTAssertTrue(migrating.legacy is KeychainStore)
    XCTAssertTrue(try makeSecretStore(keychainPath: nil, accessGroup: nil) is KeychainStore)
  }

  func testAnUnprovisionedTestBinaryHasNoGroup() {
    XCTAssertNil(ownAccessGroup())
  }
}
