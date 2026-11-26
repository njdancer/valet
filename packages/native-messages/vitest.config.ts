import { defineProject } from 'vitest/config'

export default defineProject({ test: { name: 'native-messages', include: ['test/**/*.test.ts'] } })
