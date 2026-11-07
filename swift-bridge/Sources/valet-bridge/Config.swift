// The client's bridge config file, read the way packages/mcp-server/src/private-file.ts and
// bridge-config.ts read it: a regular file owned by this user with mode 0600, never a symlink,
// holding exactly the endpoint URL and the client's token. The bridge sends the token to whatever
// URL the file names, so only http://127.0.0.1:<port>/mcp is accepted.

import Foundation

struct BridgeTarget: Equatable {
  let url: URL
  let token: String
}

enum ConfigProblem: Error {
  case notFound
  case insecureFile
  case invalid
  case unavailable

  /// The same sentences as bridge-cli.ts's configProblem().
  var message: String {
    switch self {
    case .notFound: return "the config file does not exist; start Valet to write it"
    case .insecureFile:
      return "the config file must be a regular file owned by you with mode 0600; start Valet to rewrite it"
    case .invalid:
      return "the config file must hold only the endpoint url (http://127.0.0.1:<port>/mcp) and token"
    case .unavailable: return "the config file cannot be read"
    }
  }
}

/// Reads at most this much: the real file is under 150 bytes.
private let maxConfigBytes = 64 * 1024

func readBridgeConfig(_ path: String) throws -> BridgeTarget {
  // Never follow a planted symlink, and never block on a planted FIFO.
  let fd = open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  if fd < 0 {
    switch errno {
    case ENOENT: throw ConfigProblem.notFound
    case ELOOP: throw ConfigProblem.insecureFile
    default: throw ConfigProblem.unavailable
    }
  }
  defer { close(fd) }
  // Checked on the open descriptor, so the file can't be swapped between the check and the read.
  var info = stat()
  if fstat(fd, &info) != 0 { throw ConfigProblem.unavailable }
  if (info.st_mode & S_IFMT) != S_IFREG || info.st_uid != getuid() || (info.st_mode & 0o077) != 0 {
    throw ConfigProblem.insecureFile
  }
  var bytes = [UInt8]()
  var buffer = [UInt8](repeating: 0, count: 4096)
  while true {
    let count = read(fd, &buffer, buffer.count)
    if count < 0 { throw ConfigProblem.unavailable }
    if count == 0 { break }
    bytes.append(contentsOf: buffer[0..<count])
    if bytes.count > maxConfigBytes { throw ConfigProblem.invalid }
  }
  return try parseBridgeConfig(Data(bytes))
}

func parseBridgeConfig(_ data: Data) throws -> BridgeTarget {
  guard let json = try? JSONSerialization.jsonObject(with: data),
    let object = json as? [String: Any],
    Set(object.keys) == ["url", "token"],
    let urlText = object["url"] as? String,
    let token = object["token"] as? String,
    isWellFormedToken(token),
    let url = loopbackEndpoint(urlText)
  else { throw ConfigProblem.invalid }
  return BridgeTarget(url: url, token: token)
}

/// 32 bytes in unpadded base64url, as token.ts makes them.
func isWellFormedToken(_ token: String) -> Bool {
  token.utf8.count == 43
    && token.utf8.allSatisfy { byte in
      (byte >= 0x41 && byte <= 0x5A) || (byte >= 0x61 && byte <= 0x7A) || (byte >= 0x30 && byte <= 0x39)
        || byte == 0x2D || byte == 0x5F
    }
}

/// http://127.0.0.1:<port>/mcp and nothing else: not localhost, which can resolve to ::1, where the
/// endpoint isn't listening and another local account could be.
func loopbackEndpoint(_ text: String) -> URL? {
  let prefix = "http://127.0.0.1:"
  let suffix = "/mcp"
  guard text.hasPrefix(prefix), text.hasSuffix(suffix) else { return nil }
  let port = text.dropFirst(prefix.count).dropLast(suffix.count)
  guard !port.isEmpty, port.count <= 5, port.allSatisfy({ $0.isASCII && $0.isNumber }),
    let number = Int(port), number > 0, number <= 65535, port.first != "0"
  else { return nil }
  return URL(string: text)
}
