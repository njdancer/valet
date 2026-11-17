// A WebSocket over a connection the broker dialled (docs/adapter-kinds.md#http). Tool code never
// holds the socket: it sends and receives whole messages through the broker, which spends each sent
// message from the run's upload budget before it goes, counts what arrives, holds at most a few
// messages waiting to be read, and closes the socket when the call ends. No compression extension
// (a small frame can't inflate into a large one) and no redirects.

import type { Socket } from 'node:net'
import { ValetError } from '@valet/core'
import { WebSocket } from 'ws'

export const MAX_MESSAGE_BYTES = 1024 * 1024
/** Messages received and not yet read; past this the socket is closed as a misbehaving server. */
export const MAX_QUEUED_MESSAGES = 256
export const MAX_QUEUED_BYTES = 8 * 1024 * 1024
export const MAX_RECEIVE_WAIT_MS = 30_000
export const HANDSHAKE_TIMEOUT_MS = 15_000
/** A frame's header, near enough to budget a message. */
const FRAME_OVERHEAD = 14

export type SocketMessage =
  | { readonly kind: 'message'; readonly data: Buffer; readonly binary: boolean }
  | { readonly kind: 'closed'; readonly code: number }

export interface OpenSocketOptions {
  readonly url: URL
  readonly protocols?: readonly string[]
  /** Request headers for the handshake, already checked. Lower-case names. */
  readonly headers?: Readonly<Record<string, string>>
  readonly signal?: AbortSignal
  /** Spends bytes before they are sent; throws to refuse (the run's upload budget). */
  readonly spend: (bytes: number) => void
  readonly onReceive: (bytes: number) => void
}

/** One open socket. Everything it does ends when close() is called or the signal aborts. */
export class BrokerSocket {
  private readonly queue: SocketMessage[] = []
  private queuedBytes = 0
  private closedWith: number | null = null
  private broken: ValetError | null = null
  private waiter: ((message: SocketMessage | null) => void) | null = null

  private constructor(
    private readonly ws: WebSocket,
    private readonly options: OpenSocketOptions,
  ) {}

  /** Opens a socket on `socket`, already dialled and verified for options.url's endpoint. */
  static open(socket: Socket, options: OpenSocketOptions): Promise<BrokerSocket> {
    return new Promise((resolve, reject) => {
      const handshake = `GET ${options.url.pathname}${options.url.search} HTTP/1.1`
      try {
        options.spend(handshakeSize(handshake, options))
      } catch (error) {
        socket.destroy()
        reject(error)
        return
      }
      const ws = new WebSocket(options.url.href, [...(options.protocols ?? [])], {
        createConnection: () => socket,
        perMessageDeflate: false,
        maxPayload: MAX_MESSAGE_BYTES,
        followRedirects: false,
        handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
        headers: { ...(options.headers ?? {}) },
        skipUTF8Validation: false,
      })
      const broker = new BrokerSocket(ws, options)
      let opened = false
      const onAbort = () => {
        ws.terminate()
        if (!opened) reject(new ValetError('tool-run', 'aborted'))
      }
      if (options.signal?.aborted) return onAbort()
      options.signal?.addEventListener('abort', onAbort, { once: true })
      ws.on('open', () => {
        opened = true
        resolve(broker)
      })
      ws.on('unexpected-response', (_req, res) => {
        res.resume()
        ws.terminate()
        if (!opened) reject(new ValetError('egress', 'unavailable'))
      })
      ws.on('error', () => {
        if (!opened) reject(new ValetError('egress', 'unavailable'))
        broker.closed(1006)
      })
      ws.on('close', (code: number) => {
        options.signal?.removeEventListener('abort', onAbort)
        broker.closed(code)
        if (!opened) reject(new ValetError('egress', 'unavailable'))
      })
      ws.on('message', (data: Buffer | ArrayBuffer | Buffer[], binary: boolean) => {
        const bytes = Buffer.isBuffer(data)
          ? data
          : Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.from(data as ArrayBuffer)
        broker.received(bytes, binary)
      })
    })
  }

