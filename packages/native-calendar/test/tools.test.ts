// The Calendar and Reminders tools over a fake EventKit: what agents see, what they may change, and
// what is refused. Nothing here touches the Mac's real calendars.

import { describe, expect, it } from 'vitest'
import {
  type CalendarInfo,
  type EventInfo,
  type EventKit,
  EventKitError,
  type ReminderInfo,
  type SaveEvent,
  type SaveReminder,
} from '../src/helper'
import {
  calendarOutputs,
  calendarTools,
  callCalendarTool,
  callReminderTool,
  type EventKitToolDeps,
  parseWhen,
  reminderOutputs,
  reminderTools,
} from '../src/tools'

const NOW = new Date(2026, 10, 25, 9, 0).getTime()

function ev(over: Partial<EventInfo> = {}): EventInfo {
  return {
    id: 'E1',
    occurrenceMs: NOW,
    calendarId: 'home',
    title: 'Dentist',
    start: '2026-11-25T10:00:00+10:00',
    end: '2026-11-25T11:00:00+10:00',
    allDay: false,
    location: null,
    notes: null,
    url: null,
    recurring: false,
    organizer: null,
    attendees: [],
    status: 'confirmed',
    ...over,
  }
}

function rem(over: Partial<ReminderInfo> = {}): ReminderInfo {
  return {
    id: 'R1',
    listId: 'todo',
    title: 'Buy milk',
    notes: null,
    due: '2026-11-26',
    priority: 0,
    completed: false,
    completedAt: null,
    url: null,
    ...over,
  }
}

class FakeKit implements EventKit {
  calendarsOf: Record<'events' | 'reminders', CalendarInfo[]> = {
    events: [
      { id: 'home', title: 'Home', account: 'iCloud', writable: true, subscribed: false },
      { id: 'work', title: 'Work', account: 'iCloud', writable: true, subscribed: false },
      { id: 'holidays', title: 'Holidays', account: 'Other', writable: false, subscribed: true },
    ],
    reminders: [
      { id: 'todo', title: 'To do', account: 'iCloud', writable: true, subscribed: false },
      { id: 'secret', title: 'Secret', account: 'iCloud', writable: true, subscribed: false },
    ],
  }
  events_: EventInfo[] = [
    ev(),
    ev({
      id: 'E2',
      calendarId: 'work',
      title: 'Standup',
      attendees: [{ name: 'A', email: 'a@x.com', status: 'accepted', me: false }],
    }),
  ]
  reminders_: ReminderInfo[] = [rem()]
  queries: unknown[] = []
  savedEvents: SaveEvent[] = []
  savedReminders: SaveReminder[] = []
  fail: EventKitError | null = null

  async access() {
    return 'full' as const
  }
  async requestAccess() {
    return 'full' as const
  }
  async calendars(kind: 'events' | 'reminders') {
    if (this.fail !== null) throw this.fail
    return this.calendarsOf[kind]
  }
  async events(query: { calendars: readonly string[]; startMs: number; endMs: number; limit?: number }) {
    this.queries.push(query)
    return { events: this.events_.filter((e) => query.calendars.includes(e.calendarId ?? '')), more: false }
  }
  async reminders(query: { calendars: readonly string[]; completed: boolean | null }) {
    this.queries.push(query)
    return { reminders: this.reminders_.filter((r) => query.calendars.includes(r.listId ?? '')), more: false }
  }
  async saveEvent(request: SaveEvent) {
    if (this.fail !== null) throw this.fail
    this.savedEvents.push(request)
    return ev({ id: request.id ?? 'NEW', calendarId: request.calendar, title: request.title ?? 'Dentist' })
  }
  async saveReminder(request: SaveReminder) {
    this.savedReminders.push(request)
    return rem({ id: request.id ?? 'NEW', listId: request.calendar, completed: request.completed ?? false })
  }
  removed: unknown[] = []
  async removeEvent(request: { calendar: string; id: string; occurrenceMs?: number }) {
    this.removed.push(request)
    return ev({ id: request.id, calendarId: request.calendar })
  }
  async removeReminder(request: { calendar: string; id: string }) {
    this.removed.push(request)
    return rem({ id: request.id, listId: request.calendar })
  }
}

