// The spike's pure parts. The Electron side is run by hand in the sessions (docs/m2-runbook.md).

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  chromeUserAgent,
  describeCookies,
  findLeaks,
  initiatorOf,
  isBlockPage,
  isCheckoutPath,
  isPaymentHost,
  isWwwCookie,
  judgeRequest,
  keyShape,
  settingsFrom,
  silentVerdict,
  summariseTraffic,
  touchesDeny,
} from './lib.mjs'
import { scrub } from './scrub.mjs'

const LIVE = 'https://www.woolworths.com.au'

describe('settings', () => {
  it('defaults to login mode, a Chrome user agent and the live site', () => {
    expect(settingsFrom({})).toEqual({
      mode: 'login',
      uaMode: 'chrome',
      origin: LIVE,
      siteDomain: 'woolworths.com.au',
    })
  })

  it('takes Electron’s user agent only when asked, and a fake site for a dry run', () => {
    const s = settingsFrom({
      SPIKE_UA: 'electron',
      SPIKE_MODE: 'record',
      SPIKE_ORIGIN: 'http://localhost:8417/x',
    })
    expect(s).toEqual({
      mode: 'record',
      uaMode: 'electron',
      origin: 'http://localhost:8417',
      siteDomain: 'localhost',
    })
  })

  it('refuses a mode or user agent it does not know', () => {
    expect(() => settingsFrom({ SPIKE_MODE: 'checkout' })).toThrow(/SPIKE_MODE/)
    expect(() => settingsFrom({ SPIKE_UA: 'default' })).toThrow(/SPIKE_UA/)
  })

  it('builds a clean Chrome user agent from the engine’s major version', () => {
    expect(chromeUserAgent('142.0.7444.59')).toContain('Chrome/142.0.0.0 Safari/537.36')
    expect(chromeUserAgent('142.0.7444.59')).not.toMatch(/Electron/)
  })
})

describe('cookies', () => {
  it('describes names and domains, never values', () => {
    const described = describeCookies([
      { name: 'b', domain: '.x', value: 'secret', httpOnly: true, session: false },
    ])
    expect(JSON.stringify(described)).not.toContain('secret')
  })

  it('treats the www host and the parent domain as www cookies, not the auth host', () => {
    expect(isWwwCookie({ domain: 'www.woolworths.com.au' }, LIVE)).toBe(true)
    expect(isWwwCookie({ domain: '.woolworths.com.au' }, LIVE)).toBe(true)
    expect(isWwwCookie({ domain: 'auth.woolworths.com.au' }, LIVE)).toBe(false)
  })
})

describe('pages and requests', () => {
  it('spots a block page by title or status', () => {
    expect(isBlockPage({ title: 'Access Denied', status: 200 })).toBe(true)
    expect(isBlockPage({ title: 'Woolworths', status: 403 })).toBe(true)
    expect(isBlockPage({ title: 'Woolworths', status: 200 })).toBe(false)
  })

  it('records the shape of JSON, never its values', () => {
    const shape = keyShape({
      ShopperDetails: { FirstName: 'Nick', IsLoggedIn: true },
      Items: [{ Id: 1 }],
      None: [],
    })
    expect(shape).toEqual({
      Items: [{ Id: 'number' }],
      None: ['empty'],
      ShopperDetails: { FirstName: 'string', IsLoggedIn: 'boolean' },
    })
    expect(JSON.stringify(shape)).not.toContain('Nick')
  })

  it('flags deny segments and payment hosts', () => {
    expect(touchesDeny('/api/v3/ui/checkout/order')).toBe(true)
    expect(touchesDeny('/shop/browse/fruit-veg')).toBe(false)
    expect(isPaymentHost('www.paypal.com')).toBe(true)
    expect(isPaymentHost('payments.woolworths.com.au')).toBe(true)
    expect(isPaymentHost('assets.woolworths.com.au')).toBe(false)
    expect(isCheckoutPath(`${LIVE}/shop/checkout/payment`)).toBe(true)
  })

  it('names who started a request', () => {
    expect(initiatorOf({ resourceType: 'mainFrame', hasFrame: true })).toBe('main-frame')
    expect(initiatorOf({ resourceType: 'xhr', hasFrame: true, frameHasParent: true })).toBe('subframe')
    expect(initiatorOf({ resourceType: 'xhr', hasFrame: false })).toBe('worker-or-browser')
  })

  it('keeps host and path only, and cancels order and payment calls on checkout', () => {
    const post = { method: 'POST', url: `${LIVE}/api/v3/ui/checkout/order?token=x`, resourceType: 'xhr' }
    const onCheckout = judgeRequest(post, { onCheckout: true })
    expect(onCheckout.cancel).toBe('order-or-payment-call')
    expect(onCheckout.entry).toMatchObject({
      host: 'www.woolworths.com.au',
      path: '/api/v3/ui/checkout/order',
      deny: true,
    })
    expect(JSON.stringify(onCheckout.entry)).not.toContain('token')
    expect(judgeRequest(post, { onCheckout: false }).cancel).toBeNull()
    expect(judgeRequest({ ...post, method: 'GET' }, { onCheckout: true }).cancel).toBeNull()
    const pay = { method: 'GET', url: 'https://checkoutshopper-live.adyen.com/x', resourceType: 'script' }
    expect(judgeRequest(pay, { onCheckout: false }).cancel).toBe('payment-host')
  })

  it('summarises traffic by page view', () => {
    const summary = summariseTraffic([
      {
        path: '/',
        requests: [
          { host: 'a', resourceType: 'mainFrame', deny: false, cancelled: null },
          { host: 'b', resourceType: 'xhr', deny: true, cancelled: 'payment-host' },
        ],
      },
    ])
    expect(summary[0]).toMatchObject({
      requests: 2,
      pageInitiated: 1,
      deny: 1,
      cancelled: 1,
      byHost: { a: 1, b: 1 },
    })
  })
})

