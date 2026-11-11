#!/usr/bin/env node
// The recorded install-to-order demo, run on a fresh macOS GitHub runner by
// .github/workflows/demo-video.yml. It records the whole screen with ffmpeg while it:
//
// 1. opens Valet Demo's DMG and installs the app into /Applications, as a person would;
// 2. launches it and walks first-run setup in the app's own windows (approve the shop's adapter,
//    grant its login from the test provider, add a chat client and copy its config);
// 3. pastes that config into a scripted chat client (chat.html), which starts the app's own stdio
//    bridge from it and speaks real MCP: search, add to trolley (Valet logs in on its own), get
//    the trolley;
// 4. shows Valet's activity log, then signs in to the fake shop in Chrome as the shopper, opens the
//    trolley Valet filled, and places the order;
// 5. asks the agent to check the trolley once more.
//
// Everything is fake: the shop is the repo's fake (made-up brand), its account is a test account,
// and the build is a showcase build, which is demo mode always (src/main/core/showcase.ts). No real
// 1Password, Keychain item or Messages is read.
//
// The app is driven over the DevTools protocol on a fixed loopback port that only a showcase build
// accepts; the chat and the shop are Chrome pages Playwright drives. Clicks are highlighted on
// screen before they happen, and every step writes a caption (captions.json) that finish.mjs burns
// into the video. Anything that goes wrong is written to findings.json with a screenshot, and the
// run carries on where it can.
//
//   node showcase/record.mjs --dmg <path> --out <dir>

import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { chromium } from '@playwright/test'

const { values } = parseArgs({
  options: {
    dmg: { type: 'string' },
    out: { type: 'string', default: 'showcase-out' },
    'no-record': { type: 'boolean', default: false },
  },
})
if (values.dmg === undefined) throw new Error('--dmg <path> is required')
const OUT = values.out
mkdirSync(join(OUT, 'stills'), { recursive: true })

const APP = '/Applications/Valet Demo.app'
const CDP_PORT = 9333
const DEMO_DATA = join(homedir(), 'Library/Application Support/valet-demo')
const SHOP_EMAIL = 'twofactor@example.test'
const SHOP_PASSWORD = 'fake-password-2' // the fake's test account (src/main/core/demo.ts)

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const captions = []
const findings = []
let t0 = Date.now()
let stillCount = 0

function caption(text, step = '') {
  const at = (Date.now() - t0) / 1000
  const last = captions.at(-1)
  if (last !== undefined && last.end === undefined) last.end = at
  captions.push({ start: at, step, text })
  process.stdout.write(`[${at.toFixed(1)}s] ${step} ${text}\n`)
}

async function still(page, name) {
  stillCount += 1
  const file = join(OUT, 'stills', `${String(stillCount).padStart(2, '0')}-${name}.png`)
  try {
    if (page) await page.screenshot({ path: file })
    else execFileSync('/usr/sbin/screencapture', ['-x', file])
  } catch {
    // A still is for review only.
  }
}

async function finding(severity, what, page) {
  findings.push({ at: (Date.now() - t0) / 1000, severity, what })
  process.stdout.write(`FINDING (${severity}): ${what}\n`)
  await still(page, `finding-${findings.length}`)
}

