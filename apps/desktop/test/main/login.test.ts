// @vitest-environment node
// The AuthRunner over runAuthFlow, the probe hooks, and the login hand-off.

import {
  type AuditEvent,
  type AuditRecord,
  type ManifestInput,
  parseManifest,
  type SecretValue,
  SiteAdapterError,
} from '@siteadapter/core'
import type { AuthRunRequest, LoginMarkerStore } from '@siteadapter/runtime'
import { describe, expect, it } from 'vitest'
import { disabledOtpReader } from '../../src/main/core/credentials'
import { demoCredentials } from '../../src/main/core/demo'
import {
  authProbe,
  createAuthRunner,
  Handoffs,
  isBlockedPage,
  probeLoggedIn,
  SessionTracker,
} from '../../src/main/core/login'
import { FakeAuthPage, FakeDriver, ManualTimers, SHOP } from './fixtures'

const HASH = 'e'.repeat(64)
const NOW = Date.parse('2026-11-07T00:00:00.000Z')

function manifestWith(change: Partial<ManifestInput>) {
  return parseManifest({ ...SHOP, ...change })
}

function audit() {
  const events: AuditEvent[] = []
  return {
    events,
    sink: {
      async append(event: AuditEvent): Promise<AuditRecord> {
        events.push(event)
        return { seq: events.length, at: new Date(NOW).toISOString(), event, prev: '', hash: '' }
      },
    },
  }
}

function markers() {
  const cleared: string[] = []
  const store: LoginMarkerStore = {
    read: async () => ({ kind: 'unset' }),
    set: async () => {},
    hold: async () => {},
    clear: async (id) => {
      cleared.push(id)
    },
  }
  return { store, cleared }
}

function setup() {
  const timers = new ManualTimers()
  const banners: string[] = []
  let changes = 0
  const sessions = new SessionTracker(
    () => new Date(NOW),
    () => changes++,
  )
  const marker = markers()
  const handoffs = new Handoffs({
    now: () => NOW,
    timers,
    windowMs: 15 * 60_000,
    showBanner: (id) => banners.push(`show ${id}`),
    closeBanner: (id) => banners.push(`close ${id}`),
    markers: marker.store,
    sessions,
    onChange: () => changes++,
  })
  return { timers, banners, sessions, handoffs, marker, changes: () => changes }
}

const cookieProbe = { cookieDomains: ['www.shop.test'], probe: { kind: 'cookie' as const, name: 'sid' } }

describe('probe hooks', () => {
  it('ask the auth page, and refuse a URL off home’s origin', async () => {
    const manifest = manifestWith({})
    const page = new FakeAuthPage()
    page.cookies = ['sid']
    const probe = authProbe(manifest, page)
    await probe.fetch('https://www.shop.test/api/me')
    expect(page.fetched).toEqual(['https://www.shop.test/api/me'])
    await expect(probe.fetch('https://login.shop.test/api/me')).rejects.toEqual(
      new SiteAdapterError('probe', 'host-not-allowed'),
    )
    await expect(probe.fetch('not a url')).rejects.toEqual(new SiteAdapterError('probe', 'host-not-allowed'))
    expect(await probe.cookieNames(['www.shop.test'])).toEqual(['sid'])
  })

  it('read the manifest’s probe as auth-flow does', async () => {
    const page = new FakeAuthPage()
    const cookie = manifestWith({ session: cookieProbe })
    expect(await probeLoggedIn(cookie, authProbe(cookie, page))).toBe(false)
    page.cookies = ['sid']
    expect(await probeLoggedIn(cookie, authProbe(cookie, page))).toBe(true)

    const fetch = manifestWith({
      session: {
        cookieDomains: ['www.shop.test'],
        probe: { kind: 'fetch', path: '/api/me', expectStatus: 200, jsonPath: 'user.in', equals: true },
      },
    })
    page.fetchResult = { status: 200, contentType: 'application/json', body: { user: { in: true } } }
    expect(await probeLoggedIn(fetch, authProbe(fetch, page))).toBe(true)
    expect(page.fetched.at(-1)).toBe('https://www.shop.test/api/me')
    page.fetchResult = { status: 200, contentType: 'application/json', body: { user: { in: 'yes' } } }
    expect(await probeLoggedIn(fetch, authProbe(fetch, page))).toBe(false)
    page.fetchResult = { status: 401, contentType: null, body: null }
    expect(await probeLoggedIn(fetch, authProbe(fetch, page))).toBe(false)
    const truthy = manifestWith({
      session: {
        cookieDomains: ['www.shop.test'],
        probe: { kind: 'fetch', path: '/api/me', expectStatus: 200, jsonPath: 'id' },
      },
    })
    page.fetchResult = { status: 200, contentType: 'application/json', body: { id: 7 } }
    expect(await probeLoggedIn(truthy, authProbe(truthy, page))).toBe(true)
    const any = manifestWith({
      session: {
        cookieDomains: ['www.shop.test'],
        probe: { kind: 'fetch', path: '/api/me', expectStatus: 200 },
      },
    })
    expect(await probeLoggedIn(any, authProbe(any, page))).toBe(true)
  })

  it('see Akamai’s block page only with both of its phrases, and never throw', async () => {
    const page = new FakeAuthPage()
    page.text = ['Access Denied']
    expect(await isBlockedPage(page)).toBe(false)
    page.text = ['Access Denied … Reference #18.abc']
    expect(await isBlockedPage(page)).toBe(true)
    page.textPresent = async () => {
      throw new Error('gone')
    }
    expect(await isBlockedPage(page)).toBe(false)
  })
})

