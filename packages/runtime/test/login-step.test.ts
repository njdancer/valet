// runLoginStep: the person's own login work (opening the login window, finishing a hand-off) under
// the same lock, breaker and rate budget a tool call gets.

import { defineAdapter, tool, ValetError } from '@valet/core'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { serialiseBreakerFile } from '../src/breaker-state'
import { DEFAULT_LOGIN_STEP_WAIT_MS } from '../src/tool-host'
import { akamaiDenied, FakeSessionDriver, flush, MemoryJsonStore } from './fakes'
import { call, fixture, HASH, HOME, manifest } from './fixtures'

async function errorOf(promise: Promise<unknown>): Promise<ValetError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof ValetError) return error
    throw error
  }
  throw new Error('expected a ValetError')
}

/** A tool that runs until the test releases it, recording when it starts and ends. */
function gatedTool(events: string[]) {
  const gates: (() => void)[] = []
  const definition = defineAdapter({
    manifest,
    tools: {
      run_test: tool({
        input: z.object({ id: z.string() }),
        output: z.string(),
        run: async (_ctx, input) => {
          events.push(`${input.id}:start`)
          await new Promise<void>((resolve) => gates.push(resolve))
          events.push(`${input.id}:end`)
          return input.id
        },
      }),
    },
  })
  return { definition, release: () => gates.shift()?.() }
}

const trivial = defineAdapter({
  manifest,
  tools: { run_test: tool({ input: z.object({}), output: z.string(), run: async () => 'ran' }) },
})

