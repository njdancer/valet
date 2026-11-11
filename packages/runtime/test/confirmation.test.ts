// Irreversible tools need the person's yes before any of their code runs; ctx.confirm() asks the
// person too. Neither can be answered by the MCP client.

import { type ConfirmAction, defineAdapter, tool } from '@valet/core'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { flush, json } from './fakes'
import { call, fixture, HOME, manifest } from './fixtures'

const placeOrder = vi.fn(
  async (ctx: { page: { fetch: (path: string, init: object) => Promise<{ status: number }> } }) => {
    const response = await ctx.page.fetch('/api/checkout/place', { method: 'POST', json: { confirm: true } })
    return { placed: response.status === 200 }
  },
)

const irreversible = defineAdapter({
  manifest: {
    ...manifest,
    tools: [
      {
        name: 'run_test',
        title: 'Place order',
        description: 'Places the order in the trolley and pays with the saved card.',
        sideEffect: 'irreversible',
        unlocks: [{ method: 'POST', path: '/api/checkout/place' }],
      },
    ],
  },
  tools: {
    run_test: tool({
      input: z.object({ deliveryWindow: z.string() }),
      output: z.object({ placed: z.boolean() }),
      run: (ctx) => placeOrder(ctx),
    }),
  },
})

const order = { ...call, input: { deliveryWindow: 'Sat 9-10' } }

