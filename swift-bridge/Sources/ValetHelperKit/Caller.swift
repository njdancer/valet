// Who may ask a helper for a secret. A helper signed with a Team ID answers only a caller signed by
// that same team: the Keychain helper checks its parent (the app's main process, which spawned it),
// the Messages helper checks the peer of each socket connection. An unsigned or ad hoc signed
// helper is a development build and has no team to check against, so it answers anyone running as
// this user, which is no worse than the in-process reader it stands in for.

import Foundation
import Security

public enum Caller {
  /// The Team ID this binary is signed with, or nil when it is unsigned or ad hoc signed.
  public static func ownTeamID() -> String? {
    var code: SecCode?
    guard SecCodeCopySelf([], &code) == errSecSuccess, let code else { return nil }
    var staticCode: SecStaticCode?
    guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let staticCode else { return nil }
    var info: CFDictionary?
    guard
      SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &info)
        == errSecSuccess,
      let dict = info as? [String: Any]
    else { return nil }
    guard let team = dict[kSecCodeInfoTeamIdentifier as String] as? String, isTeamID(team) else { return nil }
    return team
  }

  /// Ten letters or digits, as Apple issues them.
  public static func isTeamID(_ value: String) -> Bool {
    value.utf8.count == 10 && value.utf8.allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x41 && $0 <= 0x5A) }
  }

  /// Apple's chain, and a leaf issued to `teamID`.
  public static func requirement(teamID: String) -> String {
    "anchor apple generic and certificate leaf[subject.OU] = \"\(teamID)\""
  }

  /// Whether this process's parent is signed by `teamID`. A parent that has gone (re-parented to
  /// launchd) never passes.
  public static func parentIsSigned(by teamID: String) -> Bool {
    let parent = getppid()
    guard parent > 1 else { return false }
    return guest([kSecGuestAttributePid as String: NSNumber(value: parent)], satisfies: requirement(teamID: teamID))
  }

  /// Whether the process behind `auditToken` is signed by `teamID`. The audit token names one
  /// process instance, so a reused pid can't pass for it.
  public static func peerIsSigned(auditToken: audit_token_t, by teamID: String) -> Bool {
    var token = auditToken
    let data = withUnsafeBytes(of: &token) { Data($0) }
    return guest([kSecGuestAttributeAudit as String: data], satisfies: requirement(teamID: teamID))
  }

  static func guest(_ attributes: [String: Any], satisfies text: String) -> Bool {
    var requirement: SecRequirement?
    guard SecRequirementCreateWithString(text as CFString, [], &requirement) == errSecSuccess, let requirement
    else { return false }
    var code: SecCode?
    guard SecCodeCopyGuestWithAttributes(nil, attributes as CFDictionary, [], &code) == errSecSuccess, let code
    else { return false }
    return SecCodeCheckValidity(code, [], requirement) == errSecSuccess
  }
}

/// Zeroes `bytes` in a way the optimiser can't drop.
public func wipe(_ bytes: inout [UInt8]) {
  let count = bytes.count
  bytes.withUnsafeMutableBytes { raw in
    if let base = raw.baseAddress { _ = memset_s(base, count, 0, count) }
  }
}
