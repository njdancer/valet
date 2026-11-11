// QA screens: every surface of the real app (demo mode) at the real window sizes, in light and dark,
// with probes a screenshot can't show (sideways overflow, selectable prose, unnamed controls,
// pointer cursors on things that aren't controls). For the persona QA rounds, not a pass/fail test:
//
//   VALET_E2E_QA=1 pnpm --filter @valet/desktop exec playwright test -c e2e/playwright.config.ts qa-screens
//
// Writes PNGs and report.jsonl to $VALET_QA_OUT (default out/qa-screens). The qa-screens workflow
// runs it on a macOS runner and pushes the result to a qa-screens/<run id> branch.
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Page, test } from '@playwright/test'
import {
  appDir,
  blockSite,
  CONTROL,
  COPY_ITEM_ID,
  callTool,
  changedAdapterBuild,
  chooseStore,
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
test.skip(process.env['VALET_E2E_QA'] !== '1', 'set VALET_E2E_QA=1')

const OUT = process.env['VALET_QA_OUT'] ?? join(appDir, 'out/qa-screens')
const THEMES = ['light', 'dark'] as const
const REPORT = join(OUT, 'report.jsonl')
let userData: string | undefined
let launched: Launched | null = null
let control: Page
let client: McpClient | null = null

test.beforeAll(() => {
  mkdirSync(OUT, { recursive: true })
  writeFileSync(REPORT, '')
})
test.afterAll(async () => {
  await client?.close().catch(() => undefined)
  await launched?.close()
  if (userData !== undefined) rmSync(userData, { recursive: true, force: true })
})

async function start(appPath?: string, setup = false): Promise<void> {
  await client?.close().catch(() => undefined)
  await launched?.close()
  if (userData === undefined) throw new Error('no userData')
  launched = await launch(userData, appPath, { setup })
  control = await windowWithTitle(launched.app, CONTROL)
  await connectFakeOnePassword(launched, control)
  client = await connectMcp(control, userData, 'Claude Code')
}

function mcp(): McpClient {
  if (client === null) throw new Error('no client')
  return client
}

/** Facts about a page the screenshot can't show. */
async function probe(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const out: Record<string, unknown> = {}
    const doc = document.scrollingElement ?? document.documentElement
    out['docOverflowX'] = doc.scrollWidth - doc.clientWidth
    // Horizontally overflowing elements (content cut off or scrolling sideways).
    const over: string[] = []
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
      const cs = getComputedStyle(el)
      if (
        el.scrollWidth > el.clientWidth + 2 &&
        (cs.overflowX === 'hidden' || cs.overflowX === 'auto' || cs.overflowX === 'scroll') &&
        el.clientWidth > 0
      ) {
        if (cs.textOverflow === 'ellipsis') continue
        over.push(
          `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)} ${el.scrollWidth}>${el.clientWidth}`,
        )
      }
      const r = el.getBoundingClientRect()
      if (r.right > window.innerWidth + 1 && r.width > 0 && cs.position !== 'fixed') {
        over.push(
          `OFFSCREEN ${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)} right=${Math.round(r.right)}`,
        )
      }
    }
    out['overflow'] = over.slice(0, 15)
    // Selectable prose: text nodes in non-editable elements whose user-select isn't none.
    const sel: string[] = []
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    let n: Node | null = walker.nextNode()
    while (n !== null) {
      const t = (n.textContent ?? '').trim()
      const el = n.parentElement
      if (t.length > 2 && el !== null && el.offsetParent !== null) {
        const us = getComputedStyle(el).userSelect
        if (us !== 'none' && el.closest('input,textarea,[contenteditable]') === null)
          sel.push(`${el.tagName.toLowerCase()}:${t.slice(0, 40)}`)
      }
      n = walker.nextNode()
    }
    out['selectable'] = sel.slice(0, 25)
    out['selectableCount'] = sel.length
    // Unnamed controls.
    const unnamed: string[] = []
    for (const el of Array.from(
      document.querySelectorAll<HTMLElement>(
        'button,a,[role=button],[role=link],input,select,[role=tab],[role=switch],[role=checkbox]',
      ),
    )) {
      if (el.offsetParent === null) continue
      const name =
        (el.getAttribute('aria-label') ?? '') +
        (el.getAttribute('aria-labelledby') ?? '') +
        (el.textContent ?? '').trim() +
        (el.getAttribute('title') ?? '')
      const id = el.id
      const labelled = id !== '' && document.querySelector(`label[for="${id}"]`) !== null
      if (name === '' && !labelled && el.closest('label') === null) unnamed.push(el.outerHTML.slice(0, 120))
    }
    out['unnamed'] = unnamed
    // Pointer cursor on things that aren't controls (looks interactive, isn't), and controls without it.
    const fake: string[] = []
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
      if (el.offsetParent === null) continue
      const cs = getComputedStyle(el)
      if (
        cs.cursor === 'pointer' &&
        el.closest(
          'button,a,label,summary,input,select,[role=button],[role=link],[role=tab],[role=option],[role=menuitem],[role=switch],[role=checkbox],[role=radio],[tabindex]',
        ) === null
      )
        fake.push(
          `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 50)}:${(el.textContent ?? '').trim().slice(0, 30)}`,
        )
    }
    out['pointerNotControl'] = fake.slice(0, 10)
    // Links with href="#" or empty, and buttons that are disabled with no reason.
    out['deadLinks'] = Array.from(document.querySelectorAll('a'))
      .filter(
        (a) => a.offsetParent !== null && (a.getAttribute('href') === null || a.getAttribute('href') === '#'),
      )
      .map((a) => a.outerHTML.slice(0, 100))
    out['disabled'] = Array.from(document.querySelectorAll<HTMLButtonElement>('button:disabled'))
      .filter((b) => b.offsetParent !== null)
      .map((b) => (b.textContent ?? b.getAttribute('aria-label') ?? '').trim().slice(0, 40))
    out['h1'] = Array.from(document.querySelectorAll('h1')).map((h) => h.textContent)
    out['text'] = (document.body.innerText ?? '').replace(/\s+\n/g, '\n').slice(0, 3000)
    out['hash'] = location.hash
    return out
  })
}

