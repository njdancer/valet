// The bounded wait for an adapter's lock: a call queued behind earlier ones ends `busy` after the
// queue wait, or at once when too many are in front to get a turn in that time. Either way it has
// sent nothing, and says how many calls were ahead and when to try again.

import { defineAdapter, tool } from '@valet/core'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { DEFAULT_QUEUE_WAIT_MS, MAX_BUSY_RETRY_MS, MIN_BUSY_RETRY_MS, ToolHost } from '../src/tool-host'
import { FakePrompt, flush, MemoryAudit, MemoryJsonStore, MemoryMarkers } from './fakes'
import { call, fixture, manifest } from './fixtures'

function gated(minGapMs = manifest.limits.minGapMs) {
  const events: string[] = []
  const gates: (() => void)[] = []
  const definition = defineAdapter({
    manifest: { ...manifest, limits: { ...manifest.limits, minGapMs } },
    tools: {
      run_test: tool({
        input: z.object({ id: z.string() }),
        output: z.string(),
        run: async (_ctx, input) => {
          events.push(`${input.id}:start`)
          if (input.id !== 'quick') await new Promise<void>((resolve) => gates.push(resolve))
          events.push(`${input.id}:end`)
          return input.id
        },
      }),
    },
  })
  return { definition, events, release: () => gates.shift()?.() }
}

const input = (id: string) => ({ ...call, callId: id, input: { id } })

