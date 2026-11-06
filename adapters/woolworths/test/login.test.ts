import { SiteAdapterError } from '@siteadapter/core'
import { describe, expect, it } from 'vitest'
import { requireLogin } from '../src/login'
import { FakeToolContext } from './fake-context'

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

  it('turns needsUser into not-logged-in, without the free-text reason', async () => {
    const ctx = new FakeToolContext()
    ctx.ensureResult = { status: 'needsUser', reason: 'Verify it is you: code sent to 0400 000 000' }
    const error = await outcome(ctx)
    expect(error).toEqual(new SiteAdapterError('tool-run', 'not-logged-in'))
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
    expect(error).toEqual(new SiteAdapterError('tool-run', 'not-logged-in'))
    expect(String(error)).not.toContain('hunter2')
  })

  it('refuses an error class outside the vocabulary', async () => {
    const ctx = new FakeToolContext()
    ctx.ensureResult = { status: 'failed', stage: 'credential', errorClass: 'item op://Private/Woolworths' }
    const error = await outcome(ctx)
    expect(error).toEqual(new SiteAdapterError('tool-run', 'not-logged-in'))
    expect(String(error)).not.toContain('op://')
  })
})
