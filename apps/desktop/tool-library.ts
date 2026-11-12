// A Vite plugin for the main build (and the desktop tests): `virtual:valet-tool-library` is the
// library prelude (zod and core's tool-code subset), bundled at build time by buildToolLibrary in
// packages/runtime/src/isolation/tool-script.ts. The tool process evaluates it before every
// adapter's script, which Valet compiles itself from the adapter's package at run time
// (docs/adapter-packages.md).

import type { Plugin } from 'vite'
import { buildToolLibrary } from '../../packages/runtime/src/isolation/tool-script'

const ID = 'virtual:valet-tool-library'
const RESOLVED = `\0${ID}`

export function toolLibrary(): Plugin {
  return {
    name: 'valet-tool-library',
    resolveId: (source) => (source === ID ? RESOLVED : undefined),
    async load(id) {
      if (id !== RESOLVED) return undefined
      return `export default ${JSON.stringify(await buildToolLibrary())}`
    },
  }
}
