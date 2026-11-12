// The phone's three keys (docs/ios-app.md, Keys on the phone).
//
// - Approval: Secure Enclave, `.privateKeyUsage` + `.biometryCurrentSet` (CR-1). Every signature
//   loads the key from its blob with a brand-new LAContext whose reuse window is zero, so each one
//   asks for Face ID. Nothing caches the key or the context.
// - Transport: Secure Enclave, no user presence. Answers the relay's challenge.
// - Agreement: a CryptoKit software P-256 key kept in the Keychain (B allows "or Keychain").
//
// The simulator has no Secure Enclave, so `SoftwareDeviceKeys` (ValetFakes) stands in there and in
// tests. The shipping app doesn't link ValetFakes, and `DeviceKeyFactory` refuses software keys.

import CryptoKit
import Foundation
import ValetProtocol

#if canImport(LocalAuthentication)
  import LocalAuthentication
#endif

public struct DevicePublicKeys: Equatable, Sendable {
  public let approval: String
  public let transport: String
  public let agreement: String

  public init(approval: String, transport: String, agreement: String) {
    self.approval = approval
    self.transport = transport
    self.agreement = agreement
  }

  /// The device id: keyId(approval key).
  public var deviceId: String { Signing.keyId(approval)! }
}

public enum KeyError: Error, Equatable {
  /// Face ID failed, was cancelled, or the enrolment changed and the key is gone.
  case userCancelled
  case biometryChanged
  case unavailable
  case corrupt
}

public protocol DeviceKeys: Sendable {
  var publicKeys: DevicePublicKeys { get }
  /// True for Secure Enclave keys; false for the simulator's software keys.
  var hardwareBacked: Bool { get }
  /// Signs with the approval key. Raises Face ID itself; `reason` must be Mac-written words only.
  func signApproval(_ input: Data, reason: String) async throws -> Data
  /// Signs with the transport key. No prompt.
  func signTransport(_ input: Data) throws -> Data
  /// The agreement key, for HPKE.
  func agreementKey() throws -> P256.KeyAgreement.PrivateKey
  /// The stored form, for the Keychain.
  var stored: StoredKeys { get }
}

/// What a device's keys persist as. Blobs for Secure Enclave keys are usable only on this device.
public struct StoredKeys: Codable, Equatable, Sendable {
  public enum Kind: String, Codable, Sendable { case secureEnclave, software }
  public let kind: Kind
  public let approval: Data
  public let transport: Data
  public let agreement: Data

  public init(kind: Kind, approval: Data, transport: Data, agreement: Data) {
    self.kind = kind
    self.approval = approval
    self.transport = transport
    self.agreement = agreement
  }
}

#if canImport(LocalAuthentication)
  /// The access-control flags each key is made with. A unit test pins them, since software keys
  /// in the simulator can't show they hold.
  public enum KeyPolicy {
    public static let approvalFlags: SecAccessControlCreateFlags = [.privateKeyUsage, .biometryCurrentSet]
    public static let approvalAccessible = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    public static let transportFlags: SecAccessControlCreateFlags = [.privateKeyUsage]
    public static let transportAccessible = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly

    static func accessControl(_ accessible: CFString, _ flags: SecAccessControlCreateFlags) throws -> SecAccessControl {
      var error: Unmanaged<CFError>?
      guard let control = SecAccessControlCreateWithFlags(nil, accessible, flags, &error) else {
        throw KeyError.unavailable
      }
      return control
    }
  }

  /// Secure Enclave keys: a real iPhone.
  public final class SecureEnclaveDeviceKeys: DeviceKeys, @unchecked Sendable {
    private let approvalBlob: Data
    private let transportBlob: Data
    private let agreement: P256.KeyAgreement.PrivateKey
    public let publicKeys: DevicePublicKeys

    public static var isAvailable: Bool { SecureEnclave.isAvailable }

    public init() throws {
      guard SecureEnclave.isAvailable else { throw KeyError.unavailable }
      let approval = try SecureEnclave.P256.Signing.PrivateKey(
        accessControl: try KeyPolicy.accessControl(KeyPolicy.approvalAccessible, KeyPolicy.approvalFlags)
      )
      let transport = try SecureEnclave.P256.Signing.PrivateKey(
        accessControl: try KeyPolicy.accessControl(KeyPolicy.transportAccessible, KeyPolicy.transportFlags)
      )
      agreement = P256.KeyAgreement.PrivateKey()
      approvalBlob = approval.dataRepresentation
      transportBlob = transport.dataRepresentation
      publicKeys = DevicePublicKeys(
        approval: Signing.spki(approval.publicKey),
        transport: Signing.spki(transport.publicKey),
        agreement: Signing.spki(agreement.publicKey)
      )
    }

    public init(stored: StoredKeys) throws {
      guard stored.kind == .secureEnclave, SecureEnclave.isAvailable else { throw KeyError.unavailable }
      approvalBlob = stored.approval
      transportBlob = stored.transport
      do {
        agreement = try P256.KeyAgreement.PrivateKey(rawRepresentation: stored.agreement)
        // Loading a key reads only its public half; no prompt.
        let context = LAContext()
        context.interactionNotAllowed = true
        let approval = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: approvalBlob, authenticationContext: context)
        let transport = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: transportBlob)
        publicKeys = DevicePublicKeys(
          approval: Signing.spki(approval.publicKey),
          transport: Signing.spki(transport.publicKey),
          agreement: Signing.spki(agreement.publicKey)
        )
      } catch { throw KeyError.corrupt }
    }

    public var hardwareBacked: Bool { true }

    public var stored: StoredKeys {
      StoredKeys(kind: .secureEnclave, approval: approvalBlob, transport: transportBlob, agreement: agreement.rawRepresentation)
    }

    public func signApproval(_ input: Data, reason: String) async throws -> Data {
      let blob = approvalBlob
      return try await Task.detached(priority: .userInitiated) {
        // A new context every time, with no reuse window, so no earlier Face ID match counts.
        let context = LAContext()
        context.touchIDAuthenticationAllowableReuseDuration = 0
        context.localizedReason = reason
        context.localizedFallbackTitle = ""
        do {
          let key = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: blob, authenticationContext: context)
          return try key.signature(for: input).rawRepresentation
        } catch is LAError {
          throw KeyError.userCancelled
        } catch {
          // Anything else is reported as a failed match, not as a Face ID change: telling the
          // person to pair again on a guess would be worse (red team 9). A real enrolment change is
          // left to a launch-time check (docs/ios-app.md, open items).
          throw KeyError.userCancelled
        }
      }.value
    }

    public func signTransport(_ input: Data) throws -> Data {
      let key = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: transportBlob)
      return try key.signature(for: input).rawRepresentation
    }

    public func agreementKey() throws -> P256.KeyAgreement.PrivateKey { agreement }
  }
#endif

public enum DeviceKeyFactory {
  /// New keys for pairing: the Secure Enclave, or pairing is refused. Software keys live in
  /// ValetFakes, which the shipping app doesn't link (red team 12).
  public static func make() throws -> DeviceKeys {
    #if canImport(LocalAuthentication)
      if SecureEnclaveDeviceKeys.isAvailable { return try SecureEnclaveDeviceKeys() }
    #endif
    throw KeyError.unavailable
  }

  public static func load(_ stored: StoredKeys) throws -> DeviceKeys {
    switch stored.kind {
    case .software:
      throw KeyError.unavailable
    case .secureEnclave:
      #if canImport(LocalAuthentication)
        return try SecureEnclaveDeviceKeys(stored: stored)
      #else
        throw KeyError.unavailable
      #endif
    }
  }
}