/** Runs `step`; a failure is a finding (major unless told otherwise), and the run goes on. */
async function attempt(what, step, { page, severity = 'major' } = {}) {
  try {
    return await step()
  } catch (error) {
    await finding(
      severity,
      `${what}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
      page,
    )
    return undefined
  }
}

/** Rings an element in red for a moment, so a viewer sees what is about to be clicked. */
async function show(locator, ms = 900) {
  await locator.scrollIntoViewIfNeeded().catch(() => undefined)
  await locator
    .evaluate((node) => {
      node.dataset.showcaseOutline = node.style.outline
      node.style.outline = '3px solid #e5484d'
      node.style.outlineOffset = '2px'
    })
    .catch(() => undefined)
  await sleep(ms)
  await locator
    .evaluate((node) => {
      node.style.outline = node.dataset.showcaseOutline ?? ''
    })
    .catch(() => undefined)
}

async function click(locator, ms) {
  await locator.waitFor({ state: 'visible', timeout: 20_000 })
  await show(locator, ms)
  await locator.click()
}

async function type(locator, text) {
  await show(locator, 500)
  await locator.click()
  await locator.pressSequentially(text, { delay: 45 })
}

// ── Recording ───────────────────────────────────────────────────────────────────────────────────

let recorder = null
async function startRecording() {
  if (values['no-record']) return
  recorder = spawn(
    'ffmpeg',
    [
      '-hide_banner',
      '-y',
      '-f',
      'avfoundation',
      '-framerate',
      '15',
      '-capture_cursor',
      '1',
      '-i',
      'Capture screen 0:none',
    ].concat([
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '23',
      '-pix_fmt',
      'yuv420p',
      join(OUT, 'raw.mkv'),
    ]),
    { stdio: ['pipe', 'ignore', 'pipe'] },
  )
  let log = ''
  recorder.stderr.on('data', (chunk) => {
    log += String(chunk)
  })
  const deadline = Date.now() + 60_000
  while (!/frame=\s*[1-9]/.test(log)) {
    if (Date.now() > deadline || recorder.exitCode !== null)
      throw new Error(`ffmpeg did not start: ${log.slice(-500)}`)
    await sleep(200)
  }
  t0 = Date.now()
}

async function stopRecording() {
  if (recorder === null) return
  recorder.stdin.write('q')
  await new Promise((done) => {
    recorder.on('exit', done)
    setTimeout(done, 20_000)
  })
}

// ── MCP through the app's own bridge ────────────────────────────────────────────────────────────

const LOGGING_IN = /stage login: login-in-progress/
const BUSY = /stage tool-run: busy/

function resultText(result) {
  const content = Array.isArray(result.content) ? result.content : []
  return content
    .map((part) => (part && typeof part === 'object' && 'text' in part ? String(part.text) : ''))
    .join('\n')
}

/** One tool call shown in the chat, retried as the server's instructions say while Valet logs in. */
async function callTool(chat, client, name, args, summarise) {
  const id = await chat.evaluate(([n, a]) => window.chat.tool(n, a), [name, args])
  const deadline = Date.now() + 300_000
  for (;;) {
    let result
    try {
      result = await client.callTool({ name, arguments: args }, undefined, {
        timeout: 280_000,
        maxTotalTimeout: 280_000,
      })
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      await chat.evaluate(([i, t]) => window.chat.toolResult(i, t, 'error'), [id, text])
      await finding('major', `${name} failed at the protocol level: ${text}`, chat)
      return null
    }
    const text = resultText(result)
    if ((LOGGING_IN.test(text) || BUSY.test(text)) && Date.now() < deadline) {
      const seconds = Number(/again in (\d+) seconds/.exec(text)?.[1] ?? 10)
      const note = LOGGING_IN.test(text)
        ? `Valet: signing in to the shop first (email, password, SMS code, all in its own hidden window). Call again in ${seconds} s.`
        : `Valet: an earlier call still holds the shop's turn. Call again in ${seconds} s.`
      await chat.evaluate(([i, t]) => window.chat.toolResult(i, t, 'wait'), [id, note])
      caption(
        LOGGING_IN.test(text)
          ? 'Valet answers at once that it is logging in, and the agent calls again when told'
          : note,
      )
      await sleep(Math.min(seconds, 30) * 1000)
      continue
    }
    if (result.isError === true) {
      await chat.evaluate(([i, t]) => window.chat.toolResult(i, t, 'error'), [id, text.slice(0, 400)])
      await finding('major', `${name} returned an error: ${text.slice(0, 300)}`, chat)
      return null
    }
    const structured = result.structuredContent ?? null
    await chat.evaluate(([i, t]) => window.chat.toolResult(i, t), [id, summarise(structured, text)])
    return structured
  }
}

const money = (n) => (typeof n === 'number' ? `$${n.toFixed(2)}` : '?')

// ── The run ─────────────────────────────────────────────────────────────────────────────────────

