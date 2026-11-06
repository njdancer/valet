// Walks the manifest's auth steps against scripted Auth0 pages, to check where each kind of login
// ends up. The walker models only what these steps use; the real interpreter lives in
// @siteadapter/auth-flow, and its own tests cover the step semantics. test/e2e.test.ts runs the
// same steps against the fake site over HTTP.

import { type AuthStep, type Condition, messagesSourcesIn } from '@siteadapter/core'
import { describe, expect, it } from 'vitest'
import realManifest, {
  createManifest,
  MESSAGES_SENDER,
  NOTES,
  SELECTORS,
  SETTLE_PAUSES_MS,
  settle,
} from '../src/manifest'
import { FAKE_ORIGIN } from './fake-context'

interface PageState {
  /** Path and query: all a condition can see of a URL. */
  readonly path: string
  readonly visible: readonly string[]
}

/** A page change that happens `delayMs` of pausing after the action. */
interface Change {
  readonly delayMs: number
  readonly page: PageState
}

interface Script {
  readonly goto: Change
  /** What a click on the primary button leads to, by the page it was clicked on. */
  readonly submit?: { readonly identifier?: Change; readonly password?: Change; readonly challenge?: Change }
}

interface Walk {
  readonly outcome: 'logged-in' | 'needs-user' | 'ran-out'
  readonly reason?: string
  readonly note?: string
  /** "fill:username", "submit", "remember", "otp:messages" and so on, in order. */
  readonly actions: string[]
  readonly pausedMs: number
}

const IDENTIFIER: PageState = {
  path: '/u/login/identifier?state=T',
  visible: [SELECTORS.username, SELECTORS.submit],
}
const PASSWORD: PageState = {
  path: '/u/login/password?state=T',
  visible: [SELECTORS.password, SELECTORS.submit],
}
const SMS: PageState = {
  path: '/u/mfa-sms-challenge?state=T',
  visible: [SELECTORS.code, SELECTORS.rememberDevice, SELECTORS.submit],
}
const TOTP: PageState = { ...SMS, path: '/u/mfa-otp-challenge?state=T' }
const EMAIL: PageState = { ...SMS, path: '/u/mfa-email-challenge?state=T' }
/** Back on www after the callback. */
const HOME: PageState = { path: '/', visible: [] }
/** An Auth0 page off every login path, such as a tenant error page: only its container shows. */
const AUTH0_ERROR: PageState = { path: '/error?code=tenant', visible: [SELECTORS.auth0Widget] }
const BLANK: PageState = { path: '/auth/login?redirect_uri=x&path=/', visible: [] }

function withVisible(page: PageState, ...selectors: string[]): PageState {
  return { ...page, visible: [...page.visible, ...selectors] }
}

class NeedsUser {
  constructor(
    readonly reason: string,
    readonly note: string | undefined,
  ) {}
}

class LoggedIn {}

function holds(condition: Condition, page: PageState): boolean {
  if ('visible' in condition) return page.visible.includes(condition.visible)
  if ('urlContains' in condition) return page.path.includes(condition.urlContains)
  if ('urlRegex' in condition) return new RegExp(condition.urlRegex).test(page.path)
  if ('not' in condition) return !holds(condition.not, page)
  if ('any' in condition) return condition.any.some((inner) => holds(inner, page))
  if ('all' in condition) return condition.all.every((inner) => holds(inner, page))
  throw new Error(`the walker does not model ${JSON.stringify(condition)}`)
}

function kindOf(page: PageState): 'identifier' | 'password' | 'challenge' | null {
  if (page.path.startsWith('/u/login/identifier')) return 'identifier'
  if (page.path.startsWith('/u/login/password')) return 'password'
  if (page.path.startsWith('/u/mfa-')) return 'challenge'
  return null
}

