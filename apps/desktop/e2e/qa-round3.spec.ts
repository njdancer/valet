// QA round 3: an adversarial, exploratory pass over the order path in the real app (demo mode). Odd
// inputs, rapid clicking, resizing, keyboard only, error and empty states, interrupted flows. Not a
// pass/fail test: it records what happened to $VALET_QA_OUT/round3.jsonl, with screenshots.
//
//   VALET_E2E_QA=1 pnpm --filter @valet/desktop exec playwright test -c e2e/playwright.config.ts qa-round3
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Page, test } from '@playwright/test'
import {
  appDir,
  blockSite,
  CONTROL,
  COPY_ITEM_ID,
  callTool,
  callToolOnce,
  chooseStore,
  connectFakeOnePassword,
  connectMcp,
  type Launched,
  launch,
  type McpClient,
  siteTrolley,
  tempDir,
  windowWithTitle,
} from './harness'

test.describe.configure({ mode: 'serial', timeout: 900_000 })
test.skip(process.env['VALET_E2E_QA'] !== '1', 'set VALET_E2E_QA=1')

const OUT = process.env['VALET_QA_OUT'] ?? join(appDir, 'out/qa-round3')
const REPORT = join(OUT, 'round3.jsonl')
let userData: string | undefined
let launched: Launched | null = null
let control: Page
let client: McpClient | null = null

test.beforeAll(() => {
  mkdirSync(OUT, { recursive: true })
  writeFileSync(REPORT, '')
})
test.afterAll(async () => {
  if (launched !== null) writeFileSync(join(OUT, 'round3-logs.txt'), launched.logs.join(''))
  await client?.close().catch(() => undefined)
  await launched?.close()
  if (userData !== undefined) rmSync(userData, { recursive: true, force: true })
})

function note(name: string, data: unknown): void {
  appendFileSync(REPORT, `${JSON.stringify({ name, data })}\n`)
}

async function snap(page: Page, name: string, width = 1180, height = 780): Promise<void> {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  await page.waitForTimeout(350)
  await page.screenshot({ path: join(OUT, `r3-${name}.png`), animations: 'disabled' })
  await cdp.send('Emulation.clearDeviceMetricsOverride')
  await cdp.detach()
}

async function route(hash: string): Promise<void> {
  await control.evaluate((hash) => window.valet?.app.openControlPanel(hash as `#/${string}`), hash)
  await control.waitForTimeout(400)
}

function mcp(): McpClient {
  if (client === null) throw new Error('no client')
  return client
}

/** Renderer errors and main-process stack traces seen since the last call. */
let seen = 0
function newErrors(): string[] {
  if (launched === null) return []
  const lines = launched.logs.slice(seen)
  seen = launched.logs.length
  return lines
    .join('')
    .split('\n')
    .filter((l) => /error|uncaught|unhandled|TypeError|ReferenceError/i.test(l))
    .filter((l) => !/Autofill|DevTools|GPU|dbus|libva|Fontconfig/i.test(l))
    .slice(0, 20)
}

async function focusName(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null
    if (el === null || el === document.body) return '<body>'
    const name = el.getAttribute('aria-label') ?? (el.textContent ?? '').trim().slice(0, 40)
    return `${el.tagName.toLowerCase()}${el.getAttribute('role') ? `[${el.getAttribute('role')}]` : ''}:${name}`
  })
}

/** Tabs `count` times and records where focus goes; flags visits to <body> and invisible elements. */
async function tabWalk(page: Page, name: string, count = 40): Promise<void> {
  const stops: string[] = []
  for (let i = 0; i < count; i++) {
    await page.keyboard.press('Tab')
    const hidden = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null
      if (el === null || el === document.body) return false
      const r = el.getBoundingClientRect()
      return r.width === 0 || r.height === 0 || r.bottom < 0 || r.top > window.innerHeight + 2000
    })
    stops.push(`${hidden ? 'HIDDEN ' : ''}${await focusName(page)}`)
  }
  note(`tab-${name}`, stops)
}

