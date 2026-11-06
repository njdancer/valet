import { describe, expect, it } from 'vitest'
import { runAuthFlow } from '../src/run-auth-flow'
import { ACCOUNT_PAGE, CANARY, HASH, LOGIN, LOGIN_PAGE, manifestWithSteps, world } from './fixtures'

describe('runAuthFlow', () => {
  it('logs in to the example site', async () => {
    const w = world()
    const outcome = await runAuthFlow(w.input)
    expect(outcome).toEqual({ status: 'ok' })
    expect(w.page.currentUrl()).toBe(ACCOUNT_PAGE)
    expect(w.page.typed).toEqual([
      {
        selector: '#email',
        url: LOGIN_PAGE,
        text: CANARY.username,
        secret: true,
        delayMs: 40,
        allowedOrigins: [LOGIN],
      },
      {
        selector: '#password',
        url: LOGIN_PAGE,
        text: CANARY.password,
        secret: true,
        delayMs: 40,
        allowedOrigins: [LOGIN],
      },
    ])
    expect(w.page.clicked).toEqual(['#submit'])
  })

  it('confirms the login from the auth partition, where the site set its session cookie', async () => {
    const w = world()
    expect(w.page.cookies.has('session')).toBe(false)
    expect(await runAuthFlow(w.input)).toEqual({ status: 'ok' })
    expect(w.page.cookies.has('session')).toBe(true)
  })

  it('reports not-logged-in when the site never set a session, wherever the page ended up', async () => {
    const w = world()
    w.page.site[ACCOUNT_PAGE] = { text: ['Welcome back'] }
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'probe',
      errorClass: 'not-logged-in',
    })
    expect(w.page.currentUrl()).toBe(ACCOUNT_PAGE)
  })

  it('disposes every secret it fetched', async () => {
    const w = world()
    await runAuthFlow(w.input)
    expect(w.provider.issued).toHaveLength(2)
    expect(w.provider.issued.every((secret) => secret.disposed)).toBe(true)
  })

  it('audits the start, each secret use, and the finish, in order', async () => {
    const w = world()
    await runAuthFlow(w.input)
    expect(w.audit.events).toEqual([
      { type: 'login-started', adapterId: 'shop', callId: 'call-1' },
      {
        type: 'secret-used',
        adapterId: 'shop',
        adapterHash: HASH,
        secret: 'login',
        field: 'username',
        origin: LOGIN,
        callId: 'call-1',
      },
      {
        type: 'secret-used',
        adapterId: 'shop',
        adapterHash: HASH,
        secret: 'login',
        field: 'password',
        origin: LOGIN,
        callId: 'call-1',
      },
      { type: 'login-finished', adapterId: 'shop', outcome: 'ok' },
    ])
  })

  it('records a null callId when the person started the login', async () => {
    const w = world()
    w.input.callId = null
    await runAuthFlow(w.input)
    expect(w.audit.events[0]).toEqual({ type: 'login-started', adapterId: 'shop', callId: null })
    expect(w.audit.events[1]).toMatchObject({ type: 'secret-used', callId: null })
  })

  it('audits a failure with its stage and class', async () => {
    const w = world()
    w.input.manifest = manifestWithSteps([{ op: 'fail', errorClass: 'auth-failed' }])
    const outcome = await runAuthFlow(w.input)
    expect(outcome).toEqual({ status: 'failed', stage: 'auth-step', errorClass: 'auth-failed' })
    expect(w.audit.events.at(-1)).toEqual({
      type: 'login-finished',
      adapterId: 'shop',
      outcome: 'failed',
      stage: 'auth-step',
      errorClass: 'auth-failed',
    })
  })

  it('audits needsUser with its reason code', async () => {
    const w = world()
    w.input.manifest = manifestWithSteps([{ op: 'needsUser', reason: 'captcha' }])
    expect(await runAuthFlow(w.input)).toEqual({ status: 'needsUser', reason: 'captcha' })
    expect(w.audit.events.at(-1)).toEqual({
      type: 'login-finished',
      adapterId: 'shop',
      outcome: 'needsUser',
      needsUser: 'captcha',
    })
  })

  it('audits a block as blocked, with its stage and class', async () => {
    const w = world()
    w.page.site[LOGIN_PAGE] = { blocked: true }
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'blocked',
      stage: 'auth-step',
      errorClass: 'blocked-by-site',
    })
    expect(w.audit.events.at(-1)).toEqual({
      type: 'login-finished',
      adapterId: 'shop',
      outcome: 'blocked',
      stage: 'auth-step',
      errorClass: 'blocked-by-site',
    })
  })

  it('does not start a login it cannot audit', async () => {
    const w = world()
    w.audit.failOn = 'login-started'
    const outcome = await runAuthFlow(w.input)
    expect(outcome).toEqual({ status: 'failed', stage: 'auth-step', errorClass: 'internal' })
    expect(w.page.visited).toEqual([])
    expect(w.provider.calls).toEqual([])
  })

  it('does not report ok when the finish cannot be audited', async () => {
    const w = world()
    w.audit.failOn = 'login-finished'
    const outcome = await runAuthFlow(w.input)
    expect(outcome).toEqual({ status: 'failed', stage: 'auth-step', errorClass: 'internal' })
  })

  it('does not hand the window to the person itself; the caller does that on needsUser', async () => {
    const w = world()
    w.input.manifest = manifestWithSteps([{ op: 'needsUser', reason: 'captcha' }])
    await runAuthFlow(w.input)
    expect(w.page.handedToUser).toEqual([])
  })
})
