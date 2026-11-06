import { SiteAdapterError } from '@siteadapter/core'
import { describe, expect, it, vi } from 'vitest'
import { POLL_MS } from '../src/interpreter'
import { runAuthFlow } from '../src/run-auth-flow'
import { ACCOUNT_PAGE, EVIL, LOGIN_PAGE, manifestWithSteps, START, world } from './fixtures'

// Every flow finishes with the probe. Tests about a step that doesn't itself log in start with the
// session cookie already in the auth partition, so that the step is all they measure.

describe('goto', () => {
  it('navigates to an allowed URL', async () => {
    const w = world()
    w.page.cookies.add('session')
    w.input.manifest = manifestWithSteps([{ op: 'goto', url: LOGIN_PAGE }])
    expect(await runAuthFlow(w.input)).toEqual({ status: 'ok' })
    expect(w.page.visited).toEqual([LOGIN_PAGE])
  })

  it('refuses a URL off the navigation allowlist before navigating', async () => {
    const w = world()
    w.input.manifest = manifestWithSteps([{ op: 'goto', url: 'https://evil.test/' }])
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'navigate',
      errorClass: 'navigation-escaped',
    })
    expect(w.page.visited).toEqual([])
  })

  it('refuses a lookalike host that merely starts with an allowed origin', async () => {
    const w = world()
    w.input.manifest = manifestWithSteps([{ op: 'goto', url: 'https://login.shop.test.evil.test/' }])
    expect(await runAuthFlow(w.input)).toMatchObject({ errorClass: 'navigation-escaped' })
    expect(w.page.visited).toEqual([])
  })

  it('refuses a URL whose userinfo makes it look allowed', async () => {
    const w = world()
    w.input.manifest = manifestWithSteps([{ op: 'goto', url: 'https://login.shop.test@evil.test/' }])
    expect(await runAuthFlow(w.input)).toMatchObject({ errorClass: 'navigation-escaped' })
    expect(w.page.visited).toEqual([])
  })

  it('aborts when an allowed URL redirects off the allowlist', async () => {
    const w = world()
    w.page.site['https://login.shop.test/sso'] = { redirectTo: `${EVIL}/phish` }
    w.input.manifest = manifestWithSteps([{ op: 'goto', url: 'https://login.shop.test/sso' }])
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'navigate',
      errorClass: 'navigation-escaped',
    })
  })

  it('aborts when a redirect leaves the allowlist and comes back', async () => {
    const w = world()
    w.page.site['https://login.shop.test/sso'] = { redirectTo: `${EVIL}/bounce` }
    w.page.site[`${EVIL}/bounce`] = { redirectTo: LOGIN_PAGE }
    w.input.manifest = manifestWithSteps([{ op: 'goto', url: 'https://login.shop.test/sso' }])
    const outcome = await runAuthFlow(w.input)
    expect(w.page.currentUrl()).toBe(LOGIN_PAGE)
    expect(outcome).toMatchObject({ errorClass: 'navigation-escaped' })
  })

  it('aborts when a redirect drops to plain http on an allowed host', async () => {
    const w = world()
    w.page.site['https://login.shop.test/sso'] = { redirectTo: 'http://login.shop.test/' }
    w.input.manifest = manifestWithSteps([{ op: 'goto', url: 'https://login.shop.test/sso' }])
    expect(await runAuthFlow(w.input)).toMatchObject({ errorClass: 'navigation-escaped' })
  })

  it('reports a driver failure as navigate: internal, without its message', async () => {
    const w = world()
    vi.spyOn(w.page, 'goto').mockRejectedValue(
      new Error('net::ERR_FAILED https://login.shop.test/?token=abc'),
    )
    w.input.manifest = manifestWithSteps([{ op: 'goto', url: LOGIN_PAGE }])
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'navigate',
      errorClass: 'internal',
    })
  })

  it('passes a driver SiteAdapterError through unchanged', async () => {
    const w = world()
    vi.spyOn(w.page, 'goto').mockRejectedValue(new SiteAdapterError('navigate', 'timed-out'))
    w.input.manifest = manifestWithSteps([{ op: 'goto', url: LOGIN_PAGE }])
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'navigate',
      errorClass: 'timed-out',
    })
  })
})

