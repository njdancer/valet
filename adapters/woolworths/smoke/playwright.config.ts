import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  // The live run paces its three reads 10 s apart, after letting the home page settle.
  timeout: 120_000,
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  // Under out/, which git and Biome both ignore.
  outputDir: '../out/smoke-results',
})
