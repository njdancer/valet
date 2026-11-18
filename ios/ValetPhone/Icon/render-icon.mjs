// Renders icon.svg to the app's 1024 px icon (opaque: iOS refuses an icon with transparency).
// Run it after changing the SVG: node ios/ValetPhone/Icon/render-icon.mjs
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const desktop = resolve(here, '../../../apps/desktop')
const { chromium } = createRequire(join(desktop, 'package.json'))('@playwright/test')
const svg = readFileSync(join(here, 'icon.svg'), 'utf8')
const out = join(here, '../Sources/Assets.xcassets/AppIcon.appiconset/icon-1024.png')
const browser = await chromium.launch(
  process.env.ICON_CHROMIUM === undefined ? {} : { executablePath: process.env.ICON_CHROMIUM },
)
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 })
  await page.setContent(`<style>html,body{margin:0;background:#0a5fd6}</style>${svg}`)
  await page.locator('svg').screenshot({ path: out, omitBackground: false })
} finally {
  await browser.close()
}
