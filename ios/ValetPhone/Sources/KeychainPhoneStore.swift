import Foundation
import Security
import ValetPhoneCore

/// Keeps the phone's pairing state in the Keychain, on this device only: it is never in a backup and
/// never moves to a new phone (docs/ios-app.md, Keys). Keychain items outlive deleting the app, so a
/// marker in the app's own container tells a fresh install from a relaunch, and a fresh install
/// wipes what an earlier install left (review finding 21).
final class KeychainPhoneStore: PhoneStore {
  private let service = "me.dncr.valet.phone"
  private let account = "state"
  private static let installMarker = "valet-installed"

  init() {
    let marker = Self.markerURL
    if !FileManager.default.fileExists(atPath: marker.path) {
      wipe()
      FileManager.default.createFile(atPath: marker.path, contents: Data())
    }
  }

  private static var markerURL: URL {
    let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    try? FileManager.default.createDirectory(at: support, withIntermediateDirectories: true)
    return support.appendingPathComponent(installMarker)
  }

  private var query: [String: Any] {
    [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
  }

  func load() -> PersistedPhone? {
    var q = query
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var out: CFTypeRef?
    guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
    return try? JSONDecoder().decode(PersistedPhone.self, from: data)
  }

  func save(_ state: PersistedPhone) {
    guard let data = try? JSONEncoder().encode(state) else { return }
    let update: [String: Any] = [kSecValueData as String: data]
    if SecItemUpdate(query as CFDictionary, update as CFDictionary) == errSecItemNotFound {
      var add = query
      add[kSecValueData as String] = data
      add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
      SecItemAdd(add as CFDictionary, nil)
    }
  }

  func wipe() {
    SecItemDelete(query as CFDictionary)
  }
}
