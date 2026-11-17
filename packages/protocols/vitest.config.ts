import { defineProject } from 'vitest/config'

export default defineProject({ test: { name: 'protocols', include: ['test/**/*.test.ts'] } })
