// The local listener's authenticate hook: the request must come for 127.0.0.1 on the listener's own
// port, from no browser page or a localhost one, and carry a bearer token the app issued to one
// client (D42). The token names the client; the client's self-reported name never does.

import { createHash } from 'node:crypto'
import { ValetError } from '@valet/core'
import type { Authenticate } from './auth'
import { isClientId } from './auth'
import { bearerToken, hostAllowed, originAllowed } from './http-guards'
import { isWellFormedToken } from './token'

/**
 * The tokens the app has issued, one per client. Only their SHA-256 is kept. A presented token is
 * looked up by its hash: the token is 32 random bytes, so how long a lookup takes says nothing
 * useful about any stored token, and there is no per-byte comparison against a secret to time.
 */
export class ClientTokens {
  private readonly byHash = new Map<string, string>()
  private readonly byClient = new Map<string, string>()

  /** Issues `token` to `clientId`, replacing the token it had. */
  set(clientId: string, token: string): void {
    if (!isClientId(clientId) || !isWellFormedToken(token)) throw new ValetError('config', 'invalid')
    this.delete(clientId)
    const hash = digest(token)
    // Two clients can't share a token: the second would be indistinguishable from the first.
    if (this.byHash.has(hash)) throw new ValetError('config', 'invalid')
    this.byHash.set(hash, clientId)
    this.byClient.set(clientId, hash)
  }

  /** Takes the client's token away. True when it had one. */
  delete(clientId: string): boolean {
    const hash = this.byClient.get(clientId)
    if (hash === undefined) return false
    this.byClient.delete(clientId)
    this.byHash.delete(hash)
    return true
  }

  has(clientId: string): boolean {
    return this.byClient.has(clientId)
  }

  ids(): readonly string[] {
    return [...this.byClient.keys()]
  }

  /** The client a presented token was issued to, or null. */
  identify(presented: string): string | null {
    return this.byHash.get(digest(presented)) ?? null
  }
}

/** The local listener's hook. Host and Origin come first: a page in a browser is refused with 403. */
export function localAuthenticator(tokens: ClientTokens): Authenticate {
  return (request, listener) => {
    if (!hostAllowed(request.headers.host, listener.port) || !originAllowed(request.headers.origin)) {
      return { ok: false, status: 403 }
    }
    const presented = bearerToken(request.headers.authorization)
    const clientId = presented === null ? null : tokens.identify(presented)
    if (clientId === null) return { ok: false, status: 401, headers: { 'www-authenticate': 'Bearer' } }
    return { ok: true, identity: { origin: 'local', clientId } }
  }
}

function digest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}
