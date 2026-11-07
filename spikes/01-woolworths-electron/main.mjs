// Spike 1: does a logged-in Woolworths session, earned in one Electron partition and copied
// into another, let in-page fetch() reach the trolley API past Akamai? And the session tooling
// around it (docs/m2-runbook.md, Part 1 step 4). Every mode reuses the same persisted partitions.
//
// Run:  pnpm start                        login: log in by hand, then close the window
//       SPIKE_MODE=silent pnpm start      clear the www cookies, open /auth/login, see if Auth0 asks
//       SPIKE_MODE=probe pnpm start       one GET /api/ui/v2/bootstrap in the tool partition
//       SPIKE_MODE=record pnpm start      log every request while Nick walks to checkout by hand
//       SPIKE_UA=electron ...             Electron's own user agent (Chrome's is the default)
//       SPIKE_ORIGIN=http://localhost:8417 ...   against the fake site, for a dry run
//
// Logged-in modes need Nick present (project rules). The spike never types credentials, and stops
// on a block page. Its own scripted requests are 10 s apart. Results go to results/, which is
// gitignored and holds no cookie values, field values, query strings or response bodies; run
// `pnpm scrub` before quoting any of it.

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, session } from 'electron'
import {
  AUTH_SHAPE_SCRIPT,
  chromeUserAgent,
  describeCookies,
  GAP_MS,
  initiatorOf,
  isBlockPage,
  isCheckoutPath,
  isWwwCookie,
  judgeRequest,
  keyShape,
  settingsFrom,
  silentVerdict,
  summariseTraffic,
  where,
} from './lib.mjs'

const settings = settingsFrom(process.env)
const { mode, uaMode, origin, siteDomain } = settings
const AUTH_PARTITION = 'persist:auth:woolworths'
const TOOL_PARTITION = 'persist:tool:woolworths'
const ISOLATED_WORLD_ID = 1000
const SILENT_TIMEOUT_MS = 30_000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const log = (line) => console.log(`[spike] ${line}`)

class Blocked extends Error {}

function configure(ses) {
  if (uaMode === 'chrome') ses.setUserAgent(chromeUserAgent(process.versions.chrome), 'en-AU,en')
  return ses
}

function waitForClose(win) {
  return new Promise((resolve) => win.on('closed', resolve))
}

/**
 * Watches a window for a block page. The first one rejects `blocked`, which every mode races its
 * work against, so the run writes what it has and stops instead of trying again.
 */
function watchForBlock(win, label) {
  let reject
  const blocked = new Promise((_resolve, fail) => {
    reject = fail
  })
  blocked.catch(() => {})
  let status = 200
  win.webContents.on('did-navigate', (_event, url, code) => {
    status = code
    log(`${label} navigated: ${where(url).host}${where(url).path} (${code})`)
  })
  win.webContents.on('did-finish-load', async () => {
    const title = await win.webContents.executeJavaScript('document.title').catch(() => '')
    if (isBlockPage({ title, status })) {
      const { host, path } = where(win.webContents.getURL())
      reject(new Blocked(`${label} hit a block page at ${host}${path} (${status}, "${title}")`))
    }
  })
  return blocked
}

// Navigation that tolerates the page redirecting itself mid-load (ERR_ABORTED), as the earlier app does.
async function navigate(win, url) {
  try {
    await win.loadURL(url)
  } catch (error) {
    if (!String(error).includes('ERR_ABORTED')) throw error
    await new Promise((resolve) => win.webContents.once('did-stop-loading', resolve))
  }
}

function cookieUrl(c) {
  const scheme = c.secure ? 'https:' : new URL(origin).protocol
  return `${scheme}//${c.domain.replace(/^\./, '')}${c.path ?? '/'}`
}

async function siteCookies(ses) {
  return (await ses.cookies.get({})).filter((c) => c.domain?.endsWith(siteDomain))
}

async function copyCookies(from, to) {
  const cookies = await siteCookies(from)
  for (const c of cookies) {
    await to.cookies.set({
      url: cookieUrl(c),
      name: c.name,
      value: c.value,
      ...(c.hostOnly ? {} : { domain: c.domain }),
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite,
      ...(c.session ? {} : { expirationDate: c.expirationDate }),
    })
  }
  return cookies.length
}

