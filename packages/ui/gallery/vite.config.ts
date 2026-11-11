// The component gallery: every token, component and motion in one page, with theme, platform and
// reduced-motion switches. `pnpm --filter @valet/ui gallery` serves it; gallery:build writes dist/.
import { resolve } from 'node:path'
import tailwind from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

// The same Content-Security-Policy as the app's renderer (apps/desktop/vite.config.ts), so the gallery
// proves every component works under it: no inline scripts, no injected <style> tags.
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

function csp(): Plugin {
  return {
    name: 'gallery-csp',
    apply: 'build',
    transformIndexHtml: () => [
      {
        tag: 'meta',
        attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP },
        injectTo: 'head-prepend',
      },
    ],
  }
}

export default defineConfig({
  root: import.meta.dirname,
  base: './',
  plugins: [react(), tailwind(), csp()],
  server: { host: '127.0.0.1', port: 5199 },
  build: { outDir: resolve(import.meta.dirname, '../dist/gallery'), emptyOutDir: true, assetsInlineLimit: 0 },
})
