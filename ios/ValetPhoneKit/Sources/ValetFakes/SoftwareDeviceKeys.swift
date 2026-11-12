import CryptoKit
import Foundation
import ValetCrypto

/// Software keys: the simulator and tests only.
public final class SoftwareDeviceKeys: DeviceKeys, @unchecked Sendable {
  private let approval: P256.Signing.PrivateKey
  private let transport: P256.Signing.PrivateKey
  private let agreement: P256.KeyAgreement.PrivateKey
  /// A test hook standing in for Face ID: return false to simulate a failed or cancelled match.
  public var presence: @Sendable (String) async -> Bool = { _ in true }
  /// Every reason this key was asked to sign with, for tests.
  public private(set) var reasons: [String] = []

  public init() {
    approval = P256.Signing.PrivateKey()
    transport = P256.Signing.PrivateKey()
    agreement = P256.KeyAgreement.PrivateKey()
  }

  public init(stored: StoredKeys) throws {
    guard stored.kind == .software else { throw KeyError.corrupt }
    do {
      approval = try P256.Signing.PrivateKey(rawRepresentation: stored.approval)
      transport = try P256.Signing.PrivateKey(rawRepresentation: stored.transport)
      agreement = try P256.KeyAgreement.PrivateKey(rawRepresentation: stored.agreement)
    } catch { throw KeyError.corrupt }
  }

  public var hardwareBacked: Bool { false }

  public var publicKeys: DevicePublicKeys {
    DevicePublicKeys(
      approval: Signing.spki(approval.publicKey),
      transport: Signing.spki(transport.publicKey),
      agreement: Signing.spki(agreement.publicKey)
    )
  }

  public var stored: StoredKeys {
    StoredKeys(
      kind: .software, approval: approval.rawRepresentation, transport: transport.rawRepresentation,
      agreement: agreement.rawRepresentation
    )
  }

  public func signApproval(_ input: Data, reason: String) async throws -> Data {
    reasons.append(reason)
    guard await presence(reason) else { throw KeyError.userCancelled }
    return try approval.signature(for: input).rawRepresentation
  }

  public func signTransport(_ input: Data) throws -> Data {
    try transport.signature(for: input).rawRepresentation
  }

  public func agreementKey() throws -> P256.KeyAgreement.PrivateKey { agreement }
}