describe('createAuthRunner', () => {
  function runner(steps: ManifestInput['auth']['steps'], page = new FakeAuthPage()) {
    const s = setup()
    const log = audit()
    const driver = new FakeDriver()
    driver.nextPage = () => page
    const manifest = manifestWith({ session: cookieProbe, auth: { steps } })
    const registered: SecretValue[] = []
    const run = createAuthRunner({
      grants: { find: async () => null, list: async () => [], put: async () => {}, revoke: async () => {} },
      credentials: demoCredentials(disabledOtpReader),
      audit: log.sink,
      clock: () => new Date(NOW),
      sleep: async () => {},
      typingDelayMs: 0,
      flowTimeoutMs: 5000,
      sessions: s.sessions,
      handoffs: s.handoffs,
      callInfo: () => ({ tool: 'add', client: 'Claude Code' }),
      filledFor: async () => ({
        filled: [{ secret: 'login', field: 'username' }],
        origin: 'https://login.shop.test',
      }),
    })
    const request: AuthRunRequest = {
      adapterId: 'shop',
      adapterHash: HASH,
      manifest,
      driver,
      callId: 'call1',
      signal: new AbortController().signal,
      registerForRedaction: (secret) => registered.push(secret),
    }
    return { ...s, run: () => run(request), log, page, driver, registered }
  }

  it('reports ok when the probe passes, closes the page, and adds no login events of its own', async () => {
    const page = new FakeAuthPage()
    page.cookies = ['sid']
    const r = runner([{ op: 'assertLoggedIn' }], page)
    expect(await r.run()).toEqual({ status: 'ok' })
    expect(page.closed).toBe(true)
    // runAuthFlow's own pair, and nothing else.
    expect(r.log.events.map((e) => e.type)).toEqual(['login-started', 'login-finished'])
    expect(r.sessions.get('shop').state).toBe('logged-in')
  })

  it('on needsUser keeps the window, hands it to the person with the note in the app only', async () => {
    const r = runner([{ op: 'needsUser', reason: 'captcha', note: 'Solve the puzzle in this window.' }])
    const outcome = await r.run()
    // Only the code goes back to the runtime and on to the client.
    expect(outcome).toEqual({ status: 'needsUser', reason: 'captcha' })
    expect(JSON.stringify(outcome)).not.toContain('puzzle')
    expect(r.page.closed).toBe(false)
    expect(r.page.handedTo).toEqual(['captcha'])
    expect(r.banners).toEqual(['show shop'])
    expect(r.handoffs.list()).toEqual([
      expect.objectContaining({
        kind: 'needs-user',
        adapterId: 'shop',
        reason: 'captcha',
        note: 'Solve the puzzle in this window.',
        startedBy: 'call',
        tool: 'add',
        client: 'Claude Code',
        callId: 'call1',
        filled: [{ secret: 'login', field: 'username' }],
        filledOrigin: 'https://login.shop.test',
        windowOpen: true,
        closesAt: new Date(NOW + 15 * 60_000).toISOString(),
      }),
    ])
    expect(r.sessions.get('shop')).toMatchObject({ state: 'needs-user', needsUser: 'captcha' })
  })

  it('reports a failure or a block with its codes only, and closes the page', async () => {
    const failed = runner([{ op: 'fail', errorClass: 'auth-failed', note: 'nope' }])
    expect(await failed.run()).toEqual({ status: 'failed', stage: 'auth-step', errorClass: 'auth-failed' })
    expect(failed.page.closed).toBe(true)
    const blocked = runner([{ op: 'fail', errorClass: 'blocked-by-site' }])
    expect(await blocked.run()).toEqual({ status: 'blocked', errorClass: 'blocked-by-site' })
    expect(blocked.sessions.get('shop').state).toBe('expired')
  })
})