function setup(options: { writes?: boolean; allowance?: number } = {}) {
  const kit = new FakeKit()
  let left = options.allowance ?? 100
  const deps = (allowed: string[]): EventKitToolDeps => ({
    kit,
    allowed: () => new Set(allowed),
    writes: () => options.writes ?? false,
    spend: () => left-- > 0,
    now: () => NOW,
  })
  return { kit, calendar: deps(['home', 'work', 'holidays']), reminders: deps(['todo']) }
}

describe('times', () => {
  it('takes days and ISO date-times, nothing else', () => {
    expect(parseWhen('2026-11-25')).toEqual({ day: '2026-11-25' })
    expect(parseWhen('2026-02-30')).toBeNull()
    expect(parseWhen('2026-11-25T10:00:00Z')).toEqual({ ms: Date.UTC(2026, 10, 25, 10) })
    expect(parseWhen('2026-11-25T10:00')).toEqual({ ms: new Date(2026, 10, 25, 10).getTime() })
    expect(parseWhen('next tuesday')).toBeNull()
    expect(parseWhen('1764000000000')).toBeNull()
  })
})

describe('listing', () => {
  it('lists the write tools only while writes are on', () => {
    expect(calendarTools({ writes: false }).map((t) => t.declaration.name)).toEqual(['calendars', 'events'])
    expect(calendarTools({ writes: true }).map((t) => t.declaration.name)).toEqual([
      'calendars',
      'events',
      'create_event',
      'update_event',
      'delete_event',
    ])
    expect(reminderTools({ writes: false }).map((t) => t.declaration.name)).toEqual(['lists', 'search'])
    for (const t of [...calendarTools({ writes: true }), ...reminderTools({ writes: true })])
      expect(
        t.declaration.sideEffect === 'read' ||
          t.declaration.destructive === t.declaration.name.startsWith('delete'),
      ).toBe(true)
  })
})

