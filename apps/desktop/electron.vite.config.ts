// The Electron build: main process, preload and renderer.
//
// - main: ESM, with every workspace package bundled in (they export TypeScript source, which
//   Electron can't load) and their npm dependencies too. Only Electron itself, Node's built-ins and
//   the 1Password SDK stay external; the SDK is loaded lazily, by the service-account provider only,
//   and carries a 14 MB wasm file it reads from beside itself.
// - preload: CommonJS, one file, because a sandboxed preload can't load ES modules or other files.
// - renderer: the same root, pages and CSP as vite.config.ts.
//
//   mise exec -- pnpm --filter @siteadapter/desktop dev     # electron-vite dev
//   mise exec -- pnpm --filter @siteadapter/desktop build   # to out/
//   mise exec -- pnpm --filter @siteadapter/desktop demo    # build, then launch against the fake site

import { cpSync } from 'node:fs'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'
import { contentSecurityPolicy } from './vite.config'

const here = import.meta.dirname

/**
 * Demo mode runs the fake site in-process, and the fake reads its JSON fixtures from
 * `../fixtures/` beside its own module, which in the bundle is a chunk under out/main/chunks.
 */
function fakeSiteFixtures(): Plugin {
  return {
    name: 'siteadapter-fake-fixtures',
    apply: 'build',
    writeBundle() {
      cpSync(resolve(here, '../../fakes/woolworths-site/fixtures'), resolve(here, 'out/main/fixtures'), {
        recursive: true,
        filter: (source) => !source.endsWith('.md'),
      })
    },
  }
}

export default defineConfig({
  main: {
    plugins: [fakeSiteFixtures()],
    build: {
      outDir: resolve(here, 'out/main'),
      externalizeDeps: false,
      rollupOptions: {
        input: { index: resolve(here, 'src/main/index.ts') },
        external: ['electron', /^node:/, '@1password/sdk', '@1password/sdk-core'],
        output: { format: 'es', entryFileNames: '[name].js' },
      },
    },
  },
  preload: {
    build: {
      outDir: resolve(here, 'out/preload'),
      externalizeDeps: false,
      rollupOptions: {
        input: { index: resolve(here, 'src/preload/index.ts') },
        external: ['electron'],
        output: { format: 'cjs', entryFileNames: '[name].cjs', codeSplitting: false },
      },
    },
  },
  renderer: {
    root: resolve(here, 'src/renderer'),
    base: './',
    plugins: [react(), contentSecurityPolicy()],
    build: {
      outDir: resolve(here, 'out/renderer'),
      emptyOutDir: true,
      rollupOptions: {
        input: {
          index: resolve(here, 'src/renderer/index.html'),
          tray: resolve(here, 'src/renderer/tray.html'),
        },
      },
    },
  },
})
