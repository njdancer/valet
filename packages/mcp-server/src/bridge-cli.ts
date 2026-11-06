// The stdio bridge as a command: `siteadapter-bridge <config file>`. An MCP client launches it and
// speaks MCP on its stdin and stdout; diagnostics go to stderr only.

import type { Readable, Writable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { SiteAdapterError } from '@siteadapter/core'
import { runBridge } from './bridge'
import { readBridgeConfig } from './bridge-config'

export interface CliIo {
  readonly input: Readable
  readonly output: Writable
  readonly errors: Writable
  readonly readConfig?: typeof readBridgeConfig
  readonly run?: typeof runBridge
}

export const USAGE = 'usage: siteadapter-bridge <config file>\n'

/** Runs the bridge until the client goes away. Resolves to the process exit code. */
export async function main(args: readonly string[], io: CliIo): Promise<number> {
  const [configPath, ...extra] = args
  if (configPath === undefined || extra.length > 0) {
    io.errors.write(USAGE)
    return 2
  }
  let config: Awaited<ReturnType<typeof readBridgeConfig>>
  try {
    config = await (io.readConfig ?? readBridgeConfig)(configPath)
  } catch (error) {
    io.errors.write(`siteadapter-bridge: ${configProblem(error)}\n`)
    return 1
  }
  const bridge = await (io.run ?? runBridge)({ ...config, input: io.input, output: io.output })
  await bridge.done
  return 0
}

function configProblem(error: unknown): string {
  if (error instanceof SiteAdapterError && error.errorClass === 'not-found') {
    return 'the config file does not exist or cannot be opened'
  }
  return 'the config file must be private to you (mode 0600) and hold the endpoint url and token'
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
