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

/** Closes the control panel as its close button does, through the window rather than the page. */
async function closeControl(): Promise<void> {
  await launched.app.evaluate(({ BrowserWindow }, title) => {
    for (const w of BrowserWindow.getAllWindows()) if (w.getTitle().includes(title)) w.close()
  }, CONTROL)
  await expect
    .poll(() =>
      launched.app.evaluate(
        ({ BrowserWindow }, title) => BrowserWindow.getAllWindows().some((w) => w.getTitle().includes(title)),
        CONTROL,
      ),
    )
    .toBe(false)
}

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

test('the control panel has a Dock icon while it is open, and the app has its own menu', async () => {
  const state = () =>
    launched.app.evaluate(({ app, Menu }) => ({
      dock: app.dock?.isVisible() ?? null,
      menus: Menu.getApplicationMenu()?.items.map((item) => item.label) ?? [],
    }))
  const open = await state()
  expect(open.dock).toBe(true)
  expect(open.menus).toEqual([expect.stringMatching(/./), 'Edit', 'View', 'Window'])
  await closeControl()
  await expect.poll(async () => (await state()).dock).toBe(false)
  await launched.app.evaluate(() => {
    const hook = (globalThis as { __valetE2eWindows?: { openControlPanel: (h: string) => void } })
      .__valetE2eWindows
    hook?.openControlPanel('#/sites')
  })
  control = await windowWithTitle(launched.app, CONTROL)
  await expect.poll(async () => (await state()).dock).toBe(true)
})

test('the control panel comes back to the front after a Touch ID prompt', async () => {
  // Valet in front, the person working in the control panel.
  await activateFinder()
  await openFromBackground(control, '#/sites')
  await expect.poll(focusedTitle, { timeout: 10_000 }).toContain(CONTROL)
  await control.evaluate(() => window.valet?.app.setLockedDown(true))
  // Unlocking asks for the person at the Mac: a signed decision, Touch ID in a packaged app. Here
  // Finder comes to the front while the "prompt" is up, as the prompt's own window does, and
  // macOS doesn't hand the front back to Valet when it closes.
  await launched.app.evaluate(() => {
    ;(
      globalThis as { __valetE2ePrompt?: { stealFocus: (on: boolean) => void } }
    ).__valetE2ePrompt?.stealFocus(true)
  })
  try {
    await control.evaluate(() => window.valet?.app.setLockedDown(false))
  } finally {
    await launched.app.evaluate(() => {
      ;(
        globalThis as { __valetE2ePrompt?: { stealFocus: (on: boolean) => void } }
      ).__valetE2ePrompt?.stealFocus(false)
    })
  }
  await expect.poll(focusedTitle, { timeout: 10_000 }).toContain(CONTROL)
})
