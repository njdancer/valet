import type { ApprovalKind, ApprovalSubject, Requester } from '@valet/core'
import type { ClientIdentity } from '@valet/mcp-server'
import { describe, expect, it } from 'vitest'
import {
  AdminWriterImpl,
  type AgentBroker,
  type AgentSettingValues,
  NOTIFY_PER_HOUR,
  type WriterSource,
} from '../../src/main/core/admin-writer'
import type { Closed, RequestResult } from '../../src/main/core/approvals/broker'

const ME: ClientIdentity = { origin: 'local', clientId: 'c_me' }
const OTHER: ClientIdentity = { origin: 'local', clientId: 'c_other' }
const T0 = Date.parse('2026-11-12T08:00:00.000Z')

/** A broker that records requests and lets the test close them; it has no way to approve. */
class FakeBroker implements AgentBroker {
  readonly macId = 'mac'
  readonly requests: {
    id: string
    kind: ApprovalKind
    subject: unknown
    requester: Requester
    note: string | null
  }[] = []
  readonly closed = new Map<string, Closed>()
  refuse: RequestResult | null = null
  private n = 0

  async request<K extends ApprovalKind>(
    kind: K,
    subject: ApprovalSubject<K>,
    requester: Requester,
    note: string | null,
  ): Promise<RequestResult> {
    if (this.refuse !== null) return this.refuse
    const same = this.requests.find(
      (r) =>
        r.kind === kind &&
        JSON.stringify(r.subject) === JSON.stringify(subject) &&
        !this.closed.has(r.id) &&
        r.requester.kind === 'agent' &&
        requester.kind === 'agent' &&
        r.requester.clientId === requester.clientId,
    )
    if (same !== undefined)
      return { ok: true, requestId: same.id, ref: ref(same.id), expiresAt: expires(), reused: true }
    const id = `req${++this.n}`.padEnd(22, 'x')
    this.requests.push({ id, kind, subject, requester, note })
    return { ok: true, requestId: id, ref: ref(id), expiresAt: expires(), reused: false }
  }

  status(requestId: string, asker: Requester): { readonly state: 'pending' } | Closed | null {
    const r = this.requests.find((x) => x.id === requestId)
    if (r === undefined || r.requester.kind !== 'agent' || asker.kind !== 'agent') return null
    if (r.requester.clientId !== asker.clientId) return null
    return this.closed.get(requestId) ?? { state: 'pending' }
  }

  async withdraw(requestId: string, asker: Requester): Promise<boolean> {
    const s = this.status(requestId, asker)
    if (s === null || !('state' in s)) return false
    this.close(requestId, 'withdrawn', { reason: 'asker' })
    return true
  }

  waiting() {
    return this.requests
      .filter((r) => !this.closed.has(r.id))
      .map((r) => ({
        requestId: r.id,
        ref: ref(r.id),
        kind: r.kind,
        requester: r.requester,
        createdAt: new Date(T0).toISOString(),
        expiresAt: expires(),
      }))
  }

  close(id: string, outcome: Closed['outcome'], extra: Partial<Closed> = {}): void {
    const r = this.requests.find((x) => x.id === id)
    if (r === undefined) throw new Error(id)
    this.closed.set(id, {
      requestId: id,
      ref: ref(id),
      kind: r.kind,
      requester: r.requester,
      outcome,
      at: '2026-11-12T08:41:00.000Z',
      deviceId: outcome === 'approved' ? 'mac' : null,
      ...extra,
    })
  }
}

const ref = (id: string) => id.slice(3, 7).toUpperCase().padStart(4, '0')
const expires = () => new Date(T0 + 24 * 3600_000).toISOString()

