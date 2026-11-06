import react from '@vitejs/plugin-react'
import { defineProject } from 'vitest/config'

// Renderer, shared-contract, main-process and preload tests. The renderer's run in jsdom; the main
// process's (test/main) say `@vitest-environment node` at the top, so they run in plain Node.
export default defineProject({
  plugins: [react()],
  test: {
    name: 'desktop',
    environment: 'jsdom',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    setupFiles: ['test/setup.ts'],
    // Times render in the person's zone; tests pin one so the wording is stable.
    env: { TZ: 'Australia/Sydney' },
  },
})
