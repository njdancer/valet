// ToolCallRequest.signal (the MCP client cancelling or going away) and .transport (how it reached
// the endpoint, a label passed on to the confirmation prompt).

import { defineAdapter, tool } from '@siteadapter/core'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { flush } from './fakes'
import { call, fixture, manifest } from './fixtures'

function gated(sideEffect: 'read' | 'irreversible' = 'read') {
  const events: string[] = []
  const gates: (() => void)[] = []
  let signal: AbortSignal | undefined
  const definition = defineAdapter({
    manifest: {
      ...manifest,
      tools: [{ name: 'run_test', title: 'Run test', description: 'The tool under test', sideEffect }],
    },
    tools: {
      run_test: tool({
        input: z.object({ id: z.string() }),
        output: z.string(),
        run: async (ctx, input) => {
          signal = ctx.signal
          events.push(`${input.id}:start`)
          if (input.id !== 'quick') await new Promise<void>((resolve) => gates.push(resolve))
          events.push(`${input.id}:end`)
          return input.id
        },
      }),
    },
  })
  return { definition, events, release: () => gates.shift()?.(), signal: () => signal }
}

const aborted = { status: 'failed', stage: 'tool-run', errorClass: 'aborted' }

describe('ToolHost.call: the caller’s signal', () => {
  it('runs as before when the signal never aborts', async () => {
    const { definition } = gated()
    const { host } = fixture(definition)
    const controller = new AbortController()
    expect(await host.call({ ...call, input: { id: 'quick' }, signal: controller.signal })).toEqual({
      status: 'ok',
      output: 'quick',
    })
  })

  it('does nothing for a call whose signal has already aborted, but records it', async () => {
    const { definition, events } = gated()
    const { host, audit, driver } = fixture(definition)
    expect(await host.call({ ...call, input: { id: 'quick' }, signal: AbortSignal.abort() })).toEqual(aborted)
    expect(events).toEqual([])
    expect(driver.runEvents).toEqual([])
    expect(audit.types()).toEqual(['tool-called', 'tool-finished'])
    expect(audit.events[1]).toMatchObject({ outcome: 'failed', stage: 'tool-run', errorClass: 'aborted' })
  })

  it('leaves the queue when it aborts while waiting for the lock, and the queue keeps its order', async () => {
    const { definition, events, release } = gated()
    const { host } = fixture(definition)
    const first = host.call({ ...call, input: { id: 'a' } })
    await flush()
    const controller = new AbortController()
    const leaving = host.call({ ...call, callId: 'call-2', input: { id: 'b' }, signal: controller.signal })
    await flush()
    const third = host.call({ ...call, callId: 'call-3', input: { id: 'c' } })
    await flush()
    controller.abort()
    expect(await leaving).toEqual(aborted)

    release()
    expect(await first).toEqual({ status: 'ok', output: 'a' })
    await flush()
    release()
    expect(await third).toEqual({ status: 'ok', output: 'c' })
    expect(events).toEqual(['a:start', 'a:end', 'c:start', 'c:end'])
  })

  it('aborts the tool’s own signal while it runs and ends the run', async () => {
    const { definition, events, release, signal } = gated()
    const { host, driver } = fixture(definition)
    const controller = new AbortController()
    const running = host.call({ ...call, input: { id: 'a' }, signal: controller.signal })
    await flush()
    controller.abort()
    expect(await running).toEqual(aborted)
    expect(signal()?.aborted).toBe(true)
    expect(driver.runEvents).toEqual(['begin', 'end'])

    // The tool's own promise is not runtime work, so the next call may go once the run ended.
    const next = host.call({ ...call, callId: 'call-2', input: { id: 'quick' } })
    expect(await next).toEqual({ status: 'ok', output: 'quick' })
    release()
    expect(events).toContain('quick:end')
  })

  it('stops a login the call started, through the auth runner’s signal', async () => {
    let authSignal: AbortSignal | undefined
    const { host, page, authRunner } = fixture(
      defineAdapter({
        manifest,
        tools: {
          run_test: tool({
            input: z.object({}),
            output: z.unknown(),
            run: async (ctx) => ctx.session.ensure(),
          }),
        },
      }),
    )
    page.route('GET', 'https://www.example.com/api/session', {
      status: 200,
      contentType: 'application/json',
      body: { shopper: { loggedIn: false } },
    })
    authRunner.mockImplementation(
      (request) =>
        new Promise((_resolve, reject) => {
          authSignal = request.signal
          request.signal.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    )
    const controller = new AbortController()
    const running = host.call({ ...call, signal: controller.signal })
    await vi.waitFor(() => expect(authSignal).toBeDefined())
    controller.abort()
    expect(await running).toEqual(aborted)
    expect(authSignal?.aborted).toBe(true)
  })

  it('counts an abort during the confirmation as declined, and runs nothing even after a yes', async () => {
    const { definition, events } = gated('irreversible')
    const { host, prompt, audit } = fixture(definition)
    prompt.answer = 'hang'
    const controller = new AbortController()
    const asking = host.call({ ...call, input: { id: 'quick' }, signal: controller.signal })
    await flush()
    expect(prompt.signals[0]?.aborted).toBe(false)
    controller.abort()
    expect(await asking).toEqual(aborted)
    expect(prompt.signals[0]?.aborted).toBe(true)
    expect(audit.events.find((e) => e.type === 'confirmation')).toMatchObject({ answer: 'declined' })
    expect(events).toEqual([])
  })

  it('does not run an approved irreversible tool whose caller aborted while the person answered', async () => {
    const { definition, events } = gated('irreversible')
    const controller = new AbortController()
    const { host, prompt, driver } = fixture(definition)
    prompt.ask = async () => {
      controller.abort()
      return 'approved'
    }
    expect(await host.call({ ...call, input: { id: 'quick' }, signal: controller.signal })).toEqual(aborted)
    expect(events).toEqual([])
    expect(driver.runEvents).toEqual([])
  })

  it('declines a ctx.confirm() whose call is aborted while the person is asked', async () => {
    let answered: boolean | undefined
    const { host, prompt } = fixture(
      defineAdapter({
        manifest,
        tools: {
          run_test: tool({
            input: z.object({}),
            output: z.unknown(),
            run: async (ctx) => {
              answered = await ctx.confirm('Proceed?')
              return answered
            },
          }),
        },
      }),
    )
    prompt.answer = 'hang'
    const controller = new AbortController()
    const running = host.call({ ...call, signal: controller.signal })
    await flush()
    controller.abort()
    expect(await running).toEqual(aborted)
    await flush()
    expect(answered).toBe(false)
  })

  it('ignores a signal that is not an AbortSignal', async () => {
    const { definition } = gated()
    const { host } = fixture(definition)
    const fake = { aborted: true, addEventListener: () => {} } as unknown as AbortSignal
    expect(await host.call({ ...call, input: { id: 'quick' }, signal: fake })).toEqual({
      status: 'ok',
      output: 'quick',
    })
  })
})

describe('ToolHost.call: the client’s transport', () => {
  it('passes the transport to the confirmation prompt', async () => {
    for (const transport of ['stdio-bridge', 'http'] as const) {
      const { definition } = gated('irreversible')
      const { host, prompt } = fixture(definition)
      await host.call({ ...call, input: { id: 'quick' }, transport })
      expect(prompt.requests[0]).toMatchObject({ client: 'claude-code', transport })
    }
  })

  it('passes it on for ctx.confirm() too', async () => {
    const { host, prompt } = fixture(
      defineAdapter({
        manifest,
        tools: {
          run_test: tool({ input: z.object({}), output: z.boolean(), run: (ctx) => ctx.confirm('Sure?') }),
        },
      }),
    )
    await host.call({ ...call, transport: 'stdio-bridge' })
    expect(prompt.requests[0]).toMatchObject({ kind: 'tool-request', transport: 'stdio-bridge' })
  })

  it('leaves it out when the call has none, or names one the runtime does not know', async () => {
    for (const transport of [undefined, 'carrier-pigeon', 7]) {
      const { definition } = gated('irreversible')
      const { host, prompt } = fixture(definition)
      await host.call({ ...call, input: { id: 'quick' }, transport: transport as 'http' | undefined })
      expect(Object.hasOwn(prompt.requests[0] ?? {}, 'transport')).toBe(false)
    }
  })

  it('changes nothing about what runs: a bridge call is asked the same question and audited the same', async () => {
    const answers: unknown[] = []
    for (const transport of ['stdio-bridge', 'http'] as const) {
      const { definition } = gated('irreversible')
      const { host, prompt, audit } = fixture(definition)
      prompt.answer = 'declined'
      const result = await host.call({ ...call, input: { id: 'quick' }, transport })
      answers.push([result, audit.events])
    }
    expect(answers[0]).toEqual(answers[1])
  })
})
