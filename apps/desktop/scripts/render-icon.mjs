// Renders build/icon.svg to build/icon.png (1024 x 1024), which electron-builder turns into the
// app's .icns. Run it after changing the SVG: node apps/desktop/scripts/render-icon.mjs
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { chromium } = createRequire(join(desktop, 'package.json'))('@playwright/test')
const svg = readFileSync(join(desktop, 'build', 'icon.svg'), 'utf8')
const browser = await chromium.launch(
  process.env.ICON_CHROMIUM === undefined ? {} : { executablePath: process.env.ICON_CHROMIUM },
)
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 })
  await page.setContent(`<style>html,body{margin:0;background:transparent}</style>${svg}`)
  await page.locator('svg').screenshot({ path: join(desktop, 'build', 'icon.png'), omitBackground: true })
} finally {
  await browser.close()
}
