// The driver in real Electron, with site isolation on (Electron's default), against the local
// test site. Each test runs one harness scenario; see harness/harness.ts for what each does.

import { type ElectronApplication, expect, test } from '@playwright/test'
import { launchHarness, scenario } from './launch'

let app: ElectronApplication

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  app = await launchHarness()
})

test.afterAll(async () => {
  await app?.close()
})

const CANARY_ENCODED = 'canary-Pw9%21x+%22q'

test('hardening is applied before the app is ready', async () => {
  expect(await scenario(app, 'info')).toMatchObject({ readyWhenHardened: false, siteIsolation: true })
})

test('inspect reports ElementInfo from an isolated world, including in iframes', async () => {
  const result = await scenario(app, 'inspect')
  const { site, login } = result.origins as { site: string; login: string }
  expect(result.user).toEqual({
    visible: true,
    tagName: 'input',
    inputType: 'email',
    autocomplete: 'username',
    inputMode: null,
    frameOrigin: site,
    formActionOrigin: site,
    inputReachable: true,
  })
  expect(result.hidden).toMatchObject({ visible: false, inputType: 'text' })
  expect(result.search).toMatchObject({ inputType: 'search', formActionOrigin: 'https://analytics.test' })
  expect(result.sameOriginFrame).toMatchObject({
    inputMode: 'numeric',
    autocomplete: 'one-time-code',
    frameOrigin: site,
    formActionOrigin: site,
    inputReachable: true,
  })
  // With site isolation the cross-origin frame runs in its own process, out of trusted input's reach.
  expect(result.crossOriginFrame).toMatchObject({
    inputType: 'password',
    autocomplete: 'current-password',
    frameOrigin: login,
    formActionOrigin: login,
    inputReachable: false,
  })
  expect(result.missing).toBeNull()
  expect(result.textPresent).toBe(true)
  expect(result.textAbsent).toBe(false)
})

test('a selector built to break out of a script stays data', async () => {
  const result = await scenario(app, 'inspect')
  expect(result.invalidBreakout).toEqual({ error: { stage: 'auth-step', errorClass: 'invalid' } })
  expect(result.validBreakout).toEqual({ ok: null })
  expect(result.pwned).toBe(false)
})

test('trusted typing and a trusted click reach a main-frame form', async () => {
  const { post, keydowns } = await scenario(app, 'typeInMainFrame')
  expect(post).toMatchObject({ host: 'site.test', path: '/session' })
  // The page's own listeners saw no untrusted event.
  expect((post as { body: string }).body).toBe('user=nick%40example.test&hidden=&untrusted=0')
  // Char events alone, by default: the page sees no keydown.
  expect(keydowns).toBe(0)
})

test('a secret typed into a same-origin iframe reaches only that form', async () => {
  const { post, leaks } = await scenario(app, 'typeSecretInSameOriginFrame')
  expect((post as { body: string }).body).toBe(`code=${CANARY_ENCODED}&untrusted=0`)
  expect(leaks).toEqual([])
})

test('a secret is refused without the grant’s origins, or on a frame outside them', async () => {
  const result = await scenario(app, 'typeSecretWithoutOrigins')
  expect(result.typed).toEqual({ error: { stage: 'secret-fill', errorClass: 'origin-mismatch' } })
  expect(result.wrongOrigin).toEqual({ error: { stage: 'secret-fill', errorClass: 'origin-mismatch' } })
  expect(result.valueLength).toBe(0)
})

test('typing a secret stops when the site navigates its frame partway', async () => {
  const result = await scenario(app, 'secretFrameNavigates')
  expect(result.typed).toEqual({ error: { stage: 'secret-fill', errorClass: 'origin-mismatch' } })
  // Some of it went into the old document before the navigation, and none into the new one.
  expect(result.typedBefore).toBeGreaterThan(0)
  expect(result.typedAfter).toBe(0)
  expect(result.posts).toEqual([])
  expect(result.leaks).toEqual([])
})

