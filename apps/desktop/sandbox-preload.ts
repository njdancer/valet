// A Vite plugin for the preload build: also bundles the sandbox renderer's preload
// (src/sandbox-preload/index.ts) into out/preload/sandbox.cjs, and copies QuickJS's wasm beside it
// as out/preload/quickjs.wasm. It's a second entry, which the
// preload build can't take (a sandboxed preload must be one CommonJS file, so code splitting is off,
// and Rollup allows only one input then), so esbuild builds it beside the first.
//
// The browser build of QuickJS's Emscripten glue is used: the default one requires node:fs, which a
// sandboxed preload doesn't have. The wasm itself comes from the main process (docs/sandbox.md).

import { copyFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import type { Plugin } from 'vite'

const here = import.meta.dirname

export function sandboxPreload(outDir: string): Plugin {
  return {
    name: 'valet-sandbox-preload',
    apply: 'build',
    async closeBundle() {
      const { build } = await import('esbuild')
      const require = createRequire(join(here, '../../packages/sandbox/package.json'))
      const variant = dirname(require.resolve('@jitl/quickjs-ng-wasmfile-release-sync'))
      await build({
        entryPoints: [resolve(here, 'src/sandbox-preload/index.ts')],
        outfile: join(outDir, 'sandbox.cjs'),
        bundle: true,
        format: 'cjs',
        platform: 'browser',
        target: 'chrome140',
        external: ['electron'],
        alias: {
          '@jitl/quickjs-ng-wasmfile-release-sync/emscripten-module': join(
            variant,
            'emscripten-module.browser.mjs',
          ),
        },
        define: { 'import.meta.url': '"about:blank"' },
        legalComments: 'none',
        logLevel: 'warning',
      })
      // The main process reads this and sends it to each sandbox renderer.
      await copyFile(join(variant, 'emscripten-module.wasm'), join(outDir, 'quickjs.wasm'))
    },
  }
}