async function main() {
  await startRecording()
  caption(
    'A fresh macOS machine. Everything in this run is fake: a made-up shop, a test account and a scripted chat.',
    'Valet demo',
  )
  await sleep(4000)

  // 1. Install from the DMG.
  caption('Open the downloaded disk image, as a new user would', '1 · Install')
  execFileSync('/usr/bin/open', [values.dmg])
  await sleep(6000)
  await still(null, 'dmg-open')
  caption('Copy Valet Demo into Applications (the script copies it; a person drags the icon)', '1 · Install')
  const volume = execFileSync('/bin/sh', ['-c', 'ls -d /Volumes/Valet\\ Demo*'], { encoding: 'utf8' })
    .trim()
    .split('\n')[0]
  execFileSync('/usr/bin/ditto', [join(volume, 'Valet Demo.app'), APP])
  await sleep(2000)
  execFileSync('/usr/bin/hdiutil', ['detach', volume, '-quiet'])
  caption(
    'Installed. This test build is unsigned and was never downloaded, so Gatekeeper does not ask about it',
    '1 · Install',
  )
  await sleep(3000)

  // 2. First launch and setup.
  caption(
    'First launch. (Started with a debugging port that only this demo build accepts, so the script can drive it)',
    '2 · Set up',
  )
  execFileSync('/usr/bin/open', [
    '-a',
    APP,
    '--args',
    '--use-mock-keychain',
    `--remote-debugging-port=${CDP_PORT}`,
  ])
  const app = await connectToApp()
  const control = await appPage(app, (url) => url.includes('index.html'))
  await sleep(2500)
  await still(control, 'welcome')
  const h1 = (name) => control.getByRole('heading', { level: 1, name })

  caption('Valet opens its first-run setup', '2 · Set up')
  await attempt(
    'the welcome step',
    async () => {
      await h1('Let your AI tools use websites, not your passwords').waitFor({ timeout: 30_000 })
      await sleep(2500)
      await click(control.getByRole('link', { name: 'Continue' }))
    },
    { page: control },
  )

  caption('Where logins come from. In the demo, a test provider stands in for 1Password', '2 · Set up')
  await attempt(
    'the 1Password step',
    async () => {
      await h1('Where logins come from').waitFor()
      await sleep(3000)
      await click(control.getByRole('link', { name: 'Continue' }))
    },
    { page: control },
  )

  caption('Review the shop adapter: the sites it may reach, and what each tool can do', '2 · Set up')
  await attempt(
    'approving the adapter',
    async () => {
      await control.locator('.setup-perms').waitFor()
      await sleep(3000)
      await still(control, 'approve-summary')
      await click(control.getByRole('link', { name: /^Review .*…$/ }))
      await sleep(3000)
      await still(control, 'review')
      const ack = control.getByRole('checkbox', { name: 'I’ve read the highlighted additions' })
      if (await ack.isVisible().catch(() => false)) await click(ack)
      caption('Approve it. Until now its tools were hidden from every chat client', '2 · Set up')
      await click(control.getByRole('button', { name: /^Approve \d/ }))
    },
    { page: control },
  )

  caption('Let the adapter use the login, typed only into the shop’s sign-in page', '2 · Set up')
  await attempt(
    'granting the login',
    async () => {
      await h1(/use your login/).waitFor()
      await sleep(2000)
      await click(control.getByRole('link', { name: 'Choose an item…' }))
      const sheet = control.getByRole('dialog', { name: 'Grant a secret' })
      await sheet.waitFor()
      await sleep(1500)
      await click(sheet.getByText('Woolworths (demo account)'))
      await sleep(1500)
      await still(control, 'grant-sheet')
      await click(sheet.getByRole('button', { name: 'Grant', exact: true }))
      await sheet.waitFor({ state: 'hidden' })
      await sleep(2000)
      caption(
        'The shop texts a code at sign-in, so let Valet read that one sender’s codes (here from the fake’s outbox, not Messages)',
        '2 · Set up',
      )
      await click(control.getByRole('link', { name: 'Allow codes…' }))
      await sheet.waitFor()
      await sleep(2500)
      await still(control, 'codes-sheet')
      await click(sheet.getByRole('button', { name: 'Grant', exact: true }))
      await sheet.waitFor({ state: 'hidden' })
      await sleep(2500)
      await still(control, 'grants-done')
      await click(control.getByRole('link', { name: 'Continue' }))
    },
    { page: control },
  )

  let snippet = null
  caption(
    'Connect a chat app. Valet gives it a config that starts its own bridge, with no token in it',
    '2 · Set up',
  )
  await attempt(
    'connecting a chat client',
    async () => {
      await h1('Connect Claude').waitFor()
      await sleep(2000)
      await click(control.getByRole('button', { name: 'Add Claude Desktop' }))
      const pre = control.locator('pre.code', { hasText: 'mcpServers' })
      await pre.waitFor()
      await sleep(2000)
      await click(control.getByRole('button', { name: 'Copy', exact: true }).last())
      await sleep(1000)
      snippet = execFileSync('/usr/bin/pbpaste', { encoding: 'utf8' })
      if (!snippet.includes('mcpServers')) {
        await finding(
          'minor',
          'Copy did not put the config on the clipboard; read it from the page instead',
          control,
        )
        snippet = await pre.textContent()
      }
      await still(control, 'connect')
      await sleep(1500)
      await click(control.getByRole('button', { name: 'Finish' }))
      await sleep(2000)
    },
    { page: control },
  )
  if (snippet === null) throw new Error('no client config to connect with')

  // 3. The chat.
  caption('Now a chat app. This one is a scripted stand-in for Claude that speaks real MCP', '3 · Chat')
  const chrome = await chromium.launch({
    channel: 'chrome',
    headless: false,
    args: [
      '--host-resolver-rules=MAP *.woolworths.test 127.0.0.1',
      '--window-position=0,25',
      '--window-size=1024,740',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  })
  const browser = await chrome.newContext({ ignoreHTTPSErrors: true, viewport: null })
  const chat = await browser.newPage()
  await chat.goto(new URL('./chat.html', import.meta.url).href)
  await sleep(2500)

  caption('Paste the config Valet copied', '3 · Chat')
  await click(chat.locator('#add-connector'))
  await chat.locator('#connector-json').fill(snippet)
  await sleep(2500)
  await click(chat.locator('#connector-save'))

  const config = JSON.parse(snippet)
  const [serverName, server] = Object.entries(config.mcpServers)[0]
  const client = new Client({ name: 'showcase-chat', version: '1.0.0' })
  await client.connect(
    new StdioClientTransport({ command: server.command, args: server.args, stderr: 'pipe' }),
  )
  const { tools } = await client.listTools()
  await chat.evaluate(([n, t]) => window.chat.connector(n, t), [serverName, tools.map((t) => t.name)])
  caption(`Connected through Valet’s bridge: ${tools.length} tools`, '3 · Chat')
  if (tools.length === 0) await finding('major', 'the chat client saw no tools after setup', chat)
  await sleep(3000)
  await still(chat, 'chat-connected')

  const ask = 'Could you put milk, bread, coffee beans and Tim Tams in my Gumleaf Grocer trolley for pick up?'
  await type(chat.locator('#input'), ask)
  await sleep(600)
  await click(chat.locator('#send'), 400)
  await chat.evaluate((t) => window.chat.user(t), ask)
  await sleep(1500)
  await chat.evaluate(() => window.chat.assistant('Sure. I’ll find each one, then add it to your trolley.'))
  caption('The agent searches the shop through Valet. Searching needs no login', '3 · Chat')

  const wanted = [
    { query: 'milk', pick: /Full Cream Milk 2L/, quantity: 2 },
    { query: 'bread', pick: /White Sandwich Bread/, quantity: 1 },
    { query: 'coffee beans', pick: /Coffee Beans/, quantity: 1 },
    { query: 'tim tam', pick: /Tim Tam/, quantity: 1 },
  ]
  const chosen = []
  for (const item of wanted) {
    const found = await callTool(
      chat,
      client,
      'woolworths_search_products',
      { query: item.query, pageSize: 5 },
      (s) =>
        s === null
          ? 'no structured result'
          : `${s.total} found: ${s.products
              .slice(0, 3)
              .map((p) => `${p.name} ${money(p.price)}`)
              .join(' · ')}`,
    )
    const product =
      found?.products?.find((p) => item.pick.test(p.name) && p.available) ?? found?.products?.[0]
    if (product === undefined) {
      await finding('major', `search for ${item.query} found nothing to add`, chat)
      continue
    }
    chosen.push({ ...item, product })
    if (/Woolworths/.test(product.name))
      await finding('minor', `a product still carries the captured brand: ${product.name}`, chat)
  }
  caption(
    'Valet spaces the shop’s requests 10 to 15 seconds apart, so this is unhurried on purpose',
    '3 · Chat',
  )
  await chat.evaluate(() => window.chat.assistant('Found them. Adding to your trolley now.'))
  for (const item of chosen) {
    await callTool(
      chat,
      client,
      'woolworths_add_to_cart',
      { stockcode: item.product.stockcode, quantity: item.quantity },
      (s) =>
        s === null
          ? 'added'
          : `${s.confirmed ? 'In trolley' : 'Unconfirmed'}: ${item.product.name} × ${s.quantity ?? item.quantity}`,
    )
  }
  caption('The agent reads the trolley back', '3 · Chat')
  const cart = await callTool(chat, client, 'woolworths_get_cart', {}, (s) =>
    s === null
      ? 'no cart'
      : `${s.totalQuantity} items, subtotal ${money(s.subtotal)}${s.notices.length ? ` · ${s.notices.join(' ')}` : ''}`,
  )
  await chat.evaluate(
    (summary) =>
      window.chat.assistant(
        `Done. ${summary} It’s ready for pick up: open your trolley on the Gumleaf Grocer site to check out. I can’t place orders myself.`,
      ),
    cart === null
      ? 'Your trolley is updated.'
      : `Your trolley has ${cart.totalQuantity} items, ${money(cart.subtotal)}.`,
  )
  await sleep(4000)
  await still(chat, 'chat-done')

  // 4. Valet's view of it.
  caption('Back in Valet: every call, and the login, is in its audited activity log', '4 · Valet')
  execFileSync('/usr/bin/open', ['-a', APP])
  await sleep(2500)
  const panel = await appPage(app, (url) => url.includes('index.html')).catch(() => control)
  await attempt(
    'showing the activity log',
    async () => {
      await panel.bringToFront().catch(() => undefined)
      await click(
        panel.getByRole('complementary', { name: 'Sections' }).getByRole('link', { name: /^Activity/ }),
      )
      await sleep(5000)
      await still(panel, 'activity')
    },
    { page: panel, severity: 'minor' },
  )

  // 5. The person checks out.
  caption('Now the shopper opens the shop’s website to check out', '5 · Checkout')
  const ports = JSON.parse(readFileSync(join(DEMO_DATA, 'demo-site.json'), 'utf8'))
  const shopOrigin = `https://www.woolworths.test:${ports.port}`
  const shop = await browser.newPage()
  await shop.bringToFront()
  await shop.goto(`${shopOrigin}/`)
  await sleep(3000)
  await still(shop, 'shop-home')
  await attempt(
    'signing in on the shop',
    async () => {
      await click(shop.locator('#header-Login'))
      await sleep(1500)
      await click(shop.locator('#securelogin-Login'))
      caption(
        'Sign in on the shop’s own login page (a stand-in for its Auth0 page), with the test account',
        '5 · Checkout',
      )
      await shop.locator('#username').waitFor()
      await sleep(1200)
      await type(shop.locator('#username'), SHOP_EMAIL)
      await click(shop.locator('button[data-action-button-primary]'))
      await shop.locator('#password').waitFor()
      await sleep(1000)
      await type(shop.locator('#password'), SHOP_PASSWORD)
      await click(shop.locator('button[data-action-button-primary]'))
      await shop.locator('#code').waitFor()
      caption('The shop texts a code. A test phone page shows it', '5 · Checkout')
      await sleep(1500)
      const phone = await browser.newPage()
      await phone.goto(`${shopOrigin}/_demo/phone`)
      await sleep(3500)
      await still(phone, 'phone')
      const code = /code is (\d{6})/.exec(await phone.locator('.sms').first().textContent())?.[1]
      await phone.close()
      if (code === undefined) throw new Error('no code on the test phone')
      await shop.bringToFront()
      await type(shop.locator('#code'), code)
      await click(shop.locator('button[data-action-button-primary]'))
      await shop.waitForURL(/myaccount|\/$/, { timeout: 20_000 })
      await sleep(1500)
    },
    { page: shop },
  )
  caption('The trolley holds what the agent added through Valet', '5 · Checkout')
  await attempt(
    'the trolley',
    async () => {
      await click(shop.locator('#header-Trolley'))
      await shop.locator('#trolley-Lines').waitFor()
      await sleep(4000)
      await still(shop, 'trolley')
      const lines = await shop.locator('.trolley-line').count()
      if (lines !== chosen.length)
        await finding(
          'major',
          `the shop's trolley has ${lines} lines, not the ${chosen.length} the agent added`,
          shop,
        )
      await click(shop.locator('#trolley-Checkout'))
    },
    { page: shop },
  )
  caption('Checkout: pick up today. The person places the order; Valet’s MVP never does', '5 · Checkout')
  let orderNumber = null
  await attempt(
    'placing the order',
    async () => {
      await shop.locator('#checkout-PlaceOrder').waitFor()
      await sleep(4000)
      await still(shop, 'checkout')
      await click(shop.locator('#checkout-PlaceOrder'), 1200)
      await shop.locator('#order-Confirmed').waitFor({ timeout: 20_000 })
      orderNumber = await shop.locator('#order-Number').textContent()
      caption(`Order ${orderNumber} placed`, '5 · Checkout')
      await sleep(5000)
      await still(shop, 'order')
    },
    { page: shop },
  )

  // 6. The agent sees it.
  await chat.bringToFront()
  caption('Back in the chat, the agent can see the trolley is empty now', '6 · Done')
  const ask2 = 'I’ve placed the order. Is the trolley clear now?'
  await type(chat.locator('#input'), ask2)
  await click(chat.locator('#send'), 400)
  await chat.evaluate((t) => window.chat.user(t), ask2)
  const after = await callTool(chat, client, 'woolworths_get_cart', {}, (s) =>
    s === null ? 'no cart' : `${s.totalQuantity} items, subtotal ${money(s.subtotal)}`,
  )
  if (after !== null && after.totalQuantity !== 0 && orderNumber !== null)
    await finding('major', `the trolley still has ${after.totalQuantity} items after the order`, chat)
  await chat.evaluate(() => window.chat.assistant('Yes, it’s empty. Enjoy the Tim Tams.'))
  await sleep(4000)
  await still(chat, 'end')
  caption('End of the demo', 'Valet demo')
  await sleep(3000)

  await client.close().catch(() => undefined)
  await chrome.close().catch(() => undefined)
}

async function connectToApp() {
  const deadline = Date.now() + 60_000
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)
      if (response.ok) break
    } catch {
      // Not up yet.
    }
    if (Date.now() > deadline) throw new Error('Valet Demo did not open its debugging port')
    await sleep(500)
  }
  return chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`)
}

async function appPage(app, match, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    for (const context of app.contexts()) {
      for (const page of context.pages()) {
        if (page.url().startsWith('app://renderer/') && match(page.url())) return page
      }
    }
    if (Date.now() > deadline) throw new Error('no control panel window')
    await sleep(300)
  }
}

let failed = null
try {
  await main()
} catch (error) {
  failed = error
  await finding('major', `the run stopped: ${error instanceof Error ? error.stack : String(error)}`)
} finally {
  const last = captions.at(-1)
  if (last !== undefined && last.end === undefined) last.end = (Date.now() - t0) / 1000
  await stopRecording()
  writeFileSync(join(OUT, 'captions.json'), `${JSON.stringify(captions, null, 2)}\n`)
  writeFileSync(join(OUT, 'findings.json'), `${JSON.stringify(findings, null, 2)}\n`)
}
process.exit(failed === null ? 0 : 1)
