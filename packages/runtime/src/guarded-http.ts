// ctx.http as tool code sees it (docs/adapter-kinds.md#ctxhttp): the egress broker behind the same
// checks the page's fetch gets. Each request is checked against the manifest's request surface with
// its private hosts and exact ports, held to the tool's side effect and unlocks, counted against the
// run's ceiling, paced by the site's rate budget and refused while its breaker is open. Then the
// broker checks the endpoint again, does its own DNS, spends the bytes from the run's upload budget
// and records the connection.
//
// Tool code hands us its own objects, so every check runs against one snapshot of what it passed,
// and only that snapshot reaches the broker. What it may not set: Host (the broker writes it from
// the URL), Cookie, framing and hop-by-hop headers, proxy headers, method overrides, and any
// credential header, which only the runtime adds from a kept credential (B's secrets workstream).
// A refusal is sticky, like the page's: the call fails even if tool code catches it.

import {
  DEFAULT_SOCKET_WAIT_MS,
  decideRequest,
  type ErrorClass,
  type HttpAccess,
  type HttpRequestInit,
  type HttpResponse,
  type HttpSocket,
  type HttpSocketMessage,
  type HttpSocketOptions,
  type LocalEncoding,
  MAX_SOCKET_WAIT_MS,
  MAX_SOCKETS_PER_CALL,
  type RequestDeclaration,
  type SecretValue,
  ValetError,
} from '@valet/core'
import type { BrokerRequest, ExchangeResult, RunContext } from '@valet/egress'
import { CallGate, type CallGateOptions, METHOD_OVERRIDE_HEADERS, SURFACE_CLASS } from './call-gate'
import { REDACTED } from './redaction'
import { blockCause } from './site-protection'

/** The broker as the runtime needs it: EgressBroker implements it. */
export interface HttpEgress {
  fetch(url: URL, request: BrokerRequest, run: RunContext): Promise<ExchangeResult>
  websocket(
    url: URL,
    options: { readonly protocols?: readonly string[]; readonly headers?: Readonly<Record<string, string>> },
    run: RunContext,
  ): Promise<EgressSocket>
}

/** BrokerSocket as the runtime needs it. */
export interface EgressSocket {
  send(data: Buffer, binary: boolean): Promise<void>
  receive(
    waitMs: number,
  ): Promise<
    | { readonly kind: 'message'; readonly data: Buffer; readonly binary: boolean }
    | { readonly kind: 'closed'; readonly code: number }
    | null
  >
  close(): void
}

/**
 * Kept credentials, by the name a manifest declares (the secrets workstream implements it). Called
 * only after the request has passed every other check, for the host it goes to.
 */
export interface HttpCredentials {
  headerFor(credential: string, host: string): Promise<{ readonly name: string; readonly value: SecretValue }>
}

export interface GuardedHttpOptions extends CallGateOptions {
  readonly broker: HttpEgress
  readonly run: RunContext
  readonly credentials?: HttpCredentials
  /** Header names (lower case) only a kept credential may set: the manifest's credential headers. */
  readonly credentialHeaders?: readonly string[]
}

/** Headers tool code may never set, lower case. `proxy-` and `sec-` prefixes are refused too. */
const REFUSED_HEADERS = new Set([
  'host',
  'cookie',
  'cookie2',
  'content-length',
  'transfer-encoding',
  'te',
  'trailer',
  'connection',
  'keep-alive',
  'upgrade',
  'expect',
  'http2-settings',
  'authorization',
  ...METHOD_OVERRIDE_HEADERS,
])
const REFUSED_PREFIXES = ['proxy-', 'sec-']
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/
/** Visible ASCII, Latin-1 and tabs and spaces: no CR, LF or NUL to split a header with. */
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]{0,8192}$/
const MAX_HEADERS = 32
const MAX_URL_LENGTH = 8192
const MAX_PROTOCOLS = 8

interface Snapshot {
  readonly method: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: Buffer | null
  readonly responseEncoding: LocalEncoding
  readonly credential: string | null
}

export class GuardedHttp implements HttpAccess {
  private readonly gate: CallGate
  private readonly sockets = new Set<EgressSocket>()

  constructor(private readonly options: GuardedHttpOptions) {
    this.gate = new CallGate(options)
    // Sockets end with the call, however it ends.
    options.state.signal.addEventListener('abort', () => this.closeAll(), { once: true })
  }

