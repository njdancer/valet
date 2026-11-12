// Build time only: bundles an adapter's tool implementations into the script the isolated tool
// process evaluates (worker.ts). The script is an IIFE that defines `__valetTools` and imports
// nothing at run time. `@valet/core` resolves to its tool-code entry, and any Node built-in or
// Electron import fails the build, so tool code that reaches for `fs`, `child_process` or
// `electron` doesn't build rather than finding them missing at run time.
//
// Used by the app's build (apps/desktop/electron.vite.config.ts) and by tests. Not part of the
// runtime the app ships: esbuild is a dev dependency.

import { builtinModules } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CORE_TOOL_CODE = join(dirname(fileURLToPath(import.meta.url)), '../../../core/src/tool-code.ts')
const BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)])

/**
 * Bundles `entry`, a module exporting `tools` (a record of ToolImplementations), into one script.
 * Throws if it, or anything it imports, needs a Node built-in or Electron.
 */
export async function buildToolScript(entry: string): Promise<string> {
  const { build } = await import('esbuild')
  const result = await build({
    stdin: {
      contents: [
        `export { tools } from ${JSON.stringify(entry)}`,
        `export { NeedsUserError, ValetError } from '@valet/core'`,
        `export { toJSONSchema } from 'zod'`,
      ].join('\n'),
      resolveDir: dirname(entry),
      loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'iife',
    globalName: '__valetTools',
    platform: 'neutral',
    target: 'es2023',
    mainFields: ['module', 'main'],
    conditions: ['import', 'default'],
    legalComments: 'none',
    logLevel: 'silent',
    plugins: [
      {
        name: 'valet-tool-code',
        setup(b) {
          b.onResolve({ filter: /^@valet\/core$/ }, () => ({ path: CORE_TOOL_CODE }))
          b.onResolve({ filter: /.*/ }, (args) => {
            if (args.path === 'electron' || BUILTINS.has(args.path)) {
              return { errors: [{ text: `tool code may not import ${args.path}` }] }
            }
            return undefined
          })
        },
      },
    ],
  })
  const [output] = result.outputFiles
  if (output === undefined) throw new Error('the tool script build produced nothing')
  return output.text
}

/** The global the library prelude defines: `{ zod, core }`. */
export const TOOL_LIBRARY_GLOBAL = '__valetLib'

/**
 * Bundles the two libraries tool code may import, zod and core's tool-code subset, into the prelude
 * the tool process evaluates before an adapter's script (docs/adapter-packages.md). An adapter
 * compiled by Valet (packages/adapter-store) imports them from this global instead of carrying its
 * own copies, so its script, like its hash, is only its own code. Built with the app.
 */
export async function buildToolLibrary(): Promise<string> {
  const { build } = await import('esbuild')
  const result = await build({
    stdin: {
      contents: [
        `export * as zod from 'zod'`,
        `export * as core from ${JSON.stringify(CORE_TOOL_CODE)}`,
      ].join('\n'),
      resolveDir: dirname(CORE_TOOL_CODE),
      loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'iife',
    globalName: TOOL_LIBRARY_GLOBAL,
    platform: 'neutral',
    target: 'es2023',
    mainFields: ['module', 'main'],
    conditions: ['import', 'default'],
    legalComments: 'none',
    logLevel: 'silent',
  })
  const [output] = result.outputFiles
  if (output === undefined) throw new Error('the tool library build produced nothing')
  return output.text
}
