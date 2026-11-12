import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      'packages/*',
      'adapters/*',
      'fakes/*',
      'apps/desktop',
      'apps/relay',
      'spikes/01-woolworths-electron',
    ],
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      include: [
        'packages/*/src/**',
        'adapters/*/src/**',
        'fakes/*/src/**',
        'apps/desktop/src/**',
        'apps/relay/src/**',
      ],
      exclude: [
        '**/index.ts',
        '**/*.d.ts',
        'packages/browser-electron/src/electron/**',
        // The desktop app's Electron glue, as above: covered by its smoke test and e2e suite.
        'apps/desktop/src/main/electron/**',
        // The renderer's dev fake is test scaffolding, not shipped code.
        '**/src/renderer/dev/**',
        // The relay's Workers glue (Durable Object classes and bindings): covered by its end-to-end
        // test, which runs them in workerd, out of reach of Node's coverage.
        'apps/relay/src/mac-relay.ts',
        'apps/relay/src/push-relay.ts',
        'apps/relay/src/env.ts',
        '**/*.html',
      ],
      reporter: ['text-summary', 'html', 'json-summary'],
      thresholds: { lines: 90, functions: 90, statements: 90, branches: 85 },
    },
  },
})