  async fetch(url: string, init?: HttpRequestInit): Promise<HttpResponse> {
    const { state, manifest, broker, run, site } = this.options
    state.assertLive()
    const snapshot = snapshotRequest(init)
    const method = snapshot?.method ?? 'INVALID'
    const target = resolve(url, manifest.home)
    if (target === null) return this.gate.deny('request-surface', 'host-not-allowed', method, null, url)
    if (snapshot === null) return this.gate.deny('request-surface', 'undeclared-request', method, target, url)
    await this.check(method, target, url, snapshot.headers, false)
    const headers = await this.withCredential(snapshot, target, url, method)
    const admitted = await this.gate.admit(method, target, url)
    let result: ExchangeResult
    try {
      result = await state.track(
        broker.fetch(target, { method, headers: headers.values, body: snapshot.body }, run),
      )
    } catch (error) {
      return this.failed(error, method, target, url)
    }
    const text = result.body.toString('utf8')
    const cause = blockCause({
      status: result.status,
      contentType: result.headers['content-type'] ?? null,
      body: text,
    })
    if (cause !== null) this.gate.siteBlocked(cause)
    site.breaker.recordSuccess(admitted)
    return {
      status: result.status,
      headers: headers.redact(result.headers),
      body: headers.redactBody(result.body, snapshot.responseEncoding),
    }
  }

  async websocket(url: string, options?: HttpSocketOptions): Promise<HttpSocket> {
    const { state, manifest, broker, run } = this.options
    state.assertLive()
    const snapshot = snapshotSocket(options)
    const target = resolve(url, manifest.home)
    if (target === null) return this.gate.deny('request-surface', 'host-not-allowed', 'GET', null, url)
    if (snapshot === null) return this.gate.deny('request-surface', 'undeclared-request', 'GET', target, url)
    await this.check('GET', target, url, snapshot.headers, true)
    if (this.sockets.size >= MAX_SOCKETS_PER_CALL) {
      return this.gate.deny('request-surface', 'request-ceiling', 'GET', target, url)
    }
    const headers = await this.withCredential(
      { ...snapshot, method: 'GET', body: null, responseEncoding: 'utf8' },
      target,
      url,
      'GET',
    )
    const admitted = await this.gate.admit('GET', target, url)
    let socket: EgressSocket
    try {
      socket = await state.track(
        broker.websocket(
          target,
          {
            headers: headers.values,
            ...(snapshot.protocols === undefined ? {} : { protocols: snapshot.protocols }),
          },
          run,
        ),
      )
    } catch (error) {
      return this.failed(error, 'GET', target, url)
    }
    this.options.site.breaker.recordSuccess(admitted)
    if (state.signal.aborted) {
      socket.close()
      throw new ValetError('tool-run', 'aborted')
    }
    this.sockets.add(socket)
    return this.handle(socket, target, url, headers)
  }

  /** Closes every socket the call opened. */
  closeAll(): void {
    for (const socket of this.sockets) socket.close()
    this.sockets.clear()
  }

  private handle(socket: EgressSocket, target: URL, url: string, credential: CredentialUse): HttpSocket {
    const { state } = this.options
    let closed = false
    return Object.freeze({
      send: async (data: string, options?: { readonly binary?: boolean }): Promise<void> => {
        state.assertLive()
        if (closed) throw new ValetError('egress', 'unavailable')
        const binary = readBinary(options)
        if (typeof data !== 'string' || binary === null) throw new ValetError('tool-run', 'invalid')
        const bytes = binary ? decodeBase64(data) : Buffer.from(data, 'utf8')
        if (bytes === null) throw new ValetError('tool-run', 'invalid')
        try {
          await state.track(socket.send(bytes, binary))
        } catch (error) {
          if (error instanceof ValetError && error.errorClass === 'upload-budget') {
            this.sockets.delete(socket)
            closed = true
            return this.gate.deny('egress', 'upload-budget', 'GET', target, url)
          }
          throw error
        }
      },
      receive: async (options?: { readonly waitMs?: number }): Promise<HttpSocketMessage | null> => {
        state.assertLive()
        const wait = readWait(options)
        if (wait === null) throw new ValetError('tool-run', 'invalid')
        const message = await state.track(socket.receive(wait))
        if (message === null) return null
        if (message.kind === 'closed') {
          this.sockets.delete(socket)
          closed = true
          return { kind: 'closed', code: message.code }
        }
        return {
          kind: 'message',
          binary: message.binary,
          data: credential.redactBody(message.data, message.binary ? 'base64' : 'utf8'),
        }
      },
      close: async (): Promise<void> => {
        closed = true
        this.sockets.delete(socket)
        socket.close()
      },
    })
  }

