// Mail on this Mac (docs/mail.md): the person's switch and choices, the reader helper's state for
// the setup screen, and Valet's built-in Mail tools as NativeTools for the caller. Everything that
// reads Mail's files is in @valet/native-mail; this file only decides what is on and who may see it.
//
// Off until the person turns it on and picks the accounts agents may read. Drafts are a second,
// separate switch. Nothing here sends mail.

import { execFile } from 'node:child_process'
import { lstat } from 'node:fs/promises'
import type { ListedTool, ToolCall } from '@valet/mcp-server'
import {
  callMailTool,
  type DraftApproval,
  MAIL_ADAPTER_ID,
  MAIL_ADAPTER_NAME,
  type MailDrafts,
  type MailFiles,
  MailFilesError,
  type MailOrganizer,
  MailStore,
  MailStoreError,
  type MoveRecord,
  mailTools,
} from '@valet/native-mail'
import type { ToolCallResult } from '@valet/runtime'
import { z } from 'zod'
import type { MailSettings, MailSettingsPatch, MailStatus } from '../../shared/api'
import type { NativeTools } from './caller'
import { JsonDocument } from './files'

export const DEFAULT_MAIL_SETTINGS: MailSettings = {
  enabled: false,
  accounts: [],
  drafts: false,
  approveDrafts: false,
  organize: false,
}

/** Messages agents may move in an hour, all agents together: a confused one can't empty a mailbox. */
export const MOVES_PER_HOUR = 500

const accountId = z.string().regex(/^(local|[A-Za-z0-9-]{1,64})$/)

const mailSettingsSchema = z
  .object({
    enabled: z.boolean(),
    accounts: z.array(accountId).max(100),
    drafts: z.boolean(),
    approveDrafts: z.boolean().default(false),
    organize: z.boolean().default(false),
  })
  .strict()

export const mailSettingsPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    accounts: z.array(accountId).max(100).optional(),
    drafts: z.boolean().optional(),
    approveDrafts: z.boolean().optional(),
    organize: z.boolean().optional(),
  })
  .strict()

export type { MailSettings, MailSettingsPatch, MailStatus }

export class MailSettingsStore {
  private readonly document: JsonDocument<MailSettings>

  constructor(path: string) {
    // An unreadable file reads as off, the cautious side.
    this.document = new JsonDocument(path, mailSettingsSchema, () => DEFAULT_MAIL_SETTINGS, true)
  }

  get(): Promise<MailSettings> {
    return this.document.read()
  }

  set(patch: MailSettingsPatch): Promise<MailSettings> {
    const checked = mailSettingsPatchSchema.parse(patch)
    return this.document.update((current) => ({
      ...current,
      ...Object.fromEntries(Object.entries(checked).filter(([, v]) => v !== undefined)),
    }))
  }
}

/** How Valet starts the reader helper and sends the person to its settings. */
export interface ReaderControl {
  /** The socket the helper listens on. */
  readonly socketPath: string
  /** Starts (or registers) it. `requires-approval`: the person must allow it in Login Items. */
  start(): Promise<'started' | 'requires-approval' | 'failed'>
  /** Opens System Settings at Full Disk Access. */
  openFullDiskAccess(): Promise<void>
  /** Opens System Settings at Login Items. */
  openLoginItems(): Promise<void>
  /** Shows the helper in Finder, to drag into the Full Disk Access list. */
  reveal(): Promise<void>
}

export const FULL_DISK_ACCESS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'
export const LOGIN_ITEMS_URL = 'x-apple.systempreferences:com.apple.LoginItems-Settings.extension'

/** /usr/bin/open with fixed arguments. */
export function openWith(args: readonly string[]): Promise<number> {
  return new Promise((resolve) => {
    execFile('/usr/bin/open', [...args], { timeout: 15_000 }, (error) =>
      resolve(error === null ? 0 : typeof error.code === 'number' ? error.code : 1),
    )
  })
}

function run(file: string, args: readonly string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(file, [...args], { timeout: 15_000, maxBuffer: 4096 }, (error, stdout) =>
      resolve({
        code: error === null ? 0 : typeof error.code === 'number' ? error.code : 1,
        stdout: String(stdout),
      }),
    )
  })
}

