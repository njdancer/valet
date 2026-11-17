import { defineProject } from 'vitest/config'

export default defineProject({ test: { name: 'fake-example-services', include: ['test/**/*.test.ts'] } })
