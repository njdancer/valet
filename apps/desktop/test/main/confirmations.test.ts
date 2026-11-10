// @vitest-environment node
// The confirmation broker: only the confirmation window approves, only once armed, only before
// expiry; anything else declines or is refused.

import { parseManifest } from '@valet/core'
import type { ConfirmationRequest } from '@valet/runtime'
import { describe, expect, it } from 'vitest'
import { ConfirmationBroker, ConfirmationRefused } from '../../src/main/core/confirmations'
import { CONFIRM_ARM_MS } from '../../src/shared/api'
import { ManualTimers, SHOP } from './fixtures'

const HASH = 'd'.repeat(64)
const TIMEOUT = 120_000

function setup(ids: readonly string[] = ['cf_1']) {
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
  const broker = new ConfirmationBroker({
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
  it('shows a panel built from the runtime’s own knowledge, the adapter’s text only as a note', () => {
    const { broker, shown } = setup()
    void broker.ask(toolRequest, new AbortController().signal)
    expect(shown).toEqual(['cf_1'])
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

  it('approves from the confirmation window once armed for CONFIRM_ARM_MS', async () => {
    const { broker, advance, closed } = setup()
    const answer = broker.ask(toolRequest, new AbortController().signal)
    broker.armed('cf_1')
    advance(CONFIRM_ARM_MS)
    broker.answer('cf_1', true, { role: 'confirmation', shows: 'cf_1' })
    await expect(answer).resolves.toBe('approved')
    expect(closed).toEqual(['cf_1'])
    expect(broker.list()).toEqual([])
  })

  it('refuses an approval before the window was ever shown', () => {
    const { broker, advance } = setup()
    void broker.ask(toolRequest, new AbortController().signal)
    advance(10_000)
    expect(() => broker.answer('cf_1', true, { role: 'confirmation', shows: 'cf_1' })).toThrow(
      ConfirmationRefused,
    )
    expect(broker.has('cf_1')).toBe(true)
  })

  it('refuses an approval within CONFIRM_ARM_MS of showing, and again after refocus', () => {
    const { broker, advance } = setup()
    void broker.ask(toolRequest, new AbortController().signal)
    broker.armed('cf_1')
    advance(CONFIRM_ARM_MS - 1)
    expect(() => broker.answer('cf_1', true, { role: 'confirmation', shows: 'cf_1' })).toThrow(
      ConfirmationRefused,
    )
    advance(1)
    broker.armed('cf_1') // the window regained focus
    advance(CONFIRM_ARM_MS - 1)
    expect(() => broker.answer('cf_1', true, { role: 'confirmation', shows: 'cf_1' })).toThrow(
      ConfirmationRefused,
    )
  })

  it.each(['control', 'tray', 'needs-user'] as const)('refuses an approval from the %s window', (role) => {
    const { broker, advance } = setup()
    void broker.ask(toolRequest, new AbortController().signal)
    broker.armed('cf_1')
    advance(CONFIRM_ARM_MS)
    expect(() => broker.answer('cf_1', true, { role, shows: null })).toThrow(ConfirmationRefused)
  })

  it('refuses an approval from the panel of another pending confirmation', async () => {
    const { broker, advance, shown } = setup(['cf_a', 'cf_b'])
    const a = broker.ask(toolRequest, new AbortController().signal)
    const b = broker.ask(toolRequest, new AbortController().signal)
    expect(shown).toEqual(['cf_a', 'cf_b'])
    broker.armed('cf_a')
    broker.armed('cf_b')
    advance(CONFIRM_ARM_MS)
    // Panel A's renderer tries to approve B, which the person never saw armed in A.
    expect(() => broker.answer('cf_b', true, { role: 'confirmation', shows: 'cf_a' })).toThrow(
      ConfirmationRefused,
    )
    expect(() => broker.answer('cf_b', true, { role: 'confirmation', shows: null })).toThrow(
      ConfirmationRefused,
    )
    expect(broker.has('cf_b')).toBe(true)
    // Each panel answers its own.
    broker.answer('cf_a', true, { role: 'confirmation', shows: 'cf_a' })
    broker.answer('cf_b', true, { role: 'confirmation', shows: 'cf_b' })
    await expect(a).resolves.toBe('approved')
    await expect(b).resolves.toBe('approved')
  })

  it('takes a decline of another confirmation from a panel, as from any window', async () => {
    const { broker } = setup(['cf_a', 'cf_b'])
    void broker.ask(toolRequest, new AbortController().signal)
    const b = broker.ask(toolRequest, new AbortController().signal)
    broker.answer('cf_b', false, { role: 'confirmation', shows: 'cf_a' })
    await expect(b).resolves.toBe('declined')
  })

  it('accepts a decline from any window, at once', async () => {
    const { broker } = setup()
    const answer = broker.ask(toolRequest, new AbortController().signal)
    broker.answer('cf_1', false, { role: 'tray', shows: null })
    await expect(answer).resolves.toBe('declined')
  })

  it('refuses an id that was answered or never existed', () => {
    const { broker } = setup()
    void broker.ask(toolRequest, new AbortController().signal)
    broker.answer('cf_1', false, { role: 'control', shows: null })
    expect(() => broker.answer('cf_1', false, { role: 'control', shows: null })).toThrow(ConfirmationRefused)
    expect(() => broker.answer('cf_2', false, { role: 'control', shows: null })).toThrow(ConfirmationRefused)
  })

  it('declines itself at expiry, and refuses an answer that arrives after it', async () => {
    const { broker, timers, advance } = setup()
    const answer = broker.ask(toolRequest, new AbortController().signal)
    broker.armed('cf_1')
    advance(TIMEOUT)
    expect(() => broker.answer('cf_1', true, { role: 'confirmation', shows: 'cf_1' })).toThrow(
      ConfirmationRefused,
    )
    await expect(answer).resolves.toBe('timed-out')
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
