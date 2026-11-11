// The app tour: a paced walk through the redesigned app (demo mode, so the shop is the fake one and
// nothing real is reached), recorded scene by scene for a video and a storyboard. Not a pass/fail
// test: it drives the real windows the way a person would, with a drawn pointer, and writes what it
// saw.
//
//   VALET_E2E_TOUR=1 VALET_TOUR_THEME=dark pnpm exec playwright test -c e2e/playwright.config.ts app-tour
//
// Each scene is a run of the window's own frames (CDP screencast, at the window's real size: the
// control panel at 1180x780), written as JPEGs with their times to $VALET_TOUR_OUT/scenes/<id>/, with
// caption beats in tour.json. showcase/tour-video.mjs turns that into the video. The app-tour
// workflow runs it on a macOS runner and pushes the result to an app-tour/<run id>-<theme> branch.
//
// Agent calls happen between scenes, off camera: the fake shop's real pacing (a login, then ten
// seconds between requests) would otherwise fill the video with waiting.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type CDPSession, type Locator, type Page, test } from '@playwright/test'
import {
  appDir,
  CONTROL,
  COPY_ITEM_ID,
  COPY_ITEM_TITLE,
  callTool,
  changedAdapterBuild,
  connectFakeOnePassword,
  connectMcp,
  keyholdPrompt,
  type Launched,
  launch,
  type McpClient,
  ONEPASSWORD_ACCOUNT,
  ONEPASSWORD_UNLOCK,
  type ToolResult,
  tempDir,
  windowWithTitle,
} from './harness'

test.describe.configure({ mode: 'serial' })
test.skip(process.env['VALET_E2E_TOUR'] !== '1', 'set VALET_E2E_TOUR=1')
test.setTimeout(900_000)

const OUT = process.env['VALET_TOUR_OUT'] ?? join(appDir, 'out/app-tour')
const THEME: 'light' | 'dark' = process.env['VALET_TOUR_THEME'] === 'dark' ? 'dark' : 'light'
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

interface Beat {
  readonly t: number
  readonly text: string
}
interface Frame {
  readonly t: number
  readonly file: string
}
interface Scene {
  readonly id: string
  readonly chapter: string
  readonly window: string
  readonly width: number
  readonly height: number
  readonly start: number
  end: number
  readonly beats: Beat[]
  readonly frames: Frame[]
  readonly stills: { t: number; file: string; name: string }[]
  /** A still of the window this one sits on top of (the login banner over the shop's page). */
  under?: { file: string; width: number; height: number }
}
const scenes: Scene[] = []
const notes: string[] = []
let current: Scene | null = null
let sceneCount = 0

let userData: string | undefined
let launched: Launched | null = null
let control: Page
let client: McpClient | null = null
const sessions = new Map<Page, CDPSession>()

function now(): number {
  return Date.now() / 1000
}

function note(text: string): void {
  notes.push(text)
  console.log(`[tour] ${text}`)
}

function writeManifest(): void {
  writeFileSync(
    join(OUT, 'tour.json'),
    JSON.stringify({ theme: THEME, platform: process.platform, scenes, notes }, null, 2),
  )
}

test.beforeAll(() => {
  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(join(OUT, 'scenes'), { recursive: true })
})
test.afterAll(async () => {
  writeManifest()
  await client?.close().catch(() => undefined)
  await launched?.close()
  if (userData !== undefined) rmSync(userData, { recursive: true, force: true })
})