async function theme(t: 'light' | 'dark'): Promise<void> {
  if (launched === null) throw new Error('not launched')
  await launched.app.evaluate(({ nativeTheme }, t) => {
    nativeTheme.themeSource = t
  }, t)
}

/** One shot per theme: `name` in light, `name.dark` in dark. */
async function shot(page: Page, name: string, width = 1180, height = 780, full = false): Promise<void> {
  for (const t of THEMES) {
    await theme(t)
    await shotOne(page, t === 'light' ? name : `${name}.dark`, width, height, full)
  }
  await theme('light')
}

async function shotOne(
  page: Page,
  name: string,
  width: number,
  height: number,
  full: boolean,
): Promise<void> {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  await page.waitForTimeout(450)
  await page.screenshot({ path: join(OUT, `${name}.png`), animations: 'disabled', fullPage: full })
  const facts = await probe(page)
  appendFileSync(REPORT, `${JSON.stringify({ name, width, height, ...(facts as object) })}\n`)
  await cdp.send('Emulation.clearDeviceMetricsOverride')
  await cdp.detach()
}

/** Both the default and the minimum control-panel size. */
async function both(name: string): Promise<void> {
  await shot(control, name)
  await shot(control, `${name}@min`, 880, 560)
}

async function route(hash: string): Promise<void> {
  await control.evaluate((hash) => window.valet?.app.openControlPanel(hash as `#/${string}`), hash)
  await control.waitForTimeout(500)
}

async function tray(name: string): Promise<void> {
  if (launched === null) throw new Error('not launched')
  await launched.app.evaluate(() => {
    ;(globalThis as unknown as { __valetE2eTray: { toggle: () => void } }).__valetE2eTray.toggle()
  })
  const t = await windowWithTitle(launched.app, 'Valet menu', 15_000)
  await t.waitForTimeout(800)
  const size = await t.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }))
  await shot(t, name, size.w, size.h)
  await launched.app.evaluate(() => {
    ;(globalThis as unknown as { __valetE2eTray: { toggle: () => void } }).__valetE2eTray.toggle()
  })
}

const PAGES = [
  ['needs-you', '#/needs-you'],
  ['sites', '#/sites'],
  ['site-overview', '#/sites/woolworths/overview'],
  ['site-tools', '#/sites/woolworths/tools'],
  ['site-permissions', '#/sites/woolworths/permissions'],
  ['site-versions', '#/sites/woolworths/versions'],
  ['yahoo-overview', '#/sites/yahoo-finance/overview'],
  ['calls', '#/activity/calls'],
  ['audit', '#/activity/audit'],
  ['connections', '#/connections'],
  ['remote', '#/remote'],
  ['secrets', '#/secrets'],
  ['settings-general', '#/settings/general'],
  ['settings-notifications', '#/settings/notifications'],
  ['settings-data', '#/settings/data'],
  ['settings-updates', '#/settings/updates'],
  ['settings-reset', '#/settings/reset'],
] as const

