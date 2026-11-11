// A changed adapter. The built app is approved, granted and logged in; then the same userData is
// opened by a copy of the build whose Woolworths bundle changed (harness.ts, changedAdapterBuild:
// remove_from_cart is now irreversible, in the compiled manifest and in the source the hash covers).
// Its hash is new, so it waits for review with a diff against what was approved, its tools are off
// MCP, and the old grants don't carry. Approved and granted again, the now-irreversible tool asks
// the person in the confirmation panel: a decline reaches the client as declined, an approval runs it.

import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import {
  appWindows,
  CONTROL,
  callTool,
  changedAdapterBuild,
  chooseStore,
  clickClosing,
  connectMcp,
  type Launched,
  launch,
  type McpClient,
  siteTrolley,
  type ToolResult,
  tempDir,
  windowWithTitle,
} from './harness'

test.describe.configure({ mode: 'serial' })

const TOOLS = [
  'woolworths_add_to_cart',
  'woolworths_get_cart',
  'woolworths_get_product',
  'woolworths_remove_from_cart',
  'woolworths_search_products',
  'woolworths_set_cart_quantity',
  'woolworths_update_cart',
]

let userData: string
let launched: Launched | null = null
let control: Page
let client: McpClient | null = null
let firstHash = ''
let stockcode = 0

test.beforeAll(() => {
  userData = tempDir('update')
})

test.afterAll(async () => {
  await client?.close().catch(() => undefined)
  await launched?.close()
  if (userData !== undefined) rmSync(userData, { recursive: true, force: true })
})

// biome-ignore lint/correctness/noEmptyPattern: Playwright needs the fixtures argument destructured
test.afterEach(async ({}, testInfo) => {
  if (launched !== null && testInfo.status !== testInfo.expectedStatus) {
    for (const [i, page] of appWindows(launched.app).entries())
      await page.screenshot({ path: testInfo.outputPath(`window-${i}.png`) }).catch(() => undefined)
    await testInfo.attach('app-log', { body: launched.logs.join('') })
  }
})

async function relaunch(appPath?: string): Promise<void> {
  await client?.close().catch(() => undefined)
  await launched?.close()
  launched = await launch(userData, appPath)
  control = await windowWithTitle(launched.app, CONTROL)
  client = await connectMcp(control, userData)
}

/**
 * The last few audit events and the login marker, for a failure message: types, outcomes, codes and
 * times only, never secrets.
 */