/** The drawn pointer: Playwright's clicks are invisible, so each window gets one in its page. */
async function injectPointer(page: Page): Promise<void> {
  await page.evaluate(() => {
    if (document.getElementById('__tour_pointer') !== null) return
    // A screencast has no window behind the page, so where the page is clear for the window's
    // vibrancy it comes out black. Recording drops the mark, so the page paints its opaque look,
    // as the material looks over a plain desktop.
    delete document.documentElement.dataset['vibrancy']
    const p = document.createElement('div')
    p.id = '__tour_pointer'
    p.innerHTML =
      '<svg width="24" height="24" viewBox="0 0 24 24" style="filter:drop-shadow(0 1px 2px rgba(0,0,0,.35))"><path d="M5 2.5v16.2l4.1-3.9 2.9 6.4 2.7-1.2-2.9-6.3h5.7z" fill="#111" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>'
    const ring = document.createElement('div')
    ring.id = '__tour_ring'
    Object.assign(p.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      zIndex: '2147483647',
      pointerEvents: 'none',
      transform: `translate(${window.innerWidth * 0.62}px, ${window.innerHeight * 0.58}px)`,
      transition: 'transform 600ms cubic-bezier(.3,.7,.2,1)',
      willChange: 'transform',
    })
    Object.assign(ring.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      width: '34px',
      height: '34px',
      marginLeft: '-17px',
      marginTop: '-17px',
      borderRadius: '50%',
      border: '2px solid rgba(80,140,255,.9)',
      background: 'rgba(80,140,255,.18)',
      zIndex: '2147483646',
      pointerEvents: 'none',
      opacity: '0',
    })
    document.documentElement.append(ring, p)
    const w = window as unknown as Record<string, unknown>
    w['__tourMove'] = (x: number, y: number, ms: number) => {
      p.style.transitionDuration = `${ms}ms`
      // The arrow's tip is at (5, 2.5) in its box.
      p.style.transform = `translate(${x - 5}px, ${y - 2.5}px)`
    }
    w['__tourPulse'] = (x: number, y: number) => {
      ring.style.left = `${x}px`
      ring.style.top = `${y}px`
      ring.animate(
        [
          { opacity: 1, transform: 'scale(.4)' },
          { opacity: 0, transform: 'scale(1.3)' },
        ],
        { duration: 450, easing: 'ease-out' },
      )
    }
  })
}

const pointerAt = new Map<Page, { x: number; y: number }>()

async function pointTo(page: Page, target: Locator): Promise<{ x: number; y: number }> {
  await target.scrollIntoViewIfNeeded().catch(() => undefined)
  const box = await target.boundingBox()
  if (box === null) throw new Error('nothing to point at')
  const x = box.x + Math.min(box.width / 2, 40)
  const y = box.y + box.height / 2
  const from = pointerAt.get(page) ?? { x: 700, y: 450 }
  const dist = Math.hypot(x - from.x, y - from.y)
  const ms = Math.round(Math.min(900, Math.max(350, dist * 1.1)))
  await injectPointer(page)
  await page.evaluate(
    ([x, y, ms]) => (window as unknown as { __tourMove: (...a: number[]) => void }).__tourMove(x, y, ms),
    [x, y, ms] as const,
  )
  await page.waitForTimeout(ms + 120)
  pointerAt.set(page, { x, y })
  return { x, y }
}

/** Points at `target` and clicks it, as a person would. */
async function tap(page: Page, target: Locator, after = 700): Promise<void> {
  const { x, y } = await pointTo(page, target)
  await page.evaluate(
    ([x, y]) => (window as unknown as { __tourPulse: (...a: number[]) => void }).__tourPulse(x, y),
    [x, y] as const,
  )
  await target.click().catch((e) => {
    if (!page.isClosed()) throw e
  })
  // A window may close itself on the click (1Password's prompt, the confirmation).
  await page.waitForTimeout(after).catch(() => undefined)
}

/** Taps it if it is there; a miss is noted, not fatal, so one renamed control doesn't lose the tour. */
async function tapIf(page: Page, target: Locator, what: string, after = 700): Promise<boolean> {
  const there = await target
    .first()
    .isVisible()
    .catch(() => false)
  if (!there) {
    note(`missing: ${what} (scene ${current?.id ?? '-'})`)
    return false
  }
  await tap(page, target.first(), after)
  return true
}