function walk(steps: readonly AuthStep[], script: Script): Walk {
  let page = BLANK
  let pending: { remaining: number; page: PageState } | null = null
  let pausedMs = 0
  const actions: string[] = []

  const schedule = (change: Change | undefined): void => {
    if (change === undefined) return
    if (change.delayMs === 0) page = change.page
    else pending = { remaining: change.delayMs, page: change.page }
  }
  const requireVisible = (selector: string): void => {
    if (!page.visible.includes(selector)) throw new Error(`acted on hidden ${selector} at ${page.path}`)
  }

  const run = (list: readonly AuthStep[]): void => {
    for (const step of list) {
      switch (step.op) {
        case 'goto':
          actions.push('goto')
          schedule(script.goto)
          break
        case 'fill':
          requireVisible(step.selector)
          actions.push('secret' in step.value ? `fill:${step.value.field}` : 'fill:literal')
          break
        case 'click': {
          requireVisible(step.selector)
          if (step.selector === SELECTORS.rememberDevice) {
            actions.push('remember')
            page = { ...page, visible: page.visible.filter((s) => s !== SELECTORS.rememberDevice) }
            break
          }
          if (step.selector !== SELECTORS.submit) throw new Error(`unexpected click ${step.selector}`)
          actions.push('submit')
          const kind = kindOf(page)
          schedule(kind === null ? undefined : script.submit?.[kind])
          break
        }
        case 'otp':
          requireVisible(step.selector)
          actions.push('secret' in step.source ? 'otp:secret' : 'otp:messages')
          break
        case 'pause':
          pausedMs += step.ms
          if (pending !== null) {
            pending.remaining -= step.ms
            if (pending.remaining <= 0) {
              page = pending.page
              pending = null
            }
          }
          break
        case 'when':
          run(holds(step.condition, page) ? step.steps : (step.otherwise ?? []))
          break
        case 'needsUser':
          throw new NeedsUser(step.reason, step.note)
        case 'assertLoggedIn':
          throw new LoggedIn()
        default:
          throw new Error(`the walker does not model ${step.op}`)
      }
    }
  }

  try {
    run(steps)
  } catch (end) {
    if (end instanceof NeedsUser) {
      return { outcome: 'needs-user', reason: end.reason, note: end.note, actions, pausedMs }
    }
    if (end instanceof LoggedIn) return { outcome: 'logged-in', actions, pausedMs }
    throw end
  }
  return { outcome: 'ran-out', actions, pausedMs }
}

const steps = realManifest.auth.steps
const totpSteps = createManifest({ totp: true }).auth.steps
const SETTLE_TOTAL_MS = SETTLE_PAUSES_MS.reduce((sum, ms) => sum + ms, 0)

/** The usual way in: identifier, then password. */
const FULL: Script = {
  goto: { delayMs: 0, page: IDENTIFIER },
  submit: { identifier: { delayMs: 0, page: PASSWORD }, password: { delayMs: 0, page: HOME } },
}

describe('settle', () => {
  it('builds nothing for no pauses', () => {
    expect(settle({ visible: '#x' }, [])).toEqual([])
  })

  it('nests one look per pause, each only when the condition still does not hold', () => {
    expect(settle({ visible: '#x' }, [1000, 2000])).toEqual([
      {
        op: 'when',
        condition: { not: { visible: '#x' } },
        steps: [
          { op: 'pause', ms: 1000 },
          { op: 'when', condition: { not: { visible: '#x' } }, steps: [{ op: 'pause', ms: 2000 }] },
        ],
      },
    ])
  })

  it('waits 10 s at most for any one page change', () => {
    expect(SETTLE_TOTAL_MS).toBe(10_000)
  })
})