describe('ToolHost.runLoginStep', () => {
  it('runs the step and returns what it returns, after taking one rate-budget slot', async () => {
    const { host, clock } = fixture(trivial)
    const step = vi.fn(async () => 'window open')
    expect(await host.runLoginStep('example-shop', step)).toBe('window open')
    expect(step).toHaveBeenCalledTimes(1)
    // The first slot is free; a second step right after waits the site's full gap.
    expect(await host.runLoginStep('example-shop', async () => 'again')).toBe('again')
    expect(clock.paced).toEqual([1_000])
  })

  it('refuses an unknown adapter, or one whose exact hash is not approved, without running the step', async () => {
    const { host } = fixture(trivial, { approvals: { isApproved: async () => false } })
    const step = vi.fn(async () => 'x')
    expect(await errorOf(host.runLoginStep('example-shop', step))).toMatchObject({
      stage: 'manifest',
      errorClass: 'not-granted',
    })
    expect(await errorOf(host.runLoginStep('nobody', step))).toMatchObject({
      stage: 'manifest',
      errorClass: 'not-granted',
    })
    expect(step).not.toHaveBeenCalled()
  })

  it('treats an approval lookup that fails as not approved', async () => {
    const { host } = fixture(trivial, {
      approvals: { isApproved: () => Promise.reject(new Error('EIO')) },
    })
    expect(await errorOf(host.runLoginStep('example-shop', async () => 'x'))).toMatchObject({
      errorClass: 'not-granted',
    })
  })

  it('waits behind a running call, and a call that arrives later waits behind the step', async () => {
    const events: string[] = []
    const { definition, release } = gatedTool(events)
    const { host } = fixture(definition)

    const first = host.call({ ...call, input: { id: 'a' } })
    await flush()
    const step = host.runLoginStep('example-shop', async () => {
      events.push('step:start')
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      events.push('step:end')
      return 'done'
    })
    await flush()
    const second = host.call({ ...call, callId: 'call-2', input: { id: 'b' } })
    await flush()
    expect(events).toEqual(['a:start'])

    release()
    expect(await first).toEqual({ status: 'ok', output: 'a' })
    expect(await step).toBe('done')
    await flush()
    expect(events).toEqual(['a:start', 'a:end', 'step:start', 'step:end', 'b:start'])
    release()
    expect(await second).toEqual({ status: 'ok', output: 'b' })
  })

  it('does not run on another adapter’s lock', async () => {
    const events: string[] = []
    const { definition, release } = gatedTool(events)
    const { host } = fixture(definition, { approvals: { isApproved: async () => true } })
    host.register({
      definition: defineAdapter({
        manifest: { ...manifest, id: 'other-shop', home: 'https://www.other.example/' },
        tools: trivial.tools,
      }),
      bundleHash: HASH,
      driver: new FakeSessionDriver(),
    })
    const running = host.call({ ...call, input: { id: 'a' } })
    await flush()
    expect(await host.runLoginStep('other-shop', async () => 'other')).toBe('other')
    release()
    await running
  })

  it('gives up waiting after waitMs, without running the step, and keeps the queue in order', async () => {
    const events: string[] = []
    const { definition, release } = gatedTool(events)
    const { host, clock } = fixture(definition)
    const running = host.call({ ...call, input: { id: 'a' } })
    await flush()
    const step = vi.fn(async () => 'x')
    const waiting = host.runLoginStep('example-shop', step, { waitMs: 5_000 })
    await flush()
    const queued = host.call({ ...call, callId: 'call-2', input: { id: 'b' } })
    await flush()
    await clock.advance(5_000)
    expect(await errorOf(waiting)).toMatchObject({ stage: 'login', errorClass: 'timed-out' })
    expect(step).not.toHaveBeenCalled()

    release()
    await running
    await flush()
    // The step that gave up handed its turn straight on.
    expect(events).toEqual(['a:start', 'a:end', 'b:start'])
    release()
    expect(await queued).toEqual({ status: 'ok', output: 'b' })
  })

  it('waits 30 seconds for the lock by default', async () => {
    expect(DEFAULT_LOGIN_STEP_WAIT_MS).toBe(30_000)
    const events: string[] = []
    const { definition, release } = gatedTool(events)
    const { host, clock } = fixture(definition)
    const running = host.call({ ...call, input: { id: 'a' } })
    await flush()
    const waiting = host.runLoginStep('example-shop', async () => 'x')
    let settled = false
    void waiting
      .catch(() => {})
      .finally(() => {
        settled = true
      })
    await flush()
    await clock.advance(29_999)
    expect(settled).toBe(false)
    await clock.advance(1)
    expect(await errorOf(waiting)).toMatchObject({ errorClass: 'timed-out' })
    release()
    await running
  })

  it('gives up the wait when its signal aborts', async () => {
    const events: string[] = []
    const { definition, release } = gatedTool(events)
    const { host } = fixture(definition)
    const running = host.call({ ...call, input: { id: 'a' } })
    await flush()
    const controller = new AbortController()
    const step = vi.fn(async () => 'x')
    const waiting = host.runLoginStep('example-shop', step, { signal: controller.signal })
    await flush()
    controller.abort()
    expect(await errorOf(waiting)).toMatchObject({ stage: 'login', errorClass: 'aborted' })
    release()
    await running
    expect(step).not.toHaveBeenCalled()
  })

  it('refuses an already-aborted signal before waiting', async () => {
    const { host } = fixture(trivial)
    const step = vi.fn(async () => 'x')
    expect(
      await errorOf(host.runLoginStep('example-shop', step, { signal: AbortSignal.abort() })),
    ).toMatchObject({
      errorClass: 'aborted',
    })
    expect(step).not.toHaveBeenCalled()
  })

  it('does not run a step whose approval was revoked while it waited', async () => {
    let approved = true
    const events: string[] = []
    const { definition, release } = gatedTool(events)
    const { host } = fixture(definition, { approvals: { isApproved: async () => approved } })
    const running = host.call({ ...call, input: { id: 'a' } })
    await flush()
    const step = vi.fn(async () => 'x')
    const waiting = host.runLoginStep('example-shop', step)
    await flush()
    approved = false
    release()
    await running
    expect(await errorOf(waiting)).toMatchObject({ stage: 'manifest', errorClass: 'not-granted' })
    expect(step).not.toHaveBeenCalled()
    // The lock was given back.
    approved = true
    expect(await host.runLoginStep('example-shop', async () => 'later')).toBe('later')
  })

  it('refuses while the site’s breaker is open, after a tool call was blocked', async () => {
    const { host, page } = fixture(
      defineAdapter({
        manifest,
        tools: {
          run_test: tool({
            input: z.object({}),
            output: z.unknown(),
            run: async (ctx) => (await ctx.page.fetch('/api/trolley')).body,
          }),
        },
      }),
    )
    page.route('GET', `${HOME}/api/trolley`, akamaiDenied)
    expect((await host.call(call)).status).toBe('blocked')
    const step = vi.fn(async () => 'x')
    expect(await errorOf(host.runLoginStep('example-shop', step))).toMatchObject({
      stage: 'login',
      errorClass: 'rate-limited',
    })
    expect(step).not.toHaveBeenCalled()
  })

  it('refuses while a breaker persisted by an earlier run of the app is open', async () => {
    const breakerStore = new MemoryJsonStore()
    const { host, clock } = fixture(trivial, { breakerStore })
    breakerStore.text = serialiseBreakerFile(
      new Map([['www.example.com', { retryAt: clock.now() + 60_000, cooldownMs: 60_000 }]]),
    )
    expect(await errorOf(host.runLoginStep('example-shop', async () => 'x'))).toMatchObject({
      errorClass: 'rate-limited',
    })
  })

  it('refuses when the breaker opened while it waited for its rate-budget slot', async () => {
    let first: { reportBlocked(cause: 'blocked-by-site'): void } | undefined
    // While the second step waits for its slot, a step on another adapter for the same host is blocked.
    const pacingSleep = async (): Promise<void> => first?.reportBlocked('blocked-by-site')
    const { host } = fixture(trivial, { approvals: { isApproved: async () => true }, pacingSleep })
    host.register({
      definition: defineAdapter({ manifest: { ...manifest, id: 'same-host' }, tools: trivial.tools }),
      bundleHash: HASH,
      driver: new FakeSessionDriver(),
    })
    const step = vi.fn(async () => 'never')
    const inner = await host.runLoginStep('example-shop', async (ctx) => {
      first = ctx
      return errorOf(host.runLoginStep('same-host', step))
    })
    expect(inner).toMatchObject({ stage: 'login', errorClass: 'rate-limited' })
    expect(step).not.toHaveBeenCalled()
  })

  it('paces each further request through ctx.pace(), and refuses once the step reported a block', async () => {
    const { host, clock, audit } = fixture(trivial)
    const seen: string[] = []
    const result = host.runLoginStep('example-shop', async (ctx) => {
      seen.push('first')
      await ctx.pace()
      seen.push('second')
      ctx.reportBlocked('blocked-by-site')
      return ctx.pace()
    })
    expect(await errorOf(result)).toMatchObject({ stage: 'login', errorClass: 'rate-limited' })
    expect(seen).toEqual(['first', 'second'])
    expect(clock.paced).toEqual([1_000])
    await flush()
    expect(audit.events).toContainEqual(
      expect.objectContaining({
        type: 'breaker-opened',
        host: 'www.example.com',
        cause: 'blocked-by-site',
        callId: null,
      }),
    )
  })

  it('opens the breaker for a 429 the step reports as rate-limited, and tool calls then fail fast', async () => {
    const { host, audit } = fixture(trivial)
    await host.runLoginStep('example-shop', async (ctx) => ctx.reportBlocked('rate-limited'))
    await flush()
    expect(audit.events).toContainEqual(
      expect.objectContaining({ type: 'breaker-opened', cause: 'rate-limited' }),
    )
    expect(await host.call(call)).toEqual({ status: 'blocked', retryAfterMs: 60_000 })
  })

  it('treats a reported cause it does not know as blocked-by-site', async () => {
    const { host, audit } = fixture(trivial)
    await host.runLoginStep('example-shop', async (ctx) =>
      ctx.reportBlocked('teapot' as 'rate-limited' | 'blocked-by-site'),
    )
    await flush()
    expect(audit.events).toContainEqual(
      expect.objectContaining({ type: 'breaker-opened', cause: 'blocked-by-site' }),
    )
  })

  it('passes what the step throws on unchanged, and frees the lock', async () => {
    const { host } = fixture(trivial)
    const thrown = new Error('the app’s own failure')
    await expect(
      host.runLoginStep('example-shop', async () => {
        throw thrown
      }),
    ).rejects.toBe(thrown)
    expect(await host.call(call)).toEqual({ status: 'ok', output: 'ran' })
  })

  it('times a step out, aborts its signal, and holds the lock until it settles', async () => {
    const { host, clock } = fixture(trivial, { settleTimeoutMs: 60_000 })
    let finish: () => void = () => {}
    let signal: AbortSignal | undefined
    const step = host.runLoginStep(
      'example-shop',
      (ctx) => {
        signal = ctx.signal
        return new Promise<void>((resolve) => {
          finish = resolve
        })
      },
      { timeoutMs: 1_000 },
    )
    await flush()
    await clock.advance(1_000)
    expect(await errorOf(step)).toMatchObject({ stage: 'login', errorClass: 'timed-out' })
    expect(signal?.aborted).toBe(true)

    let ran = false
    const next = host.call(call).then((result) => {
      ran = true
      return result
    })
    await flush()
    expect(ran).toBe(false)
    finish()
    expect(await next).toEqual({ status: 'ok', output: 'ran' })
  })

  it('gives the lock back after the settle bound even if a timed-out step never settles', async () => {
    const { host, clock } = fixture(trivial, { settleTimeoutMs: 5_000 })
    const step = host.runLoginStep('example-shop', () => new Promise<never>(() => {}), { timeoutMs: 1_000 })
    await flush()
    await clock.advance(1_000)
    expect(await errorOf(step)).toMatchObject({ errorClass: 'timed-out' })
    const next = host.call(call)
    await flush()
    await clock.advance(5_000)
    expect(await next).toEqual({ status: 'ok', output: 'ran' })
  })

  it('uses the tool timeout for the step by default', async () => {
    const { host, clock } = fixture(trivial, { timeoutMs: 7_000 })
    const step = host.runLoginStep('example-shop', () => new Promise<never>(() => {}))
    let settled = false
    void step
      .catch(() => {})
      .finally(() => {
        settled = true
      })
    await flush()
    await clock.advance(6_999)
    expect(settled).toBe(false)
    await clock.advance(1)
    expect(await errorOf(step)).toMatchObject({ errorClass: 'timed-out' })
  })

  it('refuses a waitMs or timeoutMs that is not a finite number above zero, before taking the lock', async () => {
    const events: string[] = []
    const { definition, release } = gatedTool(events)
    const { host } = fixture(definition)
    const step = vi.fn(async () => 'x')
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 0, '5000']) {
      for (const options of [{ waitMs: bad }, { timeoutMs: bad }]) {
        expect([options, await errorOf(host.runLoginStep('example-shop', step, options as never))]).toEqual([
          options,
          expect.objectContaining({ stage: 'config', errorClass: 'invalid' }),
        ])
      }
    }
    // Checked before the adapter is looked up, so a typo is not hidden behind not-granted.
    expect(await errorOf(host.runLoginStep('nobody', step, { waitMs: Number.NaN }))).toMatchObject({
      stage: 'config',
    })
    expect(step).not.toHaveBeenCalled()
    // Nothing took the lock: a call runs straight away.
    const running = host.call({ ...call, input: { id: 'a' } })
    await flush()
    expect(events).toEqual(['a:start'])
    release()
    expect(await running).toEqual({ status: 'ok', output: 'a' })
  })

  it('stops waiting for the step when its caller aborts, and aborts the step’s signal', async () => {
    const { host } = fixture(trivial, { settleTimeoutMs: 0 })
    const controller = new AbortController()
    let signal: AbortSignal | undefined
    const step = host.runLoginStep(
      'example-shop',
      (ctx) => {
        signal = ctx.signal
        return new Promise<never>(() => {})
      },
      { signal: controller.signal },
    )
    await flush()
    controller.abort()
    expect(await errorOf(step)).toMatchObject({ stage: 'login', errorClass: 'aborted' })
    expect(signal?.aborted).toBe(true)
  })

  it('refuses ctx.pace() once the step has returned', async () => {
    const { host } = fixture(trivial)
    let late: (() => Promise<void>) | undefined
    await host.runLoginStep('example-shop', async (ctx) => {
      late = ctx.pace
    })
    expect(await errorOf(late?.() ?? Promise.resolve())).toMatchObject({
      stage: 'login',
      errorClass: 'aborted',
    })
  })

  it('cuts short a wait for a rate-budget slot when the caller aborts or the step’s deadline passes', async () => {
    // A slot that only comes when the wait is aborted.
    const pacingSleep = (_ms: number, signal?: AbortSignal) =>
      new Promise<void>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    const { host, clock } = fixture(trivial, { pacingSleep, timeoutMs: 1_000 })
    await host.runLoginStep('example-shop', async () => 'takes the free slot')

    const controller = new AbortController()
    const step = vi.fn(async () => 'never')
    const waiting = host.runLoginStep('example-shop', step, { signal: controller.signal })
    await flush()
    controller.abort()
    expect(await errorOf(waiting)).toMatchObject({ stage: 'login', errorClass: 'aborted' })
    expect(step).not.toHaveBeenCalled()

    // Inside a step: its deadline passes while ctx.pace() waits, and the pace is refused.
    const fresh = fixture(trivial, { pacingSleep, timeoutMs: 1_000 })
    let pacing: Promise<void> | undefined
    const inStep = fresh.host.runLoginStep('example-shop', async (ctx) => {
      pacing = ctx.pace()
      await pacing.catch(() => {})
    })
    await flush()
    await fresh.clock.advance(1_000)
    expect(await errorOf(inStep)).toMatchObject({ stage: 'login', errorClass: 'timed-out' })
    expect(await errorOf(pacing ?? Promise.resolve())).toMatchObject({
      stage: 'login',
      errorClass: 'aborted',
    })
    void clock
  })
})
