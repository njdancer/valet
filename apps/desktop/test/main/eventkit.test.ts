// @vitest-environment node
// Calendar and Reminders on this Mac (docs/calendar.md): the person's switches and picks decide what
// agents see and change, every call is audited, and setup follows macOS's answer. A fake EventKit;
// nothing touches real calendars.

import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolCall } from '@valet/mcp-server'
import { type EventKit, type EventKitAccess, EventKitError, type SaveReminder } from '@valet/native-calendar'
import type { ToolCallResult } from '@valet/runtime'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CHANGES_PER_HOUR,
  type EventKitApp,
  EventKitService,
  EventKitSettingsStore,
} from '../../src/main/core/calendar'
import type { ReaderControl } from '../../src/main/core/mail'

let root: string
const servers: Server[] = []
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'valet-eventkit-'))
})
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))))
  rmSync(root, { recursive: true, force: true })
})

async function listening(path: string): Promise<void> {
  const server = createServer((socket) => socket.end())
  servers.push(server)
  await new Promise<void>((done) => server.listen(path, done))
}

function fakeKit(access: { value: EventKitAccess }) {
  const saved: SaveReminder[] = []
  const asked: string[] = []
  const refreshed = { count: 0 }
  const kit: EventKit = {
    access: async () => access.value,
    refresh: async () => {
      refreshed.count += 1
    },
    requestAccess: async (kind) => {
      asked.push(kind)
      return access.value
    },
    calendars: async (kind) =>
      kind === 'reminders'
        ? [
            { id: 'L1', title: 'Reminders', account: 'iCloud', writable: true, subscribed: false },
            { id: 'L2', title: 'Private', account: 'iCloud', writable: true, subscribed: false },
          ]
        : [{ id: 'C1', title: 'Home', account: 'iCloud', writable: true, subscribed: false }],
    events: async () => ({ events: [], more: false }),
    reminders: async (q) => ({
      reminders: q.calendars.includes('L1')
        ? [
            {
              id: 'R1',
              listId: 'L1',
              title: 'Milk',
              notes: null,
              due: null,
              priority: 0,
              completed: false,
              completedAt: null,
              url: null,
            },
          ]
        : [],
      more: false,
    }),
    saveEvent: async () => {
      throw new Error('not here')
    },
    removeEvent: async () => {
      throw new Error('not here')
    },
    removeReminder: async () => {
      throw new Error('not here')
    },
    createCalendar: async (_kind, title) => ({
      id: 'L9',
      title,
      account: 'iCloud',
      writable: true,
      subscribed: false,
    }),
    removeCalendar: async () => {
      throw new Error('not here')
    },
    saveReminder: async (r) => {
      saved.push(r)
      return {
        id: 'R2',
        listId: r.calendar,
        title: r.title ?? null,
        notes: null,
        due: null,
        priority: 0,
        completed: false,
        completedAt: null,
        url: null,
      }
    },
  }
  return { kit, saved, asked, refreshed }
}

async function setup(app: EventKitApp = 'reminders') {
  const socketPath = join(root, 'helper.sock')
  const access = { value: 'full' as EventKitAccess }
  const { kit, saved, asked, refreshed } = fakeKit(access)
  const audited: { call: ToolCall; result: ToolCallResult }[] = []
  let started = 0
  let changed = 0
  const opened: string[] = []
  const reader: ReaderControl = {
    socketPath,
    start: async () => {
      started += 1
      return 'started'
    },
    openFullDiskAccess: async () => {},
    openLoginItems: async () => {},
    reveal: async () => {},
  }
  let now = 1_000_000
  // The calling agent's own lists (agent-access.ts): L1 to change, L2 not at all, by default.
  const lists: { items: Record<string, 'read' | 'edit'>; full: boolean } = {
    items: { L1: 'edit' },
    full: false,
  }
  const added: { call: ToolCall; id: string }[] = []
  const service = new EventKitService({
    app,
    settings: new EventKitSettingsStore(join(root, `${app}.json`)),
    reader,
    kit,
    access: () => ({ items: lists.items, full: lists.full }),
    added: async (c, id) => void added.push({ call: c, id }),
    audit: async (call, result) => void audited.push({ call, result }),
    now: () => now,
    changed: () => {
      changed += 1
    },
    openSettings: async (url) => void opened.push(url),
  })
  await service.load()
  return {
    service,
    access,
    lists,
    added,
    kit,
    saved,
    asked,
    refreshed,
    audited,
    opened,
    socketPath,
    started: () => started,
    changed: () => changed,
    tick: (ms: number) => {
      now += ms
    },
  }
}

const call = (tool: string, input: unknown): ToolCall =>
  ({ callId: 'c1', adapterId: 'reminders', tool, input, client: 'test' }) as unknown as ToolCall

