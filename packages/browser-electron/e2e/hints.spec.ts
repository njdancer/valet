// Resource hints without the process hardening. If Electron starts acting on dns-prefetch or
// preconnect hints, this fails, and the test in driver.spec.ts starts meaning something.

import { type ElectronApplication, expect, test } from '@playwright/test'
import { launchHarness, scenario } from './launch'

let app: ElectronApplication

test.beforeAll(async () => {
  app = await launchHarness({ E2E_NO_HARDENING: '1' })
})

test.afterAll(async () => {
  await app?.close()
})

test('without hardening, Electron still opens no connection for resource hints', async () => {
  const result = await scenario(app, 'hints')
  expect(result.evilConnections).toEqual([])
})