test('setup, keyboard only, interrupted and resumed', async () => {
  userData = tempDir('qa3')
  launched = await launch(userData, undefined, { setup: true })
  control = await windowWithTitle(launched.app, CONTROL)
  await control.waitForTimeout(1500)
  note('setup-initial-focus', await focusName(control))
  await tabWalk(control, 'setup-welcome', 20)
  // Enter on the primary button, as a keyboard user would.
  for (let i = 0; i < 3; i++) {
    const primary = control.getByRole('button', { name: /^(Get started|Continue|Next)/ }).first()
    if (!(await primary.isVisible().catch(() => false))) break
    await primary.focus()
    await control.keyboard.press('Enter')
    await control.waitForTimeout(700)
    note(`setup-step-${i}`, {
      h1: await control
        .locator('h1')
        .first()
        .textContent()
        .catch(() => null),
      focus: await focusName(control),
    })
    await snap(control, `setup-step-${i}`)
  }
  // Interrupt: quit mid-setup and come back.
  await launched.close()
  launched = await launch(userData, undefined, { setup: true })
  control = await windowWithTitle(launched.app, CONTROL)
  await control.waitForTimeout(1500)
  note('setup-resumed', {
    h1: await control
      .locator('h1')
      .first()
      .textContent()
      .catch(() => null),
  })
  await snap(control, 'setup-resumed')
  // "Finish later" then the app proper.
  const later = control.getByRole('button', { name: /Finish later/ })
  if (await later.isVisible().catch(() => false)) await later.click()
  await control.waitForTimeout(800)
  note('after-finish-later', { hash: await control.evaluate(() => location.hash), errors: newErrors() })
})

test('review and approve: rapid clicks, keyboard', async () => {
  await launched?.close()
  if (userData !== undefined) rmSync(userData, { recursive: true, force: true })
  userData = tempDir('qa3')
  launched = await launch(userData)
  control = await windowWithTitle(launched.app, CONTROL)
  await connectFakeOnePassword(launched, control)
  client = await connectMcp(control, userData, 'Claude Code')
  // A call before anything is approved: what does the agent hear?
  const early = await callToolOnce(mcp(), 'woolworths_search_products', { query: 'milk' })
  note('tool-before-approve', early.text.slice(0, 500))
  await route('#/sites/woolworths/versions/review')
  await tabWalk(control, 'review', 30)
  const ack = control.getByRole('checkbox', { name: /I’ve read/ })
  if (await ack.isVisible().catch(() => false)) await ack.check()
  const approve = control.getByRole('button', { name: /^Approve/ }).first()
  // Five clicks as fast as possible.
  await Promise.all(Array.from({ length: 5 }, () => approve.click({ timeout: 2000 }).catch(() => undefined)))
  await control.waitForTimeout(1200)
  const audit = await control.evaluate(() => window.valet?.audit.page({}))
  note('approve-rapid', {
    hash: await control.evaluate(() => location.hash),
    focus: await focusName(control),
    auditApprovals: JSON.stringify(audit ?? null).match(/adapter-approved/g)?.length ?? 'n/a',
    errors: newErrors(),
  })
  await snap(control, 'after-rapid-approve')
})

test('login: grant sheet opened, escaped, reopened, chosen', async () => {
  await route('#/sites/woolworths')
  const choose = control.getByRole('button', { name: /Choose login/ }).first()
  note('choose-login-visible', await choose.isVisible().catch(() => false))
  if (await choose.isVisible().catch(() => false)) {
    await choose.click()
    await control.waitForTimeout(600)
    await snap(control, 'grant-sheet')
    await control.keyboard.press('Escape')
    await control.waitForTimeout(600)
    note('grant-escape', {
      hash: await control.evaluate(() => location.hash),
      focus: await focusName(control),
    })
    // Reopen and close twice quickly.
    for (let i = 0; i < 3; i++) {
      await choose.click().catch(() => undefined)
      await control.keyboard.press('Escape')
    }
    await control.waitForTimeout(800)
    note('grant-rapid', {
      hash: await control.evaluate(() => location.hash),
      dialogs: await control.getByRole('dialog').count(),
      focus: await focusName(control),
      errors: newErrors(),
    })
  }
  // Make the grants the way the sheet does, so the rest of the path runs.
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
})

