// Build time only: bundles the protocol host (host/protocol-host.ts and the IMAP client it imports)
// into one CommonJS script, so the sandboxed process needs exactly one readable file and imports
// nothing but Node's own modules. Used by the app's build and by tests; esbuild is a dev dependency.

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PROTOCOL_HOST_ENTRY = join(dirname(fileURLToPath(import.meta.url)), 'host', 'protocol-host.ts')

/** The protocol host as one script. */
export async function buildProtocolHost(): Promise<string> {
  const { build } = await import('esbuild')
  const result = await build({
    entryPoints: [PROTOCOL_HOST_ENTRY],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    target: 'node24',
    legalComments: 'none',
    logLevel: 'silent',
    plugins: [
      {
        name: 'valet-protocol-host',
        setup(b) {
          // Only Valet's own files and Node's modules: nothing from node_modules.
          b.onResolve({ filter: /^[^./]/ }, (args) =>
            args.path.startsWith('node:') ? { path: args.path, external: true } : { errors: [{ text: `the protocol host may not import ${args.path}` }] },
          )
        },
      },
    ],
  })
  const [output] = result.outputFiles
  if (output === undefined) throw new Error('the protocol host build produced nothing')
  return output.text
}

/** Writes the bundled host to `path` (made private to this user) and returns the path. */
export async function writeProtocolHost(path: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, await buildProtocolHost(), { mode: 0o600 })
  return path
}
