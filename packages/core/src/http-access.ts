// What an `http` adapter's tool code reaches through `ctx.http` (docs/adapter-kinds.md#ctxhttp).
// Every request goes through the egress broker in the main process: the request surface, the
// tool's side effect, the run's ceiling, the site's pace and breaker, and the run's upload budget
// all apply before a byte leaves. Tool code never gets a socket or a handle it could keep: one
// request, one JSON answer; a WebSocket is a small set of calls on an id the call owns.

import type { LocalEncoding } from './local-access'

export interface HttpRequestInit {
  /** GET by default. The WebDAV methods are for the declarations that name them. */
  readonly method?: string
  /**
   * Header names are case-insensitive. Host, Cookie, Content-Length, hop-by-hop, proxy and
   * method-override headers are refused, and so are Authorization and the credential's own header
   * (a kept credential is added by the runtime, never by tool code).
   */
  readonly headers?: Readonly<Record<string, string>>
  /** A body as text, or bytes as base64 with bodyEncoding. Not with `json`. */
  readonly body?: string
  readonly bodyEncoding?: LocalEncoding
  /** A JSON body, sent with content-type application/json unless the headers say otherwise. */
  readonly json?: unknown
  /** How the answer's body comes back. Defaults to utf8. */
  readonly responseEncoding?: LocalEncoding
  /**
   * A credential the manifest declares, by name, which the runtime adds as its header. Rejects
   * `tool-run/not-granted` while this Valet keeps no such credential.
   */
  readonly credential?: string
}

export interface HttpResponse {
  readonly status: number
  /** Lower-case names; `set-cookie` is never included. */
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

export type HttpSocketMessage =
  /** Text as it came, or binary data as base64. */
  | { readonly kind: 'message'; readonly data: string; readonly binary: boolean }
  /** The server closed the socket, or it was closed. Nothing more will come. */
  | { readonly kind: 'closed'; readonly code: number }

export interface HttpSocket {
  /** Text, or bytes as base64 with `binary`. Spent from the run's upload budget before it goes. */
  send(data: string, options?: { readonly binary?: boolean }): Promise<void>
  /**
   * Sends a kept credential's declared message (its `use.message`) as a text message, for a server
   * that wants the sign-in in a message rather than on the upgrade. The credential goes in
   * Valet's own message, never one tool code wrote, so tool code never sees it. It must be the
   * first thing sent on the socket, once; what comes back has it redacted.
   */
  sendCredential(credential: string): Promise<void>
  /** The next message, waiting up to `waitMs` (at most 30 s, default 5 s); null if none came. */
  receive(options?: { readonly waitMs?: number }): Promise<HttpSocketMessage | null>
  close(): Promise<void>
}

export interface HttpSocketOptions {
  readonly protocols?: readonly string[]
  readonly headers?: Readonly<Record<string, string>>
  readonly credential?: string
}

/** `ctx.http`. A browser adapter's every call rejects `tool-run/not-granted`. */
export interface HttpAccess {
  /**
   * One request to a declared endpoint. Relative URLs resolve against the manifest's first
   * endpoint. Redirects come back as they are, never followed. Bodies are capped at 2 MB each way.
   */
  fetch(url: string, init?: HttpRequestInit): Promise<HttpResponse>
  /** Opens a WebSocket on a declaration marked `websocket: true`. Closed when the call ends. */
  websocket(url: string, options?: HttpSocketOptions): Promise<HttpSocket>
}

/** The most sockets one call may have open at once. */
export const MAX_SOCKETS_PER_CALL = 4
/** The longest a socket receive() may wait. */
export const MAX_SOCKET_WAIT_MS = 30_000
export const DEFAULT_SOCKET_WAIT_MS = 5_000
