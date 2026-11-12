// valet-approver: the Mac's own device keys (docs/agent-run-security.md#devices-and-keys,
// docs/approval-broker.md#approving-at-the-mac).
//
//   valet-approver keys            the public keys, as JSON; 44 if there are none yet
//   valet-approver create          makes the three keys; 73 if any already exist
//   valet-approver sign-decision   stdin {"requestText","payload"}: the approval signature
//
// Every key is a P-256 key in the Secure Enclave. The approval key needs user presence (Touch ID,
// or the Mac's password), so each signature is the person's gesture; the transport and agreement
// keys don't. The Keychain keeps only the Secure Enclave's wrapped blobs, usable on this Mac alone.
// No private key ever leaves this process, and nothing but public keys and signatures reaches
// stdout.
//
// The helper signs only an approval of exactly the request it was shown, and writes the prompt's
// reason itself from that request (ValetHelperKit/Approval.swift). `keys` never creates: a missing
// key is reported, never silently replaced, because a new approval key is a new Mac identity.
//
// Exit codes, which apps/desktop/src/main/core/approvals/helper-signer.ts maps: 0 done, 44 no keys,
// 50 the person cancelled or failed the prompt, 64 usage or a payload refused, 69 no Secure
// Enclave, 73 keys exist, 77 caller refused, 1 anything else.

import CryptoKit
import Foundation
import LocalAuthentication
import Security
import ValetHelperKit

enum Code {
  static let ok: Int32 = 0
  static let other: Int32 = 1
  static let noKeys: Int32 = 44
  static let cancelled: Int32 = 50
  static let usage: Int32 = 64
  static let unavailable: Int32 = 69
  static let exists: Int32 = 73
  static let refused: Int32 = 77
}

func fail(_ code: Int32, _ message: String) -> Never {
  FileHandle.standardError.write(Data("valet-approver: \(message)\n".utf8))
  exit(code)
}

func output(_ text: String) {
  FileHandle.standardOutput.write(Data(text.utf8))
}

signal(SIGPIPE, SIG_IGN)

if let team = Caller.ownTeamID(), !Caller.parentIsSigned(by: team) {
  fail(Code.refused, "caller refused")
}

// Debug builds only: a throwaway keychain, and software keys with a stand-in for the finger, for
// the contract suite on CI runners, which have no Secure Enclave. Release builds ignore all three.
#if DEBUG
  let environment = ProcessInfo.processInfo.environment
  let keychainPath = environment["VALET_KEYCHAIN_PATH"]
  let software = environment["VALET_APPROVER_SOFTWARE"] == "1"
  let present = environment["VALET_APPROVER_PRESENT"] != "0"
#else
  let keychainPath: String? = nil
  let software = false
  let present = true
#endif

let service = "valet.device"
let names = ["approval", "transport", "agreement"]

let store: KeychainStore
do {
  store = try KeychainStore(keychainPath: keychainPath)
} catch {
  fail(Code.other, "keychain unavailable")
}

func item(_ name: String) -> KeychainItem {
  guard let item = KeychainItem(service: service, account: name) else { fail(Code.other, "invalid item") }
  return item
}

/// The stored blob, or nil if there is none.
func blob(_ name: String) -> Data? {
  do {
    return Data(try store.read(item(name)))
  } catch KeychainFailure.notFound {
    return nil
  } catch {
    fail(Code.other, "keychain read failed")
  }
}

func accessControl(presence: Bool) -> SecAccessControl {
  let flags: SecAccessControlCreateFlags = presence ? [.privateKeyUsage, .userPresence] : [.privateKeyUsage]
  var error: Unmanaged<CFError>?
  guard
    let access = SecAccessControlCreateWithFlags(
      nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, flags, &error)
  else { fail(Code.other, "access control") }
  return access
}

/// The SPKI DER of a stored key's public half.
func publicKey(_ name: String, _ data: Data) throws -> Data {
  if software {
    if name == "agreement" { return try P256.KeyAgreement.PrivateKey(rawRepresentation: data).publicKey.derRepresentation }
    return try P256.Signing.PrivateKey(rawRepresentation: data).publicKey.derRepresentation
  }
  if name == "agreement" {
    return try SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: data).publicKey.derRepresentation
  }
  // Reading the public half of the approval key needs no presence: only signing does.
  return try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: data).publicKey.derRepresentation
}

