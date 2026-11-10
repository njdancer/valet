// Remote access as the app runs it (relay.md, D41): whether it is on, the public names the tunnel
// forwards, the loopback port it forwards to, and which tools remote clients may use. The listener
// itself is mcp-server's startRemoteListener, over the same caller as the local endpoint, so
// nothing here handles a call.
//
// remote.json is the cautious side whenever it is missing or doesn't validate: remote access off,
// no names, no tools. Each tool is off for remote clients until the person turns it on, and turning
// it on records the tool's side effect then. A later version of the adapter that raises it (read to
// write, write to irreversible) turns it off again until the person looks at it, the same way an
// adapter update needs a new approval.
//
// Pausing (the tray's kill switch) is remembered: a paused Mac stays paused after a restart.
//
// Not here yet: the in-app OAuth authorisation server that mints access tokens into `tokens`, and
// the tunnel. Until they exist no remote client can get a token, so the listener refuses everything.

import type { ToolDeclaration } from '@valet/core'
import { ValetError } from '@valet/core'
import {
  type LiveSessions,
  normaliseRemoteHost,
  RemoteAccessTokens,
  type RemoteListenerOptions,
  type RemoteRefusal,
  type RunningRemoteListener,
  type ServerInfo,
  startRemoteListener,
  type ToolCall,
  type ToolCaller,
} from '@valet/mcp-server'
import { z } from 'zod'
import { JsonDocument } from './files'

type SideEffect = ToolDeclaration['sideEffect']

const RANK: Readonly<Record<SideEffect, number>> = { read: 0, write: 1, irreversible: 2 }
const MAX_HOSTS = 8

const sideEffect = z.enum(['read', 'write', 'irreversible'])
const toolName = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)
const adapterId = z.string().regex(/^[a-z][a-z0-9-]{1,63}$/)

const remoteSchema = z
  .object({
    enabled: z.boolean(),
    /** The loopback port the tunnel points at: picked at the first start and kept. */
    port: z.number().int().min(1).max(65535).nullable(),
    hosts: z.array(z.string().refine((h) => normaliseRemoteHost(h) === h)).max(MAX_HOSTS),
    tools: z.record(
      adapterId,
      z.record(toolName, z.object({ sideEffect, enabledAt: z.iso.datetime({ offset: true }) }).strict()),
    ),
  })
  .strict()

export type RemoteDocument = z.infer<typeof remoteSchema>

export const DEFAULT_REMOTE: RemoteDocument = { enabled: false, port: null, hosts: [], tools: {} }

export interface RemoteStatus {
  /** The person has remote access on (not paused). */
  readonly enabled: boolean
  /** The listener is up. Can be false while enabled, when its port couldn't be had. */
  readonly listening: boolean
  /** The loopback URL the tunnel points at, while listening. */
  readonly url: string | null
  readonly hosts: readonly string[]
  /** Remote sessions open now. */
  readonly sessions: number
  /** Remote-enabled tools, as `<adapterId>.<tool>`. */
  readonly tools: readonly string[]
}

export interface RemoteAccessDeps {
  readonly path: string
  readonly info: ServerInfo
  readonly now: () => number
  /** Something about remote access changed: its state, its sessions or its tools. */
  readonly changed: () => void
  /** Writes an audit event for a change the person made. */
  readonly audit: (
    event:
      | { readonly type: 'remote-state'; readonly state: 'on' | 'paused'; readonly revokedTokens: number }
      | {
          readonly type: 'remote-tool'
          readonly adapterId: string
          readonly tool: string
          readonly enabled: boolean
          readonly sideEffect: SideEffect
        },
  ) => Promise<void>
  /** The policy refused a remote call: audit it like the app's own refusals. */
  readonly refused: (call: ToolCall, reason: RemoteRefusal) => Promise<void>
  readonly start?: (options: RemoteListenerOptions) => Promise<RunningRemoteListener>
}