describe('click', () => {
  it('clicks a visible element', async () => {
    const w = world()
    w.input.manifest = manifestWithSteps([
      { op: 'goto', url: LOGIN_PAGE },
      { op: 'click', selector: '#submit' },
    ])
    expect(await runAuthFlow(w.input)).toEqual({ status: 'ok' })
    expect(w.page.currentUrl()).toBe(ACCOUNT_PAGE)
  })

  it('fails on a missing element without clicking', async () => {
    const w = world()
    w.input.manifest = manifestWithSteps([
      { op: 'goto', url: LOGIN_PAGE },
      { op: 'click', selector: '#nope' },
    ])
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'auth-step',
      errorClass: 'element-missing',
    })
    expect(w.page.clicked).toEqual([])
  })

  it('fails on a hidden element without clicking', async () => {
    const w = world()
    w.page.site[LOGIN_PAGE] = {
      ...w.page.site[LOGIN_PAGE],
      elements: { '#submit': { tagName: 'button', visible: false } },
    }
    w.input.manifest = manifestWithSteps([
      { op: 'goto', url: LOGIN_PAGE },
      { op: 'click', selector: '#submit' },
    ])
    expect(await runAuthFlow(w.input)).toMatchObject({ errorClass: 'element-missing' })
    expect(w.page.clicked).toEqual([])
  })

  it('aborts when a click follows an open redirect to another host', async () => {
    const w = world()
    w.page.site[LOGIN_PAGE] = {
      ...w.page.site[LOGIN_PAGE],
      clicks: { '#submit': 'https://www.shop.test/redirect?to=https://evil.test/' },
    }
    w.page.site['https://www.shop.test/redirect?to=https://evil.test/'] = { redirectTo: `${EVIL}/` }
    w.input.manifest = manifestWithSteps([
      { op: 'goto', url: LOGIN_PAGE },
      { op: 'click', selector: '#submit' },
      { op: 'assertLoggedIn' },
    ])
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'navigate',
      errorClass: 'navigation-escaped',
    })
    expect(w.probe.calls).toBe(0)
  })
})

describe('fill with a literal', () => {
  it('types the literal into the element as a plain string, with no origin restriction', async () => {
    const w = world()
    w.page.cookies.add('session')
    w.input.manifest = manifestWithSteps([
      { op: 'goto', url: LOGIN_PAGE },
      { op: 'fill', selector: '#search', value: { literal: 'milk' } },
    ])
    expect(await runAuthFlow(w.input)).toEqual({ status: 'ok' })
    expect(w.page.typed).toEqual([
      {
        selector: '#search',
        url: LOGIN_PAGE,
        text: 'milk',
        secret: false,
        delayMs: 40,
        allowedOrigins: undefined,
      },
    ])
  })

  it('does not audit a literal as a secret use', async () => {
    const w = world()
    w.input.manifest = manifestWithSteps([
      { op: 'goto', url: LOGIN_PAGE },
      { op: 'fill', selector: '#search', value: { literal: 'milk' } },
    ])
    await runAuthFlow(w.input)
    expect(w.audit.events.map((e) => e.type)).toEqual(['login-started', 'login-finished'])
  })

  it('fails on a missing element without typing', async () => {
    const w = world()
    w.input.manifest = manifestWithSteps([
      { op: 'goto', url: LOGIN_PAGE },
      { op: 'fill', selector: '#nope', value: { literal: 'milk' } },
    ])
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'auth-step',
      errorClass: 'element-missing',
    })
    expect(w.page.typed).toEqual([])
  })
})

