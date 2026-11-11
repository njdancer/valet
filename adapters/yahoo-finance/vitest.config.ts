import { defineProject } from 'vitest/config'

export default defineProject({ test: { name: 'adapter-yahoo-finance', include: ['test/**/*.test.ts'] } })
