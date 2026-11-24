// Calendar and Reminders on this Mac (docs/calendar.md): the person's switches and picks, the setup
// state for Settings, and the built-in tools as NativeTools for the caller. EventKit itself is in
// the reader helper (@valet/native-calendar talks to it); this file decides what is on.
//
// Each is off until the person turns it on and picks calendars (or lists). Adding and changing is a
// second switch. Nothing is ever deleted, and nothing is sent to anyone.

import { lstat } from 'node:fs/promises'
import type { ListedTool, ToolCall } from '@valet/mcp-server'
import {
  CALENDAR_ADAPTER_ID,
  CALENDAR_ADAPTER_NAME,
  calendarTools,
  callCalendarTool,
  callReminderTool,
  type EventKit,
  EventKitError,
  type EventKitKind,
  REMINDERS_ADAPTER_ID,
  REMINDERS_ADAPTER_NAME,
  reminderTools,
} from '@valet/native-calendar'
import type { ToolCallResult } from '@valet/runtime'
import { z } from 'zod'
import type {
  EventKitAction,
  EventKitSettings,
  EventKitSettingsPatch,
  EventKitStatus,
} from '../../shared/api'
import type { NativeTools } from './caller'
import { JsonDocument } from './files'
import { openWith, type ReaderControl } from './mail'

export type { EventKitAction, EventKitSettings, EventKitSettingsPatch, EventKitStatus }

export const DEFAULT_EVENTKIT_SETTINGS: EventKitSettings = { enabled: false, calendars: [], writes: false }

/** Changes agents may make in an hour, all agents together, for each of Calendar and Reminders. */
export const CHANGES_PER_HOUR = 100

const calendarId = z.string().min(1).max(200)

const settingsSchema = z
  .object({ enabled: z.boolean(), calendars: z.array(calendarId).max(200), writes: z.boolean() })
  .strict()

export const eventKitSettingsPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    calendars: z.array(calendarId).max(200).optional(),
    writes: z.boolean().optional(),
  })
  .strict()

export const EVENTKIT_KINDS = ['calendar', 'reminders'] as const
export type EventKitApp = (typeof EVENTKIT_KINDS)[number]

const PRIVACY_URL: Readonly<Record<EventKitKind, string>> = {
  events: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars',
  reminders: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Reminders',
}

export class EventKitSettingsStore {
  private readonly document: JsonDocument<EventKitSettings>

  constructor(path: string) {
    // An unreadable file reads as off, the cautious side.
    this.document = new JsonDocument(path, settingsSchema, () => DEFAULT_EVENTKIT_SETTINGS, true)
  }

  get(): Promise<EventKitSettings> {
    return this.document.read()
  }

  set(patch: EventKitSettingsPatch): Promise<EventKitSettings> {
    const checked = eventKitSettingsPatchSchema.parse(patch)
    return this.document.update((current) => ({
      ...current,
      ...Object.fromEntries(Object.entries(checked).filter(([, v]) => v !== undefined)),
    }))
  }
}

export interface EventKitServiceDeps {
  readonly app: EventKitApp
  readonly settings: EventKitSettingsStore
  /** Null: this build has no reader helper. */
  readonly reader: ReaderControl | null
  readonly kit: EventKit | null
  readonly audit: (call: ToolCall, result: ToolCallResult, durationMs: number) => Promise<void>
  readonly now: () => number
  /** Tells the app the tool list changed. */
  readonly changed: () => void
  /** Opens System Settings at a privacy pane; /usr/bin/open by default. */
  readonly openSettings?: (url: string) => Promise<void>
}

export class EventKitService implements NativeTools {
  readonly adapterId: string
  private readonly adapterName: string
  private readonly kind: EventKitKind
  private current: EventKitSettings = DEFAULT_EVENTKIT_SETTINGS
  /** When each change of the last hour happened, oldest first. */
  private changes: number[] = []

  constructor(private readonly deps: EventKitServiceDeps) {
    const calendar = deps.app === 'calendar'
    this.adapterId = calendar ? CALENDAR_ADAPTER_ID : REMINDERS_ADAPTER_ID
    this.adapterName = calendar ? CALENDAR_ADAPTER_NAME : REMINDERS_ADAPTER_NAME
    this.kind = calendar ? 'events' : 'reminders'
  }