describe('calendar', () => {
  it('shows only the calendars the person picked', async () => {
    const { calendar } = setup()
    const result = await callCalendarTool({ ...calendar, allowed: () => new Set(['home']) }, 'calendars', {})
    expect(result.status).toBe('ok')
    const out = calendarOutputs.calendars.parse((result as { output: unknown }).output)
    expect(out.calendars.map((c) => c.id)).toEqual(['home'])
    expect(out.calendars[0]?.writable).toBe(false)
  })

  it('finds events in a week from today by default, in picked calendars only', async () => {
    const { kit, calendar } = setup()
    const result = await callCalendarTool({ ...calendar, allowed: () => new Set(['home']) }, 'events', {})
    const out = calendarOutputs.events.parse((result as { output: unknown }).output)
    expect(out.events.map((e) => e.title)).toEqual(['Dentist'])
    const query = kit.queries[0] as { calendars: string[]; startMs: number; endMs: number }
    expect(query.calendars).toEqual(['home'])
    expect(query.startMs).toBe(new Date(2026, 10, 25).getTime())
    expect(query.endMs - query.startMs).toBe(7 * 86_400_000)
  })

  it('refuses a calendar that is not picked, and too long a range', async () => {
    const { calendar } = setup()
    const only = { ...calendar, allowed: () => new Set(['home']) }
    expect(await callCalendarTool(only, 'events', { calendarIds: ['work'] })).toMatchObject({
      errorClass: 'not-found',
    })
    expect(await callCalendarTool(only, 'events', { from: '2026-01-01', to: '2027-06-01' })).toMatchObject({
      errorClass: 'invalid',
    })
  })

  it('counts a day as to its end, and filters by words', async () => {
    const { kit, calendar } = setup()
    const result = await callCalendarTool(calendar, 'events', {
      from: '2026-11-25',
      to: '2026-11-25',
      text: 'stand',
    })
    const out = calendarOutputs.events.parse((result as { output: unknown }).output)
    expect(out.events.map((e) => e.title)).toEqual(['Standup'])
    const query = kit.queries[0] as { startMs: number; endMs: number }
    expect(query.endMs - query.startMs).toBe(86_400_000)
  })

  it('marks events in writable calendars editable, with others on them too, and recurring ids name the occurrence', async () => {
    const { kit, calendar } = setup({ writes: true })
    kit.events_.push(ev({ id: 'E3', recurring: true, occurrenceMs: 1_800_000_000_000 }))
    const out = calendarOutputs.events.parse(
      ((await callCalendarTool(calendar, 'events', {})) as { output: unknown }).output,
    )
    expect(out.events.find((e) => e.title === 'Standup')?.editable).toBe(true)
    expect(out.events.find((e) => e.id === 'E1')?.editable).toBe(true)
    expect(out.events.some((e) => e.id === 'E3#1800000000000')).toBe(true)
  })

  it('does not add or change anything while writes are off', async () => {
    const { kit, calendar } = setup({ writes: false })
    const add = { calendarId: 'home', title: 'X', start: '2026-11-26T10:00', end: '2026-11-26T11:00' }
    expect(await callCalendarTool(calendar, 'create_event', add)).toMatchObject({ errorClass: 'not-found' })
    expect(
      await callCalendarTool(calendar, 'update_event', { id: 'E1', calendarId: 'home', title: 'Y' }),
    ).toMatchObject({
      errorClass: 'not-found',
    })
    expect(kit.savedEvents).toEqual([])
  })

  it('adds timed and all-day events to a picked calendar', async () => {
    const { kit, calendar } = setup({ writes: true })
    const timed = await callCalendarTool(calendar, 'create_event', {
      calendarId: 'home',
      title: 'Lunch',
      start: '2026-11-26T12:00:00+10:00',
      end: '2026-11-26T13:00:00+10:00',
      location: 'Cafe',
    })
    expect(timed.status).toBe('ok')
    calendarOutputs.create_event.parse((timed as { output: unknown }).output)
    expect(kit.savedEvents[0]).toEqual({
      calendar: 'home',
      title: 'Lunch',
      start: { ms: Date.parse('2026-11-26T12:00:00+10:00') },
      end: { ms: Date.parse('2026-11-26T13:00:00+10:00') },
      location: 'Cafe',
    })
    expect(
      (
        await callCalendarTool(calendar, 'create_event', {
          calendarId: 'home',
          title: 'Leave',
          start: '2026-12-01',
          end: '2026-12-01',
        })
      ).status,
    ).toBe('ok')
    expect(kit.savedEvents[1]?.start).toEqual({ day: '2026-12-01' })
  })

  it('refuses mixed or backwards times, unpicked calendars, attendees and spent allowances', async () => {
    const { kit, calendar } = setup({ writes: true, allowance: 1 })
    const only = { ...calendar, allowed: () => new Set(['home']) }
    const base = { calendarId: 'home', title: 'X' }
    expect(
      await callCalendarTool(only, 'create_event', { ...base, start: '2026-12-01', end: '2026-12-01T10:00' }),
    ).toMatchObject({ errorClass: 'invalid' })
    expect(
      await callCalendarTool(only, 'create_event', {
        ...base,
        start: '2026-12-01T11:00',
        end: '2026-12-01T10:00',
      }),
    ).toMatchObject({ errorClass: 'invalid' })
    expect(
      await callCalendarTool(only, 'create_event', {
        ...base,
        calendarId: 'work',
        start: '2026-12-01',
        end: '2026-12-01',
      }),
    ).toMatchObject({ errorClass: 'not-found' })
    expect(
      await callCalendarTool(only, 'create_event', {
        ...base,
        start: '2026-12-01',
        end: '2026-12-01',
        attendees: ['a@b.c'],
      }),
    ).toMatchObject({ errorClass: 'invalid' })
    expect(
      (await callCalendarTool(only, 'create_event', { ...base, start: '2026-12-01', end: '2026-12-01' }))
        .status,
    ).toBe('ok')
    expect(
      await callCalendarTool(only, 'create_event', { ...base, start: '2026-12-02', end: '2026-12-02' }),
    ).toMatchObject({ errorClass: 'rate-limited' })
    expect(kit.savedEvents).toHaveLength(1)
  })

  it('changes one occurrence, and says when an event has other people on it', async () => {
    const { kit, calendar } = setup({ writes: true })
    const changed = await callCalendarTool(calendar, 'update_event', {
      id: 'E3#1800000000000',
      calendarId: 'home',
      notes: null,
    })
    expect(changed.status).toBe('ok')
    expect(kit.savedEvents[0]).toEqual({
      calendar: 'home',
      id: 'E3',
      occurrenceMs: 1_800_000_000_000,
      notes: null,
    })
    kit.fail = new EventKitError('read-only')
    expect(
      await callCalendarTool(calendar, 'update_event', { id: 'E2', calendarId: 'work', title: 'Z' }),
    ).toMatchObject({ errorClass: 'not-granted' })
  })

  it('deletes one occurrence in a picked calendar, only while writes are on', async () => {
    const off = setup({ writes: false })
    expect(
      await callCalendarTool(off.calendar, 'delete_event', { id: 'E1', calendarId: 'home' }),
    ).toMatchObject({
      errorClass: 'not-found',
    })
    const { kit, calendar } = setup({ writes: true })
    const only = { ...calendar, allowed: () => new Set(['home']) }
    const done = await callCalendarTool(only, 'delete_event', { id: 'E3#1800000000000', calendarId: 'home' })
    expect(calendarOutputs.delete_event.parse((done as { output: unknown }).output).deleted.id).toBe('E3')
    expect(kit.removed).toEqual([{ calendar: 'home', id: 'E3', occurrenceMs: 1_800_000_000_000 }])
    expect(await callCalendarTool(only, 'delete_event', { id: 'E2', calendarId: 'work' })).toMatchObject({
      errorClass: 'not-found',
    })
    expect(kit.removed).toHaveLength(1)
  })

  it('asks the person when macOS access is not given', async () => {
    const { kit, calendar } = setup()
    kit.fail = new EventKitError('denied')
    expect(await callCalendarTool(calendar, 'calendars', {})).toEqual({
      status: 'needsUser',
      reason: 'other',
    })
  })
})