async function type(page: Page, target: Locator, text: string): Promise<void> {
  await tap(page, target, 200)
  await target.pressSequentially(text, { delay: 65 })
  await page.waitForTimeout(400)
}

/** Scrolls whatever is under the window's middle by `dy` pixels in a few smooth steps. */
async function scroll(page: Page, dy: number): Promise<void> {
  const { width, height } = await size(page)
  const x = Math.round(width * 0.55)
  const y = Math.round(height * 0.55)
  const from = pointerAt.get(page)
  if (from === undefined || Math.hypot(from.x - x, from.y - y) > 2) {
    await injectPointer(page)
    await page.evaluate(
      ([x, y]) => (window as unknown as { __tourMove: (...a: number[]) => void }).__tourMove(x, y, 500),
      [x, y] as const,
    )
    await page.waitForTimeout(600)
    pointerAt.set(page, { x, y })
  }
  await page.mouse.move(x, y)
  const steps = Math.max(4, Math.round(Math.abs(dy) / 60))
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, dy / steps)
    await page.waitForTimeout(45)
  }
  await page.waitForTimeout(500)
}

async function session(page: Page, width: number, height: number): Promise<CDPSession> {
  let cdp = sessions.get(page)
  if (cdp === undefined) {
    cdp = await page.context().newCDPSession(page)
    sessions.set(page, cdp)
  }
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  // Playwright pins pages to light, so the app's own theme needs the media feature emulated too.
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: THEME }] })
  return cdp
}

async function size(page: Page): Promise<{ width: number; height: number }> {
  return page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
}

function beat(text: string): void {
  current?.beats.push({ t: now(), text })
}

/** A still for the storyboard, from the frame on screen now. */
async function still(page: Page, name: string): Promise<void> {
  if (current === null) return
  await page.waitForTimeout(250)
  const file = `still-${name}.png`
  await page.screenshot({ path: join(OUT, 'scenes', current.id, file), animations: 'disabled' })
  current.stills.push({ t: now(), file, name })
}

/**
 * Records `body` as one scene of `page`'s frames. `width`/`height` default to the control panel's
 * real size; other windows pass their own.
 */
async function scene(
  page: Page,
  chapter: string,
  firstBeat: string,
  body: () => Promise<void>,
  dims: { width: number; height: number } = { width: 1180, height: 780 },
  windowName = 'control',
): Promise<void> {
  sceneCount += 1
  const id = String(sceneCount).padStart(2, '0')
  const dir = join(OUT, 'scenes', id)
  mkdirSync(dir, { recursive: true })
  const cdp = await session(page, dims.width, dims.height)
  await page.waitForTimeout(300)
  await injectPointer(page)
  const s: Scene = {
    id,
    chapter,
    window: windowName,
    width: dims.width,
    height: dims.height,
    start: now(),
    end: 0,
    beats: [],
    frames: [],
    stills: [],
  }
  scenes.push(s)
  current = s
  let n = 0
  const first = (await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 88 })) as {
    data: string
  }
  writeFileSync(join(dir, 'f00000.jpg'), Buffer.from(first.data, 'base64'))
  s.frames.push({ t: s.start, file: 'f00000.jpg' })
  const onFrame = (f: { data: string; sessionId: number; metadata: { timestamp?: number } }) => {
    n += 1
    const file = `f${String(n).padStart(5, '0')}.jpg`
    writeFileSync(join(dir, file), Buffer.from(f.data, 'base64'))
    s.frames.push({ t: f.metadata.timestamp ?? now(), file })
    void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => undefined)
  }
  cdp.on('Page.screencastFrame', onFrame)
  await cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 88,
    maxWidth: dims.width,
    maxHeight: dims.height,
    everyNthFrame: 1,
  })
  beat(firstBeat)
  try {
    await body()
    await page.waitForTimeout(900).catch(() => undefined)
  } catch (e) {
    note(`scene ${id} (${chapter}) stopped early: ${String(e).split('\n')[0]}`)
  } finally {
    await cdp.send('Page.stopScreencast').catch(() => undefined)
    cdp.off('Page.screencastFrame', onFrame)
    s.end = now()
    current = null
    writeManifest()
  }
}