test('another iframe reloading partway doesn’t stop a secret typed into a different frame', async () => {
  const result = await scenario(app, 'secretSiblingReloads')
  expect(result.siblingBefore).toBe(true)
  expect(result.reloaded).toBe(true)
  expect(result.typed).toEqual({ ok: undefined })
  expect(result.typedLength).toBe(result.expected)
})

test('full key events reach the form as keyDown, char and keyUp, and type the same text', async () => {
  const { post, keydowns, leaks } = await scenario(app, 'typeSecretWithFullKeys')
  expect((post as { body: string }).body).toBe(`code=${CANARY_ENCODED}&untrusted=0`)
  expect(keydowns).toBe(15)
  expect(leaks).toEqual([])
})

test('with site isolation, a cross-origin iframe is refused rather than typed into blind', async () => {
  const result = await scenario(app, 'typeSecretInCrossOriginFrame')
  expect(result.focus).toEqual({ error: { stage: 'auth-step', errorClass: 'element-unsuitable' } })
  expect(result.typed).toEqual({ error: { stage: 'secret-fill', errorClass: 'element-unsuitable' } })
  expect(result.click).toEqual({ error: { stage: 'auth-step', errorClass: 'element-unsuitable' } })
  expect(result.valueLength).toBe(0)
  expect(result.post).toBeNull()
  expect(result.leaks).toEqual([])
})

test('the auth partition cannot be navigated off its origins', async () => {
  const result = await scenario(app, 'navigationGuard')
  // A link click off the list is prevented, and the page is poisoned.
  expect(result.afterClick).toEqual({ error: { stage: 'navigate', errorClass: 'navigation-escaped' } })
  expect((result.clickCommitted as string[]).every((url) => url.includes('://site.test:'))).toBe(true)
  // An open redirect on an allowed origin is stopped at the redirect.
  expect(result.redirect).toEqual({ error: { stage: 'navigate', errorClass: 'navigation-escaped' } })
  expect(result.redirectCommitted).toEqual([])
  // goto() refuses an off-list URL outright.
  expect(result.offList).toEqual({ error: { stage: 'navigate', errorClass: 'navigation-escaped' } })
  expect(result.evil).toEqual([])
})

test('the tool partition’s egress guard blocks every request to an undeclared host', async () => {
  const result = await scenario(app, 'egress')
  expect(result.refused).toEqual({ error: { stage: 'egress', errorClass: 'host-not-allowed' } })
  expect(result.attempts).toMatchObject({ ok: { fetch: 'failed' } })
  expect(result.allowed).toMatchObject({ ok: { status: 200, body: { host: 'site.test' } } })
  const targets = (result.blocked as { method: string; target: string; reason: string }[]).map(
    (b) => `${b.method} ${b.target} ${b.reason}`,
  )
  expect(targets.some((t) => /^GET https:\/\/evil\.test:\d+ host-not-allowed$/.test(t))).toBe(true)
  expect(targets.some((t) => /^POST https:\/\/evil\.test:\d+ host-not-allowed$/.test(t))).toBe(true)
  expect(targets.some((t) => /^GET wss:\/\/evil\.test:\d+ host-not-allowed$/.test(t))).toBe(true)
  // Reports carry the origin only: tool code chose the path and query, and put the cookie there.
  expect(targets.every((t) => !t.includes('/collect') && !t.includes('?'))).toBe(true)
  // And nothing reached the evil host at all.
  expect(result.evil).toEqual([])
})

test('on an allowed host, tool code cannot get past the request surface by any route', async () => {
  const result = await scenario(app, 'surface')
  // The page's own fetch, called from evaluate(): every one cancelled before it left.
  expect(result.attempts).toEqual({
    ok: { checkout: 'failed', encoded: 'failed', undeclared: 'failed', wrongMethod: 'failed', beacon: true },
  })
  // A trusted click submitted a POST form to /payment; the navigation was cancelled.
  expect(result.click).toEqual({})
  // Five declared calls a run, and the sixth is cut off.
  expect(result.calls).toEqual([200, 200, 200, 200, 200, { stage: 'tool-run', errorClass: 'unavailable' }])
  // webRequest can't tell evaluate()'s fetches or a click's form from the site's own requests, so
  // they are reported as the page's; page.fetch is the tool's.
  expect(result.reasons).toEqual(
    expect.arrayContaining([
      'POST /checkout/pay undeclared page',
      'POST /check%6Fut/pay undeclared page',
      'GET /apis/orders undeclared page',
      'DELETE /echo undeclared page',
      'POST /collect undeclared page',
      'POST /payment undeclared page',
      'GET /payments/new denied-path page',
      'GET /echo request-ceiling tool',
    ]),
  )
  // And the site saw none of it.
  expect(result.seen).toEqual([])
})

