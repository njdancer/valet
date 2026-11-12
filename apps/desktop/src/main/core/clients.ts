// The MCP clients the person has added (D42). Each has its own token, kept only in its own bridge
// config file (mode 0600) and by the endpoint, so a call is attributed to the client whose token
// made it, and one client's access can be reset or revoked alone. What a client says its name is,
// in MCP initialize, is kept beside it as a claim that proves nothing.

import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { ValetError } from '@valet/core'
import type { EndpointClient } from '@valet/mcp-server'
import type { ClientTransport } from '@valet/runtime'
import { z } from 'zod'
import type { ClientInfo } from '../../shared/api'
import { JsonDocument } from './files'

export const MAX_CLIENT_NAME = 60
const MAX_CLIENTS = 200

const clientSchema = z
  .object({
    id: z.string().regex(/^c_[0-9a-f]{16}$/),
    /** The person's name for it, given when they added it. */
    name: z.string().min(1).max(MAX_CLIENT_NAME),
    addedAt: z.iso.datetime(),
    accessResetAt: z.iso.datetime().nullable(),
    lastSeen: z.iso.datetime().nullable(),
    reportedName: z.string().min(1).max(200).nullable(),
    transport: z.enum(['http', 'stdio']).nullable(),
    revokedAt: z.iso.datetime().nullable(),
    /**
     * What the app may do besides calling site tools (docs/ux/agent-run/information-architecture.md,
     * "Use tools · See Valet · Ask for changes"). Absent in files from before it: the defaults.
     */
    capabilities: z
      .object({
        /** Valet's own read-only tools answer it. */
        seeValet: z.boolean(),
        /** Those tools show other agents' calls too, not only its own. */
        allActivity: z.boolean(),
        /**
         * "Ask for changes": Valet's write tools (docs/admin-tools.md, "Write tier") and the
         * authoring tools (docs/authoring-tools.md), each still approved by the person where it
         * widens. Absent in files from before it: on, as for a new local app, unless the person had
         * taken See Valet away.
         */
        askForChanges: z.boolean().optional(),
      })
      .strict()
      .optional(),
    /**
     * Site tools the app turned off for itself (`<adapterId>.<tool>`), with valet_turn_off_tool.
     * Only ever narrows what it sees, so nothing here needs an approval.
     */
    toolsOff: z
      .array(z.string().regex(/^[a-z][a-z0-9-]{1,63}\.[a-z][a-z0-9_]{0,63}$/))
      .max(500)
      .optional(),
  })
  .strict()

// Version 1 recorded clients by reported name, before tokens were per client. Such a file doesn't
// validate and reads as empty: those records were labels, with nothing to carry over.
const fileSchema = z
  .object({ version: z.literal(2), clients: z.array(clientSchema).max(MAX_CLIENTS) })
  .strict()

type StoredClient = z.infer<typeof clientSchema>

export type ClientCapabilities = Required<NonNullable<StoredClient['capabilities']>>

/**
 * A local app sees Valet, and only its own calls, until the person says otherwise: section 5's
 * "own; All with the tick". The tick lives on the app's Connections page (not built yet).
 */
export const DEFAULT_CAPABILITIES: ClientCapabilities = {
  seeValet: true,
  allActivity: false,
  askForChanges: true,
}

/**
 * How the screens name a transport: the bridge as stdio, everything else as HTTP. The endpoint
 * labels each session itself; the bridge says so in a header any local client could also send, so
 * it is a label, never a permission.
 */
export function shownTransport(transport: ClientTransport | undefined): 'http' | 'stdio' {
  return transport === 'stdio-bridge' ? 'stdio' : 'http'
}

/** The person's name for a client, flattened: printable, trimmed, and at most MAX_CLIENT_NAME long. */
export function cleanClientName(name: unknown): string | null {
  if (typeof name !== 'string') return null
  const flat = name
    .replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_CLIENT_NAME)
  return flat.length > 0 ? flat : null
}

export class ClientRegistry {
  private readonly document: JsonDocument<z.infer<typeof fileSchema>>
  private clients: StoredClient[] = []

  constructor(
    path: string,
    /** The directory holding one bridge config file per client. */
    private readonly configDir: string,
    private readonly now: () => Date,
    private readonly newId: () => string = () => `c_${randomBytes(8).toString('hex')}`,
  ) {
    // An unreadable file loses the list: no client gets a token until the person adds it again,
    // which is the safe side.
    this.document = new JsonDocument(path, fileSchema, () => ({ version: 2, clients: [] }), true)
  }

  async load(): Promise<void> {
    this.clients = [...(await this.document.read()).clients]
  }

  /** Where a client's bridge config file is. */
  configPath(id: string): string {
    return join(this.configDir, `${id}.json`)
  }