function recentAudit(): string {
  let marker: string
  try {
    marker = readFileSync(join(userData, 'login-markers', 'woolworths.login-attempt'), 'utf8').trim()
  } catch (error) {
    marker = `none (${(error as NodeJS.ErrnoException).code ?? String(error)})`
  }
  try {
    const events = readFileSync(join(userData, 'audit.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .slice(-16)
      .map((line) => {
        const record = JSON.parse(line) as { ts?: unknown; at?: unknown; event: unknown }
        return `${String(record.ts ?? record.at ?? '')} ${JSON.stringify(record.event)}`
      })
      .join('\n')
    return `login marker: ${marker}\n${events}`
  } catch (error) {
    return `login marker: ${marker}\nno audit log: ${String(error)}`
  }
}

function mcp(): McpClient {
  if (client === null) throw new Error('no client')
  return client
}

async function grantBoth(hash: string): Promise<void> {
  const detail = await control.evaluate(() => window.valet?.adapters.get('woolworths'))
  const login = detail?.secretRequests.find((s) => s.name === 'login')?.origins ?? []
  await control.evaluate(
    ({ hash, login }) =>
      Promise.all([
        window.valet?.grants.make({
          adapterId: 'woolworths',
          adapterHash: hash,
          secret: 'login',
          provider: 'fake',
          itemRef: 'demo-woolworths',
          origins: login,
        }),
        window.valet?.grants.make({
          adapterId: 'woolworths',
          adapterHash: hash,
          secret: 'messages',
          provider: 'messages',
          itemRef: 'Woolworths',
          origins: login,
        }),
      ]),
    { hash, login },
  )
}

test('the built app, approved and granted, logs in and adds a line', async () => {
  await relaunch()
  const pending = await control.evaluate(() => window.valet?.approvals.pending())
  firstHash = pending?.find((p) => p.adapterId === 'woolworths')?.to.hash ?? ''
  expect(firstHash).toMatch(/^[0-9a-f]{64}$/)
  await control.evaluate((hash) => window.valet?.approvals.approve('woolworths', hash), firstHash)
  await grantBoth(firstHash)
  await expect.poll(async () => (await mcp().listTools()).tools.map((t) => t.name).sort()).toEqual(TOOLS)
  // Chosen once: the choice belongs to the adapter, not to a hash, so the changed bundle keeps it.
  await chooseStore(control)

  const found = await callTool(mcp(), 'woolworths_search_products', { query: 'bread' })
  stockcode = (found.structured as { products: { stockcode: number }[] }).products[0]?.stockcode ?? 0
  const added = await callTool(mcp(), 'woolworths_add_to_cart', { stockcode, quantity: 1 })
  expect(added.isError, added.text).toBe(false)
  if (launched === null) throw new Error('not launched')
  expect(await siteTrolley(launched)).toEqual([{ stockcode, quantity: 1 }])
})

test('a restart of the same build keeps the approval and the grants', async () => {
  // The demo site comes back on the same ports, so the adapter's origins, and its hash, are the same.
  await relaunch()
  // The other built-ins (no login, public data) stay unreviewed here; only Woolworths matters.
  expect(
    (await control.evaluate(() => window.valet?.approvals.pending()))?.filter(
      (p) => p.adapterId === 'woolworths',
    ),
  ).toEqual([])
  const detail = await control.evaluate(() => window.valet?.adapters.get('woolworths'))
  expect(detail?.hash).toBe(firstHash)
  expect(detail?.approval).toBe('approved')
  expect(detail?.secretRequests.map((s) => s.grant?.itemTitle)).toEqual(['Woolworths (demo account)'])
  await expect.poll(async () => (await mcp().listTools()).tools.map((t) => t.name).sort()).toEqual(TOOLS)
  // And the restarted demo works: the fake is new, so the cart is empty and the login runs again.
  const cart = await callTool(mcp(), 'woolworths_get_cart', {})
  expect(cart.isError, `${cart.text}\n${recentAudit()}`).toBe(false)
  expect(cart.structured).toMatchObject({ items: [] })
})

test('the changed bundle waits for review: tools off MCP, no grants, a diff against the approved one', async () => {
  // A new launch is a new fake site: its trolley starts empty, and Auth0's session is gone.
  await relaunch(changedAdapterBuild())
  const pending = (await control.evaluate(() => window.valet?.approvals.pending()))?.filter(
    (p) => p.adapterId === 'woolworths',
  )
  expect(pending).toHaveLength(1)
  const review = pending?.[0]
  expect(review?.from?.hash).toBe(firstHash)
  expect(review?.to.hash).toMatch(/^[0-9a-f]{64}$/)
  expect(review?.to.hash).not.toBe(firstHash)
  expect(review?.diff.tools.added).toEqual([
    {
      name: 'remove_from_cart',
      title: 'Remove from cart',
      sideEffect: 'irreversible',
      destructive: true,
      idempotent: false,
    },
  ])
  expect(review?.diff.tools.removed).toEqual([
    {
      name: 'remove_from_cart',
      title: 'Remove from cart',
      sideEffect: 'write',
      destructive: true,
      idempotent: true,
    },
  ])
  expect(review?.files.map((f) => [f.path, f.status])).toEqual([['src/manifest.ts', 'modified']])

  // Nothing of the new bundle is callable, and nothing granted for the old hash reaches it.
  expect((await mcp().listTools()).tools.map((t) => t.name)).toEqual([])
  const refused = await callTool(mcp(), 'woolworths_get_cart', {})
  expect(refused.isError).toBe(true)
  const detail = await control.evaluate(() => window.valet?.adapters.get('woolworths'))
  expect(detail?.approval).toBe('unapproved')
  expect(detail?.secretRequests.map((s) => s.grant)).toEqual([null])
  expect(detail?.messages.map((m) => m.grant)).toEqual([null])
  // The old hash can't be approved in its place.
  const old = await control.evaluate(
    (hash) =>
      window.valet?.approvals.approve('woolworths', hash).then(
        () => 'approved',
        () => 'refused',
      ),
    firstHash,
  )
  expect(old).toBe('refused')
})

test('the review screen shows the change, and Approve waits for the acknowledgement', async () => {
  await expect(control.getByText('Woolworths 0.4.0 is ready for review.')).toBeVisible()
  await control
    .locator('.callout', { hasText: 'Woolworths' })
    .getByRole('link', { name: 'Review changes' })
    .click()
  await expect(control.getByText('This update asks for more')).toBeVisible()
  await expect(control.getByText('remove_from_cart').first()).toBeVisible()
  await expect(control.getByText('src/manifest.ts')).toBeVisible()
  const approve = control.getByRole('button', { name: 'Approve 0.4.0' })
  await expect(approve).toBeDisabled()
  await control.getByRole('checkbox', { name: 'I’ve read the highlighted additions' }).check()
  await approve.click()
  await expect.poll(async () => (await mcp().listTools()).tools.map((t) => t.name).sort()).toEqual(TOOLS)
  const detail = await control.evaluate(() => window.valet?.adapters.get('woolworths'))
  expect(detail?.approval).toBe('approved')
  expect(detail?.secretRequests.map((s) => s.grant)).toEqual([null])
})

test('without new grants the login can’t fill; granted again, the next call logs in and works', async () => {
  if (launched === null) throw new Error('not launched')
  const ungranted = await callTool(mcp(), 'woolworths_add_to_cart', { stockcode, quantity: 1 })
  expect(ungranted.isError).toBe(true)
  expect(ungranted.text).toMatch(/secret-fill: not-granted/)
  expect(await siteTrolley(launched)).toEqual([])

  // The person grants the new hash in the sheet, as the adapter page offers.
  await control.getByRole('link', { name: 'Woolworths' }).first().click()
  await control.getByRole('link', { name: 'Grant…' }).first().click()
  const sheet = control.getByRole('dialog', { name: 'Grant a secret' })
  await sheet.getByText('Woolworths (demo account)').click()
  await sheet.getByRole('button', { name: 'Grant', exact: true }).click()
  await expect(sheet).toBeHidden()
  await control.getByRole('link', { name: 'Grant…' }).first().click()
  await expect(sheet.getByText('Let Woolworths read one-time codes from Messages')).toBeVisible()
  await sheet.getByRole('button', { name: 'Grant', exact: true }).click()
  await expect(sheet).toBeHidden()

  // The failed login's hold on automatic logins is released by the grant: the agent's retry logs in.
  const added = await callTool(mcp(), 'woolworths_add_to_cart', { stockcode, quantity: 3 })
  expect(added.isError, added.text).toBe(false)
  expect(await siteTrolley(launched)).toEqual([{ stockcode, quantity: 3 }])
})

async function confirmationPanel(): Promise<Page> {
  if (launched === null) throw new Error('not launched')
  return windowWithTitle(launched.app, 'Valet: confirm', 30_000)
}

test('the irreversible tool asks first; Decline in the panel returns declined to the client', async () => {
  const call: Promise<ToolResult> = callTool(mcp(), 'woolworths_remove_from_cart', { stockcode })
  const panel = await confirmationPanel()
  await expect(panel.getByText('Remove from cart').first()).toBeVisible()
  // Decline has the focus, so Return declines, as a person typing elsewhere might press it.
  await expect(panel.getByRole('button', { name: 'Decline' })).toBeFocused()
  await clickClosing(panel.getByRole('button', { name: 'Decline' }))
  const result = await call
  expect(result.isError).toBe(true)
  expect(result.text).toMatch(/declined/)
  if (launched === null) throw new Error('not launched')
  expect(await siteTrolley(launched)).toEqual([{ stockcode, quantity: 3 }])
})

test('a client that cancels while the panel waits: the panel closes, and the tool never runs', async () => {
  if (launched === null) throw new Error('not launched')
  const cancel = new AbortController()
  const call = mcp()
    .callTool({ name: 'woolworths_remove_from_cart', arguments: { stockcode } }, undefined, {
      signal: cancel.signal,
      timeout: 150_000,
    })
    .then(
      () => 'answered',
      () => 'cancelled',
    )
  const panel = await confirmationPanel()
  await expect(panel.getByText('Remove from cart').first()).toBeVisible()
  cancel.abort()
  expect(await call).toBe('cancelled')
  // The cancel reaches the runtime: the panel goes, the answer is on record as declined, and the call
  // as aborted.
  await expect.poll(() => panel.isClosed()).toBe(true)
  const finished = () =>
    readFileSync(join(userData, 'audit.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as { event: Record<string, unknown> }).event)
      .filter((e) => e['type'] === 'tool-finished' || e['type'] === 'confirmation')
      .slice(-2)
  await expect.poll(finished).toEqual([
    expect.objectContaining({ type: 'confirmation', answer: 'declined' }),
    expect.objectContaining({
      type: 'tool-finished',
      outcome: 'failed',
      stage: 'tool-run',
      errorClass: 'aborted',
    }),
  ])
  expect(await siteTrolley(launched)).toEqual([{ stockcode, quantity: 3 }])
})

test('only the panel itself can approve; approved there once armed, the tool runs and the line goes', async () => {
  const call: Promise<ToolResult> = callTool(mcp(), 'woolworths_remove_from_cart', { stockcode })
  const panel = await confirmationPanel()
  const id = /\[([^\]]+)\]$/.exec(await panel.title())?.[1] ?? ''
  expect(id).not.toBe('')
  // The control panel is one of the app's windows, but not the one opened for this confirmation.
  const elsewhere = await control.evaluate(
    (id) =>
      window.valet?.answerConfirmation(id, true).then(
        () => 'approved',
        () => 'refused',
      ),
    id,
  )
  expect(elsewhere).toBe('refused')
  const approve = panel.getByRole('button', { name: 'Approve Remove from cart' })
  await expect(approve).toBeVisible()
  await expect(approve).toBeEnabled()
  await clickClosing(approve)
  const result = await call
  expect(result.isError, result.text).toBe(false)
  expect(result.structured).toMatchObject({ stockcode, removed: true })
  if (launched === null) throw new Error('not launched')
  expect(await siteTrolley(launched)).toEqual([])
})
