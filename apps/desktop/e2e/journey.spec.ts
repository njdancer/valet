// The person's and the agent's first session with the demo, in order, on one userData: review and
// approve Woolworths, grant its login from the person's (fake) 1Password item, which its prompt asks
// them to allow and Valet copies into the demo's Keychain, and its SMS codes from Messages,
// then search, add (which logs in on the fake's Auth0, password and SMS code), read, update and
// remove over MCP. Then the secret scan, a wrong password typed only once (AC10), the site's block
// opening the breaker, and the audit chain (verified, then broken by an edit on disk).

import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import {
  approveInKeyhold,
  appWindows,
  blockSite,
  CONTROL,
  COPY_ITEM_ID,
  COPY_ITEM_TITLE,
  callTool,
  clientTokens,
  connectMcp,
  DEMO_PASSWORD,
  demoAccountMatches,
  type Launched,
  launch,
  type McpClient,
  ONEPASSWORD_ACCOUNT,
  onePasswordPrompts,
  passwordPosts,
  renderedText,
  secretsIn,
  sitePickupStores,
  siteTrolley,
  tempDir,
  windowWithTitle,
  wrongPassword,
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
  // The person's 1Password account, as setup or Settings names it (setup.spec types it).
  await control.evaluate(
    (account) => window.valet?.settings.set({ onePasswordAccount: account }),
    ONEPASSWORD_ACCOUNT,
  )
})

