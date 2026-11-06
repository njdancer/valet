import react from '@vitejs/plugin-react'
import { defineProject } from 'vitest/config'

// Renderer and shared-contract tests. The main process and preload (later) get their own project
// in plain Node.
export default defineProject({
  plugins: [react()],
  test: {
    name: 'desktop',
    environment: 'jsdom',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    // Times render in the person's zone; tests pin one so the wording is stable.
    env: { TZ: 'Australia/Sydney' },
  },
})
