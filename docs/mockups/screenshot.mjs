// Renders every app mockup to docs/mockups/screens/<name>.png (light) and <name>-dark.png at
// 1440x900, device scale 2. Local files only: the pages load nothing from the network.
//
//   mise exec -- node docs/mockups/screenshot.mjs            # every app screen
//   mise exec -- node docs/mockups/screenshot.mjs menubar    # just one

import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// Playwright is a dev dependency of the desktop app, not of the workspace root.
const require = createRequire(join(here, '..', '..', 'apps', 'desktop', 'package.json'))
const { chromium } = require('@playwright/test')

const SCREENS = [
  'index',
  'menubar',
  'control-adapters',
  'adapter-detail',
  'approve-adapter',
  'grant-secret',
  'run-trace',
  'audit-log',
  'confirm-irreversible',
  'needs-user',
  'clients-settings',
]

const wanted = process.argv.slice(2)
const names = wanted.length > 0 ? wanted : SCREENS
const out = join(here, 'screens')
mkdirSync(out, { recursive: true })

const browser = await chromium.launch({ executablePath: findChromium() })
const failures = []
try {
  for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
      colorScheme: theme,
    })
    // Belt and braces: refuse anything that isn't a local file, so a stray URL can't reach the network.
    await context.route(/^(?!file:)/, (route) => route.abort())
    const page = await context.newPage()
    page.on('pageerror', (error) => failures.push(`${theme}: ${error.message}`))
    for (const name of names) {
      const file = join(here, `${name}.html`)
      if (!existsSync(file)) {
        failures.push(`${name}.html does not exist`)
        continue
      }
      const url = `${pathToFileURL(file).href}?theme=${theme}&clean`
      await page.goto(url, { waitUntil: 'load' })
      const suffix = theme === 'dark' ? '-dark' : ''
      await page.screenshot({ path: join(out, `${name}${suffix}.png`) })
    }
    await context.close()
  }
} finally {
  await browser.close()
}

// Playwright looks for the exact browser build it shipped with, which may not be downloaded yet.
// Any already-installed Chromium renders static pages the same, so use the newest one we can find
// rather than downloading. MOCKUP_CHROMIUM overrides; undefined falls back to Playwright's default.
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