test.afterAll(async () => {
  await client?.close().catch(() => undefined)
  await launched?.close()
  // Chromium may still be flushing a partition as the app exits.
  if (userData !== undefined)
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
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
  // The sidebar's links carry a count after the name ("Needs you, 3 waiting for you").
  await control
    .getByRole('navigation', { name: 'Places' })
    .getByRole('link', { name: new RegExp(`^${section}\\b`) })
    .click()
}

test('the demo account the scan looks for is the one the app uses', () => {
  expect(demoAccountMatches()).toBe(true)
})

test('first launch: Woolworths waits for review, and no MCP client sees or can call its tools', async () => {
  await expect(control).toHaveTitle('Valet (demo) [control]')
  await control.evaluate(() => {
    window.location.hash = '#/sites'
  })
  await expect(control.getByText(/Not approved yet/).first()).toBeVisible()

  client = await connectMcp(control, userData)
  const tools = await client.listTools()
  expect(tools.tools.map((t) => t.name)).toEqual([])
  const refused = await callTool(client, 'woolworths_search_products', { query: 'milk' })
  results.push(refused.raw)
  expect(refused.isError).toBe(true)
  expect(refused.text).not.toMatch(/Full Cream|stockcode/i)
})

test('approve in the review screen; the tools appear to MCP clients', async () => {
  // The Sites list's row for a site never approved carries its Review button.
  await control.getByRole('link', { name: 'Review Woolworths' }).first().click()
  await expect(control.getByRole('button', { name: /^Approve (Woolworths|0\.4\.0)$/ })).toBeVisible()
  const ack = control.getByRole('checkbox', { name: 'I’ve read the highlighted additions' })
  if (await ack.isVisible()) {
    await expect(control.getByRole('button', { name: /^Approve (Woolworths|0\.4\.0)$/ })).toBeDisabled()
    await ack.check()
  }
  await control.getByRole('button', { name: /^Approve (Woolworths|0\.4\.0)$/ }).click()

  await expect
    .poll(async () => (await client.listTools()).tools.map((t) => t.name).sort())
    .toEqual([
      'woolworths_add_to_cart',
      'woolworths_get_cart',
      'woolworths_get_product',
      'woolworths_remove_from_cart',
      'woolworths_search_products',
      'woolworths_set_cart_quantity',
      'woolworths_update_cart',
    ])
})

test('grant login from the person’s 1Password item, offered only the manifest’s origin', async () => {
  // Approving with “choose the login next” ticked opens the sheet; otherwise it is on the site page.
  const sheet = control.getByRole('dialog')
  // A first install goes to the login next, after the approval seal has shown for a moment.
  await sheet.waitFor({ state: 'visible', timeout: 3000 }).catch(() => undefined)
  if (!(await sheet.isVisible().catch(() => false))) {
    await control.getByRole('link', { name: 'Woolworths' }).first().click()
    await control.getByRole('link', { name: 'Choose login…' }).first().click()
  }
  await expect(sheet).toBeVisible()
  await expect(sheet.getByRole('heading', { name: 'Give Valet your Woolworths login' })).toBeVisible()

  const status = await control.evaluate(() => window.valet?.adapters.get('woolworths'))
  const authOrigin = status?.secretRequests.find((s) => s.name === 'login')?.origins
  expect(authOrigin).toEqual([expect.stringMatching(/^https:\/\/auth\.woolworths\.test:\d+$/)])

  // Listing the person's vaults asks the fake 1Password; they unlock it and allow Valet. Then the
  // item, and exactly the origins the manifest asked for.
  await approveInKeyhold(launched)
  await sheet.getByText(COPY_ITEM_TITLE).click()
  await expect(sheet.getByRole('radio', { name: /Woolworths \(demo account\)/ })).toBeChecked()
  const originBoxes = sheet.getByRole('checkbox')
  await expect(originBoxes).toHaveCount(1)
  await expect(originBoxes).toBeChecked()
  await expect(originBoxes).toHaveAccessibleName(authOrigin?.[0] ?? '')
  await expect(sheet.getByText(/www\.woolworths\.test/)).toHaveCount(0)
  await sheet.getByRole('button', { name: 'Use this login' }).click()
  await expect(sheet).toBeHidden()
  // The copy was made under the approval the listing got: one prompt in all.
  expect(await onePasswordPrompts(launched)).toEqual([
    { kind: 'sdk', integration: 'valet', state: 'allowed' },
  ])

  // The main process refuses an origin the manifest didn't ask for, whatever the renderer sends.
  const hash = status?.hash ?? ''
  const widened = await control.evaluate(
    ({ hash, authOrigin, itemRef }) =>
      window.valet?.grants
        .make({
          adapterId: 'woolworths',
          adapterHash: hash,
          secret: 'login',
          provider: 'keychain-copy',
          itemRef,
          origins: [authOrigin, 'https://evil.test'],
        })
        .then(
          () => 'made',
          () => 'refused',
        ),
    { hash, authOrigin: authOrigin?.[0] ?? '', itemRef: COPY_ITEM_ID },
  )
  expect(widened).toBe('refused')
})

test('grant SMS codes from Messages for the declared sender', async () => {
  await control.getByRole('link', { name: 'Choose…' }).first().click()
  const sheet = control.getByRole('dialog')
  await expect(sheet.getByText('Let Woolworths read one-time codes from Messages')).toBeVisible()
  await expect(sheet.getByRole('radio', { name: /Woolworths/ })).toBeChecked()
  await sheet.getByRole('button', { name: 'Allow these codes' }).click()
  await expect(sheet).toBeHidden()
  const detail = await control.evaluate(() => window.valet?.adapters.get('woolworths'))
  expect(detail?.secretRequests.map((s) => s.grant?.itemTitle)).toEqual([COPY_ITEM_TITLE])
  expect(detail?.messages.map((m) => [m.sender, m.grant?.itemId])).toEqual([['Woolworths', 'Woolworths']])
  // Codes are typed where Auth0 asks for them, the login's origin, and nowhere else by default.
  const loginOrigins = detail?.secretRequests.find((s) => s.name === 'login')?.origins
  expect(detail?.messages[0]?.grant?.origins).toEqual(loginOrigins)
})

test('the tools wait for a store: an agent is told to ask, and the person picks one by postcode (D69)', async () => {
  const waiting = await callTool(client, 'woolworths_search_products', { query: 'milk' })
  results.push(waiting.raw)
  expect(waiting.text).toContain('setting-required')
  expect(waiting.text).not.toMatch(/Full Cream|stockcode/i)
  // The setting's own tools are Valet's: no client can call one, listed or not.
  const direct = await callTool(client, 'woolworths_apply_store', { value: '9001310' })
  results.push(direct.raw)
  expect(direct.isError).toBe(true)

  await control.evaluate(() => {
    window.location.hash = '#/sites/woolworths'
  })
  const card = control.getByTestId('setting-store')
  await expect(card.getByText(/No store chosen/)).toBeVisible()
  await card.getByRole('link', { name: 'Choose store…' }).click()
  const sheet = control.getByRole('dialog', { name: 'Choose your Woolworths store' })
  await sheet.getByRole('textbox', { name: 'Postcode to find a store' }).fill('2000')
  await sheet.getByRole('button', { name: 'Search' }).click()
  const choices = sheet.getByRole('radiogroup')
  await expect(choices.getByText('Woolworths Town Hall')).toBeVisible()
  await expect(choices.getByText('Woolworths Metro Wynyard')).toBeVisible()
  await choices.getByText('Woolworths Metro Wynyard').click()
  await sheet.getByRole('button', { name: 'Use Woolworths Metro Wynyard' }).click()
  await expect(sheet).toBeHidden()
  await expect(card.getByTestId('setting-chosen')).toContainText('Woolworths Metro Wynyard')

  const detail = await control.evaluate(() => window.valet?.adapters.get('woolworths'))
  expect(detail?.settingsNeeded).toEqual([])
  expect(detail?.settings[0]?.chosen).toMatchObject({ id: '9001245', label: 'Woolworths Metro Wynyard' })
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

  const detail = await control.evaluate(() => window.valet?.adapters.get('woolworths'))
  expect(detail?.session.state).toBe('logged-in')
  // The site itself holds the line, in the demo account's trolley.
  expect(await siteTrolley(launched)).toEqual([{ stockcode, quantity: 2 }])
})

test('get_cart shows the line; set_cart_quantity and remove_from_cart change it', async () => {
  const cart = await callTool(client, 'woolworths_get_cart', {})
  results.push(cart.raw)
  expect(cart.isError, cart.text).toBe(false)
  expect(JSON.stringify(cart.structured)).toContain(`"stockcode":${stockcode}`)
  // The login started a new session on the site, without the store. Valet set it again before
  // this call, so the logged-in session shops at the store the person chose (D69).
  expect(await sitePickupStores(launched)).toEqual([9001245])

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
  const calls = control.getByRole('table', { name: 'Tool calls' })
  for (const tool of ['get_cart', 'remove_from_cart', 'set_cart_quantity', 'add_to_cart', 'search_products'])
    await expect(calls.getByRole('link', { name: tool, exact: true }).first()).toBeVisible()
  // The newest is listed first. The login belongs to the first add_to_cart: it answered early, that a
  // login was running, so the list folds it into the call that followed, which links back to it.
  await calls
    .getByRole('row')
    .filter({ has: control.getByRole('link', { name: 'add_to_cart', exact: true }) })
    .last()
    .getByRole('link', { name: /^(a retry|\d+ retries)$/ })
    .click()
  await expect(control.getByText('Declarative steps, no adapter code')).toBeVisible()
  // Each fill names the secret and field, never the value.
  await expect(control.getByText(/secret:login\.username/)).toBeVisible()
  await expect(control.getByText(/secret:login\.password/)).toBeVisible()
})

test('no secret reaches an MCP result, the audit log, the renderer or the app’s logs', async () => {
  const tokens = clientTokens(userData)
  expect(results.length).toBeGreaterThan(5)
  expect(secretsIn(results.join('\n'), tokens)).toEqual([])
  const audit = readFileSync(join(userData, 'audit.jsonl'), 'utf8')
  expect(audit).toContain('"login-')
  expect(secretsIn(audit, tokens)).toEqual([])
  // Every screen that shows run data, rendered.
  for (const section of [
    '#/sites',
    '#/sites/woolworths',
    '#/sites/woolworths/permissions',
    '#/activity/calls',
    '#/activity/audit',
    '#/connections',
    '#/secrets',
    '#/settings',
  ]) {
    await control.evaluate((hash) => {
      window.location.hash = hash
    }, section)
    await control.waitForTimeout(300)
    expect(secretsIn(await renderedText(launched.app), tokens), section).toEqual([])
  }
  expect(secretsIn(launched.logs.join(''), tokens)).toEqual([])
  // The scan can find what it looks for: the password is in the demo's own source.
  expect(secretsIn(`x${DEMO_PASSWORD}x`)).toEqual(['demo password'])
})

test('a wrong password is typed once, the login is held for the person, and the next call sends nothing (AC10)', async () => {
  // As if the password had been changed elsewhere: logged out everywhere, and the stored one wrong.
  await wrongPassword(launched, true)
  const before = await passwordPosts(launched)
  const failed = await callTool(client, 'woolworths_get_cart', {})
  results.push(failed.raw)
  expect(failed.text).toMatch(/login-required/)
  expect((await passwordPosts(launched)) - before).toBe(1)
  const detail = await control.evaluate(() => window.valet?.adapters.get('woolworths'))
  expect(detail?.session).toMatchObject({ state: 'needs-user', needsUser: 'login-required' })

  // The held login stays with the person: the next call types nothing.
  const again = await callTool(client, 'woolworths_get_cart', {})
  results.push(again.raw)
  expect(again.text).toMatch(/login-required/)
  expect((await passwordPosts(launched)) - before).toBe(1)

  await control.evaluate(() => {
    window.location.hash = '#/sites/woolworths'
  })
  await expect(control.getByText(/Waiting for you to log in/).first()).toBeVisible()
  await expect(control.getByRole('button', { name: 'Show login window' }).first()).toBeVisible()
  await wrongPassword(launched, false)
  // The person closes the login window without logging in.
  await launched.app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows())
      if (window.getTitle().includes('needs you to log in')) window.close()
  })
})