// Runs in the page. Reports the shape of the response, never its contents.
const fetchShapeScript = (path) => `(async () => {
  const response = await fetch(${JSON.stringify(path)}, { credentials: 'same-origin', headers: { accept: 'application/json' } })
  const text = await response.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    json,
    isJson: json !== null,
    bodyLooksBlocked: json === null && /access denied|reference #|pardon our interruption/i.test(text),
    userAgent: navigator.userAgent,
    brands: navigator.userAgentData?.brands?.map((b) => b.brand) ?? null,
  }
})()`

/** One scripted fetch, reduced to its shape before anything is kept. */
async function fetchShape(win, path, world) {
  const script = fetchShapeScript(path)
  try {
    const raw =
      world === 'isolated'
        ? await win.webContents.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD_ID, [{ code: script }])
        : await win.webContents.executeJavaScript(script)
    const { json, ...rest } = raw
    const shape = { ...rest, keys: json === null ? null : keyShape(json, 2) }
    if (Array.isArray(json?.AvailableItems)) shape.itemCount = json.AvailableItems.length
    if (raw.status === 403 || raw.status === 429 || raw.bodyLooksBlocked) {
      throw new Blocked(`${path} in the ${world} world was refused (${raw.status})`)
    }
    return shape
  } catch (error) {
    if (error instanceof Blocked) throw error
    return { error: String(error) }
  }
}

function hiddenToolWindow() {
  return new BrowserWindow({
    show: false,
    width: 1440,
    height: 900,
    webPreferences: { partition: TOOL_PARTITION },
  })
}

// --- modes -------------------------------------------------------------------------------------

async function login(results, auth, tool) {
  log('Log in to Woolworths in the window, then close the window. Tick "remember this device".')
  const authWin = new BrowserWindow({
    width: 1280,
    height: 900,
    title: 'Log in, then close this window',
    webPreferences: { partition: AUTH_PARTITION },
  })
  const closed = waitForClose(authWin)
  const blocked = watchForBlock(authWin, 'auth')
  results.authPages = []
  authWin.webContents.on('did-finish-load', async () => {
    const shape = await authWin.webContents.executeJavaScript(AUTH_SHAPE_SCRIPT).catch(() => null)
    if (shape !== null && shape.forms.length > 0) results.authPages.push(shape)
  })
  await Promise.race([navigate(authWin, `${origin}/shop/securelogin`).then(() => closed), blocked])

  results.authCookies = describeCookies(await auth.cookies.get({}))
  results.cookiesCopied = await copyCookies(auth, tool)
  log(`copied ${results.cookiesCopied} cookies to the tool partition`)

  const toolWin = hiddenToolWindow()
  try {
    const toolBlocked = watchForBlock(toolWin, 'tool')
    await Promise.race([navigate(toolWin, `${origin}/`), toolBlocked])
    await Promise.race([sleep(GAP_MS), toolBlocked]) // let Akamai's script run and refresh its cookies
    results.toolProbe = { main: await fetchShape(toolWin, '/apis/ui/Trolley', 'main') }
    await Promise.race([sleep(GAP_MS), toolBlocked])
    results.toolProbe.isolated = await fetchShape(toolWin, '/apis/ui/Trolley', 'isolated')
    const after = await tool.cookies.get({})
    results.toolCookiesAfterLoad = describeCookies(after)
    results.akamaiCookieInTool = after.some((c) => c.name === '_abck')
  } finally {
    toolWin.destroy()
  }
}

async function silent(results, auth, tool) {
  results.cleared = []
  for (const [label, ses] of [
    ['auth', auth],
    ['tool', tool],
  ]) {
    for (const c of (await ses.cookies.get({})).filter((cookie) => isWwwCookie(cookie, origin))) {
      await ses.cookies.remove(cookieUrl(c), c.name)
      results.cleared.push({ partition: label, name: c.name, domain: c.domain })
    }
  }
  log(`cleared ${results.cleared.length} www cookies; Auth0's own are kept`)

  const win = new BrowserWindow({ width: 1280, height: 900, webPreferences: { partition: AUTH_PARTITION } })
  const blocked = watchForBlock(win, 'silent')
  const steps = []
  const settled = new Promise((resolve) => {
    const onStep = (url) => {
      steps.push(where(url))
      const verdict = silentVerdict(steps, origin)
      const home = where(url).host === new URL(origin).host && !where(url).path.startsWith('/auth/')
      // A login page means it was not silent: stop there, before anything is typed.
      if (verdict.outcome === 'login-page-shown' || (verdict.outcome === 'silent' && home)) resolve()
    }
    win.webContents.on('did-redirect-navigation', (details) => details.isMainFrame && onStep(details.url))
    win.webContents.on('did-navigate', (_event, url) => onStep(url))
  })
  try {
    navigate(win, `${origin}/auth/login`).catch(() => {})
    await Promise.race([settled, sleep(SILENT_TIMEOUT_MS), blocked])
  } finally {
    win.destroy()
  }
  results.steps = steps
  results.verdict = silentVerdict(steps, origin)
  log(`silent redirect: ${results.verdict.outcome}`)
}

