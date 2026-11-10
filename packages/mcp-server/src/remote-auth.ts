// The remote listener's authenticate hook and the access tokens it checks (relay.md, D41). Remote
// traffic reaches the Mac through a tunnel daemon or the relay socket, both of which connect to a
// listener on 127.0.0.1, so binding alone keeps nothing out: the guards here do.
//
// - Host must be one of the public names the person set up (their Funnel or tunnel hostname). The
//   local listener's 127.0.0.1:<port> is refused here, as this listener's name is refused there, so
//   neither listener answers for the other, and a DNS-rebound page that reaches the port by an
//   attacker's name is refused before any token is read.
// - Any Origin is refused. The remote clients this is for (claude.ai's connectors, cloud agents)
//   call from servers, not pages; a browser page on any origin is not a client of this listener.
// - The bearer token must be an access token from RemoteAccessTokens. Those are minted by the
//   in-app authorisation server (not built yet) and never by the local listener's ClientTokens, so a
//   local client's token is refused here, and a remote token there.

import { createHash } from 'node:crypto'
import { ValetError } from '@valet/core'
import { type Authenticate, isClientId } from './auth'
import { bearerToken } from './http-guards'
import { generateToken, isWellFormedToken } from './token'

/** relay.md: access tokens live an hour; refresh tokens (with the authorisation server) renew them. */
export const ACCESS_TOKEN_TTL_MS = 60 * 60_000

interface AccessToken {
  readonly clientId: string
  readonly expiresAt: number
}

export interface RemoteAccessTokensOptions {
  readonly now?: () => number
  readonly generateToken?: () => string
  readonly ttlMs?: number
}

/**
 * Opaque access tokens for remote clients, one or more per client registration, kept only as their
 * SHA-256 and only in memory: they live an hour, so a restart revoking them all costs a refresh.
 * Revoking is deleting rows, which is what the kill switch relies on (relay.md, "Audit and the kill
 * switch").
 */
export class RemoteAccessTokens {
  private readonly byHash = new Map<string, AccessToken>()
  private readonly now: () => number
  private readonly newToken: () => string
  private readonly ttlMs: number

  constructor(options: RemoteAccessTokensOptions = {}) {
    this.now = options.now ?? Date.now
    this.newToken = options.generateToken ?? generateToken
    this.ttlMs = options.ttlMs ?? ACCESS_TOKEN_TTL_MS
  }

  /** Mints an access token for a client registration. The token is returned once and never kept. */
  issue(clientId: string): string {
    if (!isClientId(clientId)) throw new ValetError('config', 'invalid')
    const token = this.newToken()
    if (!isWellFormedToken(token)) throw new ValetError('config', 'invalid')
    const hash = digest(token)
    if (this.byHash.has(hash)) throw new ValetError('config', 'invalid')
    this.sweep()
    this.byHash.set(hash, { clientId, expiresAt: this.now() + this.ttlMs })
    return token
  }

  /** The client a presented token was issued to, while it is unexpired and unrevoked; else null. */
  identify(presented: string): string | null {
    const hash = digest(presented)
    const entry = this.byHash.get(hash)
    if (entry === undefined) return null
    if (this.now() >= entry.expiresAt) {
      this.byHash.delete(hash)
      return null
    }
    return entry.clientId
  }

  /** Revokes every token one client holds. Returns how many there were. */
  revokeClient(clientId: string): number {
    let count = 0
    for (const [hash, entry] of this.byHash) {
      if (entry.clientId !== clientId) continue
      this.byHash.delete(hash)
      count++
    }
    return count
  }

  /** Revokes every access token: the kill switch. Returns how many there were. */
  revokeAll(): number {
    const count = this.byHash.size
    this.byHash.clear()
    return count
  }

  /** Unexpired tokens held now. */
  get size(): number {
    this.sweep()
    return this.byHash.size
  }

  private sweep(): void {
    const now = this.now()
    for (const [hash, entry] of this.byHash) if (now >= entry.expiresAt) this.byHash.delete(hash)
  }
}

/**
 * A public hostname as the person types it: a DNS name of letters, digits and hyphens, at least two
 * labels, lowercased, no port, no trailing dot. Null for anything else, including IP literals.
 */
export function normaliseRemoteHost(input: string): string | null {
  const host = input.trim().toLowerCase().replace(/\.$/, '')
  if (host.length === 0 || host.length > 253) return null
  const labels = host.split('.')
  if (labels.length < 2) return null
  for (const label of labels) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) return null
  }
  // The last label of a DNS name is never all digits; this keeps out 10.0.0.1 and friends.
  if (/^[0-9]+$/.test(labels[labels.length - 1] as string)) return null
  return host
}

/**
 * True when the Host header names one of `hosts` exactly, with no port or the HTTPS default port.
 * Tunnels forward the public name; anything else, 127.0.0.1 above all, is refused.
 */
export function remoteHostAllowed(header: string | undefined, hosts: ReadonlySet<string>): boolean {
  if (header === undefined) return false
  const match = /^([^:]+)(?::443)?$/.exec(header.toLowerCase())
  const name = match?.[1]
  if (name === undefined) return false
  return hosts.has(name.replace(/\.$/, ''))
}

export interface RemoteAuthOptions {
  readonly tokens: Pick<RemoteAccessTokens, 'identify'>
  /** The public names the listener answers to. Read on every request, so it can change live. */
  readonly hosts: () => ReadonlySet<string>
}

/**
 * The remote listener's hook. Host and Origin come first (403); then the access token (401, with
 * the Bearer challenge the authorisation server will extend with resource metadata, RFC 9728).
 */
export function remoteAuthenticator(options: RemoteAuthOptions): Authenticate {
  return (request) => {
    if (!remoteHostAllowed(request.headers.host, options.hosts()) || request.headers.origin !== undefined) {
      return { ok: false, status: 403 }
    }
    const presented = bearerToken(request.headers.authorization)
    const clientId = presented === null ? null : options.tokens.identify(presented)
    if (clientId === null) return { ok: false, status: 401, headers: { 'www-authenticate': 'Bearer' } }
    return { ok: true, identity: { origin: 'remote', clientId } }
  }
}

function digest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}
