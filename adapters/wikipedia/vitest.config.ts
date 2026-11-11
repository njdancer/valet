import { defineProject } from 'vitest/config'

export default defineProject({ test: { name: 'adapter-wikipedia', include: ['test/**/*.test.ts'] } })
