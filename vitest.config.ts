import { defineConfig } from 'vitest/config'

// CI's check job runs the unit suite on Linux without the updater's test files, which need macOS's
// ditto (.github/workflows/ci.yml; they run on macOS in the e2e job). With them goes the code only
// they cover, so the thresholds below hold the rest of the code to the same bar.
const withoutMacosOnly = process.env['VALET_COVERAGE_WITHOUT_MACOS_ONLY'] === '1'

export default defineConfig({
  test: {
    projects: [
      'packages/*',
      'adapters/*',
      'fakes/*',
      'apps/desktop',
      'apps/relay',
      'apps/blind-relay',
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
        'apps/blind-relay/src/**',
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
        // The Node runtime's host script runs only inside the sandboxed child process, out of reach
        // of this process's coverage; test/runtime.test.ts and test/redteam drive every part of it.
        'packages/node-runtime/src/host/**',
        // The protocol host, likewise: it runs only in its sandboxed child process, and
        // test/host.e2e.test.ts and test/mail-reader.e2e.test.ts drive it; the client and operations
        // it runs are covered directly.
        'packages/protocols/src/host/**',
        // The hub's Durable Object and the glue that reaches it (docs/relay-hub.md): covered by
        // test/hub.test.ts, which runs them in workerd, as above.
        'apps/relay/src/hub/hub.ts',
        'apps/relay/src/hub/link.ts',
        // The blind relay's entry point: environment and process wiring, run by its deploy's health
        // check; the relay and the certificate manager it starts are covered directly.
        'apps/blind-relay/src/main.ts',
        '**/*.html',
        ...(withoutMacosOnly ? ['apps/desktop/src/main/updater/**'] : []),
      ],
      reporter: ['text-summary', 'html', 'json-summary'],
      thresholds: { lines: 90, functions: 90, statements: 90, branches: 85 },
    },
  },
})