describe('irreversible tools', () => {
  it('asks the person before running, showing the tool’s validated input', async () => {
    placeOrder.mockClear()
    const { host, prompt, page } = fixture(irreversible)
    page.route('POST', `${HOME}/api/checkout/place`, json({ ok: true }))

    expect(await host.call(order)).toEqual({ status: 'ok', output: { placed: true } })
    expect(prompt.requests).toEqual([
      {
        adapterId: 'example-shop',
        adapterName: 'Example Shop',
        tool: 'run_test',
        toolTitle: 'Place order',
        callId: 'call-1',
        client: 'claude-code',
        kind: 'irreversible-tool',
        input: { deliveryWindow: 'Sat 9-10' },
      },
    ])
    expect(page.toolFetches()).toEqual([`${HOME}/api/checkout/place`])
  })

  it('audits the approval before the tool runs', async () => {
    const { host, audit, page } = fixture(irreversible)
    page.route('POST', `${HOME}/api/checkout/place`, json({ ok: true }))
    await host.call(order)

    expect(audit.types()).toEqual(['tool-called', 'confirmation', 'tool-finished'])
    expect(audit.events[1]).toEqual({
      type: 'confirmation',
      adapterId: 'example-shop',
      tool: 'run_test',
      client: 'claude-code',
      callId: 'call-1',
      answer: 'approved',
    })
  })

  it('unlocks the driver’s irreversible declarations only after the approval, within the run', async () => {
    const { host, page, driver, prompt } = fixture(irreversible)
    page.route('POST', `${HOME}/api/checkout/place`, json({ ok: true }))
    let whileAsking: string[] = []
    prompt.ask = async () => {
      whileAsking = [...driver.runEvents]
      return 'approved'
    }
    await host.call(order)

    // Nothing is running, let alone unlocked, while the person is still deciding.
    expect(whileAsking).toEqual([])
    expect(driver.runEvents).toEqual(['begin', 'unlock', 'end'])
    expect(driver.policies[0]?.maxPurpose).toBe('irreversible')
  })

  it('never unlocks for a declined call, or for a tool that is not irreversible', async () => {
    const declined = fixture(irreversible)
    declined.prompt.answer = 'declined'
    await declined.host.call(order)
    expect(declined.driver.runEvents).toEqual([])

    const write = fixture(
      defineAdapter({
        manifest: { ...manifest, tools: [{ ...manifest.tools[0]!, sideEffect: 'write' }] },
        tools: {
          run_test: tool({
            input: z.object({}),
            output: z.boolean(),
            run: (ctx) => ctx.confirm({ requests: [{ method: 'POST', path: '/api/trolley/update' }] }),
          }),
        },
      }),
    )
    expect(await write.host.call(call)).toEqual({ status: 'ok', output: true })
    expect(write.driver.runEvents).toEqual(['begin', 'end'])
  })

  it('does not run when the person declines', async () => {
    placeOrder.mockClear()
    const { host, prompt, page, audit, driver } = fixture(irreversible)
    prompt.answer = 'declined'

    expect(await host.call(order)).toEqual({ status: 'declined' })
    expect(placeOrder).not.toHaveBeenCalled()
    expect(driver.toolPageCalls).toBe(0)
    expect(page.fetches).toEqual([])
    expect(audit.events).toContainEqual(expect.objectContaining({ type: 'confirmation', answer: 'declined' }))
    expect(audit.events.at(-1)).toEqual({
      type: 'tool-finished',
      adapterId: 'example-shop',
      callId: 'call-1',
      outcome: 'declined',
      durationMs: 0,
    })
  })

  it('does not run when the prompt times out', async () => {
    placeOrder.mockClear()
    const { host, prompt, audit } = fixture(irreversible)
    prompt.answer = 'timed-out'

    expect(await host.call(order)).toEqual({ status: 'declined', timedOut: true })
    expect(placeOrder).not.toHaveBeenCalled()
    expect(audit.events).toContainEqual(
      expect.objectContaining({ type: 'confirmation', answer: 'timed-out' }),
    )
  })

  it('treats a prompt that fails as a decline', async () => {
    placeOrder.mockClear()
    const { host, prompt, audit } = fixture(irreversible)
    prompt.answer = 'throw'

    expect(await host.call(order)).toEqual({ status: 'declined' })
    expect(placeOrder).not.toHaveBeenCalled()
    expect(audit.events).toContainEqual(expect.objectContaining({ type: 'confirmation', answer: 'declined' }))
  })

  it('treats anything but an explicit approval as a decline', async () => {
    placeOrder.mockClear()
    const { host, prompt } = fixture(irreversible)
    prompt.answer = 'yes' as never

    expect(await host.call(order)).toEqual({ status: 'declined' })
    expect(placeOrder).not.toHaveBeenCalled()
  })

  it('treats a prompt that never answers as timed out, aborts it, and frees the lock', async () => {
    placeOrder.mockClear()
    const { host, prompt, audit, clock } = fixture(irreversible, { confirmationTimeoutMs: 60_000 })
    prompt.answer = 'hang'

    const asking = host.call(order)
    await flush()
    await clock.advance(60_000)

    expect(await asking).toEqual({ status: 'declined', timedOut: true })
    expect(prompt.signals[0]?.aborted).toBe(true)
    expect(placeOrder).not.toHaveBeenCalled()
    expect(audit.events).toContainEqual(
      expect.objectContaining({ type: 'confirmation', answer: 'timed-out' }),
    )

    prompt.answer = 'declined'
    expect(await host.call({ ...order, callId: 'call-2' })).toEqual({ status: 'declined' })
  })

  it('gives the person two minutes by default, then declines (D19)', async () => {
    const { host, prompt, clock } = fixture(irreversible)
    prompt.answer = 'hang'

    const asking = host.call(order)
    await flush()
    await clock.advance(2 * 60_000 - 1)
    expect(prompt.signals[0]?.aborted).toBe(false)
    await clock.advance(1)
    expect(await asking).toEqual({ status: 'declined', timedOut: true })
  })

  it('does not run when the approval cannot be audited', async () => {
    placeOrder.mockClear()
    const { host, audit } = fixture(irreversible)
    audit.failNext = 'confirmation'

    expect(await host.call(order)).toEqual({ status: 'failed', stage: 'tool-run', errorClass: 'internal' })
    expect(placeOrder).not.toHaveBeenCalled()
  })

  it('does not ask for invalid input', async () => {
    const { host, prompt } = fixture(irreversible)
    expect(await host.call({ ...call, input: {} })).toMatchObject({ stage: 'tool-input' })
    expect(prompt.requests).toEqual([])
  })

  it('does not ask a read tool', async () => {
    const { host, prompt } = fixture(
      defineAdapter({
        manifest,
        tools: { run_test: tool({ input: z.object({}), output: z.string(), run: async () => 'read' }) },
      }),
    )
    await host.call(call)
    expect(prompt.requests).toEqual([])
  })
})

