import { type Probe, ValetError } from '@valet/core'
import { describe, expect, it } from 'vitest'
import { readJsonPath } from '../src/probe'
import { runAuthFlow } from '../src/run-auth-flow'
import { CANARY, LOGIN, LOGIN_PAGE, MANIFEST, manifestWithSteps, WWW, world } from './fixtures'

/** Logged in when the JSON body has a truthy shopper.id. */
const FETCH_PROBE: Probe = {
  kind: 'fetch',
  path: '/api/me',
  expectStatus: 200,
  loggedOutStatuses: [401],
  jsonPath: 'shopper.id',
}

const ASSERT_ONLY = manifestWithSteps([{ op: 'assertLoggedIn' }])

/** ASSERT_ONLY with the session probe replaced. */
function withProbe(probe: Probe) {
  return { ...ASSERT_ONLY, session: { ...ASSERT_ONLY.session, probe } }
}

const LOGGED_IN = { status: 200, contentType: 'application/json', body: { shopper: { id: 7 } } }

describe('a cookie probe', () => {
  it('asks the auth partition for the manifest cookie domains, and is logged in when the cookie is there', async () => {
    const w = world()
    w.page.cookies.add('session')
    w.input.manifest = ASSERT_ONLY
    expect(await runAuthFlow(w.input)).toEqual({ status: 'ok' })
    expect(w.probe.cookieQueries).toEqual([MANIFEST.session.cookieDomains])
    expect(w.probe.fetched).toEqual([])
  })

  it('matches the cookie name exactly', async () => {
    const w = world()
    w.probe.cookies = () => ['session_old', 'Session', 'session2']
    w.input.manifest = ASSERT_ONLY
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'probe',
      errorClass: 'not-logged-in',
    })
  })

  it('reports a hook that answers with something other than a list as probe: internal', async () => {
    const w = world()
    w.probe.cookies = () => 'session' as unknown as string[]
    w.input.manifest = ASSERT_ONLY
    expect(await runAuthFlow(w.input)).toEqual({ status: 'failed', stage: 'probe', errorClass: 'internal' })
  })
})

