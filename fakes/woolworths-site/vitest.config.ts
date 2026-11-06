import { defineProject } from 'vitest/config'

export default defineProject({ test: { name: 'fake-woolworths-site', include: ['test/**/*.test.ts'] } })
