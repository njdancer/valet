// session.ensure() as tool code calls it: probe, login through the injected auth runner, handoff,
// re-probe, guarded by the durable login attempt marker.

import { defineAdapter, type EnsureResult, SiteAdapterError, tool } from '@siteadapter/core'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { MARKER_SET_REASON } from '../src/session'
import { akamaiDenied, flush, json } from './fakes'
import { call, fixture, HASH, HOME, loggedIn, loggedOut, manifest, SESSION_URL } from './fixtures'

/** Calls ensure() and returns its result as the tool's output. */
const ensureOnce = defineAdapter({
  manifest,
  tools: {
    run_test: tool({
      input: z.object({}),
      output: z.unknown(),
      run: async (ctx) => ctx.session.ensure(),
    }),
  },
})

/** Calls ensure() and throws unless it was ok, as most real tools will. */
const ensureOrThrow = defineAdapter({
  manifest,
  tools: {
    run_test: tool({
      input: z.object({}),
      output: z.string(),
      run: async (ctx) => {
        const session = await ctx.session.ensure()
        if (session.status !== 'ok') throw new Error(`session ${session.status}`)
        return 'logged in'
      },
    }),
  },
})

describe('session.ensure', () => {
  it('returns ok without logging in when the probe says logged in', async () => {
    const { host, authRunner, page } = fixture(ensureOnce)

    expect(await host.call(call)).toEqual({ status: 'ok', output: { status: 'ok' } })
    expect(authRunner).not.toHaveBeenCalled()
    expect(page.fetches).toEqual([
      { url: SESSION_URL, init: { method: 'GET', headers: { accept: 'application/json' } } },
    ])
  })

  it('logs in when logged out: marker, auth runner, handoff, marker cleared, re-probe', async () => {
    const { host, authRunner, page, driver, markers, audit } = fixture(ensureOnce)
    const steps: string[] = []
    page.route('GET', SESSION_URL, () => {
      steps.push('probe')
      return steps.includes('handoff') ? loggedIn : loggedOut
    })
    authRunner.mockImplementation(async (request) => {
      steps.push(`auth:marker=${markers.marked.has('example-shop')}`)
      expect(request).toMatchObject({
        adapterId: 'example-shop',
        adapterHash: HASH,
        manifest,
        driver,
        callId: 'call-1',
      })
      expect(request.signal.aborted).toBe(false)
      return { status: 'ok' }
    })
    driver.onHandoff = () => {
      steps.push(`handoff:marker=${markers.marked.has('example-shop')}`)
      steps.push('handoff')
    }

    expect(await host.call(call)).toEqual({ status: 'ok', output: { status: 'ok' } })
    expect(steps).toEqual(['probe', 'auth:marker=true', 'handoff:marker=true', 'handoff', 'probe'])
    expect(driver.handoffs).toEqual([
      { cookieDomains: ['www.example.com'], storage: [{ origin: HOME, keys: ['token'] }] },
    ])
    expect(markers.marked.size).toBe(0)
    expect(audit.types()).toEqual(['tool-called', 'login-started', 'login-finished', 'tool-finished'])
    expect(audit.events[1]).toEqual({ type: 'login-started', adapterId: 'example-shop', callId: 'call-1' })
    expect(audit.events[2]).toEqual({ type: 'login-finished', adapterId: 'example-shop', outcome: 'ok' })
  })

  it('refuses to log in while a previous attempt is still marked', async () => {
    const { host, authRunner, page, markers } = fixture(ensureOnce)
    page.route('GET', SESSION_URL, loggedOut)
    markers.marked.add('example-shop')

    expect(await host.call(call)).toEqual({
      status: 'ok',
      output: { status: 'needsUser', reason: MARKER_SET_REASON },
    })
    expect(authRunner).not.toHaveBeenCalled()
    expect(markers.marked.has('example-shop')).toBe(true)
  })

  it('treats a marker store it cannot read as set', async () => {
    const { host, authRunner, page, markers } = fixture(ensureOnce)
    page.route('GET', SESSION_URL, loggedOut)
    markers.failOn = 'isSet'

    expect(await host.call(call)).toMatchObject({ output: { status: 'needsUser' } })
    expect(authRunner).not.toHaveBeenCalled()
  })

  it('does not log in when the marker cannot be written', async () => {
    const { host, authRunner, page, markers } = fixture(ensureOnce)
    page.route('GET', SESSION_URL, loggedOut)
    markers.failOn = 'set'

    expect(await host.call(call)).toEqual({
      status: 'ok',
      output: { status: 'failed', stage: 'auth-step', errorClass: 'internal' },
    })
    expect(authRunner).not.toHaveBeenCalled()
  })

  it('reports a failure when the marker cannot be cleared, leaving it set', async () => {
    const { host, page, markers } = fixture(ensureOnce)
    page.route('GET', SESSION_URL, loggedOut)
    markers.failOn = 'clear'

    expect(await host.call(call)).toMatchObject({ output: { status: 'failed', errorClass: 'internal' } })
    expect(markers.marked.has('example-shop')).toBe(true)
  })

  it('makes a call whose tool throws after needsUser report needsUser', async () => {
    const { host, page, authRunner, markers } = fixture(ensureOrThrow)
    page.route('GET', SESSION_URL, loggedOut)
    authRunner.mockResolvedValue({ status: 'needsUser', reason: 'The site is asking for a CAPTCHA.' })

    expect(await host.call(call)).toEqual({
      status: 'needsUser',
      reason: 'The site is asking for a CAPTCHA.',
    })
    expect(markers.marked.size).toBe(0)
  })

  it('makes a call whose tool throws after a failed login report that failure', async () => {
    const { host, page, authRunner, audit } = fixture(ensureOrThrow)
    page.route('GET', SESSION_URL, loggedOut)
    authRunner.mockResolvedValue({ status: 'failed', stage: 'secret-fill', errorClass: 'origin-mismatch' })

    expect(await host.call(call)).toEqual({
      status: 'failed',
      stage: 'secret-fill',
      errorClass: 'origin-mismatch',
    })
    expect(audit.events).toContainEqual({
      type: 'login-finished',
      adapterId: 'example-shop',
      outcome: 'failed',
      stage: 'secret-fill',
      errorClass: 'origin-mismatch',
    })
  })

  it('maps a login failure outside the error vocabulary to tool-run internal', async () => {
    const { host, page, authRunner } = fixture(ensureOrThrow)
    page.route('GET', SESSION_URL, loggedOut)
    authRunner.mockResolvedValue({
      status: 'failed',
      stage: 'page said: wrong password' as never,
      errorClass: 'x' as never,
    })

    expect(await host.call(call)).toEqual({ status: 'failed', stage: 'tool-run', errorClass: 'internal' })
  })

  it('lets a tool that handles needsUser and returns normally report ok', async () => {
    const { host, page, authRunner } = fixture(ensureOnce)
    page.route('GET', SESSION_URL, loggedOut)
    authRunner.mockResolvedValue({ status: 'needsUser', reason: 'Verify this device.' })

    expect(await host.call(call)).toEqual({
      status: 'ok',
      output: { status: 'needsUser', reason: 'Verify this device.' },
    })
  })

  it('keeps the marker set when the auth runner throws, and leaks nothing of the error', async () => {
    const { host, page, authRunner, markers, audit } = fixture(ensureOrThrow)
    page.route('GET', SESSION_URL, loggedOut)
    authRunner.mockRejectedValue(new Error('password hunter2 rejected'))

    const result = await host.call(call)
    expect(result).toEqual({ status: 'failed', stage: 'auth-step', errorClass: 'internal' })
    expect(markers.marked.has('example-shop')).toBe(true)
    expect(JSON.stringify(audit.events)).not.toContain('hunter2')
    expect(audit.events).toContainEqual({
      type: 'login-finished',
      adapterId: 'example-shop',
      outcome: 'failed',
      stage: 'auth-step',
      errorClass: 'internal',
    })
  })

  it('keeps the stage and class when the auth runner throws a SiteAdapterError', async () => {
    const { host, page, authRunner } = fixture(ensureOnce)
    page.route('GET', SESSION_URL, loggedOut)
    authRunner.mockRejectedValue(new SiteAdapterError('otp', 'not-found'))

    expect(await host.call(call)).toMatchObject({
      output: { status: 'failed', stage: 'otp', errorClass: 'not-found' },
    })
  })

  it('stops a second login attempt after the first one crashed', async () => {
    const { host, page, authRunner } = fixture(ensureOnce)
    page.route('GET', SESSION_URL, loggedOut)
    authRunner.mockRejectedValueOnce(new Error('renderer crashed'))

    await host.call(call)
    expect(await host.call({ ...call, callId: 'call-2' })).toMatchObject({ output: { status: 'needsUser' } })
    expect(authRunner).toHaveBeenCalledTimes(1)
  })

  it('reports not-logged-in when the login succeeded but the probe still disagrees', async () => {
    const { host, page, markers } = fixture(ensureOnce)
    page.route('GET', SESSION_URL, loggedOut)

    expect(await host.call(call)).toEqual({
      status: 'ok',
      output: { status: 'failed', stage: 'probe', errorClass: 'not-logged-in' },
    })
    expect(markers.marked.size).toBe(0)
  })

  it('reports a failed handoff and still clears the marker', async () => {
    const { host, page, driver, markers } = fixture(ensureOnce)
    page.route('GET', SESSION_URL, loggedOut)
    driver.onHandoff = () => {
      throw new Error('cookie store locked')
    }

    expect(await host.call(call)).toEqual({
      status: 'ok',
      output: { status: 'failed', stage: 'session-handoff', errorClass: 'internal' },
    })
    expect(markers.marked.size).toBe(0)
  })

  it('shares one probe and one login between concurrent ensure() calls', async () => {
    const results: EnsureResult[][] = []
    const { host, page, authRunner } = fixture(
      defineAdapter({
        manifest,
        tools: {
          run_test: tool({
            input: z.object({}),
            output: z.unknown(),
            run: async (ctx) => {
              results.push(
                await Promise.all([ctx.session.ensure(), ctx.session.ensure(), ctx.session.ensure()]),
              )
              return 'ok'
            },
          }),
        },
      }),
    )
    let loggedInNow = false
    page.route('GET', SESSION_URL, () => (loggedInNow ? loggedIn : loggedOut))
    authRunner.mockImplementation(async () => {
      loggedInNow = true
      return { status: 'ok' }
    })

    expect(await host.call(call)).toMatchObject({ status: 'ok' })
    expect(authRunner).toHaveBeenCalledTimes(1)
    expect(results).toEqual([[{ status: 'ok' }, { status: 'ok' }, { status: 'ok' }]])
    expect(page.fetches).toHaveLength(2)
  })

  it('probes again on a later ensure() once the first has finished', async () => {
    const { host, page } = fixture(
      defineAdapter({
        manifest,
        tools: {
          run_test: tool({
            input: z.object({}),
            output: z.unknown(),
            run: async (ctx) => [await ctx.session.ensure(), await ctx.session.ensure()],
          }),
        },
      }),
    )
    await host.call(call)
    expect(page.fetches).toHaveLength(2)
  })

  it('passes the secret-remembering hook to the auth runner', async () => {
    const { host, page, authRunner } = fixture(ensureOnce)
    page.route('GET', SESSION_URL, loggedOut)
    authRunner.mockImplementation(async (request) => {
      expect(typeof request.rememberSecret).toBe('function')
      return { status: 'failed', stage: 'credential', errorClass: 'locked' }
    })
    expect(await host.call(call)).toMatchObject({ output: { status: 'failed', errorClass: 'locked' } })
  })
})