describe('waitFor', () => {
  it('returns at once when the condition already holds', async () => {
    const w = world()
    w.page.cookies.add('session')
    w.input.manifest = manifestWithSteps([
      { op: 'goto', url: LOGIN_PAGE },
      { op: 'waitFor', condition: { visible: '#email' }, timeoutMs: 1000 },
    ])
    expect(await runAuthFlow(w.input)).toEqual({ status: 'ok' })
    expect(w.clock.sleeps).toEqual([])
  })

  it('polls every 250 ms until the condition holds', async () => {
    const w = world()
    w.page.cookies.add('session')
    w.input.manifest = manifestWithSteps([
      { op: 'goto', url: LOGIN_PAGE },
      { op: 'waitFor', condition: { textPresent: 'Ready' }, timeoutMs: 5000 },
    ])
    w.clock.onSleep = () => {
      if (w.clock.now >= START + 1000) w.page.site[LOGIN_PAGE] = { text: ['Ready'] }
    }
    expect(await runAuthFlow(w.input)).toEqual({ status: 'ok' })
    expect(w.clock.sleeps).toEqual([POLL_MS, POLL_MS, POLL_MS, POLL_MS])
  })

  it('times out with condition-timeout', async () => {
    const w = world()
    w.input.manifest = manifestWithSteps([
      { op: 'goto', url: LOGIN_PAGE },
      { op: 'waitFor', condition: { visible: '#never' }, timeoutMs: 1000 },
    ])
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'auth-step',
      errorClass: 'condition-timeout',
    })
    expect(w.clock.now).toBe(START + 1000)
    expect(w.clock.sleeps).toEqual([POLL_MS, POLL_MS, POLL_MS, POLL_MS])
  })

  it('gives the condition one last look at the deadline', async () => {
    const w = world()
    w.page.cookies.add('session')
    w.input.manifest = manifestWithSteps([
      { op: 'goto', url: LOGIN_PAGE },
      { op: 'waitFor', condition: { textPresent: 'Ready' }, timeoutMs: 1000 },
    ])
    w.clock.onSleep = () => {
      if (w.clock.now >= START + 1000) w.page.site[LOGIN_PAGE] = { text: ['Ready'] }
    }
    expect(await runAuthFlow(w.input)).toEqual({ status: 'ok' })
  })

  it('catches a redirect off the allowlist while waiting, not only after', async () => {
    const w = world()
    w.input.manifest = manifestWithSteps([
      { op: 'goto', url: LOGIN_PAGE },
      { op: 'waitFor', condition: { visible: '#never' }, timeoutMs: 10_000 },
    ])
    w.clock.onSleep = () => {
      if (w.clock.now === START + 500) w.page.navigate(`${EVIL}/`)
    }
    expect(await runAuthFlow(w.input)).toMatchObject({ errorClass: 'navigation-escaped' })
    expect(w.clock.now).toBe(START + 500)
  })

  it('catches a block page while waiting', async () => {
    const w = world()
    w.page.site['https://www.shop.test/denied'] = { blocked: true }
    w.input.manifest = manifestWithSteps([
      { op: 'goto', url: LOGIN_PAGE },
      { op: 'waitFor', condition: { visible: '#never' }, timeoutMs: 10_000 },
    ])
    w.clock.onSleep = () => {
      if (w.clock.now === START + 500) w.page.navigate('https://www.shop.test/denied')
    }
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'blocked',
      stage: 'auth-step',
      errorClass: 'blocked-by-site',
    })
  })

  it('stops at the flow deadline when that comes before the step timeout', async () => {
    const w = world()
    w.input.flowTimeoutMs = 2000
    w.input.manifest = manifestWithSteps([
      { op: 'goto', url: LOGIN_PAGE },
      { op: 'waitFor', condition: { visible: '#never' }, timeoutMs: 10_000 },
    ])
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'timeout',
      errorClass: 'timed-out',
    })
    expect(w.clock.now).toBe(START + 2000)
    expect(w.clock.sleeps).toHaveLength(2000 / POLL_MS)
  })

  it('reports a page that throws while being inspected as auth-step: internal', async () => {
    const w = world()
    vi.spyOn(w.page, 'textPresent').mockRejectedValue(new Error('Execution context was destroyed'))
    w.input.manifest = manifestWithSteps([
      { op: 'goto', url: LOGIN_PAGE },
      { op: 'waitFor', condition: { textPresent: 'x' }, timeoutMs: 1000 },
    ])
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'auth-step',
      errorClass: 'internal',
    })
  })
})

describe('pause', () => {
  it('sleeps for the given time', async () => {
    const w = world()
    w.page.cookies.add('session')
    w.input.manifest = manifestWithSteps([{ op: 'pause', ms: 750 }])
    expect(await runAuthFlow(w.input)).toEqual({ status: 'ok' })
    expect(w.clock.sleeps).toEqual([750])
  })

  it('never sleeps past the flow deadline', async () => {
    const w = world()
    w.input.flowTimeoutMs = 500
    w.input.manifest = manifestWithSteps([{ op: 'pause', ms: 30_000 }])
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'timeout',
      errorClass: 'timed-out',
    })
    expect(w.clock.sleeps).toEqual([500])
  })
})

