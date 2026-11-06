// The person's and the agent's first session with the demo, in order, on one userData: review and
// approve Woolworths, grant its login from the demo vault item and its SMS codes from Messages,
// then search, add (which logs in on the fake's Auth0, password and SMS code), read, update and
// remove over MCP. Then the secret scan, the audit chain (verified, then broken by an edit on disk),
// and the site's block opening the breaker.

import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import {
  appWindows,
  blockSite,
  bridgeConfig,
  CONTROL,
  callTool,
  connectMcp,
  DEMO_PASSWORD,
  demoAccountMatches,
  type Launched,
  launch,
  type McpClient,
  renderedText,
  secretsIn,
  siteTrolley,
  tempDir,
  windowWithTitle,
} from './harness'

test.describe.configure({ mode: 'serial' })

let userData: string
let launched: Launched
let control: Page
let client: McpClient

/** Every MCP result the client received, for the secret scan. */
const results: string[] = []

test.beforeAll(async () => {
  userData = tempDir('journey')
  launched = await launch(userData)
  control = await windowWithTitle(launched.app, CONTROL)
})

test.afterAll(async () => {
  await client?.close().catch(() => undefined)
  await launched?.close()
  if (userData !== undefined) rmSync(userData, { recursive: true, force: true })
})

// biome-ignore lint/correctness/noEmptyPattern: Playwright needs the fixtures argument destructured
test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) {
    for (const [i, page] of appWindows(launched.app).entries()) {
      await page.screenshot({ path: testInfo.outputPath(`window-${i}.png`) }).catch(() => undefined)
    }
    await testInfo.attach('app-log', { body: launched.logs.join('') })
  }
})

async function go(section: string): Promise<void> {
  // The sidebar's links carry a count after the name ("Activity 7").
  await control
    .getByRole('complementary', { name: 'Sections' })
    .getByRole('link', { name: new RegExp(`^${section}(\\s+\\d+)?$`) })
    .click()
}

test('the demo account the scan looks for is the one the app uses', () => {
  expect(demoAccountMatches()).toBe(true)
})

test('first launch: Woolworths waits for review, and no MCP client sees or can call its tools', async () => {
  await expect(control).toHaveTitle('siteadapter (demo) [control]')
  await expect(control.getByText('Woolworths 0.2.0 is ready for review.')).toBeVisible()
  await expect(control.getByText('Not approved').first()).toBeVisible()

  client = await connectMcp(userData)
  const tools = await client.listTools()
  expect(tools.tools.map((t) => t.name)).toEqual([])
  const refused = await callTool(client, 'woolworths_search_products', { query: 'milk' })
  results.push(refused.raw)
  expect(refused.isError).toBe(true)
  expect(refused.text).not.toMatch(/Full Cream|stockcode/i)
})

test('approve in the review screen; the tools appear to MCP clients', async () => {
  await control.getByRole('link', { name: 'Review changes' }).click()
  await expect(control.getByRole('button', { name: 'Approve 0.2.0' })).toBeVisible()
  const ack = control.getByRole('checkbox', { name: 'I’ve read the highlighted additions' })
  if (await ack.isVisible()) {
    await expect(control.getByRole('button', { name: 'Approve 0.2.0' })).toBeDisabled()
    await ack.check()
  }
  await control.getByRole('button', { name: 'Approve 0.2.0' }).click()

  await expect
    .poll(async () => (await client.listTools()).tools.map((t) => t.name).sort())
    .toEqual([
      'woolworths_add_to_cart',
      'woolworths_get_cart',
      'woolworths_get_product',
      'woolworths_remove_from_cart',
      'woolworths_search_products',
      'woolworths_set_cart_quantity',
    ])
})

