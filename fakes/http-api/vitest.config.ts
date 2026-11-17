import { defineProject } from 'vitest/config'

export default defineProject({ test: { name: 'fake-http-api', include: ['test/**/*.test.ts'] } })