describe('silent redirect verdict', () => {
  const site = { host: 'www.woolworths.com.au' }
  it('is silent when the callback arrives without a login page', () => {
    const steps = [
      { ...site, path: '/auth/login' },
      { host: 'auth.woolworths.com.au', path: '/authorize' },
      { ...site, path: '/auth/callback' },
      { ...site, path: '/' },
    ]
    expect(silentVerdict(steps, LIVE)).toEqual({ outcome: 'silent', landedOn: '/' })
  })

  it('is not silent when Auth0 shows a login page', () => {
    const steps = [
      { ...site, path: '/auth/login' },
      { host: 'auth.woolworths.com.au', path: '/u/login/password' },
    ]
    expect(silentVerdict(steps, LIVE)).toEqual({ outcome: 'login-page-shown', page: '/u/login/password' })
    expect(silentVerdict([{ ...site, path: '/auth/login' }], LIVE)).toEqual({ outcome: 'undecided' })
  })
})

describe('scrub', () => {
  it.each([
    ['email address', '"title": "Hi nick@example.test"'],
    ['state or code parameter', '"path": "/auth/callback?code=abc"'],
    ['state or code field', '"state": "hKFo2SBz"'],
    ['cookie value', '"value": "x"'],
    ['JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.sig'],
    ['long opaque token', 'AQAAAAEAAAAbcdefghijklmnopqrstuvwxyz0123456789'],
    ['card-like number', '4111 1111 1111 1111'],
  ])('catches a %s', (kind, line) => {
    expect(findLeaks(`{\n${line}\n}`)).toContainEqual({ line: 2, kind })
  })

  it('passes a clean result', () => {
    expect(
      findLeaks('{\n  "path": "/u/login/password",\n  "name": "_abck",\n  "chrome": "142.0.7444.59"\n}'),
    ).toEqual([])
  })

  it('writes a draft only when every file is clean', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spike-scrub-'))
    const clean = {
      at: '2026-11-07T00:00:00.000Z',
      mode: 'silent',
      uaMode: 'chrome',
      electron: '44.3.0',
      blocked: null,
      steps: [{ host: 'www.woolworths.com.au', path: '/auth/callback' }],
      verdict: { outcome: 'silent', landedOn: '/' },
    }
    await writeFile(join(dir, 'a.json'), JSON.stringify(clean, null, 2))
    const passed = await scrub(dir)
    expect(passed.leaks).toEqual([])
    expect(passed.draft).toContain('verdict: silent')

    await writeFile(
      join(dir, 'b.json'),
      JSON.stringify({ ...clean, steps: [{ host: 'h', path: '/?state=abc' }] }),
    )
    const failed = await scrub(dir)
    expect(failed.draft).toBeNull()
    expect(failed.leaks).toContainEqual({ file: 'b.json', line: 1, kind: 'state or code parameter' })
  })

  it('summarises every mode', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spike-scrub-'))
    const base = { at: '2026-11-07T00:00:00.000Z', uaMode: 'chrome', electron: '44.3.0' }
    const files = {
      'login.json': {
        ...base,
        mode: 'login',
        blocked: null,
        authPages: [
          {
            host: 'auth.woolworths.com.au',
            path: '/u/login/password',
            rememberDevice: true,
            forms: [
              {
                actionOrigin: 'https://auth.woolworths.com.au',
                fields: [{ name: 'password', type: 'password' }],
              },
            ],
          },
        ],
        toolProbe: { main: { status: 200, isJson: true }, isolated: { error: 'Error: x' } },
        authCookies: [{ name: 'auth0' }],
        toolCookiesAfterLoad: [{ name: '_abck' }],
      },
      'probe.json': {
        ...base,
        mode: 'probe',
        blocked: 'tool hit a block page',
        bootstrap: { status: 200, keys: { A: 'string' } },
      },
      'record.json': {
        ...base,
        mode: 'record',
        summary: [{ path: '/', requests: 3, pageInitiated: 2, deny: 0, cancelled: 0 }],
      },
    }
    for (const [name, value] of Object.entries(files))
      await writeFile(join(dir, name), JSON.stringify(value, null, 2))
    const { draft, leaks } = await scrub(dir)
    expect(leaks).toEqual([])
    expect(draft).toContain(
      'password:password → https://auth.woolworths.com.au (remember this device offered)',
    )
    expect(draft).toContain('trolley in the isolated world: Error: x')
    expect(draft).toContain('Stopped on a block')
    expect(draft).toContain('| / | 3 | 2 | 0 | 0 |')
  })
})
