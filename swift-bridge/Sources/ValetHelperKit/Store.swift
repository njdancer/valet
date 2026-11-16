// Where the helpers keep Valet's own secrets: the Mac's device-key blobs, the trusted-store anchor
// and Valet's copies of logins.
//
// - ProtectedStore: the data protection Keychain (the iOS-style one), in an access group that only
//   binaries signed by Valet's team with that group in their provisioning profile can open. Nothing
//   else can read the items, and Valet never sees a Keychain prompt: access follows the signature,
//   not a per-item ACL that each rebuild invalidates. Items are usable after the Mac's first unlock
//   since it started, so they work while the screen is locked.
// - KeychainStore (Keychain.swift): the classic file Keychain. Kept for helpers that carry no access
//   group (an unsigned development build, the contract suites' throwaway keychain) and as the
//   place older items are moved out of.
// - MigratingStore: the protected store first; an item found only in the classic Keychain is moved
//   across on first read and the old copy removed, so each item asks (at most) once, ever.

import Foundation
import Security

/// What a helper needs from a store of generic-password items.
public protocol SecretStore: AnyObject {
  func read(_ item: KeychainItem) throws -> [UInt8]
  /// The item's comment, without reading its secret.
  func comment(_ item: KeychainItem) throws -> String
  /// Replaces the item's secret and comment, adding the item if it isn't there.
  func write(_ item: KeychainItem, secret: [UInt8], comment: String) throws
  func delete(_ item: KeychainItem) throws
  /// Removes every item of one service. Returns how many passes removed something.
  @discardableResult func purge(service: String) throws -> Int
}

extension KeychainStore: SecretStore {}

/// The access group from this binary's `keychain-access-groups` entitlement, or nil without one.
public func ownAccessGroup() -> String? {
  guard let task = SecTaskCreateFromSelf(nil) else { return nil }
  let value = SecTaskCopyValueForEntitlement(task, "keychain-access-groups" as CFString, nil)
  guard let groups = value as? [String], let first = groups.first, isAccessGroup(first) else { return nil }
  return first
}

/// A team-prefixed group: `<10-character Team ID>.<reverse-DNS name>`.
public func isAccessGroup(_ group: String) -> Bool {
  let parts = group.split(separator: ".", maxSplits: 1, omittingEmptySubsequences: false)
  guard parts.count == 2, Caller.isTeamID(String(parts[0])) else { return false }
  let name = parts[1]
  return (1...200).contains(name.utf8.count)
    && name.utf8.allSatisfy {
      ($0 >= 0x61 && $0 <= 0x7A) || ($0 >= 0x41 && $0 <= 0x5A) || ($0 >= 0x30 && $0 <= 0x39) || $0 == 0x2E
        || $0 == 0x2D
    }
}

public final class ProtectedStore: SecretStore {
  public let accessGroup: String

  public init(accessGroup: String) {
    self.accessGroup = accessGroup
  }

