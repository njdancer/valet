// Who is calling. Every listener runs the same Streamable HTTP handler and the same MCP server; what
// differs between them is only this hook, which looks at a request and either names the client or
// refuses it (D41). The local listener checks the Host and Origin headers and a per-client bearer
// token (D42); a remote listener, after M3, checks OAuth access tokens through the same hook.

import type { IncomingMessage } from 'node:http'

/** Where a client reaches Valet from: this Mac's loopback listener, or a remote one. */
export type ClientOrigin = 'local' | 'remote'

export interface ClientIdentity {
  readonly origin: ClientOrigin
  /** The id the app gave the client when it was added. Never the client's self-reported name. */
  readonly clientId: string
}

/** What the listener knows that a request can't tell it. */
export interface ListenerInfo {
  /** The port the listener is bound to. */
  readonly port: number
}

export type AuthResult =
  | { readonly ok: true; readonly identity: ClientIdentity }
  | {
      readonly ok: false
      /** 403 for a request that may never pass (wrong Host or Origin), 401 for a missing or bad credential. */
      readonly status: 401 | 403
      readonly headers?: Readonly<Record<string, string>>
    }

/**
 * Called once for every request, before anything else reads it. Must not throw; a hook that does
 * is treated as a refusal with status 500 by the handler. It may answer asynchronously, so a
 * remote hook can look a token up.
 */
export type Authenticate = (
  request: IncomingMessage,
  listener: ListenerInfo,
) => AuthResult | Promise<AuthResult>

/** Client ids the app makes: a short plain token, safe in a file name and the audit log. */
export const CLIENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/

export function isClientId(value: string): boolean {
  return CLIENT_ID_PATTERN.test(value)
}

/** The identity as the audit log records it: `local:<id>` or `remote:<id>` (relay.md). */
export function identityLabel(identity: ClientIdentity): string {
  return `${identity.origin}:${identity.clientId}`
}

export function sameIdentity(a: ClientIdentity, b: ClientIdentity): boolean {
  return a.origin === b.origin && a.clientId === b.clientId
}
