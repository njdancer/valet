// Screenshots of the real app's main screens in demo mode, into screens/live/ (the mockup-compared
// ones in screens/ are the renderer alone on the fake API). Light, 1440x900 at device scale 2, as
// src/renderer/dev/screenshot.mjs takes them. Off unless asked, since it rewrites committed files:
//
//   mise exec -- pnpm --filter @valet/desktop screens:live

import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import {
  appDir,
  blockSite,
  CONTROL,
  COPY_ITEM_ID,
  COPY_ITEM_TITLE,
  callTool,
  changedAdapterBuild,
  chooseStore,
  clickClosing,
  connectFakeOnePassword,
  connectMcp,
  type Launched,
  launch,
  type McpClient,
  type ToolResult,
  tempDir,
  windowWithTitle,
} from './harness'

test.describe.configure({ mode: 'serial' })
test.skip(process.env['VALET_E2E_SCREENS'] !== '1', 'set VALET_E2E_SCREENS=1 (screens:live)')

const OUT = join(appDir, 'screens/live')
let userData: string | undefined
let launched: Launched | null = null
let control: Page
let client: McpClient | null = null

test.afterAll(async () => {
  await client?.close().catch(() => undefined)
  await launched?.close()
  if (userData !== undefined) rmSync(userData, { recursive: true, force: true })
})

async function start(appPath?: string): Promise<void> {
  await client?.close().catch(() => undefined)
  await launched?.close()
  if (userData === undefined) throw new Error('no userData')
  launched = await launch(userData, appPath)
  await launched.app.evaluate(({ nativeTheme }) => {
    nativeTheme.themeSource = 'light'
  })
  control = await windowWithTitle(launched.app, CONTROL)
  await connectFakeOnePassword(launched, control)
  client = await connectMcp(control, userData, 'Claude Code')
}

function mcp(): McpClient {
  if (client === null) throw new Error('no client')
  return client
}

/** The page at `width`x`height` CSS pixels and device scale 2, whatever the display is. */
async function shot(page: Page, name: string, width = 1440, height = 900): Promise<void> {
  mkdirSync(OUT, { recursive: true })
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false })
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(OUT, `${name}.png`), animations: 'disabled' })
  await cdp.send('Emulation.clearDeviceMetricsOverride')
  await cdp.detach()
}

async function route(hash: string): Promise<void> {
  await control.evaluate((hash) => window.valet?.app.openControlPanel(hash as `#/${string}`), hash)
  await control.waitForTimeout(300)
}

let stockcode = 0

test('first run: the adapter waits for review', async () => {
  userData = tempDir('screens')
  await start()
  await expect(control.getByText('Woolworths 0.4.0 is ready for review.')).toBeVisible()
  await shot(control, 'adapters')
  await control.getByRole('link', { name: 'Review changes' }).click()
  await expect(control.getByRole('button', { name: 'Approve 0.4.0' })).toBeVisible()
  await shot(control, 'approve-adapter')
  const ack = control.getByRole('checkbox', { name: 'I’ve read the highlighted additions' })
  if (await ack.isVisible()) await ack.check()
  await control.getByRole('button', { name: 'Approve 0.4.0' }).click()
  await expect
    .poll(async () => (await control.evaluate(() => window.valet?.approvals.pending()))?.length)
    .toBe(0)
  await control.waitForTimeout(500)
})

test('the grant sheet, then the approved adapter', async () => {
  const sheet = control.getByRole('dialog', { name: 'Grant a secret' })
  if (!(await sheet.isVisible())) await route('#/adapters/woolworths/grant/login')
  await expect(sheet).toBeVisible()
  await sheet.getByText(COPY_ITEM_TITLE).click()
  await shot(control, 'grant-secret')
  await sheet.getByRole('button', { name: 'Grant', exact: true }).click()
  await expect(sheet).toBeHidden()
  await route('#/adapters/woolworths/grant/messages')
  await sheet.getByRole('button', { name: 'Grant', exact: true }).click()
  await expect(sheet).toBeHidden()

  await chooseStore(control)
  const found = await callTool(mcp(), 'woolworths_search_products', { query: 'milk' })
  stockcode = (found.structured as { products: { stockcode: number }[] }).products[0]?.stockcode ?? 0
  const added = await callTool(mcp(), 'woolworths_add_to_cart', { stockcode, quantity: 2 })
  expect(added.isError, added.text).toBe(false)
  await callTool(mcp(), 'woolworths_get_cart', {})
  await route('#/adapters/woolworths')
  await shot(control, 'adapter-detail')
})