describe('session.ensure and the site', () => {
  it('turns a blocked login into a blocked call and opens the breaker', async () => {
    const { host, page, authRunner, markers, audit } = fixture(ensureOnce)
    page.route('GET', SESSION_URL, loggedOut)
    authRunner.mockResolvedValue({ status: 'blocked' })

    expect(await host.call(call)).toEqual({ status: 'blocked', retryAfterMs: 60_000 })
    expect(markers.marked.size).toBe(0)
    expect(audit.events).toContainEqual({
      type: 'login-finished',
      adapterId: 'example-shop',
      outcome: 'failed',
      stage: 'auth-step',
      errorClass: 'blocked-by-site',
    })
    expect(await host.call({ ...call, callId: 'call-2' })).toEqual({
      status: 'blocked',
      retryAfterMs: 60_000,
    })
    expect(authRunner).toHaveBeenCalledTimes(1)
  })

  it('throws blocked-by-site to tool code when the probe gets Akamai’s page', async () => {
    let thrown: unknown
    const { host, page, authRunner } = fixture(
      defineAdapter({
        manifest,
        tools: {
          run_test: tool({
            input: z.object({}),
            output: z.unknown(),
            run: async (ctx) => {
              thrown = await ctx.session.ensure().catch((error: unknown) => error)
              return 'swallowed'
            },
          }),
        },
      }),
    )
    page.route('GET', SESSION_URL, akamaiDenied)

    expect(await host.call(call)).toEqual({ status: 'blocked', retryAfterMs: 60_000 })
    expect(thrown).toMatchObject({ stage: 'tool-run', errorClass: 'blocked-by-site' })
    expect(authRunner).not.toHaveBeenCalled()
  })

  it('reports a probe that throws as a probe failure', async () => {
    const { host, page } = fixture(ensureOnce)
    page.route('GET', SESSION_URL, () => {
      throw new Error('net::ERR_CONNECTION_RESET')
    })
    expect(await host.call(call)).toEqual({
      status: 'ok',
      output: { status: 'failed', stage: 'probe', errorClass: 'internal' },
    })
  })

  it('refuses a probe path that points at another host', async () => {
    const { host, page, authRunner } = fixture(
      defineAdapter({
        manifest: {
          ...manifest,
          session: {
            ...manifest.session,
            probe: { kind: 'fetch', path: '//evil.test/api/session', expectStatus: 200 },
          },
        },
        tools: ensureOnce.tools,
      }),
    )
    expect(await host.call(call)).toEqual({
      status: 'ok',
      output: { status: 'failed', stage: 'probe', errorClass: 'host-not-allowed' },
    })
    expect(page.fetches).toEqual([])
    expect(authRunner).not.toHaveBeenCalled()
  })

  it('reports a cookie probe as unsupported and treats the session as logged out', async () => {
    const { host, page, authRunner, diagnostics } = fixture(
      defineAdapter({
        manifest: {
          ...manifest,
          session: { ...manifest.session, probe: { kind: 'cookie', name: 'shopper-id' } },
        },
        tools: ensureOnce.tools,
      }),
    )

    expect(await host.call(call)).toMatchObject({
      output: { status: 'failed', stage: 'probe', errorClass: 'not-logged-in' },
    })
    expect(diagnostics).toHaveBeenCalledWith({
      type: 'unsupported-probe',
      adapterId: 'example-shop',
      kind: 'cookie',
    })
    expect(authRunner).toHaveBeenCalledTimes(1)
    expect(page.fetches).toEqual([])
  })

  it('aborts ensure() at once when the call has been aborted', async () => {
    const { host, page, clock } = fixture(
      defineAdapter({
        manifest,
        tools: {
          run_test: tool({
            input: z.object({}),
            output: z.unknown(),
            run: async (ctx) => {
              await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve))
              return ctx.session.ensure()
            },
          }),
        },
      }),
      { timeoutMs: 1_000 },
    )
    const running = host.call(call)
    await flush()
    await clock.advance(1_000)
    expect(await running).toMatchObject({ stage: 'timeout' })
    expect(page.fetches).toEqual([])
  })

  it('surfaces an aborted probe wait as aborted rather than a probe failure', async () => {
    let seen: unknown
    const { host, clock } = fixture(
      defineAdapter({
        manifest,
        tools: {
          run_test: tool({
            input: z.object({}),
            output: z.unknown(),
            run: async (ctx) => {
              // The fetch takes the rate budget's first slot, so the probe has to wait for the next.
              await ctx.page.fetch('/api/trolley')
              seen = await ctx.session.ensure().catch((error: unknown) => error)
              return seen
            },
          }),
        },
      }),
      {
        timeoutMs: 1_000,
        siteProtection: { minRequestGapMs: 5_000, cooldownMs: 60_000, maxCooldownMs: 600_000 },
      },
    )
    const running = host.call(call)
    await flush()
    await clock.advance(1_000)

    expect(await running).toEqual({ status: 'failed', stage: 'timeout', errorClass: 'timed-out' })
    expect(seen).toMatchObject({ stage: 'tool-run', errorClass: 'aborted' })
  })
})

