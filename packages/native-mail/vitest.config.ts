import { defineProject } from 'vitest/config'

export default defineProject({ test: { name: 'native-mail', include: ['test/**/*.test.ts'] } })