describe('ToolHost.call: the wait for the adapter’s lock', () => {
  it('ends a call busy once it has waited the queue wait, and never starts it', async () => {
    const { definition, events, release } = gated()
    const { host, clock, audit, driver } = fixture(definition)
    const first = host.call(input('a'))
    await flush()
    const second = host.call(input('b'))
    await flush()

    await clock.advance(DEFAULT_QUEUE_WAIT_MS - 1)
    let settled = false
    void second.then(() => {
      settled = true
    })
    await flush()
    expect(settled).toBe(false)

    await clock.advance(1)
    expect(await second).toEqual({ status: 'busy', retryAfterMs: MIN_BUSY_RETRY_MS, ahead: 1 })
    expect(events).toEqual(['a:start'])
    expect(driver.runEvents).toEqual(['begin'])
    expect(audit.events.filter((e) => e.type === 'tool-finished')).toEqual([
      expect.objectContaining({ callId: 'b', outcome: 'failed', stage: 'tool-run', errorClass: 'busy' }),
    ])

    release()
    expect(await first).toEqual({ status: 'ok', output: 'a' })
  })

  it('takes the bound from queueWaitMs', async () => {
    const { definition, release } = gated()
    const { host, clock } = fixture(definition, { queueWaitMs: 2_000 })
    const first = host.call(input('a'))
    await flush()
    const second = host.call(input('b'))
    await flush()
    await clock.advance(2_000)
    expect(await second).toMatchObject({ status: 'busy' })
    release()
    await first
  })

  it('runs a queued call that gets its turn within the wait, and leaves no timer behind', async () => {
    const { definition, events, release } = gated()
    const { host, clock } = fixture(definition)
    const first = host.call(input('a'))
    await flush()
    const second = host.call(input('quick'))
    await flush()
    await clock.advance(DEFAULT_QUEUE_WAIT_MS - 1)
    release()
    expect(await first).toEqual({ status: 'ok', output: 'a' })
    expect(await second).toEqual({ status: 'ok', output: 'quick' })
    expect(events).toEqual(['a:start', 'a:end', 'quick:start', 'quick:end'])
    expect(clock.pendingTimers()).toBe(0)
  })

  it('refuses at once a call with too many in front to get a turn within the wait', async () => {
    // Woolworths' numbers: 10 s between requests, so three calls in front fill the 30 s wait.
    const { definition, events, release } = gated(10_000)
    const { host, clock, audit } = fixture(definition)
    const first = host.call(input('a'))
    await flush()
    const second = host.call(input('b'))
    await flush()
    await clock.advance(10_000)
    const third = host.call(input('c'))
    await flush()

    expect(await host.call(input('d'))).toEqual({ status: 'busy', retryAfterMs: 30_000, ahead: 3 })
    expect(audit.events.at(-1)).toMatchObject({ callId: 'd', errorClass: 'busy', durationMs: 0 })

    // Those that joined still wait their own 30 s, and count only who is still in front.
    await clock.advance(DEFAULT_QUEUE_WAIT_MS - 10_000)
    expect(await second).toEqual({ status: 'busy', retryAfterMs: 10_000, ahead: 1 })
    await clock.advance(10_000)
    expect(await third).toEqual({ status: 'busy', retryAfterMs: 10_000, ahead: 1 })
    expect(events).toEqual(['a:start'])
    release()
    await first
  })

  it('does not count a refused call as in front of the next', async () => {
    const { definition, release } = gated(10_000)
    const { host } = fixture(definition)
    const running = [host.call(input('a')), host.call(input('b')), host.call(input('c'))]
    await flush()
    expect(await host.call(input('d'))).toMatchObject({ status: 'busy', ahead: 3 })
    expect(await host.call(input('e'))).toMatchObject({ status: 'busy', ahead: 3 })
    release()
    release()
    release()
    await flush()
    release()
    await flush()
    release()
    expect(await Promise.all(running)).toEqual([
      { status: 'ok', output: 'a' },
      { status: 'ok', output: 'b' },
      { status: 'ok', output: 'c' },
    ])
    expect(await host.call(input('quick'))).toEqual({ status: 'ok', output: 'quick' })
  })

  it('keeps the time to try again within its bounds', async () => {
    const { definition, release } = gated(45_000)
    const { host } = fixture(definition, { queueWaitMs: 200_000 })
    const running = ['a', 'b', 'c', 'd', 'e'].map((id) => host.call(input(id)))
    await flush()
    expect(await host.call(input('f'))).toEqual({
      status: 'busy',
      retryAfterMs: MAX_BUSY_RETRY_MS,
      ahead: 5,
    })
    for (const _ of running) {
      release()
      await flush()
    }
    await Promise.all(running)
  })

  it('lets a call that arrives after others gave up run next, in order', async () => {
    const { definition, events, release } = gated()
    const { host, clock } = fixture(definition)
    const first = host.call(input('a'))
    await flush()
    const second = host.call(input('b'))
    await flush()
    await clock.advance(DEFAULT_QUEUE_WAIT_MS)
    expect(await second).toMatchObject({ status: 'busy' })

    const third = host.call(input('quick'))
    await flush()
    release()
    expect(await first).toEqual({ status: 'ok', output: 'a' })
    expect(await third).toEqual({ status: 'ok', output: 'quick' })
    expect(events).toEqual(['a:start', 'a:end', 'quick:start', 'quick:end'])
  })

  it('counts a login step holding the lock as a call in front', async () => {
    const { definition, events } = gated()
    const { host, clock } = fixture(definition)
    let finish: () => void = () => {}
    const step = host.runLoginStep(
      'example-shop',
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    await flush()
    const queued = host.call(input('quick'))
    await flush()
    await clock.advance(DEFAULT_QUEUE_WAIT_MS)
    expect(await queued).toMatchObject({ status: 'busy', ahead: 1 })
    expect(events).toEqual([])
    finish()
    await step
  })

  it('still ends an aborted wait as aborted, not busy', async () => {
    const { definition, release } = gated()
    const { host } = fixture(definition)
    const first = host.call(input('a'))
    await flush()
    const controller = new AbortController()
    const second = host.call({ ...input('b'), signal: controller.signal })
    await flush()
    controller.abort()
    expect(await second).toEqual({ status: 'failed', stage: 'tool-run', errorClass: 'aborted' })
    release()
    await first
  })

  it.each([0, -1, Number.POSITIVE_INFINITY, Number.NaN])('refuses a queue wait of %s', (queueWaitMs) => {
    expect(
      () =>
        new ToolHost({
          approvals: { isApproved: async () => true },
          audit: new MemoryAudit(),
          prompt: new FakePrompt(),
          authRunner: async () => ({ status: 'ok' }),
          markers: new MemoryMarkers(),
          breakerStore: new MemoryJsonStore(),
          queueWaitMs,
        }),
    ).toThrow('config: invalid')
  })
})
