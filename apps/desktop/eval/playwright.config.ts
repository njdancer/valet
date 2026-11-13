// The authoring evals (eval/README.md): one file that holds the app open while a model drives it.
// Never part of the e2e suite or CI.

import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  testMatch: '*.eval.ts',
  timeout: 0,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: '../out/eval-results',
})
