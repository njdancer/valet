import { describe, expect, it } from 'vitest'
import { runAuthFlow } from '../src/run-auth-flow'
import { CANARY, LOGIN_PAGE, manifestWithSteps, START, world } from './fixtures'

describe('a clock that misbehaves', () => {
  it('reports a clock that throws at the start as internal, without its message', async () => {
    const w = world()
    w.input.clock = () => {
      throw new Error(`boom ${CANARY.password}`)
    }
    const outcome = await runAuthFlow(w.input)
    expect(outcome).toEqual({ status: 'failed', stage: 'auth-step', errorClass: 'internal' })
    expect(JSON.stringify(outcome)).not.toContain(CANARY.password)
    expect(w.page.typed).toEqual([])
  })

  it('reports a clock that throws partway through as internal, and audits the finish', async () => {
    const w = world()
    let calls = 0
    w.input.clock = () => {
      if (++calls > 3) throw new Error(`boom ${CANARY.password}`)
      return new Date(START)
    }
    const outcome = await runAuthFlow(w.input)
    expect(outcome).toEqual({ status: 'failed', stage: 'auth-step', errorClass: 'internal' })
    expect(w.audit.events.at(-1)).toMatchObject({ type: 'login-finished', errorClass: 'internal' })
    expect(JSON.stringify(w.audit.events)).not.toContain(CANARY.password)
  })

  it('reports a clock that returns an invalid date at the start as internal', async () => {
    const w = world()
    w.input.clock = () => new Date(Number.NaN)
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'auth-step',
      errorClass: 'internal',
    })
    expect(w.audit.events).toEqual([])
  })

  it('stops, rather than polling forever, when the clock goes invalid partway through', async () => {
    const w = world()
    let calls = 0
    w.input.clock = () => new Date(++calls > 2 ? Number.NaN : START)
    w.input.manifest = manifestWithSteps([
      { op: 'goto', url: LOGIN_PAGE },
      { op: 'waitFor', condition: { visible: '#never' }, timeoutMs: 10_000 },
    ])
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'auth-step',
      errorClass: 'internal',
    })
    expect(w.clock.sleeps).toEqual([])
  })
})

describe('the flow budget and typing delay', () => {
  it('refuses a NaN flow timeout before doing anything, so no poll loop can run forever', async () => {
    const w = world()
    w.input.flowTimeoutMs = Number.NaN
    w.input.manifest = manifestWithSteps([
      { op: 'goto', url: LOGIN_PAGE },
      {
        op: 'otp',
        selector: '#otp',
        source: { messages: { sender: 'ShopSMS', pattern: 'code is (\\d{6})', maxAgeSeconds: 300 } },
      },
    ])
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'auth-step',
      errorClass: 'invalid',
    })
    expect(w.otpReader.calls).toEqual([])
    expect(w.clock.sleeps).toEqual([])
    expect(w.page.visited).toEqual([])
    expect(w.audit.events).toEqual([])
  })

  it('refuses an infinite flow timeout', async () => {
    const w = world()
    w.input.flowTimeoutMs = Number.POSITIVE_INFINITY
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'auth-step',
      errorClass: 'invalid',
    })
  })

  it('refuses a zero flow timeout', async () => {
    const w = world()
    w.input.flowTimeoutMs = 0
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'auth-step',
      errorClass: 'invalid',
    })
  })

  it('refuses a negative flow timeout', async () => {
    const w = world()
    w.input.flowTimeoutMs = -1
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'auth-step',
      errorClass: 'invalid',
    })
  })

  it('accepts a one-millisecond flow timeout', async () => {
    const w = world()
    w.input.flowTimeoutMs = 1
    w.input.manifest = manifestWithSteps([{ op: 'goto', url: LOGIN_PAGE }])
    expect(await runAuthFlow(w.input)).toEqual({ status: 'ok' })
  })

  it('refuses a NaN typing delay before typing anything', async () => {
    const w = world()
    w.input.typingDelayMs = Number.NaN
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'auth-step',
      errorClass: 'invalid',
    })
    expect(w.page.typed).toEqual([])
    expect(w.provider.calls).toEqual([])
  })

  it('refuses a negative typing delay', async () => {
    const w = world()
    w.input.typingDelayMs = -40
    expect(await runAuthFlow(w.input)).toEqual({
      status: 'failed',
      stage: 'auth-step',
      errorClass: 'invalid',
    })
  })

  it('accepts a zero typing delay', async () => {
    const w = world()
    w.input.typingDelayMs = 0
    expect(await runAuthFlow(w.input)).toEqual({ status: 'ok' })
    expect(w.page.typed.every((typed) => typed.delayMs === 0)).toBe(true)
  })
})

describe('urlMatches patterns are checked up front', () => {
  it('refuses a bad pattern in a branch the flow never takes, before any secret is fetched', async () => {
    const w = world()
    w.input.manifest = manifestWithSteps([
      { op: 'goto', url: LOGIN_PAGE },
      { op: 'fill', selector: '#password', value: { secret: 'login', field: 'password' } },
      {
        op: 'when',
        condition: { visible: '#never' },
        steps: [{ op: 'waitFor', condition: { urlMatches: '/(/' }, timeoutMs: 1000 }],
      },
    ])
    expect(await runAuthFlow(w.input)).toEqual({ status: 'failed', stage: 'manifest', errorClass: 'invalid' })
    expect(w.provider.calls).toEqual([])
    expect(w.page.typed).toEqual([])
    expect(w.page.visited).toEqual([])
  })

  it('refuses a bad pattern inside an otherwise branch', async () => {
    const w = world()
    w.input.manifest = manifestWithSteps([
      {
        op: 'when',
        condition: { visible: '#email' },
        steps: [],
        otherwise: [{ op: 'waitFor', condition: { urlMatches: '/[/' }, timeoutMs: 1000 }],
      },
    ])
    expect(await runAuthFlow(w.input)).toMatchObject({ stage: 'manifest', errorClass: 'invalid' })
  })

  it('refuses a bad pattern inside a retry', async () => {
    const w = world()
    w.input.manifest = manifestWithSteps([
      {
        op: 'retry',
        times: 1,
        steps: [{ op: 'waitFor', condition: { urlMatches: '/a{2,1}/' }, timeoutMs: 1000 }],
      },
    ])
    expect(await runAuthFlow(w.input)).toMatchObject({ stage: 'manifest', errorClass: 'invalid' })
  })

  it('refuses a bad pattern nested in a when condition', async () => {
    const w = world()
    w.input.manifest = manifestWithSteps([
      {
        op: 'when',
        condition: { any: [{ visible: '#email' }, { not: { all: [{ urlMatches: '/+/' }] } }] },
        steps: [],
      },
    ])
    expect(await runAuthFlow(w.input)).toMatchObject({ stage: 'manifest', errorClass: 'invalid' })
  })

  it('accepts valid patterns everywhere', async () => {
    const w = world()
    w.input.manifest = manifestWithSteps([
      { op: 'goto', url: LOGIN_PAGE },
      {
        op: 'when',
        condition: { not: { urlMatches: '/^\\/account/' } },
        steps: [{ op: 'waitFor', condition: { textPresent: 'Sign in' }, timeoutMs: 1000 }],
        otherwise: [{ op: 'waitFor', condition: { urlMatches: 'account' }, timeoutMs: 1000 }],
      },
    ])
    expect(await runAuthFlow(w.input)).toEqual({ status: 'ok' })
  })
})
