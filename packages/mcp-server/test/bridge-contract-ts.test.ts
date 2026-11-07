// The shared bridge suite against the TypeScript bridge, run as a command under tsx.

import { join } from 'node:path'
import { bridgeContract } from './bridge-contract'

const root = join(import.meta.dirname, '../../..')

bridgeContract('TypeScript', (configPath) => ({
  command: join(root, 'node_modules/.bin/tsx'),
  args: [join(root, 'packages/mcp-server/src/bridge-cli.ts'), configPath],
}))
