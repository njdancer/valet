import { defineProject } from 'vitest/config'

// The sandbox tests spawn real Node processes, some under Seatbelt, so they get more time.
export default defineProject({
  test: { name: 'node-runtime', include: ['test/**/*.test.ts'], testTimeout: 30_000, hookTimeout: 30_000 },
})
