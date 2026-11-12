// The fixture browser over real Electron (docs/authoring-tools.md#the-agents-cases): a case's pages
// from memory, read with the runtime's own tool page, their scripts never run, nothing sent.

import { type ElectronApplication, expect, test } from '@playwright/test'
import { launchHarness, scenario } from './launch'

let app: ElectronApplication

test.beforeAll(async () => {
  app = await launchHarness()
})

test.afterAll(async () => {
  await app?.close()
})

test('serves a case’s pages from memory, runs none of their script, and sends nothing', async () => {
  const result = await scenario(app, 'fixture')
  expect(result.price).toBe('1.50')
  // The fixture's own script didn't run.
  expect(result.ran).toBeNull()
  // A link between two fixture pages works.
  expect(result.nextPrice).toBe('2.00')
  // A page the case doesn't have loads as a 404 from memory, not from the site.
  expect(result.missing).toBe('loaded')
  expect(result.sent).toBe(0)
  expect(result.evil).toBe(0)
})