  /** The clients that hold a token: every one added and not revoked. */
  active(): EndpointClient[] {
    return this.clients
      .filter((c) => c.revokedAt === null)
      .map((c) => ({ id: c.id, configPath: this.configPath(c.id) }))
  }

  get(id: string): StoredClient | null {
    return this.clients.find((c) => c.id === id) ?? null
  }

  isActive(id: string): boolean {
    return this.get(id)?.revokedAt === null
  }

  /** Adds a client under the person's name for it. Throws ValetError('config', 'invalid') for a blank name. */
  async add(name: unknown): Promise<StoredClient> {
    const clean = cleanClientName(name)
    if (clean === null) throw new ValetError('config', 'invalid')
    if (this.clients.length >= MAX_CLIENTS) throw new ValetError('config', 'unavailable')
    const client: StoredClient = {
      id: this.newId(),
      name: clean,
      addedAt: this.now().toISOString(),
      accessResetAt: null,
      lastSeen: null,
      reportedName: null,
      transport: null,
      revokedAt: null,
    }
    this.clients = [...this.clients, client]
    await this.save()
    return client
  }

  /** Records that the client's access was reset. False for an unknown or revoked client. */
  async reset(id: string): Promise<boolean> {
    if (!this.isActive(id)) return false
    const at = this.now().toISOString()
    this.clients = this.clients.map((c) => (c.id === id ? { ...c, accessResetAt: at } : c))
    await this.save()
    return true
  }

  /** Marks the client revoked; the caller withdraws its token. False for an unknown or revoked client. */
  async revoke(id: string): Promise<boolean> {
    if (!this.isActive(id)) return false
    const at = this.now().toISOString()
    this.clients = this.clients.map((c) => (c.id === id ? { ...c, revokedAt: at } : c))
    await this.save()
    return true
  }

  /** What an active client may see; null for an unknown or revoked one. */
  capabilities(id: string): ClientCapabilities | null {
    const client = this.get(id)
    if (client === null || client.revokedAt !== null) return null
    const stored = client.capabilities
    if (stored === undefined) return DEFAULT_CAPABILITIES
    // A file from before Ask for changes: on, unless the person had taken See Valet away.
    return { ...stored, askForChanges: stored.askForChanges ?? stored.seeValet }
  }

  /** Changes what a client may see. False for an unknown or revoked client. */
  async setCapabilities(id: string, patch: Partial<ClientCapabilities>): Promise<boolean> {
    const current = this.capabilities(id)
    if (current === null) return false
    const next: ClientCapabilities = {
      seeValet: patch.seeValet ?? current.seeValet,
      allActivity: patch.allActivity ?? current.allActivity,
      askForChanges: patch.askForChanges ?? current.askForChanges,
    }
    this.clients = this.clients.map((c) => (c.id === id ? { ...c, capabilities: next } : c))
    await this.save()
    return true
  }

  /** Site tools an active client turned off for itself, as `<adapterId>.<tool>`; empty otherwise. */
  toolsOff(id: string): ReadonlySet<string> {
    const client = this.get(id)
    if (client === null || client.revokedAt !== null) return new Set()
    return new Set(client.toolsOff ?? [])
  }

  /**
   * Turns one site tool off for one client. 'already' if it was off; 'not-found' for an unknown or
   * revoked client, or a full list.
   */
  async turnOffTool(id: string, qualified: string): Promise<'done' | 'already' | 'not-found'> {
    const off = this.toolsOff(id)
    if (this.capabilities(id) === null) return 'not-found'
    if (off.has(qualified)) return 'already'
    if (off.size >= 500) return 'not-found'
    this.clients = this.clients.map((c) =>
      c.id === id ? { ...c, toolsOff: [...(c.toolsOff ?? []), qualified] } : c,
    )
    await this.save()
    return 'done'
  }

  /** Records a call from a client: when, and what it says it is. Returns true when the shown row changed. */
  seen(id: string, reportedName: string, transport: 'http' | 'stdio'): boolean {
    const existing = this.get(id)
    if (existing === null) return false
    const changed = existing.reportedName !== reportedName || existing.transport !== transport
    const at = this.now().toISOString()
    this.clients = this.clients.map((c) =>
      c.id === id ? { ...c, lastSeen: at, reportedName: reportedName.slice(0, 200), transport } : c,
    )
    void this.save().catch(() => undefined)
    return changed || existing.lastSeen === null
  }

  list(calls7d: (id: string) => number): ClientInfo[] {
    // Capabilities aren't in ClientInfo yet: the Connections page that shows them comes later.
    return this.clients.map(({ capabilities: _capabilities, toolsOff: _toolsOff, ...c }) => ({
      ...c,
      calls7d: calls7d(c.id),
    }))
  }

  private async save(): Promise<void> {
    const clients = this.clients
    await this.document.update(() => ({ version: 2, clients }))
  }
}