/** A packaged app: the helper is a launch agent inside Valet.app, registered with SMAppService. */
export function agentReader(binary: string, socketPath: string): ReaderControl {
  return {
    socketPath,
    async start() {
      const { code, stdout } = await run(binary, ['register'])
      const state = stdout.trim()
      if (state === 'enabled') return 'started'
      if (state === 'requires-approval') return 'requires-approval'
      return code === 0 ? 'started' : 'failed'
    },
    openFullDiskAccess: async () => void (await openWith([FULL_DISK_ACCESS_URL])),
    openLoginItems: async () => void (await openWith([LOGIN_ITEMS_URL])),
    reveal: async () => void (await openWith(['-R', binary])),
  }
}

/**
 * A development build: "Valet Reader.app" (swift-bridge/build-helper-apps.sh), started through
 * LaunchServices so it is responsible for itself and Full Disk Access names it, not Valet.
 */
export function bundleReader(bundle: string, label: string, socketPath: string): ReaderControl {
  return {
    socketPath,
    async start() {
      const code = await openWith(['-g', '-j', '-a', bundle, '--args', 'serve', label])
      return code === 0 ? 'started' : 'failed'
    },
    openFullDiskAccess: async () => void (await openWith([FULL_DISK_ACCESS_URL])),
    openLoginItems: async () => void (await openWith([LOGIN_ITEMS_URL])),
    reveal: async () => void (await openWith(['-R', bundle])),
  }
}

export interface MailServiceDeps {
  readonly settings: MailSettingsStore
  /** Null: this build has no reader helper. */
  readonly reader: ReaderControl | null
  readonly files: MailFiles | null
  readonly drafts: Pick<MailDrafts, 'save'>
  /** Moves and marks messages through Mail. Absent: agents can't organise mail in this build. */
  readonly organizer?: Pick<MailOrganizer, 'apply'> & Partial<Pick<MailOrganizer, 'source'>>
  /** A PDF attachment's text. Absent: agents get PDFs' names only. */
  readonly pdfText?: (bytes: Buffer) => Promise<string | null>
  /** Records the messages a call moved (the audit log, which Undo reads). */
  readonly moved?: (moves: readonly MoveRecord[], call: ToolCall) => Promise<void>
  /** Audits a call and its end, as the runtime does for an adapter's tools. */
  readonly audit: (call: ToolCall, result: ToolCallResult, durationMs: number) => Promise<void>
  readonly now: () => number
  /** Tells the app the tool list changed (the endpoint re-lists). */
  readonly changed: () => void
  /** Asks the person about one draft. Absent: drafts are never asked about. */
  readonly approveDraft?: (
    draft: DraftApproval,
    call: ToolCall,
  ) => Promise<'approved' | 'declined' | 'timed-out'>
}

export class MailService implements NativeTools {
  readonly adapterId = MAIL_ADAPTER_ID
  private current: MailSettings = DEFAULT_MAIL_SETTINGS
  private readonly store: MailStore | null
  /** When each move of the last hour happened, oldest first. */
  private moves: number[] = []

  constructor(private readonly deps: MailServiceDeps) {
    this.store =
      deps.files === null
        ? null
        : new MailStore(deps.files, {
            allowedAccounts: () => new Set(this.current.enabled ? this.current.accounts : []),
            ...(deps.pdfText === undefined ? {} : { pdfText: deps.pdfText }),
            ...(deps.organizer?.source === undefined
              ? {}
              : {
                  fetchSource: async (message) => {
                    const outcome = await deps.organizer?.source?.(message)
                    return outcome?.kind === 'done' ? outcome.source : null
                  },
                }),
          })
  }

  /** Reads the saved settings; call once at start. */
  async load(): Promise<void> {
    this.current = await this.deps.settings.get()
    if (this.current.enabled) await this.deps.reader?.start().catch(() => 'failed')
  }

