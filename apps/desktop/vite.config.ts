// Renderer-only Vite config: `vite` serves the control panel and tray popover in a plain browser
// against the in-memory fake API (src/renderer/dev). The Electron build (electron-vite, later)
// reuses src/renderer as its renderer root.
//
//   mise exec -- pnpm exec vite --config apps/desktop/vite.config.ts
//   then open /index.html (control panel) or /tray.html (tray popover)

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), 'src/renderer')

/**
 * The renderer loads nothing but its own bundle. Built pages get this CSP; the dev server doesn't,
 * because React's refresh preamble is an inline script. Style attributes need 'unsafe-inline'.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

function contentSecurityPolicy(): Plugin {
  return {
    name: 'siteadapter-csp',
    apply: 'build',
    transformIndexHtml: () => [
      {
        tag: 'meta',
        attrs: { 'http-equiv': 'Content-Security-Policy', content: CONTENT_SECURITY_POLICY },
        injectTo: 'head-prepend',
      },
    ],
  }
}

export default defineConfig({
  root,
  base: './',
  plugins: [react(), contentSecurityPolicy()],
  server: { host: '127.0.0.1', port: 5194, strictPort: false },
  build: {
    outDir: resolve(root, '../../out/renderer'),
    emptyOutDir: true,
    rollupOptions: {
      input: { index: resolve(root, 'index.html'), tray: resolve(root, 'tray.html') },
    },
  },
})
