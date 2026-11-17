// Shared by the Node runtime's tests: a tool script built the way a `raw` adapter's is, a minimal
// ToolContext, a plain forwarding stand-in for the egress broker, and fake servers on loopback.

import { createServer, type Server, type Socket } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ToolContext } from '@valet/core'
import { buildToolLibrary, TOOL_LIBRARY_GLOBAL } from '@valet/runtime/tool-script'
import type { OpenTunnels, TunnelSet } from '../src/tunnels'

const here = dirname(fileURLToPath(import.meta.url))

export const mac = process.platform === 'darwin'

let library: Promise<string> | null = null

/** The library prelude and the tool file bundled for Node, as F's raw compile will make them. */
export async function scriptFor(file: string): Promise<string> {
  library ??= buildToolLibrary()
  const { build } = await import('esbuild')
  const result = await build({
    stdin: {
      contents: [
        `export { tools } from ${JSON.stringify(join(here, 'tools', file))}`,
        `export { NeedsUserError, ValetError } from '@valet/core'`,
        `export { toJSONSchema } from 'zod'`,
      ].join('\n'),
      resolveDir: here,
      loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'iife',
    globalName: '__valetTools',
    platform: 'node',
    target: 'node22',
    logLevel: 'silent',
    plugins: [
      {
        name: 'valet-test',
        setup(b) {
          // As Valet's compile does: the two libraries come from the prelude's global.
          b.onResolve({ filter: /^(zod|@valet\/core)$/ }, (args) => ({
            path: args.path === 'zod' ? 'zod' : 'core',
            namespace: 'valet-library',
          }))
          b.onLoad({ filter: /.*/, namespace: 'valet-library' }, (args) => ({
            contents: `module.exports = globalThis.${TOOL_LIBRARY_GLOBAL}.${args.path}`,
            loader: 'js',
          }))
        },
      },
    ],
  })
  const [output] = result.outputFiles
  if (output === undefined) throw new Error('no output')
  return `${await library}\n${output.text}`
}

/** Enough of a ToolContext for runIsolated: no page, and confirm says yes. */
export function context(signal: AbortSignal = new AbortController().signal): ToolContext {
  return {
    signal,
    page: { currentUrl: () => '' },
    confirm: async () => true,
  } as unknown as ToolContext
}

/**
 * A stand-in for the egress broker: a loopback listener per endpoint that forwards to a fixed
 * target (a fake server). No policy at all; the real broker is workstream A's.
 */
export function forwardingTunnels(
  targets: Readonly<Record<string, { readonly host: string; readonly port: number }>>,
): OpenTunnels & { stats: { opened: number; closed: number; connections: string[] } } {
  const state = { opened: 0, closed: 0, connections: [] as string[] }
  const open = async (endpoints: readonly string[]): Promise<TunnelSet> => {
    const servers: Server[] = []
    const sockets = new Set<Socket>()
    const ports = new Map<string, number>()
    for (const endpoint of endpoints) {
      const target = targets[endpoint]
      if (target === undefined) throw new Error(`no target for ${endpoint}`)
      const { connect } = await import('node:net')
      const server = createServer((inbound) => {
        state.connections.push(endpoint)
        sockets.add(inbound)
        const outbound = connect(target.port, target.host)
        sockets.add(outbound)
        inbound.pipe(outbound).pipe(inbound)
        const end = () => {
          inbound.destroy()
          outbound.destroy()
        }
        inbound.on('error', end).on('close', end)
        outbound.on('error', end).on('close', end)
      })
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      servers.push(server)
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('no port')
      ports.set(endpoint, address.port)
    }
    state.opened += 1
    let closed = false
    return {
      ports,
      close: () => {
        if (closed) return
        closed = true
        state.closed += 1
        for (const s of sockets) s.destroy()
        for (const s of servers) s.close()
      },
    }
  }
  return Object.assign(open, { stats: state })
}

/** A plain TCP server on loopback that answers each connection with `reply`, then closes. */
export async function tcpServer(reply: string): Promise<{ port: number; close(): void; received: string[] }> {
  const received: string[] = []
  const server = createServer((socket) => {
    socket.once('data', (data) => {
      received.push(data.toString('utf8'))
      socket.end(reply)
    })
    socket.on('error', () => undefined)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { port: address.port, close: () => server.close(), received }
}
