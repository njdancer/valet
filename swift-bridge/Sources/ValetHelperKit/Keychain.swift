// Valet's own generic-password items, read and written with SecItem in this process. An item this
// binary adds trusts this binary (the Keychain's default ACL for the creator), so a signed helper
// reads it without a prompt, and any prompt names the helper rather than /usr/bin/security.
//
// Only services named valet or valet.<name> are reachable, so the helper can't be pointed at the
// person's other items.

import Foundation
import Security

public enum KeychainFailure: Error, Equatable {
  case notFound
  /// The Keychain wants the person: locked, a prompt refused, or interaction not allowed.
  case interaction
  case invalid
  case other(Int32)
}

public struct KeychainItem: Equatable {
  public let service: String
  public let account: String

  /// Nil unless both names are ones the helper may touch.
  public init?(service: String, account: String) {
    guard isAllowedService(service), isAllowedAccount(account) else { return nil }
    self.service = service
    self.account = account
  }
}

/// `valet`, or `valet.` and up to three dot-separated lowercase names.
public func isAllowedService(_ service: String) -> Bool {
  let parts = service.split(separator: ".", omittingEmptySubsequences: false)
  guard parts.first == "valet", parts.count <= 4 else { return false }
  return parts.dropFirst().allSatisfy { part in
    (1...32).contains(part.utf8.count)
      && part.utf8.allSatisfy { ($0 >= 0x61 && $0 <= 0x7A) || ($0 >= 0x30 && $0 <= 0x39) || $0 == 0x2D }
  }
}

/// 1 to 512 bytes of printable text.
public func isAllowedAccount(_ account: String) -> Bool {
  (1...512).contains(account.utf8.count) && isPrintable(account)
}

/// No control characters (including DEL).
public func isPrintable(_ text: String) -> Bool {
  text.unicodeScalars.allSatisfy { $0.value >= 0x20 && $0.value != 0x7F && !(0x80...0x9F).contains($0.value) }
}

public final class KeychainStore {
  private let keychain: SecKeychain?

  /// `keychainPath` is for tests (a throwaway keychain file); nil is the person's default keychain.
  public init(keychainPath: String? = nil) throws {
    if let keychainPath {
      var opened: SecKeychain?
      let status = SecKeychainOpen(keychainPath, &opened)
      guard status == errSecSuccess, let opened else { throw KeychainFailure.other(status) }
      keychain = opened
    } else {
      keychain = nil
    }
  }

  private func baseQuery(_ item: KeychainItem) -> [String: Any] {
    var query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: item.service,
      kSecAttrAccount as String: item.account,
    ]
    if let keychain { query[kSecMatchSearchList as String] = [keychain] }
    return query
  }

  /// The item's secret. The caller wipes it.
  public func read(_ item: KeychainItem) throws -> [UInt8] {
    var query = baseQuery(item)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    try check(SecItemCopyMatching(query as CFDictionary, &result))
    guard let data = result as? Data else { throw KeychainFailure.other(errSecInternalError) }
    return [UInt8](data)
  }

  /// The item's comment, without reading its secret, so it never prompts.
  public func comment(_ item: KeychainItem) throws -> String {
    var query = baseQuery(item)
    query[kSecReturnAttributes as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    try check(SecItemCopyMatching(query as CFDictionary, &result))
    guard let attributes = result as? [String: Any] else { throw KeychainFailure.other(errSecInternalError) }
    return attributes[kSecAttrComment as String] as? String ?? ""
  }

  /// Replaces the item's secret and comment, adding the item if it isn't there.
  public func write(_ item: KeychainItem, secret: [UInt8], comment: String) throws {
    let data = Data(secret)
    let changes: [String: Any] = [kSecValueData as String: data, kSecAttrComment as String: comment]
    var status = SecItemUpdate(baseQuery(item) as CFDictionary, changes as CFDictionary)
    if status == errSecItemNotFound {
      var add: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: item.service,
        kSecAttrAccount as String: item.account,
        kSecAttrLabel as String: item.service,
        kSecValueData as String: data,
        kSecAttrComment as String: comment,
      ]
      if let keychain { add[kSecUseKeychain as String] = keychain }
      status = SecItemAdd(add as CFDictionary, nil)
    }
    try check(status)
  }

  public func delete(_ item: KeychainItem) throws {
    try check(SecItemDelete(baseQuery(item) as CFDictionary))
  }

  private func check(_ status: OSStatus) throws {
    switch status {
    case errSecSuccess: return
    case errSecItemNotFound: throw KeychainFailure.notFound
    case errSecInteractionNotAllowed, errSecInteractionRequired, errSecUserCanceled, errSecAuthFailed:
      throw KeychainFailure.interaction
    default: throw KeychainFailure.other(status)
    }
  }
}