describe('ctx.confirm', () => {
  const writeManifest = { ...manifest, tools: [{ ...manifest.tools[0]!, sideEffect: 'write' as const }] }
  const asking = defineAdapter({
    manifest: writeManifest,
    tools: {
      run_test: tool({
        input: z.object({ action: z.unknown() }),
        output: z.boolean(),
        // Whatever the test passes, as hostile tool code could: the runtime checks it, not the types.
        run: (ctx, input) => ctx.confirm(input.action as ConfirmAction),
      }),
    },
  })
  const update = { method: 'POST', path: '/api/trolley/update' } as const
  const ask = (action: unknown) => ({ ...call, input: { action } })

  it('asks the person with the manifest’s own declarations and resolves true on approval', async () => {
    const { host, prompt, audit } = fixture(asking)

    expect(await host.call(ask({ requests: [update], note: 'Swap to the 2L bottle?' }))).toEqual({
      status: 'ok',
      output: true,
    })
    expect(prompt.requests).toEqual([
      {
        adapterId: 'example-shop',
        adapterName: 'Example Shop',
        tool: 'run_test',
        toolTitle: 'Run test',
        callId: 'call-1',
        client: 'claude-code',
        kind: 'tool-request',
        requests: [{ ...update, purpose: 'write' }],
        note: 'Swap to the 2L bottle?',
      },
    ])
    expect(audit.events).toContainEqual(expect.objectContaining({ type: 'confirmation', answer: 'approved' }))
  })

  it('makes the note optional and lists a request named twice once', async () => {
    const { host, prompt } = fixture(asking)
    await host.call(ask({ requests: [update, { method: 'GET', path: '/api/trolley' }, update] }))
    expect(prompt.requests[0]).toMatchObject({
      requests: [
        { ...update, purpose: 'write' },
        { method: 'GET', path: '/api/trolley', purpose: 'read' },
      ],
      note: null,
    })
  })

  it('resolves false on a decline or a timeout', async () => {
    for (const answer of ['declined', 'timed-out'] as const) {
      const { host, prompt } = fixture(asking)
      prompt.answer = answer
      expect(await host.call(ask({ requests: [update] }))).toEqual({ status: 'ok', output: false })
    }
  })

  it.each([
    ['free text, as before C4', 'Swap to the 2L bottle?'],
    ['no requests', { requests: [] }],
    ['an unknown field', { requests: [update], title: 'Refresh your session' }],
    ['a note over the cap', { requests: [update], note: 'x'.repeat(501) }],
    ['an empty note', { requests: [update], note: '' }],
    ['a lower-case method', { requests: [{ method: 'post', path: '/api/trolley/update' }] }],
    ['too many requests', { requests: Array.from({ length: 11 }, () => update) }],
  ])('refuses %s without asking, and fails the call', async (_what, action) => {
    const { host, prompt, audit } = fixture(asking)
    expect(await host.call(ask(action))).toEqual({
      status: 'failed',
      stage: 'confirm',
      errorClass: 'invalid',
    })
    expect(prompt.requests).toEqual([])
    expect(audit.types()).not.toContain('confirmation')
  })

  it('refuses a request the manifest doesn’t declare, even one the surface would match', async () => {
    for (const path of ['/api/basket', '/api/fruit/items', '/api/trolley/update/']) {
      const { host, prompt } = fixture(asking)
      expect(await host.call(ask({ requests: [{ method: 'POST', path }] }))).toEqual({
        status: 'failed',
        stage: 'confirm',
        errorClass: 'undeclared-request',
      })
      expect(prompt.requests).toEqual([])
    }
  })

  it('refuses a request whose purpose outranks the tool’s side effect', async () => {
    const { host, prompt } = fixture(asking)
    const place = { method: 'POST', path: '/api/checkout/place' }
    expect(await host.call(ask({ requests: [update, place] }))).toEqual({
      status: 'failed',
      stage: 'confirm',
      errorClass: 'invalid',
    })

    const read = fixture(
      defineAdapter({
        manifest,
        tools: {
          run_test: tool({
            input: z.object({}),
            output: z.boolean(),
            run: (ctx) => ctx.confirm({ requests: [update] }),
          }),
        },
      }),
    )
    expect(await read.host.call(call)).toMatchObject({ stage: 'confirm', errorClass: 'invalid' })
    expect([...prompt.requests, ...read.prompt.requests]).toEqual([])
  })

  it('keeps the refusal even when tool code catches it', async () => {
    const { host, prompt } = fixture(
      defineAdapter({
        manifest: writeManifest,
        tools: {
          run_test: tool({
            input: z.object({}),
            output: z.boolean(),
            run: async (ctx) => {
              try {
                await ctx.confirm({ requests: [{ method: 'POST', path: '/api/basket' }] })
              } catch {
                // A hostile tool tries a second wording after the first is refused.
              }
              return ctx.confirm({ requests: [update] })
            },
          }),
        },
      }),
    )
    expect(await host.call(call)).toEqual({
      status: 'failed',
      stage: 'confirm',
      errorClass: 'undeclared-request',
    })
    expect(prompt.requests).toEqual([])
  })

  it('passes the call’s abort signal to the prompt', async () => {
    const { host, prompt } = fixture(asking)
    const signals: AbortSignal[] = []
    prompt.ask = async (_request: unknown, signal?: AbortSignal) => {
      if (signal) signals.push(signal)
      return 'approved'
    }
    await host.call(ask({ requests: [update] }))
    expect(signals[0]?.aborted).toBe(true)
  })
})
