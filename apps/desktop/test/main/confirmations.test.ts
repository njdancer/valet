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
    /** Each withdrawal with its reason, `<requestId>:<why>`. */
    reasons: [] as string[],
    declined: [] as string[],
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
          if (item !== undefined) broker.approvedById(item.id)
        }
        return signing.prompt
      },
      decline: (requestId) => void signing.declined.push(requestId),
      withdraw: (requestId, why) => {
        signing.withdrawn.push(requestId)
        signing.reasons.push(`${requestId}:${why}`)
      },
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

  it('shows a send as Valet’s own rendering of the exact message, Bcc included, unlocking nothing', async () => {
    const { broker } = setup()
    void broker.ask(
      {
        adapterId: 'shop',
        adapterName: 'Shop',
        tool: 'order',
        toolTitle: 'Order',
        callId: 'call1',
        client: 'Claude Code',
        kind: 'mail-send',
        mail: {
          endpoint: 'smtp.mail.me.com:587',
          to: ['ann@example.com'],
          cc: ['cy@example.com'],
          bcc: ['bo@example.com'],
          subject: 'Hello',
          text: 'Hi Ann\nSee you',
          inReplyTo: '<a1@example.com>',
          references: ['<a0@example.com>', '<a1@example.com>'],
        },
      },
      new AbortController().signal,
    )
    const [item] = broker.list()
    expect(item?.trigger).toBe('mail-send')
    // Not the call's own input, and nothing the adapter wrote as a note.
    expect(item?.input).toEqual([
      {
        kind: 'text',
        text: [
          'From: your account at smtp.mail.me.com',
          'To: ann@example.com',
          'Cc: cy@example.com',
          'Bcc is not shown to the other recipients:',
          'Bcc: bo@example.com',
          'Subject: Hello',
          'In reply to: <a1@example.com>',
          'References: <a0@example.com> <a1@example.com>',
          '',
          'Hi Ann',
          'See you',
        ].join('\n'),
      },
    ])
    expect(item?.adapterNote).toBeNull()
    expect(item?.unlocks).toEqual([])
    expect(item?.requests).toEqual([])
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

  it('takes a decline of another confirmation from a panel, as from any window, and declines its request', async () => {
    const { broker, signing } = setup(['cf_a', 'cf_b'])
    void broker.ask(toolRequest, new AbortController().signal)
    const b = broker.ask(toolRequest, new AbortController().signal)
    await settle()
    await broker.answer('cf_b', false, { role: 'confirmation', shows: 'cf_a' })
    await expect(b).resolves.toBe('declined')
    // The person's decline of the signed request, never a withdrawal by the app.
    expect(signing.declined).toEqual(['rq_cf_b'])
    expect(signing.withdrawn).toEqual([])
  })

  it('declines the request made after the person already declined', async () => {
    const { broker, signing } = setup()
    const answer = broker.ask(toolRequest, new AbortController().signal)
    await broker.answer('cf_1', false, { role: 'tray', shows: null })
    await expect(answer).resolves.toBe('declined')
    await settle()
    expect(signing.declined).toEqual(['rq_cf_1'])
    expect(signing.withdrawn).toEqual([])
  })

  it('withdraws, as cancelled, the request of a call that ended before anyone answered', async () => {
    const { broker, signing, closed } = setup()
    const controller = new AbortController()
    const answer = broker.ask(toolRequest, controller.signal)
    await settle()
    controller.abort()
    await expect(answer).resolves.toBe('timed-out')
    expect(signing.reasons).toEqual(['rq_cf_1:call-cancelled'])
    expect(signing.declined).toEqual([])
    expect(closed).toEqual(['cf_1'])
  })

  it('cancels the confirmations of a revoked agent’s calls at once, and no others', async () => {
    const { broker, signing, closed } = setup(['cf_a', 'cf_b'])
    const a = broker.ask(toolRequest, new AbortController().signal)
    const b = broker.ask({ ...toolRequest, callId: 'call2' }, new AbortController().signal)
    await settle()
    expect(broker.cancelWhere((item) => item.callId === 'call1', 'client-revoked')).toBe(1)
    await expect(a).resolves.toBe('cancelled')
    expect(signing.reasons).toEqual(['rq_cf_a:client-revoked'])
    expect(signing.declined).toEqual([])
    expect(closed).toEqual(['cf_a'])
    expect(broker.has('cf_b')).toBe(true)
    await broker.answer('cf_b', false, { role: 'tray', shows: null })
    await expect(b).resolves.toBe('declined')
  })

  it('accepts a decline from any window, at once', async () => {
    const { broker } = setup()
    const answer = broker.ask(toolRequest, new AbortController().signal)
    await broker.answer('cf_1', false, { role: 'tray', shows: null })
    await expect(answer).resolves.toBe('declined')
  })

  it('applies a signed approval only to the question it was signed for, never another of the same call', async () => {
    const { broker } = setup(['cf_a', 'cf_b'])
    const a = broker.ask(toolRequest, new AbortController().signal)
    const b = broker.ask(toolRequest, new AbortController().signal)
    expect(broker.waiting('cf_b')).toBe(false)
    await settle()
    expect(broker.waiting('cf_b')).toBe(true)
    expect(broker.approvedById('cf_nope')).toBe(false)
    expect(broker.approvedById('cf_b')).toBe(true)
    await expect(b).resolves.toBe('approved')
    expect(broker.has('cf_a')).toBe(true)
    expect(broker.approvedById('cf_b')).toBe(false)
    await broker.answer('cf_a', false, { role: 'tray', shows: null })
    await expect(a).resolves.toBe('declined')
  })

  it('tells the panel it wasn’t approved when it ran out while Touch ID was open', async () => {
    const { broker, signing, advance, timers } = setup()
    const answer = broker.ask(toolRequest, new AbortController().signal)
    await settle()
    signing.prompt = 'approved'
    // The prompt is signed, but the confirmation timed out first: nothing applies it.
    const original = broker.approvedById.bind(broker)
    broker.approvedById = () => false
    const pending = broker.answer('cf_1', true, { role: 'confirmation', shows: 'cf_1' })
    advance(TIMEOUT)
    timers.fire()
    await expect(pending).rejects.toThrow(ConfirmationRefused)
    await expect(answer).resolves.toBe('timed-out')
    broker.approvedById = original
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
    expect(signing.reasons).toEqual(['rq_cf_1:unanswered'])
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

  it('declines everything on quit, withdrawing the requests rather than declining them for the person', async () => {
    const { broker, signing } = setup()
    const answer = broker.ask(toolRequest, new AbortController().signal)
    await settle()
    broker.declineAll()
    await expect(answer).resolves.toBe('declined')
    expect(signing.reasons).toEqual(['rq_cf_1:unanswered'])
    expect(signing.declined).toEqual([])
  })
})

/** Lets the signed request's creation (a promise) land. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}
