#!/usr/bin/env node
// A recorded run against a real site: Yahoo Finance, which needs no login. Run on a fresh macOS
// GitHub runner by .github/workflows/live-sites.yml. It records the screen with ffmpeg while it:
//
// 1. installs Valet Demo from its DMG and launches it (the showcase build; the made-up shop is
//    skipped in setup, since this run is about a real site);
// 2. connects a chat client in setup, then reviews and approves the Yahoo Finance adapter from the
//    Adapters screen;
// 3. has a scripted chat client (chat.html) ask about stocks over real MCP through the app's own
//    bridge: symbol search, quotes for an ASX and a US stock, an index, a currency, and an index's
//    month of prices, each one Valet fetching live from finance.yahoo.com;
// 4. shows Valet's activity log.
//
// Every tool result is written to results.json, and anything that goes wrong to findings.json with
// a screenshot; the run carries on where it can. Nothing here signs in anywhere.
//
//   node showcase/record-live.mjs --dmg <path> --out <dir>

import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
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

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const captions = []
const findings = []
const results = []
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
      results.push({ name, args, ok: false, text: text.slice(0, 1000) })
      await chat.evaluate(([i, t]) => window.chat.toolResult(i, t, 'error'), [id, text.slice(0, 400)])
      await finding('major', `${name} returned an error: ${text.slice(0, 300)}`, chat)
      return null
    }
    const structured = result.structuredContent ?? null
    results.push({ name, args, ok: true, structured })
    await chat.evaluate(([i, t]) => window.chat.toolResult(i, t), [id, summarise(structured, text)])
    return structured
  }
}

// ── The run ─────────────────────────────────────────────────────────────────────────────────────

const pct = (n) => (typeof n === 'number' ? `${n >= 0 ? '+' : ''}${n.toFixed(2)}%` : '?')
const price = (q) =>
  q === null
    ? 'no quote'
    : `${q.name ?? q.symbol}: ${q.price ?? '?'} ${q.currency ?? ''} (${pct(q.changePercent)})`

