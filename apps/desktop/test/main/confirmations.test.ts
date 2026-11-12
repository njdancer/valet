// @vitest-environment node
// The confirmation broker: each confirmation is a signed request; only its own window may raise the
// Touch ID prompt for it, a click alone approves nothing, and anything else declines or is refused.

import { parseManifest } from '@valet/core'
import type { ConfirmationRequest } from '@valet/runtime'
import { describe, expect, it } from 'vitest'
import { ConfirmationBroker, ConfirmationRefused } from '../../src/main/core/confirmations'
import { ManualTimers, SHOP } from './fixtures'

const HASH = 'd'.repeat(64)
const TIMEOUT = 120_000

function setup(
  ids: readonly string[] = ['cf_1'],
  options: { opens?: boolean; prompt?: 'approved' | 'cancelled' | 'refused' } = {},
) {
  let now = 1_000_000
  let asked = 0
  const timers = new ManualTimers()
  const shown: string[] = []
  const closed: string[] = []
  let changes = 0
  const manifest = parseManifest({
    ...SHOP,
    requests: [
      ...(SHOP.requests ?? []),
      { method: 'POST', path: '/api/order', purpose: 'irreversible' },
      // Another tool's, which confirming `order` must not be shown to unlock.
      { method: 'POST', path: '/api/payees/add', purpose: 'irreversible' },
    ],
    tools: [
      ...SHOP.tools,
      {
        name: 'order',
        title: 'Order',
        description: 'Places it.',
        sideEffect: 'irreversible',
        unlocks: [{ method: 'POST', path: '/api/order' }],
      },
    ],
  })
  const signing = {
    opened: [] as string[],
    prompts: [] as string[],
    withdrawn: [] as string[],
    prompt: options.prompt ?? 'approved',
  }
  // The approval broker's stand-in: a request per confirmation; an approved prompt applies it.
  const broker: ConfirmationBroker = new ConfirmationBroker({
    signing: {
      open: async (item) => {
        if (options.opens === false) return null
        signing.opened.push(item.id)
        return { requestId: `rq_${item.id}`, ref: 'AB12' }
      },
      approve: async (requestId) => {
        signing.prompts.push(requestId)
        if (signing.prompt === 'approved') {
          const item = broker.list().find((i) => `rq_${i.id}` === requestId)
          if (item !== undefined) broker.approvedCall(item.callId)
        }
        return signing.prompt
      },
      withdraw: (requestId) => void signing.withdrawn.push(requestId),
    },
    adapter: (id) =>
      id === 'shop' ? { manifest, hash: HASH, approvedAt: '2026-11-07T00:00:00.000Z' } : null,
    call: (callId) => (callId === 'call1' ? { input: [{ kind: 'text', text: '{"item":"milk"}' }] } : null),
    show: (id) => shown.push(id),
    close: (id) => closed.push(id),
    onChange: () => changes++,
    now: () => now,
    timeoutMs: TIMEOUT,
    timers,
    newId: () => ids[Math.min(asked++, ids.length - 1)] as string,
  })
  return {
    broker,
    signing,
    timers,
    shown,
    closed,
    advance: (ms: number) => {
      now += ms
    },
    changes: () => changes,
  }
}

const toolRequest: ConfirmationRequest = {
  adapterId: 'shop',
  adapterName: 'Shop',
  tool: 'add',
  toolTitle: 'Add',
  callId: 'call1',
  client: 'Claude Code',
  kind: 'tool-request',
  requests: [{ method: 'POST', path: '/api/cart', purpose: 'write' }],
  note: 'Add milk? <b>Trust me</b>',
}