test('setup flow, first launch', async () => {
  userData = tempDir('qa-setup')
  await start(undefined, true)
  await control.waitForTimeout(1500)
  await both('setup-0')
  // Walk forward with the primary button where one exists.
  for (let i = 1; i <= 8; i++) {
    const buttons = await control.getByRole('button').allTextContents()
    appendFileSync(REPORT, `${JSON.stringify({ name: `setup-${i}-buttons`, buttons })}\n`)
    const next = control
      .getByRole('button', { name: /^(Get started|Continue|Next|Skip.*|Set up later|Done)/ })
      .first()
    if (!(await next.isVisible().catch(() => false))) break
    await next.click().catch(() => undefined)
    await control.waitForTimeout(800)
    await shot(control, `setup-${i}`)
  }
})

test('first run (no setup): every page', async () => {
  await launched?.close()
  launched = null
  if (userData !== undefined) rmSync(userData, { recursive: true, force: true })
  userData = tempDir('qa')
  await start()
  for (const [name, hash] of PAGES) {
    await route(hash)
    await both(`fr-${name}`)
  }
  await route('#/sites/woolworths/versions/review')
  await both('fr-review')
  await shot(control, 'fr-review-full', 1180, 780, true)
  await tray('fr-tray')
})

let stockcode = 0
test('approved, granted, store, some calls: every page', async () => {
  await route('#/sites/woolworths/versions/review')
  const ack = control.getByRole('checkbox', { name: /I’ve read/ })
  if (await ack.isVisible().catch(() => false)) await ack.check()
  await control
    .getByRole('button', { name: /^Approve/ })
    .first()
    .click()
  await control.waitForTimeout(800)
  await shot(control, 'after-approve')
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
  await chooseStore(control)
  const found = await callTool(mcp(), 'woolworths_search_products', { query: 'milk' })
  appendFileSync(REPORT, `${JSON.stringify({ name: 'tool-search', text: found.text.slice(0, 600) })}\n`)
  stockcode = (found.structured as { products: { stockcode: number }[] }).products[0]?.stockcode ?? 0
  const added = await callTool(mcp(), 'woolworths_add_to_cart', { stockcode, quantity: 2 })
  appendFileSync(REPORT, `${JSON.stringify({ name: 'tool-add', text: added.text.slice(0, 600) })}\n`)
  const cart = await callTool(mcp(), 'woolworths_get_cart', {})
  appendFileSync(REPORT, `${JSON.stringify({ name: 'tool-cart', text: cart.text.slice(0, 800) })}\n`)
  const q = await callTool(mcp(), 'yahoo_finance_get_quote', { symbol: 'AAPL' }).catch(
    (e) => ({ isError: true, text: String(e) }) as ToolResult,
  )
  appendFileSync(REPORT, `${JSON.stringify({ name: 'tool-yahoo', text: q.text.slice(0, 400) })}\n`)
  for (const [name, hash] of PAGES) {
    await route(hash)
    await both(`ok-${name}`)
  }
  const runs = await control.evaluate(() => window.valet?.runs.list())
  const first = runs?.findLast((r) => r.tool === 'add_to_cart')
  await route(`#/activity/calls/${first?.callId ?? ''}`)
  await both('ok-call-trace')
  await shot(control, 'ok-call-trace-full', 1180, 780, true)
  await route('#/sites/woolworths/login/login')
  await both('ok-login-page')
  await route('#/connections')
  const link = control.getByRole('link', { name: /Claude Code/ }).first()
  if (await link.isVisible().catch(() => false)) {
    await link.click()
    await control.waitForTimeout(500)
    await both('ok-client')
  }
  await tray('ok-tray')
  // Palette
  await control.keyboard.press('Meta+k')
  await control.waitForTimeout(400)
  await shot(control, 'ok-palette')
  await control.keyboard.press('Escape')
  await control.keyboard.press('Control+k')
  await control.waitForTimeout(400)
  await shot(control, 'ok-palette-ctrl')
  await control.keyboard.press('Escape')
})

test('login banner', async () => {
  await control.evaluate(() => window.valet?.openLoginWindow('woolworths'))
  if (launched === null) throw new Error('not launched')
  const banner = await windowWithTitle(launched.app, 'Valet: sign in')
  await banner.waitForTimeout(600)
  const size = await banner.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
  await shot(banner, 'banner', size.width, size.height)
  await route('#/needs-you')
  await both('banner-needs-you')
  await tray('banner-tray')
  await banner
    .getByRole('button', { name: /Cancel/ })
    .click()
    .catch(() => undefined)
})

