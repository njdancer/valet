// How Valet reaches the Mac's calendars and reminders: EventKit, in the reader helper
// (swift-bridge, EventKitAccess.swift), over the same socket Mail uses. macOS lets only the helper
// use them, once the person allows it. Tests use a fake EventKit with the same answers.

import * as nodeFs from 'node:fs/promises'
import { createConnection } from 'node:net'

export type EventKitKind = 'events' | 'reminders'

/** What macOS lets the helper do: `full` is the only one that reads anything. */
export type EventKitAccess = 'full' | 'write-only' | 'denied' | 'restricted' | 'not-determined'

export type EventKitFailure =
  | 'invalid'
  | 'not-found'
  | 'denied'
  | 'read-only'
  | 'has-attendees'
  | 'unavailable'

export class EventKitError extends Error {
  constructor(readonly code: EventKitFailure) {
    super(`eventkit: ${code}`)
    this.name = 'EventKitError'
  }
}

export interface CalendarInfo {
  readonly id: string
  readonly title: string
  readonly account: string | null
  readonly writable: boolean
  /** A subscribed or birthdays calendar: nobody can add to it. */
  readonly subscribed: boolean
}

export interface Participant {
  readonly name: string | null
  readonly email: string | null
  readonly status: string
  readonly me: boolean
}

export interface EventInfo {
  readonly id: string
  readonly occurrenceMs: number
  readonly calendarId: string | null
  readonly title: string | null
  /** ISO date-time with offset, or a day (YYYY-MM-DD) for an all-day event. */
  readonly start: string
  /** The end, or for an all-day event the last day it covers. */
  readonly end: string
  readonly allDay: boolean
  readonly location: string | null
  readonly notes: string | null
  readonly url: string | null
  readonly recurring: boolean
  readonly organizer: Participant | null
  readonly attendees: readonly Participant[]
  readonly status: string
}

export interface ReminderInfo {
  readonly id: string
  readonly listId: string | null
  readonly title: string | null
  readonly notes: string | null
  /** A day (YYYY-MM-DD), an ISO date-time, or null. */
  readonly due: string | null
  /** EventKit's: 0 none, 1 high, 5 medium, 9 low. */
  readonly priority: number
  readonly completed: boolean
  readonly completedAt: string | null
  readonly url: string | null
}

/** A day or an instant, as the helper takes them. */
export type HelperTime = { readonly day: string } | { readonly ms: number }

export interface EventQuery {
  readonly calendars: readonly string[]
  readonly startMs: number
  readonly endMs: number
  /** Words in the title, location or notes, matched before the limit. */
  readonly text?: string
  readonly limit?: number
}

export interface ReminderQuery {
  readonly calendars: readonly string[]
  /** null: open and done. */
  readonly completed: boolean | null
  readonly dueStartMs?: number
  readonly dueEndMs?: number
  /** Words in the title or notes, matched before the limit. */
  readonly text?: string
  readonly limit?: number
}

export interface SaveEvent {
  readonly calendar: string
  readonly id?: string
  readonly occurrenceMs?: number
  readonly title?: string
  readonly start?: HelperTime
  readonly end?: HelperTime
  readonly location?: string | null
  readonly notes?: string | null
  readonly url?: string | null
}

export interface SaveReminder {
  readonly calendar: string
  readonly id?: string
  readonly title?: string
  readonly notes?: string | null
  readonly due?: HelperTime | null
  readonly priority?: number
  readonly completed?: boolean
  readonly url?: string | null
}

export interface EventKit {
  access(kind: EventKitKind): Promise<EventKitAccess>
  /** Asks macOS (its prompt shows); answers at once with the access before the person answers. */
  requestAccess(kind: EventKitKind): Promise<EventKitAccess>
  calendars(kind: EventKitKind): Promise<readonly CalendarInfo[]>
  events(query: EventQuery): Promise<{ readonly events: readonly EventInfo[]; readonly more: boolean }>
  reminders(
    query: ReminderQuery,
  ): Promise<{ readonly reminders: readonly ReminderInfo[]; readonly more: boolean }>
  saveEvent(request: SaveEvent): Promise<EventInfo>
  saveReminder(request: SaveReminder): Promise<ReminderInfo>
  /** Deletes an event (one occurrence of a recurring one); answers what it was. */
  removeEvent(request: {
    readonly calendar: string
    readonly id: string
    readonly occurrenceMs?: number
  }): Promise<EventInfo>
  removeReminder(request: { readonly calendar: string; readonly id: string }): Promise<ReminderInfo>
}

const ACCESS: ReadonlySet<string> = new Set(['full', 'write-only', 'denied', 'restricted', 'not-determined'])
const FAILURES: ReadonlySet<string> = new Set([
  'invalid',
  'not-found',
  'denied',
  'read-only',
  'has-attendees',
  'unavailable',
])
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 25_000

export interface SocketLike {
  write(data: string): unknown
  on(event: 'connect', listener: () => void): unknown
  on(event: 'data', listener: (chunk: Buffer) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'close', listener: () => void): unknown
  destroy(): unknown
}

