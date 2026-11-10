// valet-messages-helper: the only Valet process that holds Full Disk Access (D8).
//
//   valet-messages-helper serve <label>   the launch agent (launchd runs this; see the plist)
//   valet-messages-helper register        SMAppService: register the agent with launchd
//   valet-messages-helper unregister
//   valet-messages-helper status          enabled | requires-approval | not-registered | not-found
//
// Registered with SMAppService, launchd starts it, so it is responsible for itself and the Full
// Disk Access grant names it, not Valet: adapter tool code running under the app never inherits the
// grant. It listens on a Unix socket only this user can reach,
// ~/Library/Application Support/<label>/helper.sock, and answers one request per connection: the
// newest code from one sender since a time (ValetHelperKit's Messages.swift). A signed helper answers
// only a peer signed with its own Team ID. Node can't speak XPC without a native addon, so the
// socket stands in for the XPC service D8 sketched; the peer check is the same audit-token check.

import Foundation
import ServiceManagement
import ValetHelperKit

let plistName = "messages-helper.plist"
let maxRequestBytes = 16 * 1024
// SOL_LOCAL and LOCAL_PEERTOKEN from <sys/un.h>.
let solLocal: Int32 = 0
let localPeerToken: Int32 = 0x006

func fail(_ code: Int32, _ message: String) -> Never {
  FileHandle.standardError.write(Data("valet-messages-helper: \(message)\n".utf8))
  exit(code)
}

func isLabel(_ value: String) -> Bool {
  (1...64).contains(value.utf8.count)
    && value.utf8.allSatisfy { ($0 >= 0x61 && $0 <= 0x7A) || ($0 >= 0x30 && $0 <= 0x39) || $0 == 0x2E || $0 == 0x2D }
    && value.first != "."
}

func home() -> String {
  String(cString: getpwuid(getuid()).pointee.pw_dir)
}

func applicationSupport() -> String {
  home() + "/Library/Application Support"
}

func statusName(_ status: SMAppService.Status) -> String {
  switch status {
  case .enabled: return "enabled"
  case .requiresApproval: return "requires-approval"
  case .notRegistered: return "not-registered"
  case .notFound: return "not-found"
  @unknown default: return "not-found"
  }
}

/// Makes `dir` (mode 0700, owned by this user) and returns the socket path in it, removing a stale
/// socket of ours. Anything else at either path is refused.
func prepareSocket(dir: String) -> String {
  if mkdir(dir, 0o700) != 0 && errno != EEXIST { fail(1, "cannot create the socket directory") }
  var info = stat()
  guard lstat(dir, &info) == 0, (info.st_mode & S_IFMT) == S_IFDIR, info.st_uid == getuid() else {
    fail(1, "the socket directory is not ours")
  }
  chmod(dir, 0o700)
  let path = dir + "/helper.sock"
  if lstat(path, &info) == 0 {
    guard (info.st_mode & S_IFMT) == S_IFSOCK, info.st_uid == getuid() else { fail(1, "something else is at the socket path") }
    unlink(path)
  }
  return path
}

func listen(at path: String) -> Int32 {
  let fd = socket(AF_UNIX, SOCK_STREAM, 0)
  guard fd >= 0 else { fail(1, "socket failed") }
  var address = sockaddr_un()
  address.sun_family = sa_family_t(AF_UNIX)
  let bytes = Array(path.utf8)
  guard bytes.count < MemoryLayout.size(ofValue: address.sun_path) else { fail(1, "socket path too long") }
  withUnsafeMutableBytes(of: &address.sun_path) { raw in
    raw.copyBytes(from: bytes)
    raw[bytes.count] = 0
  }
  // Only this user, from the moment it exists.
  let previous = umask(0o077)
  let bound = withUnsafePointer(to: &address) {
    $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
  }
  umask(previous)
  guard bound == 0, chmod(path, 0o600) == 0, Darwin.listen(fd, 8) == 0 else { fail(1, "cannot listen") }
  return fd
}

