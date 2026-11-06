// Walks the manifest's auth steps against scripted login pages, to check where each kind of login
// ends up. The walker models only what these steps use; the real interpreter lives in
// @siteadapter/auth-flow, and its own tests cover the step semantics.

import type { AuthStep, Condition } from '@siteadapter/core'
import { describe, expect, it } from 'vitest'
import realManifest, {
  createManifest,
  LOGIN_PATH,
  NEEDS_USER_REASONS,
  SELECTORS,
  SETTLE_PAUSES_MS,
  settle,
} from '../src/manifest'
import { FAKE_ORIGIN } from './fake-context'

interface PageState {
  readonly path: string
  readonly visible: readonly string[]
}

/** A page change that happens `delayMs` of pausing after the named action. */
interface Change {
  readonly delayMs: number
  readonly page: PageState
}

interface Script {
  readonly goto: Change
  readonly submit: Change
  readonly otp?: Change
}

interface Walk {
  readonly outcome: 'logged-in' | 'needs-user' | 'ran-out'
  readonly reason?: string
  /** "fill:username", "click", "otp" and so on, in order. */
  readonly actions: string[]
  readonly pausedMs: number
}

const LOGIN_FORM: PageState = {
  path: LOGIN_PATH,
  visible: [SELECTORS.email, SELECTORS.password, SELECTORS.submit],
}
const CODE_PROMPT: PageState = { path: LOGIN_PATH, visible: [SELECTORS.otp] }
const SIGNED_IN: PageState = { path: '/shop/browse', visible: [] }
const BLANK: PageState = { path: '/', visible: [] }

class NeedsUser {
  constructor(readonly reason: string) {}
}

class LoggedIn {}

function holds(condition: Condition, page: PageState): boolean {
  if ('visible' in condition) return page.visible.includes(condition.visible)
  if ('urlMatches' in condition) return page.path.includes(condition.urlMatches)
  if ('not' in condition) return !holds(condition.not, page)
  if ('any' in condition) return condition.any.some((inner) => holds(inner, page))
  if ('all' in condition) return condition.all.every((inner) => holds(inner, page))
  throw new Error(`the walker does not model ${JSON.stringify(condition)}`)
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

  const run = (list: readonly AuthStep[]): void => {
    for (const step of list) {
      switch (step.op) {
        case 'goto':
          actions.push('goto')
          schedule(script.goto)
          break
        case 'fill':
          if (!page.visible.includes(step.selector)) throw new Error(`filled hidden ${step.selector}`)
          actions.push('secret' in step.value ? `fill:${step.value.field}` : 'fill:literal')
          break
        case 'click':
          if (!page.visible.includes(step.selector)) throw new Error(`clicked hidden ${step.selector}`)
          actions.push('click')
          schedule(script.submit)
          break
        case 'otp':
          if (!page.visible.includes(step.selector))
            throw new Error(`typed code into hidden ${step.selector}`)
          actions.push('otp')
          schedule(script.otp)
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
          throw new NeedsUser(step.reason)
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
    if (end instanceof NeedsUser) return { outcome: 'needs-user', reason: end.reason, actions, pausedMs }
    if (end instanceof LoggedIn) return { outcome: 'logged-in', actions, pausedMs }
    throw end
  }
  return { outcome: 'ran-out', actions, pausedMs }
}

const steps = realManifest.auth.steps
const SETTLE_TOTAL_MS = SETTLE_PAUSES_MS.reduce((sum, ms) => sum + ms, 0)

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

  it('waits 20 s at most for any one page change', () => {
    expect(SETTLE_TOTAL_MS).toBe(20_000)
  })
})

describe('the login, walked against scripted pages', () => {
  it('signs in without a code, stopping its wait as soon as the page moves on', () => {
    const result = walk(steps, {
      goto: { delayMs: 0, page: LOGIN_FORM },
      submit: { delayMs: 2500, page: SIGNED_IN },
    })
    expect(result.outcome).toBe('logged-in')
    expect(result.actions).toEqual(['goto', 'fill:username', 'fill:password', 'click'])
    expect(result.pausedMs).toBe(3000)
  })

  it('fills the code when the prompt appears, then waits for the page to move on', () => {
    const result = walk(steps, {
      goto: { delayMs: 0, page: LOGIN_FORM },
      submit: { delayMs: 1000, page: CODE_PROMPT },
      otp: { delayMs: 2000, page: SIGNED_IN },
    })
    expect(result.outcome).toBe('logged-in')
    expect(result.actions).toEqual(['goto', 'fill:username', 'fill:password', 'click', 'otp'])
  })

  it('waits for a slow sign-in form instead of failing', () => {
    const result = walk(steps, {
      goto: { delayMs: 9000, page: LOGIN_FORM },
      submit: { delayMs: 0, page: SIGNED_IN },
    })
    expect(result.outcome).toBe('logged-in')
  })

  it('hands a challenge shown instead of the form to the person, before typing any secret', () => {
    const challenge: PageState = { path: LOGIN_PATH, visible: ['#sec-cpt-if'] }
    const result = walk(steps, {
      goto: { delayMs: 0, page: challenge },
      submit: { delayMs: 0, page: SIGNED_IN },
    })
    expect(result).toEqual({
      outcome: 'needs-user',
      reason: NEEDS_USER_REASONS.noForm,
      actions: ['goto'],
      pausedMs: SETTLE_TOTAL_MS,
    })
  })

  it('hands a CAPTCHA or rejected password after submit to the person, submitting the password once', () => {
    const rejected: PageState = { path: LOGIN_PATH, visible: [...LOGIN_FORM.visible, '.login-error'] }
    const result = walk(steps, {
      goto: { delayMs: 0, page: LOGIN_FORM },
      submit: { delayMs: 800, page: rejected },
    })
    expect(result).toEqual({
      outcome: 'needs-user',
      reason: NEEDS_USER_REASONS.stuck,
      actions: ['goto', 'fill:username', 'fill:password', 'click'],
      pausedMs: SETTLE_TOTAL_MS,
    })
  })

  it('hands a code that the site did not accept to the person, typing it once', () => {
    const result = walk(steps, {
      goto: { delayMs: 0, page: LOGIN_FORM },
      submit: { delayMs: 0, page: CODE_PROMPT },
      otp: { delayMs: 0, page: CODE_PROMPT },
    })
    expect(result.outcome).toBe('needs-user')
    expect(result.reason).toBe(NEEDS_USER_REASONS.stuck)
    expect(result.actions.filter((action) => action === 'otp')).toEqual(['otp'])
  })

  it('never runs off the end without asserting the login or asking for the person', () => {
    const pages = [LOGIN_FORM, CODE_PROMPT, SIGNED_IN, BLANK]
    for (const first of pages) {
      for (const afterSubmit of pages) {
        for (const afterOtp of pages) {
          const result = walk(steps, {
            goto: { delayMs: 0, page: first },
            submit: { delayMs: 0, page: afterSubmit },
            otp: { delayMs: 0, page: afterOtp },
          })
          expect(result.outcome).not.toBe('ran-out')
          expect(result.pausedMs).toBeLessThanOrEqual(3 * SETTLE_TOTAL_MS)
        }
      }
    }
  })

  it('walks the same way against the fake origin', () => {
    const result = walk(createManifest({ origin: FAKE_ORIGIN }).auth.steps, {
      goto: { delayMs: 0, page: LOGIN_FORM },
      submit: { delayMs: 0, page: LOGIN_FORM },
    })
    expect(result.outcome).toBe('needs-user')
  })
})