test('store: odd postcodes, empty and error states', async () => {
  // A tool call with no store chosen.
  const noStore = await callTool(mcp(), 'woolworths_search_products', { query: 'milk' })
  note('tool-no-store', noStore.text.slice(0, 500))
  await route('#/sites/woolworths')
  await snap(control, 'site-no-store')
  const odd = [
    '',
    '   ',
    'abcd',
    '0000',
    '99999',
    '<b>2000</b>',
    '2000; DROP',
    'x'.repeat(500),
    '２０００',
    ' 2000 ',
  ]
  const replies: Record<string, unknown> = {}
  for (const q of odd) {
    replies[q.slice(0, 30)] = await control.evaluate(async (q) => {
      try {
        const r = await window.valet?.adapters.settingChoices('woolworths', 'store', q)
        return r?.status === 'ok' ? `ok ${r.choices.length}` : JSON.stringify(r).slice(0, 200)
      } catch (e) {
        return `threw ${String(e).slice(0, 200)}`
      }
    }, q)
  }
  note('store-odd-postcodes', replies)
  // The UI: open the chooser and type odd things.
  const change = control.getByRole('button', { name: /Choose store|Change store/ }).first()
  if (await change.isVisible().catch(() => false)) {
    await change.click()
    await control.waitForTimeout(500)
    const box = control.getByRole('dialog').locator('input').first()
    if (await box.isVisible().catch(() => false)) {
      for (const q of ['abcd', '99999', 'x'.repeat(300)]) {
        await box.fill(q)
        await control.keyboard.press('Enter')
        await control.waitForTimeout(2500)
        await snap(control, `store-${q.slice(0, 5)}`)
        note(`store-ui-${q.slice(0, 5)}`, {
          text: (
            await control
              .getByRole('dialog')
              .innerText()
              .catch(() => '')
          ).slice(0, 400),
        })
      }
      // Rapid Enter.
      await box.fill('2000')
      for (let i = 0; i < 5; i++) await control.keyboard.press('Enter')
      await control.waitForTimeout(4000)
      await snap(control, 'store-rapid-enter')
      note('store-rapid-enter', {
        text: (
          await control
            .getByRole('dialog')
            .innerText()
            .catch(() => '')
        ).slice(0, 500),
        errors: newErrors(),
      })
      await control.keyboard.press('Escape')
      await control.waitForTimeout(500)
      note('store-escape-focus', await focusName(control))
    }
  }
  await chooseStore(control)
})