describe('a fetch probe', () => {
  it('fetches the path on the home origin, and reads the JSON path', async () => {
    const w = world()
    w.probe.respond = () => LOGGED_IN
    w.input.manifest = withProbe(FETCH_PROBE)
    expect(await runAuthFlow(w.input)).toEqual({ status: 'ok' })
    expect(w.probe.fetched).toEqual([`${WWW}/api/me`])
    expect(w.probe.cookieQueries).toEqual([])
  })

  it('is logged in on the expected status alone when there is no JSON path', async () => {
    const w = world()
    w.probe.respond = () => ({ status: 204, contentType: null, body: null })
    w.input.manifest = withProbe({
      kind: 'fetch',
      path: '/api/me',
      expectStatus: 204,
      loggedOutStatuses: [401],
    })
    expect(await runAuthFlow(w.input)).toEqual({ status: 'ok' })
  })

  it('reads a logged-out status as not-logged-in, which a retry may try again', async () => {
    const w = world()
    let calls = 0
    w.probe.respond = () => (++calls < 3 ? { status: 401, contentType: null, body: null } : LOGGED_IN)
    w.input.manifest = {
      ...withProbe(FETCH_PROBE),
      auth: { steps: [{ op: 'retry', times: 2, steps: [{ op: 'assertLoggedIn' }] }], frameOrigins: [] },
    }
    expect(await runAuthFlow(w.input)).toEqual({ status: 'ok' })
    expect(w.probe.fetched).toHaveLength(3)
  })

  it('honours the manifest list of logged-out statuses', async () => {
    const w = world()
    w.probe.respond = () => ({ status: 403, contentType: 'application/json', body: {} })
    w.input.manifest = withProbe({ ...FETCH_PROBE, loggedOutStatuses: [401, 403] })
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'probe',
      errorClass: 'not-logged-in',
    })
  })

  it('reads any other unexpected status as probe: unavailable, and never retries it', async () => {
    // A 403 that isn't an HTML page is an endpoint refusing, not bot protection.
    for (const status of [500, 503, 302, 404, 403]) {
      const w = world()
      w.probe.respond = () => ({ status, contentType: 'text/plain', body: 'nope' })
      w.input.manifest = {
        ...withProbe(FETCH_PROBE),
        auth: { steps: [{ op: 'retry', times: 3, steps: [{ op: 'assertLoggedIn' }] }], frameOrigins: [] },
      }
      expect(await runAuthFlow(w.input)).toEqual({
        status: 'failed',
        stage: 'probe',
        errorClass: 'unavailable',
      })
      expect(w.probe.fetched).toHaveLength(1)
    }
  })

  it('is not logged in when the JSON path is missing or falsy', async () => {
    for (const body of [{}, { shopper: {} }, { shopper: { id: 0 } }, { shopper: null }, [], 'null']) {
      const w = world()
      w.probe.respond = () => ({ status: 200, contentType: 'application/json', body })
      w.input.manifest = withProbe(FETCH_PROBE)
      expect(await runAuthFlow(w.input)).toMatchObject({ stage: 'probe', errorClass: 'not-logged-in' })
    }
  })

  it('compares with equals strictly when the manifest gives it', async () => {
    const w = world()
    w.probe.respond = () => ({ status: 200, contentType: 'application/json', body: { IsLoggedIn: 'true' } })
    w.input.manifest = withProbe({ ...FETCH_PROBE, jsonPath: 'IsLoggedIn', equals: true })
    expect(await runAuthFlow(w.input)).toMatchObject({ errorClass: 'not-logged-in' })

    const v = world()
    v.probe.respond = () => ({ status: 200, contentType: 'application/json', body: { IsLoggedIn: true } })
    v.input.manifest = withProbe({ ...FETCH_PROBE, jsonPath: 'IsLoggedIn', equals: true })
    expect(await runAuthFlow(v.input)).toEqual({ status: 'ok' })
  })

  it('parses a JSON body that arrived as text', async () => {
    const w = world()
    w.probe.respond = () => ({ status: 200, contentType: 'application/json', body: '{"shopper":{"id":7}}' })
    w.input.manifest = withProbe(FETCH_PROBE)
    expect(await runAuthFlow(w.input)).toEqual({ status: 'ok' })
  })

  it('refuses an HTML answer where it expected JSON, as an error or interstitial page', async () => {
    const w = world()
    w.probe.respond = () => ({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: '<html>Sign in</html>',
    })
    w.input.manifest = withProbe(FETCH_PROBE)
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'probe',
      errorClass: 'unavailable',
    })
  })

  it('refuses markup with no content type as HTML too', async () => {
    const w = world()
    w.probe.respond = () => ({ status: 200, contentType: null, body: '  <!doctype html>' })
    w.input.manifest = withProbe(FETCH_PROBE)
    expect(await runAuthFlow(w.input)).toMatchObject({ errorClass: 'unavailable' })
  })

  it('reports a hook that answers with no result as probe: internal', async () => {
    const w = world()
    w.probe.respond = () => null as never
    w.input.manifest = withProbe(FETCH_PROBE)
    expect(await runAuthFlow(w.input)).toEqual({ status: 'failed', stage: 'probe', errorClass: 'internal' })
  })

  it('reports a hook error as probe: internal, without its message', async () => {
    const w = world()
    w.probe.respond = () => {
      throw new Error(`fetch failed: ${CANARY.password}`)
    }
    w.input.manifest = withProbe(FETCH_PROBE)
    const outcome = await runAuthFlow(w.input)
    expect(outcome).toEqual({ status: 'failed', stage: 'probe', errorClass: 'internal' })
    expect(JSON.stringify(outcome)).not.toContain(CANARY.password)
  })

  it('ends the flow as blocked when the hook says the site refused the probe', async () => {
    const w = world()
    w.probe.respond = () => {
      throw new ValetError('probe', 'blocked-by-site')
    }
    w.input.manifest = {
      ...withProbe(FETCH_PROBE),
      auth: { steps: [{ op: 'retry', times: 3, steps: [{ op: 'assertLoggedIn' }] }], frameOrigins: [] },
    }
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'blocked',
      stage: 'probe',
      errorClass: 'blocked-by-site',
    })
    expect(w.probe.fetched).toHaveLength(1)
    expect(w.audit.events.at(-1)).toEqual({
      type: 'login-finished',
      adapterId: 'shop',
      outcome: 'blocked',
      stage: 'probe',
      errorClass: 'blocked-by-site',
    })
  })

  it('ends the flow as blocked when the hook says the site rate-limited the probe', async () => {
    const w = world()
    w.probe.respond = () => {
      throw new ValetError('probe', 'rate-limited')
    }
    w.input.manifest = withProbe(FETCH_PROBE)
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'blocked',
      stage: 'probe',
      errorClass: 'rate-limited',
    })
  })
})