describe('Handoffs', () => {
  function started(startedBy: 'call' | 'person' = 'call') {
    const s = setup()
    const page = new FakeAuthPage()
    const driver = new FakeDriver()
    const manifest = manifestWith({ session: cookieProbe })
    s.handoffs.start({
      manifest,
      driver,
      page,
      reason: 'login-required',
      note: null,
      startedBy,
      callId: null,
      tool: null,
      client: null,
      filled: [],
      filledOrigin: null,
    })
    return { ...s, page, driver }
  }

  it('hands the session over only once the probe says logged in, then clears the hold', async () => {
    const h = started()
    await expect(h.handoffs.finish('shop')).rejects.toEqual(new SiteAdapterError('probe', 'not-logged-in'))
    expect(h.driver.handoffs).toEqual([])
    expect(h.handoffs.has('shop')).toBe(true)
    h.page.cookies = ['sid']
    await h.handoffs.finish('shop')
    expect(h.driver.handoffs).toEqual([{ cookieDomains: ['www.shop.test'], storage: [] }])
    expect(h.marker.cleared).toEqual(['shop'])
    expect(h.page.closed).toBe(true)
    expect(h.handoffs.list()).toEqual([])
    expect(h.sessions.get('shop').state).toBe('logged-in')
    await expect(h.handoffs.finish('shop')).rejects.toEqual(new SiteAdapterError('login', 'not-found'))
  })

  it('marks the window closed when the person hides it, and shows it again on request', async () => {
    const h = started()
    h.page.personClosed()
    await Promise.resolve()
    await Promise.resolve()
    expect(h.handoffs.list()[0]?.windowOpen).toBe(false)
    expect(h.handoffs.show('shop')).toBe(true)
    expect(h.page.handedTo).toEqual(['login-required', 'login-required'])
    expect(h.handoffs.list()[0]?.windowOpen).toBe(true)
    expect(h.handoffs.show('other')).toBe(false)
  })

  it('closes the window without a hand-off when the person gives up or time runs out', async () => {
    const given = started()
    await given.handoffs.close('shop')
    expect(given.driver.handoffs).toEqual([])
    expect(given.page.closed).toBe(true)
    expect(given.sessions.get('shop').state).toBe('expired')
    await given.handoffs.close('shop')

    const timed = started()
    timed.timers.fire()
    await Promise.resolve()
    expect(timed.handoffs.list()).toEqual([])
    expect(timed.page.closed).toBe(true)
  })

  it('leaves the session as it was when the person gives up on a window they opened', async () => {
    const h = started('person')
    // Opening it doesn't say the session needs the person: the tool partition may be logged in.
    expect(h.sessions.get('shop').state).toBe('unknown')
    expect(h.handoffs.list()[0]?.startedBy).toBe('person')
    h.sessions.set('shop', 'logged-in')
    await h.handoffs.close('shop')
    expect(h.sessions.get('shop').state).toBe('logged-in')
    expect(h.page.closed).toBe(true)

    const timed = started('person')
    timed.sessions.set('shop', 'logged-in')
    timed.timers.fire()
    await Promise.resolve()
    expect(timed.sessions.get('shop').state).toBe('logged-in')
  })

  it('marks the session logged in once a window the person opened passes the probe', async () => {
    const h = started('person')
    h.page.cookies = ['sid']
    await h.handoffs.finish('shop')
    expect(h.sessions.get('shop').state).toBe('logged-in')
    expect(h.driver.handoffs).toHaveLength(1)
  })

  it('replaces an earlier hand-off for the same adapter, and closes them all on quit', () => {
    const h = started()
    const second = new FakeAuthPage()
    h.handoffs.start({
      manifest: manifestWith({}),
      driver: h.driver,
      page: second,
      reason: 'otp-required',
      note: null,
      startedBy: 'call',
      callId: null,
      tool: null,
      client: null,
      filled: [],
      filledOrigin: null,
    })
    expect(h.page.closed).toBe(true)
    expect(h.handoffs.list().map((i) => i.reason)).toEqual(['otp-required'])
    h.handoffs.closeAll()
    expect(second.closed).toBe(true)
    expect(h.handoffs.list()).toEqual([])
  })
})