  /** Sends one message. Its bytes are spent from the budget first; refused, nothing is sent. */
  send(data: Buffer, binary: boolean): Promise<void> {
    if (this.broken !== null) return Promise.reject(this.broken)
    if (this.closedWith !== null || this.ws.readyState !== WebSocket.OPEN)
      return Promise.reject(new ValetError('egress', 'unavailable'))
    if (data.byteLength > MAX_MESSAGE_BYTES) return Promise.reject(new ValetError('tool-run', 'invalid'))
    try {
      this.options.spend(data.byteLength + FRAME_OVERHEAD)
    } catch (error) {
      // Over budget: the socket goes too, so nothing more leaves on it.
      this.close()
      return Promise.reject(error)
    }
    return new Promise((resolve, reject) => {
      this.ws.send(data, { binary }, (error) =>
        error ? reject(new ValetError('egress', 'unavailable')) : resolve(),
      )
    })
  }

  /**
   * The next message, waiting up to `waitMs` for one. Null when none came in time; `closed` once
   * the socket has closed and every earlier message has been read.
   */
  receive(waitMs: number): Promise<SocketMessage | null> {
    if (this.broken !== null) return Promise.reject(this.broken)
    const next = this.queue.shift()
    if (next !== undefined) {
      if (next.kind === 'message') this.queuedBytes -= next.data.byteLength
      return Promise.resolve(next)
    }
    if (this.closedWith !== null) return Promise.resolve({ kind: 'closed', code: this.closedWith })
    if (this.waiter !== null) return Promise.reject(new ValetError('tool-run', 'invalid'))
    const wait = Math.max(0, Math.min(MAX_RECEIVE_WAIT_MS, Math.floor(waitMs)))
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiter = null
        resolve(null)
      }, wait)
      const onAbort = () => {
        clearTimeout(timer)
        this.waiter = null
        resolve(null)
      }
      this.options.signal?.addEventListener('abort', onAbort, { once: true })
      this.waiter = (message) => {
        clearTimeout(timer)
        this.options.signal?.removeEventListener('abort', onAbort)
        this.waiter = null
        resolve(message)
      }
    })
  }

  close(): void {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
      this.ws.terminate()
    this.closed(this.closedWith ?? 1000)
  }

  get isClosed(): boolean {
    return this.closedWith !== null
  }

  private received(data: Buffer, binary: boolean): void {
    this.options.onReceive(data.byteLength + FRAME_OVERHEAD)
    if (this.waiter !== null) {
      this.waiter({ kind: 'message', data, binary })
      return
    }
    if (this.queue.length >= MAX_QUEUED_MESSAGES || this.queuedBytes + data.byteLength > MAX_QUEUED_BYTES) {
      // A server flooding the socket faster than tool code reads it.
      this.broken = new ValetError('tool-run', 'unexpected-shape')
      this.ws.terminate()
      return
    }
    this.queue.push({ kind: 'message', data, binary })
    this.queuedBytes += data.byteLength
  }

  private closed(code: number): void {
    if (this.closedWith !== null) return
    this.closedWith = code
    if (this.waiter !== null && this.queue.length === 0) this.waiter({ kind: 'closed', code })
  }
}

/**
 * The bytes the opening handshake puts on the wire, at least: the request line, Host, the caller's
 * headers and subprotocols, and 256 for the ones ws adds itself (Upgrade, Connection, the key,
 * version and extensions).
 */
function handshakeSize(requestLine: string, options: OpenSocketOptions): number {
  let size = requestLine.length + 2 + `host: ${options.url.host}\r\n`.length + 256 + 2
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    size += Buffer.byteLength(`${name}: ${value}\r\n`, 'latin1')
  }
  const protocols = options.protocols ?? []
  if (protocols.length > 0) size += `sec-websocket-protocol: ${protocols.join(', ')}\r\n`.length
  return size
}
