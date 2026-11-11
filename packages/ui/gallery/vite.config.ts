// The component gallery: every token, component and motion in one page, with theme, platform and
// reduced-motion switches. `pnpm --filter @valet/ui gallery` serves it; gallery:build writes dist/.
import { resolve } from 'node:path'
import tailwind from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  root: import.meta.dirname,
  base: './',
  plugins: [react(), tailwind()],
  server: { host: '127.0.0.1', port: 5199 },
  build: { outDir: resolve(import.meta.dirname, '../dist/gallery'), emptyOutDir: true, assetsInlineLimit: 0 },
})