describe('probe answers', () => {
  const probeOutcome = async (answer: ReturnType<typeof json>, probe = manifest.session.probe) => {
    const { host, page } = fixture(
      defineAdapter({
        manifest: { ...manifest, session: { ...manifest.session, probe } },
        tools: ensureOnce.tools,
      }),
    )
    page.route('GET', SESSION_URL, answer)
    const result = await host.call(call)
    return result.status === 'ok' ? result.output : result
  }

  it('is logged out on an unexpected status', async () => {
    expect(await probeOutcome(json({ shopper: { loggedIn: true } }, 401))).toMatchObject({
      errorClass: 'not-logged-in',
    })
  })

  it('is logged out when the value differs from equals', async () => {
    expect(await probeOutcome(json({ shopper: { loggedIn: 'true' } }))).toMatchObject({
      errorClass: 'not-logged-in',
    })
  })

  it('is logged out when the path is missing', async () => {
    expect(await probeOutcome(json({ shopper: {} }))).toMatchObject({ errorClass: 'not-logged-in' })
    expect(await probeOutcome(json(null))).toMatchObject({ errorClass: 'not-logged-in' })
  })

  it('without equals, needs a truthy value', async () => {
    const probe = { kind: 'fetch' as const, path: '/api/session', expectStatus: 200, jsonPath: 'shopper.id' }
    expect(await probeOutcome(json({ shopper: { id: 'S-1' } }), probe)).toEqual({ status: 'ok' })
    expect(await probeOutcome(json({ shopper: { id: '' } }), probe)).toMatchObject({
      errorClass: 'not-logged-in',
    })
  })

  it('without a jsonPath, only the status counts', async () => {
    const probe = { kind: 'fetch' as const, path: '/api/session', expectStatus: 204 }
    expect(await probeOutcome(json(null, 204), probe)).toEqual({ status: 'ok' })
  })

  it('does not find values through the prototype chain', async () => {
    const probe = {
      kind: 'fetch' as const,
      path: '/api/session',
      expectStatus: 200,
      jsonPath: 'constructor.name',
    }
    expect(await probeOutcome(json({}), probe)).toMatchObject({ errorClass: 'not-logged-in' })
  })

  it('parses a JSON body that arrives as text', async () => {
    expect(
      await probeOutcome({
        status: 200,
        contentType: 'application/json',
        body: '{"shopper":{"loggedIn":true}}',
      }),
    ).toEqual({ status: 'ok' })
    expect(
      await probeOutcome({ status: 200, contentType: 'application/json', body: '{not json' }),
    ).toMatchObject({
      errorClass: 'not-logged-in',
    })
  })

  it('treats HTML where the probe expected JSON as a block', async () => {
    expect(await probeOutcome({ status: 200, contentType: 'text/html', body: '<html>' })).toEqual({
      status: 'blocked',
      retryAfterMs: 60_000,
    })
  })
})