describe('when', () => {
  it('runs its steps when the condition holds', async () => {
    const w = world()
    w.input.manifest = manifestWithSteps([
      { op: 'goto', url: LOGIN_PAGE },
      {
        op: 'when',
        condition: { textPresent: 'Sign in' },
        steps: [{ op: 'fill', selector: '#search', value: { literal: 'then' } }],
        otherwise: [{ op: 'fill', selector: '#search', value: { literal: 'otherwise' } }],
      },
    ])
    await runAuthFlow(w.input)
    expect(w.page.typed.map((t) => t.text)).toEqual(['then'])
  })

  it('runs otherwise when the condition does not hold', async () => {
    const w = world()
    w.input.manifest = manifestWithSteps([
      { op: 'goto', url: LOGIN_PAGE },
      {
        op: 'when',
        condition: { textPresent: 'Remember this device?' },
        steps: [{ op: 'fill', selector: '#search', value: { literal: 'then' } }],
        otherwise: [{ op: 'fill', selector: '#search', value: { literal: 'otherwise' } }],
      },
    ])
    await runAuthFlow(w.input)
    expect(w.page.typed.map((t) => t.text)).toEqual(['otherwise'])
  })

  it('does nothing when the condition does not hold and there is no otherwise', async () => {
    const w = world()
    w.page.cookies.add('session')
    w.input.manifest = manifestWithSteps([
      { op: 'goto', url: LOGIN_PAGE },
      {
        op: 'when',
        condition: { textPresent: 'Remember this device?' },
        steps: [{ op: 'fail', errorClass: 'auth-failed' }],
      },
    ])
    expect(await runAuthFlow(w.input)).toEqual({ status: 'ok' })
  })

  it('nests', async () => {
    const w = world()
    w.input.manifest = manifestWithSteps([
      { op: 'goto', url: LOGIN_PAGE },
      {
        op: 'when',
        condition: { visible: '#email' },
        steps: [
          {
            op: 'when',
            condition: { not: { visible: '#otp' } },
            steps: [{ op: 'fail', errorClass: 'unexpected-shape' }],
            otherwise: [{ op: 'needsUser', reason: 'otp-required', note: 'Enter the code from your app' }],
          },
        ],
      },
    ])
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'needsUser',
      reason: 'otp-required',
      appNote: 'Enter the code from your app',
    })
  })
})

