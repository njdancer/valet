// @vitest-environment node
// Calendar and Reminders on this Mac (docs/calendar.md): the person's switches and picks decide what
// agents see and change, every call is audited, and setup follows macOS's answer. A fake EventKit;
// nothing touches real calendars.

import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolCall } from '@valet/mcp-server'
import type { EventKit, EventKitAccess, SaveReminder } from '@valet/native-calendar'
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
  const kit: EventKit = {
    access: async () => access.value,
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
  return { kit, saved, asked }
}

async function setup(app: EventKitApp = 'reminders') {
  const socketPath = join(root, 'helper.sock')
  const access = { value: 'full' as EventKitAccess }
  const { kit, saved, asked } = fakeKit(access)
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
  const service = new EventKitService({
    app,
    settings: new EventKitSettingsStore(join(root, `${app}.json`)),
    reader,
    kit,
    audit: async (call, result) => void audited.push({ call, result }),
    now: () => now,
    changed: () => void (changed += 1),
    openSettings: async (url) => void opened.push(url),
  })
  await service.load()
  return {
    service,
    access,
    saved,
    asked,
    audited,
    opened,
    socketPath,
    started: () => started,
    changed: () => changed,
    tick: (ms: number) => void (now += ms),
  }
}

const call = (tool: string, input: unknown): ToolCall =>
  ({ callId: 'c1', adapterId: 'reminders', tool, input, client: 'test' }) as unknown as ToolCall

describe('EventKitService', () => {
  it('lists nothing until on with something picked, and writes only with their switch', async () => {
    const s = await setup()
    expect(s.service.listTools()).toEqual([])
    await s.service.update({ enabled: true })
    expect(s.started()).toBe(1)
    expect(s.service.listTools()).toEqual([])
    await s.service.update({ calendars: ['L1'] })
    expect(s.service.listTools().map((t) => `${t.adapterId}.${t.declaration.name}`)).toEqual([
      'reminders.lists',
      'reminders.search',
    ])
    await s.service.update({ writes: true })
    expect(s.service.listTools().map((t) => t.declaration.name)).toEqual([
      'lists',
      'search',
      'create',
      'update',
    ])
    expect(s.changed()).toBe(3)
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
    await s.service.update({ enabled: true, calendars: ['L1'], writes: true })
    const signal = new AbortController().signal
    const found = await s.service.call(call('search', {}), signal)
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
    expect(s.audited).toHaveLength(CHANGES_PER_HOUR + 4)

    // Off: nothing is read or written, and the call is still audited.
    await s.service.update({ enabled: false })
    expect(await s.service.call(call('search', {}), signal)).toMatchObject({
      status: 'failed',
      errorClass: 'not-found',
    })
    expect(s.audited).toHaveLength(CHANGES_PER_HOUR + 5)
  })

  it('keeps all its tools known for turning them off while off', async () => {
    const s = await setup('calendar')
    expect(s.service.adapterId).toBe('calendar')
    expect(s.service.allTools().map((t) => t.declaration.name)).toEqual([
      'calendars',
      'events',
      'create_event',
      'update_event',
    ])
  })
})
