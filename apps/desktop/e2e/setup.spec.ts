// First-run setup, end to end (AC2, AC3): a first launch opens setup in the control panel, and the
// person walks it in order. 1Password is the fake one (Keyhold): the person names its account, and
// granting the login opens its prompt, which they unlock and allow, and Valet copies the item into
// the demo's Keychain (D6). The approval is the bundled Woolworths adapter's review; the grant has
// origins exactly the fake's auth origin; then Claude Code and Claude Desktop are added and their
// setup copied. A real MCP
// client with Claude Code's own token then lists the adapter's six namespaced tools with their
// annotations. Finishing closes setup for good: a relaunch opens the adapters page.

import { rmSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { expect, type Page, test } from '@playwright/test'
import {
  approveInKeyhold,
  appWindows,
  CONTROL,
  COPY_ITEM_ID,
  COPY_ITEM_TITLE,
  clientConfig,
  keychainItems,
  type Launched,
  launch,
  type McpClient,
  ONEPASSWORD_ACCOUNT,
  onePasswordPrompts,
  renderedText,
  secretsIn,
  siteTools,
  tempDir,
  windowWithTitle,
} from './harness'

test.describe.configure({ mode: 'serial' })

let userData: string
let launched: Launched
let control: Page
let client: McpClient | null = null

test.beforeAll(async () => {
  userData = tempDir('setup')
  launched = await launch(userData, undefined, { setup: true })
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

const h1 = (name: string | RegExp) => control.getByRole('heading', { level: 1, name })

async function clipboard(): Promise<string> {
  return launched.app.evaluate(({ clipboard }) => clipboard.readText())
}

test('a first launch opens setup at the welcome', async () => {
  await expect(control).toHaveTitle('Valet (demo) [control]')
  await expect(h1('Let Claude shop at Woolworths for you')).toBeVisible()
  expect(new URL(control.url()).hash).toBe('#/setup')
  await control.getByRole('link', { name: 'Get started' }).click()
})

test('1Password: naming the account makes the Keychain copy ready, and nothing asks yet', async () => {
  await expect(h1('Where your Woolworths password comes from')).toBeVisible()
  await expect(control.getByText('Valet can’t reach 1Password yet.', { exact: false })).toBeVisible()
  await control.getByRole('textbox', { name: '1Password account' }).fill(ONEPASSWORD_ACCOUNT)
  await control.getByRole('button', { name: 'Save' }).click()
  await expect(control.getByText('Copy in your Keychain is ready.', { exact: false })).toBeVisible()
  // The test provider is gone from demo mode: the copy is the only way in.
  await expect(control.getByText('Test provider')).toHaveCount(0)
  expect(await onePasswordPrompts(launched)).toEqual([])
  await control.getByRole('link', { name: 'Continue' }).click()
})

test('approve the bundled Woolworths adapter in its review, back into setup', async () => {
  await expect(h1('Approve Woolworths')).toBeVisible()
  const perms = control.getByTestId('setup-perms')
  await expect(perms).toContainText(/www\.woolworths\.test/)
  await expect(perms).toContainText(/auth\.woolworths\.test/)
  await expect(perms).toContainText(/3 read.*4 write.*0 irreversible/)
  await control.getByRole('link', { name: /^Review Woolworths .*…$/ }).click()
  const approve = control.getByRole('button', { name: /^Approve (Woolworths|\d)/ })
  await expect(approve).toBeVisible()
  const ack = control.getByRole('checkbox', { name: 'I’ve read the highlighted additions' })
  if (await ack.isVisible()) await ack.check()
  await approve.click()
  await expect(h1('Your Woolworths login')).toBeVisible()
  const woolworths = await control.evaluate(() => window.valet?.adapters.get('woolworths'))
  expect(woolworths?.approval).toBe('approved')
})

test('grant login from the person’s 1Password item, approved in its prompt, with origins exactly the auth origin', async () => {
  await control.getByRole('link', { name: 'Choose an item…' }).click()
  const sheet = control.getByRole('dialog')
  await expect(sheet).toBeVisible()
  // Listing the person's vaults asks 1Password: its prompt opens, locked, and the person unlocks it
  // and allows Valet.
  await expect(sheet.getByRole('radio', { name: /Copy in your Keychain/ })).toBeChecked()
  await approveInKeyhold(launched)
  await sheet.getByText(COPY_ITEM_TITLE).click()
  await expect(sheet.getByRole('checkbox')).toHaveCount(1)
  await expect(sheet.getByRole('checkbox')).toBeChecked()
  await expect(sheet.getByText(/www\.woolworths\.test/)).toHaveCount(0)
  await sheet.getByRole('button', { name: 'Use this login' }).click()
  await expect(sheet).toBeHidden()
  await expect(
    control.getByText(/Uses “Woolworths \(demo account\) \(Personal\)” from Copy in your Keychain/),
  ).toBeVisible()

  const grants = await control.evaluate(() => window.valet?.grants.list())
  const login = grants?.find((g) => g.adapterId === 'woolworths' && g.secret === 'login')
  expect(login?.provider).toBe('keychain-copy')
  expect(login?.itemId).toBe(COPY_ITEM_ID)
  // One prompt covered the listing and the copy, and the copy is in the demo's Keychain, a field each.
  expect(await onePasswordPrompts(launched)).toEqual([
    { kind: 'sdk', integration: 'valet', state: 'allowed' },
  ])
  expect((await keychainItems(launched)).map((i) => i.account).sort()).toEqual([
    `op://${COPY_ITEM_ID.replace('-', '/')}#password`,
    `op://${COPY_ITEM_ID.replace('-', '/')}#username`,
  ])
  expect(login?.origins).toEqual([expect.stringMatching(/^https:\/\/auth\.woolworths\.test:\d+$/)])
  expect(login?.origins.some((o) => o.includes('www.'))).toBe(false)
  const detail = await control.evaluate(() => window.valet?.adapters.get('woolworths'))
  expect(login?.adapterHash).toBe(detail?.hash)

  // The login asks for an SMS code, so setup offers that grant too: without it the first login
  // stops at the code page (the recorded demo found setup leaving it out).
  await control.getByRole('link', { name: 'Allow codes…' }).click()
  await expect(sheet.getByText('Let Woolworths read one-time codes from Messages')).toBeVisible()
  await sheet.getByRole('button', { name: 'Allow these codes' }).click()
  await expect(sheet).toBeHidden()
  await expect(control.getByText(/Reads one-time codes from Woolworths in Messages/)).toBeVisible()
  const codes = await control.evaluate(() => window.valet?.adapters.get('woolworths'))
  expect(codes?.messages.map((m) => m.grant?.itemId)).toEqual(['Woolworths'])

  // The store is required on the fake (D69), so setup asks for it in a step of its own: without it
  // every tool ends needsUser.
  await control.getByRole('link', { name: 'Continue' }).click()
  await expect(h1('Your Woolworths store')).toBeVisible()
  const settings = control.getByTestId('setup-settings')
  await settings.getByRole('textbox').fill('2000')
  await settings.getByRole('button', { name: 'Search' }).click()
  await settings.getByRole('button', { name: 'Choose' }).first().click()
  await expect(settings.getByTestId('setting-chosen')).toBeVisible()
  await control.getByRole('link', { name: 'Continue' }).click()
})

test('connect Claude Code and Claude Desktop, each with its own config to copy', async () => {
  await expect(h1('Connect Claude')).toBeVisible()
  await control.getByRole('button', { name: 'Add Claude Code' }).click()
  const codeSnippet = control.locator('pre', { hasText: 'claude mcp add valet' })
  await expect(codeSnippet).toBeVisible()
  await control.getByRole('button', { name: 'Copy' }).first().click()
  await expect.poll(clipboard).toBe(await codeSnippet.textContent())

  await control.getByRole('button', { name: 'Add Claude Desktop' }).click()
  const desktopSnippet = control.locator('pre', { hasText: 'mcpServers' })
  await expect(desktopSnippet).toBeVisible()
  // Claude Code's button now says Copied, so the one left is Claude Desktop's.
  await control.getByRole('button', { name: 'Copy', exact: true }).click()
  await expect.poll(clipboard).toContain('mcpServers')
  // Demo mode names the server valet-demo, so it never replaces a real install's entry.
  const desktop = JSON.parse(await clipboard()) as {
    mcpServers: Record<string, { command: string; args: string[] }>
  }
  const server = desktop.mcpServers['valet-demo']
  expect(server?.command.length).toBeGreaterThan(0)

  // Neither snippet carries a token: the bridge reads it from the client's own config file.
  const clients = (await control.evaluate(() => window.valet?.clients.list())) ?? []
  expect(clients.map((c) => c.name)).toEqual(['Claude Code', 'Claude Desktop'])
  for (const c of clients) {
    const { token } = clientConfig(userData, c.id)
    expect(await codeSnippet.textContent()).not.toContain(token)
    expect(await desktopSnippet.textContent()).not.toContain(token)
    // The Desktop snippet points the bridge at that client's own file.
    if (c.name === 'Claude Desktop') expect(server?.args.at(-1)).toContain(c.id)
  }
})

test('Claude Code’s token lists the six namespaced tools with manifest-derived annotations', async () => {
  const clients = (await control.evaluate(() => window.valet?.clients.list())) ?? []
  const code = clients.find((c) => c.name === 'Claude Code')
  if (code === undefined) throw new Error('Claude Code was not added')
  const { url, token } = clientConfig(userData, code.id)
  client = new Client({ name: 'claude-code', version: '1.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  )
  const { tools } = await client.listTools()
  const byName = Object.fromEntries(siteTools(tools).map((t) => [t.name, t.annotations]))
  expect(Object.keys(byName).sort()).toEqual([
    'woolworths_add_to_cart',
    'woolworths_get_cart',
    'woolworths_get_product',
    'woolworths_remove_from_cart',
    'woolworths_search_products',
    'woolworths_set_cart_quantity',
    'woolworths_update_cart',
  ])
  for (const read of ['woolworths_get_cart', 'woolworths_get_product', 'woolworths_search_products']) {
    expect(byName[read]).toMatchObject({ readOnlyHint: true, openWorldHint: true })
  }
  // C9, from the manifest: every write destructive (add_to_cart until D30); setting a quantity or
  // removing a line twice is the same cart (AC3), adding twice is not.
  for (const [write, idempotentHint] of [
    ['woolworths_add_to_cart', false],
    ['woolworths_remove_from_cart', true],
    ['woolworths_set_cart_quantity', true],
    ['woolworths_update_cart', false],
  ] as const) {
    expect(byName[write]).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint,
      openWorldHint: true,
    })
  }
})

test('finishing closes setup for good, and nothing on screen holds a secret', async () => {
  await control.getByRole('button', { name: 'Finish', exact: true }).click()
  await expect(h1(/set up$/)).toBeVisible()
  await control.getByRole('link', { name: 'Open Valet' }).click()
  await expect(control.getByRole('navigation', { name: 'Places' })).toBeVisible()
  expect(new URL(control.url()).hash).toBe('#/sites')
  const status = await control.evaluate(() => window.valet?.setup.status())
  expect(status?.completedAt).toEqual(expect.any(String))

  const tokens = ((await control.evaluate(() => window.valet?.clients.list())) ?? []).map(
    (c) => clientConfig(userData, c.id).token,
  )
  const text = await renderedText(launched.app)
  expect(secretsIn(text, tokens)).toEqual([])

  await client?.close().catch(() => undefined)
  client = null
  await launched.close()
  launched = await launch(userData, undefined, { setup: true })
  control = await windowWithTitle(launched.app, CONTROL)
  await expect(control.getByRole('navigation', { name: 'Places' })).toBeVisible()
  expect(new URL(control.url()).hash).not.toContain('setup')
})