let stockcode = 0
test('tools: odd inputs and concurrent calls', async () => {
  const found = await callTool(mcp(), 'woolworths_search_products', { query: 'milk' })
  stockcode =
    (found.structured as { products?: { stockcode: number }[] } | null)?.products?.[0]?.stockcode ?? 0
  note('search-milk', { isError: found.isError, stockcode })
  const cases: [string, string, Record<string, unknown>][] = [
    ['search-empty', 'woolworths_search_products', { query: '' }],
    ['search-long', 'woolworths_search_products', { query: 'milk '.repeat(1000) }],
    ['search-emoji', 'woolworths_search_products', { query: '🥛 lait écrémé' }],
    ['search-html', 'woolworths_search_products', { query: '<img src=x onerror=alert(1)>' }],
    ['search-missing', 'woolworths_search_products', {}],
    ['search-wrong-type', 'woolworths_search_products', { query: 42 }],
    ['product-unknown', 'woolworths_get_product', { stockcode: 1 }],
    ['product-negative', 'woolworths_get_product', { stockcode: -5 }],
    ['add-zero', 'woolworths_add_to_cart', { stockcode, quantity: 0 }],
    ['add-negative', 'woolworths_add_to_cart', { stockcode, quantity: -3 }],
    ['add-fraction', 'woolworths_add_to_cart', { stockcode, quantity: 2.5 }],
    ['add-huge', 'woolworths_add_to_cart', { stockcode, quantity: 1e9 }],
    ['add-string', 'woolworths_add_to_cart', { stockcode, quantity: 'two' }],
    ['add-unknown', 'woolworths_add_to_cart', { stockcode: 99999999, quantity: 1 }],
    ['set-zero', 'woolworths_set_cart_quantity', { stockcode, quantity: 0 }],
    ['update-empty', 'woolworths_update_cart', { items: [] }],
    [
      'update-31',
      'woolworths_update_cart',
      { items: Array.from({ length: 31 }, (_, i) => ({ stockcode: i + 1, quantity: 1 })) },
    ],
    [
      'update-dupe',
      'woolworths_update_cart',
      {
        items: [
          { stockcode, quantity: 1 },
          { stockcode, quantity: 2 },
        ],
      },
    ],
    ['unknown-tool', 'woolworths_checkout', {}],
    ['internal-tool', 'woolworths_find_stores', { postcode: '2000' }],
  ]
  for (const [name, tool, args] of cases) {
    const r = await callTool(mcp(), tool, args, 120_000)
    note(`tool-${name}`, { isError: r.isError, text: r.text.slice(0, 400) })
  }
  note('trolley-after-odd', await siteTrolley(launched as Launched))
  // Five adds at once, and a search while they run.
  const many = await Promise.all([
    ...Array.from({ length: 5 }, () =>
      callToolOnce(mcp(), 'woolworths_add_to_cart', { stockcode, quantity: 1 }),
    ),
    callToolOnce(mcp(), 'woolworths_search_products', { query: 'bread' }),
  ])
  note(
    'tool-concurrent',
    many.map((r) => `${r.isError ? 'ERR ' : ''}${r.text.slice(0, 160)}`),
  )
  note('trolley-after-concurrent', await siteTrolley(launched as Launched))
  await route('#/activity/calls')
  await snap(control, 'calls-after-odd')
  note('calls-errors', newErrors())
})

test('confirmation: double approve, closed window, pause and lock down mid-call', async () => {
  if (launched === null) throw new Error('not launched')
  // Double-click Approve.
  const first = callTool(mcp(), 'woolworths_remove_from_cart', { stockcode })
  const early = await Promise.race([
    first.then((r) => `returned first: ${r.text.slice(0, 400)}`),
    windowWithTitle(launched.app, 'Valet: confirm', 90_000).then(() => 'window'),
  ])
  note('confirm-opened', early)
  if (early !== 'window') {
    await route('#/needs-you')
    await snap(control, 'confirm-no-window')
    note('confirm-no-window-needs-you', (await control.locator('main').innerText()).slice(0, 800))
    note('confirm-no-window-logs', newErrors())
    return
  }
  let panel = await windowWithTitle(launched.app, 'Valet: confirm', 5_000)
  await panel.waitForTimeout(500)
  note('confirm-focus', await focusName(panel))
  await tabWalk(panel, 'confirm', 12)
  const approve = panel.getByRole('button', { name: /^Approve/ })
  await Promise.all([approve.click().catch(() => undefined), approve.click().catch(() => undefined)])
  const r1 = await first
  note('confirm-double-approve', { isError: r1.isError, text: r1.text.slice(0, 300) })
  note('trolley-after-remove', await siteTrolley(launched))
  // Close the confirmation window instead of answering.
  await callTool(mcp(), 'woolworths_add_to_cart', { stockcode, quantity: 1 })
  const second = callTool(mcp(), 'woolworths_remove_from_cart', { stockcode })
  panel = await windowWithTitle(launched.app, 'Valet: confirm', 90_000)
  await panel.waitForTimeout(500)
  await panel.evaluate(() => window.close())
  await control.waitForTimeout(1500)
  await route('#/needs-you')
  await snap(control, 'confirm-window-closed')
  note('confirm-window-closed-needs-you', (await control.locator('main').innerText()).slice(0, 600))
  // Pause Valet while it waits.
  await control.evaluate(() => window.valet?.app.setPaused(true))
  await control.waitForTimeout(1500)
  const pausedText = await Promise.race([
    second.then((r) => r.text),
    new Promise<string>((d) => setTimeout(() => d('still waiting after 8s'), 8000)),
  ])
  note('confirm-paused-mid-wait', pausedText.slice(0, 400))
  await snap(control, 'paused-mid-confirm')
  await control.evaluate(() => window.valet?.app.setPaused(false))
  const r2 = await second
  note('confirm-second-result', { isError: r2.isError, text: r2.text.slice(0, 300) })
  // A call while the site is blocked, then unblocked.
  await blockSite(launched, true)
  const blocked = await callTool(mcp(), 'woolworths_get_cart', {})
  note('tool-blocked', blocked.text.slice(0, 400))
  await blockSite(launched, false)
  const after = await callTool(mcp(), 'woolworths_get_cart', {})
  note('tool-after-unblock', after.text.slice(0, 400))
  await route('#/sites/woolworths')
  await snap(control, 'site-after-block')
  note('confirm-errors', newErrors())
})