async function nav(name: string | RegExp): Promise<void> {
  const places = control.getByRole('navigation', { name: 'Places' })
  await tapIf(control, places.getByRole('link', { name }).first(), `sidebar ${String(name)}`, 900)
}

async function tab(name: string | RegExp): Promise<void> {
  await tapIf(
    control,
    control.getByRole('tab', { name }).or(control.getByRole('link', { name })).first(),
    `tab ${String(name)}`,
    900,
  )
}

async function theme(): Promise<void> {
  if (launched === null) return
  await launched.app.evaluate(({ nativeTheme }, t) => {
    nativeTheme.themeSource = t
  }, THEME)
}

const h1 = (name: string | RegExp) => control.getByRole('heading', { level: 1, name })

function mcp(): McpClient {
  if (client === null) throw new Error('no client')
  return client
}

async function agent(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
  const r = await callTool(mcp(), tool, args).catch((e) => ({ isError: true, text: String(e) }) as ToolResult)
  note(`agent ${tool}: ${r.isError ? 'ERROR ' : ''}${r.text.slice(0, 160).replace(/\s+/g, ' ')}`)
  return r
}

let stockcode = 0

test('setup: install to connected', async () => {
  userData = tempDir('tour')
  launched = await launch(userData, undefined, { setup: true })
  control = await windowWithTitle(launched.app, CONTROL)
  await theme()
  await control.waitForTimeout(1500)

  await scene(control, 'First launch', 'A first launch opens setup in the Valet window.', async () => {
    await still(control, 'setup-welcome')
    await control.waitForTimeout(1500)
    await tap(control, control.getByRole('link', { name: 'Get started' }), 1000)
    beat('Step 1: where the Woolworths password comes from. Valet keeps a Keychain copy of a 1Password item.')
    await type(control, control.getByRole('textbox', { name: '1Password account' }), ONEPASSWORD_ACCOUNT)
    await tap(control, control.getByRole('button', { name: 'Save' }), 1200)
    await still(control, 'setup-1password')
    await tap(control, control.getByRole('link', { name: 'Continue' }), 1000)
    beat('Step 2: approve the Woolworths adapter: the sites it reaches and what each tool can do.')
    await still(control, 'setup-approve')
    await control.waitForTimeout(1200)
    await tap(control, control.getByRole('link', { name: /^Review Woolworths .*…$/ }), 1200)
    beat('The review shows the adapter’s code and permissions before anything runs.')
    await still(control, 'setup-review')
    await scroll(control, 700)
    await scroll(control, 700)
    await scroll(control, -1400)
    const ack = control.getByRole('checkbox', { name: 'I’ve read the highlighted additions' })
    if (await ack.isVisible().catch(() => false)) await tap(control, ack, 400)
    await tap(control, control.getByRole('button', { name: /^Approve (Woolworths|\d)/ }), 1200)
    beat('Step 3: which login to use. Choosing an item asks 1Password.')
    await still(control, 'setup-login')
    await tap(control, control.getByRole('link', { name: 'Choose an item…' }), 800)
  })

  // 1Password's own window asks the person (here the fake one, Keyhold).
  const prompt = await keyholdPrompt(launched.app)
  await scene(
    prompt,
    'First launch',
    '1Password asks first: unlock it, then allow Valet.',
    async () => {
      const password = prompt.getByLabel('Account password')
      if (await password.isVisible().catch(() => false)) {
        await still(prompt, 'keyhold-unlock')
        await type(prompt, password, ONEPASSWORD_UNLOCK)
        await tap(prompt, prompt.getByRole('button', { name: 'Unlock' }), 900)
      }
      await still(prompt, 'keyhold-allow')
      await tap(prompt, prompt.getByRole('button', { name: 'Allow' }), 900)
    },
    await size(prompt),
    'keyhold',
  )

  await scene(
    control,
    'First launch',
    'Pick the login. It may only be typed into the shop’s sign-in page.',
    async () => {
      const sheet = control.getByRole('dialog')
      await sheet.getByText(COPY_ITEM_TITLE).waitFor()
      await still(control, 'setup-login-sheet')
      await tap(control, sheet.getByText(COPY_ITEM_TITLE), 600)
      await tap(control, sheet.getByRole('button', { name: 'Use this login' }), 1000)
      beat('The shop texts a code at sign-in, so Valet may read that code from Messages.')
      await tap(control, control.getByRole('link', { name: 'Allow codes…' }), 800)
      await tap(control, control.getByRole('dialog').getByRole('button', { name: 'Allow these codes' }), 1000)
      await still(control, 'setup-login-done')
      await tap(control, control.getByRole('link', { name: 'Continue' }), 1000)
      beat('Step 4: the store whose prices and pickup times you shop with.')
      const settings = control.getByTestId('setup-settings')
      await type(control, settings.getByRole('textbox'), '2000')
      await tap(control, settings.getByRole('button', { name: 'Search' }), 1500)
      await tap(control, settings.getByRole('button', { name: 'Choose' }).first(), 1000)
      await still(control, 'setup-store')
      await tap(control, control.getByRole('link', { name: 'Continue' }), 1000)
      beat('Step 5: connect Claude. Each app gets its own access, and the setup to copy.')
      await tap(control, control.getByRole('button', { name: 'Add Claude Code' }), 1200)
      await tap(control, control.getByRole('button', { name: 'Copy' }).first(), 900)
      await still(control, 'setup-connect')
      await tap(control, control.getByRole('button', { name: 'Finish', exact: true }), 1400)
      beat('Valet is set up. It lives in the menu bar from here.')
      await still(control, 'setup-done')
      await control.waitForTimeout(800)
      await tap(control, control.getByRole('link', { name: 'Open Valet' }), 1200)
    },
  )
  await h1(/./).first().waitFor()
})

