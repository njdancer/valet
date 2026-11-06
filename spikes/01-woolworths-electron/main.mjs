// Spike 1: does a logged-in Woolworths session, earned in one Electron partition and copied
// into another, let in-page fetch() reach the trolley API past Akamai?
//
// Run:  pnpm start                 (Electron's default user agent)
//       SPIKE_UA=chrome pnpm start (a clean Chrome user agent string)
//
// You log in by hand in the window that opens, then close it. The spike never types
// credentials. Results go to results/<ua-mode>.json, which holds no cookie values or cart contents.

import { app, BrowserWindow, session } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const ORIGIN = 'https://www.woolworths.com.au'
const LOGIN_URL = `${ORIGIN}/shop/securelogin`
const AUTH_PARTITION = 'persist:auth:woolworths'
const TOOL_PARTITION = 'persist:tool:woolworths'
const ISOLATED_WORLD_ID = 1000
const uaMode = process.env.SPIKE_UA === 'chrome' ? 'chrome' : 'default'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function chromeUserAgent() {
  const major = process.versions.chrome.split('.')[0]
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
}

function configure(ses) {
  if (uaMode === 'chrome') ses.setUserAgent(chromeUserAgent(), 'en-AU,en')
  return ses
}

function waitForClose(win) {
  return new Promise((resolve) => win.on('closed', resolve))
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

// Cookie names, flags and which domains they belong to. Never values.
function describeCookies(cookies) {
  return cookies
    .map((c) => ({ name: c.name, domain: c.domain, httpOnly: c.httpOnly, session: c.session }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

async function copyCookies(from, to) {
  const cookies = (await from.cookies.get({})).filter((c) => c.domain?.endsWith('woolworths.com.au'))
  for (const c of cookies) {
    const host = c.domain.replace(/^\./, '')
    await to.cookies.set({
      url: `https://${host}${c.path ?? '/'}`,
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

// Runs in the page. Reports the shape of the trolley response, never its contents.
const TROLLEY_PROBE = `(async () => {
  const response = await fetch('/apis/ui/Trolley', { credentials: 'same-origin', headers: { accept: 'application/json' } })
  const text = await response.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    isJson: json !== null,
    topLevelKeys: json && typeof json === 'object' ? Object.keys(json).slice(0, 40) : null,
    itemCount: Array.isArray(json?.AvailableItems) ? json.AvailableItems.length : null,
    bodyStart: json === null ? text.slice(0, 120) : null,
    userAgent: navigator.userAgent,
    brands: navigator.userAgentData?.brands ?? null,
  }
})()`

async function probe(win) {
  const result = {}
  for (const [world, run] of [
    ['main', () => win.webContents.executeJavaScript(TROLLEY_PROBE)],
    ['isolated', () => win.webContents.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD_ID, [{ code: TROLLEY_PROBE }])],
  ]) {
    try {
      result[world] = await run()
    } catch (error) {
      result[world] = { error: String(error) }
    }
  }
  return result
}

async function run() {
  const auth = configure(session.fromPartition(AUTH_PARTITION))
  const tool = configure(session.fromPartition(TOOL_PARTITION))

  console.log(`[spike] user agent mode: ${uaMode}`)
  console.log('[spike] Log in to Woolworths in the window, then close the window.')

  const authWin = new BrowserWindow({ width: 1280, height: 900, title: 'Log in, then close this window', webPreferences: { partition: AUTH_PARTITION } })
  const closed = waitForClose(authWin)
  const blockedPageSeen = { value: false }
  authWin.webContents.on('did-navigate', (_e, url) => console.log(`[spike] auth navigated: ${new URL(url).pathname}`))
  authWin.webContents.on('did-finish-load', async () => {
    const title = await authWin.webContents.executeJavaScript('document.title').catch(() => '')
    if (/access denied|blocked|pardon our interruption/i.test(title)) blockedPageSeen.value = true
  })
  await navigate(authWin, LOGIN_URL)
  await closed

  const authCookies = await auth.cookies.get({})
  const copied = await copyCookies(auth, tool)
  console.log(`[spike] copied ${copied} cookies to the tool partition`)

  const toolWin = new BrowserWindow({ show: false, width: 1440, height: 900, webPreferences: { partition: TOOL_PARTITION } })
  await navigate(toolWin, `${ORIGIN}/`)
  await sleep(5000) // let Akamai's script run and refresh its cookies
  const toolProbe = await probe(toolWin)
  const toolCookiesAfter = await tool.cookies.get({})
  toolWin.destroy()

  const results = {
    at: new Date().toISOString(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    uaMode,
    blockedPageSeenDuringLogin: blockedPageSeen.value,
    cookiesCopied: copied,
    authCookies: describeCookies(authCookies),
    toolCookiesAfterLoad: describeCookies(toolCookiesAfter),
    akamaiCookieInTool: toolCookiesAfter.some((c) => c.name === '_abck'),
    toolProbe,
  }
  const dir = join(import.meta.dirname, 'results')
  await mkdir(dir, { recursive: true })
  const file = join(dir, `${uaMode}.json`)
  await writeFile(file, JSON.stringify(results, null, 2))
  console.log(`[spike] wrote ${file}`)
  console.log(JSON.stringify(toolProbe, null, 2))
  app.quit()
}

app.on('window-all-closed', () => {})
app.whenReady().then(run).catch((error) => {
  console.error('[spike] failed:', error)
  app.exit(1)
})
