import { defineProject } from 'vitest/config'

export default defineProject({ test: { name: 'native-calendar', include: ['test/**/*.test.ts'] } })
