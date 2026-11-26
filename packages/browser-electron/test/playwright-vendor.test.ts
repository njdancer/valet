// The vendored copy of Playwright's in-page script matches the pinned playwright-core, patched with
// Valet's hooks. After bumping playwright-core, run scripts/vendor-playwright.mjs.

import { describe, expect, it } from 'vitest'
import { extractInjectedScript, render } from '../scripts/vendor-playwright.mjs'
import { INJECTED_SHA256, INJECTED_SOURCE, PLAYWRIGHT_VERSION } from '../src/generated/playwright-injected'

describe('vendored Playwright', () => {
  it('is what scripts/vendor-playwright.mjs makes from the installed playwright-core', () => {
    const fresh = extractInjectedScript()
    expect(PLAYWRIGHT_VERSION).toBe(fresh.version)
    expect(INJECTED_SHA256).toBe(fresh.sha256)
    expect(INJECTED_SOURCE === fresh.source).toBe(true)
    expect(render(fresh).length).toBeGreaterThan(INJECTED_SOURCE.length)
  })
})
