// The Mac's side of the relay (docs/relay-worker.md). It dials out to the relay over a WebSocket,
// so nothing ever connects in to the Mac, answers the relay's challenge with the transport key,
// and turns each forwarded request into a request to the remote listener on 127.0.0.1, exactly
// as a tunnel daemon would (remote.ts). It is a byte pipe: the listener's OAuth server, remote
// policy, limits and audit decide everything, and there is no second MCP code path (D41).
//
// The transport key lives in the Swift helper's Secure Enclave and signs only the relay's
// challenge; this file sees its public key and asks it to sign.

import { request as httpRequest, type IncomingMessage } from 'node:http'
import { StringDecoder } from 'node:string_decoder'
import {
  type MacToRelay,
  RELAY_LIMITS,
  RELAY_RESPONSE_HEADERS,
  type RelayToMac,
  relayAuthPayload,
  relayToMacSchema,
} from '@valet/core'
import type { RelayConsentView } from './oauth-server'

/** The transport key: signs `valet/relay-auth/v1\n<payload>` without user presence. */
export interface TransportSigner {
  /** base64url SPKI DER, P-256. */
  readonly publicKey: string
  /** A base64url raw r||s signature over the relay-auth domain and this payload. */
  sign(payload: string): Promise<string>
}

export type RelayClientStatus =
  | { readonly state: 'connecting' }
  | { readonly state: 'online'; readonly devices: readonly string[] }
  | { readonly state: 'offline'; readonly retryInMs: number }
  /** The relay refused this Mac's key. Retried slowly; the app tells the person. */
  | { readonly state: 'refused'; readonly retryInMs: number }
  /** Another process connected as this Mac. Not retried, or the two would take turns forever. */
  | { readonly state: 'replaced' }
  | { readonly state: 'stopped' }

/**
 * The approval key vouching for the transport key (verifyRelayBinding): signed once, with Touch
 * ID, when the transport key is made, and kept by the app. Sent on every hello, so a new
 * transport key replaces the old one at the relay, and nobody who only knows the Mac's id can
 * register as it.
 */
export interface RelayBinding {
  readonly approvalKey: string
  readonly signature: string
}

/** Frames for the app: the phone channel, pairing replies, and the relay-side lock. */
export type RelayEvent = Extract<
  RelayToMac,
  { type: 'envelope' | 'device-online' | 'ready' | 'pairing-reply' | 'relay-locked' }
>

export interface RelayClientOptions {
  /** The relay's origin, e.g. https://relay.example. The challenge must name exactly this. */
  readonly relay: string
  readonly macId: string
  readonly signer: TransportSigner
  readonly binding: RelayBinding
  /** The remote listener's loopback URL, or null while remote access is paused. */
  readonly listener: () => string | null
  /** RemoteAuthorization.relayConsent, bound to this Mac's public host. */
  readonly consent: (id: string, query: string, source: string | null) => RelayConsentView
  readonly onEvent?: (event: RelayEvent) => void
  readonly onStatus?: (status: RelayClientStatus) => void
  /**
   * The base of this Mac's public host, when the relay gives Macs names under another domain
   * (its RELAY_MAC_HOST): `<macId>.<macHost>`. Unset, `<macId>.<relay host>`.
   */
  readonly macHost?: string
  /** Where to connect, when it isn't the relay's own origin (tests against a local runtime). */
  readonly connectUrl?: string
  readonly WebSocket?: typeof WebSocket
  readonly backoff?: { readonly minMs: number; readonly maxMs: number }
  readonly random?: () => number
  /** How long to gather response bytes before sending a chunk; fewer, larger frames. */
  readonly coalesceMs?: number
  readonly pingMs?: number
}

/**
 * Characters per response chunk: well under the contract's cap, so that even text JSON-escapes
 * to six times its length a frame stays within the relay's frame limit.
 */
const CHUNK_CHARS = Math.min(RELAY_LIMITS.maxResponseChunkBytes, 64 * 1024)
/** WebSocket.OPEN. */
/** What Node accepts in a header value: tab, printable ASCII and Latin-1, no CR or LF. */
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/
const OPEN = 1
const CLOSE_AUTH_FAILED = 4401
const CLOSE_REPLACED = 4409

interface Forwarded {
  readonly abort: () => void
}

export class RelayClient {
  private socket: WebSocket | null = null
  private stopped = true
  private attempt = 0
  private retry: ReturnType<typeof setTimeout> | null = null
  private ping: ReturnType<typeof setInterval> | null = null
  private readonly inFlight = new Map<string, Forwarded>()
  private current: RelayClientStatus = { state: 'stopped' }

  constructor(private readonly options: RelayClientOptions) {}