test('the agent shops, off camera', async () => {
  if (launched === null || userData === undefined) throw new Error('not launched')
  await connectFakeOnePassword(launched, control)
  client = await connectMcp(control, userData, 'Claude Code')
  const found = await agent('woolworths_search_products', { query: 'milk' })
  stockcode =
    (found.structured as { products?: { stockcode: number }[] } | undefined)?.products?.[0]?.stockcode ?? 0
  await agent('woolworths_add_to_cart', { stockcode, quantity: 2 })
  const bread = await agent('woolworths_search_products', { query: 'bread' })
  const b = (bread.structured as { products?: { stockcode: number }[] } | undefined)?.products?.[0]?.stockcode
  if (b !== undefined) await agent('woolworths_add_to_cart', { stockcode: b, quantity: 1 })
  await agent('woolworths_get_cart', {})
})

test('the six places', async () => {
  await scene(
    control,
    'Finding your way',
    'Six places in the sidebar. Needs you comes first: anything waiting on you.',
    async () => {
      await nav(/^Needs you/)
      await still(control, 'needs-you')
      await control.waitForTimeout(1200)
      beat('Sites: every site Valet can work on, and how each is doing.')
      await nav(/^Sites$/)
      await still(control, 'sites')
      await control.waitForTimeout(1000)
    },
  )

  await scene(
    control,
    'A site’s own page',
    'Each site has its own page: what it is doing, and whether it’s healthy.',
    async () => {
      const places = control.getByRole('navigation', { name: 'Places' })
      await tapIf(control, places.getByRole('link', { name: /^Woolworths/ }), 'sidebar Woolworths', 1000)
      await still(control, 'site-overview')
      await control.waitForTimeout(1200)
      beat('Tools: what agents can ask of this site, with what each one is allowed to change.')
      await tab(/^Tools/)
      await still(control, 'site-tools')
      await control.waitForTimeout(800)
      beat('Permissions: its login, its codes, and its store, each with its own grant.')
      await tab(/^Permissions/)
      await still(control, 'site-permissions')
      await control.waitForTimeout(800)
      beat('Versions: which adapter version is approved, and any update waiting for review.')
      await tab(/^Versions/)
      await still(control, 'site-versions')
      await control.waitForTimeout(800)
    },
  )

  await scene(control, 'Activity', 'Activity: every call an agent made, newest first.', async () => {
    await nav(/^Activity/)
    await still(control, 'calls')
    await control.waitForTimeout(1000)
    const row = control.getByRole('row').filter({ hasText: 'add_to_cart' }).last().getByRole('link').first()
    beat('Open a call to see each step Valet took on the site, and what it sent back.')
    if (await tapIf(control, row, 'a call row', 1200)) {
      await still(control, 'call-trace')
      await scroll(control, 500)
      await scroll(control, -500)
    }
    beat('The audit log: a hash-chained record of everything, logins and approvals included.')
    await nav(/^Activity/)
    await tab(/^Audit/)
    await still(control, 'audit')
    await control.waitForTimeout(1500)
  })

  await scene(
    control,
    'Search',
    `Search finds any place, site, call or setting: ${MOD === 'Meta' ? '⌘K' : 'Ctrl+K'}.`,
    async () => {
      await tapIf(control, control.getByRole('button', { name: /Search Valet/ }), 'search button', 600)
      const input = control.getByRole('combobox').or(control.getByRole('textbox')).first()
      await input.pressSequentially('remote', { delay: 90 })
      await control.waitForTimeout(700)
      await still(control, 'palette')
      await control.waitForTimeout(600)
      await control.keyboard.press('Enter')
      await control.waitForTimeout(1200)
      beat('…and takes you straight there.')
      await control.waitForTimeout(1200)
    },
  )

  await scene(
    control,
    'Connections, secrets, settings',
    'Connections: the apps and agents that can call Valet, each with its own access.',
    async () => {
      await nav(/^Connections/)
      await still(control, 'connections')
      await control.waitForTimeout(800)
      await tapIf(control, control.getByRole('link', { name: /^Claude Code/ }), 'Claude Code client', 1000)
      await still(control, 'client')
      await control.waitForTimeout(800)
      beat('Secrets: where each login comes from. Valet shows which, never the password.')
      await nav(/^Secrets/)
      await still(control, 'secrets')
      await control.waitForTimeout(1200)
      beat('Settings: notifications, data kept, updates, and reset.')
      await nav(/^Settings/)
      await still(control, 'settings')
      await control.waitForTimeout(800)
      await tapIf(
        control,
        control
          .getByRole('link', { name: /^Notifications/ })
          .or(control.getByRole('tab', { name: /^Notifications/ })),
        'settings notifications',
        900,
      )
      await control.waitForTimeout(600)
    },
  )
})

