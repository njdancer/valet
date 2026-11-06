import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: ['packages/*', 'adapters/*', 'fakes/*', 'apps/desktop'],
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**', 'adapters/*/src/**', 'fakes/*/src/**', 'apps/desktop/src/**'],
      exclude: [
        '**/index.ts',
        '**/*.d.ts',
        'packages/browser-electron/src/electron/**',
        // The desktop app's Electron glue, as above: covered by its smoke test and e2e suite.
        'apps/desktop/src/main/electron/**',
        // The renderer's dev fake is test scaffolding, not shipped code.
        '**/src/renderer/dev/**',
        '**/*.html',
      ],
      reporter: ['text-summary', 'html', 'json-summary'],
      thresholds: { lines: 90, functions: 90, statements: 90, branches: 85 },
    },
  },
})
