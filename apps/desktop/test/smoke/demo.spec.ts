// Launches the built app in demo mode with a fresh userData and checks the first screen: the
// Woolworths adapter waiting for review, the DEMO badge, the strict window settings, and a refusal
// for an IPC request the renderer isn't allowed to make.

import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron, type ElectronApplication, expect, type Page, test } from '@playwright/test'

const require = createRequire(import.meta.url)
const electronPath = require('electron') as unknown as string
const appDir = join(import.meta.dirname, '../..')

let app: ElectronApplication
let userData: string

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), 'valet-smoke-'))
  app = await _electron.launch({
    executablePath: electronPath,
    args: [appDir],
    env: {
      ...process.env,
      VALET_DEMO: '1',
      VALET_E2E: '1',
      VALET_USER_DATA: userData,
    } as Record<string, string>,
  })
})

test.afterAll(async () => {
  await app?.close()
  rmSync(userData, { recursive: true, force: true })
})

async function controlPanel(): Promise<Page> {
  for (let i = 0; i < 100; i++) {
    for (const page of app.windows()) {
      if ((await page.title().catch(() => '')).includes('[control]')) return page
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('the control panel never opened')
}

test('the control panel shows the Woolworths adapter waiting for review, in demo mode', async () => {
  const page = await controlPanel()
  await expect(page).toHaveTitle('valet (demo) [control]')
  await expect(page.getByText('DEMO').first()).toBeVisible()
  await expect(page.getByText('Woolworths').first()).toBeVisible()
  await expect(page.getByText('Not approved').first()).toBeVisible()
  const pending = await page.evaluate(() => window.valet?.approvals.pending())
  expect(pending?.map((r) => [r.adapterId, r.from])).toEqual([['woolworths', null]])
  expect(await page.evaluate(() => window.valet?.app.status())).toMatchObject({
    demo: true,
    paused: false,
  })
})

test('the renderer has no Node, and the main process refuses what the contract doesn’t allow', async () => {
  const page = await controlPanel()
  expect(await page.evaluate(() => typeof (globalThis as { require?: unknown }).require)).toBe('undefined')
  expect(await page.evaluate(() => typeof (globalThis as { process?: unknown }).process)).toBe('undefined')
  const refused = await page.evaluate(() =>
    window.valet?.app.openControlPanel('https://evil.test/#/adapters' as `#/${string}`).then(
      () => 'opened',
      () => 'refused',
    ),
  )
  expect(refused).toBe('refused')
  const prefs = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .filter((w) => w.getTitle().includes('[control]'))
      .map((w) => {
        // Electron has this at run time, though its type definitions leave it out.
        const contents = w.webContents as unknown as {
          getLastWebPreferences(): {
            contextIsolation?: boolean
            sandbox?: boolean
            nodeIntegration?: boolean
          } | null
        }
        const p = contents.getLastWebPreferences()
        return {
          contextIsolation: p?.contextIsolation,
          sandbox: p?.sandbox,
          nodeIntegration: p?.nodeIntegration,
        }
      }),
  )
  expect(prefs).toEqual([{ contextIsolation: true, sandbox: true, nodeIntegration: false }])
})
