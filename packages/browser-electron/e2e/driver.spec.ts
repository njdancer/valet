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
  })
  expect(result.hidden).toMatchObject({ visible: false, inputType: 'text' })
  expect(result.search).toMatchObject({ inputType: 'search', formActionOrigin: 'https://analytics.test' })
  expect(result.sameOriginFrame).toMatchObject({
    inputMode: 'numeric',
    autocomplete: 'one-time-code',
    frameOrigin: site,
    formActionOrigin: site,
  })
  expect(result.crossOriginFrame).toMatchObject({
    inputType: 'password',
    autocomplete: 'current-password',
    frameOrigin: login,
    formActionOrigin: login,
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
  const { post } = await scenario(app, 'typeInMainFrame')
  expect(post).toMatchObject({ host: 'site.test', path: '/session' })
  // The page's own listeners saw no untrusted event.
  expect((post as { body: string }).body).toBe('user=nick%40example.test&hidden=&untrusted=0')
})

test('a secret typed into a same-origin iframe reaches only that form', async () => {
  const { post, leaks } = await scenario(app, 'typeSecretInSameOriginFrame')
  expect((post as { body: string }).body).toBe(`code=${CANARY_ENCODED}&untrusted=0`)
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
  const targets = (result.blocked as { method: string; target: string }[]).map(
    (b) => `${b.method} ${b.target}`,
  )
  expect(targets.some((t) => /^GET https:\/\/evil\.test:\d+\/collect$/.test(t))).toBe(true)
  expect(targets.some((t) => /^POST https:\/\/evil\.test:\d+\/collect$/.test(t))).toBe(true)
  expect(targets.some((t) => /^GET wss:\/\/evil\.test:\d+\/ws$/.test(t))).toBe(true)
  // Reports carry origin and path only.
  expect(targets.every((t) => !t.includes('?'))).toBe(true)
  // And nothing reached the evil host at all.
  expect(result.evil).toEqual([])
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
  expect(result.redaction).toEqual(expect.arrayContaining(['host-only-sid', 'domain-shared']))
})

test('handToUser shows the window, and closing it hides the page instead of destroying it', async () => {
  expect(await scenario(app, 'handToUser')).toEqual({
    hiddenBefore: true,
    shown: true,
    title: 'Finish logging in, then close this window',
    hiddenAfter: true,
    aliveAfterClose: true,
    destroyedByPageClose: true,
  })
})

test('close destroys every window the driver opened', async () => {
  expect(await scenario(app, 'close')).toEqual({ windows: 0 })
})
