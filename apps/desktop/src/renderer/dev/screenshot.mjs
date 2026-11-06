// Renders every renderer screen against the fake API to apps/desktop/screens/<name>.png (light) and
// <name>-dark.png, at 1440x900, device scale 2, for comparison with docs/mockups/screens. Starts its
// own Vite dev server on a free port and refuses every request that isn't to it.
//
//   mise exec -- node apps/desktop/src/renderer/dev/screenshot.mjs            # every screen
//   mise exec -- node apps/desktop/src/renderer/dev/screenshot.mjs adapters   # just one

import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const require = createRequire(join(desktop, 'package.json'))
const { chromium } = require('@playwright/test')
const { createServer } = require('vite')

/** The worked example's moment: Sat 7 Nov 2026, 9:48 pm in Sydney. */
const NOW = new Date('2026-11-07T21:48:00+11:00')

const SCREENS = {
  adapters: 'index.html#/adapters',
  'adapter-detail': 'index.html#/adapters/woolworths',
  'approve-adapter': 'index.html#/adapters/woolworths/review',
  'grant-secret': 'index.html#/adapters/woolworths/grant/login',
  'run-trace': 'index.html#/activity/c_8f2e1b',
  'audit-log': 'index.html#/audit',
  'clients-settings': 'index.html#/clients',
  credentials: 'index.html#/credentials',
  'confirm-irreversible': 'index.html#/confirm/cf_a40f3c',
  'needs-user': 'index.html#/needs-user/woolworths',
  menubar: 'tray.html',
}

const wanted = process.argv.slice(2)
const names = wanted.length > 0 ? wanted : Object.keys(SCREENS)
const out = join(desktop, 'screens')
mkdirSync(out, { recursive: true })

const server = await createServer({
  configFile: join(desktop, 'vite.config.ts'),
  server: { port: 0, host: '127.0.0.1' },
  logLevel: 'warn',
})
await server.listen()
const address = server.httpServer.address()
const origin = `http://127.0.0.1:${address.port}`

const browser = await chromium.launch({ executablePath: findChromium() })
const failures = []
try {
  for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
      colorScheme: theme,
      timezoneId: 'Australia/Sydney',
      locale: 'en-AU',
    })
    await context.route(
      (url) => !url.href.startsWith(origin),
      (route) => route.abort(),
    )
    const page = await context.newPage()
    await page.clock.setFixedTime(NOW)
    page.on('pageerror', (error) => failures.push(`${theme}: ${error.message}`))
    page.on('console', (message) => {
      if (message.type() === 'error') failures.push(`${theme}: console: ${message.text()}`)
    })
    for (const name of names) {
      const path = SCREENS[name]
      if (path === undefined) {
        failures.push(`unknown screen ${name}`)
        continue
      }
      await page.goto('about:blank')
      await page.goto(`${origin}/${path}`, { waitUntil: 'networkidle' })
      await page.waitForTimeout(300)
      const suffix = theme === 'dark' ? '-dark' : ''
      await page.screenshot({ path: join(out, `${name}${suffix}.png`) })
    }
    await context.close()
  }
} finally {
  await browser.close()
  await server.close()
}

// Use any installed Chromium rather than downloading Playwright's exact build (as
// docs/mockups/screenshot.mjs does). MOCKUP_CHROMIUM overrides.
function findChromium() {
  if (process.env.MOCKUP_CHROMIUM) return process.env.MOCKUP_CHROMIUM
  const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright')
  if (!existsSync(cache)) return undefined
  const builds = readdirSync(cache)
    .filter((entry) => /^chromium-\d+$/.test(entry))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
  for (const build of builds) {
    const app = join(cache, build, 'chrome-mac-arm64', 'Google Chrome for Testing.app')
    const binary = join(app, 'Contents', 'MacOS', 'Google Chrome for Testing')
    if (existsSync(binary)) return binary
  }
  return undefined
}

if (failures.length > 0) {
  console.error(failures.join('\n'))
  process.exitCode = 1
}
