import { defineProject } from 'vitest/config'

export default defineProject({ test: { name: 'auth-flow', include: ['test/**/*.test.ts'] } })
