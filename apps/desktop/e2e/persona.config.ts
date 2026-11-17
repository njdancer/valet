// Scratch config for persona QA runs: same as playwright.config.ts but without the global teardown
// (which kills every Electron of this worktree) so several personas can run side by side.
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  testMatch: 'persona-*.spec.ts',
  timeout: 600_000,
  expect: { timeout: 20_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  outputDir: `/tmp/persona-results/${process.env['PERSONA'] ?? 'default'}`,
})
