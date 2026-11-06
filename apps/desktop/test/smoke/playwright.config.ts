// The smoke test: the built app (out/), launched in demo mode with Playwright's _electron. Needs a
// GUI session and openssl, so it isn't part of `pnpm check`:
//
//   mise exec -- pnpm --filter @siteadapter/desktop test:smoke

import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  timeout: 90_000,
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  // Under out/, which git and Biome both ignore.
  outputDir: '../../out/smoke-results',
})
