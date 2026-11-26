import { defineProject } from 'vitest/config'

export default defineProject({ test: { name: 'iphone', include: ['test/**/*.test.ts'] } })
