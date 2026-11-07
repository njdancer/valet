// valet-keychain: Valet's own Keychain items, for the app's main process only (D6).
//
//   valet-keychain read   <service> <account>            the secret, on stdout, as stored
//   valet-keychain info   <service> <account>            the item's comment, never its secret
//   valet-keychain write  <service> <account> <comment>  the secret on stdin (never argv)
//   valet-keychain delete <service> <account>
//
// Exit codes, which packages/credentials/src/keychain-helper.ts maps: 0 done, 44 no such item (as
// /usr/bin/security), 51 the Keychain wants the person, 64 usage, 77 caller refused, 1 anything
// else. Nothing but the secret or the comment ever reaches stdout, and stderr says only which class
// of failure it was.

import Foundation
import ValetHelperKit

enum Code {
  static let ok: Int32 = 0
  static let other: Int32 = 1
  static let notFound: Int32 = 44
  static let interaction: Int32 = 51
  static let usage: Int32 = 64
  static let refused: Int32 = 77
}

/// The most a secret or comment may be: a password, a TOTP secret or a service-account token.
let maxSecretBytes = 16 * 1024
let maxCommentBytes = 2 * 1024

func fail(_ code: Int32, _ message: String) -> Never {
  FileHandle.standardError.write(Data("valet-keychain: \(message)\n".utf8))
  exit(code)
}

/// stdin to its end, refusing more than `limit` bytes.
func readInput(limit: Int) -> [UInt8]? {
  var bytes = [UInt8]()
  var buffer = [UInt8](repeating: 0, count: 4096)
  defer { wipe(&buffer) }
  while true {
    let count = read(0, &buffer, buffer.count)
    if count < 0 {
      if errno == EINTR { continue }
      wipe(&bytes)
      return nil
    }
    if count == 0 { return bytes }
    bytes.append(contentsOf: buffer[0..<count])
    if bytes.count > limit {
      wipe(&bytes)
      return nil
    }
  }
}

func writeAll(_ bytes: [UInt8]) -> Bool {
  var offset = 0
  while offset < bytes.count {
    let written = bytes[offset...].withUnsafeBytes { write(1, $0.baseAddress, $0.count) }
    if written < 0 {
      if errno == EINTR { continue }
      return false
    }
    offset += written
  }
  return true
}

signal(SIGPIPE, SIG_IGN)

if let team = Caller.ownTeamID(), !Caller.parentIsSigned(by: team) {
  fail(Code.refused, "caller refused")
}

let args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else { fail(Code.usage, "usage: valet-keychain read|info|write|delete <service> <account>") }
let expected = command == "write" ? 4 : 3
guard ["read", "info", "write", "delete"].contains(command), args.count == expected else {
  fail(Code.usage, "usage: valet-keychain read|info|write|delete <service> <account>")
}
guard let item = KeychainItem(service: args[1], account: args[2]) else { fail(Code.usage, "invalid item") }

// A throwaway keychain file for the contract suite; a release build always uses the default.
#if DEBUG
  let keychainPath = ProcessInfo.processInfo.environment["VALET_KEYCHAIN_PATH"]
#else
  let keychainPath: String? = nil
#endif

do {
  let store = try KeychainStore(keychainPath: keychainPath)
  switch command {
  case "read":
    var secret = try store.read(item)
    defer { wipe(&secret) }
    if !writeAll(secret) { fail(Code.other, "write failed") }
  case "info":
    if !writeAll(Array(try store.comment(item).utf8)) { fail(Code.other, "write failed") }
  case "write":
    let comment = args[3]
    guard comment.utf8.count <= maxCommentBytes, isPrintable(comment) else { fail(Code.usage, "invalid comment") }
    guard var secret = readInput(limit: maxSecretBytes), !secret.isEmpty else { fail(Code.usage, "invalid secret") }
    defer { wipe(&secret) }
    try store.write(item, secret: secret, comment: comment)
  default:
    try store.delete(item)
  }
  exit(Code.ok)
} catch KeychainFailure.notFound {
  fail(Code.notFound, "not found")
} catch KeychainFailure.interaction {
  fail(Code.interaction, "interaction required")
} catch KeychainFailure.other(let status) {
  fail(Code.other, "keychain status \(status)")
} catch {
  fail(Code.other, "failed")
}