describe('EventKitService', () => {
  it('adds a list only with Full access, and hands the new one to the calling agent', async () => {
    const s = await setup()
    await s.service.update({ enabled: true })
    const signal = new AbortController().signal
    expect(await s.service.call(call('create_list', { title: 'Trips' }), signal)).toMatchObject({
      errorClass: 'not-found',
    })
    s.lists.full = true
    expect(await s.service.call(call('create_list', { title: 'Trips' }), signal)).toMatchObject({
      status: 'ok',
    })
    expect(s.added.map((a) => [a.call.callId, a.id])).toEqual([['c1', 'L9']])
    expect(s.audited.map((a) => a.call.tool)).toEqual(['create_list', 'create_list'])
  })

  it('lists nothing until on, then every tool: which an agent holds follows its own access', async () => {
    const s = await setup()
    expect(s.service.listTools()).toEqual([])
    await s.service.update({ enabled: true })
    expect(s.started()).toBe(1)
    expect(s.service.listTools().map((t) => `${t.adapterId}.${t.declaration.name}`)).toEqual([
      'reminders.lists',
      'reminders.search',
      'reminders.create',
      'reminders.update',
      'reminders.delete',
      'reminders.create_list',
      'reminders.delete_list',
    ])
    expect(s.changed()).toBe(1)
  })

  it('shows and changes only the calling agent’s own lists, at its own level', async () => {
    const s = await setup()
    await s.service.update({ enabled: true })
    const signal = new AbortController().signal
    s.lists.items = { L1: 'read' }
    const shown = await s.service.call(call('lists', {}), signal)
    expect(shown).toMatchObject({ status: 'ok' })
    expect(JSON.stringify(shown)).not.toContain('L2')
    // Nothing it may change: the changing tools aren't there for it.
    expect(await s.service.call(call('create', { listId: 'L1', title: 'T' }), signal)).toMatchObject({
      errorClass: 'not-found',
    })
    // Read here, Edit there: says so, rather than that the list doesn't exist.
    s.lists.items = { L1: 'read', L2: 'edit' }
    expect(
      JSON.stringify(await s.service.call(call('create', { listId: 'L1', title: 'T' }), signal)),
    ).toContain('read-access-only')
    s.lists.items = { L1: 'edit' }
    expect(await s.service.call(call('create', { listId: 'L2', title: 'T' }), signal)).toMatchObject({
      errorClass: 'not-found',
    })
    s.lists.items = {}
    expect(await s.service.call(call('search', { listIds: ['L1'] }), signal)).toMatchObject({
      errorClass: 'not-found',
    })
    expect(s.saved).toHaveLength(0)
  })

  it('follows setup: reader, macOS access, then the lists', async () => {
    const s = await setup()
    await s.service.update({ enabled: true })
    expect((await s.service.status()).state).toBe('not-running')
    await listening(s.socketPath)
    s.access.value = 'not-determined'
    expect((await s.service.status()).state).toBe('needs-access')
    await s.service.action('request-access')
    expect(s.asked).toEqual(['reminders'])
    s.access.value = 'denied'
    expect((await s.service.status()).state).toBe('denied')
    await s.service.action('privacy-settings')
    expect(s.opened).toEqual(['x-apple.systempreferences:com.apple.preference.security?Privacy_Reminders'])
    s.access.value = 'full'
    await s.service.update({ calendars: ['L1'] })
    const ready = await s.service.status()
    expect(ready.state).toBe('ready')
    expect(ready.calendars.map((c) => [c.id, c.allowed])).toEqual([
      ['L1', true],
      ['L2', false],
    ])
  })

  it('reads only picked lists, audits every call, and caps changes per hour', async () => {
    const s = await setup()
    await s.service.update({ enabled: true })
    const signal = new AbortController().signal
    const before = s.refreshed.count
    const found = await s.service.call(call('search', {}), signal)
    // An agent call sees lists added since the last one; nothing polls in the background.
    expect(s.refreshed.count).toBe(before + 1)
    // A burst refreshes once (feedback issue #28), and again once REFRESH_EVERY_MS has passed.
    await s.service.call(call('search', {}), signal)
    expect(s.refreshed.count).toBe(before + 1)
    s.tick(10_000)
    await s.service.call(call('search', {}), signal)
    expect(s.refreshed.count).toBe(before + 2)
    expect(found).toMatchObject({ status: 'ok' })
    expect(await s.service.call(call('search', { listIds: ['L2'] }), signal)).toMatchObject({
      errorClass: 'not-found',
    })
    for (let i = 0; i < CHANGES_PER_HOUR; i++)
      expect(await s.service.call(call('create', { listId: 'L1', title: `T${i}` }), signal)).toMatchObject({
        status: 'ok',
      })
    expect(
      await s.service.call(call('create', { listId: 'L1', title: 'one too many' }), signal),
    ).toMatchObject({
      errorClass: 'rate-limited',
    })
    s.tick(3_600_001)
    expect(await s.service.call(call('create', { listId: 'L1', title: 'next hour' }), signal)).toMatchObject({
      status: 'ok',
    })
    expect(s.saved).toHaveLength(CHANGES_PER_HOUR + 1)
    expect(s.audited).toHaveLength(CHANGES_PER_HOUR + 6)

    // Off: nothing is read or written, and the call is still audited.
    await s.service.update({ enabled: false })
    expect(await s.service.call(call('search', {}), signal)).toMatchObject({
      status: 'failed',
      errorClass: 'not-found',
    })
    expect(s.audited).toHaveLength(CHANGES_PER_HOUR + 7)
  })

  it('keeps all its tools known for turning them off while off', async () => {
    const s = await setup('calendar')
    expect(s.service.adapterId).toBe('calendar')
    expect(s.service.allTools().map((t) => t.declaration.name)).toEqual([
      'calendars',
      'events',
      'create_event',
      'update_event',
      'delete_event',
      'create_calendar',
      'delete_calendar',
    ])
  })

  it('starts the reader again when it answers unavailable', async () => {
    const s = await setup()
    await s.service.update({ enabled: true, calendars: ['L1'] })
    const startedBefore = s.started()
    s.kit.calendars = async () => {
      throw new EventKitError('unavailable')
    }
    const result = await s.service.call(call('lists', {}), new AbortController().signal)
    expect(result).toMatchObject({ status: 'failed', errorClass: 'unavailable' })
    expect(s.started()).toBe(startedBefore + 1)
  })
})
