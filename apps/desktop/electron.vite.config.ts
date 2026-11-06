// The Electron build: main process, preload and renderer.
//
// - main: ESM, with every workspace package bundled in (they export TypeScript source, which
//   Electron can't load) and their npm dependencies too. Only Electron itself, Node's built-ins and
//   the 1Password SDK stay external; the SDK is loaded lazily, by the service-account provider only,
//   and carries a 14 MB wasm file it reads from beside itself.
// - preload: CommonJS, one file, because a sandboxed preload can't load ES modules or other files.
// - renderer: the same root, pages and CSP as vite.config.ts.
//
// Build-time constants (src/main/build-flags.d.ts) decide what the main bundle carries:
// __SITEADAPTER_DEMO_BUILD__ (demo mode, the fake site and its fixtures) is true for `dev` and for
// `build --mode demo` only, and __SITEADAPTER_DEV_SERVER__ (trusting the dev server's URL) for `dev`
// only. The fake imports its fixtures as JSON modules, so they are inlined in the demo chunk and no
// folder is copied beside it. __SITEADAPTER_SMOKE_BUILD__ (the package smoke's own argv and self-check, core/smoke.ts) is
// true for `build --mode smoke` only. A plain `build`, which packaging uses, has none of them. Only
// a plain build compiles in an update feed, and only when its environment names both
// SITEADAPTER_UPDATE_URL and SITEADAPTER_FEED_PUBLIC_KEY_FILE (__SITEADAPTER_FEED_BASE_URL__,
// __SITEADAPTER_FEED_PUBLIC_KEY__); with SITEADAPTER_RELEASE=1 it must (core/feed-defines.ts).
//
//   mise exec -- pnpm --filter @siteadapter/desktop dev     # electron-vite dev
//   mise exec -- pnpm --filter @siteadapter/desktop build   # to out/, without demo mode
//   mise exec -- pnpm --filter @siteadapter/desktop demo    # a demo build, launched against the fake site

import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import { feedDefines } from './src/main/core/feed-defines'
import { contentSecurityPolicy } from './vite.config'

const here = import.meta.dirname

export default defineConfig(({ command, mode }) => {
  const plainBuild = command === 'build' && mode !== 'demo' && mode !== 'smoke'
  const feed = feedDefines(process.env, plainBuild)
  return {
    main: {
      define: {
        __SITEADAPTER_DEMO_BUILD__: JSON.stringify(command === 'serve' || mode === 'demo'),
        __SITEADAPTER_DEV_SERVER__: JSON.stringify(command === 'serve'),
        __SITEADAPTER_SMOKE_BUILD__: JSON.stringify(command === 'build' && mode === 'smoke'),
        __SITEADAPTER_FEED_BASE_URL__: JSON.stringify(feed.url),
        __SITEADAPTER_FEED_PUBLIC_KEY__: JSON.stringify(feed.publicKey),
      },
      build: {
        outDir: resolve(here, 'out/main'),
        // A demo build's chunk and fixtures must never outlive it into a plain build's out/main.
        emptyOutDir: true,
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
        emptyOutDir: true,
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
  }
})