describe('retry', () => {
  it('re-runs its steps after a retryable failure until they succeed', async () => {
    const w = world()
    let probes = 0
    w.probe.cookies = () => (++probes >= 3 ? ['session'] : [])
    w.input.manifest = manifestWithSteps([{ op: 'retry', times: 3, steps: [{ op: 'assertLoggedIn' }] }])
    expect(await runAuthFlow(w.input)).toEqual({ status: 'ok' })
    expect(probes).toBe(3)
  })

  it('runs its steps at most times + 1 times, then reports the last failure', async () => {
    const w = world()
    w.input.manifest = manifestWithSteps([{ op: 'retry', times: 2, steps: [{ op: 'assertLoggedIn' }] }])
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'probe',
      errorClass: 'not-logged-in',
    })
    expect(w.probe.calls).toBe(3)
  })

  it('retries a condition timeout', async () => {
    const w = world()
    w.input.manifest = manifestWithSteps([
      { op: 'goto', url: LOGIN_PAGE },
      { op: 'retry', times: 1, steps: [{ op: 'waitFor', condition: { visible: '#never' }, timeoutMs: 500 }] },
    ])
    expect(await runAuthFlow(w.input)).toMatchObject({ errorClass: 'condition-timeout' })
    expect(w.clock.now).toBe(START + 1000)
  })

  it('retries a fail step', async () => {
    const w = world()
    w.input.manifest = manifestWithSteps([
      {
        op: 'retry',
        times: 2,
        steps: [
          { op: 'pause', ms: 100 },
          { op: 'fail', errorClass: 'auth-failed' },
        ],
      },
    ])
    expect(await runAuthFlow(w.input)).toMatchObject({ errorClass: 'auth-failed' })
    expect(w.clock.sleeps).toEqual([100, 100, 100])
  })

  it('never retries a navigation escape', async () => {
    const w = world()
    w.page.site['https://login.shop.test/sso'] = { redirectTo: `${EVIL}/` }
    w.input.manifest = manifestWithSteps([
      { op: 'retry', times: 5, steps: [{ op: 'goto', url: 'https://login.shop.test/sso' }] },
    ])
    expect(await runAuthFlow(w.input)).toMatchObject({ errorClass: 'navigation-escaped' })
    expect(w.page.visited).toEqual(['https://login.shop.test/sso'])
  })

  it('never retries a secret-fill guard failure', async () => {
    const w = world()
    w.input.manifest = manifestWithSteps([
      { op: 'goto', url: LOGIN_PAGE },
      {
        op: 'retry',
        times: 5,
        steps: [{ op: 'fill', selector: '#search', value: { secret: 'login', field: 'password' } }],
      },
    ])
    expect(await runAuthFlow(w.input)).toMatchObject({ stage: 'secret-fill' })
    expect(w.provider.calls).toEqual([])
    expect(w.audit.events.filter((e) => e.type === 'login-finished')).toHaveLength(1)
  })

  it('retries an element that is missing from a click', async () => {
    const w = world()
    w.page.cookies.add('session')
    let sleeps = 0
    w.clock.onSleep = () => {
      if (++sleeps === 2) {
        w.page.site[LOGIN_PAGE] = { elements: { '#later': { tagName: 'button' } } }
      }
    }
    w.input.manifest = manifestWithSteps([
      { op: 'goto', url: LOGIN_PAGE },
      {
        op: 'retry',
        times: 2,
        steps: [
          { op: 'pause', ms: 100 },
          { op: 'click', selector: '#later' },
        ],
      },
    ])
    expect(await runAuthFlow(w.input)).toEqual({ status: 'ok' })
    expect(w.page.clicked).toEqual(['#later'])
    expect(w.clock.sleeps).toEqual([100, 100])
  })

  it('never retries a fill whose element went missing while the person approved Touch ID', async () => {
    const w = world()
    w.provider.beforeResolve = () => w.page.navigate(ACCOUNT_PAGE)
    w.input.manifest = manifestWithSteps([
      {
        op: 'retry',
        times: 2,
        steps: [
          { op: 'goto', url: LOGIN_PAGE },
          { op: 'fill', selector: '#password', value: { secret: 'login', field: 'password' } },
        ],
      },
    ])
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'secret-fill',
      errorClass: 'element-missing',
    })
    expect(w.provider.calls.length).toBe(1)
    expect(w.page.visited).toEqual([LOGIN_PAGE])
    expect(w.page.typed).toEqual([])
  })

  it('never retries a fill after the page bounced through another host while resolving', async () => {
    const w = world()
    w.provider.beforeResolve = () => {
      w.page.navigate(`${EVIL}/x`)
      w.page.navigate(LOGIN_PAGE)
    }
    w.input.manifest = manifestWithSteps([
      {
        op: 'retry',
        times: 2,
        steps: [
          { op: 'goto', url: LOGIN_PAGE },
          { op: 'fill', selector: '#password', value: { secret: 'login', field: 'password' } },
        ],
      },
    ])
    expect(await runAuthFlow(w.input)).toMatchObject({ errorClass: 'navigation-escaped' })
    expect(w.provider.calls.length).toBe(1)
    expect(w.page.typed).toEqual([])
  })

  it('never retries a secret-fill element-missing even before anything was resolved', async () => {
    const w = world()
    w.input.manifest = manifestWithSteps([
      { op: 'goto', url: LOGIN_PAGE },
      {
        op: 'retry',
        times: 2,
        steps: [{ op: 'fill', selector: '#gone', value: { secret: 'login', field: 'password' } }],
      },
    ])
    const inspect = vi.spyOn(w.page, 'inspect')
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'secret-fill',
      errorClass: 'element-missing',
    })
    expect(inspect).toHaveBeenCalledTimes(1)
  })

  it('never retries a credential failure, so the person is not asked twice', async () => {
    const w = world()
    w.provider.items['op://siteadapter/Shop'] = {}
    w.input.manifest = manifestWithSteps([
      { op: 'goto', url: LOGIN_PAGE },
      {
        op: 'retry',
        times: 2,
        steps: [{ op: 'fill', selector: '#password', value: { secret: 'login', field: 'password' } }],
      },
    ])
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'credential',
      errorClass: 'field-missing',
    })
    expect(w.provider.calls.length).toBe(1)
  })

  it('never retries needsUser', async () => {
    const w = world()
    w.page.cookies.add('session')
    w.input.manifest = manifestWithSteps([
      {
        op: 'retry',
        times: 5,
        steps: [{ op: 'assertLoggedIn' }, { op: 'needsUser', reason: 'captcha' }],
      },
    ])
    expect(await runAuthFlow(w.input)).toEqual({ status: 'needsUser', reason: 'captcha' })
    expect(w.probe.calls).toBe(1)
  })

  it('never retries a block', async () => {
    const w = world()
    w.page.site['https://www.shop.test/denied'] = { blocked: true }
    w.input.manifest = manifestWithSteps([
      { op: 'retry', times: 5, steps: [{ op: 'goto', url: 'https://www.shop.test/denied' }] },
    ])
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'blocked',
      stage: 'auth-step',
      errorClass: 'blocked-by-site',
    })
    expect(w.page.visited).toHaveLength(1)
  })

  it('never retries past the flow deadline', async () => {
    const w = world()
    w.input.flowTimeoutMs = 300
    w.input.manifest = manifestWithSteps([
      {
        op: 'retry',
        times: 5,
        steps: [
          { op: 'pause', ms: 200 },
          { op: 'fail', errorClass: 'auth-failed' },
        ],
      },
    ])
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'timeout',
      errorClass: 'timed-out',
    })
    expect(w.clock.sleeps).toEqual([200, 100])
  })

  it('does not start another attempt once a failed one has used up the flow', async () => {
    const w = world()
    w.input.flowTimeoutMs = 1000
    let probes = 0
    w.probe.cookies = () => {
      probes++
      w.clock.now += 2000
      return []
    }
    w.input.manifest = manifestWithSteps([{ op: 'retry', times: 3, steps: [{ op: 'assertLoggedIn' }] }])
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'timeout',
      errorClass: 'timed-out',
    })
    expect(probes).toBe(1)
  })

  it('nests inside when, and when inside retry', async () => {
    const w = world()
    let probes = 0
    w.probe.cookies = () => (++probes >= 2 ? ['session'] : [])
    w.input.manifest = manifestWithSteps([
      { op: 'goto', url: LOGIN_PAGE },
      {
        op: 'when',
        condition: { visible: '#email' },
        steps: [
          {
            op: 'retry',
            times: 2,
            steps: [
              {
                op: 'when',
                condition: { textPresent: 'Sign in' },
                steps: [{ op: 'fill', selector: '#search', value: { literal: 'attempt' } }],
              },
              { op: 'assertLoggedIn' },
            ],
          },
        ],
      },
    ])
    expect(await runAuthFlow(w.input)).toEqual({ status: 'ok' })
    expect(w.page.typed.map((t) => t.text)).toEqual(['attempt', 'attempt'])
  })
})

