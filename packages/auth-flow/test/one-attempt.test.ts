// AC10, as far as the auth flow goes: at most one automated password submit per login, whatever the
// manifest's retry steps say (D32), and the caller told before any password or code is typed (D35).

import { describe, expect, it } from 'vitest'
import { runAuthFlow } from '../src/run-auth-flow'
import { ACCOUNT_PAGE, CANARY, LOGIN_PAGE, manifestWithSteps, SITE, world } from './fixtures'

/** The example site, where the password is wrong: submitting comes back to the login page. */
function wrongPassword(w: ReturnType<typeof world>): void {
  const login = structuredClone(SITE[LOGIN_PAGE])
  w.page.site[LOGIN_PAGE] = { ...login, clicks: { '#submit': LOGIN_PAGE } }
}

const typedPasswords = (w: ReturnType<typeof world>) =>
  w.page.typed.filter((t) => t.text === CANARY.password).length

describe('one password submit per login', () => {
  it('types and submits a wrong password once, even inside a generous retry', async () => {
    const w = world()
    wrongPassword(w)
    w.input.manifest = manifestWithSteps([
      { op: 'goto', url: LOGIN_PAGE },
      {
        op: 'retry',
        times: 5,
        steps: [
          { op: 'waitFor', condition: { visible: '#email' }, timeoutMs: 1_000 },
          { op: 'fill', selector: '#email', value: { secret: 'login', field: 'username' } },
          { op: 'fill', selector: '#password', value: { secret: 'login', field: 'password' } },
          { op: 'click', selector: '#submit' },
          // Never true after a rejected password, so this times out, which retry would retry.
          { op: 'waitFor', condition: { urlContains: '/account' }, timeoutMs: 1_000 },
        ],
      },
    ])
    expect(await runAuthFlow(w.input)).toEqual({ status: 'needsUser', reason: 'login-required' })
    expect(typedPasswords(w)).toBe(1)
    expect(w.page.clicked).toEqual(['#submit'])
    // The second password was refused before it was fetched from the provider.
    expect(w.provider.calls.filter((c) => c.field === 'password')).toHaveLength(1)
  })

  it('refuses a second password fill outside any retry too', async () => {
    const w = world()
    w.input.manifest = manifestWithSteps([
      { op: 'goto', url: LOGIN_PAGE },
      { op: 'fill', selector: '#password', value: { secret: 'login', field: 'password' } },
      { op: 'fill', selector: '#password', value: { secret: 'login', field: 'password' } },
    ])
    expect(await runAuthFlow(w.input)).toEqual({ status: 'needsUser', reason: 'login-required' })
    expect(typedPasswords(w)).toBe(1)
  })

  it('still fills the username as often as the steps say', async () => {
    const w = world()
    w.page.cookies.add('session')
    w.input.manifest = manifestWithSteps([
      { op: 'goto', url: LOGIN_PAGE },
      { op: 'fill', selector: '#email', value: { secret: 'login', field: 'username' } },
      { op: 'fill', selector: '#email', value: { secret: 'login', field: 'username' } },
    ])
    expect(await runAuthFlow(w.input)).toEqual({ status: 'ok' })
    expect(w.page.typed.filter((t) => t.text === CANARY.username)).toHaveLength(2)
  })
})

describe('beforeAttempt', () => {
  it('is awaited before the password is typed, and not before the username', async () => {
    const w = world()
    const order: string[] = []
    w.input.beforeAttempt = async () => {
      order.push(`attempt after ${w.page.typed.length} typed`)
    }
    expect(await runAuthFlow(w.input)).toEqual({ status: 'ok' })
    expect(order).toEqual(['attempt after 1 typed'])
    expect(w.page.currentUrl()).toBe(ACCOUNT_PAGE)
  })

  it('is awaited before a one-time code is typed', async () => {
    const w = world()
    w.page.cookies.add('session')
    let calls = 0
    w.input.beforeAttempt = async () => {
      calls++
    }
    w.input.manifest = manifestWithSteps([
      { op: 'goto', url: LOGIN_PAGE },
      { op: 'otp', selector: '#otp', source: { secret: 'login' } },
    ])
    expect(await runAuthFlow(w.input)).toEqual({ status: 'ok' })
    expect(calls).toBe(1)
  })

  it('types nothing when it fails, and ends the login as a secret-fill fault', async () => {
    const w = world()
    w.input.beforeAttempt = async () => {
      throw new Error('disk full')
    }
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'secret-fill',
      errorClass: 'internal',
    })
    expect(typedPasswords(w)).toBe(0)
    expect(w.page.clicked).toEqual([])
  })
})
