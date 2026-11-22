// The Mac's side of the blind relay (docs/blind-relay.md). It dials out to the relay over a
// WebSocket, so nothing connects in to the Mac, signs the relay's challenge with the transport key,
// and then receives each connection a cloud agent or a phone makes to `<macId>.<mac domain>` as a
// stream of raw TLS bytes. TLS ends here: this file puts the Mac's own certificate on the stream and
// hands the decrypted connection to the remote listener's HTTP server, the same one a tunnel daemon
// reaches on 127.0.0.1 (D41). The relay only ever sees ciphertext.
//
// A connection offering ALPN `acme-tls/1` is Let's Encrypt checking that this Mac controls its name
// (RFC 8737): it gets the challenge certificate the ACME client set up, and nothing else.

import type { SecureContext } from 'node:tls'
import { TLSSocket } from 'node:tls'
import {
  parseClientHello,
  relayAuthPayload,
  relayChallengeSchema,
  TUNNEL_LIMITS,
  TUNNEL_PATH_PREFIX,
  TunnelMux,
  type TunnelOpen,
  type TunnelStream,
  tunnelHost,
  tunnelReadySchema,
} from '@valet/core'
import type { AcceptedConnection } from './http'
import type { RelayBinding, TransportSigner } from './relay-client'

export const ACME_TLS_ALPN = 'acme-tls/1'

export type TunnelClientStatus =
  | { readonly state: 'connecting' }
  | { readonly state: 'online'; readonly host: string }
  | { readonly state: 'offline'; readonly retryInMs: number }
  /** The relay refused this Mac's key. Retried slowly; the app tells the person. */
  | { readonly state: 'refused'; readonly retryInMs: number }
  /** Another process connected as this Mac. Not retried, or the two would take turns forever. */
  | { readonly state: 'replaced' }
  | { readonly state: 'stopped' }

export interface TunnelClientOptions {
  /** The relay's own origin, e.g. https://relay.valet.example. Its challenge must name exactly this. */
  readonly relay: string
  /** The domain Macs are named under: this Mac is `<macId>.<macDomain>`. */
  readonly macDomain: string
  readonly macId: string
  readonly signer: TransportSigner
  readonly binding: RelayBinding
  /** This Mac's certificate for its public name, or null while it has none yet. */
  readonly certificate: () => SecureContext | null
  /** The TLS-ALPN-01 certificate for a name being validated now, or null when nothing is. */
  readonly acmeChallenge?: (serverName: string) => SecureContext | null
  /**
   * Where a decrypted connection goes: the remote listener's accept, or null while remote access
   * is paused (the connection is then closed, as a stopped listener would).
   */
  readonly listener: () => ((socket: TLSSocket, meta: AcceptedConnection) => void) | null
  readonly onStatus?: (status: TunnelClientStatus) => void
  /** Something the relay sent that this Mac refused (it then drops the connection). */
  readonly onBadFrame?: (why: string) => void
  /**
   * A connection this Mac dropped before it reached the listener, and why: a hello it couldn't
   * read, another name, nothing to serve it with, or a TLS handshake that failed. Never content.
   */
  readonly onDropped?: (why: string) => void
  /** Where to connect, when it isn't the relay's own origin (tests and a local relay). */
  readonly connectUrl?: string
  readonly WebSocket?: typeof WebSocket
  readonly backoff?: { readonly minMs: number; readonly maxMs: number }
  readonly random?: () => number
  /**
   * How often the Mac pings the relay. A ping the relay hasn't answered by the next one means the
   * link is dead though no close came (a network that dropped it silently): the Mac drops it and
   * dials again at once, rather than leaving callers' connections to vanish into it.
   */
  readonly pingMs?: number
  /** For tests: TUNNEL_LIMITS.window otherwise. Both ends must agree. */
  readonly window?: number
}

const OPEN = 1
const CLOSE_AUTH_FAILED = 4401
const CLOSE_REPLACED = 4409
const CLOSE_BAD_FRAME = 4400
const CLOSE_SIGN_FAILED = 4500

export class TunnelClient {
  private socket: WebSocket | null = null
  private mux: TunnelMux | null = null
  private stopped = true
  private attempt = 0
  private retry: ReturnType<typeof setTimeout> | null = null
  private ping: ReturnType<typeof setInterval> | null = null
  /** A ping is out and nothing has come back from the relay since. */
  private unanswered = false
  private current: TunnelClientStatus = { state: 'stopped' }
  private readonly open = new Set<TunnelStream>()