async function trayWindow(): Promise<Page> {
  if (launched === null) throw new Error('not launched')
  await launched.app.evaluate(() => {
    ;(globalThis as unknown as { __valetE2eTray: { toggle: () => void } }).__valetE2eTray.toggle()
  })
  const t = await windowWithTitle(launched.app, 'Valet menu', 15_000)
  await t.waitForTimeout(800)
  return t
}

async function closeTray(): Promise<void> {
  await launched?.app.evaluate(() => {
    ;(globalThis as unknown as { __valetE2eTray: { toggle: () => void } }).__valetE2eTray.toggle()
  })
}

test('the menu bar, the login hand-off, lock down', async () => {
  const t = await trayWindow()
  await scene(
    t,
    'The menu bar',
    'The menu bar panel: today’s calls, each site, and the stop buttons, without opening the window.',
    async () => {
      await still(t, 'tray')
      await pointTo(t, t.getByRole('button').first())
      await t.waitForTimeout(2500)
    },
    await size(t),
    'tray',
  )
  await closeTray()

  // A login that needs the person: the banner over the shop's own sign-in page.
  await control.evaluate(() => window.valet?.openLoginWindow('woolworths'))
  if (launched === null) throw new Error('not launched')
  const banner = await windowWithTitle(launched.app, 'Valet: sign in')
  await banner.waitForTimeout(800)
  const shopPage = launched.app
    .windows()
    .find((p) => !p.isClosed() && p !== banner && /woolworths\.test/.test(p.url()))
  const under = shopPage === undefined ? undefined : { file: 'under.png', ...(await size(shopPage)) }
  if (shopPage === undefined) note('missing: the shop sign-in page under the banner')
  await scene(
    banner,
    'Signing in',
    'When a site needs you to sign in yourself, Valet opens its page under a banner that says why.',
    async () => {
      const sc = scenes.at(-1)
      if (shopPage !== undefined && under !== undefined && sc !== undefined) {
        // The page under the banner may not paint while covered, so the main process captures it.
        const url = shopPage.url()
        const png = await launched?.app
          .evaluate(async ({ webContents }, url) => {
            const wc = webContents.getAllWebContents().find((w) => w.getURL() === url)
            return wc === undefined ? null : (await wc.capturePage()).toPNG().toString('base64')
          }, url)
          .catch(() => null)
        if (png === null || png === undefined) note('missing: a capture of the shop sign-in page')
        else {
          writeFileSync(join(OUT, 'scenes', sc.id, under.file), Buffer.from(png, 'base64'))
          sc.under = under
        }
      }
      await still(banner, 'login-banner')
      await banner.waitForTimeout(3000)
    },
    await size(banner),
    'login',
  )
  await scene(control, 'Signing in', 'Needs you shows it too, until it’s done.', async () => {
    await nav(/^Needs you/)
    await still(control, 'needs-you-login')
    await control.waitForTimeout(1800)
  })
  await banner
    .getByRole('button', { name: /Cancel/ })
    .click()
    .catch(() => undefined)

  await scene(
    control,
    'Stopping Valet',
    'Pause Valet stops every call at once. Lock down goes further.',
    async () => {
      await nav(/^Needs you/)
      await tapIf(
        control,
        control.getByRole('button', { name: 'More ways to stop Valet' }),
        'pause menu',
        600,
      )
      await tapIf(control, control.getByRole('menuitem', { name: /Lock down/ }), 'lock down item', 900)
      await still(control, 'lock-down-dialog')
      await control.waitForTimeout(2500)
      const dialog = control.getByRole('alertdialog').or(control.getByRole('dialog')).first()
      await tapIf(control, dialog.getByRole('button', { name: 'Lock down' }), 'lock down confirm', 1200)
      beat('Locked down: every call is refused, with an answer that says why, until you unlock.')
      await still(control, 'locked-down')
      await control.waitForTimeout(2200)
      beat('Unlock puts it back. Cloud agents removed by Lock down have to be approved again.')
      await tapIf(control, control.getByRole('button', { name: 'Unlock' }), 'unlock', 1500)
    },
  )
})