// The hook returns what the site said; the flow decides that it was a refusal, as the runtime's
// looksBlocked does in the tool partition, so a hook that forgets to throw can't skip the cooldown.
describe('a fetch probe answered by the site refusing us', () => {
  it('reads a returned 429 as blocked: rate-limited, and never retries it', async () => {
    const w = world()
    w.probe.respond = () => ({ status: 429, contentType: 'application/json', body: {} })
    w.input.manifest = {
      ...withProbe(FETCH_PROBE),
      auth: { steps: [{ op: 'retry', times: 3, steps: [{ op: 'assertLoggedIn' }] }], frameOrigins: [] },
    }
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'blocked',
      stage: 'probe',
      errorClass: 'rate-limited',
    })
    expect(w.probe.fetched).toHaveLength(1)
    expect(w.audit.events.at(-1)).toEqual({
      type: 'login-finished',
      adapterId: 'shop',
      outcome: 'blocked',
      stage: 'probe',
      errorClass: 'rate-limited',
    })
  })

  it('reads a 429 as rate-limited even when the manifest lists it as logged out', async () => {
    const w = world()
    w.probe.respond = () => ({ status: 429, contentType: null, body: null })
    w.input.manifest = withProbe({ ...FETCH_PROBE, loggedOutStatuses: [401, 429] })
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'blocked',
      stage: 'probe',
      errorClass: 'rate-limited',
    })
  })

  it('reads a 429 as rate-limited even when the manifest expects it', async () => {
    const w = world()
    w.probe.respond = () => ({ status: 429, contentType: null, body: null })
    w.input.manifest = withProbe({
      kind: 'fetch',
      path: '/api/me',
      expectStatus: 429,
      loggedOutStatuses: [401],
    })
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'blocked',
      stage: 'probe',
      errorClass: 'rate-limited',
    })
  })

  it('reads an HTML 403 as blocked-by-site, even when the manifest lists 403 as logged out', async () => {
    const w = world()
    w.probe.respond = () => ({ status: 403, contentType: 'text/html', body: '<html>Forbidden</html>' })
    w.input.manifest = withProbe({ ...FETCH_PROBE, loggedOutStatuses: [401, 403] })
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'blocked',
      stage: 'probe',
      errorClass: 'blocked-by-site',
    })
  })

  it("reads Akamai's Access Denied page as blocked-by-site, even on the expected status", async () => {
    const w = world()
    const page = '<html><h1>Access Denied</h1><p>Reference #18.2f3a.1700000000</p></html>'
    w.probe.respond = () => ({ status: 200, contentType: 'text/html', body: page })
    // No jsonPath: without the block check, the expected status alone would read as logged in.
    w.input.manifest = withProbe({
      kind: 'fetch',
      path: '/api/me',
      expectStatus: 200,
      loggedOutStatuses: [401],
    })
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'blocked',
      stage: 'probe',
      errorClass: 'blocked-by-site',
    })
  })

  it('does not read an HTML page that only mentions access denied as a block', async () => {
    const w = world()
    w.probe.respond = () => ({
      status: 200,
      contentType: 'text/html',
      body: '<p>Access denied? Sign in.</p>',
    })
    w.input.manifest = withProbe({
      kind: 'fetch',
      path: '/api/me',
      expectStatus: 200,
      loggedOutStatuses: [401],
    })
    expect(await runAuthFlow(w.input)).toEqual({ status: 'ok' })
  })

  it('does not read a JSON body that says access denied as a block', async () => {
    const w = world()
    w.probe.respond = () => ({
      status: 401,
      contentType: 'application/json',
      body: 'Access Denied. Reference #1',
    })
    w.input.manifest = withProbe(FETCH_PROBE)
    expect(await runAuthFlow(w.input)).toMatchObject({ status: 'failed', errorClass: 'not-logged-in' })
  })

  it('does not read an HTML page with no text body as a block', async () => {
    const w = world()
    w.probe.respond = () => ({ status: 401, contentType: 'text/html', body: null })
    w.input.manifest = withProbe(FETCH_PROBE)
    expect(await runAuthFlow(w.input)).toMatchObject({ status: 'failed', errorClass: 'not-logged-in' })
  })
})

// The schema refuses these paths. The manifests here skip it, as a hand-built one would.
describe('where a fetch probe may go', () => {
  for (const path of [
    '//evil.test/api/me',
    '/\\evil.test/api/me',
    '\\\\evil.test/api/me',
    'https://evil.test/x',
  ]) {
    it(`refuses ${JSON.stringify(path)}, which would leave the home origin, without fetching`, async () => {
      const w = world()
      w.input.manifest = withProbe({ ...FETCH_PROBE, path })
      expect(await runAuthFlow(w.input)).toEqual({
        status: 'failed',
        stage: 'probe',
        errorClass: 'host-not-allowed',
      })
      expect(w.probe.fetched).toEqual([])
    })
  }

  it('refuses a probe when the home origin is not somewhere the auth partition may go', async () => {
    const w = world()
    w.input.manifest = { ...withProbe(FETCH_PROBE), navigation: [LOGIN] }
    w.page.navigate(LOGIN_PAGE)
    expect(await runAuthFlow(w.input)).toMatchObject({ stage: 'probe', errorClass: 'host-not-allowed' })
    expect(w.probe.fetched).toEqual([])
  })

  it('refuses a probe when the home page is not https', async () => {
    const w = world()
    w.input.manifest = { ...withProbe(FETCH_PROBE), home: 'http://www.shop.test/' }
    expect(await runAuthFlow(w.input)).toMatchObject({ stage: 'probe', errorClass: 'host-not-allowed' })
    expect(w.probe.fetched).toEqual([])
  })

  it('refuses a probe whose home does not parse', async () => {
    const w = world()
    w.input.manifest = { ...withProbe(FETCH_PROBE), home: 'not a url' }
    expect(await runAuthFlow(w.input)).toMatchObject({ stage: 'probe', errorClass: 'host-not-allowed' })
    expect(w.probe.fetched).toEqual([])
  })
})