test('an image, script, stylesheet, iframe, location= or goto cannot reach an undeclared API path', async () => {
  const result = await scenario(app, 'apiRoutes')
  expect(result.routes).toEqual({
    ok: { image: 'error', encoded: 'error', script: 'error', style: 'error', frame: expect.any(String) },
  })
  expect(result.viaGoto).toEqual({ error: { stage: 'egress', errorClass: 'host-not-allowed' } })
  expect(result.reasons).toEqual(
    expect.arrayContaining(['GET /api/cart/add undeclared', 'GET /static/..%2Fapi/cart/add ambiguous-path']),
  )
  // Seven routes to /api/cart/add, and the site saw none of them; the declared /api/cart it did see.
  expect(result.reasons as string[]).toHaveLength(7)
  expect(result.reachedAdd).toBe(0)
  expect(result.reachedCart).toBe(1)
})

test('page script cannot load assets without limit: the asset budget cuts off N+1', async () => {
  const result = await scenario(app, 'assetBudget')
  expect(result.inRun).toBe(80)
  expect(result.reasons).toEqual(['/pixel request-ceiling'])
  // The next run starts a fresh budget.
  expect(result.nextRun).toBe(1)
})

test('the site’s own undeclared API call is blocked and reported as the page’s', async () => {
  const result = await scenario(app, 'pageInitiated')
  const origin = result.origin as string
  expect(result.sitesOwn).toEqual([
    { method: 'GET', target: `${origin}/api/bootstrap`, reason: 'undeclared', initiator: 'page' },
  ])
  // The same call through page.fetch is the tool's.
  expect(result.tool).toEqual({ error: { stage: 'tool-run', errorClass: 'unavailable' } })
  expect(result.toolMade).toEqual([
    { method: 'GET', target: `${origin}/api/bootstrap`, reason: 'undeclared', initiator: 'tool' },
  ])
  expect(result.reached).toBe(0)
})

test('an irreversible declaration is refused until the person unlocks the run, and only in it', async () => {
  const result = await scenario(app, 'irreversible')
  const refused = { error: { stage: 'tool-run', errorClass: 'unavailable' } }
  expect(result.inWriteRun).toEqual(refused)
  expect(result.beforeUnlock).toEqual(refused)
  expect(result.reachedBeforeUnlock).toBe(0)
  expect(result.afterUnlock).toMatchObject({ ok: { status: 200 } })
  expect(result.afterRun).toEqual(refused)
  expect(result.reached).toBe(1)
  expect(result.reasons).toEqual([
    'POST purpose-exceeded tool',
    'POST purpose-exceeded tool',
    'POST undeclared tool',
  ])
})

test('WebRTC and WebTransport reach no undeclared host from the tool partition', async () => {
  const result = await scenario(app, 'sockets')
  expect(result.webrtc).toMatchObject({ outcome: { ok: 'gathered' }, tcp: 0, udp: 0 })
  expect(result.webtransport).toMatchObject({ outcome: { ok: 'failed' }, tcp: 0, udp: 0 })
  // TURN over TCP and TLS went to the proxy, which refused before resolving or dialling anything.
  expect(result.refusedConnects).toEqual(
    expect.arrayContaining([expect.stringMatching(/^https:\/\/evil\.test:\d+$/)]),
  )
})