  private func baseQuery(_ item: KeychainItem) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: item.service,
      kSecAttrAccount as String: item.account,
      kSecUseDataProtectionKeychain as String: true,
      kSecAttrAccessGroup as String: accessGroup,
    ]
  }

  public func read(_ item: KeychainItem) throws -> [UInt8] {
    var query = baseQuery(item)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    try checkStatus(SecItemCopyMatching(query as CFDictionary, &result))
    guard let data = result as? Data else { throw KeychainFailure.other(errSecInternalError) }
    return [UInt8](data)
  }

  public func comment(_ item: KeychainItem) throws -> String {
    var query = baseQuery(item)
    query[kSecReturnAttributes as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    try checkStatus(SecItemCopyMatching(query as CFDictionary, &result))
    guard let attributes = result as? [String: Any] else { throw KeychainFailure.other(errSecInternalError) }
    return attributes[kSecAttrComment as String] as? String ?? ""
  }

  public func write(_ item: KeychainItem, secret: [UInt8], comment: String) throws {
    let data = Data(secret)
    let changes: [String: Any] = [
      kSecValueData as String: data,
      kSecAttrComment as String: comment,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    ]
    var status = SecItemUpdate(baseQuery(item) as CFDictionary, changes as CFDictionary)
    if status == errSecItemNotFound {
      var add = baseQuery(item)
      add[kSecAttrLabel as String] = item.service
      for (key, value) in changes { add[key] = value }
      status = SecItemAdd(add as CFDictionary, nil)
    }
    try checkStatus(status)
  }

  public func delete(_ item: KeychainItem) throws {
    try checkStatus(SecItemDelete(baseQuery(item) as CFDictionary))
  }

  @discardableResult
  public func purge(service: String) throws -> Int {
    guard isAllowedService(service) else { throw KeychainFailure.invalid }
    // The data protection Keychain deletes every match at once.
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecUseDataProtectionKeychain as String: true,
      kSecAttrAccessGroup as String: accessGroup,
    ]
    let status = SecItemDelete(query as CFDictionary)
    if status == errSecItemNotFound { return 0 }
    try checkStatus(status)
    return 1
  }
}

/// The protected store, moving each item out of the classic Keychain the first time it's read.
public final class MigratingStore: SecretStore {
  public let primary: SecretStore
  public let legacy: SecretStore

  public init(primary: SecretStore, legacy: SecretStore) {
    self.primary = primary
    self.legacy = legacy
  }

  public func read(_ item: KeychainItem) throws -> [UInt8] {
    do {
      return try primary.read(item)
    } catch KeychainFailure.notFound {
      return try migrate(item)
    }
  }

  public func comment(_ item: KeychainItem) throws -> String {
    do {
      return try primary.comment(item)
    } catch KeychainFailure.notFound {
      // Moving it reads the secret, which an old item may need the person for: only the comment
      // was asked for, so answer from where it is.
      return try legacy.comment(item)
    }
  }

  public func write(_ item: KeychainItem, secret: [UInt8], comment: String) throws {
    try primary.write(item, secret: secret, comment: comment)
    // An old copy left behind would come back if the new one were ever deleted.
    try? legacy.delete(item)
  }

  public func delete(_ item: KeychainItem) throws {
    var found = false
    for store in [primary, legacy] {
      do {
        try store.delete(item)
        found = true
      } catch KeychainFailure.notFound {
        continue
      }
    }
    if !found { throw KeychainFailure.notFound }
  }

  @discardableResult
  public func purge(service: String) throws -> Int {
    try primary.purge(service: service) + legacy.purge(service: service)
  }

  /// Copies an old item into the protected store, then removes the old one. The copy is kept if
  /// the old one can't be removed: the protected store is read first, so it wins either way.
  private func migrate(_ item: KeychainItem) throws -> [UInt8] {
    let secret = try legacy.read(item)
    let note = (try? legacy.comment(item)) ?? ""
    try primary.write(item, secret: secret, comment: note)
    try? legacy.delete(item)
    return secret
  }
}

/// The store a helper uses: the throwaway keychain the contract suites name; otherwise the
/// protected store when this binary has an access group, moving old items across; otherwise the
/// classic Keychain.
public func makeSecretStore(keychainPath: String?, accessGroup: String? = ownAccessGroup()) throws -> SecretStore {
  if let keychainPath { return try KeychainStore(keychainPath: keychainPath) }
  let legacy = try KeychainStore()
  guard let accessGroup else { return legacy }
  return MigratingStore(primary: ProtectedStore(accessGroup: accessGroup), legacy: legacy)
}

func checkStatus(_ status: OSStatus) throws {
  switch status {
  case errSecSuccess: return
  case errSecItemNotFound: throw KeychainFailure.notFound
  case errSecInteractionNotAllowed, errSecInteractionRequired, errSecUserCanceled, errSecAuthFailed:
    throw KeychainFailure.interaction
  default: throw KeychainFailure.other(status)
  }
}