/** Clicks the first visible control matching `name`, if any; records whether it was there. */
async function tryClick(
  page: Page,
  role: 'button' | 'link' | 'switch' | 'menuitem' | 'tab',
  name: RegExp | string,
): Promise<boolean> {
  const target = page.getByRole(role, { name }).first()
  const found = await target.isVisible().catch(() => false)
  appendFileSync(REPORT, `${JSON.stringify({ name: 'click', role, target: String(name), found })}\n`)
  if (found) {
    await target.click().catch(() => undefined)
    await page.waitForTimeout(500)
  }
  return found
}

/** Where focus goes over `presses` Tabs from the top of the page (P5): name, role, and a visible ring. */
async function tabWalk(page: Page, label: string, presses = 20): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  const stops: string[] = []
  for (let i = 0; i < presses; i++) {
    await page.keyboard.press('Tab')
    stops.push(
      await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null
        if (el === null || el === document.body) return '(body)'
        const cs = getComputedStyle(el)
        const ring =
          cs.outlineStyle !== 'none' && cs.outlineWidth !== '0px'
            ? 'ring'
            : cs.boxShadow !== 'none'
              ? 'shadow'
              : 'NO-RING'
        const name = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40)
        return `${el.tagName.toLowerCase()}[${el.getAttribute('role') ?? ''}] ${name} (${ring})`
      }),
    )
  }
  appendFileSync(REPORT, `${JSON.stringify({ name: `tab-${label}`, stops })}\n`)
}

test('the surfaces round 1 touched least', async () => {
  // Keyboard first (P5): the shell and a site page.
  await route('#/needs-you')
  await tabWalk(control, 'needs-you')
  await route('#/sites/woolworths')
  await tabWalk(control, 'site', 25)

  // Connections: add an app, then a client's two "asks first" dialogs.
  await route('#/connections')
  if (await tryClick(control, 'button', /^Add an app/)) {
    await shot(control, 'r2-add-app')
    await control.keyboard.press('Escape')
    await control.waitForTimeout(300)
    appendFileSync(
      REPORT,
      `${JSON.stringify({ name: 'focus-after-sheet', focused: await control.evaluate(() => document.activeElement?.outerHTML.slice(0, 120)) })}\n`,
    )
  }
  await route('#/connections')
  if (await tryClick(control, 'link', /^Claude Code/)) {
    if (await tryClick(control, 'button', /^Reset access/)) {
      await shot(control, 'r2-reset-access')
      await control.keyboard.press('Escape')
    }
    if (await tryClick(control, 'button', /^Revoke/)) {
      await shot(control, 'r2-revoke')
      await control.keyboard.press('Escape')
    }
  }

  // Remote access: a public name, then on.
  await route('#/connections/remote')
  const field = control.getByPlaceholder('valet.example.com')
  if (await field.isVisible().catch(() => false)) {
    await field.fill('valet.example.com')
    await tryClick(control, 'button', /^Add$/)
    await shot(control, 'r2-remote-named')
    await tryClick(control, 'switch', /Remote access/)
    await control.waitForTimeout(800)
    await shot(control, 'r2-remote-on')
    await route('#/connections')
    await shot(control, 'r2-connections-remote-on')
    await tray('r2-tray-remote-on')
    await route('#/connections/remote')
    await tryClick(control, 'switch', /Remote access/)
  }

  // The endpoint off, then back on.
  await route('#/connections')
  if (await tryClick(control, 'switch', /endpoint|Endpoint|On/)) {
    await shot(control, 'r2-endpoint-off')
    await route('#/needs-you')
    await shot(control, 'r2-endpoint-off-needs-you')
    await route('#/connections')
    await tryClick(control, 'switch', /endpoint|Endpoint|Off/)
  }

  // Pause one site, then all of Valet; the lock-down dialog.
  await route('#/sites/woolworths')
  if (await tryClick(control, 'button', /^Pause site/)) {
    await shot(control, 'r2-site-paused')
    await route('#/sites')
    await shot(control, 'r2-sites-site-paused')
    await route('#/sites/woolworths')
    await tryClick(control, 'button', /^Resume/)
  }
  if (await tryClick(control, 'button', /^Pause Valet/)) {
    await shot(control, 'r2-valet-paused')
    await tray('r2-tray-paused')
    await tryClick(control, 'button', /^Resume/)
  }
  await route('#/needs-you')
  const more = control.getByRole('button', { name: /More|Pause options|options/i }).first()
  if (await more.isVisible().catch(() => false)) {
    await more.click()
    await control.waitForTimeout(300)
    await shot(control, 'r2-pause-menu')
    if (await tryClick(control, 'menuitem', /Lock down/)) {
      await shot(control, 'r2-lock-down-dialog')
      await control.keyboard.press('Escape')
    } else await control.keyboard.press('Escape')
  }

  // Activity: a filter, an audit record, a search.
  await route('#/activity/calls?outcome=failed')
  await shot(control, 'r2-calls-failed')
  await route('#/activity/calls?site=woolworths&tool=add_to_cart')
  await shot(control, 'r2-calls-filtered')
  await route('#/activity/audit')
  const row = control.getByRole('row').nth(3)
  if (await row.isVisible().catch(() => false)) {
    await row.click().catch(() => undefined)
    await control.waitForTimeout(500)
    await shot(control, 'r2-audit-record')
  }
  await route('#/activity/audit?category=logins')
  await shot(control, 'r2-audit-logins')

  // Secrets with a login, and the login's own page.
  await route('#/secrets')
  await shot(control, 'r2-secrets')
  await shot(control, 'r2-secrets-full', 1180, 780, true)
  await route('#/secrets')
  if (await tryClick(control, 'link', /^Woolworths login/)) await shot(control, 'r2-login-page')

  // 200% text (IA principle 12): the shell and a site at twice the size.
  if (launched !== null) {
    await launched.app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows())
        if (w.getTitle().includes('[control]')) w.webContents.setZoomFactor(2)
    })
    for (const [name, hash] of [
      ['r2-zoom-needs-you', '#/needs-you'],
      ['r2-zoom-site', '#/sites/woolworths'],
      ['r2-zoom-calls', '#/activity/calls'],
    ] as const) {
      await route(hash)
      await shot(control, name)
    }
    await launched.app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows())
        if (w.getTitle().includes('[control]')) w.webContents.setZoomFactor(1)
    })
  }
})

