// The same cross-origin iframe login with site isolation switched off for the whole app. With it
// on, sendInputEvent can't reach an out-of-process frame and the driver refuses (driver.spec.ts).
// This file shows what switching it off buys, as input to that decision; it is not the default.

import { type ElectronApplication, expect, test } from '@playwright/test'
import { launchHarness, scenario } from './launch'

let app: ElectronApplication

test.beforeAll(async () => {
  app = await launchHarness({ E2E_NO_SITE_ISOLATION: '1' })
})

test.afterAll(async () => {
  await app?.close()
})

test('without site isolation, a secret typed into a cross-origin iframe reaches only that form', async () => {
  expect(await scenario(app, 'info')).toMatchObject({ siteIsolation: false })
  const result = await scenario(app, 'typeSecretInCrossOriginFrame')
  // A settled outcome with no value: { ok: undefined } arrives as {}.
  expect(result.focus).toEqual({})
  expect(result.typed).toEqual({})
  expect(result.valueLength).toBe(15)
  expect(result.post).toMatchObject({
    host: 'login.test',
    path: '/session',
    body: 'password=canary-Pw9%21x+%22q&untrusted=0',
  })
  expect(result.leaks).toEqual([])
})
