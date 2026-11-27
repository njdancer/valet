// @vitest-environment node
// Login sessions: an agent's sign-in steps on an adapter's own login page, with a login's checks,
// a page it may read only cleaned, and acting only on the login origins.

import { type AuditEvent, parseManifest, ValetError } from '@valet/core'
import type { LoginStepContext } from '@valet/runtime'
import { describe, expect, it } from 'vitest'
import { LoginSecrets } from '../../src/main/core/blocked'
import { disabledOtpReader } from '../../src/main/core/credentials'
import { DEMO_ACCOUNT } from '../../src/main/core/demo'
import {
  LOGIN_BATCH_MS,
  LOGIN_SESSION_MS,
  LoginSession,
  loginOrigins,
  runLoginTrial,
} from '../../src/main/core/login-session'
import { FakeAuthPage, SHOP } from './fixtures'
import { testCredentials } from './test-credentials'

const HASH = 'e'.repeat(64)
const NOW = Date.parse('2026-11-27T10:00:00.000Z')
const LOGIN = 'https://login.shop.test'

const FIELD = {
  visible: true,
  tagName: 'INPUT',
  inputType: 'email',
  autocomplete: 'username',
  inputMode: null,
  frameOrigin: LOGIN,
  formActionOrigin: LOGIN,
  inputReachable: true,
} as const

function setup(options: { refuse?: Error } = {}) {
  const manifest = parseManifest(SHOP)
  const page = new FakeAuthPage()
  const events: AuditEvent[] = []
  const secrets = new LoginSecrets()
  const steps: string[] = []
  const blocked: string[] = []
  const timers: { run: () => void; ms: number; cleared: boolean }[] = []
  const grant = {
    adapterId: 'shop',
    adapterHash: HASH,
    secret: 'login',
    provider: 'fake' as const,
    itemRef: 'demo-woolworths',
    origins: [LOGIN],
    grantedAt: new Date(NOW).toISOString(),
  }
  const session = new LoginSession({
    adapterId: 'shop',
    manifest,
    adapterHash: HASH,
    page,
    grants: {
      find: async () => grant,
      list: async () => [grant],
      put: async () => {},
      revoke: async () => {},
    },
    credentials: testCredentials(disabledOtpReader),
    audit: { append: async (event: AuditEvent) => void events.push(event) } as never,
    clock: () => new Date(NOW),
    sleep: async () => {},
    typingDelayMs: 0,
    secrets: secrets.begin('shop'),
    holdsSecret: (text) => secrets.occursIn('shop', text),
    loginStep: async <T>(step: (ctx: LoginStepContext) => Promise<T>): Promise<T> => {
      steps.push('step')
      if (options.refuse !== undefined) throw options.refuse
      return step({
        signal: new AbortController().signal,
        pace: async () => {},
        reportBlocked: (cause) => void blocked.push(cause),
      })
    },
    timers: {
      setTimeout: (run, ms) => {
        const t = { run, ms, cleared: false }
        timers.push(t)
        return t
      },
      clearTimeout: (t) => {
        ;(t as { cleared: boolean }).cleared = true
      },
    },
  })
  return { session, page, events, secrets, steps, blocked, timers }
}

