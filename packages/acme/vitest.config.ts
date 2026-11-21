import { defineProject } from 'vitest/config'

export default defineProject({ test: { name: 'acme', include: ['test/**/*.test.ts'], testTimeout: 30_000 } })
