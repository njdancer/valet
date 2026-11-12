import { defineProject } from 'vitest/config'

export default defineProject({ test: { name: 'adapter-store', include: ['test/**/*.test.ts'] } })