test('with only the WebRTC IP policy and webRequest, both get out: the test above means something', async () => {
  const result = await scenario(app, 'socketsWithoutProxy')
  // TURN over TCP connects even though webRequest would cancel any request to evil.test.
  expect((result.webrtc as { tcp: number }).tcp).toBeGreaterThan(0)
  expect((result.webtransport as { udp: number }).udp).toBeGreaterThan(0)
})

test('adapter code runs in its own world, so it cannot forge what the runtime’s fetch reports', async () => {
  const result = await scenario(app, 'worlds')
  // The patches stuck in the adapter's world: even evaluate()'s own result now comes back forged.
  expect(result.adapterSees).toEqual({ forged: true })
  expect(result.fetched).toMatchObject({ status: 200, body: { host: 'site.test' } })
})

test('resource hints to an undeclared host open no connection', async () => {
  // Not proof that the hardening works: Electron opened none of these without it either (see
  // hints.spec.ts). It guards against a regression that starts opening them.
  const result = await scenario(app, 'hints')
  expect(result.evilConnections).toEqual([])
  expect(result.evil).toEqual([])
})

test('handoff copies cookies and storage auth -> tool with their attributes, never back', async () => {
  const result = await scenario(app, 'handoff')
  const cookie = (result.echoed as { body: { cookie: string } }).body.cookie
  expect(cookie).toContain('sid=host-only-sid')
  expect(cookie).toContain('shared=domain-shared')
  expect(result.token).toBe('storage-token-123')
  const tool = result.toolCookies as { name: string }[]
  expect(tool.find((c) => c.name === 'sid')).toEqual({
    name: 'sid',
    domain: 'site.test',
    path: '/',
    hostOnly: true,
    secure: true,
    httpOnly: true,
    sameSite: 'lax',
    session: false,
  })
  expect(tool.find((c) => c.name === 'shared')).toMatchObject({
    domain: '.site.test',
    hostOnly: false,
    sameSite: 'no_restriction',
  })
  expect(tool.find((c) => c.name === 'narrow')).toMatchObject({ path: '/account' })
  // What tool code planted stayed in the tool partition.
  expect((result.authCookies as { name: string }[]).map((c) => c.name)).not.toContain('planted')
  expect(result.authPlantedStorage).toBeNull()
  // sessionSecrets: the cookie values and the handed-off storage value, for output redaction.
  expect(result.redaction).toEqual(
    expect.arrayContaining(['host-only-sid', 'domain-shared', 'storage-token-123']),
  )
})

test('redaction still has every session value tool code read, after it overwrote or expired them', async () => {
  const result = await scenario(app, 'redactionAfterOverwrite')
  expect(result.read).toContain('shared=domain-shared')
  expect(result.after).not.toContain('domain-shared')
  expect(result.after).not.toContain('mid-run-cookie')
  expect(result.redaction).toEqual(
    expect.arrayContaining([
      'host-only-sid',
      'domain-shared',
      'mid-run-cookie',
      'storage-token-123',
      'rotated-in-page',
      'decoy',
    ]),
  )
})

test('auth subframes load only from navigation and the manifest’s frame origins', async () => {
  const result = await scenario(app, 'authSubframes')
  const hosts = result.hosts as string[]
  expect(hosts).toContain('captcha.test')
  // The undeclared widget never reached the network.
  expect(hosts).not.toContain('widget.test')
  expect((result.frames as string[]).some((origin) => origin.includes('captcha.test'))).toBe(true)
  expect((result.frames as string[]).some((origin) => origin.includes('widget.test'))).toBe(false)
  // A blocked subframe doesn't poison the page the way a main-frame escape does.
  expect(result.poisoned).toEqual({ ok: false })
})

