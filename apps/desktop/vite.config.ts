// Renderer-only Vite config: `vite` serves the control panel and tray popover in a plain browser
// against the in-memory fake API (src/renderer/dev). The Electron build (electron-vite, later)
// reuses src/renderer as its renderer root.
//
//   mise exec -- pnpm --filter @valet/desktop exec vite
//   then open /index.html (control panel) or /tray.html (tray popover)

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import tailwind from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), 'src/renderer')

/**
 * The renderer loads nothing but its own bundle. Built pages get this CSP; the dev server doesn't,
 * because React's refresh preamble is an inline script. No 'unsafe-inline' for styles: the built CSS
 * is a linked stylesheet, and React sets `style` props through the CSSOM, which CSP doesn't block.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

export function contentSecurityPolicy(): Plugin {
  return {
    name: 'valet-csp',
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
  plugins: [react(), tailwind(), contentSecurityPolicy()],
  server: { host: '127.0.0.1', port: 5194, strictPort: false },
  build: {
    outDir: resolve(root, '../../out/renderer'),
    emptyOutDir: true,
    // Fonts stay files: the CSP's font-src is 'self', which refuses data: URLs.
    assetsInlineLimit: 0,
    rollupOptions: {
      input: { index: resolve(root, 'index.html'), tray: resolve(root, 'tray.html') },
    },
  },
})