describe('assertLoggedIn', () => {
  it('passes when the probe says logged in, and is not repeated at the end of the flow', async () => {
    const w = world()
    w.page.cookies.add('session')
    w.input.manifest = manifestWithSteps([{ op: 'assertLoggedIn' }])
    expect(await runAuthFlow(w.input)).toEqual({ status: 'ok' })
    expect(w.probe.cookieQueries).toEqual([['www.shop.test']])
  })

  it('fails with probe: not-logged-in when the probe says otherwise', async () => {
    const w = world()
    w.input.manifest = manifestWithSteps([{ op: 'assertLoggedIn' }])
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'probe',
      errorClass: 'not-logged-in',
    })
  })

  it('reports a probe that throws as probe: internal', async () => {
    const w = world()
    w.probe.cookies = () => {
      throw new Error('cookies failed: {"email":"someone@example.com"}')
    }
    w.input.manifest = manifestWithSteps([{ op: 'assertLoggedIn' }])
    expect(await runAuthFlow(w.input)).toEqual({ status: 'failed', stage: 'probe', errorClass: 'internal' })
  })
})

describe('needsUser and fail', () => {
  it('needsUser ends the flow with the manifest reason, and later steps do not run', async () => {
    const w = world()
    w.input.manifest = manifestWithSteps([
      { op: 'needsUser', reason: 'captcha' },
      { op: 'goto', url: LOGIN_PAGE },
    ])
    expect(await runAuthFlow(w.input)).toEqual({ status: 'needsUser', reason: 'captcha' })
    expect(w.page.visited).toEqual([])
  })

  it('fail ends the flow with auth-step and the step class, and later steps do not run', async () => {
    const w = world()
    w.input.manifest = manifestWithSteps([
      { op: 'fail', errorClass: 'unexpected-shape' },
      { op: 'goto', url: LOGIN_PAGE },
    ])
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'auth-step',
      errorClass: 'unexpected-shape',
    })
    expect(w.page.visited).toEqual([])
  })
})

