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
// __VALET_DEMO_BUILD__ (demo mode, the fake site and its fixtures) is true for `dev` and for
// `build --mode demo` only, and __VALET_DEV_SERVER__ (trusting the dev server's URL) for `dev`
// only. The fake imports its fixtures as JSON modules, so they are inlined in the demo chunk and no
// folder is copied beside it. __VALET_SMOKE_BUILD__ (the package smoke's own argv and self-check, core/smoke.ts) is
// true for `build --mode smoke` only. __VALET_SHOWCASE_BUILD__ (a packaged app that is always in demo
// mode, core/showcase.ts) is true for `build --mode showcase` only, which is a demo build too. A plain `build`, which packaging uses, has none of them. Only
// a plain build compiles in an update feed, and only when its environment names both
// VALET_UPDATE_URL and VALET_FEED_PUBLIC_KEY_FILE (__VALET_FEED_BASE_URL__,
// __VALET_FEED_PUBLIC_KEY__); with VALET_RELEASE=1 it must (core/feed-defines.ts).
//
//   mise exec -- pnpm --filter @valet/desktop dev     # electron-vite dev
//   mise exec -- pnpm --filter @valet/desktop build   # to out/, without demo mode
//   mise exec -- pnpm --filter @valet/desktop demo    # a demo build, launched against the fake site

import { resolve } from 'node:path'
import tailwind from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import { sandboxPreload } from './sandbox-preload'
import { feedDefines } from './src/main/core/feed-defines'
import { toolLibrary } from './tool-library'
import { contentSecurityPolicy } from './vite.config'

const here = import.meta.dirname

export default defineConfig(({ command, mode }) => {
  const showcase = command === 'build' && mode === 'showcase'
  const plainBuild = command === 'build' && mode !== 'demo' && mode !== 'smoke' && !showcase
  const feed = feedDefines(process.env, plainBuild)
  return {
    main: {
      plugins: [toolLibrary()],
      define: {
        __VALET_DEMO_BUILD__: JSON.stringify(command === 'serve' || mode === 'demo' || showcase),
        __VALET_SHOWCASE_BUILD__: JSON.stringify(showcase),
        __VALET_DEV_SERVER__: JSON.stringify(command === 'serve'),
        __VALET_SMOKE_BUILD__: JSON.stringify(command === 'build' && mode === 'smoke'),
        __VALET_FEED_BASE_URL__: JSON.stringify(feed.url),
        __VALET_FEED_PUBLIC_KEY__: JSON.stringify(feed.publicKey),
      },
      build: {
        outDir: resolve(here, 'out/main'),
        // A demo build's chunk and fixtures must never outlive it into a plain build's out/main.
        emptyOutDir: true,
        externalizeDeps: false,
        rollupOptions: {
          input: {
            index: resolve(here, 'src/main/index.ts'),
            // The tool process: the runtime's worker only, with no adapter in it.
            'tool-process': resolve(here, 'src/main/electron/tool-process-entry.ts'),
          },
          external: ['electron', /^node:/, '@1password/sdk', '@1password/sdk-core'],
          output: { format: 'es', entryFileNames: '[name].js' },
        },
      },
    },
    preload: {
      // The sandbox renderer's preload, beside this one (docs/sandbox.md).
      plugins: [sandboxPreload(resolve(here, 'out/preload'))],
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
      plugins: [react(), tailwind(), contentSecurityPolicy()],
      build: {
        outDir: resolve(here, 'out/renderer'),
        emptyOutDir: true,
        // Fonts stay files: the CSP's font-src is 'self', which refuses data: URLs.
        assetsInlineLimit: 0,
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