function setup(overrides: Partial<WriterSource> = {}) {
  let now = T0
  const broker = new FakeBroker()
  const values: Record<string, boolean | number> = {
    messagesOtpEnabled: false,
    notifications: true,
    traceRetentionDays: 14,
  }
  const audited: unknown[] = []
  const told: [string, string, number][] = []
  const off = new Map<string, Set<string>>()
  const disconnected: string[] = []
  const clients = new Map([
    ['c_me', 'Claude Code'],
    ['c_other', 'Other agent'],
  ])
  const source: WriterSource = {
    now: () => now,
    lockedDown: () => false,
    client: (viewer) => {
      const name = viewer.origin === 'local' ? clients.get(viewer.clientId) : undefined
      return name === undefined ? null : { name }
    },
    broker: () => broker,
    wiredKinds: () => new Set<ApprovalKind>(['setting']),
    phonePaired: () => false,
    settings: () => values as unknown as AgentSettingValues,
    // As approvals/subjects.ts classifies them (R6): turning on Messages or remote access, turning
    // notifications off, and shortening retention widen.
    widens: (name, from, to) =>
      name === 'notifications'
        ? to === false
        : name === 'traceRetentionDays'
          ? (to as number) < (from as number)
          : to === true,
    settingSubject: (name, from, to) => ({
      scope: 'valet',
      adapterId: null,
      setting: name,
      label: name,
      from: String(from),
      to: String(to),
    }),
    applySetting: async (name, from, value) => {
      if (values[name] !== from) throw new Error('changed')
      values[name] = value
    },
    adapterSetting: async (adapterId, setting) =>
      adapterId === 'woolworths' && setting === 'store'
        ? {
            ok: true,
            title: 'Choose the store for Woolworths',
            subject: {
              scope: 'adapter',
              adapterId,
              setting,
              label: 'Store',
              from: 'Not set',
              to: 'Chosen on this card',
              choices: [
                { value: '1', label: 'A' },
                { value: '2', label: 'B' },
              ],
            },
          }
        : { ok: false, reason: 'not-found' },
    tool: (adapterId, tool) =>
      adapterId === 'woolworths' && tool === 'search_products'
        ? { adapterName: 'Woolworths', title: 'Search products' }
        : null,
    toolOff: (clientId, qualified) => off.get(clientId)?.has(qualified) === true,
    turnOffTool: async (clientId, qualified) => {
      const set = off.get(clientId) ?? new Set()
      if (set.has(qualified)) return 'already'
      set.add(qualified)
      off.set(clientId, set)
      return 'done'
    },
    disconnect: async (clientId) => {
      disconnected.push(clientId)
      clients.delete(clientId)
      return true
    },
    audit: async (event) => {
      audited.push(event)
    },
    told: (clientId, name, count) => told.push([clientId, name, count]),
    ...overrides,
  }
  return {
    source,
    writer: new AdminWriterImpl(source),
    broker,
    values,
    audited,
    told,
    off,
    disconnected,
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe('AdminWriterImpl', () => {
  it('makes a stricter setting change at once, audits it first and tells the person', async () => {
    const { writer, values, audited, told, broker } = setup()
    const outcome = await writer.setSetting(ME, 'messagesOtpEnabled', false, null)
    expect(outcome).toEqual({ kind: 'unchanged', current: 'Read login codes from Messages is already off' })
    const done = await writer.setSetting(ME, 'traceRetentionDays', 30, null)
    expect(done).toEqual({ kind: 'done', what: 'Keep call details for set to 30 days' })
    expect(values['traceRetentionDays']).toBe(30)
    expect(audited).toEqual([
      { clientId: 'local:c_me', action: 'setting', target: 'traceRetentionDays', value: '30' },
    ])
    expect(told).toEqual([['local:c_me', 'Claude Code', 1]])
    expect(broker.requests).toEqual([])
  })

  it('turns every widening change into a request with the agent as asker and its note, changing nothing', async () => {
    const { writer, values, broker, audited } = setup()
    for (const [name, value] of [
      ['messagesOtpEnabled', true],
      ['notifications', false],
      ['traceRetentionDays', 1],
    ] as const) {
      const outcome = await writer.setSetting(ME, name, value, 'please')
      expect(outcome.kind).toBe('asked')
    }
    expect(values).toEqual({
      messagesOtpEnabled: false,
      notifications: true,
      traceRetentionDays: 14,
    })
    expect(audited).toEqual([])
    expect(broker.requests.map((r) => [r.kind, r.requester, r.note])).toEqual(
      Array(3).fill([
        'setting',
        { kind: 'agent', clientId: 'local:c_me', clientName: 'Claude Code' },
        'please',
      ]),
    )
  })

  it('says a request kind is not available until the app wires it', async () => {
    const { writer, broker } = setup({ wiredKinds: () => new Set() })
    expect(await writer.setSetting(ME, 'messagesOtpEnabled', true, null)).toEqual({
      kind: 'refused',
      reason: 'not-available',
    })
    expect(await writer.requestSetting(ME, 'woolworths', 'store', null, null)).toEqual({
      kind: 'refused',
      reason: 'not-available',
    })
    expect(broker.requests).toEqual([])
  })

  it('asks for an adapter setting with the choices the app fetched, never a value', async () => {
    const { writer, broker } = setup()
    const outcome = await writer.requestSetting(ME, 'woolworths', 'store', '2000', null)
    expect(outcome.kind).toBe('asked')
    expect(broker.requests[0]?.subject).toMatchObject({ scope: 'adapter', to: 'Chosen on this card' })
    expect(await writer.requestSetting(ME, 'woolworths', 'nope', null, null)).toEqual({
      kind: 'refused',
      reason: 'not-found',
    })
  })

  it('passes on the broker’s limits and reuse', async () => {
    const { writer, broker } = setup()
    const first = await writer.setSetting(ME, 'messagesOtpEnabled', true, null)
    const again = await writer.setSetting(ME, 'messagesOtpEnabled', true, null)
    expect(first.kind === 'asked' && !first.reused).toBe(true)
    expect(again.kind === 'asked' && again.reused).toBe(true)
    broker.refuse = { ok: false, reason: 'cooling-down', until: '2026-11-12T09:00:00.000Z' }
    expect(await writer.setSetting(ME, 'messagesOtpEnabled', true, null)).toEqual({
      kind: 'refused',
      reason: 'cooling-down',
      until: '2026-11-12T09:00:00.000Z',
    })
  })

  it('turns a tool off for the asking agent only, and not one it may not call', async () => {
    const { writer, off } = setup()
    expect(await writer.turnOffTool(ME, 'woolworths', 'search_products')).toEqual({
      kind: 'done',
      what: '"Search products" (Woolworths) turned off for you',
    })
    expect([...(off.get('c_me') ?? [])]).toEqual(['woolworths.search_products'])
    expect(off.has('c_other')).toBe(false)
    expect((await writer.turnOffTool(ME, 'woolworths', 'search_products')).kind).toBe('unchanged')
    expect(await writer.turnOffTool(ME, 'woolworths', 'select_store')).toEqual({
      kind: 'refused',
      reason: 'not-found',
    })
  })

  it(`allows ${NOTIFY_PER_HOUR} Notify-only changes an hour, then refuses until the oldest is an hour old`, async () => {
    const { writer, advance } = setup({
      turnOffTool: async () => 'done',
    })
    for (let i = 0; i < NOTIFY_PER_HOUR; i++) {
      expect((await writer.turnOffTool(ME, 'woolworths', 'search_products')).kind).toBe('done')
      advance(1000)
    }
    const refused = await writer.turnOffTool(ME, 'woolworths', 'search_products')
    expect(refused).toMatchObject({ kind: 'refused', reason: 'too-many-changes' })
    // Another agent has its own count.
    expect((await writer.turnOffTool(OTHER, 'woolworths', 'search_products')).kind).toBe('done')
    advance(3600_000)
    expect((await writer.turnOffTool(ME, 'woolworths', 'search_products')).kind).toBe('done')
  })

  it('makes no change it couldn’t audit', async () => {
    const { writer, values } = setup({
      audit: async () => {
        throw new Error('disk full')
      },
    })
    expect(await writer.setSetting(ME, 'notifications', false, null)).toMatchObject({ kind: 'asked' })
    values['notifications'] = false
    expect(await writer.setSetting(ME, 'notifications', true, null)).toEqual({
      kind: 'refused',
      reason: 'unavailable',
    })
    expect(values['notifications']).toBe(false)
  })

  it('refuses everything while locked down, from a remote client, or from an unknown one', async () => {
    const locked = setup({ lockedDown: () => true })
    expect(await locked.writer.disconnect(ME)).toEqual({ kind: 'refused', reason: 'locked-down' })
    const { writer } = setup()
    expect(
      await writer.setSetting({ origin: 'remote', clientId: 'c_me' }, 'notifications', true, null),
    ).toEqual({
      kind: 'refused',
      reason: 'not-allowed',
    })
    expect(
      await writer.turnOffTool({ origin: 'local', clientId: 'c_gone' }, 'woolworths', 'search_products'),
    ).toEqual({
      kind: 'refused',
      reason: 'not-found',
    })
  })

  it('disconnects only the asking agent', async () => {
    const { writer, disconnected, audited } = setup()
    expect((await writer.disconnect(ME)).kind).toBe('done')
    expect(disconnected).toEqual(['c_me'])
    expect(audited).toEqual([
      { clientId: 'local:c_me', action: 'disconnect', target: 'local:c_me', value: null },
    ])
  })

  it('shows and withdraws only the asker’s own requests', async () => {
    const { writer, broker } = setup()
    const mine = await writer.setSetting(ME, 'messagesOtpEnabled', true, null)
    const theirs = await writer.setSetting(OTHER, 'messagesOtpEnabled', true, null)
    if (mine.kind !== 'asked' || theirs.kind !== 'asked') throw new Error('not asked')
    expect((await writer.approvals(ME, null)).map((r) => r.ref)).toEqual([mine.request.ref])
    expect(await writer.approvals(ME, theirs.request.ref)).toEqual([])
    expect(await writer.withdraw(ME, theirs.request.ref)).toBe('not-found')
    expect(broker.closed.size).toBe(0)
    expect(await writer.withdraw(ME, mine.request.ref)).toBe('withdrawn')
    expect(await writer.withdraw(ME, mine.request.ref)).toBe('closed')
  })

  it('reports each ended request once, on any later call', async () => {
    const { writer, broker } = setup()
    const asked = await writer.setSetting(ME, 'messagesOtpEnabled', true, null)
    if (asked.kind !== 'asked') throw new Error('not asked')
    expect(await writer.answers(ME)).toEqual([])
    broker.close(broker.requests[0]?.id as string, 'declined', { deviceId: 'phone1', note: 'Not now' })
    const answers = await writer.answers(ME)
    expect(answers).toEqual([
      expect.objectContaining({ ref: asked.request.ref, state: 'declined', note: 'Not now' }),
    ])
    expect(await writer.answers(ME)).toEqual([])
    expect(await writer.answers(OTHER)).toEqual([])
  })

  it('finds a request still waiting from before a restart', async () => {
    const first = setup()
    await first.writer.setSetting(ME, 'messagesOtpEnabled', true, null)
    const restarted = new AdminWriterImpl({ ...first.source, phonePaired: () => true })
    const views = await restarted.approvals(ME, null)
    expect(views).toEqual([expect.objectContaining({ state: 'waiting', where: 'mac-and-phone' })])
  })

  it('lists the asker’s own changes, and everyone’s only with All agents’ activity', async () => {
    const { writer } = setup()
    await writer.turnOffTool(ME, 'woolworths', 'search_products')
    await writer.setSetting(OTHER, 'messagesOtpEnabled', true, null)
    expect((await writer.changes(ME, false, 20)).map((c) => c.what)).toEqual([
      '"Search products" (Woolworths) turned off for you',
    ])
    const all = await writer.changes(ME, true, 20)
    expect(all.map((c) => [c.agent, c.mine, c.tier, c.approval?.state ?? null])).toEqual([
      ['Other agent', false, 'approve', 'waiting'],
      ['Claude Code', true, 'notify', null],
    ])
  })

  it('holds the hourly limit against calls made in parallel', async () => {
    const { writer } = setup({
      audit: () => new Promise((resolve) => setTimeout(resolve, 2)),
      toolOff: () => false,
      turnOffTool: async () => 'done',
    })
    const outcomes = await Promise.all(
      Array.from({ length: 30 }, () => writer.turnOffTool(ME, 'woolworths', 'search_products')),
    )
    expect(outcomes.filter((o) => o.kind === 'done')).toHaveLength(NOTIFY_PER_HOUR)
  })

  it('re-reads the value for each of two changes made in parallel, so the second is a request', async () => {
    const { writer, values, broker } = setup({
      audit: () => new Promise((resolve) => setTimeout(resolve, 2)),
    })
    const [first, second] = await Promise.all([
      writer.setSetting(ME, 'traceRetentionDays', 60, null),
      writer.setSetting(ME, 'traceRetentionDays', 40, null),
    ])
    expect(first.kind).toBe('done')
    // 60 to 40 shortens: an agent's request, never a change made or a prompt on the person's behalf.
    expect(second.kind).toBe('asked')
    expect(values['traceRetentionDays']).toBe(60)
    expect(broker.requests[0]?.requester).toMatchObject({ kind: 'agent', clientId: 'local:c_me' })
  })

  it('writes no record for a tool already off, an unknown tool, or a refused change', async () => {
    const { writer, audited } = setup()
    await writer.turnOffTool(ME, 'woolworths', 'search_products')
    for (let i = 0; i < 20; i++) await writer.turnOffTool(ME, 'woolworths', 'search_products')
    await writer.turnOffTool(ME, 'woolworths', 'nope')
    expect(audited).toHaveLength(1)
  })

  it('counts store lookups against the hourly limit', async () => {
    const { writer } = setup()
    for (let i = 0; i < NOTIFY_PER_HOUR; i++)
      await writer.requestSetting(ME, 'woolworths', 'nope', null, null)
    expect(await writer.requestSetting(ME, 'woolworths', 'store', null, null)).toMatchObject({
      kind: 'refused',
      reason: 'too-many-changes',
    })
  })
})