export class RemoteAccess {
  /** The access tokens the listener accepts. The authorisation server will mint into this. */
  readonly tokens: RemoteAccessTokens
  private readonly document: JsonDocument<RemoteDocument>
  private current: RemoteDocument = DEFAULT_REMOTE
  private listener: RunningRemoteListener | null = null
  private caller: ToolCaller | null = null
  /** Changes run one at a time: a pause never interleaves with a start. */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly deps: RemoteAccessDeps) {
    this.tokens = new RemoteAccessTokens({ now: deps.now })
    this.document = new JsonDocument(deps.path, remoteSchema, () => DEFAULT_REMOTE, true)
  }

  /** Reads remote.json, and starts listening if the person left remote access on. */
  start(caller: ToolCaller): Promise<void> {
    this.caller = caller
    return this.serially(async () => {
      this.current = await this.document.read()
      if (this.current.enabled) await this.listen().catch(() => undefined)
    })
  }

  /** The remote policy: on for this tool, at a side effect no higher than when it was turned on. */
  allows(adapter: string, declaration: ToolDeclaration): boolean {
    const entry = this.current.tools[adapter]?.[declaration.name]
    return entry !== undefined && RANK[declaration.sideEffect] <= RANK[entry.sideEffect]
  }

  status(): RemoteStatus {
    const tools: string[] = []
    for (const [adapter, byTool] of Object.entries(this.current.tools))
      for (const tool of Object.keys(byTool)) tools.push(`${adapter}.${tool}`)
    return {
      enabled: this.current.enabled,
      listening: this.listener !== null,
      url: this.listener?.url ?? null,
      hosts: this.current.hosts,
      sessions: this.listener?.sessions().total ?? 0,
      tools: tools.sort(),
    }
  }

  /**
   * On: starts the listener. Off is the kill switch: every access token is revoked, calls in flight
   * fail aborted, sessions close and the listener stops, before this resolves. Neither needs the
   * network. The new state is saved first, so a crash part-way leaves it paused on the next start.
   */
  setEnabled(enabled: boolean): Promise<void> {
    return this.serially(async () => {
      if (enabled === this.current.enabled && (this.listener !== null) === enabled) return
      try {
        if (!enabled) {
          const revokedTokens = this.tokens.size
          await this.save({ ...this.current, enabled: false })
          await this.unlisten()
          await this.deps
            .audit({ type: 'remote-state', state: 'paused', revokedTokens })
            .catch(() => undefined)
        } else {
          await this.save({ ...this.current, enabled: true })
          await this.deps
            .audit({ type: 'remote-state', state: 'on', revokedTokens: 0 })
            .catch(() => undefined)
          await this.listen()
        }
      } finally {
        this.deps.changed()
      }
    })
  }

  /** The public names the tunnel forwards. Each must be a DNS name; anything else is refused whole. */
  setHosts(hosts: readonly string[]): Promise<void> {
    return this.serially(async () => {
      const normalised = [...new Set(hosts.map(normaliseRemoteHost))]
      if (normalised.length > MAX_HOSTS || normalised.some((h) => h === null))
        throw new ValetError('config', 'invalid')
      await this.save({ ...this.current, hosts: normalised as string[] })
      this.deps.changed()
    })
  }

  /** Turns one tool on or off for remote clients, as it is declared now. */
  setTool(adapter: string, declaration: ToolDeclaration, enabled: boolean): Promise<void> {
    return this.serially(async () => {
      if (!adapterId.safeParse(adapter).success || !toolName.safeParse(declaration.name).success)
        throw new ValetError('config', 'invalid')
      const byTool = { ...(this.current.tools[adapter] ?? {}) }
      if (enabled) {
        byTool[declaration.name] = {
          sideEffect: declaration.sideEffect,
          enabledAt: new Date(this.deps.now()).toISOString(),
        }
      } else {
        delete byTool[declaration.name]
      }
      const tools = { ...this.current.tools, [adapter]: byTool }
      if (Object.keys(byTool).length === 0) delete tools[adapter]
      await this.save({ ...this.current, tools })
      await this.deps
        .audit({
          type: 'remote-tool',
          adapterId: adapter,
          tool: declaration.name,
          enabled,
          sideEffect: declaration.sideEffect,
        })
        .catch(() => undefined)
      this.refresh()
      this.deps.changed()
    })
  }

  /** Re-lists the tools for remote sessions, after approvals or the policy change. */
  refresh(): void {
    try {
      this.listener?.refresh()
    } catch {
      // The runtime couldn't list; every session keeps what it had.
    }
  }

  /** The app is quitting: stop listening, leaving the saved state as it is. */
  close(): Promise<void> {
    return this.serially(() => this.unlisten())
  }

  /** Remote sessions, for the tray's count. */
  sessions(): LiveSessions | null {
    return this.listener?.sessions() ?? null
  }

  private async listen(): Promise<void> {
    if (this.listener !== null || this.caller === null) return
    const start = this.deps.start ?? startRemoteListener
    this.listener = await start({
      caller: this.caller,
      policy: this,
      tokens: this.tokens,
      hosts: () => new Set(this.current.hosts),
      info: this.deps.info,
      // A kept port, so the tunnel's configuration stays right. If something else holds it, this
      // fails rather than move: the tunnel would keep forwarding to whatever has it.
      port: this.current.port ?? 0,
      refused: (call, reason) => this.deps.refused(call, reason),
      onSessionsChanged: () => this.deps.changed(),
    })
    this.listener.refresh()
    if (this.current.port !== this.listener.port)
      await this.save({ ...this.current, port: this.listener.port })
  }

  private async unlisten(): Promise<void> {
    const listener = this.listener
    this.listener = null
    // Even with no listener, tokens minted while it was down are refused from now on.
    this.tokens.revokeAll()
    await listener?.close()
  }

  private async save(next: RemoteDocument): Promise<void> {
    await this.document.update(() => next)
    this.current = next
  }

  private serially<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work)
    this.queue = run.catch(() => undefined)
    return run
  }
}
