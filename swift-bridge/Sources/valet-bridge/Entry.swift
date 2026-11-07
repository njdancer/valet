// `valet-bridge <config file>`: an MCP client launches it and speaks MCP on its stdin and stdout.
// Diagnostics go to stderr only. Exit codes as bridge-cli.ts: 2 for usage, 1 for a config problem,
// 0 once the client has gone away.

import Foundation

private let usage = "usage: valet-bridge <config file>\n"

@main
struct ValetBridge {
  static func main() async {
    // A client that closes its end mid-write must not kill the bridge before it answers.
    signal(SIGPIPE, SIG_IGN)
    let args = CommandLine.arguments.dropFirst()
    guard args.count == 1, let configPath = args.first else {
      FileHandle.standardError.write(Data(usage.utf8))
      exit(2)
    }
    let target: BridgeTarget
    do {
      target = try readBridgeConfig(configPath)
    } catch {
      let problem = (error as? ConfigProblem) ?? .unavailable
      FileHandle.standardError.write(Data("valet-bridge: \(problem.message)\n".utf8))
      exit(1)
    }
    // The app rewrites the file with its new port and token each time it starts, or when the
    // person resets this client's access.
    let bridge = Bridge(target: target, output: Output(), reconnect: { try readBridgeConfig(configPath) })
    for await line in stdinLines() {
      await bridge.relayUp(line)
    }
    await bridge.close()
    exit(0)
  }
}

/// Newline-delimited lines from stdin, read on a thread of their own so a slow upstream never stops
/// the client's writes from being drained.
func stdinLines() -> AsyncStream<Data> {
  AsyncStream { continuation in
    let thread = Thread {
      var pending = Data()
      let input = FileHandle.standardInput
      while true {
        let chunk = input.availableData
        if chunk.isEmpty { break }
        pending.append(chunk)
        while let newline = pending.firstIndex(of: 0x0A) {
          var line = pending[pending.startIndex..<newline]
          if line.last == 0x0D { line = line.dropLast() }
          if !line.isEmpty { continuation.yield(Data(line)) }
          pending.removeSubrange(pending.startIndex...newline)
        }
      }
      continuation.finish()
    }
    thread.start()
  }
}
