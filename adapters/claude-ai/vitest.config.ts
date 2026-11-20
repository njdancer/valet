import { defineProject } from 'vitest/config'

export default defineProject({ test: { name: 'adapter-claude-ai', include: ['test/**/*.test.ts'] } })
