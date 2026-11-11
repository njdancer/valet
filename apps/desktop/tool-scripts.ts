// A Vite plugin for the main build (and the desktop tests): `virtual:valet-tool-scripts` is each
// built-in adapter's tool script, keyed by adapter id, bundled at build time from the same sources
// the main bundle compiles the adapter from (packages/runtime/src/isolation/tool-script.ts). The
// app hands it to the tool process, which is all that process ever runs (overnight queue item 7).

import { resolve } from 'node:path'
import type { Plugin } from 'vite'
import { buildToolScript } from '../../packages/runtime/src/isolation/tool-script'

const ID = 'virtual:valet-tool-scripts'
const RESOLVED = `\0${ID}`
const ENTRIES: Readonly<Record<string, string>> = {
  woolworths: resolve(import.meta.dirname, '../../adapters/woolworths/src/tools.ts'),
  wikipedia: resolve(import.meta.dirname, '../../adapters/wikipedia/src/tools.ts'),
  'yahoo-finance': resolve(import.meta.dirname, '../../adapters/yahoo-finance/src/tools.ts'),
}

export function toolScripts(): Plugin {
  return {
    name: 'valet-tool-scripts',
    resolveId: (source) => (source === ID ? RESOLVED : undefined),
    async load(id) {
      if (id !== RESOLVED) return undefined
      const scripts: Record<string, string> = {}
      for (const [adapterId, entry] of Object.entries(ENTRIES))
        scripts[adapterId] = await buildToolScript(entry)
      return `export default ${JSON.stringify(scripts)}`
    },
  }
}