describe('reminders', () => {
  it('finds open reminders in picked lists', async () => {
    const { kit, reminders } = setup()
    const result = await callReminderTool(reminders, 'search', {})
    const out = reminderOutputs.search.parse((result as { output: unknown }).output)
    expect(out.reminders.map((r) => r.title)).toEqual(['Buy milk'])
    expect(kit.queries[0]).toMatchObject({ calendars: ['todo'], completed: false })
    expect(await callReminderTool(reminders, 'search', { listIds: ['secret'] })).toMatchObject({
      errorClass: 'not-found',
    })
    const lists = reminderOutputs.lists.parse(
      ((await callReminderTool(reminders, 'lists', {})) as { output: unknown }).output,
    )
    expect(lists.lists.map((l) => l.id)).toEqual(['todo'])
  })

  it('adds, completes and clears due dates only while writes are on', async () => {
    const off = setup({ writes: false })
    expect(await callReminderTool(off.reminders, 'create', { listId: 'todo', title: 'X' })).toMatchObject({
      errorClass: 'not-found',
    })
    const { kit, reminders } = setup({ writes: true })
    const added = await callReminderTool(reminders, 'create', {
      listId: 'todo',
      title: 'Call Mum',
      due: '2026-11-27',
      priority: 'high',
    })
    expect(added.status).toBe('ok')
    expect(kit.savedReminders[0]).toEqual({
      calendar: 'todo',
      title: 'Call Mum',
      due: { day: '2026-11-27' },
      priority: 1,
    })
    const done = await callReminderTool(reminders, 'update', {
      id: 'R1',
      listId: 'todo',
      completed: true,
      due: null,
    })
    expect(reminderOutputs.update.parse((done as { output: unknown }).output).reminder.completed).toBe(true)
    expect(kit.savedReminders[1]).toEqual({ calendar: 'todo', id: 'R1', due: null, completed: true })
    const gone = await callReminderTool(reminders, 'delete', { id: 'R1', listId: 'todo' })
    expect(reminderOutputs.delete.parse((gone as { output: unknown }).output).deleted.id).toBe('R1')
    expect(await callReminderTool(reminders, 'delete', { id: 'R9', listId: 'secret' })).toMatchObject({
      errorClass: 'not-found',
    })
    expect(
      await callReminderTool(reminders, 'update', { id: 'R9', listId: 'secret', completed: true }),
    ).toMatchObject({ errorClass: 'not-found' })
  })
})