async function main() {
  await startRecording()
  caption('A fresh macOS machine, and a real website: Yahoo Finance. No account, no login.', 'Valet, live')
  await sleep(3500)

  caption('Install Valet from its disk image', '1 · Install')
  execFileSync('/usr/bin/open', [values.dmg])
  await sleep(6000)
  const volume = execFileSync('/bin/sh', ['-c', 'ls -d /Volumes/Valet\\ Demo*'], { encoding: 'utf8' })
    .trim()
    .split('\n')[0]
  execFileSync('/usr/bin/ditto', [join(volume, 'Valet Demo.app'), APP])
  await sleep(1500)
  execFileSync('/usr/bin/hdiutil', ['detach', volume, '-quiet'])

  caption(
    'First launch (with a debugging port only this test build accepts, so the script can drive it)',
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
  const h1 = (name) => control.getByRole('heading', { level: 1, name })

  caption(
    'Setup walks through the shop adapter first. This run skips it: it is about a real site',
    '2 · Set up',
  )
  await attempt(
    'walking past the shop steps',
    async () => {
      await h1('Let your AI tools use websites, not your passwords').waitFor({ timeout: 30_000 })
      await sleep(1500)
      await click(control.getByRole('link', { name: 'Continue' }))
      await h1('Where logins come from').waitFor()
      await sleep(1200)
      await click(control.getByRole('link', { name: 'Continue' }))
      await control.locator('.setup-perms').waitFor()
      await sleep(1500)
      await click(control.getByRole('link', { name: 'Skip for now' }))
      await h1(/use your login/).waitFor()
      await sleep(1200)
      await click(control.getByRole('link', { name: 'Skip for now' }))
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
      await sleep(1500)
      await click(control.getByRole('button', { name: 'Add Claude Desktop' }))
      const pre = control.locator('pre.code', { hasText: 'mcpServers' })
      await pre.waitFor()
      await sleep(1500)
      await click(control.getByRole('button', { name: 'Copy', exact: true }).last())
      await sleep(800)
      snippet = execFileSync('/usr/bin/pbpaste', { encoding: 'utf8' })
      if (!snippet.includes('mcpServers')) snippet = await pre.textContent()
      await click(control.getByRole('button', { name: /^Finish/ }))
      await sleep(2000)
    },
    { page: control },
  )
  if (snippet === null) throw new Error('no client config to connect with')

  caption(
    'Now the Yahoo Finance adapter. Its tools stay hidden from every client until it is approved',
    '3 · Approve',
  )
  await approve(
    control,
    'Yahoo Finance',
    'yahoo',
    'The review: it reaches finance.yahoo.com and its API host only, reads only, and asks for no login',
  )
  caption('And Wikipedia, approved the same way', '3 · Approve')
  await approve(
    control,
    'Wikipedia',
    'wikipedia',
    'Wikipedia: en.wikipedia.org only, three read-only APIs, no login',
  )

  caption('A chat app: a scripted stand-in for Claude that speaks real MCP', '4 · Chat')
  const chrome = await chromium.launch({
    channel: 'chrome',
    headless: false,
    args: [
      '--window-position=0,25',
      '--window-size=1024,740',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  })
  const browser = await chrome.newContext({ viewport: null })
  const chat = await browser.newPage()
  await chat.goto(new URL('./chat.html', import.meta.url).href)
  await sleep(2000)
  await click(chat.locator('#add-connector'))
  await chat.locator('#connector-json').fill(snippet)
  await sleep(1500)
  await click(chat.locator('#connector-save'))

  const config = JSON.parse(snippet)
  const [serverName, server] = Object.entries(config.mcpServers)[0]
  const client = new Client({ name: 'live-chat', version: '1.0.0' })
  await client.connect(
    new StdioClientTransport({ command: server.command, args: server.args, stderr: 'pipe' }),
  )
  const { tools } = await client.listTools()
  const names = tools.map((t) => t.name)
  await chat.evaluate(([n, t]) => window.chat.connector(n, t), [serverName, names])
  caption(`Connected through Valet’s bridge: ${tools.length} tools`, '4 · Chat')
  writeFileSync(join(OUT, 'tools.json'), `${JSON.stringify(tools, null, 2)}\n`)
  const tool = (suffix) => names.find((n) => n.endsWith(suffix))
  if (tool('get_quote') === undefined) {
    await finding('major', `the client sees no get_quote tool: ${names.join(', ')}`, chat)
    return
  }
  await sleep(2500)

  const ask = 'How are BHP and Commonwealth Bank doing today? And how has the S&P 500 gone this past month?'
  await type(chat.locator('#input'), ask)
  await click(chat.locator('#send'), 400)
  await chat.evaluate((t) => window.chat.user(t), ask)
  await sleep(1200)
  await chat.evaluate(() =>
    window.chat.assistant('I’ll look them up on Yahoo Finance. First, Commonwealth Bank’s symbol.'),
  )
  caption('The agent searches for a symbol. Valet fetches it live from Yahoo Finance', '4 · Chat')

  const found = await callTool(
    chat,
    client,
    tool('search_symbols'),
    { query: 'commonwealth bank', limit: 5 },
    (s) =>
      s === null
        ? 'no matches'
        : s.matches.map((m) => `${m.symbol} ${m.name ?? ''} (${m.exchange ?? ''})`).join(' · '),
  )
  const cba = found?.matches?.find((m) => m.symbol.endsWith('.AX'))?.symbol ?? 'CBA.AX'
  if (found === null)
    await chat.evaluate(() =>
      window.chat.assistant('Search didn’t answer, so I’ll use CBA.AX, its ASX code.'),
    )

  caption(
    'Then quotes: each is the stock’s page on finance.yahoo.com, read by Valet’s own browser',
    '4 · Chat',
  )
  const quotes = []
  for (const symbol of ['BHP.AX', cba, '^GSPC', 'AUDUSD=X']) {
    quotes.push(
      await callTool(chat, client, tool('get_quote'), { symbol }, (s) =>
        s === null ? 'no quote' : price(s),
      ),
    )
  }
  caption(
    'Valet spaces its requests to the site a few seconds apart, so this is unhurried on purpose',
    '4 · Chat',
  )
  const history = await callTool(
    chat,
    client,
    tool('get_price_history'),
    { symbol: '^GSPC', range: '1mo', interval: '1d' },
    (s) => {
      if (s === null || s.points.length === 0) return 'no prices'
      const first = s.points.find((p) => p.close !== null)
      const last = [...s.points].reverse().find((p) => p.close !== null)
      return `${s.points.length} days, ${first?.close?.toFixed(2)} → ${last?.close?.toFixed(2)}`
    },
  )
  const [bhp, cb, spx, aud] = quotes
  const lines = [
    bhp ? `BHP is ${bhp.price} AUD, ${pct(bhp.changePercent)} today.` : 'I couldn’t get BHP.',
    cb
      ? `Commonwealth Bank is ${cb.price} AUD, ${pct(cb.changePercent)}.`
      : 'I couldn’t get Commonwealth Bank.',
    spx ? `The S&P 500 is at ${spx.price} (${pct(spx.changePercent)} today).` : '',
    history && history.points.length > 1
      ? (() => {
          const closes = history.points.map((p) => p.close).filter((c) => c !== null)
          const change = ((closes.at(-1) - closes[0]) / closes[0]) * 100
          return `Over the past month it has moved ${pct(change)}.`
        })()
      : 'I couldn’t get its month of prices.',
    aud ? `For reference, AUD/USD is ${aud.price?.toFixed(4)}.` : '',
    'Prices are delayed as Yahoo shows them.',
  ]
  await chat.evaluate((t) => window.chat.assistant(t), lines.filter(Boolean).join(' '))
  await sleep(5000)
  await still(chat, 'chat-done')

  if (tool('get_summary') !== undefined) {
    const follow = 'Thanks. And what does BHP actually do?'
    await type(chat.locator('#input'), follow)
    await click(chat.locator('#send'), 400)
    await chat.evaluate((t) => window.chat.user(t), follow)
    caption('A follow-up the agent answers from Wikipedia, read live through Valet', '4 · Chat')
    const articles = await callTool(chat, client, tool('search_articles'), { query: 'BHP', limit: 3 }, (s) =>
      s === null ? 'no articles' : s.results.map((r) => r.title).join(' · '),
    )
    const title = articles?.results?.[0]?.title ?? 'BHP'
    const summary = await callTool(chat, client, tool('get_summary'), { title }, (s) =>
      s === null ? 'no summary' : `${s.title}: ${(s.extract ?? '').slice(0, 120)}…`,
    )
    await chat.evaluate(
      (t) => window.chat.assistant(t),
      summary?.extract ? `From Wikipedia: ${summary.extract}` : 'I couldn’t reach Wikipedia just now.',
    )
    await sleep(5000)
    await still(chat, 'chat-wikipedia')
  } else {
    await finding('major', `the client sees no Wikipedia tools: ${names.join(', ')}`, chat)
  }

  caption('Back in Valet: every call is in its audited activity log', '5 · Valet')
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
  caption('End of the run', 'Valet, live')
  await sleep(2500)
  await client.close().catch(() => undefined)
  await chrome.close().catch(() => undefined)
}

/** Reviews and approves one built-in adapter from the Adapters page. */
async function approve(control, name, slug, review) {
  await attempt(
    `approving ${name}`,
    async () => {
      await control.evaluate(() => {
        window.location.hash = '#/adapters'
      })
      await sleep(2500)
      await still(control, `adapters-${slug}`)
      const callout = control.locator('.callout', { hasText: name })
      await click(callout.getByRole('link', { name: 'Review changes' }))
      await sleep(3000)
      await still(control, `review-${slug}`)
      caption(review, '3 · Approve')
      await control.mouse.wheel(0, 500)
      await sleep(2500)
      await still(control, `review-${slug}-2`)
      const ack = control.getByRole('checkbox', { name: 'I’ve read the highlighted additions' })
      if (await ack.isVisible().catch(() => false)) await click(ack)
      await click(control.getByRole('button', { name: /^Approve \d/ }))
      await sleep(2500)
      await still(control, `approved-${slug}`)
    },
    { page: control },
  )
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
  writeFileSync(join(OUT, 'results.json'), `${JSON.stringify(results, null, 2)}\n`)
}
process.exit(failed === null ? 0 : 1)
