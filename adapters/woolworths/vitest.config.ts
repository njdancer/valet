import { defineProject } from 'vitest/config'

export default defineProject({ test: { name: 'adapter-woolworths', include: ['test/**/*.test.ts'] } })