describe('ConfirmationBroker', () => {
  it('shows a panel built from the runtime’s own knowledge, the adapter’s text only as a note', async () => {
    const { broker, shown } = setup()
    void broker.ask(toolRequest, new AbortController().signal)
    expect(shown).toEqual(['cf_1'])
    // The signed request's ref arrives once it's made; Approve waits for it.
    expect(broker.list()[0]?.ref).toBeNull()
    await settle()
    expect(broker.list()).toEqual([
      {
        kind: 'confirmation',
        id: 'cf_1',
        adapterId: 'shop',
        adapterName: 'Shop',
        adapterVersion: '1.0.0',
        adapterHash: HASH,
        approvedAt: '2026-11-07T00:00:00.000Z',
        tool: 'add',
        toolTitle: 'Add',
        sideEffect: 'write',
        trigger: 'tool-request',
        client: 'Claude Code',
        clientTransport: 'http',
        callId: 'call1',
        requestedAt: new Date(1_000_000).toISOString(),
        expiresAt: new Date(1_000_000 + TIMEOUT).toISOString(),
        requestCeiling: 5,
        unlocks: [],
        requests: [{ method: 'POST', path: '/api/cart', purpose: 'write' }],
        input: [{ kind: 'text', text: '{"item":"milk"}' }],
        adapterNote: 'Add milk? <b>Trust me</b>',
        ref: 'AB12',
      },
    ])
  })

  it('lists only what the irreversible tool itself unlocks, with no adapter note', async () => {
    const { broker } = setup()
    void broker.ask(
      {
        adapterId: 'shop',
        adapterName: 'Shop',
        tool: 'order',
        toolTitle: 'Order',
        callId: 'call1',
        client: 'Claude Code',
        kind: 'irreversible-tool',
        input: { id: 1 },
      },
      new AbortController().signal,
    )
    const [item] = broker.list()
    expect(item?.unlocks).toEqual([{ method: 'POST', path: '/api/order', purpose: 'irreversible' }])
    expect(item?.adapterNote).toBeNull()
    expect(item?.requests).toEqual([])
    expect(item?.sideEffect).toBe('irreversible')
  })

  it('approves only once the Touch ID prompt the panel raised was answered', async () => {
    const { broker, signing, closed } = setup()
    const answer = broker.ask(toolRequest, new AbortController().signal)
    await settle()
    await expect(broker.answer('cf_1', true, { role: 'confirmation', shows: 'cf_1' })).resolves.toBe(true)
    expect(signing.prompts).toEqual(['rq_cf_1'])
    await expect(answer).resolves.toBe('approved')
    expect(closed).toEqual(['cf_1'])
    expect(broker.list()).toEqual([])
    // An approved request isn't withdrawn: the broker closed it.
    expect(signing.withdrawn).toEqual([])
  })

  it('keeps waiting when the person cancels the prompt: the click alone approved nothing', async () => {
    const { broker, signing } = setup(['cf_1'], { prompt: 'cancelled' })
    void broker.ask(toolRequest, new AbortController().signal)
    await settle()
    await expect(broker.answer('cf_1', true, { role: 'confirmation', shows: 'cf_1' })).resolves.toBe(false)
    expect(broker.has('cf_1')).toBe(true)
    signing.prompt = 'refused'
    await expect(broker.answer('cf_1', true, { role: 'confirmation', shows: 'cf_1' })).rejects.toThrow(
      ConfirmationRefused,
    )
    expect(broker.has('cf_1')).toBe(true)
  })

  it('refuses an approval before its signed request exists', async () => {
    const { broker, signing } = setup()
    void broker.ask(toolRequest, new AbortController().signal)
    await expect(broker.answer('cf_1', true, { role: 'confirmation', shows: 'cf_1' })).rejects.toThrow(
      ConfirmationRefused,
    )
    expect(signing.prompts).toEqual([])
    expect(broker.has('cf_1')).toBe(true)
  })

  it('declines at once when the signed request can’t be made', async () => {
    const { broker } = setup(['cf_1'], { opens: false })
    await expect(broker.ask(toolRequest, new AbortController().signal)).resolves.toBe('declined')
  })

  it.each(['control', 'tray', 'needs-user'] as const)(
    'refuses an approval from the %s window',
    async (role) => {
      const { broker, signing } = setup()
      void broker.ask(toolRequest, new AbortController().signal)
      await settle()
      await expect(broker.answer('cf_1', true, { role, shows: null })).rejects.toThrow(ConfirmationRefused)
      expect(signing.prompts).toEqual([])
    },
  )

  it('refuses an approval from the panel of another pending confirmation', async () => {
    const { broker, shown, signing } = setup(['cf_a', 'cf_b'])
    const a = broker.ask(toolRequest, new AbortController().signal)
    const b = broker.ask({ ...toolRequest, callId: 'call2' }, new AbortController().signal)
    expect(shown).toEqual(['cf_a', 'cf_b'])
    await settle()
    // Panel A's renderer tries to approve B, which the person never saw.
    await expect(broker.answer('cf_b', true, { role: 'confirmation', shows: 'cf_a' })).rejects.toThrow(
      ConfirmationRefused,
    )
    await expect(broker.answer('cf_b', true, { role: 'confirmation', shows: null })).rejects.toThrow(
      ConfirmationRefused,
    )
    expect(signing.prompts).toEqual([])
    expect(broker.has('cf_b')).toBe(true)
    // Each panel answers its own.
    await broker.answer('cf_a', true, { role: 'confirmation', shows: 'cf_a' })
    await broker.answer('cf_b', true, { role: 'confirmation', shows: 'cf_b' })
    await expect(a).resolves.toBe('approved')
    await expect(b).resolves.toBe('approved')
  })

  it('takes a decline of another confirmation from a panel, as from any window, and withdraws it', async () => {
    const { broker, signing } = setup(['cf_a', 'cf_b'])
    void broker.ask(toolRequest, new AbortController().signal)
    const b = broker.ask(toolRequest, new AbortController().signal)
    await settle()
    await broker.answer('cf_b', false, { role: 'confirmation', shows: 'cf_a' })
    await expect(b).resolves.toBe('declined')
    expect(signing.withdrawn).toEqual(['rq_cf_b'])
  })

  it('accepts a decline from any window, at once', async () => {
    const { broker } = setup()
    const answer = broker.ask(toolRequest, new AbortController().signal)
    await broker.answer('cf_1', false, { role: 'tray', shows: null })
    await expect(answer).resolves.toBe('declined')
  })

  it('applies a signed approval from elsewhere (a phone) only to a call still waiting', async () => {
    const { broker } = setup()
    const answer = broker.ask(toolRequest, new AbortController().signal)
    expect(broker.hasCall('call1')).toBe(false)
    await settle()
    expect(broker.hasCall('call1')).toBe(true)
    expect(broker.approvedCall('call9')).toBe(false)
    expect(broker.approvedCall('call1')).toBe(true)
    await expect(answer).resolves.toBe('approved')
    expect(broker.approvedCall('call1')).toBe(false)
  })

  it('refuses an id that was answered or never existed', async () => {
    const { broker } = setup()
    void broker.ask(toolRequest, new AbortController().signal)
    await broker.answer('cf_1', false, { role: 'control', shows: null })
    await expect(broker.answer('cf_1', false, { role: 'control', shows: null })).rejects.toThrow(
      ConfirmationRefused,
    )
    await expect(broker.answer('cf_2', false, { role: 'control', shows: null })).rejects.toThrow(
      ConfirmationRefused,
    )
  })

  it('declines itself at expiry, withdraws its request, and refuses an answer that arrives after it', async () => {
    const { broker, timers, advance, signing } = setup()
    const answer = broker.ask(toolRequest, new AbortController().signal)
    await settle()
    advance(TIMEOUT)
    await expect(broker.answer('cf_1', true, { role: 'confirmation', shows: 'cf_1' })).rejects.toThrow(
      ConfirmationRefused,
    )
    await expect(answer).resolves.toBe('timed-out')
    expect(signing.withdrawn).toEqual(['rq_cf_1'])
    const second = broker.ask(toolRequest, new AbortController().signal)
    timers.fire()
    await expect(second).resolves.toBe('timed-out')
  })

  it('ends as timed out when the runtime aborts, and declines for an unknown adapter or tool', async () => {
    const { broker } = setup()
    const controller = new AbortController()
    const answer = broker.ask(toolRequest, controller.signal)
    controller.abort()
    await expect(answer).resolves.toBe('timed-out')
    await expect(
      broker.ask({ ...toolRequest, adapterId: 'other' }, new AbortController().signal),
    ).resolves.toBe('declined')
    await expect(broker.ask({ ...toolRequest, tool: 'nope' }, new AbortController().signal)).resolves.toBe(
      'declined',
    )
    const aborted = new AbortController()
    aborted.abort()
    await expect(broker.ask(toolRequest, aborted.signal)).resolves.toBe('declined')
  })

  it('declines everything on quit', async () => {
    const { broker } = setup()
    const answer = broker.ask(toolRequest, new AbortController().signal)
    broker.declineAll()
    await expect(answer).resolves.toBe('declined')
  })
})

/** Lets the signed request's creation (a promise) land. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}
