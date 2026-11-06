import { SiteAdapterError } from '@siteadapter/core'
import { describe, expect, it } from 'vitest'
import { getCart } from '../src/cart'
import { NEEDS_USER, requireLogin } from '../src/login'
import { FakeToolContext, json } from './fake-context'

async function outcome(ctx: FakeToolContext): Promise<unknown> {
  return requireLogin(ctx).then(
    () => 'ok',
    (e: unknown) => e,
  )
}

describe('requireLogin', () => {
  it('returns when the session is logged in', async () => {
    const ctx = new FakeToolContext()
    expect(await outcome(ctx)).toBe('ok')
    expect(ctx.events).toEqual(['ensure'])
  })

  it('turns needsUser into auth-step/not-logged-in, without the free-text reason', async () => {
    const ctx = new FakeToolContext()
    ctx.ensureResult = { status: 'needsUser', reason: 'Verify it is you: code sent to 0400 000 000' }
    const error = await outcome(ctx)
    expect(error).toEqual(new SiteAdapterError('auth-step', 'not-logged-in'))
    expect(String(error)).not.toContain('0400')
    expect(JSON.stringify(error)).not.toContain('0400')
  })

  it('keeps a failure whose stage and class are in the fixed vocabularies', async () => {
    const ctx = new FakeToolContext()
    ctx.ensureResult = { status: 'failed', stage: 'auth-step', errorClass: 'blocked-by-site' }
    expect(await outcome(ctx)).toEqual(new SiteAdapterError('auth-step', 'blocked-by-site'))
  })

  it('refuses a stage outside the vocabulary, so free text cannot ride along', async () => {
    const ctx = new FakeToolContext()
    ctx.ensureResult = { status: 'failed', stage: 'password is hunter2', errorClass: 'locked' }
    const error = await outcome(ctx)
    expect(error).toEqual(new SiteAdapterError('auth-step', 'auth-failed'))
    expect(String(error)).not.toContain('hunter2')
  })

  it('refuses an error class outside the vocabulary', async () => {
    const ctx = new FakeToolContext()
    ctx.ensureResult = { status: 'failed', stage: 'credential', errorClass: 'item op://Private/Woolworths' }
    const error = await outcome(ctx)
    expect(error).toEqual(new SiteAdapterError('auth-step', 'auth-failed'))
    expect(String(error)).not.toContain('op://')
  })

  it('never reports needsUser as the expired-session pair a 401 gives, which the runtime re-logs in on', async () => {
    const needsUser = new FakeToolContext()
    needsUser.ensureResult = { status: 'needsUser', reason: 'CAPTCHA shown' }
    const expiredMidTool = new FakeToolContext().on('GET', '/apis/ui/Trolley', json({}, 401))

    const fromNeedsUser = (await outcome(needsUser)) as SiteAdapterError
    const from401 = (await getCart.run(expiredMidTool, {}).catch((e: unknown) => e)) as SiteAdapterError

    expect([from401.stage, from401.errorClass]).toEqual(['tool-run', 'not-logged-in'])
    expect([fromNeedsUser.stage, fromNeedsUser.errorClass]).not.toEqual([from401.stage, from401.errorClass])
    expect([fromNeedsUser.stage, fromNeedsUser.errorClass]).toEqual([...NEEDS_USER])
  })

  it('does not dress an unknown ensure() failure up as an expired session either', async () => {
    const ctx = new FakeToolContext()
    ctx.ensureResult = { status: 'failed', stage: 'something-new', errorClass: 'not-logged-in' }
    const error = (await outcome(ctx)) as SiteAdapterError
    expect([error.stage, error.errorClass]).not.toEqual(['tool-run', 'not-logged-in'])
  })
})
