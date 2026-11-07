// The stdio bridge as a command: `valet-bridge <config file>`. An MCP client launches it and
// speaks MCP on its stdin and stdout; diagnostics go to stderr only.

import type { Readable, Writable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { ValetError } from '@valet/core'
import { runBridge } from './bridge'
import { readBridgeConfig } from './bridge-config'

export interface CliIo {
  readonly input: Readable
  readonly output: Writable
  readonly errors: Writable
  readonly readConfig?: typeof readBridgeConfig
  readonly run?: typeof runBridge
}

export const USAGE = 'usage: valet-bridge <config file>\n'

/** Runs the bridge until the client goes away. Resolves to the process exit code. */
export async function main(args: readonly string[], io: CliIo): Promise<number> {
  const [configPath, ...extra] = args
  if (configPath === undefined || extra.length > 0) {
    io.errors.write(USAGE)
    return 2
  }
  const readConfig = io.readConfig ?? readBridgeConfig
  let config: Awaited<ReturnType<typeof readBridgeConfig>>
  try {
    config = await readConfig(configPath)
  } catch (error) {
    io.errors.write(`valet-bridge: ${configProblem(error)}\n`)
    return 1
  }
  const bridge = await (io.run ?? runBridge)({
    ...config,
    input: io.input,
    output: io.output,
    // The app rewrites the file with its new port and token each time it starts.
    reconnect: () => readConfig(configPath),
  })
  await bridge.done
  return 0
}

function configProblem(error: unknown): string {
  const errorClass = error instanceof ValetError ? error.errorClass : null
  switch (errorClass) {
    case 'not-found':
      return 'the config file does not exist; start Valet to write it'
    case 'insecure-file':
      return 'the config file must be a regular file owned by you with mode 0600; start Valet to rewrite it'
    case 'invalid':
      return 'the config file must hold only the endpoint url (http://127.0.0.1:<port>/mcp) and token'
    default:
      return 'the config file cannot be read'
  }
}

/* v8 ignore start -- the process entry point; main() is what the tests exercise. */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), { input: process.stdin, output: process.stdout, errors: process.stderr }).then(
    (code) => {
      process.exitCode = code
    },
  )
}
/* v8 ignore stop */