func printKeys(_ blobs: [String: Data]) {
  var keys: [String: String] = [:]
  for name in names {
    guard let data = blobs[name], let der = try? publicKey(name, data) else { fail(Code.other, "unreadable key") }
    keys["\(name)Key"] = base64url(der)
  }
  guard let json = try? JSONSerialization.data(withJSONObject: keys, options: [.sortedKeys]) else {
    fail(Code.other, "encode")
  }
  output(String(decoding: json, as: UTF8.self))
}

func storedBlobs() -> [String: Data] {
  var found: [String: Data] = [:]
  for name in names { if let data = blob(name) { found[name] = data } }
  return found
}

let args = Array(CommandLine.arguments.dropFirst())
guard args.count == 1, let command = args.first else {
  fail(Code.usage, "usage: valet-approver keys|create|sign-decision")
}

switch command {
case "keys":
  let found = storedBlobs()
  if found.isEmpty { fail(Code.noKeys, "no keys") }
  // Some but not all: never fill the gap, which would change the Mac's identity.
  if found.count != names.count { fail(Code.other, "incomplete keys") }
  printKeys(found)

case "create":
  if !storedBlobs().isEmpty { fail(Code.exists, "keys exist") }
  if !software && !SecureEnclave.isAvailable { fail(Code.unavailable, "no secure enclave") }
  var made: [String: Data] = [:]
  do {
    if software {
      made["approval"] = P256.Signing.PrivateKey().rawRepresentation
      made["transport"] = P256.Signing.PrivateKey().rawRepresentation
      made["agreement"] = P256.KeyAgreement.PrivateKey().rawRepresentation
    } else {
      made["approval"] = try SecureEnclave.P256.Signing.PrivateKey(
        accessControl: accessControl(presence: true)).dataRepresentation
      made["transport"] = try SecureEnclave.P256.Signing.PrivateKey(
        accessControl: accessControl(presence: false)).dataRepresentation
      made["agreement"] = try SecureEnclave.P256.KeyAgreement.PrivateKey(
        accessControl: accessControl(presence: false)).dataRepresentation
    }
    for name in names {
      guard let data = made[name] else { fail(Code.other, "create failed") }
      try store.write(item(name), secret: [UInt8](data), comment: "Valet device key")
    }
  } catch {
    fail(Code.other, "create failed")
  }
  printKeys(made)

case "sign-decision":
  guard
    let input = try? FileHandle.standardInput.readToEnd(), input.count <= 160 * 1024,
    let body = (try? JSONSerialization.jsonObject(with: input)) as? [String: Any],
    let requestText = body["requestText"] as? String,
    let payload = body["payload"] as? String
  else { fail(Code.usage, "invalid input") }
  guard let approval = blob("approval") else { fail(Code.noKeys, "no keys") }
  guard let der = try? publicKey("approval", approval) else { fail(Code.other, "unreadable key") }
  guard let toSign = approvalToSign(requestText: requestText, payload: payload, deviceId: keyId(spki: der)) else {
    fail(Code.usage, "payload refused")
  }
  let signature: Data
  if software {
    #if DEBUG
      FileHandle.standardError.write(Data("valet-approver: reason: \(toSign.reason)\n".utf8))
    #endif
    if !present { fail(Code.cancelled, "cancelled") }
    guard let key = try? P256.Signing.PrivateKey(rawRepresentation: approval),
      let signed = try? key.signature(for: toSign.input)
    else { fail(Code.other, "sign failed") }
    signature = signed.rawRepresentation
  } else {
    // A fresh context with no reuse, so every approval asks for the finger again.
    let context = LAContext()
    context.localizedReason = toSign.reason
    context.touchIDAuthenticationAllowableReuseDuration = 0
    guard
      let key = try? SecureEnclave.P256.Signing.PrivateKey(
        dataRepresentation: approval, authenticationContext: context)
    else { fail(Code.other, "unreadable key") }
    // Any failure here (cancelled, failed, locked out) signed nothing.
    guard let signed = try? key.signature(for: toSign.input) else { fail(Code.cancelled, "not signed") }
    signature = signed.rawRepresentation
  }
  output(base64url(signature))

default:
  fail(Code.usage, "usage: valet-approver keys|create|sign-decision")
}
exit(Code.ok)
