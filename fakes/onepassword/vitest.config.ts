import { defineProject } from 'vitest/config'

export default defineProject({ test: { name: 'fake-onepassword', include: ['test/**/*.test.ts'] } })
