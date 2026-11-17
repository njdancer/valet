import { defineProject } from 'vitest/config'

export default defineProject({ test: { name: 'fake-imap', include: ['test/**/*.test.ts'] } })