test('grant login from the demo vault item, offered only the manifest’s origin', async () => {
  // Approving with “grant next” ticked opens the sheet; otherwise it is on the adapter page.
  const sheet = control.getByRole('dialog', { name: 'Grant a secret' })
  if (!(await sheet.isVisible().catch(() => false))) {
    await control.getByRole('link', { name: 'Woolworths' }).first().click()
    await control.getByRole('link', { name: 'Grant…' }).first().click()
  }
  await expect(sheet).toBeVisible()
  await expect(sheet.getByText('Let Woolworths log in with your 1Password item')).toBeVisible()

  const status = await control.evaluate(() => window.siteadapter?.adapters.get('woolworths'))
  const authOrigin = status?.secretRequests.find((s) => s.name === 'login')?.origins
  expect(authOrigin).toEqual([expect.stringMatching(/^https:\/\/auth\.woolworths\.test:\d+$/)])

  // The test provider, its one item, and exactly the origins the manifest asked for.
  await sheet.getByText('Woolworths (demo account)').click()
  await expect(sheet.getByRole('radio', { name: /Woolworths \(demo account\)/ })).toBeChecked()
  const originBoxes = sheet.getByRole('checkbox')
  await expect(originBoxes).toHaveCount(1)
  await expect(originBoxes).toBeChecked()
  await expect(sheet.locator('.origin-row')).toHaveText([new RegExp(`^${authOrigin?.[0]}`)])
  await expect(sheet.getByText(/www\.woolworths\.test/)).toHaveCount(0)
  await sheet.getByRole('button', { name: 'Grant', exact: true }).click()
  await expect(sheet).toBeHidden()

  // The main process refuses an origin the manifest didn't ask for, whatever the renderer sends.
  const hash = status?.hash ?? ''
  const widened = await control.evaluate(
    ({ hash, authOrigin }) =>
      window.siteadapter?.grants
        .make({
          adapterId: 'woolworths',
          adapterHash: hash,
          secret: 'login',
          provider: 'fake',
          itemRef: 'demo-woolworths',
          origins: [authOrigin, 'https://evil.test'],
        })
        .then(
          () => 'made',
          () => 'refused',
        ),
    { hash, authOrigin: authOrigin?.[0] ?? '' },
  )
  expect(widened).toBe('refused')
})

test('grant SMS codes from Messages for the declared sender', async () => {
  await control.getByRole('link', { name: 'Grant…' }).first().click()
  const sheet = control.getByRole('dialog', { name: 'Grant a secret' })
  await expect(sheet.getByText('Let Woolworths read one-time codes from Messages')).toBeVisible()
  await expect(sheet.getByRole('radio', { name: /Woolworths/ })).toBeChecked()
  await sheet.getByRole('button', { name: 'Grant', exact: true }).click()
  await expect(sheet).toBeHidden()
  const detail = await control.evaluate(() => window.siteadapter?.adapters.get('woolworths'))
  expect(detail?.secretRequests.map((s) => s.grant?.itemTitle)).toEqual(['Woolworths (demo account)'])
  expect(detail?.messages.map((m) => [m.sender, m.grant?.itemId])).toEqual([['Woolworths', 'Woolworths']])
  // Codes are typed where Auth0 asks for them, the login's origin, and nowhere else by default.
  const loginOrigins = detail?.secretRequests.find((s) => s.name === 'login')?.origins
  expect(detail?.messages[0]?.grant?.origins).toEqual(loginOrigins)
})

test('search_products returns catalogue items, with no login', async () => {
  const found = await callTool(client, 'woolworths_search_products', { query: 'milk' })
  results.push(found.raw)
  expect(found.isError, found.text).toBe(false)
  const products = (found.structured as { products: { stockcode: number; name: string }[] }).products
  expect(products.length).toBeGreaterThan(0)
  expect(products.some((p) => /milk/i.test(p.name))).toBe(true)
})

let stockcode = 0

test('add_to_cart logs in on the fake Auth0 (email, password, SMS code) and adds the line', async () => {
  const found = await callTool(client, 'woolworths_search_products', { query: 'milk' })
  const products = (found.structured as { products: { stockcode: number }[] }).products
  stockcode = products[0]?.stockcode ?? 0
  const added = await callTool(client, 'woolworths_add_to_cart', { stockcode, quantity: 2 })
  results.push(added.raw)
  expect(added.isError, added.text).toBe(false)
  expect(added.structured).toMatchObject({
    stockcode,
    previousQuantity: 0,
    requestedQuantity: 2,
    quantity: 2,
  })

  const detail = await control.evaluate(() => window.siteadapter?.adapters.get('woolworths'))
  expect(detail?.session.state).toBe('logged-in')
  // The site itself holds the line, in the demo account's trolley.
  expect(await siteTrolley(launched)).toEqual([{ stockcode, quantity: 2 }])
})

