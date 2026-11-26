// Messages on this Mac (docs/messages.md): the person's switch, the conversations they hide, whether
// one-time codes are hidden, the reader's setup state for Settings, and the built-in Messages tools
// as NativeTools for the caller. Everything that reads chat.db is in @valet/native-messages; this
// file decides what is on.
//
// Off until the person turns it on. Then agents see every conversation except those the person
// hides (Nick, 2026-11-26), and never a message that looks like a one-time code unless the person
// turns that rule off. Nothing here sends or changes a message. Every call is audited.

import { lstat } from 'node:fs/promises'
import type { ListedTool, ToolCall } from '@valet/mcp-server'
import type { Rendered, RenderRequest } from '@valet/native-mail'
import {
  callMessagesTool,
  MAX_HIDDEN,
  MESSAGES_ADAPTER_ID,
  MESSAGES_ADAPTER_NAME,
  type MessagesFiles,
  MessagesFilesError,
  MessagesStore,
  MessagesStoreError,
  messagesTools,
} from '@valet/native-messages'
import type { ToolCallResult } from '@valet/runtime'
import { z } from 'zod'
import type {
  MessagesAction,
  MessagesSettings,
  MessagesSettingsPatch,
  MessagesStatus,
} from '../../shared/api'
import type { NativeTools } from './caller'
import { JsonDocument } from './files'
import type { ReaderControl } from './mail'

export type { MessagesAction, MessagesSettings, MessagesSettingsPatch, MessagesStatus }

export const DEFAULT_MESSAGES_SETTINGS: MessagesSettings = { enabled: false, hidden: [], hideCodes: true }

const chatId = z.string().min(1).max(300)

const settingsSchema = z
  .object({
    enabled: z.boolean(),
    hidden: z.array(chatId).max(MAX_HIDDEN),
    hideCodes: z.boolean().default(true),
  })
  .strict()

export const messagesSettingsPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    hidden: z.array(chatId).max(MAX_HIDDEN).optional(),
    hideCodes: z.boolean().optional(),
  })
  .strict()

export class MessagesSettingsStore {
  private readonly document: JsonDocument<MessagesSettings>

  constructor(path: string) {
    // An unreadable file reads as off, the cautious side.
    this.document = new JsonDocument(path, settingsSchema, () => DEFAULT_MESSAGES_SETTINGS, true)
  }

  get(): Promise<MessagesSettings> {
    return this.document.read()
  }

  set(patch: MessagesSettingsPatch): Promise<MessagesSettings> {
    const checked = messagesSettingsPatchSchema.parse(patch)
    return this.document.update((current) => ({
      ...current,
      ...Object.fromEntries(Object.entries(checked).filter(([, v]) => v !== undefined)),
    }))
  }
}

export interface MessagesServiceDeps {
  readonly settings: MessagesSettingsStore
  /** Null: this build has no reader helper. */
  readonly reader: ReaderControl | null
  readonly files: MessagesFiles | null
  /** Pictures of images (native-mail's render.ts). Absent: images go as they are. */
  readonly render?: (bytes: Buffer, request: RenderRequest) => Promise<Rendered | null>
  readonly audit: (call: ToolCall, result: ToolCallResult, durationMs: number) => Promise<void>
  readonly now: () => number
  /** Tells the app the tool list changed. */
  readonly changed: () => void
}

/** Conversations the settings screen lists, newest first. */
const LISTED_CHATS = 300

export class MessagesService implements NativeTools {
  readonly adapterId = MESSAGES_ADAPTER_ID
  private current: MessagesSettings = DEFAULT_MESSAGES_SETTINGS
  private readonly store: MessagesStore | null

  constructor(private readonly deps: MessagesServiceDeps) {
    this.store =
      deps.files === null
        ? null
        : new MessagesStore(deps.files, {
            hidden: () => new Set(this.current.hidden),
            hideCodes: () => this.current.hideCodes,
            now: deps.now,
          })
  }

  /** Reads the saved settings; call once at start. */
  async load(): Promise<void> {
    this.current = await this.deps.settings.get()
    if (this.current.enabled) await this.deps.reader?.start().catch(() => 'failed')
  }

  /** Every tool this can list: for turning one off for remote agents while Messages is off. */
  allTools() {
    return messagesTools()
  }

  listTools(): readonly ListedTool[] {
    if (!this.current.enabled || this.store === null) return []
    return messagesTools().map((tool) => ({
      adapterId: MESSAGES_ADAPTER_ID,
      adapterName: MESSAGES_ADAPTER_NAME,
      declaration: tool.declaration,
      input: tool.input,
      output: tool.output,
    }))
  }

  async call(call: ToolCall, signal: AbortSignal): Promise<ToolCallResult> {
    const started = this.deps.now()
    let result: ToolCallResult
    if (signal.aborted) result = { status: 'failed', stage: 'tool-run', errorClass: 'aborted' }
    else if (this.store === null || !this.current.enabled)
      result = { status: 'failed', stage: 'config', errorClass: 'not-found' }
    else
      result = await callMessagesTool(
        { store: this.store, ...(this.deps.render === undefined ? {} : { render: this.deps.render }) },
        call.tool,
        call.input,
      )
    await this.deps.audit(call, result, Math.max(0, this.deps.now() - started)).catch(() => undefined)
    return result
  }

  async status(): Promise<MessagesStatus> {
    const settings = this.current
    const off = (state: MessagesStatus['state']): MessagesStatus => ({
      state: settings.enabled ? state : 'off',
      settings,
      chats: [],
    })
    if (this.deps.reader === null || this.deps.files === null || this.store === null) return off('no-reader')
    let running = false
    try {
      running = (await lstat(this.deps.reader.socketPath)).isSocket()
    } catch {
      running = false
    }
    if (!running) return off('not-running')
    try {
      const info = await this.deps.files.info()
      if (!info.chat) return off('needs-access')
    } catch (error) {
      // A reader from before the Messages tools answers Mail's questions but not these.
      if (error instanceof MessagesFilesError && error.code === 'invalid') return off('no-reader')
      return off('not-running')
    }
    try {
      const hidden = new Set(settings.hidden)
      const all = await this.store.allChats(LISTED_CHATS)
      return {
        state: settings.enabled ? 'ready' : 'off',
        settings,
        chats: all.map((c) => ({
          id: c.id,
          name: c.name,
          detail: c.group ? `${c.handles.length + 1} people` : c.name === c.id ? null : c.id,
          last: c.last,
          hidden: hidden.has(c.id),
        })),
      }
    } catch (error) {
      if (error instanceof MessagesStoreError && error.code === 'unsupported')
        return { state: 'unsupported', settings, chats: [] }
      return off('needs-access')
    }
  }

  async update(patch: MessagesSettingsPatch): Promise<MessagesStatus> {
    const before = this.current
    this.current = await this.deps.settings.set(patch)
    if (this.current.enabled && !before.enabled) await this.deps.reader?.start().catch(() => 'failed')
    // Hiding a conversation or the codes rule is read on every call; only on and off change the list.
    if (before.enabled !== this.current.enabled) this.deps.changed()
    return this.status()
  }

  /** The setup screen's buttons. */
  async action(action: MessagesAction): Promise<void> {
    const reader = this.deps.reader
    if (reader === null) return
    if (action === 'start-reader') await reader.start()
    else if (action === 'full-disk-access') await reader.openFullDiskAccess()
    else await reader.reveal()
  }
}