test('an update to review, and a confirmation', async () => {
  // The same app with a changed Woolworths adapter: an update waiting for review. Its
  // remove_from_cart is marked irreversible, which is what makes a tool ask the person first.
  await client?.close().catch(() => undefined)
  await launched?.close()
  if (userData === undefined) throw new Error('no userData')
  launched = await launch(userData, changedAdapterBuild())
  control = await windowWithTitle(launched.app, CONTROL)
  sessions.clear()
  pointerAt.clear()
  await theme()
  await connectFakeOnePassword(launched, control)
  client = await connectMcp(control, userData, 'Claude Code')
  await control.waitForTimeout(1500)

  await scene(
    control,
    'Reviewing an update',
    'An adapter update waits for you. Until then, that site’s tools are off.',
    async () => {
      await nav(/^Needs you/)
      await still(control, 'update-needs-you')
      await control.waitForTimeout(1500)
      const review = control
        .getByRole('link', { name: /^Review/ })
        .or(control.getByRole('button', { name: /^Review/ }))
        .first()
      await tapIf(control, review, 'review link', 1200)
      beat('The review compares it with the version you approved, and highlights what changed.')
      await still(control, 'update-review')
      await scroll(control, 600)
      await control.waitForTimeout(600)
      await scroll(control, 600)
      await control.waitForTimeout(600)
      await scroll(control, -1200)
      const ack = control.getByRole('checkbox', { name: /I’ve read/ })
      if (await ack.isVisible().catch(() => false)) await tap(control, ack, 500)
      await tapIf(control, control.getByRole('button', { name: /^Approve/ }), 'approve update', 1500)
      beat('Approved. Logins don’t carry over to a new version, so choose it again.')
      await still(control, 'update-approved')
      await control.waitForTimeout(1500)
      if (await tapIf(control, control.getByRole('link', { name: 'Choose login…' }), 'choose login', 900)) {
        const sheet = control.getByRole('dialog')
        const item = sheet.getByText(COPY_ITEM_TITLE)
        await item.waitFor({ timeout: 20_000 }).catch(() => undefined)
        await tapIf(control, item, 'login item', 600)
        await tapIf(control, sheet.getByRole('button', { name: 'Use this login' }), 'use this login', 1200)
        beat('The site is back on, at the new version.')
        await still(control, 'update-login-again')
        await control.waitForTimeout(1500)
      }
    },
  )

  // The SMS codes grant (and the login, if the scene missed it) for the new version, off camera.
  const detail = await control.evaluate(() => window.valet?.adapters.get('woolworths'))
  const origins = detail?.secretRequests[0]?.origins ?? []
  const grants = (await control.evaluate(() => window.valet?.grants.list())) ?? []
  const has = (secret: string) =>
    grants.some((g) => g.adapterId === 'woolworths' && g.secret === secret && g.adapterHash === detail?.hash)
  await control.evaluate(
    ({ hash, origins, itemRef, login }) =>
      Promise.all([
        login
          ? window.valet?.grants.make({
              adapterId: 'woolworths',
              adapterHash: hash,
              secret: 'login',
              provider: 'keychain-copy',
              itemRef,
              origins,
            })
          : null,
        window.valet?.grants.make({
          adapterId: 'woolworths',
          adapterHash: hash,
          secret: 'messages',
          provider: 'messages',
          itemRef: 'Woolworths',
          origins,
        }),
      ]),
    { hash: detail?.hash ?? '', origins, itemRef: COPY_ITEM_ID, login: !has('login') },
  )

  const call = agent('woolworths_remove_from_cart', { stockcode })
  if (launched === null) throw new Error('not launched')
  const panel = await windowWithTitle(launched.app, 'Valet: confirm', 120_000)
  await panel.waitForTimeout(600)
  await scene(
    panel,
    'Asking first',
    'A tool that can’t be undone asks you first, in a window of its own. (A test build here: no MVP Woolworths tool asks.)',
    async () => {
      await still(panel, 'confirm')
      await panel.waitForTimeout(2500)
      await tapIf(panel, panel.getByRole('button', { name: 'Decline' }), 'decline', 300)
    },
    await size(panel),
    'confirm',
  )
  await call
  await scene(
    control,
    'Asking first',
    'The agent is told you declined, and Activity records it.',
    async () => {
      await nav(/^Activity/)
      await still(control, 'declined-call')
      await control.waitForTimeout(2200)
    },
  )
})
