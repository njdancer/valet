// The MCP clients that have called, by the name each reports in MCP initialize. Every client shares
// one token (D42 is open), so a name is a label, not an identity: revoking one refuses calls made
// under that name, which stops an honest client and nothing else. Rotating the token is the control
// that cuts off everyone.

import { sha256Hex } from '@siteadapter/core'
import type { ClientTransport } from '@siteadapter/runtime'
import { z } from 'zod'
import type { ClientInfo } from '../../shared/api'
import { JsonDocument } from './files'

const clientSchema = z
  .object({
    id: z.string().regex(/^c_[0-9a-f]{16}$/),
    reportedName: z.string().min(1).max(200),
    transport: z.enum(['http', 'stdio']),
    firstSeen: z.iso.datetime(),
    lastSeen: z.iso.datetime(),
    revokedAt: z.iso.datetime().nullable(),
  })
  .strict()

const fileSchema = z.object({ version: z.literal(1), clients: z.array(clientSchema).max(500) }).strict()

type StoredClient = z.infer<typeof clientSchema>

/**
 * How the screens name a transport: the bridge as stdio, everything else as HTTP. The endpoint
 * labels each session itself; the bridge says so in a header any local client could also send, so
 * it is a label, never a permission.
 */
export function shownTransport(transport: ClientTransport | undefined): ClientInfo['transport'] {
  return transport === 'stdio-bridge' ? 'stdio' : 'http'
}

export function clientId(reportedName: string): string {
  return `c_${sha256Hex(reportedName).slice(0, 16)}`
}

export class ClientRegistry {
  private readonly document: JsonDocument<z.infer<typeof fileSchema>>
  private clients: StoredClient[] = []

  constructor(
    path: string,
    private readonly now: () => Date,
  ) {
    // An unreadable file loses the list, and with it any revocations: those are labels anyway.
    this.document = new JsonDocument(path, fileSchema, () => ({ version: 1, clients: [] }), true)
  }

  async load(): Promise<void> {
    this.clients = [...(await this.document.read()).clients]
  }

  isRevoked(reportedName: string): boolean {
    return this.clients.some((c) => c.reportedName === reportedName && c.revokedAt !== null)
  }

  /** Records a call from `reportedName`. Returns true when the client is new. */
  seen(reportedName: string, transport: 'http' | 'stdio'): boolean {
    const at = this.now().toISOString()
    const existing = this.clients.find((c) => c.reportedName === reportedName)
    if (existing !== undefined) {
      this.clients = this.clients.map((c) => (c === existing ? { ...c, lastSeen: at, transport } : c))
    } else {
      this.clients = [
        ...this.clients,
        { id: clientId(reportedName), reportedName, transport, firstSeen: at, lastSeen: at, revokedAt: null },
      ].slice(-500)
    }
    void this.save()
    return existing === undefined
  }

  async revoke(id: string): Promise<boolean> {
    const at = this.now().toISOString()
    let found = false
    this.clients = this.clients.map((c) => {
      if (c.id !== id || c.revokedAt !== null) return c
      found = true
      return { ...c, revokedAt: at }
    })
    if (found) await this.save()
    return found
  }

  list(calls7d: (reportedName: string) => number): ClientInfo[] {
    return this.clients.map((c) => ({ ...c, calls7d: calls7d(c.reportedName) }))
  }

  private save(): Promise<void> {
    const clients = this.clients
    return this.document
      .update(() => ({ version: 1, clients }))
      .then(
        () => undefined,
        () => undefined,
      )
  }
}
