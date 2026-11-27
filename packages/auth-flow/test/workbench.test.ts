// The login workbench: an agent's batches of auth steps on one page, with a login's checks.

import { describe, expect, it } from 'vitest'
import { LoginWorkbench } from '../src/workbench'
import { ACCOUNT_PAGE, CANARY, EVIL, LOGIN_PAGE, world } from './fixtures'

function bench(change?: (w: ReturnType<typeof world>) => void) {
  const w = world()
  change?.(w)
  const { flowTimeoutMs: _t, ...input } = w.input
  return { w, bench: new LoginWorkbench(input) }
}

const fill = (selector: string, field: 'username' | 'password') =>
  ({ op: 'fill', selector, value: { secret: 'login', field } }) as const

describe('LoginWorkbench', () => {
  it('runs batches on one page, each after where the last left it, and logs in', async () => {
    const { w, bench: b } = bench()
    expect(await b.run({ steps: [{ op: 'goto', url: LOGIN_PAGE }], timeoutMs: 10_000 })).toEqual({
      status: 'ok',
    })
    expect(await b.run({ steps: [fill('#email', 'username')], timeoutMs: 10_000 })).toEqual({ status: 'ok' })
    const last = await b.run({
      steps: [fill('#password', 'password'), { op: 'click', selector: '#submit' }, { op: 'assertLoggedIn' }],
      timeoutMs: 10_000,
    })
    expect(last).toEqual({ status: 'ok' })
    expect(w.page.currentUrl()).toBe(ACCOUNT_PAGE)
    // Typed by secret-fill, audited, and remembered for redaction like a login's.
    expect(w.page.typed.map((t) => t.text)).toEqual([CANARY.username, CANARY.password])
    expect(w.audit.events.filter((e) => e.type === 'secret-used')).toHaveLength(2)
    expect(w.remembered).toHaveLength(2)
    b.close()
  })

  it('types a password once in its whole life, however many batches ask', async () => {
    const { w, bench: b } = bench()
    await b.run({
      steps: [{ op: 'goto', url: LOGIN_PAGE }, fill('#password', 'password')],
      timeoutMs: 10_000,
    })
    expect(await b.run({ steps: [fill('#password', 'password')], timeoutMs: 10_000 })).toEqual({
      status: 'needsUser',
      reason: 'login-required',
    })
    expect(w.page.typed.filter((t) => t.text === CANARY.password)).toHaveLength(1)
    expect(w.provider.calls.filter((c) => c.field === 'password')).toHaveLength(1)
  })

  it('keeps a login’s walls: off the navigation origins, a secret off its grant’s origins', async () => {
    const { bench: b } = bench()
    expect(await b.run({ steps: [{ op: 'goto', url: `${EVIL}/` }], timeoutMs: 10_000 })).toMatchObject({
      status: 'failed',
      errorClass: 'navigation-escaped',
    })
    const other = bench()
    await other.bench.run({ steps: [{ op: 'goto', url: ACCOUNT_PAGE }], timeoutMs: 10_000 })
    expect(await other.bench.run({ steps: [fill('#email', 'username')], timeoutMs: 10_000 })).toMatchObject({
      status: 'failed',
    })
    expect(other.w.page.typed).toEqual([])
  })

  it('asks beforeAct before every click and fill, and stops the batch on its refusal', async () => {
    const acted: string[] = []
    const { w, bench: b } = bench((w) => {
      w.input.beforeAct = async () => {
        acted.push(w.page.currentUrl())
        if (w.page.currentUrl() === ACCOUNT_PAGE)
          throw new (await import('@valet/core')).ValetError('auth-step', 'navigation-escaped')
      }
    })
    await b.run({
      steps: [
        { op: 'goto', url: LOGIN_PAGE },
        { op: 'click', selector: '#submit' },
      ],
      timeoutMs: 10_000,
    })
    expect(await b.run({ steps: [{ op: 'click', selector: '#submit' }], timeoutMs: 10_000 })).toMatchObject({
      status: 'failed',
      errorClass: 'navigation-escaped',
    })
    expect(acted).toEqual([LOGIN_PAGE, ACCOUNT_PAGE])
    expect(w.page.clicked).toEqual(['#submit'])
  })

  it('returns needsUser without its note, and refuses bad batches and a closed workbench', async () => {
    const { bench: b } = bench()
    expect(
      await b.run({ steps: [{ op: 'needsUser', reason: 'captcha', note: 'secret note' }], timeoutMs: 1_000 }),
    ).toEqual({ status: 'needsUser', reason: 'captcha' })
    expect(await b.run({ steps: [], timeoutMs: 0 })).toMatchObject({
      status: 'failed',
      errorClass: 'invalid',
    })
    b.close()
    expect(await b.run({ steps: [], timeoutMs: 1_000 })).toMatchObject({
      status: 'failed',
      errorClass: 'aborted',
    })
  })
})
