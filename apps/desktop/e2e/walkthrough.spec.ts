// The pairing and approval walkthrough (docs/phone-channel.md#the-walkthrough): the real Mac app,
// the real relay in a local Workers runtime, and the iPhone app's dev build in the simulator, all
// on one macOS runner. Nothing here is a fake of the channel: the Mac pairs the phone, an agent
// asks over MCP, the card is sealed to the phone through the relay, and the phone's Face ID
// signature comes back the same way. The fakes are the sites (a made-up library adapter's draft)
// and the Mac's Touch ID, which a test build answers itself.
//
//   VALET_E2E_WALKTHROUGH=1 SIMULATOR=<udid> XCTESTRUN=<path> WALKTHROUGH_OUT=<dir> \
//     pnpm exec playwright test -c e2e/playwright.config.ts walkthrough --trace off
//
// It records the Mac's screen with ffmpeg and the phone with `simctl io recordVideo`, and writes
// timeline.json (when each recording started, and every caption and agent line), which
// showcase/walkthrough-video.mjs turns into one side-by-side video.

import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { type Page, test } from '@playwright/test'
import {
  appDir,
  CONTROL,
  callToolOnce,
  connectMcp,
  type Launched,
  launch,
  type McpClient,
  sleep,
  tempDir,
  windowWithTitle,
} from './harness'

test.skip(process.env['VALET_E2E_WALKTHROUGH'] !== '1', 'set VALET_E2E_WALKTHROUGH=1')
test.setTimeout(30 * 60_000)

const OUT = process.env['WALKTHROUGH_OUT'] ?? join(appDir, 'test-results/walkthrough')
const SIMULATOR = process.env['SIMULATOR'] ?? 'booted'
const RELAY_PORT = 8787
const CUES_PORT = 9911
const RELAY_ORIGIN = 'https://relay.valet.test'

interface Timeline {
  macStartedAt: number | null
  phoneStartedAt: number | null
  captions: { at: number; text: string }[]
  agent: { at: number; who: 'agent' | 'valet'; text: string }[]
  marks: { at: number; name: string; value: string }[]
}
const timeline: Timeline = { macStartedAt: null, phoneStartedAt: null, captions: [], agent: [], marks: [] }
const children: ChildProcess[] = []

function caption(text: string) {
  timeline.captions.push({ at: Date.now(), text })
  console.log(`caption: ${text}`)
}
function agentLine(who: 'agent' | 'valet', text: string) {
  timeline.agent.push({ at: Date.now(), who, text })
  console.log(`${who}: ${text}`)
}
function save() {
  writeFileSync(join(OUT, 'timeline.json'), JSON.stringify(timeline, null, 2))
}

/** The cue server: the phone's test and this driver take turns through it. */
class Cues {
  qr: string | null = null
  private readonly signalled = new Set<string>()
  private readonly marks = new Map<string, string>()
  private readonly waiters = new Map<string, ((value: string) => void)[]>()
  onMark: (name: string) => void = () => undefined
  server: Server

  constructor() {
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname === '/qr') {
        res.writeHead(this.qr === null ? 404 : 200, { 'content-type': 'text/plain' })
        return res.end(this.qr ?? '')
      }
      const cue = url.pathname.match(/^\/cue\/([a-z-]+)$/)
      if (cue !== null) {
        res.writeHead(this.signalled.has(cue[1] as string) ? 200 : 404)
        return res.end()
      }
      const mark = url.pathname.match(/^\/mark\/([a-z-]+)$/)
      if (mark !== null && req.method === 'POST') {
        const name = mark[1] as string
        const value = url.searchParams.get('v') ?? ''
        timeline.marks.push({ at: Date.now(), name, value })
        console.log(`phone: ${name} ${value}`)
        this.marks.set(name, value)
        for (const w of this.waiters.get(name) ?? []) w(value)
        this.waiters.delete(name)
        this.onMark(name)
        res.writeHead(200)
        return res.end()
      }
      res.writeHead(404)
      res.end()
    })
  }

  listen() {
    return new Promise<void>((done) => this.server.listen(CUES_PORT, '127.0.0.1', done))
  }

  signal(name: string) {
    this.signalled.add(name)
  }

  /** Waits for the phone's next mark of this name (marks repeat, so a seen one is consumed). */
  mark(name: string, timeoutMs = 240_000): Promise<string> {
    if (this.marks.has(name)) {
      const value = this.marks.get(name) as string
      this.marks.delete(name)
      return Promise.resolve(value)
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`the phone never marked ${name}`)), timeoutMs)
      const list = this.waiters.get(name) ?? []
      list.push((value) => {
        clearTimeout(timer)
        this.marks.delete(name)
        resolve(value)
      })
      this.waiters.set(name, list)
    })
  }
}