  /** The host remote clients use for this Mac: `<macId>.<relay host>`, or `<macId>.<macHost>`. */
  get publicHost(): string {
    return `${this.options.macId}.${this.options.macHost ?? new URL(this.options.relay).host}`
  }

  get status(): RelayClientStatus {
    return this.current
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.attempt = 0
    this.open()
  }

  /** Closes the connection and fails what's in flight. The relay answers callers itself. */
  stop(): void {
    this.stopped = true
    if (this.retry !== null) clearTimeout(this.retry)
    this.retry = null
    this.teardown()
    this.socket?.close(1000, 'stopped')
    this.socket = null
    this.setStatus({ state: 'stopped' })
  }

  /** Sends a frame to the relay; false when not connected (the caller retries on device-online). */
  send(frame: Exclude<MacToRelay, { type: 'hello' }>): boolean {
    if (this.socket === null || this.current.state !== 'online') return false
    this.socket.send(JSON.stringify(frame))
    return true
  }

  private open() {
    this.setStatus({ state: 'connecting' })
    const Impl = this.options.WebSocket ?? WebSocket
    const base = this.options.connectUrl ?? this.options.relay
    const url = `${base.replace(/^http/, 'ws').replace(/\/$/, '')}/v1/mac/${this.options.macId}`
    let socket: WebSocket
    try {
      socket = new Impl(url)
    } catch {
      return this.scheduleRetry(false)
    }
    this.socket = socket
    let refused = false
    socket.addEventListener('message', (event) => {
      if (this.socket !== socket) return
      void this.onMessage(socket, event.data)
    })
    socket.addEventListener('close', (event) => {
      if (this.socket !== socket) return
      this.socket = null
      this.teardown()
      if (this.stopped) return
      if (event.code === CLOSE_REPLACED) {
        this.stopped = true
        return this.setStatus({ state: 'replaced' })
      }
      refused = event.code === CLOSE_AUTH_FAILED
      this.scheduleRetry(refused)
    })
    socket.addEventListener('error', () => {
      // A close event follows.
    })
  }

  private async onMessage(socket: WebSocket, data: unknown): Promise<void> {
    if (typeof data !== 'string') return socket.close(1003, 'text only')
    if (data === 'pong') return
    let parsed: RelayToMac
    try {
      const result = relayToMacSchema.safeParse(JSON.parse(data))
      if (!result.success) return socket.close(1008, 'bad frame')
      parsed = result.data
    } catch {
      return socket.close(1008, 'bad frame')
    }
    switch (parsed.type) {
      case 'challenge': {
        // A challenge for another relay would sign us in there with this signature: refuse it.
        if (parsed.relay !== this.options.relay) return socket.close(1008, 'wrong relay')
        const payload = relayAuthPayload({
          nonce: parsed.nonce,
          relay: parsed.relay,
          role: 'mac',
          id: this.options.macId,
        })
        let signature: string
        try {
          signature = await this.options.signer.sign(payload)
        } catch {
          return socket.close(1011, 'could not sign')
        }
        if (this.socket !== socket) return
        socket.send(
          JSON.stringify({
            type: 'hello',
            role: 'mac',
            id: this.options.macId,
            transportKey: this.options.signer.publicKey,
            binding: this.options.binding,
            signature,
          } satisfies MacToRelay),
        )
        return
      }
      case 'ready':
        this.attempt = 0
        this.setStatus({ state: 'online', devices: parsed.devices })
        this.startPing(socket)
        return this.emit(parsed)
      case 'http-request':
        return this.forward(socket, parsed)
      case 'http-cancel':
        this.inFlight.get(parsed.id)?.abort()
        this.inFlight.delete(parsed.id)
        return
      case 'consent-open': {
        let view: RelayConsentView
        try {
          view = this.options.consent(parsed.id, parsed.query, parsed.source === '' ? null : parsed.source)
        } catch {
          view = { state: 'declined' }
        }
        this.sendOn(socket, { type: 'consent-view', id: parsed.id, ...view })
        return
      }
      case 'envelope':
      case 'device-online':
      case 'pairing-reply':
      case 'relay-locked':
        return this.emit(parsed)
    }
  }