describe('blocked', () => {
  it('reports blocked when a goto lands on the block page', async () => {
    const w = world()
    w.page.site[LOGIN_PAGE] = { blocked: true }
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'blocked',
      stage: 'auth-step',
      errorClass: 'blocked-by-site',
    })
    expect(w.provider.calls).toEqual([])
  })

  it('reports blocked when the page is already blocked before the first step', async () => {
    const w = world()
    w.page.site['https://www.shop.test/'] = { blocked: true }
    w.page.navigate('https://www.shop.test/')
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'blocked',
      stage: 'auth-step',
      errorClass: 'blocked-by-site',
    })
    expect(w.page.visited).toEqual([])
  })

  it('reports blocked after a click submits into a block', async () => {
    const w = world()
    w.page.site[ACCOUNT_PAGE] = { blocked: true }
    const outcome = await runAuthFlow(w.input)
    expect(outcome).toEqual({ status: 'blocked', stage: 'auth-step', errorClass: 'blocked-by-site' })
    expect(w.page.clicked).toEqual(['#submit'])
  })

  it('reports a block check that throws as auth-step: internal', async () => {
    const w = world()
    w.input.isBlockedPage = async () => {
      throw new Error('boom')
    }
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'auth-step',
      errorClass: 'internal',
    })
  })

  it('checks navigation before the block, so an escape to a block page reports the escape', async () => {
    const w = world()
    w.page.site[`${EVIL}/`] = { blocked: true }
    w.page.site['https://login.shop.test/sso'] = { redirectTo: `${EVIL}/` }
    w.input.manifest = manifestWithSteps([{ op: 'goto', url: 'https://login.shop.test/sso' }])
    expect(await runAuthFlow(w.input)).toMatchObject({ errorClass: 'navigation-escaped' })
  })
})

describe('the whole-flow timeout', () => {
  it('stops between steps once the deadline has passed', async () => {
    const w = world()
    w.input.flowTimeoutMs = 1000
    w.input.manifest = manifestWithSteps([
      { op: 'pause', ms: 400 },
      { op: 'pause', ms: 400 },
      { op: 'pause', ms: 400 },
      { op: 'goto', url: LOGIN_PAGE },
    ])
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'timeout',
      errorClass: 'timed-out',
    })
    expect(w.page.visited).toEqual([])
  })

  it('counts time a step spent in the driver', async () => {
    const w = world()
    w.input.flowTimeoutMs = 1000
    vi.spyOn(w.page, 'goto').mockImplementation(async (url: string) => {
      w.clock.now += 5000
      w.page.navigate(url)
    })
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'timeout',
      errorClass: 'timed-out',
    })
    expect(w.provider.calls).toEqual([])
  })
})

describe('the navigation check', () => {
  it('allows a fresh page on about:blank', async () => {
    const w = world()
    w.page.cookies.add('session')
    w.page.history.push('about:blank')
    w.input.manifest = manifestWithSteps([{ op: 'goto', url: LOGIN_PAGE }])
    expect(await runAuthFlow(w.input)).toEqual({ status: 'ok' })
  })

  it('refuses any other non-https URL in the history', async () => {
    const w = world()
    w.page.history.push('data:text/html,hello')
    w.input.manifest = manifestWithSteps([{ op: 'goto', url: LOGIN_PAGE }])
    expect(await runAuthFlow(w.input)).toMatchObject({ errorClass: 'navigation-escaped' })
    expect(w.page.visited).toEqual([])
  })

  it('reports a history that cannot be read as navigate: internal', async () => {
    const w = world()
    vi.spyOn(w.page, 'committedUrls').mockImplementation(() => {
      throw new Error('webContents destroyed')
    })
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'navigate',
      errorClass: 'internal',
    })
  })
})