/// Whether the peer runs as this user and, for a signed helper, is signed by the same team.
func peerAllowed(_ fd: Int32, team: String?) -> Bool {
  var uid: uid_t = 0
  var gid: gid_t = 0
  guard getpeereid(fd, &uid, &gid) == 0, uid == getuid() else { return false }
  guard let team else { return true }
  var token = audit_token_t()
  var length = socklen_t(MemoryLayout<audit_token_t>.size)
  guard getsockopt(fd, solLocal, localPeerToken, &token, &length) == 0 else { return false }
  return Caller.peerIsSigned(auditToken: token, by: team)
}

/// One line, up to the first newline, within the size limit and the socket's receive timeout.
func readRequest(_ fd: Int32) -> Data? {
  var data = Data()
  var buffer = [UInt8](repeating: 0, count: 4096)
  while data.count <= maxRequestBytes {
    let count = read(fd, &buffer, buffer.count)
    if count < 0 && errno == EINTR { continue }
    if count <= 0 { return nil }
    if let newline = buffer[0..<count].firstIndex(of: 0x0A) {
      data.append(contentsOf: buffer[0..<newline])
      return data
    }
    data.append(contentsOf: buffer[0..<count])
  }
  return nil
}

func sendData(_ fd: Int32, _ data: Data) {
  data.withUnsafeBytes { raw in
    var offset = 0
    while offset < raw.count {
      let written = write(fd, raw.baseAddress! + offset, raw.count - offset)
      if written < 0 && errno == EINTR { continue }
      if written <= 0 { return }
      offset += written
    }
  }
}

func serve(label: String, socketPath: String?, databasePath: String) -> Never {
  let team = Caller.ownTeamID()
  let path = socketPath ?? prepareSocket(dir: applicationSupport() + "/" + label)
  let server = listen(at: path)
  while true {
    let client = accept(server, nil, nil)
    if client < 0 { continue }
    var timeout = timeval(tv_sec: 2, tv_usec: 0)
    setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    setsockopt(client, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    var noSigpipe: Int32 = 1
    setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &noSigpipe, socklen_t(MemoryLayout<Int32>.size))
    defer { close(client) }
    guard peerAllowed(client, team: team) else {
      sendData(client, responseLine(.failure(.unavailable)))
      continue
    }
    guard let line = readRequest(client) else { continue }
    let nowMs = Int64(Date().timeIntervalSince1970 * 1000)
    let request: OtpRequest
    do {
      request = try parseOtpRequest(line, nowMs: nowMs)
    } catch {
      sendData(client, responseLine(.failure(.invalid)))
      continue
    }
    let result = answer(request, databasePath: databasePath) {
      // A match that overran its deadline is still running on another thread: answer, then exit so
      // launchd starts a fresh agent.
      sendData(client, responseLine(.failure(.invalid)))
      close(client)
      exit(70)
    }
    sendData(client, responseLine(result))
  }
}

signal(SIGPIPE, SIG_IGN)
let args = Array(CommandLine.arguments.dropFirst())
let service = SMAppService.agent(plistName: plistName)

switch args.first {
case "serve":
  guard args.count >= 2, isLabel(args[1]) else { fail(64, "usage: valet-messages-helper serve <label>") }
  var socketPath: String?
  var databasePath = home() + "/Library/Messages/chat.db"
  // The contract suite runs the agent by hand on a fixture database and a socket in a temporary
  // directory. A release build always reads the person's own chat.db.
  #if DEBUG
    var rest = args.dropFirst(2)
    while let flag = rest.first {
      rest = rest.dropFirst()
      guard let value = rest.first else { fail(64, "missing value for \(flag)") }
      rest = rest.dropFirst()
      switch flag {
      case "--socket": socketPath = value
      case "--db": databasePath = value
      default: fail(64, "unknown flag \(flag)")
      }
    }
  #else
    guard args.count == 2 else { fail(64, "usage: valet-messages-helper serve <label>") }
  #endif
  serve(label: args[1], socketPath: socketPath, databasePath: databasePath)
case "register":
  do {
    try service.register()
    print(statusName(service.status))
  } catch {
    // Most often: the person has to allow it in System Settings > General > Login Items.
    print(statusName(service.status))
    exit(service.status == .requiresApproval ? 0 : 1)
  }
case "unregister":
  do {
    try service.unregister()
  } catch {
    fail(1, "unregister failed")
  }
case "status":
  print(statusName(service.status))
default:
  fail(64, "usage: valet-messages-helper serve <label> | register | unregister | status")
}
