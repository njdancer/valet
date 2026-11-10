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
// The in-app OAuth authorisation server (mcp-server's RemoteAuthorization) answers on the same
// listener and mints into `tokens`. Its client registrations and grants, secrets hashed, are kept in
// remote-clients.json, so pausing and restarting keep every connector; access tokens are memory
// only. Consent is answered here, by the person typing the code their browser shows (relay.md,
// "Consent happens on the Mac"); a client may then call only the remote-enabled tools they ticked.
// Not here yet: the tunnel (D14: Cloudflare Tunnel, which the person runs themselves).

import type { ToolDeclaration } from '@valet/core'
import { ValetError } from '@valet/core'
import {
  type ConsentPrompt,
  type ConsentRequest,
  ConsentRequests,
  EMPTY_REMOTE_CLIENTS,
  type LiveSessions,
  normaliseRemoteHost,
  RemoteAccessTokens,
  RemoteAuthorization,
  type RemoteClientInfo,
  RemoteClients,
  type RemoteClientsState,
  type RemoteListenerOptions,
  type RemoteRefusal,
  type RunningRemoteListener,
  remoteClientsStateSchema,
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
  /** Client registrations kept, consented or not. */
  readonly clients: number
  /** Consent requests waiting for the person. */
  readonly pendingConsents: number
}

/** A tool the consent window offers to tick: remote-enabled now. */
export interface ConsentTool {
  /** `<adapterId>.<tool>`. */
  readonly ref: string
  readonly adapterId: string
  readonly tool: string
  readonly sideEffect: SideEffect
}

export interface ConsentView {
  /** Pending requests, oldest first. Never their codes. */
  readonly requests: readonly ConsentPrompt[]
  /** What can be granted. `write` and `irreversible` tools start unticked; `read` ones ticked. */
  readonly tools: readonly ConsentTool[]
}

/** How typing a code went. */
export type ConsentAnswer = 'approved' | 'wrong-code' | 'cancelled'

type RemoteAuditEvent =
  | { readonly type: 'remote-state'; readonly state: 'on' | 'paused'; readonly revokedTokens: number }
  | {
      readonly type: 'remote-tool'
      readonly adapterId: string
      readonly tool: string
      readonly enabled: boolean
      readonly sideEffect: SideEffect
    }
  | {
      readonly type: 'remote-consent'
      readonly clientId: string
      readonly clientHost: string
      readonly source: string | null
      readonly tools: readonly string[]
      readonly answer: 'approved' | 'declined' | 'expired' | 'cancelled'
    }
  | { readonly type: 'remote-revoked'; readonly clientId: string | null; readonly clients: number }
  | { readonly type: 'remote-token-reuse'; readonly clientId: string; readonly token: 'refresh' | 'code' }

export interface RemoteAccessDeps {
  readonly path: string
  readonly info: ServerInfo
  readonly now: () => number
  /** Something about remote access changed: its state, its sessions or its tools. */
  readonly changed: () => void
  /** Where client registrations and grants are kept. */
  readonly clientsPath: string
  /** Writes an audit event for a change the person made, or one the authorisation server saw. */
  readonly audit: (event: RemoteAuditEvent) => Promise<void>
  /** A consent request opened: show the person the consent window. Must not throw. */
  readonly consentRequested?: () => void
  /** The policy refused a remote call: audit it like the app's own refusals. */
  readonly refused: (call: ToolCall, reason: RemoteRefusal) => Promise<void>
  readonly start?: (options: RemoteListenerOptions) => Promise<RunningRemoteListener>
}