test('get_cart shows the line; set_cart_quantity and remove_from_cart change it', async () => {
  const cart = await callTool(client, 'woolworths_get_cart', {})
  results.push(cart.raw)
  expect(cart.isError, cart.text).toBe(false)
  expect(JSON.stringify(cart.structured)).toContain(`"stockcode":${stockcode}`)

  const set = await callTool(client, 'woolworths_set_cart_quantity', { stockcode, quantity: 5 })
  results.push(set.raw)
  expect(set.isError, set.text).toBe(false)
  expect(set.structured).toMatchObject({ stockcode, quantity: 5, confirmed: true })

  const removed = await callTool(client, 'woolworths_remove_from_cart', { stockcode })
  results.push(removed.raw)
  expect(removed.isError, removed.text).toBe(false)
  expect(removed.structured).toMatchObject({ stockcode, removed: true })

  const after = await callTool(client, 'woolworths_get_cart', {})
  results.push(after.raw)
  expect(JSON.stringify(after.structured)).not.toContain(`"stockcode":${stockcode}`)
  expect(await siteTrolley(launched)).toEqual([])
})

test('the activity screen lists the calls; add_to_cart’s trace shows the login and the fills', async () => {
  await go('Activity')
  const recent = control.getByRole('complementary', { name: 'Sections' })
  for (const tool of ['get_cart', 'remove_from_cart', 'set_cart_quantity', 'add_to_cart', 'search_products'])
    await expect(recent.getByRole('link', { name: new RegExp(`^${tool}`) }).first()).toBeVisible()
  await recent.getByRole('link', { name: /^add_to_cart/ }).click()
  await expect(control.getByText('declarative steps, no adapter code')).toBeVisible()
  // Each fill names the secret and field, never the value.
  await expect(control.getByText('secret:login.username')).toBeVisible()
  await expect(control.getByText('secret:login.password')).toBeVisible()
})

test('no secret reaches an MCP result, the audit log, the renderer or the app’s logs', async () => {
  const { token } = bridgeConfig(userData)
  expect(results.length).toBeGreaterThan(5)
  expect(secretsIn(results.join('\n'), [token])).toEqual([])
  const audit = readFileSync(join(userData, 'audit.jsonl'), 'utf8')
  expect(audit).toContain('"login-')
  expect(secretsIn(audit, [token])).toEqual([])
  // Every screen that shows run data, rendered.
  for (const section of ['Adapters', 'Activity', 'Audit log', 'Clients', 'Credentials', 'Settings']) {
    await go(section)
    await control.waitForTimeout(300)
    expect(secretsIn(await renderedText(launched.app), [token]), section).toEqual([])
  }
  expect(secretsIn(launched.logs.join(''), [token])).toEqual([])
  // The scan can find what it looks for: the password is in the demo's own source.
  expect(secretsIn(`x${DEMO_PASSWORD}x`)).toEqual(['demo password'])
})

test('the site blocking every request opens the breaker: tools return blocked, the UI shows a retry', async () => {
  await blockSite(launched, true)
  const blocked = await callTool(client, 'woolworths_search_products', { query: 'bread' })
  results.push(blocked.raw)
  expect(blocked.isError).toBe(true)
  expect(blocked.text).toMatch(/blocked/i)
  expect(blocked.text).toMatch(/\d+ ?s|second/i)

  await go('Adapters')
  await expect(control.getByText('Blocked by site').first()).toBeVisible()
  await expect(control.getByText(/Retry in /).first()).toBeVisible()
  await expect(control.getByText(/Open · /).first()).toBeVisible()

  // While open, the next call is refused without touching the site.
  const again = await callTool(client, 'woolworths_search_products', { query: 'bread' })
  expect(again.isError).toBe(true)
  expect(again.text).toMatch(/blocked/i)
})

test('the audit log verifies; an edit to the file on disk breaks the chain', async () => {
  await go('Audit log')
  await control.getByRole('button', { name: 'Verify chain' }).click()
  await expect(control.getByText(/Chain intact up to record \d+\./)).toBeVisible()

  // Change one recorded value in the middle of the file, as someone covering their tracks would.
  const path = join(userData, 'audit.jsonl')
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
  const victim = lines.findIndex((line) => line.includes('"tool-called"'))
  expect(victim).toBeGreaterThan(0)
  lines[victim] = (lines[victim] ?? '').replace('"woolworths_search_products"', '"woolworths_get_cart"')
  lines[victim] = (lines[victim] ?? '').replace('"search_products"', '"get_cart"')
  writeFileSync(path, `${lines.join('\n')}\n`)

  await control.getByRole('button', { name: 'Verify chain' }).click()
  await expect(control.getByText(/Chain broken at record \d+\./)).toBeVisible()
  await expect(control.getByText('Audit chain broken')).toBeVisible()
})
