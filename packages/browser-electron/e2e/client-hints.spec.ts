// The client-hint override (D24a, off by default): with clientHints 'chrome', every page's
// navigator.userAgentData names Google Chrome, as Nick's Chrome does. driver.spec.ts checks the
// default restates the engine's own.

import { type ElectronApplication, expect, test } from '@playwright/test'
import { launchHarness, scenario } from './launch'

let app: ElectronApplication

test.beforeAll(async () => {
  app = await launchHarness({ E2E_CLIENT_HINTS: '1' })
})

test.afterAll(async () => {
  await app?.close()
})

test('with the override on, both partitions’ client hints name Google Chrome, and the UA stays clean', async () => {
  const result = await scenario(app, 'userAgent')
  const major = (result.chrome as string).split('.')[0]
  for (const sees of [result.toolPageSees, result.authPageSees] as {
    ua: string
    language: string
    brands: string[]
  }[]) {
    expect(sees.ua).toContain(`Chrome/${major}.0.0.0 Safari/537.36`)
    expect(sees.language).toBe('en-AU')
    expect(sees.brands).toEqual(expect.arrayContaining(['Google Chrome', 'Chromium']))
  }
  const seen = result.seen as { acceptLanguage: string; clientHintBrands: string }[]
  expect(seen.length).toBeGreaterThanOrEqual(2)
  for (const request of seen) {
    expect(request.acceptLanguage).toBe('en-AU,en;q=0.9')
    // Electron sends no Sec-CH-UA header even with the override: the brands reach only scripts.
    expect(request.clientHintBrands).toBe('')
  }
})
