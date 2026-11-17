// What the app gives the Node runtime for a `raw` adapter (docs/node-runtime.md,
// docs/adapter-kinds.md#raw): where the runtime's own Node binary is, and the read and read-write
// paths its sandbox profile allows, from the manifest's `files` exceptions. Pure, so the rules are
// tested without a Mac; app.ts joins them to nodeRuntimeProcess and the egress broker.

import { join } from 'node:path'
import type { AdapterManifest } from '@valet/core'
import { DEFAULT_SANDBOX } from '@valet/core'

/** The runtime's binary in a packaged app, beside the app's own executable (electron-builder.config.ts). */
export const NODE_RUNTIME_EXECUTABLE = 'valet-node'

/**
 * The runtime's Node binary, or null where there is none (raw adapters are then unavailable). A
 * packaged app has it as Contents/MacOS/valet-node. A development build uses the one
 * `node apps/desktop/scripts/node-runtime.mjs` builds, or, in an end-to-end run only, the one the
 * suite names. It is never Electron run as Node (nodeRuntimeProcess refuses that too).
 */
export function nodeRuntimeBinary(input: {
  readonly packaged: boolean
  readonly execPath: string
  readonly appPath: string
  readonly e2e: boolean
  readonly env: Readonly<Record<string, string | undefined>>
  readonly exists: (path: string) => boolean
}): string | null {
  const candidate = input.packaged
    ? join(input.execPath, '..', NODE_RUNTIME_EXECUTABLE)
    : input.e2e && input.env['VALET_E2E_NODE_RUNTIME'] !== undefined
      ? input.env['VALET_E2E_NODE_RUNTIME']
      : join(input.appPath, '.node-runtime', NODE_RUNTIME_EXECUTABLE)
  if (candidate === input.execPath || !candidate.startsWith('/')) return null
  return input.exists(candidate) ? candidate : null
}

/**
 * The folders a raw adapter's profile may read, and read and write, from its `files` exceptions:
 * `~` expanded, and a trailing `/*` or `/**` dropped, so each is the folder itself (the profile
 * allows a folder with everything under it; `/*` is not narrower there). nodeRuntimeProcess resolves
 * each and refuses one that is, or resolves into, a never-grantable place.
 */
export function rawPaths(
  manifest: Pick<AdapterManifest, 'sandbox'>,
  home: string,
): { readonly readPaths: string[]; readonly readWritePaths: string[] } {
  const sandbox = manifest.sandbox ?? DEFAULT_SANDBOX
  const readPaths: string[] = []
  const readWritePaths: string[] = []
  if (sandbox.mode !== 'sandboxed') return { readPaths, readWritePaths }
  for (const exception of sandbox.exceptions) {
    if (exception.kind !== 'files') continue
    for (const pattern of exception.paths) {
      const folder = pattern.replace(/\/\*\*?$/, '')
      const absolute = folder.startsWith('~/') ? join(home, folder.slice(2)) : folder
      ;(exception.access === 'read-write' ? readWritePaths : readPaths).push(absolute)
    }
  }
  return { readPaths, readWritePaths }
}