  /** The request surface, the tool's side effect, and the headers tool code set. */
  private async check(
    method: string,
    target: URL,
    raw: string,
    headers: Readonly<Record<string, string>>,
    websocket: boolean,
  ): Promise<RequestDeclaration> {
    const { manifest } = this.options
    if (!this.headersAllowed(headers)) {
      return this.gate.deny('request-surface', 'undeclared-request', method, target, raw)
    }
    const decision = decideRequest(method, target.href, manifest.egress, manifest.requests, {
      privateHosts: manifest.privateHosts ?? [],
      exactPort: true,
      ...(websocket ? { websocket: true } : {}),
    })
    if (!decision.allowed) {
      return this.gate.deny('request-surface', SURFACE_CLASS[decision.reason], method, target, raw)
    }
    if (!this.gate.mayUse(decision.declaration)) {
      return this.gate.deny('request-surface', 'denied-path', method, target, raw)
    }
    return decision.declaration
  }

  private headersAllowed(headers: Readonly<Record<string, string>>): boolean {
    const names = Object.keys(headers)
    if (names.length > MAX_HEADERS) return false
    const credentialHeaders = this.options.credentialHeaders ?? []
    const seen = new Set<string>()
    for (const name of names) {
      const lower = name.toLowerCase()
      if (!TOKEN.test(name) || seen.has(lower)) return false
      seen.add(lower)
      if (REFUSED_HEADERS.has(lower) || credentialHeaders.includes(lower)) return false
      if (REFUSED_PREFIXES.some((p) => lower.startsWith(p))) return false
      if (!HEADER_VALUE.test(headers[name] as string)) return false
    }
    return true
  }

  /**
   * The headers to send, with the credential's added when the request names one. A credential is
   * never sent over plain http, and its value is taken out of whatever comes back.
   */
  private async withCredential(
    snapshot: Snapshot,
    target: URL,
    raw: string,
    method: string,
  ): Promise<CredentialUse> {
    const values: Record<string, string> = {}
    for (const [name, value] of Object.entries(snapshot.headers)) values[name.toLowerCase()] = value
    if (snapshot.credential === null) return new CredentialUse(values, null)
    const { credentials, state } = this.options
    if (credentials === undefined || target.protocol !== 'https:') {
      return this.gate.deny('tool-run', 'not-granted', method, target, raw)
    }
    let header: { readonly name: string; readonly value: SecretValue }
    try {
      header = await state.track(credentials.headerFor(snapshot.credential, target.hostname))
    } catch {
      return this.gate.deny('tool-run', 'not-granted', method, target, raw)
    }
    const name = header.name.toLowerCase()
    if (!TOKEN.test(name) || (REFUSED_HEADERS.has(name) && name !== 'authorization')) {
      return this.gate.deny('tool-run', 'not-granted', method, target, raw)
    }
    const plaintext = header.value.reveal((v) => v)
    if (!HEADER_VALUE.test(plaintext)) return this.gate.deny('tool-run', 'not-granted', method, target, raw)
    values[name] = plaintext
    return new CredentialUse(values, plaintext)
  }

  /** A broker refusal that is the tool's doing is sticky and recorded; anything else just fails. */
  private failed(error: unknown, method: string, target: URL, raw: string): never | Promise<never> {
    if (error instanceof ValetError) {
      const sticky: readonly ErrorClass[] = ['upload-budget', 'host-not-allowed']
      if (sticky.includes(error.errorClass))
        return this.gate.deny(error.stage, error.errorClass, method, target, raw)
      throw error
    }
    throw new ValetError('egress', 'unavailable')
  }
}

/** The headers a request goes with, and a credential's value to take out of what comes back. */
class CredentialUse {
  constructor(
    readonly values: Readonly<Record<string, string>>,
    private readonly secret: string | null,
  ) {}

  redact(headers: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
    if (this.secret === null) return headers
    const out: Record<string, string> = {}
    for (const [name, value] of Object.entries(headers)) out[name] = value.split(this.secret).join(REDACTED)
    return out
  }

  /**
   * The body as tool code asked for it. Text has the credential's value replaced; bytes that hold it
   * can't be cut cleanly, so they are refused.
   */
  redactBody(body: Buffer, encoding: LocalEncoding): string {
    if (this.secret !== null && body.includes(this.secret)) {
      if (encoding === 'base64') throw new ValetError('tool-run', 'unexpected-shape')
      return body.toString('utf8').split(this.secret).join(REDACTED)
    }
    return encoding === 'base64' ? body.toString('base64') : body.toString('utf8')
  }
}

function resolve(url: string, home: string): URL | null {
  if (typeof url !== 'string' || url.length > MAX_URL_LENGTH) return null
  try {
    const target = new URL(url, home)
    if (target.protocol !== 'https:' && target.protocol !== 'http:') return null
    // The fragment never leaves anyway; dropping it keeps it out of every record.
    target.hash = ''
    return target
  } catch {
    return null
  }
}

