import { defineProject } from 'vitest/config'

export default defineProject({ test: { name: 'fake-sftp', include: ['test/**/*.test.ts'] } })