  listTools(): readonly ListedTool[] {
    if (!this.current.enabled || this.current.accounts.length === 0 || this.store === null) return []
    return mailTools({ drafts: this.current.drafts, organize: this.organizing() }).map((tool) => ({
      adapterId: MAIL_ADAPTER_ID,
      adapterName: MAIL_ADAPTER_NAME,
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
    else {
      const approve = this.deps.approveDraft
      result = await callMailTool(
        {
          store: this.store,
          drafts: this.deps.drafts,
          draftsEnabled: () => this.current.drafts,
          approveDraft:
            approve === undefined
              ? null
              : () => (this.current.approveDrafts ? (draft) => approve(draft, call) : null),
          ...(this.deps.organizer === undefined
            ? {}
            : {
                organize: {
                  organizer: this.deps.organizer,
                  enabled: () => this.organizing(),
                  spend: (count: number) => this.spendMoves(count),
                  moved: async (moves: readonly MoveRecord[]) => {
                    await this.deps.moved?.(moves, call)
                  },
                },
              }),
        },
        call.tool,
        call.input,
      )
    }
    await this.deps.audit(call, result, Math.max(0, this.deps.now() - started)).catch(() => undefined)
    return result
  }

  /** Whether agents may move and mark messages now: the person's switch, in a build that can. */
  private organizing(): boolean {
    return this.current.organize && this.deps.organizer !== undefined
  }

  private spendMoves(count: number): boolean {
    const now = this.deps.now()
    this.moves = this.moves.filter((t) => now - t < 3_600_000)
    if (this.moves.length + count > MOVES_PER_HOUR) return false
    for (let i = 0; i < count; i++) this.moves.push(now)
    return true
  }

  /**
   * Moves messages back where an earlier move took them from (the person's Undo in Activity), as
   * recorded. Not an agent's tool, and not counted against the hour's moves.
   */
  async undoMoves(moves: readonly MoveRecord[]): Promise<'done' | 'not-found' | 'not-allowed' | 'failed'> {
    if (this.deps.organizer === undefined || moves.length === 0) return 'failed'
    let all = true
    for (const back of new Set(moves.map((m) => m.from))) {
      const group = moves.filter((m) => m.from === back)
      const outcome = await this.deps.organizer.apply({
        kind: 'move',
        // Its id changed with the move, so a message without a Message-ID is found by what it is.
        items: group.map((m) => ({
          messageId: m.messageId,
          accountId: m.accountId,
          mailbox: m.to,
          subject: m.subject,
          sender: m.sender,
          date: m.date,
        })),
        to: back,
      })
      if (outcome.kind === 'not-allowed') return 'not-allowed'
      if (outcome.kind !== 'done') return 'failed'
      if (outcome.results.some((r) => r !== 'done')) all = false
    }
    return all ? 'done' : 'not-found'
  }

  async status(): Promise<MailStatus> {
    const settings = this.current
    if (this.deps.reader === null || this.deps.files === null || this.store === null) {
      return { state: settings.enabled ? 'no-reader' : 'off', settings, accounts: [] }
    }
    let running = false
    try {
      running = (await lstat(this.deps.reader.socketPath)).isSocket()
    } catch {
      running = false
    }
    if (!running) return { state: settings.enabled ? 'not-running' : 'off', settings, accounts: [] }
    try {
      await this.deps.files.library()
      const all = await this.store.allAccounts()
      const allowed = new Set(settings.accounts)
      return {
        state: settings.enabled ? 'ready' : 'off',
        settings,
        accounts: all.map((a) => ({ ...a, allowed: allowed.has(a.id) })),
      }
    } catch (error) {
      if (error instanceof MailStoreError && error.code === 'unsupported')
        return { state: 'unsupported', settings, accounts: [] }
      if (error instanceof MailFilesError || error instanceof MailStoreError)
        return { state: settings.enabled ? 'needs-access' : 'off', settings, accounts: [] }
      throw error
    }
  }

  async update(patch: MailSettingsPatch): Promise<MailStatus> {
    const before = this.current
    this.current = await this.deps.settings.set(patch)
    if (this.current.enabled && !before.enabled) await this.deps.reader?.start().catch(() => 'failed')
    if (
      before.enabled !== this.current.enabled ||
      before.drafts !== this.current.drafts ||
      before.organize !== this.current.organize ||
      before.accounts.join() !== this.current.accounts.join()
    )
      this.deps.changed()
    return this.status()
  }

  /** The setup screen's buttons. */
  async startReader(): Promise<'started' | 'requires-approval' | 'failed' | 'no-reader'> {
    return this.deps.reader === null ? 'no-reader' : this.deps.reader.start()
  }

  async openFullDiskAccess(): Promise<void> {
    await this.deps.reader?.openFullDiskAccess()
  }

  async openLoginItems(): Promise<void> {
    await this.deps.reader?.openLoginItems()
  }

  async revealReader(): Promise<void> {
    await this.deps.reader?.reveal()
  }
}