describe('SessionTracker', () => {
  it('starts unknown and keeps since across repeats of one state', () => {
    let now = NOW
    const tracker = new SessionTracker(
      () => new Date(now),
      () => {},
    )
    expect(tracker.get('shop')).toEqual({ state: 'unknown', checkedAt: null, needsUser: null, since: null })
    tracker.set('shop', 'logged-in')
    now += 1000
    tracker.set('shop', 'logged-in')
    expect(tracker.get('shop')).toEqual({
      state: 'logged-in',
      checkedAt: new Date(now).toISOString(),
      needsUser: null,
      since: new Date(NOW).toISOString(),
    })
    tracker.set('shop', 'expired', 'captcha')
    expect(tracker.get('shop').needsUser).toBeNull()
  })
})

describe('a login that fills a secret', () => {
  it('registers each secret for redaction before typing, and disposes its own copy', async () => {
    const s = setup()
    const log = audit()
    const page = new FakeAuthPage()
    page.cookies = ['sid']
    page.element = {
      visible: true,
      tagName: 'INPUT',
      inputType: 'email',
      autocomplete: 'username',
      inputMode: null,
      frameOrigin: 'https://login.shop.test',
      formActionOrigin: 'https://login.shop.test',
      inputReachable: true,
    }
    const driver = new FakeDriver()
    driver.nextPage = () => page
    const manifest = manifestWith({
      session: cookieProbe,
      auth: {
        steps: [
          { op: 'goto', url: 'https://login.shop.test/login' },
          { op: 'fill', selector: '#user', value: { secret: 'login', field: 'username' } },
          { op: 'assertLoggedIn' },
        ],
      },
    })
    const grant = {
      adapterId: 'shop',
      adapterHash: HASH,
      secret: 'login',
      provider: 'fake' as const,
      itemRef: 'demo-woolworths',
      origins: ['https://login.shop.test'],
      grantedAt: new Date(NOW).toISOString(),
    }
    const registered: { secret: SecretValue; matched: boolean }[] = []
    const run = createAuthRunner({
      grants: {
        find: async () => grant,
        list: async () => [grant],
        put: async () => {},
        revoke: async () => {},
      },
      credentials: demoCredentials(disabledOtpReader),
      audit: log.sink,
      clock: () => new Date(NOW),
      sleep: async () => {},
      typingDelayMs: 0,
      flowTimeoutMs: 5000,
      sessions: s.sessions,
      handoffs: s.handoffs,
      callInfo: () => ({ tool: null, client: null }),
      filledFor: async () => ({ filled: [], origin: null }),
    })
    const outcome = await run({
      adapterId: 'shop',
      adapterHash: HASH,
      manifest,
      driver,
      callId: null,
      signal: new AbortController().signal,
      // As the runtime does: it keeps its own clone.
      registerForRedaction: (secret) =>
        registered.push({ secret, matched: secret.occursIn('x twofactor@example.test') }),
    })
    expect(outcome).toEqual({ status: 'ok' })
    expect(registered).toHaveLength(1)
    expect(registered[0]?.matched).toBe(true)
    expect(registered[0]?.secret.disposed).toBe(true)
    expect(page.typed).toEqual([{ text: '[secret]', secret: true }])
    expect(log.events.map((e) => e.type)).toEqual(['login-started', 'secret-used', 'login-finished'])
    expect(JSON.stringify(log.events)).not.toContain('twofactor@example.test')
  })
})