async function probe(results) {
  const win = hiddenToolWindow()
  try {
    const blocked = watchForBlock(win, 'tool')
    await Promise.race([navigate(win, `${origin}/`), blocked])
    await Promise.race([sleep(GAP_MS), blocked])
    results.bootstrap = await fetchShape(win, '/api/ui/v2/bootstrap', 'main')
  } finally {
    win.destroy()
  }
}

async function record(results, _auth, tool) {
  log(
    'Walk to checkout by hand as you would in Chrome. Do not press Place order. Close the window when done.',
  )
  const win = new BrowserWindow({ width: 1440, height: 900, webPreferences: { partition: TOOL_PARTITION } })
  const pageViews = []
  let current = { path: '(before first page)', requests: [] }
  pageViews.push(current)
  let onCheckout = false
  const byId = new Map()

  win.webContents.on('did-start-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument) return
    onCheckout = isCheckoutPath(details.url)
    current = { path: where(details.url).path, host: where(details.url).host, requests: [] }
    pageViews.push(current)
  })
  tool.webRequest.onBeforeRequest((details, callback) => {
    const frame = details.frame
    const initiator = initiatorOf({
      resourceType: details.resourceType,
      hasFrame: frame != null,
      frameHasParent: frame?.parent != null,
    })
    let judged
    try {
      judged = judgeRequest({ ...details, initiator }, { onCheckout })
    } catch {
      return callback({}) // a data: or blob: URL; nothing to record
    }
    const entry = { ...judged.entry, cancelled: judged.cancel }
    current.requests.push(entry)
    byId.set(details.id, entry)
    if (judged.cancel !== null) log(`cancelled ${entry.method} ${entry.host}${entry.path} (${judged.cancel})`)
    callback({ cancel: judged.cancel !== null })
  })
  tool.webRequest.onCompleted((details) => {
    const entry = byId.get(details.id)
    if (entry !== undefined) entry.status = details.statusCode
  })
  tool.webRequest.onErrorOccurred((details) => {
    const entry = byId.get(details.id)
    if (entry !== undefined) entry.error = details.error
  })

  const closed = waitForClose(win)
  const blocked = watchForBlock(win, 'record')
  try {
    await Promise.race([navigate(win, `${origin}/`).then(() => closed), blocked])
  } finally {
    tool.webRequest.onBeforeRequest(null)
    tool.webRequest.onCompleted(null)
    tool.webRequest.onErrorOccurred(null)
    results.pageViews = pageViews.filter((view) => view.requests.length > 0)
    results.summary = summariseTraffic(results.pageViews)
  }
}

const MODE_RUNNERS = { login, silent, probe, record }

async function run() {
  const auth = configure(session.fromPartition(AUTH_PARTITION))
  const tool = configure(session.fromPartition(TOOL_PARTITION))
  const at = new Date().toISOString()
  const results = {
    at,
    mode,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    uaMode,
    origin,
    blocked: null,
  }
  log(`mode ${mode}, user agent ${uaMode}, ${origin}`)
  try {
    await MODE_RUNNERS[mode](results, auth, tool)
  } catch (error) {
    if (!(error instanceof Blocked)) throw error
    results.blocked = error.message
    log(`STOPPED: ${error.message}. Nothing more today (runbook rules).`)
  }

  const dir = join(import.meta.dirname, 'results')
  await mkdir(dir, { recursive: true })
  const file = join(dir, `${mode}-${uaMode}-${at.replace(/[:.]/g, '-')}.json`)
  await writeFile(file, `${JSON.stringify(results, null, 2)}\n`)
  log(`wrote ${file}; run pnpm scrub before sharing any of it`)
  app.quit()
}

app.on('window-all-closed', () => {})
app
  .whenReady()
  .then(run)
  .catch((error) => {
    console.error('[spike] failed:', error)
    app.exit(1)
  })