test('both partitions present the clean Chrome UA and en-AU by default, with the engine’s own hints', async () => {
  const result = await scenario(app, 'userAgent')
  const major = (result.chrome as string).split('.')[0]
  const ua = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
  type Sees = { ua: string; language: string; languages: string[]; brands: string[]; hints: unknown }
  const engine = result.engineSees as Sees
  // The control window really has no override from the driver, or the comparison below is vacuous.
  expect(engine.ua).toBe(result.controlUa)
  for (const sees of [result.toolPageSees, result.authPageSees] as Sees[]) {
    expect(sees.ua).toBe(ua)
    expect(sees.language).toBe('en-AU')
    expect(sees.languages).toEqual(['en-AU', 'en'])
    // D24a is open: the client hints are exactly the engine's own, restated.
    expect(sees.brands).toEqual(engine.brands)
    expect(sees.brands).not.toContain('Google Chrome')
    expect(sees.hints).toEqual(engine.hints)
  }
  const seen = result.seen as { userAgent: string; acceptLanguage: string; clientHintBrands: string }[]
  expect(seen.length).toBeGreaterThanOrEqual(2)
  for (const request of seen) {
    expect(request.userAgent).toBe(ua)
    expect(request.userAgent).not.toMatch(/electron|e2e/i)
    expect(request.acceptLanguage).toBe('en-AU,en;q=0.9')
    // Electron's Chromium sends no Sec-CH-UA header at all, unlike Chrome; recorded for D24a.
    expect(request.clientHintBrands).toBe('')
  }
})

test('workers, service workers and cross-site frames present the same clean UA and en-AU', async () => {
  const result = await scenario(app, 'userAgentEverywhere')
  type Sees = { ua: string; language: string; languages: string[]; brands: string[] }
  const authSees = result.authSees as Record<string, Sees | boolean>
  const main = authSees.main as Sees
  expect(main.ua).toMatch(/Chrome\/\d+\.0\.0\.0 Safari\/537\.36$/)
  const expected = { ua: main.ua, language: 'en-AU', languages: ['en-AU', 'en'], brands: main.brands }
  for (const [partition, sees] of Object.entries({
    auth: authSees,
    tool: result.toolSees as typeof authSees,
  })) {
    // The cross-site frame really is out of process, or this proves nothing about OOPIFs.
    expect(sees.crossSiteIsOutOfProcess, partition).toBe(true)
    for (const where of ['main', 'worker', 'serviceWorker', 'sharedWorker', 'crossSite', 'crossSiteWorker']) {
      expect(sees[where], `${partition} ${where}`).toEqual(expected)
    }
  }
  // And every request they made said the same.
  for (const request of result.headers as { path: string; userAgent: string; acceptLanguage: string }[]) {
    expect(request.userAgent, request.path).toBe(main.ua)
    expect(request.acceptLanguage, request.path).toBe('en-AU,en;q=0.9')
  }
})