test('update pending, confirmation, breaker', async () => {
  await start(changedAdapterBuild())
  await route('#/sites/woolworths')
  await both('upd-site')
  await route('#/needs-you')
  await both('upd-needs-you')
  await route('#/sites')
  await both('upd-sites')
  await route('#/sites/woolworths/versions')
  await both('upd-versions')
  await tray('upd-tray')
  await route('#/sites/woolworths/versions/review')
  await both('upd-review')
  await shot(control, 'upd-review-full', 1180, 780, true)
  const ack = control.getByRole('checkbox', { name: /I’ve read/ })
  if (await ack.isVisible().catch(() => false)) await ack.check()
  await control
    .getByRole('button', { name: /^Approve/ })
    .first()
    .click()
  await control.waitForTimeout(800)
  await both('upd-after-approve')
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
  const panel = await windowWithTitle(launched.app, 'Valet: confirm', 90_000)
  await panel.waitForTimeout(600)
  await shot(panel, 'confirm', 460, 620)
  await route('#/needs-you')
  await both('confirm-needs-you')
  await tray('confirm-tray')
  // Keyboard: what is focused in the confirmation window?
  const focused = await panel.evaluate(() => document.activeElement?.outerHTML.slice(0, 200))
  appendFileSync(REPORT, `${JSON.stringify({ name: 'confirm-focus', focused })}\n`)
  await panel
    .getByRole('button', { name: 'Decline' })
    .click()
    .catch(() => undefined)
  const r = await call
  appendFileSync(REPORT, `${JSON.stringify({ name: 'tool-declined', text: r.text })}\n`)
  // P7: a confirmation nobody answers becomes "Missed" on Needs you and in the menu bar.
  const unanswered: Promise<ToolResult> = callTool(mcp(), 'woolworths_remove_from_cart', { stockcode })
  await windowWithTitle(launched.app, 'Valet: confirm', 90_000)
  const timedOut = await unanswered
  appendFileSync(REPORT, `${JSON.stringify({ name: 'tool-timed-out', text: timedOut.text })}\n`)
  await route('#/needs-you')
  await shot(control, 'missed-needs-you')
  await tray('missed-tray')
  await blockSite(launched, true)
  const b = await callTool(mcp(), 'woolworths_search_products', { query: 'bread' })
  appendFileSync(REPORT, `${JSON.stringify({ name: 'tool-blocked', text: b.text })}\n`)
  await route('#/sites')
  await both('brk-sites')
  await route('#/sites/woolworths')
  await both('brk-site')
  await route('#/activity/calls')
  await both('brk-calls')
  await tray('brk-tray')
  writeFileSync(join(OUT, 'logs.txt'), launched.logs.join(''))
})