  /** Reads the saved settings; call once at start. */
  async load(): Promise<void> {
    this.current = await this.deps.settings.get()
    if (this.current.enabled) await this.deps.reader?.start().catch(() => 'failed')
  }

  /** Every tool this can list, writes included: for turning one off for remote agents while off. */
  allTools() {
    return this.deps.app === 'calendar' ? calendarTools({ writes: true }) : reminderTools({ writes: true })
  }

  listTools(): readonly ListedTool[] {
    if (!this.current.enabled || this.current.calendars.length === 0 || this.deps.kit === null) return []
    const writes = this.current.writes
    const tools = this.deps.app === 'calendar' ? calendarTools({ writes }) : reminderTools({ writes })
    return tools.map((tool) => ({
      adapterId: this.adapterId,
      adapterName: this.adapterName,
      declaration: tool.declaration,
      input: tool.input,
      output: tool.output,
    }))
  }

  async call(call: ToolCall, signal: AbortSignal): Promise<ToolCallResult> {
    const started = this.deps.now()
    let result: ToolCallResult
    const kit = this.deps.kit
    if (signal.aborted) result = { status: 'failed', stage: 'tool-run', errorClass: 'aborted' }
    else if (kit === null || !this.current.enabled)
      result = { status: 'failed', stage: 'config', errorClass: 'not-found' }
    else {
      const deps = {
        kit,
        allowed: () => new Set(this.current.enabled ? this.current.calendars : []),
        writes: () => this.current.enabled && this.current.writes,
        spend: () => this.spend(),
        now: this.deps.now,
      }
      result =
        this.deps.app === 'calendar'
          ? await callCalendarTool(deps, call.tool, call.input)
          : await callReminderTool(deps, call.tool, call.input)
    }
    await this.deps.audit(call, result, Math.max(0, this.deps.now() - started)).catch(() => undefined)
    return result
  }

  private spend(): boolean {
    const now = this.deps.now()
    this.changes = this.changes.filter((t) => now - t < 3_600_000)
    if (this.changes.length >= CHANGES_PER_HOUR) return false
    this.changes.push(now)
    return true
  }

  async status(): Promise<EventKitStatus> {
    const settings = this.current
    const off = (state: EventKitStatus['state']): EventKitStatus => ({
      state: settings.enabled ? state : 'off',
      settings,
      calendars: [],
    })
    if (this.deps.reader === null || this.deps.kit === null) return off('no-reader')
    let running = false
    try {
      running = (await lstat(this.deps.reader.socketPath)).isSocket()
    } catch {
      running = false
    }
    if (!running) return off('not-running')
    let access: string
    try {
      access = await this.deps.kit.access(this.kind)
    } catch (error) {
      // An older reader answers Mail's questions but not these: it needs rebuilding.
      if (error instanceof EventKitError && error.code === 'invalid') return off('no-reader')
      return off('not-running')
    }
    if (access === 'not-determined' || access === 'write-only') return off('needs-access')
    if (access !== 'full') return off('denied')
    try {
      const all = await this.deps.kit.calendars(this.kind)
      const allowed = new Set(settings.calendars)
      return {
        state: settings.enabled ? 'ready' : 'off',
        settings,
        calendars: all.map((c) => ({
          id: c.id,
          title: c.title,
          account: c.account,
          writable: c.writable && !c.subscribed,
          allowed: allowed.has(c.id),
        })),
      }
    } catch {
      return off('not-running')
    }
  }

  async update(patch: EventKitSettingsPatch): Promise<EventKitStatus> {
    const before = this.current
    this.current = await this.deps.settings.set(patch)
    if (this.current.enabled && !before.enabled) await this.deps.reader?.start().catch(() => 'failed')
    if (
      before.enabled !== this.current.enabled ||
      before.writes !== this.current.writes ||
      before.calendars.join() !== this.current.calendars.join()
    )
      this.deps.changed()
    return this.status()
  }

  /** The setup screen's buttons. */
  async action(action: EventKitAction): Promise<void> {
    if (action === 'start-reader') await this.deps.reader?.start()
    else if (action === 'request-access') await this.deps.kit?.requestAccess(this.kind)
    else {
      const open = this.deps.openSettings ?? (async (url: string) => void (await openWith([url])))
      await open(PRIVACY_URL[this.kind])
    }
  }
}