describe('the flow always finishes with the probe', () => {
  it('runs the probe when the flow has no assertLoggedIn, and fails if it says logged out', async () => {
    const w = world()
    w.input.manifest = manifestWithSteps([{ op: 'goto', url: LOGIN_PAGE }])
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'probe',
      errorClass: 'not-logged-in',
    })
    expect(w.probe.calls).toBe(1)
    expect(w.audit.events.at(-1)).toMatchObject({ type: 'login-finished', outcome: 'failed', stage: 'probe' })
  })

  it('reports ok from a flow without assertLoggedIn only once the probe agrees', async () => {
    const w = world()
    w.input.manifest = manifestWithSteps([
      { op: 'goto', url: LOGIN_PAGE },
      { op: 'click', selector: '#submit' },
    ])
    expect(await runAuthFlow(w.input)).toEqual({ status: 'ok' })
    expect(w.probe.calls).toBe(1)
  })

  it('does not probe twice when the last step was a passing assertLoggedIn', async () => {
    const w = world()
    expect(await runAuthFlow(w.input)).toEqual({ status: 'ok' })
    expect(w.probe.calls).toBe(1)
  })

  it('does not probe twice when the passing assertLoggedIn was the last step inside a branch', async () => {
    const w = world()
    w.page.cookies.add('session')
    w.input.manifest = manifestWithSteps([
      { op: 'when', condition: { not: { visible: '#email' } }, steps: [{ op: 'assertLoggedIn' }] },
    ])
    expect(await runAuthFlow(w.input)).toEqual({ status: 'ok' })
    expect(w.probe.calls).toBe(1)
  })

  it('probes again when anything ran after the last assertLoggedIn', async () => {
    const w = world()
    w.page.cookies.add('session')
    w.input.manifest = manifestWithSteps([{ op: 'assertLoggedIn' }, { op: 'goto', url: LOGIN_PAGE }])
    expect(await runAuthFlow(w.input)).toEqual({ status: 'ok' })
    expect(w.probe.calls).toBe(2)
  })

  it('catches a session lost after the flow asserted it, so the flow cannot end on a stale answer', async () => {
    const w = world()
    w.page.cookies.add('session')
    w.page.site[`${WWW}/logout`] = {}
    w.input.manifest = manifestWithSteps([{ op: 'assertLoggedIn' }, { op: 'goto', url: `${WWW}/logout` }])
    w.probe.cookies = () => (w.page.currentUrl().endsWith('/logout') ? [] : ['session'])
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'probe',
      errorClass: 'not-logged-in',
    })
  })

  it('checks the page once more after the final probe', async () => {
    const w = world()
    w.page.site[`${WWW}/denied`] = { blocked: true }
    w.input.manifest = manifestWithSteps([{ op: 'goto', url: LOGIN_PAGE }])
    w.probe.cookies = () => {
      w.page.navigate(`${WWW}/denied`)
      return ['session']
    }
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'blocked',
      stage: 'auth-step',
      errorClass: 'blocked-by-site',
    })
  })

  it('does not probe a flow that ended in needsUser or a failure', async () => {
    const w = world()
    w.input.manifest = manifestWithSteps([{ op: 'needsUser', reason: 'captcha' }])
    await runAuthFlow(w.input)
    expect(w.probe.calls).toBe(0)

    const v = world()
    v.input.manifest = manifestWithSteps([
      { op: 'goto', url: `${WWW}/nowhere` },
      { op: 'click', selector: '#x' },
    ])
    await runAuthFlow(v.input)
    expect(v.probe.calls).toBe(0)
  })
})

describe('readJsonPath', () => {
  it('follows own properties only', () => {
    expect(readJsonPath({ a: { b: 1 } }, 'a.b')).toBe(1)
    expect(readJsonPath({}, 'constructor')).toBeUndefined()
    expect(readJsonPath({}, '__proto__')).toBeUndefined()
    expect(readJsonPath({ a: {} }, 'a.toString')).toBeUndefined()
  })

  it('reads through arrays by index', () => {
    expect(readJsonPath({ a: [{ b: 'x' }] }, 'a.0.b')).toBe('x')
  })

  it('is undefined for a text body that is not JSON', () => {
    expect(readJsonPath('<html>', 'a')).toBeUndefined()
  })
})
