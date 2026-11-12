import { defineProject } from 'vitest/config'

export default defineProject({ test: { name: 'sandbox', include: ['test/**/*.test.ts'] } })