let ticker: NodeJS.Timeout | null = null

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(command, args, (_error, stdout, stderr) => resolve(`${stdout}${stderr}`))
  })
}

/** Starts a child and resolves once a line of its output matches. */
function startUntil(command: string, args: string[], ready: RegExp, env: NodeJS.ProcessEnv = process.env) {
  const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  return new Promise<ChildProcess>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${command} never became ready`)), 120_000)
    const look = (chunk: Buffer) => {
      process.stdout.write(`[${command}] ${chunk}`)
      if (ready.test(String(chunk))) {
        clearTimeout(timer)
        resolve(child)
      }
    }
    child.stdout?.on('data', look)
    child.stderr?.on('data', look)
  })
}

/** Face ID in the simulator: enrolled once, then a match whenever the phone's test asks. */
const enrolFaceId = async () => {
  await run('xcrun', [
    'simctl',
    'spawn',
    SIMULATOR,
    'notifyutil',
    '-s',
    'com.apple.BiometricKit.enrollmentChanged',
    '1',
  ])
  await run('xcrun', [
    'simctl',
    'spawn',
    SIMULATOR,
    'notifyutil',
    '-p',
    'com.apple.BiometricKit.enrollmentChanged',
  ])
}
const matchFace = () =>
  run('xcrun', ['simctl', 'spawn', SIMULATOR, 'notifyutil', '-p', 'com.apple.BiometricKit_Sim.pearl.match'])

async function call(client: McpClient, name: string, args: Record<string, unknown>, show = true) {
  if (show) agentLine('agent', `${name}(${JSON.stringify(args).slice(0, 140)})`)
  const result = await callToolOnce(client, name, args)
  if (show) agentLine('valet', result.text.slice(0, 400))
  if (result.isError) throw new Error(`${name}: ${result.text}`)
  return result
}

const TOOLS = `import { tool, ValetError } from '@valet/core'
import { z } from 'zod'

export const tools = {
  get_book: tool({
    input: z.object({ id: z.string().regex(/^[a-z0-9-]{1,40}$/) }),
    output: z.object({ id: z.string(), title: z.string().max(200), available: z.boolean() }),
    async run(ctx, input) {
      await ctx.page.goto('https://www.example.com/books/' + input.id)
      const title = await ctx.page.extract('h1')
      if (typeof title !== 'string' || title === '') throw new ValetError('tool-run', 'unavailable')
      const status = await ctx.page.extract('.status')
      return { id: input.id, title: title.trim().slice(0, 200), available: status === 'On the shelf' }
    },
  }),
}
`
const MANIFEST = `${JSON.stringify(
  {
    schemaVersion: 1,
    id: 'leafline-library',
    name: 'Leafline Library',
    version: '0.1.0',
    description: 'Looks up a book at the Leafline Library: its title and whether it is on the shelf.',
    home: 'https://www.example.com/',
    navigation: ['https://www.example.com'],
    egress: ['www.example.com'],
    secrets: {},
    session: { cookieDomains: [], storage: [], probe: { kind: 'none' } },
    auth: { steps: [], frameOrigins: [] },
    requests: [],
    tools: [
      {
        name: 'get_book',
        title: 'Get book',
        description: 'One book by its id: its title and whether it is on the shelf.',
        sideEffect: 'read',
      },
    ],
    settings: {},
    limits: {
      requestsPerRun: 5,
      minGapMs: 3000,
      requestsPerHour: 120,
      requestsPerMinute: 10,
      gapJitterPercent: 50,
      cooldownSeconds: 600,
      maxCooldownSeconds: 7200,
    },
  },
  null,
  2,
)}\n`
const BOOK_PAGE =
  '<!doctype html><title>Leafline Library</title><h1>The Long Paddock</h1><p class="status">On the shelf</p>'
const CASES = JSON.stringify({
  cases: [
    {
      name: 'reads a book page',
      tool: 'get_book',
      input: { id: 'long-paddock' },
      pages: { 'https://www.example.com/books/long-paddock': 'fixtures/book.html' },
      expect: { output: { id: 'long-paddock', title: 'The Long Paddock', available: true } },
    },
  ],
})

let launched: Launched | null = null

test.afterAll(async () => {
  if (ticker !== null) clearInterval(ticker)
  save()
  if (launched !== null) writeFileSync(join(OUT, 'mac.log'), launched.logs.join(''))
  for (const child of children.reverse()) child.kill('SIGINT')
  await sleep(4000)
  await launched?.close()
})

test('pairing an iPhone, and approving an agent’s requests on it', async () => {
  mkdirSync(OUT, { recursive: true })
  await startUntil(
    'node',
    [join(appDir, '../relay/scripts/local.mjs'), '--port', String(RELAY_PORT)],
    /relay listening/,
  )
  const cues = new Cues()
  cues.onMark = (name) => {
    if (name === 'faceid') void sleep(1200).then(matchFace)
  }
  await cues.listen()
  await enrolFaceId()

  const userData = tempDir('walkthrough')
  launched = await launch(userData, appDir, {
    env: {
      VALET_RELAY_ORIGIN: RELAY_ORIGIN,
      VALET_RELAY_CONNECT: `http://127.0.0.1:${RELAY_PORT}`,
      VALET_MAC_NAME: 'Nick’s MacBook Pro',
    },
  })
  // A cold macOS runner can take longer than the default to open the first window.
  const control = await windowWithTitle(launched.app, CONTROL, 90_000)
  await launched.app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows())
      if (w.getTitle().includes('[control]')) {
        w.setBounds({ x: 0, y: 30, width: 1024, height: 730 })
        w.show()
        w.focus()
      }
  })
  const go = (hash: string) =>
    control.evaluate((h) => {
      window.location.hash = h
    }, hash)

  // The recordings, then the phone's side of the script.
  const mac = spawn(
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
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '23',
      '-pix_fmt',
      'yuv420p',
      join(OUT, 'mac.mp4'),
    ],
    { stdio: ['pipe', 'ignore', 'pipe'] },
  )
  children.push(mac)
  await new Promise<void>((resolve) => {
    mac.stderr?.on('data', (chunk) => {
      if (timeline.macStartedAt === null && /frame=/.test(String(chunk))) {
        timeline.macStartedAt = Date.now()
        resolve()
      }
    })
  })
  await startUntil(
    'xcrun',
    ['simctl', 'io', SIMULATOR, 'recordVideo', '--codec=h264', '--force', join(OUT, 'phone.mp4')],
    /Recording started/,
  )
  timeline.phoneStartedAt = Date.now()
  // simctl writes a frame only when the screen changes, and its clock runs short over long still
  // stretches (the app launching took 100 s of real time and 39 s of video), so the phone drifted
  // ahead of the Mac. Nudging the status bar's battery level each second keeps frames coming, so
  // the video's times stay true.
  let battery = 100
  let nudging = false
  ticker = setInterval(() => {
    if (nudging) return
    nudging = true
    battery = battery === 100 ? 99 : 100
    void run('xcrun', [
      'simctl',
      'status_bar',
      SIMULATOR,
      'override',
      '--batteryLevel',
      String(battery),
    ]).finally(() => {
      nudging = false
    })
  }, 1000)
  const xctestrun = process.env['XCTESTRUN']
  if (xctestrun === undefined) throw new Error('set XCTESTRUN')
  const phoneTest = spawn(
    'xcodebuild',
    [
      'test-without-building',
      '-xctestrun',
      xctestrun,
      '-destination',
      `id=${SIMULATOR}`,
      '-only-testing:ValetPhoneUITests/WalkthroughTests',
      '-resultBundlePath',
      join(OUT, 'phone.xcresult'),
    ],
    {
      env: { ...process.env, TEST_RUNNER_VALET_WALKTHROUGH_CUES: `http://127.0.0.1:${CUES_PORT}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  children.push(phoneTest)
  phoneTest.stdout?.on('data', (c) => process.stdout.write(`[phone] ${c}`))
  phoneTest.stderr?.on('data', (c) => process.stdout.write(`[phone] ${c}`))

  // ---- J1: pairing ----
  await go('#/settings/devices')
  caption(
    'Valet on the Mac, and the iPhone app in the Simulator. Both talk through Valet’s relay, running locally here.',
  )
  await cues.mark('launched')
  await sleep(4000)
  caption('To pair, open Settings › Devices on the Mac and choose Pair an iPhone.')
  await sleep(2500)
  await control.getByRole('button', { name: 'Pair an iPhone' }).click()
  const qr = control.locator('svg[data-pairing-qr]')
  await qr.waitFor({ timeout: 30_000 })
  cues.qr = await qr.getAttribute('data-pairing-qr')
  caption(
    'The Mac shows a one-time QR code. The Simulator has no camera, so this test build reads the same code over a local link.',
  )
  cues.signal('qr')
  const code = await cues.mark('code')
  caption(
    'The phone shows six digits. The Mac shows three codes, and you pick the one that matches the phone.',
  )
  await sleep(5000)
  const dialog = control.getByRole('dialog')
  await dialog.getByRole('button', { name: `${code.slice(0, 3)} ${code.slice(3)}` }).click()
  caption(
    'Picking it asks for Touch ID on the Mac (this test build answers that itself). The phone is paired.',
  )
  await cues.mark('paired')
  // Where the phone app's threads are a few seconds after pairing (macOS `sample`; Simulator apps
  // are host processes), for diagnosing a stall.
  void sleep(6000).then(() =>
    run('sample', ['ValetPhoneDev', '3', '-mayDie', '-file', join(OUT, 'phone-sample.txt')]).catch(
      () => undefined,
    ),
  )
  void sleep(8000).then(async () =>
    console.log(
      'mac phones 8 s after pairing:',
      JSON.stringify(await control.evaluate(() => window.valet?.phones.status())),
    ),
  )
  await sleep(3500)
  await dialog
    .getByRole('button', { name: 'Done' })
    .click()
    .catch(() => undefined)
  await sleep(1500)

  // ---- J4: an agent asks; approved on the phone ----
  const client = await connectMcp(control, userData, 'Claude Code')
  caption('Now an agent, connected to Valet over MCP, writes an adapter for a made-up library site.')
  await go('#/sites')
  const created = await call(client, 'valet_create_draft', {
    adapterId: 'leafline-library',
    from: 'blank',
    name: 'Leafline Library',
  })
  const draftId = String((created.structured as { draft: { draftId: string } }).draft.draftId)
  await call(client, 'valet_write_draft_file', { draftId, path: 'manifest.json', content: MANIFEST }, false)
  await call(client, 'valet_write_draft_file', { draftId, path: 'src/tools.ts', content: TOOLS }, false)
  await call(client, 'valet_delete_draft_file', { draftId, path: 'test/example.json' }, false)
  await call(client, 'valet_delete_draft_file', { draftId, path: 'fixtures/item-abc-1.json' }, false)
  agentLine('agent', 'valet_write_draft_file(src/tools.ts, a test case, a fixture page)')
  await call(client, 'valet_write_draft_file', { draftId, path: 'test/book.json', content: CASES }, false)
  await call(
    client,
    'valet_write_draft_file',
    { draftId, path: 'fixtures/book.html', content: BOOK_PAGE },
    false,
  )
  const check = await call(client, 'valet_check_draft', { draftId }, false)
  agentLine(
    'valet',
    `valet_check_draft: ${(check.structured as { ok?: boolean } | null)?.ok === true ? 'all cases pass' : check.text.slice(0, 200)}`,
  )
  await call(client, 'valet_submit_draft', {
    draftId,
    note: 'Looks up one book’s title and whether it is on the shelf.',
  })
  cues.signal('install-asked')
  caption('Installing it needs your approval. The request is sealed to the phone and sent through the relay.')
  await go('#/needs-you')
  await cues.mark('card-open')
  caption('The card on the phone says what the adapter can reach and who asked. Approve asks for Face ID.')
  await cues.mark('approved')
  caption(
    'Approved with Face ID on the phone. The signed approval goes back to the Mac, which checks it and installs.',
  )
  await sleep(2000)
  for (let i = 0; i < 20; i++) {
    const got = await callToolOnce(client, 'valet_get_draft', { draftId })
    if ((got.structured as { draft?: { status?: string } } | null)?.draft?.status === 'approved') break
    await sleep(1000)
  }
  await call(client, 'valet_get_draft', { draftId })
  caption('The agent asks how its request went: approved, and the adapter is installed.')
  await go('#/sites')
  await sleep(4000)

  // ---- A decline ----
  caption(
    'Next the agent asks to keep call traces for 3 days instead of 14. Shortening them removes evidence, so it needs an approval.',
  )
  await call(client, 'valet_set_setting', {
    setting: 'traceRetentionDays',
    value: 3,
    note: 'Old traces take up space.',
  })
  cues.signal('setting-asked')
  await go('#/needs-you')
  await cues.mark('card-open')
  caption('This time you decline on the phone, with a note for the agent. No Face ID is needed to say no.')
  await cues.mark('declined')
  await sleep(1500)
  await call(client, 'valet_get_approval', {})
  caption('The agent is told it was declined, and gets your note. Nothing changed.')
  await sleep(4000)

  // ---- No push: the phone was closed ----
  await cues.mark('backgrounded')
  caption(
    'Without a paid Apple developer account there are no push notifications. Here the phone app is closed when the agent asks.',
  )
  await sleep(2000)
  await call(client, 'valet_set_setting', {
    setting: 'messagesOtpEnabled',
    value: true,
    note: 'Lets me finish logins that send a code by text.',
  })
  cues.signal('closed-asked')
  caption('The Mac keeps the request until the phone confirms it has it.')
  await cues.mark('reopened')
  caption('Open Valet on the phone and it reconnects. The waiting card arrives straight away.')
  await cues.mark('approved-after-open')
  caption('Approved with Face ID, same as before.')
  await sleep(1500)
  await call(client, 'valet_get_approval', {})
  await go('#/activity')
  caption('Every request, approval and decline is in the Mac’s audit log.')
  await cues.mark('done')
  await sleep(4000)
  save()
  await new Promise<void>((resolve) => {
    phoneTest.on('exit', () => resolve())
    setTimeout(resolve, 60_000)
  })
  save()
})

export type { Page }