test('the site blocking every request opens the breaker: tools return blocked, the UI shows a retry', async () => {
  await blockSite(launched, true)
  const blocked = await callTool(client, 'woolworths_search_products', { query: 'bread' })
  results.push(blocked.raw)
  expect(blocked.isError).toBe(true)
  expect(blocked.text).toMatch(/blocked/i)
  expect(blocked.text).toMatch(/\d+ ?s|second/i)

  await control.evaluate(() => {
    window.location.hash = '#/sites'
  })
  await expect(control.getByText(/limiting (its )?requests/).first()).toBeVisible()
  await expect(control.getByText(/calls resume at /).first()).toBeVisible()

  // While open, the next call is refused without touching the site.
  const again = await callTool(client, 'woolworths_search_products', { query: 'bread' })
  expect(again.isError).toBe(true)
  expect(again.text).toMatch(/blocked/i)
})

test('the audit log verifies; an edit to the file on disk breaks the chain', async () => {
  await go('Activity')
  await control
    .getByRole('navigation', { name: 'Activity' })
    .getByRole('link', { name: /^Audit log/ })
    .click()
  await control.getByRole('button', { name: 'Check now' }).click()
  await expect(control.getByText(/The audit log checks out up to record \d+\./)).toBeVisible()

  // Change one recorded value in the middle of the file, as someone covering their tracks would.
  const path = join(userData, 'audit.jsonl')
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
  const victim = lines.findIndex((line) => line.includes('"tool-called"'))
  expect(victim).toBeGreaterThan(0)
  lines[victim] = (lines[victim] ?? '').replace('"woolworths_search_products"', '"woolworths_get_cart"')
  lines[victim] = (lines[victim] ?? '').replace('"search_products"', '"get_cart"')
  writeFileSync(path, `${lines.join('\n')}\n`)

  await control.getByRole('button', { name: 'Check now' }).click()
  await expect(control.getByText(/The audit log doesn’t check out from record \d+\./)).toBeVisible()
  await expect(control.getByRole('link', { name: 'See where' })).toBeVisible()
})
