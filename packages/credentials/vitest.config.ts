import { defineProject } from 'vitest/config'

export default defineProject({ test: { name: 'credentials', include: ['test/**/*.test.ts'] } })