  constructor(private readonly options: TunnelClientOptions) {}

  /** The name cloud agents and phones use for this Mac. */
  get publicHost(): string {
    return tunnelHost(this.options.macId, this.options.macDomain)
  }

  get status(): TunnelClientStatus {
    return this.current
  }

  /** Connections through the relay open now. */
  get connections(): number {
    return this.open.size
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.attempt = 0
    this.dial()
  }

  /** Closes the WebSocket, and with it every connection through the relay. */
  stop(): void {
    this.stopped = true
    if (this.retry !== null) clearTimeout(this.retry)
    this.retry = null
    this.teardown()
    this.socket?.close(1000, 'stopped')
    this.socket = null
    this.setStatus({ state: 'stopped' })
  }

  private dial(): void {
    this.setStatus({ state: 'connecting' })
    const Impl = this.options.WebSocket ?? WebSocket
    const base = (this.options.connectUrl ?? this.options.relay).replace(/^http/, 'ws').replace(/\/$/, '')
    let socket: WebSocket
    try {
      socket = new Impl(`${base}${TUNNEL_PATH_PREFIX}${this.options.macId}`)
    } catch {
      this.scheduleRetry(false)
      return
    }
    socket.binaryType = 'arraybuffer'
    this.socket = socket
    let ready = false
    socket.addEventListener('message', (event) => {
      if (this.socket !== socket) return
      this.unanswered = false
      const data: unknown = event.data
      if (typeof data === 'string') {
        if (data === 'pong') return
        void this.onControl(socket, data, ready).then((nowReady) => {
          ready ||= nowReady
        })
        return
      }
      // Stream frames only after the relay has said this Mac is signed in.
      if (!ready || this.mux === null || !(data instanceof ArrayBuffer))
        return this.bad(socket, 'early or odd frame')
      this.mux.receive(new Uint8Array(data))
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
      this.scheduleRetry(event.code === CLOSE_AUTH_FAILED)
    })
    socket.addEventListener('error', () => {
      // A close event follows.
    })
  }

  /** A text frame: the challenge, then ready. True once this Mac is signed in. */
  private async onControl(socket: WebSocket, data: string, ready: boolean): Promise<boolean> {
    let value: unknown
    try {
      value = JSON.parse(data)
    } catch {
      this.bad(socket, 'not JSON')
      return false
    }
    const challenge = relayChallengeSchema.safeParse(value)
    if (challenge.success && !ready) {
      // A challenge for another relay would sign us in there with this signature: refuse it.
      if (challenge.data.relay !== this.options.relay) {
        this.bad(socket, 'wrong relay')
        return false
      }
      const payload = relayAuthPayload({
        nonce: challenge.data.nonce,
        relay: challenge.data.relay,
        role: 'mac',
        id: this.options.macId,
      })
      let signature: string
      try {
        signature = await this.options.signer.sign(payload)
      } catch {
        socket.close(CLOSE_SIGN_FAILED, 'could not sign')
        return false
      }
      if (this.socket !== socket) return false
      socket.send(
        JSON.stringify({
          type: 'hello',
          role: 'mac',
          id: this.options.macId,
          transportKey: this.options.signer.publicKey,
          binding: this.options.binding,
          signature,
        }),
      )
      return false
    }
    const parsedReady = tunnelReadySchema.safeParse(value)
    if (parsedReady.success && !ready) {
      if (parsedReady.data.host !== this.publicHost) {
        this.bad(socket, 'relay names another host')
        return false
      }
      this.attempt = 0
      this.mux = new TunnelMux({
        acceptsOpen: true,
        ...(this.options.window === undefined ? {} : { window: this.options.window }),
        send: (frame) => {
          if (this.socket === socket && socket.readyState === OPEN) socket.send(new Uint8Array(frame))
        },
        onOpen: (stream, open) => this.serve(stream, open),
        onViolation: (why) => this.bad(socket, why),
      })
      this.startPing(socket)
      this.setStatus({ state: 'online', host: parsedReady.data.host })
      return true
    }
    this.bad(socket, 'unexpected control frame')
    return false
  }

