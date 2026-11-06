import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: ['packages/*', 'adapters/*', 'fakes/*'],
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**', 'adapters/*/src/**', 'fakes/*/src/**'],
      exclude: ['**/index.ts', '**/*.d.ts'],
      reporter: ['text-summary', 'html', 'json-summary'],
      thresholds: { lines: 90, functions: 90, statements: 90, branches: 85 },
    },
  },
})