describe('the login, walked against scripted Auth0 pages', () => {
  it('fills the email, then the password, each on its own page, and asserts the login', () => {
    const result = walk(steps, FULL)
    expect(result.outcome).toBe('logged-in')
    expect(result.actions).toEqual(['goto', 'fill:username', 'submit', 'fill:password', 'submit'])
    expect(result.pausedMs).toBe(0)
  })

  it('stops each wait as soon as the next page is there', () => {
    const result = walk(steps, {
      goto: { delayMs: 2500, page: IDENTIFIER },
      submit: { identifier: { delayMs: 800, page: PASSWORD }, password: { delayMs: 2500, page: HOME } },
    })
    expect(result.outcome).toBe('logged-in')
    expect(result.pausedMs).toBe(3000 + 1500 + 3000)
    expect(SETTLE_PAUSES_MS.slice(0, 3)).toEqual([500, 1000, 1500])
  })

  it('logs in silently, typing nothing, when Auth0’s session sends the browser straight back', () => {
    const result = walk(steps, { goto: { delayMs: 0, page: HOME } })
    expect(result).toEqual({ outcome: 'logged-in', actions: ['goto'], pausedMs: 0 })
  })

  it('fills only the password when Auth0 skips the identifier page', () => {
    const result = walk(steps, {
      goto: { delayMs: 0, page: PASSWORD },
      submit: { password: { delayMs: 0, page: HOME } },
    })
    expect(result.outcome).toBe('logged-in')
    expect(result.actions).toEqual(['goto', 'fill:password', 'submit'])
  })

  it('fills an SMS code from Messages, ticks remember-device, and submits', () => {
    const result = walk(steps, {
      ...FULL,
      submit: {
        ...FULL.submit,
        password: { delayMs: 0, page: SMS },
        challenge: { delayMs: 1500, page: HOME },
      },
    })
    expect(result.outcome).toBe('logged-in')
    expect(result.actions).toEqual([
      'goto',
      'fill:username',
      'submit',
      'fill:password',
      'submit',
      'otp:messages',
      'remember',
      'submit',
    ])
  })

  it('does not untick remember-device when it is already ticked', () => {
    const ticked: PageState = { ...SMS, visible: [SELECTORS.code, SELECTORS.submit] }
    const result = walk(steps, {
      ...FULL,
      submit: {
        ...FULL.submit,
        password: { delayMs: 0, page: ticked },
        challenge: { delayMs: 0, page: HOME },
      },
    })
    expect(result.outcome).toBe('logged-in')
    expect(result.actions).not.toContain('remember')
  })

  it('fills an authenticator code from 1Password only when the manifest is set up for one', () => {
    const script: Script = {
      ...FULL,
      submit: { ...FULL.submit, password: { delayMs: 0, page: TOTP }, challenge: { delayMs: 0, page: HOME } },
    }
    const withTotp = walk(totpSteps, script)
    expect(withTotp.outcome).toBe('logged-in')
    expect(withTotp.actions).toContain('otp:secret')
    expect(withTotp.actions).not.toContain('otp:messages')

    const without = walk(steps, script)
    expect(without).toMatchObject({
      outcome: 'needs-user',
      reason: 'otp-required',
      note: NOTES.authenticatorCode,
    })
    expect(without.actions.some((action) => action.startsWith('otp'))).toBe(false)
  })

  it('hands an email code to the person', () => {
    const result = walk(totpSteps, {
      ...FULL,
      submit: { ...FULL.submit, password: { delayMs: 0, page: EMAIL } },
    })
    expect(result).toMatchObject({ outcome: 'needs-user', reason: 'otp-required', note: NOTES.emailCode })
    expect(result.actions.some((action) => action.startsWith('otp'))).toBe(false)
  })

  it('hands a code the site refused to the person, typing it once', () => {
    const refused = withVisible(SMS, SELECTORS.fieldError)
    const result = walk(steps, {
      ...FULL,
      submit: {
        ...FULL.submit,
        password: { delayMs: 0, page: SMS },
        challenge: { delayMs: 500, page: refused },
      },
    })
    expect(result).toMatchObject({ outcome: 'needs-user', reason: 'otp-required', note: NOTES.codeRefused })
    expect(result.actions.filter((action) => action.startsWith('otp'))).toEqual(['otp:messages'])
    expect(result.pausedMs).toBe(500)
  })

  it('hands a CAPTCHA shown before the form to the person, before typing any secret', () => {
    const result = walk(steps, { goto: { delayMs: 0, page: withVisible(IDENTIFIER, SELECTORS.captcha) } })
    expect(result).toEqual({
      outcome: 'needs-user',
      reason: 'captcha',
      note: NOTES.captcha,
      actions: ['goto'],
      pausedMs: 0,
    })
  })

  it('hands a CAPTCHA on the password page to the person, before typing the password', () => {
    const result = walk(steps, {
      ...FULL,
      submit: { identifier: { delayMs: 0, page: withVisible(PASSWORD, SELECTORS.captcha) } },
    })
    expect(result).toMatchObject({ outcome: 'needs-user', reason: 'captcha' })
    expect(result.actions).toEqual(['goto', 'fill:username', 'submit'])
  })

  it('hands a CAPTCHA after the password to the person', () => {
    const result = walk(steps, {
      ...FULL,
      submit: { ...FULL.submit, password: { delayMs: 0, page: withVisible(PASSWORD, SELECTORS.captcha) } },
    })
    expect(result).toMatchObject({ outcome: 'needs-user', reason: 'captcha' })
    expect(result.actions.filter((action) => action === 'fill:password')).toHaveLength(1)
  })

  it('hands a refused password to the person, having typed it once', () => {
    const result = walk(steps, {
      ...FULL,
      submit: {
        ...FULL.submit,
        password: { delayMs: 900, page: withVisible(PASSWORD, SELECTORS.fieldError) },
      },
    })
    expect(result).toMatchObject({
      outcome: 'needs-user',
      reason: 'login-required',
      note: NOTES.passwordRefused,
    })
    expect(result.actions).toEqual(['goto', 'fill:username', 'submit', 'fill:password', 'submit'])
    expect(result.pausedMs).toBe(1500)
  })

  it('reports a blocked account as account-locked', () => {
    const blocked = withVisible(PASSWORD, SELECTORS.fieldError, SELECTORS.accountBlocked)
    const result = walk(steps, {
      ...FULL,
      submit: { ...FULL.submit, password: { delayMs: 0, page: blocked } },
    })
    expect(result).toMatchObject({
      outcome: 'needs-user',
      reason: 'account-locked',
      note: NOTES.accountBlocked,
    })
  })

  it('hands an email address Auth0 would not move past to the person, before any password', () => {
    const result = walk(steps, {
      ...FULL,
      submit: { identifier: { delayMs: 0, page: withVisible(IDENTIFIER, SELECTORS.fieldError) } },
    })
    expect(result).toMatchObject({
      outcome: 'needs-user',
      reason: 'login-required',
      note: NOTES.emailRefused,
    })
    expect(result.actions).not.toContain('fill:password')
  })

  it('hands Auth0’s new-terms and consent pages to the person as terms-update', () => {
    for (const path of ['/u/terms?state=T', '/u/consent?state=T', '/u/terms/accept']) {
      const page: PageState = { path, visible: [SELECTORS.auth0Widget] }
      const result = walk(steps, { ...FULL, submit: { ...FULL.submit, password: { delayMs: 0, page } } })
      expect(result).toMatchObject({ outcome: 'needs-user', reason: 'terms-update', note: NOTES.terms })
      expect(result.pausedMs).toBe(SETTLE_TOTAL_MS)
    }
  })

  it('does not take a lookalike of the terms path for terms', () => {
    const page: PageState = { path: '/u/termsandmore?state=T', visible: [SELECTORS.auth0Widget] }
    const result = walk(steps, { ...FULL, submit: { ...FULL.submit, password: { delayMs: 0, page } } })
    expect(result).toMatchObject({ outcome: 'needs-user', reason: 'site-changed', note: NOTES.unknownPage })
  })

  it('hands an Auth0 page nobody scripted (phone enrolment, say) to the person as site-changed', () => {
    const enrol: PageState = { path: '/u/mfa-sms-enrollment?state=T', visible: [SELECTORS.auth0Widget] }
    const result = walk(steps, { ...FULL, submit: { ...FULL.submit, password: { delayMs: 0, page: enrol } } })
    expect(result).toMatchObject({ outcome: 'needs-user', reason: 'site-changed', note: NOTES.unknownPage })
    expect(result.pausedMs).toBe(SETTLE_TOTAL_MS)
  })

  it('hands an Auth0 page off every login path (a tenant error) to the person, not to the probe', () => {
    const result = walk(steps, {
      ...FULL,
      submit: { ...FULL.submit, password: { delayMs: 0, page: AUTH0_ERROR } },
    })
    expect(result).toMatchObject({ outcome: 'needs-user', reason: 'site-changed', note: NOTES.unknownPage })
    expect(result.actions).toEqual(['goto', 'fill:username', 'submit', 'fill:password', 'submit'])
    // Straight there: off the login paths, so no settle waits on it.
    expect(result.pausedMs).toBe(0)
  })

  it('hands an Auth0 error page met straight after the goto to the person, typing nothing', () => {
    const result = walk(steps, { goto: { delayMs: 0, page: AUTH0_ERROR } })
    expect(result).toEqual({
      outcome: 'needs-user',
      reason: 'site-changed',
      note: NOTES.unknownPage,
      actions: ['goto'],
      pausedMs: 0,
    })
  })

  it('hands a login page that never appeared to the person as site-changed', () => {
    const result = walk(steps, { goto: { delayMs: 0, page: BLANK } })
    expect(result).toEqual({
      outcome: 'needs-user',
      reason: 'site-changed',
      note: NOTES.noLoginPage,
      actions: ['goto'],
      pausedMs: SETTLE_TOTAL_MS,
    })
  })

  it('does not take a lookalike path without the field for the page', () => {
    const bare: PageState = { path: '/u/login/identifier?state=T', visible: [] }
    const result = walk(steps, { goto: { delayMs: 0, page: bare } })
    expect(result).toMatchObject({ outcome: 'needs-user', reason: 'site-changed', note: NOTES.unknownPage })
    expect(result.actions).toEqual(['goto'])
  })

  it('never runs off the end, types each secret at most once, and waits a bounded time', () => {
    const pages = [
      IDENTIFIER,
      PASSWORD,
      SMS,
      TOTP,
      EMAIL,
      HOME,
      BLANK,
      withVisible(PASSWORD, SELECTORS.fieldError),
      withVisible(IDENTIFIER, SELECTORS.captcha),
      AUTH0_ERROR,
      { path: '/u/terms?state=T', visible: [SELECTORS.auth0Widget] },
    ]
    for (const manifestSteps of [steps, totpSteps]) {
      for (const first of pages) {
        for (const afterIdentifier of pages) {
          for (const afterPassword of pages) {
            for (const afterChallenge of pages) {
              const result = walk(manifestSteps, {
                goto: { delayMs: 0, page: first },
                submit: {
                  identifier: { delayMs: 0, page: afterIdentifier },
                  password: { delayMs: 0, page: afterPassword },
                  challenge: { delayMs: 0, page: afterChallenge },
                },
              })
              expect(result.outcome).not.toBe('ran-out')
              for (const secret of ['fill:username', 'fill:password']) {
                expect(result.actions.filter((action) => action === secret).length).toBeLessThanOrEqual(1)
              }
              expect(result.actions.filter((action) => action.startsWith('otp')).length).toBeLessThanOrEqual(
                1,
              )
              // Four settles at most (after the goto, the email, the password and the code).
              expect(result.pausedMs).toBeLessThanOrEqual(4 * SETTLE_TOTAL_MS)
            }
          }
        }
      }
    }
  })

  it('reads the SMS code from the Woolworths sender, as a six-digit number', () => {
    const [source] = messagesSourcesIn(steps)
    expect(source).toEqual({ sender: MESSAGES_SENDER, pattern: '\\b(\\d{6})\\b', maxAgeSeconds: 300 })
    const pattern = new RegExp(source?.pattern ?? '')
    expect(pattern.exec('Your Woolworths verification code is 135790.')?.[1]).toBe('135790')
    expect(pattern.exec('Order 1234567 is on its way')).toBeNull()
  })

  it('walks the same way against the fake origins', () => {
    const result = walk(createManifest({ origin: FAKE_ORIGIN }).auth.steps, FULL)
    expect(result.outcome).toBe('logged-in')
  })
})