export interface HelperEventKitOptions {
  readonly socketPath: string
  readonly connect?: (path: string) => SocketLike
  readonly lstat?: (path: string) => Promise<{ isSocket(): boolean; readonly uid: number }>
  readonly uid?: number
  readonly timeoutMs?: number
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export class HelperEventKit implements EventKit {
  readonly #socketPath: string
  readonly #connect: (path: string) => SocketLike
  readonly #lstat: NonNullable<HelperEventKitOptions['lstat']>
  readonly #uid: number | undefined
  readonly #timeoutMs: number

  constructor(options: HelperEventKitOptions) {
    this.#socketPath = options.socketPath
    this.#connect = options.connect ?? ((path) => createConnection({ path }))
    this.#lstat = options.lstat ?? ((path) => nodeFs.lstat(path))
    this.#uid = options.uid ?? process.getuid?.()
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  async access(kind: EventKitKind): Promise<EventKitAccess> {
    return accessOf(await this.#ask({ op: 'eventkit.status', kind }))
  }

  async requestAccess(kind: EventKitKind): Promise<EventKitAccess> {
    return accessOf(await this.#ask({ op: 'eventkit.request', kind }))
  }

  async calendars(kind: EventKitKind): Promise<readonly CalendarInfo[]> {
    const answer = await this.#ask({ op: 'eventkit.calendars', kind })
    return listOf(answer['calendars']) as unknown as CalendarInfo[]
  }

  async events(query: EventQuery) {
    const answer = await this.#ask({ op: 'eventkit.events', ...query, calendars: [...query.calendars] })
    return { events: listOf(answer['events']) as unknown as EventInfo[], more: answer['more'] === true }
  }

  async reminders(query: ReminderQuery) {
    const answer = await this.#ask({ op: 'eventkit.reminders', ...query, calendars: [...query.calendars] })
    return {
      reminders: listOf(answer['reminders']) as unknown as ReminderInfo[],
      more: answer['more'] === true,
    }
  }

  async saveEvent(request: SaveEvent): Promise<EventInfo> {
    const answer = await this.#ask({ op: 'eventkit.saveEvent', ...request })
    if (!isObject(answer['event'])) throw new EventKitError('unavailable')
    return answer['event'] as unknown as EventInfo
  }

  async saveReminder(request: SaveReminder): Promise<ReminderInfo> {
    const answer = await this.#ask({ op: 'eventkit.saveReminder', ...request })
    if (!isObject(answer['reminder'])) throw new EventKitError('unavailable')
    return answer['reminder'] as unknown as ReminderInfo
  }

  async removeEvent(request: {
    readonly calendar: string
    readonly id: string
    readonly occurrenceMs?: number
  }) {
    const answer = await this.#ask({ op: 'eventkit.removeEvent', ...request })
    if (!isObject(answer['event'])) throw new EventKitError('unavailable')
    return answer['event'] as unknown as EventInfo
  }

  async removeReminder(request: { readonly calendar: string; readonly id: string }) {
    const answer = await this.#ask({ op: 'eventkit.removeReminder', ...request })
    if (!isObject(answer['reminder'])) throw new EventKitError('unavailable')
    return answer['reminder'] as unknown as ReminderInfo
  }

  async #ask(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    try {
      const info = await this.#lstat(this.#socketPath)
      if (!info.isSocket() || (this.#uid !== undefined && info.uid !== this.#uid)) throw new Error('not ours')
    } catch {
      // Not installed, not allowed in Login Items, or not running yet.
      throw new EventKitError('unavailable')
    }
    const body = Object.fromEntries(Object.entries(request).filter(([, v]) => v !== undefined))
    const raw = await this.#send(`${JSON.stringify({ v: 1, ...body })}\n`)
    let answer: unknown
    try {
      answer = JSON.parse(raw.toString('utf8'))
    } catch {
      throw new EventKitError('unavailable')
    }
    if (!isObject(answer)) throw new EventKitError('unavailable')
    const error = answer['error']
    if (typeof error === 'string')
      throw new EventKitError(FAILURES.has(error) ? (error as EventKitFailure) : 'unavailable')
    return answer
  }

  #send(line: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      let settled = false
      let socket: SocketLike | null = null
      const finish = (outcome: Buffer | EventKitError): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket?.destroy()
        if (outcome instanceof EventKitError) reject(outcome)
        else resolve(outcome)
      }
      const timer = setTimeout(() => finish(new EventKitError('unavailable')), this.#timeoutMs)
      try {
        socket = this.#connect(this.#socketPath)
      } catch {
        finish(new EventKitError('unavailable'))
        return
      }
      socket.on('connect', () => socket?.write(line))
      socket.on('data', (chunk) => {
        if (settled) return
        const newline = chunk.indexOf(0x0a)
        const part = newline < 0 ? chunk : chunk.subarray(0, newline)
        size += part.length
        if (size > MAX_RESPONSE_BYTES) return finish(new EventKitError('unavailable'))
        chunks.push(part)
        if (newline >= 0) finish(Buffer.concat(chunks))
      })
      socket.on('error', () => finish(new EventKitError('unavailable')))
      socket.on('close', () =>
        finish(chunks.length > 0 ? Buffer.concat(chunks) : new EventKitError('unavailable')),
      )
    })
  }
}

function accessOf(answer: Record<string, unknown>): EventKitAccess {
  const access = answer['access']
  if (typeof access !== 'string' || !ACCESS.has(access)) throw new EventKitError('unavailable')
  return access as EventKitAccess
}

function listOf(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new EventKitError('unavailable')
  return value.filter(isObject)
}