test('the run trace of the call that logged in, and the audit log verified', async () => {
  const runs = await control.evaluate(() => window.valet?.runs.list())
  // Newest first: the earliest add_to_cart is the one whose login the trace shows.
  const login = runs?.findLast((r) => r.tool === 'add_to_cart')
  await route(`#/activity/${login?.callId ?? ''}`)
  await expect(control.getByText('declarative steps, no adapter code')).toBeVisible()
  await shot(control, 'run-trace')
  await route('#/audit')
  await control.getByRole('button', { name: 'Verify chain' }).click()
  await expect(control.getByText(/Chain intact up to record \d+\./)).toBeVisible()
  await shot(control, 'audit-log')
  await route('#/clients')
  await shot(control, 'clients-settings')
  await route('#/credentials')
  await shot(control, 'credentials')
})

test('the login window the person opens, with the banner above it', async () => {
  await control.evaluate(() => window.valet?.openLoginWindow('woolworths'))
  if (launched === null) throw new Error('not launched')
  const banner = await windowWithTitle(launched.app, 'Valet: sign in')
  await expect(banner.getByRole('button', { name: 'Give up' })).toBeVisible()
  const size = await banner.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
  await shot(banner, 'needs-user', size.width, size.height)
  await banner.getByRole('button', { name: 'Give up' }).click()
})

test('a changed bundle under review, and its irreversible tool’s confirmation', async () => {
  await start(changedAdapterBuild())
  await control.getByRole('link', { name: 'Review changes' }).click()
  await expect(control.getByText('This update asks for more')).toBeVisible()
  await shot(control, 'approve-update')
  await control.getByRole('checkbox', { name: 'I’ve read the highlighted additions' }).check()
  await control.getByRole('button', { name: 'Approve 0.4.0' }).click()
  const detail = await control.evaluate(() => window.valet?.adapters.get('woolworths'))
  const origins = detail?.secretRequests[0]?.origins ?? []
  await control.evaluate(
    ({ hash, origins, itemRef }) =>
      Promise.all([
        window.valet?.grants.make({
          adapterId: 'woolworths',
          adapterHash: hash,
          secret: 'login',
          provider: 'keychain-copy',
          itemRef,
          origins,
        }),
        window.valet?.grants.make({
          adapterId: 'woolworths',
          adapterHash: hash,
          secret: 'messages',
          provider: 'messages',
          itemRef: 'Woolworths',
          origins,
        }),
      ]),
    { hash: detail?.hash ?? '', origins, itemRef: COPY_ITEM_ID },
  )
  const call: Promise<ToolResult> = callTool(mcp(), 'woolworths_remove_from_cart', { stockcode })
  if (launched === null) throw new Error('not launched')
  const panel = await windowWithTitle(launched.app, 'Valet: confirm', 60_000)
  await expect(panel.getByRole('button', { name: 'Approve Remove from cart' })).toBeEnabled()
  await shot(panel, 'confirm-irreversible', 460, 620)
  await clickClosing(panel.getByRole('button', { name: 'Decline' }))
  expect((await call).text).toMatch(/declined/)
})

test('the site blocks: the breaker is open, with its retry time', async () => {
  if (launched === null) throw new Error('not launched')
  await blockSite(launched, true)
  await callTool(mcp(), 'woolworths_search_products', { query: 'bread' })
  await route('#/adapters')
  await expect(control.getByText('Blocked by site').first()).toBeVisible()
  await shot(control, 'adapters-breaker-open')
})