export class RemoteAccess {
  /** The access tokens the listener accepts. The authorisation server mints into this. */
  readonly tokens: RemoteAccessTokens
  /** Client registrations, their grants and refresh tokens. Read from its file at start(). */
  readonly clients: RemoteClients
  readonly consents: ConsentRequests
  readonly authorization: RemoteAuthorization
  private readonly document: JsonDocument<RemoteDocument>
  private readonly clientsDocument: JsonDocument<RemoteClientsState>
  /** Saves run one after another; each writes the latest state. */
  private saving: Promise<unknown> = Promise.resolve()
  private current: RemoteDocument = DEFAULT_REMOTE
  private listener: RunningRemoteListener | null = null
  private caller: ToolCaller | null = null
  /** Changes run one at a time: a pause never interleaves with a start. */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly deps: RemoteAccessDeps) {
    this.tokens = new RemoteAccessTokens({ now: deps.now })
    this.document = new JsonDocument(deps.path, remoteSchema, () => DEFAULT_REMOTE, true)
    // A file that doesn't validate reads as no clients: each connector is added again, with consent.
    this.clientsDocument = new JsonDocument(
      deps.clientsPath,
      remoteClientsStateSchema,
      () => EMPTY_REMOTE_CLIENTS,
      true,
    )
    this.clients = new RemoteClients({ now: deps.now, changed: (state) => this.saveClients(state) })
    this.consents = new ConsentRequests({
      now: deps.now,
      changed: () => deps.changed(),
      ended: (request) => this.auditConsent(request),
    })
    this.authorization = new RemoteAuthorization({
      tokens: this.tokens,
      clients: this.clients,
      consents: this.consents,
      now: deps.now,
      consentRequested: () => deps.consentRequested?.(),
      audit: (event) => {
        void deps.audit({ ...event, clientId: `remote:${event.clientId}` }).catch(() => undefined)
        // Its sessions go with its tokens.
        void this.listener?.endClient(event.clientId).catch(() => undefined)
        deps.changed()
      },
    })
  }

  /** Reads remote.json, and starts listening if the person left remote access on. */
  start(caller: ToolCaller): Promise<void> {
    this.caller = caller
    return this.serially(async () => {
      this.current = await this.document.read()
      this.clients.restore(await this.clientsDocument.read())
      if (this.current.enabled) await this.listen().catch(() => undefined)
    })
  }

  /**
   * The remote policy: on for this tool, at a side effect no higher than when it was turned on, and
   * (for one client) ticked when the person approved that client.
   */
  allows(adapter: string, declaration: ToolDeclaration, clientId: string | null = null): boolean {
    const entry = this.current.tools[adapter]?.[declaration.name]
    if (entry === undefined || RANK[declaration.sideEffect] > RANK[entry.sideEffect]) return false
    if (clientId === null) return true
    return this.clients.get(clientId)?.grant?.tools.includes(`${adapter}.${declaration.name}`) ?? false
  }

  /** What the consent window shows. */
  consentView(): ConsentView {
    return { requests: this.consents.prompts(), tools: this.enabledTools() }
  }

  /**
   * The person typed a code and ticked tools. Tools that aren't remote-enabled now are refused
   * whole (ValetError config invalid). Approves only the request the code belongs to.
   */
  async approveConsent(code: string, tools: readonly string[]): Promise<ConsentAnswer> {
    const enabled = new Set(this.enabledTools().map((t) => t.ref))
    if (tools.some((t) => !enabled.has(t))) throw new ValetError('config', 'invalid')
    const result = this.consents.approve(code, tools)
    if (!result.ok) return result.reason
    await this.auditConsent(result.request)
    return 'approved'
  }

  declineConsent(id: string): boolean {
    return this.consents.decline(id)
  }

  declineAllConsents(): number {
    return this.consents.declineAll()
  }

  /** The kept client registrations, for the remote-clients list. */
  remoteClients(): RemoteClientInfo[] {
    return this.clients.list()
  }

  /** Revokes one client: its registration, grant and tokens go, and its sessions close. */
  revokeClient(clientId: string): Promise<boolean> {
    return this.serially(async () => {
      if (this.clients.get(clientId) === null) return false
      this.authorization.revokeClient(clientId)
      await this.listener?.endClient(clientId)
      await this.deps
        .audit({ type: 'remote-revoked', clientId: `remote:${clientId}`, clients: 1 })
        .catch(() => undefined)
      this.deps.changed()
      return true
    })
  }

  /**
   * "Revoke all remote clients…": every registration with its grant and tokens, and every remote
   * session. Each connector has to be added again, with consent on the Mac. Returns how many.
   */
  revokeAllClients(): Promise<number> {
    return this.serially(async () => {
      const ids = this.clients.list().map((c) => c.id)
      this.consents.declineAll()
      const count = this.authorization.revokeAll()
      for (const id of ids) await this.listener?.endClient(id)
      await this.deps.audit({ type: 'remote-revoked', clientId: null, clients: count }).catch(() => undefined)
      this.deps.changed()
      return count
    })
  }

  /** Written once all saves so far are done. For tests and quitting. */
  async flushed(): Promise<void> {
    await this.saving
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
      clients: this.clients.list().length,
      pendingConsents: this.consents.prompts().length,
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
          // Browsers waiting on the listener can't be answered once it's gone.
          this.consents.declineAll()
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
    return this.serially(async () => {
      this.consents.declineAll()
      await this.unlisten()
      await this.saving
    })
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
      authorization: this.authorization,
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

  private enabledTools(): ConsentTool[] {
    const tools: ConsentTool[] = []
    for (const [adapterId, byTool] of Object.entries(this.current.tools))
      for (const [tool, entry] of Object.entries(byTool))
        tools.push({ ref: `${adapterId}.${tool}`, adapterId, tool, sideEffect: entry.sideEffect })
    return tools.sort((a, b) => a.ref.localeCompare(b.ref))
  }

  private auditConsent(request: ConsentRequest): Promise<void> {
    const answer = request.status === 'pending' ? 'expired' : request.status
    return this.deps
      .audit({
        type: 'remote-consent',
        clientId: `remote:${request.clientId}`,
        clientHost: request.clientHost,
        source: request.source,
        tools: answer === 'approved' ? [...request.tools] : [],
        answer,
      })
      .catch(() => undefined)
  }

  private saveClients(state: RemoteClientsState): void {
    this.saving = this.saving.then(() => this.clientsDocument.update(() => state)).catch(() => undefined)
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