  /** One connection: read its ClientHello, pick the certificate, end TLS here, hand it on. */
  private serve(stream: TunnelStream, open: TunnelOpen): void {
    this.open.add(stream)
    stream.on('close', () => this.open.delete(stream))
    stream.on('error', () => undefined)
    const chunks: Buffer[] = []
    let size = 0
    const timer = setTimeout(() => stream.destroy(), TUNNEL_LIMITS.clientHelloTimeoutMs)
    const onData = (chunk: Buffer) => {
      chunks.push(chunk)
      size += chunk.length
      const hello = parseClientHello(Buffer.concat(chunks))
      if (hello.state === 'partial' && size < TUNNEL_LIMITS.maxClientHelloBytes) return
      clearTimeout(timer)
      stream.off('data', onData)
      stream.pause()
      if (hello.state !== 'complete') return this.drop(stream, `unreadable hello (${hello.state})`)
      // The bytes go back so TLS reads the hello itself.
      stream.unshift(Buffer.concat(chunks))
      if (hello.alpn.includes(ACME_TLS_ALPN)) {
        const context =
          hello.serverName === null ? null : (this.options.acmeChallenge?.(hello.serverName) ?? null)
        if (context === null) return stream.destroy()
        // The validator completes the handshake and leaves; nothing else is served on it.
        const tls = new TLSSocket(stream, {
          isServer: true,
          secureContext: context,
          ALPNProtocols: [ACME_TLS_ALPN],
        })
        tls.on('error', () => tls.destroy())
        tls.on('secure', () => tls.end())
        return
      }
      if (hello.serverName !== this.publicHost)
        return this.drop(stream, `name ${JSON.stringify((hello.serverName ?? '').slice(0, 100))}`)
      const context = this.options.certificate()
      const accept = this.options.listener()
      if (context === null) return this.drop(stream, 'no certificate yet')
      if (accept === null) return this.drop(stream, 'remote access paused')
      const tls = new TLSSocket(stream, {
        isServer: true,
        secureContext: context,
        ALPNProtocols: ['http/1.1'],
      })
      let secured = false
      tls.once('secure', () => {
        secured = true
      })
      tls.on('error', (error: Error & { code?: string }) => {
        if (!secured)
          this.options.onDropped?.(`tls handshake failed: ${error.code ?? ''} ${error.message}`.slice(0, 200))
        tls.destroy()
      })
      tls.on('close', () => stream.destroy())
      try {
        accept(tls, { source: open.source })
      } catch {
        tls.destroy()
      }
    }
    stream.on('data', onData)
    stream.on('end', () => {
      if (size === 0) stream.destroy()
    })
  }

  private drop(stream: TunnelStream, why: string): void {
    try {
      this.options.onDropped?.(why)
    } catch {
      // A log line is not worth more than the connection.
    }
    stream.destroy()
  }

  private bad(socket: WebSocket, why: string): void {
    this.options.onBadFrame?.(why)
    if (this.socket === socket) socket.close(CLOSE_BAD_FRAME, 'bad frame')
  }

  private startPing(socket: WebSocket): void {
    if (this.ping !== null) clearInterval(this.ping)
    this.unanswered = false
    this.ping = setInterval(() => {
      if (this.socket !== socket) return
      if (this.unanswered) return this.dead(socket)
      if (socket.readyState !== OPEN) return
      this.unanswered = true
      socket.send('ping')
    }, this.options.pingMs ?? 15_000)
  }

  /** The relay stopped answering: let this socket go without waiting for a close, and dial again. */
  private dead(socket: WebSocket): void {
    this.socket = null
    this.teardown()
    const terminate = (socket as unknown as { terminate?: () => void }).terminate
    try {
      if (typeof terminate === 'function') terminate.call(socket)
      else socket.close(4000, 'no answer')
    } catch {
      // Gone either way.
    }
    if (this.stopped) return
    // It was online a moment ago: straight back, not after a backoff.
    this.attempt = 0
    this.scheduleRetry(false)
  }

  private teardown(): void {
    if (this.ping !== null) clearInterval(this.ping)
    this.ping = null
    this.mux?.close()
    this.mux = null
    for (const stream of this.open) stream.destroy()
    this.open.clear()
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
      if (!this.stopped) this.dial()
    }, delay)
  }

  private setStatus(status: TunnelClientStatus): void {
    this.current = status
    try {
      this.options.onStatus?.(status)
    } catch {
      // The app's handler is not ours to fail.
    }
  }
}
