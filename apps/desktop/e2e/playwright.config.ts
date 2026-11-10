// The end-to-end suite: the built app (out/), launched in demo mode with Playwright's _electron,
// driven through its real windows where the person acts and through a real MCP client where an agent
// does. Needs a GUI session and openssl, so it isn't part of `pnpm check`:
//
//   mise exec -- pnpm --filter @valet/desktop test:e2e
//
// Each spec file launches its own app with its own temporary userData, one at a time: the app takes
// a single-instance lock and the endpoint keeps its port in userData.

import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  // A login on the fake takes about 15 s (the adapter's settle pauses), and the breaker test waits
  // for the site's own block. The site's pacing is real here: at most four requests a minute
  // (D28), so a login and the call after it can take three to four minutes between them.
  timeout: 300_000,
  expect: { timeout: 20_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  globalTeardown: './teardown.ts',
  // Under out/, which git and Biome both ignore.
  outputDir: '../out/e2e-results',
})