  private forward(socket: WebSocket, frame: Extract<RelayToMac, { type: 'http-request' }>) {
    const answer = (status: number, headers: Record<string, string> = {}) => {
      this.sendOn(socket, { type: 'http-response-start', id: frame.id, status, headers })
      this.sendOn(socket, { type: 'http-response-end', id: frame.id })
    }
    const listener = this.options.listener()
    // Paused: the same answer the listener would give if it weren't there.
    if (listener === null) return answer(503, { 'retry-after': '60' })
    // The relay is not trusted to send only what Node will put in a header.
    if (![frame.source, ...Object.values(frame.headers)].every((v) => HEADER_VALUE.test(v)))
      return answer(400)
    const target = new URL(frame.path + (frame.query === '' ? '' : `?${frame.query}`), listener)
    const headers: Record<string, string> = { ...frame.headers, host: this.publicHost }
    if (frame.source !== '') headers['cf-connecting-ip'] = frame.source
    if (frame.body !== '') headers['content-length'] = String(Buffer.byteLength(frame.body))
    const coalesceMs = this.options.coalesceMs ?? 20
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      this.inFlight.delete(frame.id)
    }
    let req: ReturnType<typeof httpRequest>
    try {
      req = httpRequest(target, { method: frame.method, headers }, (res: IncomingMessage) => {
        if (finished) return res.destroy()
        this.sendOn(socket, {
          type: 'http-response-start',
          id: frame.id,
          status: res.statusCode ?? 502,
          headers: responseHeaders(res),
        })
        const decoder = new StringDecoder('utf8')
        let buffered = ''
        let timer: ReturnType<typeof setTimeout> | null = null
        const flush = () => {
          if (timer !== null) clearTimeout(timer)
          timer = null
          while (buffered.length > 0) {
            const part = takeChunk(buffered, CHUNK_CHARS)
            buffered = buffered.slice(part.length)
            this.sendOn(socket, { type: 'http-response-chunk', id: frame.id, data: part })
          }
        }
        res.on('data', (chunk: Buffer) => {
          if (finished) return
          buffered += decoder.write(chunk)
          if (buffered.length >= CHUNK_CHARS) flush()
          else timer ??= setTimeout(flush, coalesceMs)
        })
        res.on('end', () => {
          if (finished) return
          buffered += decoder.end()
          flush()
          this.sendOn(socket, { type: 'http-response-end', id: frame.id })
          finish()
        })
        res.on('error', () => {
          if (finished) return
          if (timer !== null) clearTimeout(timer)
          this.sendOn(socket, { type: 'http-response-end', id: frame.id })
          finish()
        })
      })
    } catch {
      return answer(502)
    }
    req.on('error', () => {
      if (finished) return
      this.sendOn(socket, { type: 'http-response-start', id: frame.id, status: 502, headers: {} })
      this.sendOn(socket, { type: 'http-response-end', id: frame.id })
      finish()
    })
    this.inFlight.set(frame.id, {
      abort: () => {
        finish()
        req.destroy()
      },
    })
    req.end(frame.body === '' ? undefined : frame.body)
  }

  private sendOn(socket: WebSocket, frame: Exclude<MacToRelay, { type: 'hello' }>): void {
    if (this.socket !== socket || socket.readyState !== OPEN) return
    socket.send(JSON.stringify(frame))
  }

  private emit(event: RelayEvent): void {
    try {
      this.options.onEvent?.(event)
    } catch {
      // The app's handler is not ours to fail.
    }
  }

  private startPing(socket: WebSocket): void {
    if (this.ping !== null) clearInterval(this.ping)
    this.ping = setInterval(() => {
      if (this.socket === socket && socket.readyState === OPEN) socket.send('ping')
    }, this.options.pingMs ?? 30_000)
  }

  /** Every request in flight ends: the relay has already failed them to their callers. */
  private teardown(): void {
    if (this.ping !== null) clearInterval(this.ping)
    this.ping = null
    for (const forwarded of this.inFlight.values()) forwarded.abort()
    this.inFlight.clear()
  }

  private scheduleRetry(refused: boolean): void {
    const { minMs, maxMs } = this.options.backoff ?? { minMs: 1000, maxMs: 60_000 }
    const random = this.options.random ?? Math.random
    const base = refused ? maxMs : Math.min(maxMs, minMs * 2 ** this.attempt)
    const delay = Math.round(base / 2 + (random() * base) / 2)
    this.attempt++
    this.setStatus(refused ? { state: 'refused', retryInMs: delay } : { state: 'offline', retryInMs: delay })
    this.retry = setTimeout(() => {
      this.retry = null
      if (!this.stopped) this.open()
    }, delay)
  }

  private setStatus(status: RelayClientStatus): void {
    this.current = status
    try {
      this.options.onStatus?.(status)
    } catch {
      // As above.
    }
  }
}

function responseHeaders(res: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of RELAY_RESPONSE_HEADERS) {
    const value = res.headers[name]
    if (value === undefined) continue
    const text = Array.isArray(value) ? value.join(', ') : String(value)
    if (text.length <= 8192) out[name] = text
  }
  return out
}

/** At most `max` characters, never splitting a surrogate pair. */
function takeChunk(text: string, max: number): string {
  if (text.length <= max) return text
  const code = text.charCodeAt(max - 1)
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max)
}
