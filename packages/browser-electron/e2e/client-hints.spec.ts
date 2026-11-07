// The client-hint brands (D24a). The default names Google Chrome, which driver.spec.ts checks; this
// file runs the harness with clientHints 'engine', which must restate the engine's own hints exactly.

import { type ElectronApplication, expect, test } from '@playwright/test'
import { launchHarness, scenario } from './launch'

let app: ElectronApplication

test.beforeAll(async () => {
  app = await launchHarness({ E2E_CLIENT_HINTS: 'engine' })
})

test.afterAll(async () => {
  await app?.close()
})

test('with engine brands, both partitions’ client hints are the engine’s own, and the UA stays clean', async () => {
  const result = await scenario(app, 'userAgent')
  const major = (result.chrome as string).split('.')[0]
  type Sees = { ua: string; language: string; brands: string[]; hints: unknown }
  const engine = result.engineSees as Sees
  // The control window really has no override from the driver, or the comparison below is vacuous.
  expect(engine.ua).toBe(result.controlUa)
  for (const sees of [result.toolPageSees, result.authPageSees] as Sees[]) {
    expect(sees.ua).toContain(`Chrome/${major}.0.0.0 Safari/537.36`)
    expect(sees.language).toBe('en-AU')
    expect(sees.brands).toEqual(engine.brands)
    expect(sees.brands).not.toContain('Google Chrome')
    expect(sees.hints).toEqual(engine.hints)
  }
  const seen = result.seen as { acceptLanguage: string; clientHintBrands: string }[]
  expect(seen.length).toBeGreaterThanOrEqual(2)
  for (const request of seen) {
    expect(request.acceptLanguage).toBe('en-AU,en;q=0.9')
    // Electron sends no Sec-CH-UA header with or without the override: the brands reach only scripts.
    expect(request.clientHintBrands).toBe('')
  }
})