describe('a login session', () => {
  it('acts only on the origins its manifest’s secrets may be typed on', () => {
    expect(loginOrigins(parseManifest(SHOP))).toEqual([LOGIN])
  })

  it('runs steps as login steps, types the login by secret-fill, and shows the page cleaned', async () => {
    const { session, page, events, secrets, steps } = setup()
    page.element = FIELD
    page.view = {
      url: `${LOGIN}/u/login?state=xyz`,
      title: 'Log in',
      snapshot: `- textbox "Email" [ref=e2]: ${DEMO_ACCOUNT.username}\n- text: Signed in as ${DEMO_ACCOUNT.username}\n- button "Continue" [ref=e3]`,
    }
    const ran = await session.loginSteps([
      { op: 'goto', url: `${LOGIN}/login` },
      { op: 'fill', selector: '#user', value: { secret: 'login', field: 'username' } },
    ])
    expect(ran.outcome).toEqual({ status: 'ok', reason: null, stage: null, errorClass: null })
    // The fake page keeps only that a secret was typed, never its value.
    expect(page.typed).toEqual([{ text: '[secret]', secret: true }])
    expect(events.filter((e) => e.type === 'secret-used')).toHaveLength(1)
    expect(steps).toEqual(['step'])
    expect(ran.page).toEqual({
      url: `${LOGIN}/u/login`,
      title: 'Log in',
      yaml: '- textbox "Email" [ref=e2]\n- [redacted: held a login secret]\n- button "Continue" [ref=e3]',
      previous: null,
      cut: false,
    })
    expect(JSON.stringify(ran)).not.toContain(DEMO_ACCOUNT.username)
    expect(secrets.occursIn('shop', DEMO_ACCOUNT.username)).toBe(true)
  })

  it('types the password once for its whole life', async () => {
    const { session, page } = setup()
    page.element = { ...FIELD, inputType: 'password', autocomplete: 'current-password' }
    page.view = { url: `${LOGIN}/login`, title: '', snapshot: '' }
    const pass = { op: 'fill', selector: '#pass', value: { secret: 'login', field: 'password' } } as const
    await session.loginSteps([{ op: 'goto', url: `${LOGIN}/login` }, pass])
    const again = await session.loginSteps([pass])
    expect(again.outcome).toMatchObject({ status: 'needsUser', reason: 'login-required' })
    expect(page.typed.filter((t) => t.secret)).toHaveLength(1)
  })

  it('looks but doesn’t act off the login origins', async () => {
    const { session, page } = setup()
    page.element = FIELD
    page.view = { url: 'https://www.shop.test/checkout', title: 'Checkout', snapshot: '- button "Pay"' }
    await session.go('https://www.shop.test/checkout')
    const ran = await session.loginSteps([{ op: 'click', selector: '#pay' }])
    expect(ran.outcome).toMatchObject({ status: 'failed', errorClass: 'navigation-escaped' })
    const typed = await session.loginSteps([{ op: 'fill', selector: '#q', value: { literal: 'x' } }])
    expect(typed.outcome).toMatchObject({ status: 'failed' })
    expect(page.typed).toEqual([])
  })

  it('refuses selectors that could read back a typed value, however deep', async () => {
    const { session, page } = setup()
    page.view = { url: `${LOGIN}/`, title: '', snapshot: '' }
    for (const steps of [
      [{ op: 'click', selector: 'input[value^="a"]' }],
      [{ op: 'waitFor', condition: { visible: 'form:has(input[value="x"])' }, timeoutMs: 100 }],
      [
        {
          op: 'retry',
          times: 1,
          steps: [{ op: 'when', condition: { not: { visible: '#a[VALUE*="b"]' } }, steps: [] }],
        },
      ],
    ] as const)
      await expect(session.loginSteps(steps as never)).rejects.toMatchObject({
        detail: expect.stringMatching(/value/),
      })
    expect((await session.loginSteps([{ op: 'pause', ms: 1 }])).outcome.status).toBe('ok')
  })

  it('refuses everything else a session does, and a part of the page', async () => {
    const { session, page } = setup()
    page.view = { url: `${LOGIN}/`, title: '', snapshot: '' }
    for (const refused of [
      session.evaluate(),
      session.cookies(),
      session.storage(),
      session.clickElement(),
      session.fill(),
      session.press(),
      session.screenshot(),
      session.body(),
      session.ariaSnapshot({ target: 'e1' }),
    ])
      await expect(refused).rejects.toMatchObject({ detail: expect.stringMatching(/login session/) })
    expect(() => session.entries()).toThrow()
    expect(() => session.consoleMessages()).toThrow()
    expect(session.takeDownloads()).toEqual([])
  })

  it('says why steps didn’t start, opens the breaker on a block, and refuses a page off the site', async () => {
    const cooling = setup({ refuse: new ValetError('login', 'rate-limited') })
    await expect(cooling.session.go(`${LOGIN}/`)).rejects.toMatchObject({
      detail: expect.stringMatching(/cooling/),
    })
    const { session, page, blocked } = setup()
    await expect(session.go('https://evil.test/')).rejects.toMatchObject({
      detail: expect.stringMatching(/navigation-escaped/),
    })
    page.view = { url: `${LOGIN}/`, title: '', snapshot: '' }
    const ran = await session.loginSteps([{ op: 'fail', errorClass: 'blocked-by-site' }])
    expect(ran.outcome.status).toBe('blocked')
    expect(blocked).toEqual(['blocked-by-site'])
  })

  it('closes after 30 minutes, once, closing its page and telling its listeners', async () => {
    const { session, page, timers } = setup()
    const closed: string[] = []
    session.onClosed(() => closed.push('closed'))
    expect(timers[0]?.ms).toBe(LOGIN_SESSION_MS)
    timers[0]?.run()
    session.close()
    expect(closed).toEqual(['closed'])
    expect(page.closed).toBe(true)
    expect(session.isClosed()).toBe(true)
    await expect(session.loginSteps([{ op: 'pause', ms: 1 }])).rejects.toMatchObject({
      detail: expect.stringMatching(/closed/),
    })
  })
})

