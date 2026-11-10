// D50: a call that has to log in first answers its caller within seconds and leaves the login
// running. What the caller is told, what tool code may still do (nothing), and what the next call
// finds.

import { defineAdapter, tool } from '@valet/core'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { DEFAULT_LOGIN_ANSWER_MS, DEFAULT_LOGIN_TIMEOUT_MS, LOGIN_RETRY_MS } from '../src/tool-host'
import type { AuthOutcome, AuthRunRequest } from '../src/types'
import { flush } from './fakes'
import { call, fixture, loggedIn, loggedOut, manifest, SESSION_URL } from './fixtures'

/** A fixture whose session is logged out and whose login runs until the test ends it. */
function setup() {
  const afterEnsure: string[] = []
  const definition = defineAdapter({
    manifest,
    tools: {
      run_test: tool({
        input: z.object({}),
        output: z.string(),
        run: async (ctx) => {
          const session = await ctx.session.ensure()
          afterEnsure.push(session.status)
          if (session.status !== 'ok') throw new Error('no session')
          await ctx.page.fetch('/api/trolley')
          return 'done'
        },
      }),
    },
  })
  const f = fixture(definition)
  let loggedInNow = false
  f.page.route('GET', SESSION_URL, () => (loggedInNow ? loggedIn : loggedOut))
  const logins: AuthRunRequest[] = []
  let end: (outcome: AuthOutcome) => void = () => {}
  f.authRunner.mockImplementation(
    (request) =>
      new Promise<AuthOutcome>((resolve) => {
        logins.push(request)
        end = (outcome) => {
          if (outcome.status === 'ok') loggedInNow = true
          resolve(outcome)
        }
      }),
  )
  const trolleys = () => f.page.fetches.filter((x) => x.url.endsWith('/api/trolley')).length
  return { ...f, afterEnsure, logins, finishLogin: (outcome: AuthOutcome) => end(outcome), trolleys }
}

const EARLY = { status: 'logging-in', retryAfterMs: LOGIN_RETRY_MS }

describe('a call that has to log in first', () => {
  it('answers after a few seconds that a login is running, and tool code does nothing more', async () => {
    const { host, clock, audit, afterEnsure, logins, finishLogin, trolleys } = setup()
    const pending = host.call(call)
    await flush()
    expect(logins).toHaveLength(1)
    await clock.advance(DEFAULT_LOGIN_ANSWER_MS - 1)
    await clock.advance(1)

    expect(await pending).toEqual(EARLY)
    expect(audit.events.at(-1)).toMatchObject({
      type: 'tool-finished',
      callId: 'call-1',
      outcome: 'failed',
      stage: 'login',
      errorClass: 'login-in-progress',
    })
    // The login was not stopped with the call.
    expect(logins[0]?.signal.aborted).toBe(false)

    finishLogin({ status: 'ok' })
    await flush()
    // ensure() gave tool code nothing back, and the tool's own request was never made.
    expect(afterEnsure).toEqual([])
    expect(trolleys()).toBe(0)
  })

  it('holds the adapter’s turn until the login ends, and the next call finds the session logged in', async () => {
    const { host, clock, authRunner, driver, finishLogin, trolleys } = setup()
    const first = host.call(call)
    await flush()
    await clock.advance(DEFAULT_LOGIN_ANSWER_MS)
    expect(await first).toEqual(EARLY)

    const second = host.call({ ...call, callId: 'call-2' })
    await flush()
    // Still waiting its turn behind the login.
    expect(trolleys()).toBe(0)
    finishLogin({ status: 'ok' })

    expect(await second).toEqual({ status: 'ok', output: 'done' })
    expect(driver.handoffs).toHaveLength(1)
    expect(authRunner).toHaveBeenCalledTimes(1)
  })

  it('still finishes a quick login inside the call', async () => {
    const { host, clock, finishLogin } = setup()
    const pending = host.call(call)
    await flush()
    await clock.advance(DEFAULT_LOGIN_ANSWER_MS - 1)
    finishLogin({ status: 'ok' })
    expect(await pending).toEqual({ status: 'ok', output: 'done' })
  })

  it('tells the next call when the login it left running needed the person', async () => {
    const { host, clock, authRunner, finishLogin } = setup()
    const first = host.call(call)
    await flush()
    await clock.advance(DEFAULT_LOGIN_ANSWER_MS)
    expect(await first).toEqual(EARLY)
    finishLogin({ status: 'needsUser', reason: 'captcha' })

    expect(await host.call({ ...call, callId: 'call-2' })).toEqual({ status: 'needsUser', reason: 'captcha' })
    // Held for the person: no second login.
    expect(authRunner).toHaveBeenCalledTimes(1)
  })

  it('gives the next call the failure of the login it left running, once, then the hold it left', async () => {
    const { host, clock, authRunner, finishLogin } = setup()
    const first = host.call(call)
    await flush()
    await clock.advance(DEFAULT_LOGIN_ANSWER_MS)
    expect(await first).toEqual(EARLY)
    finishLogin({ status: 'failed', stage: 'secret-fill', errorClass: 'not-granted' })

    expect(await host.call({ ...call, callId: 'call-2' })).toEqual({
      status: 'failed',
      stage: 'secret-fill',
      errorClass: 'not-granted',
    })
    expect(await host.call({ ...call, callId: 'call-3' })).toEqual({
      status: 'needsUser',
      reason: 'login-required',
    })
    expect(authRunner).toHaveBeenCalledTimes(1)
  })

  it('does not stop the login when the caller goes away after its answer', async () => {
    const { host, clock, logins, finishLogin } = setup()
    const caller = new AbortController()
    const pending = host.call({ ...call, signal: caller.signal })
    await flush()
    await clock.advance(DEFAULT_LOGIN_ANSWER_MS)
    expect(await pending).toEqual(EARLY)
    caller.abort()
    await flush()
    expect(logins[0]?.signal.aborted).toBe(false)
    finishLogin({ status: 'ok' })
  })

  it('stops the login when the caller goes away before any answer', async () => {
    const { host, clock, logins, finishLogin } = setup()
    const caller = new AbortController()
    const pending = host.call({ ...call, signal: caller.signal })
    await flush()
    await clock.advance(1_000)
    caller.abort()
    expect(await pending).toEqual({ status: 'failed', stage: 'tool-run', errorClass: 'aborted' })
    expect(logins[0]?.signal.aborted).toBe(true)
    finishLogin({ status: 'failed', stage: 'login', errorClass: 'aborted', attemptStarted: false })
  })

  it('stops a login that is still running five minutes after its call was answered', async () => {
    const { host, clock, logins, finishLogin } = setup()
    const pending = host.call(call)
    await flush()
    await clock.advance(DEFAULT_LOGIN_ANSWER_MS)
    expect(await pending).toEqual(EARLY)
    await flush()
    await clock.advance(DEFAULT_LOGIN_TIMEOUT_MS - 1)
    expect(logins[0]?.signal.aborted).toBe(false)
    await clock.advance(1)
    expect(logins[0]?.signal.aborted).toBe(true)
    finishLogin({ status: 'failed', stage: 'login', errorClass: 'aborted', attemptStarted: false })
  })
})
