// The control panel comes to the front when Valet opens it while another app is in use: a
// connection waiting for its code, a notification's click, a tool result's link. Valet is a
// menu-bar app with no Dock icon, so a window shown without making the app active lands behind
// whatever the person is using, with no Dock icon or ⌘-Tab entry to find it by.
//
// macOS only: another app (Finder) is made frontmost with osascript, and the check is whether the
// control panel is then the key window, which it can only be while Valet is the active app.

import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { expect, type Page, test } from '@playwright/test'
import { CONTROL, type Launched, launch, sleep, tempDir, windowWithTitle } from './harness'

test.describe.configure({ mode: 'serial' })
test.skip(process.platform !== 'darwin', 'needs macOS to switch the frontmost app')

let userData: string
let launched: Launched
let control: Page

test.beforeAll(async () => {
  userData = tempDir('front')
  launched = await launch(userData)
  control = await windowWithTitle(launched.app, CONTROL)
})

test.afterAll(async () => {
  await launched?.close()
  rmSync(userData, { recursive: true, force: true })
})

/** Makes Finder the frontmost app, and waits until Valet has no key window. */
async function activateFinder(): Promise<void> {
  execFileSync('osascript', ['-e', 'tell application "Finder" to activate'])
  await expect.poll(focusedTitle, { timeout: 10_000 }).toBe(null)
}

/** The title of Valet's key window, or null while Valet isn't the active app. */
async function focusedTitle(): Promise<string | null> {
  return launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.getTitle() ?? null)
}

/**
 * Asks the main process to open the control panel, from a page that isn't focused, as a
 * notification click or a waiting connection does: nothing the person clicked in Valet.
 */
async function openFromBackground(page: Page, hash: string): Promise<void> {
  await page.evaluate((h) => window.valet?.app.openControlPanel(h as `#/${string}`), hash)
}

test('an open control panel comes to the front over another app', async () => {
  await activateFinder()
  await openFromBackground(control, '#/connections')
  await expect.poll(focusedTitle, { timeout: 10_000 }).toContain(CONTROL)
  await expect(control).toHaveURL(/#\/connections$/)
})

test('a control panel opened afresh comes to the front over another app', async () => {
  // Closed, there's no page of ours to ask from, so ask through the main process, the way a
  // notification's click does.
  await control.close()
  await activateFinder()
  await launched.app.evaluate(() => {
    const hook = (globalThis as { __valetE2eWindows?: { openControlPanel: (h: string) => void } })
      .__valetE2eWindows
    if (hook === undefined) throw new Error('no e2e windows hook: not in e2e mode')
    hook.openControlPanel('#/needs-you')
  })
  control = await windowWithTitle(launched.app, CONTROL)
  await expect.poll(focusedTitle, { timeout: 10_000 }).toContain(CONTROL)
  await sleep(200)
})