describe('a batch’s time', () => {
  it('ends well inside the 60 s an MCP client usually gives a tool call', () => {
    // The agent has to hear how a batch ended, a wait for a one-time code included (issue #30).
    expect(LOGIN_BATCH_MS).toBeLessThanOrEqual(45_000)
  })
})

describe('a draft’s login trial', () => {
  type Outcome = {
    status: 'ok' | 'needsUser' | 'failed' | 'blocked'
    reason: string | null
    stage: string | null
    errorClass: string | null
  }
  const OK: Outcome = { status: 'ok', reason: null, stage: null, errorClass: null }
  const SIGNED_OUT: Outcome = { status: 'failed', reason: null, stage: 'probe', errorClass: 'not-logged-in' }
  function scripted(outcomes: Outcome[]) {
    const batches: unknown[] = []
    return {
      batches,
      session: {
        runSteps: async (steps: readonly unknown[]) => {
          batches.push(steps)
          const outcome = outcomes.shift()
          if (outcome === undefined) throw new Error('no more batches')
          return outcome
        },
      } as unknown as Pick<LoginSession, 'runSteps'>,
    }
  }
  const STEPS = [{ op: 'goto', url: `${LOGIN}/login` }, { op: 'assertLoggedIn' }] as const

  it('checks for signed out, runs the steps, then checks for signed in', async () => {
    const s = scripted([SIGNED_OUT, OK, OK])
    expect(await runLoginTrial(s.session, STEPS, 180_000)).toEqual({ kind: 'signed-in' })
    expect(s.batches).toEqual([[{ op: 'assertLoggedIn' }], STEPS, [{ op: 'assertLoggedIn' }]])
  })

  it('runs no step when the session is signed in already, and says where it stopped otherwise', async () => {
    const signedIn = scripted([OK])
    expect(await runLoginTrial(signedIn.session, STEPS, 180_000)).toEqual({ kind: 'signed-in-before' })
    expect(signedIn.batches).toHaveLength(1)
    const blocked: Outcome = {
      status: 'blocked',
      reason: null,
      stage: 'login',
      errorClass: 'blocked-by-site',
    }
    expect(await runLoginTrial(scripted([blocked]).session, STEPS, 180_000)).toMatchObject({
      kind: 'stopped',
      at: 'before',
      status: 'blocked',
    })
    const user: Outcome = { status: 'needsUser', reason: 'captcha', stage: null, errorClass: null }
    expect(await runLoginTrial(scripted([SIGNED_OUT, user]).session, STEPS)).toMatchObject({
      kind: 'stopped',
      at: 'steps',
      status: 'needsUser',
      reason: 'captcha',
    })
    expect(await runLoginTrial(scripted([SIGNED_OUT, OK, SIGNED_OUT]).session, STEPS)).toMatchObject({
      kind: 'stopped',
      at: 'after',
      errorClass: 'not-logged-in',
    })
  })
})