/** Reads each field of `init` once into a fresh object; null when anything is the wrong shape. */
function snapshotRequest(init: HttpRequestInit | undefined): Snapshot | null {
  if (init === undefined) {
    return { method: 'GET', headers: {}, body: null, responseEncoding: 'utf8', credential: null }
  }
  try {
    if (init === null || typeof init !== 'object') return null
    const rawMethod: unknown = init.method
    const rawBody: unknown = init.body
    const rawBodyEncoding: unknown = init.bodyEncoding
    const rawJson: unknown = init.json
    const rawResponseEncoding: unknown = init.responseEncoding
    const rawCredential: unknown = init.credential
    const headers = snapshotHeaders(init.headers)
    if (headers === null) return null
    if (rawMethod !== undefined && typeof rawMethod !== 'string') return null
    if (rawCredential !== undefined && (typeof rawCredential !== 'string' || rawCredential.length > 64))
      return null
    const bodyEncoding = rawBodyEncoding ?? 'utf8'
    const responseEncoding = rawResponseEncoding ?? 'utf8'
    if (!isEncoding(bodyEncoding) || !isEncoding(responseEncoding)) return null
    let body: Buffer | null = null
    if (rawBody !== undefined && rawJson !== undefined) return null
    if (rawBody !== undefined) {
      if (typeof rawBody !== 'string') return null
      body = bodyEncoding === 'base64' ? decodeBase64(rawBody) : Buffer.from(rawBody, 'utf8')
      if (body === null) return null
    } else if (rawJson !== undefined) {
      const text = JSON.stringify(rawJson)
      if (typeof text !== 'string') return null
      body = Buffer.from(text, 'utf8')
      if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
        headers['content-type'] = 'application/json'
      }
    }
    return {
      method: (rawMethod ?? 'GET').toUpperCase(),
      headers: Object.freeze(headers),
      body,
      responseEncoding,
      credential: rawCredential ?? null,
    }
  } catch {
    return null
  }
}

function snapshotSocket(options: HttpSocketOptions | undefined): {
  readonly headers: Readonly<Record<string, string>>
  readonly protocols?: readonly string[]
  readonly credential: string | null
} | null {
  if (options === undefined) return { headers: {}, credential: null }
  try {
    if (options === null || typeof options !== 'object') return null
    const rawProtocols: unknown = options.protocols
    const rawCredential: unknown = options.credential
    const headers = snapshotHeaders(options.headers)
    if (headers === null) return null
    if (rawCredential !== undefined && (typeof rawCredential !== 'string' || rawCredential.length > 64))
      return null
    let protocols: string[] | undefined
    if (rawProtocols !== undefined) {
      if (!Array.isArray(rawProtocols) || rawProtocols.length > MAX_PROTOCOLS) return null
      protocols = [...rawProtocols].map((p: unknown) => (typeof p === 'string' && TOKEN.test(p) ? p : ''))
      if (protocols.includes('')) return null
    }
    return {
      headers: Object.freeze(headers),
      credential: rawCredential ?? null,
      ...(protocols === undefined ? {} : { protocols: Object.freeze(protocols) }),
    }
  } catch {
    return null
  }
}

/** Own string-valued entries, read once; anything else in the object makes it null. */
function snapshotHeaders(raw: unknown): Record<string, string> | null {
  const headers: Record<string, string> = Object.create(null)
  if (raw === undefined) return headers
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value !== 'string') return null
    headers[name] = value
  }
  return headers
}

function isEncoding(value: unknown): value is LocalEncoding {
  return value === 'utf8' || value === 'base64'
}

/** Strict base64: what Buffer would quietly skip over is refused. */
function decodeBase64(text: string): Buffer | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) return null
  return Buffer.from(text, 'base64')
}

function readBinary(options: { readonly binary?: boolean } | undefined): boolean | null {
  if (options === undefined) return false
  if (options === null || typeof options !== 'object') return null
  const binary: unknown = options.binary
  if (binary === undefined) return false
  return typeof binary === 'boolean' ? binary : null
}

function readWait(options: { readonly waitMs?: number } | undefined): number | null {
  if (options === undefined) return DEFAULT_SOCKET_WAIT_MS
  if (options === null || typeof options !== 'object') return null
  const wait: unknown = options.waitMs
  if (wait === undefined) return DEFAULT_SOCKET_WAIT_MS
  if (typeof wait !== 'number' || !Number.isFinite(wait) || wait < 0) return null
  return Math.min(MAX_SOCKET_WAIT_MS, Math.floor(wait))
}

/** ctx.http for an adapter without the broker: a browser adapter, or a runtime without one. */
export const NO_HTTP_ACCESS: HttpAccess = Object.freeze({
  fetch: () => Promise.reject(new ValetError('tool-run', 'not-granted')),
  websocket: () => Promise.reject(new ValetError('tool-run', 'not-granted')),
})
