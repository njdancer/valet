import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  timeout: 60_000,
  // One Electron app per file, shared by its tests; files run one at a time.
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  // Under out/, which git and Biome both ignore.
  outputDir: '../out/e2e-results',
})