test('resizing and rapid navigation', async () => {
  if (launched === null) throw new Error('not launched')
  const sizes = [
    [600, 400],
    [880, 560],
    [2200, 1300],
  ] as const
  for (const [w, h] of sizes) {
    await launched.app.evaluate(
      ({ BrowserWindow }, { w, h }) => {
        const win = BrowserWindow.getAllWindows().find((b) => b.getTitle().includes('[control]'))
        win?.setSize(w, h)
      },
      { w, h },
    )
    await control.waitForTimeout(500)
    const actual = await control.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
    for (const hash of ['#/sites/woolworths', '#/activity/calls', '#/needs-you']) {
      await route(hash)
      const overflow = await control.evaluate(() => {
        const doc = document.scrollingElement ?? document.documentElement
        return doc.scrollWidth - doc.clientWidth
      })
      note(`resize-${w}x${h}-${hash}`, { actual, overflow })
    }
    await control.screenshot({ path: join(OUT, `r3-resize-${w}x${h}.png`) })
  }
  await launched.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((b) => b.getTitle().includes('[control]'))
      ?.setSize(1180, 780)
  })
  // Shortcuts as fast as they go, then back and forward.
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  for (let i = 0; i < 30; i++) await control.keyboard.press(`${mod}+${(i % 6) + 1}`)
  for (let i = 0; i < 10; i++) await control.keyboard.press(`${mod}+[`)
  for (let i = 0; i < 10; i++) await control.keyboard.press(`${mod}+]`)
  await control.waitForTimeout(800)
  note('rapid-nav', { hash: await control.evaluate(() => location.hash), errors: newErrors() })
  // Bad addresses.
  for (const hash of [
    '#/sites/nope',
    '#/activity/calls/nope',
    '#/sites/woolworths/versions/zzz',
    '#/%%%',
    '#/settings/nope',
  ]) {
    await control.evaluate((h) => {
      location.hash = h
    }, hash)
    await control.waitForTimeout(500)
    note(`bad-route-${hash}`, {
      h1: await control
        .locator('h1')
        .first()
        .textContent()
        .catch(() => null),
      hash: await control.evaluate(() => location.hash),
    })
    await snap(control, `bad-route-${hash.replace(/[^a-z]/g, '')}`)
  }
  // Calls filter with odd text.
  await route('#/activity/calls')
  const search = control
    .getByRole('searchbox')
    .or(control.getByPlaceholder(/Search|Filter/))
    .first()
  if (await search.isVisible().catch(() => false)) {
    for (const q of ['zzzz', '((', '.*', '\\']) {
      await search.fill(q)
      await control.waitForTimeout(400)
      note(`calls-filter-${q}`, (await control.locator('main').innerText()).slice(0, 300))
    }
  }
  note('nav-errors', newErrors())
})
