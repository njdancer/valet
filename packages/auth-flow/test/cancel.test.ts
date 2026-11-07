// D67: a login stops when the call that needed it gives up, and says whether a password or code
// had begun to be typed, so the runtime knows whether the site saw an attempt.

import { describe, expect, it } from 'vitest'
import { runAuthFlow } from '../src/run-auth-flow'
import { CANARY, manifestWithSteps, world } from './fixtures'

const aborted = (attemptStarted: boolean) => ({
  status: 'failed',
  stage: 'auth-step',
  errorClass: 'aborted',
  attemptStarted,
})

function typedTexts(w: ReturnType<typeof world>): string[] {
  return w.page.typed.map((t) => t.text)
}

describe('runAuthFlow cancellation', () => {
  it('runs as before when the signal never fires', async () => {
    const w = world()
    w.input.signal = new AbortController().signal
    expect(await runAuthFlow(w.input)).toEqual({ status: 'ok' })
  })

  it('does nothing on the page when the signal has already fired', async () => {
    const w = world()
    const controller = new AbortController()
    controller.abort()
    w.input.signal = controller.signal
    expect(await runAuthFlow(w.input)).toEqual(aborted(false))
    expect(w.page.typed).toEqual([])
    expect(w.provider.calls).toEqual([])
  })

  it('stops while waiting for the email field, with no attempt started', async () => {
    const w = world()
    const controller = new AbortController()
    w.input.signal = controller.signal
    w.input.manifest = manifestWithSteps([
      { op: 'goto', url: 'https://login.shop.test/' },
      { op: 'waitFor', condition: { visible: '#never' }, timeoutMs: 10_000 },
    ])
    w.clock.onSleep = () => controller.abort()
    expect(await runAuthFlow(w.input)).toEqual(aborted(false))
    expect(w.page.typed).toEqual([])
  })

  it('stops after the email and before the password, with no attempt started', async () => {
    const w = world()
    const controller = new AbortController()
    w.input.signal = controller.signal
    // The cancel lands while the person approves the password's fetch (Touch ID, say).
    w.provider.beforeResolve = () => {
      if (w.provider.calls.at(-1)?.field === 'password') controller.abort()
    }
    expect(await runAuthFlow(w.input)).toEqual(aborted(false))
    expect(typedTexts(w)).toEqual([CANARY.username])
    // The value it fetched is still disposed.
    expect(w.provider.issued.every((secret) => secret.disposed)).toBe(true)
  })

  it('reports an attempt started once the password has been typed', async () => {
    const w = world()
    const controller = new AbortController()
    w.input.signal = controller.signal
    w.input.manifest = manifestWithSteps([
      { op: 'goto', url: 'https://login.shop.test/' },
      { op: 'fill', selector: '#email', value: { secret: 'login', field: 'username' } },
      { op: 'fill', selector: '#password', value: { secret: 'login', field: 'password' } },
      { op: 'pause', ms: 1_000 },
      { op: 'click', selector: '#submit' },
    ])
    w.clock.onSleep = () => controller.abort()
    expect(await runAuthFlow(w.input)).toEqual(aborted(true))
    expect(typedTexts(w)).toEqual([CANARY.username, CANARY.password])
    expect(w.page.clicked).toEqual([])
  })

  it('counts a one-time code as an attempt too', async () => {
    const w = world()
    const controller = new AbortController()
    w.input.signal = controller.signal
    w.input.manifest = manifestWithSteps([
      { op: 'goto', url: 'https://login.shop.test/' },
      { op: 'otp', selector: '#otp', source: { secret: 'login' } },
      { op: 'pause', ms: 1_000 },
    ])
    w.clock.onSleep = () => controller.abort()
    expect(await runAuthFlow(w.input)).toEqual(aborted(true))
  })

  it('cuts a pause short instead of sleeping on after the cancel', async () => {
    const w = world()
    const controller = new AbortController()
    w.input.signal = controller.signal
    w.input.manifest = manifestWithSteps([
      { op: 'goto', url: 'https://login.shop.test/' },
      { op: 'pause', ms: 30_000 },
    ])
    // A sleep that never ends: only the signal can get the flow out of it.
    w.input.sleep = () => new Promise<void>(() => {})
    const running = runAuthFlow(w.input)
    await new Promise((resolve) => setTimeout(resolve, 0))
    controller.abort()
    expect(await running).toEqual(aborted(false))
  })

  it('audits the stop as a failed login', async () => {
    const w = world()
    const controller = new AbortController()
    controller.abort()
    w.input.signal = controller.signal
    await runAuthFlow(w.input)
    expect(w.audit.events.at(-1)).toEqual({
      type: 'login-finished',
      adapterId: 'shop',
      outcome: 'failed',
      stage: 'auth-step',
      errorClass: 'aborted',
    })
  })

  it('never retries a cancelled login', async () => {
    const w = world()
    const controller = new AbortController()
    w.input.signal = controller.signal
    w.input.manifest = manifestWithSteps([
      { op: 'goto', url: 'https://login.shop.test/' },
      { op: 'retry', times: 3, steps: [{ op: 'pause', ms: 1_000 }] },
    ])
    w.clock.onSleep = () => controller.abort()
    expect(await runAuthFlow(w.input)).toEqual(aborted(false))
    expect(w.clock.sleeps).toEqual([1_000])
  })
})