test('the auth probe GETs from the main process with the auth partition’s cookies, as the page presents', async () => {
  const result = await scenario(app, 'authProbe')
  const probe = result.probe as {
    ok: { status: number; contentType: string; body: { host: string; headers: Record<string, string> } }
  }
  expect(probe.ok.status).toBe(200)
  expect(probe.ok.contentType).toBe('application/json; charset=utf-8')
  expect(probe.ok.body.host).toBe('site.test')
  const headers = probe.ok.body.headers
  // The cookies a prior navigation in the auth partition set, path rules and all.
  expect(headers.cookie).toContain('sid=host-only-sid')
  expect(headers.cookie).toContain('shared=domain-shared')
  expect(headers.cookie).not.toContain('narrow')
  expect(headers['user-agent']).toMatch(
    /^Mozilla\/5\.0 \(Macintosh; Intel Mac OS X 10_15_7\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/\d+\.0\.0\.0 Safari\/537\.36$/,
  )
  expect(headers['accept-language']).toBe('en-AU,en;q=0.9')
  expect(headers.accept).toBe('*/*')
  expect(headers.referer).toBeUndefined()
  // Fetch metadata as from the page's origin, except the mode: the page's own fetch() says cors, and
  // Electron's net has no way to ask for that. Recorded, since a site can tell by it.
  const fetchMetadata = Object.fromEntries(
    Object.entries(headers).filter(([name]) => /^(sec-|origin$)/.test(name)),
  )
  expect(fetchMetadata).toEqual({
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'no-cors',
    'sec-fetch-site': 'same-origin',
  })
  // The fragment never left, and the probe reached exactly one URL.
  expect(result.probeSeen).toEqual([{ host: 'site.test', path: '/probe' }])
  // Names only, and the cookie the probe's own answer set is kept in the auth partition.
  expect([...(result.names as { ok: string[] }).ok].sort()).toEqual(['narrow', 'shared', 'sid'])
  expect(JSON.stringify(result.names)).not.toContain('host-only-sid')
  expect([...(result.namesAfter as { ok: string[] }).ok].sort()).toEqual([
    'narrow',
    'probed',
    'shared',
    'sid',
  ])
  expect(result.toolCookies).not.toContain('probed')
  // The probe isn't a navigation: the page didn't move.
  expect(result.committed).toEqual([expect.stringContaining('/set-session')])
})

test('the auth probe is refused off the navigation origins, and refuses a redirect off them', async () => {
  const result = await scenario(app, 'authProbe')
  expect(result.offList).toEqual({ error: { stage: 'probe', errorClass: 'host-not-allowed' } })
  expect(result.redirectOff).toEqual({ error: { stage: 'probe', errorClass: 'host-not-allowed' } })
  // A redirect to another navigation origin is followed.
  expect(result.redirectOn).toMatchObject({ ok: { status: 200, body: { host: 'login.test' } } })
  const hosts = result.hosts as string[]
  expect(hosts.filter((h) => h.startsWith('evil.test'))).toEqual([])
  expect(hosts).toContain('site.test/redirect')
  expect(hosts).toContain('login.test/probe')
})

test('the auth probe caps the body and hands back HTML and error statuses as text', async () => {
  const result = await scenario(app, 'authProbe')
  expect(result.big).toEqual({ error: { stage: 'probe', errorClass: 'unexpected-shape' } })
  expect(result.html).toEqual({ status: 200, contentType: 'text/html; charset=utf-8', bodyType: 'string' })
  expect(result.notFound).toEqual({
    status: 404,
    contentType: 'text/html; charset=utf-8',
    bodyType: 'string',
  })
})

test('an auth probe that never answers gives up at the step timeout', async () => {
  const result = await scenario(app, 'authProbeTimeout')
  expect(result.hung).toEqual({ error: { stage: 'timeout', errorClass: 'timed-out' } })
  expect(result.elapsedMs).toBeGreaterThanOrEqual(1400)
  expect(result.elapsedMs).toBeLessThan(5000)
  expect(result.after).toEqual({ status: 200 })
  expect(result.reached).toEqual(['/hang', '/probe'])
})

test('the auth partition’s refused subframes and escapes are reported as the page’s', async () => {
  const result = await scenario(app, 'authBlocks')
  expect(result.escaped).toEqual({ error: { stage: 'navigate', errorClass: 'navigation-escaped' } })
  const reports = result.reports as { method: string; target: string; reason: string; initiator: string }[]
  const origin = (host: string) =>
    expect.stringMatching(new RegExp(`^https://${host.replace('.', '\\.')}:\\d+$`))
  expect(reports).toEqual(
    expect.arrayContaining([
      { method: 'GET', target: origin('widget.test'), reason: 'host-not-allowed', initiator: 'page' },
      { method: 'GET', target: origin('evil.test'), reason: 'host-not-allowed', initiator: 'page' },
    ]),
  )
  // Each once, origin only, nothing from the query.
  expect(reports).toHaveLength(2)
  expect(JSON.stringify(reports)).not.toContain('secret')
  expect(result.toolBlocked).toEqual([])
})

test('handToUser shows the window, and closing it hides the page instead of destroying it', async () => {
  expect(await scenario(app, 'handToUser')).toEqual({
    hiddenBefore: true,
    shown: true,
    title: 'E2E needs you to log in. Close this window when you’re done.',
    hiddenAfter: true,
    aliveAfterClose: true,
    secondCloseDestroyed: true,
  })
})

test('close destroys every window the driver opened', async () => {
  expect(await scenario(app, 'close')).toEqual({ windows: 0 })
})
