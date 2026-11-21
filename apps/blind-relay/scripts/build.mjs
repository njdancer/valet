// Bundles the relay into one file for its container: dist/main.js, Node built-ins left external.

import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('..', import.meta.url))

await build({
  entryPoints: [`${root}src/main.ts`],
  outfile: `${root}dist/main.js`,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  // ws's optional native helpers; it falls back to JavaScript without them.
  external: ['bufferutil', 'utf-8-validate'],
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  logLevel: 'warning',
})
