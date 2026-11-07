import { NeedsUserError, ValetError } from '@valet/core'
import { describe, expect, it } from 'vitest'
import { getCart } from '../src/cart'
import { requireLogin, withLogin } from '../src/login'
import { FakeToolContext, json } from './fake-context'

async function outcome(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => 'ok',
    (e: unknown) => e,
  )
}

describe('requireLogin', () => {
  it('returns when the session is logged in', async () => {
    const ctx = new FakeToolContext()
    expect(await outcome(requireLogin(ctx))).toBe('ok')
    expect(ctx.events).toEqual(['ensure'])
  })

  it('throws NeedsUserError with the reason, so the run ends as needsUser', async () => {
    for (const reason of ['captcha', 'otp-required', 'account-locked', 'login-required'] as const) {
      const ctx = new FakeToolContext()
      ctx.ensureResult = { status: 'needsUser', reason }
      const error = await outcome(requireLogin(ctx))
      expect(error).toBeInstanceOf(NeedsUserError)
      expect((error as NeedsUserError).reason).toBe(reason)
    }
  })

  it('does not pass on a needsUser reason outside the vocabulary', async () => {
    const ctx = new FakeToolContext()
    ctx.ensureResult = { status: 'needsUser', reason: 'Verify it is you: code sent to 0400 000 000' as any }
    const error = await outcome(requireLogin(ctx))
    expect(error).toEqual(new NeedsUserError('other'))
    expect(String(error)).not.toContain('0400')
    expect(JSON.stringify(error)).not.toContain('0400')
  })

  it('keeps a failure whose stage and class are in the fixed vocabularies', async () => {
    const ctx = new FakeToolContext()
    ctx.ensureResult = { status: 'failed', stage: 'credential', errorClass: 'locked' }
    expect(await outcome(requireLogin(ctx))).toEqual(new ValetError('credential', 'locked'))
  })

  it('refuses a stage outside the vocabulary, so free text cannot ride along', async () => {
    const ctx = new FakeToolContext()
    ctx.ensureResult = { status: 'failed', stage: 'password is hunter2' as any, errorClass: 'locked' }
    const error = await outcome(requireLogin(ctx))
    expect(error).toEqual(new ValetError('auth-step', 'auth-failed'))
    expect(String(error)).not.toContain('hunter2')
  })

  it('refuses an error class outside the vocabulary', async () => {
    const ctx = new FakeToolContext()
    ctx.ensureResult = {
      status: 'failed',
      stage: 'credential',
      errorClass: 'item op://Private/Woolworths' as any,
    }
    const error = await outcome(requireLogin(ctx))
    expect(error).toEqual(new ValetError('auth-step', 'auth-failed'))
    expect(String(error)).not.toContain('op://')
  })

  it('never reports a failed login as the expired-session pair a 401 gives', async () => {
    const ctx = new FakeToolContext()
    ctx.ensureResult = { status: 'failed', stage: 'something-new' as any, errorClass: 'not-logged-in' }
    const error = (await outcome(requireLogin(ctx))) as ValetError
    expect([error.stage, error.errorClass]).not.toEqual(['tool-run', 'not-logged-in'])
  })
})

describe('withLogin', () => {
  it('ensures, then runs the call once', async () => {
    const ctx = new FakeToolContext()
    let runs = 0
    expect(await withLogin(ctx, async () => ++runs)).toBe(1)
    expect(ctx.events).toEqual(['ensure'])
  })

  it('does not run the call when the login needs the person', async () => {
    const ctx = new FakeToolContext()
    ctx.ensureResult = { status: 'needsUser', reason: 'captcha' }
    let runs = 0
    expect(await outcome(withLogin(ctx, async () => ++runs))).toEqual(new NeedsUserError('captcha'))
    expect(runs).toBe(0)
  })

  it('logs in once more and runs the call again after an expired session, and no more', async () => {
    const ctx = new FakeToolContext()
    let runs = 0
    const error = await outcome(
      withLogin(ctx, async () => {
        runs += 1
        throw new ValetError('tool-run', 'not-logged-in')
      }),
    )
    expect(error).toEqual(new ValetError('tool-run', 'not-logged-in'))
    expect(runs).toBe(2)
    expect(ctx.events).toEqual(['ensure', 'ensure'])
  })

  it('passes every other error straight through', async () => {
    for (const thrown of [
      new ValetError('tool-run', 'blocked-by-site'),
      new ValetError('auth-step', 'not-logged-in'),
      new ValetError('request-surface', 'request-ceiling'),
      new NeedsUserError('captcha'),
      new Error('boom'),
    ]) {
      const ctx = new FakeToolContext()
      expect(await outcome(withLogin(ctx, async () => Promise.reject(thrown)))).toBe(thrown)
      expect(ctx.events).toEqual(['ensure'])
    }
  })

  it('reaches a cart tool: a 401 on every try ends as tool-run/not-logged-in after two', async () => {
    const ctx = new FakeToolContext().on('GET', '/apis/ui/Trolley', json({}, 401))
    const error = await outcome(getCart.run(ctx, {}))
    expect(error).toEqual(new ValetError('tool-run', 'not-logged-in'))
    expect(ctx.fetches).toHaveLength(2)
  })
})
