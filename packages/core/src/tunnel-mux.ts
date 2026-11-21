// Streams over one WebSocket, for the blind relay (tunnel-protocol.ts). Both ends use this: the
// relay pipes each incoming TCP connection into a stream it opens; the Mac gets each stream as a
// Duplex and puts TLS on it. Credit-based flow control keeps a slow stream from holding the others
// back or growing a buffer without bound.

import { Duplex } from 'node:stream'
import {
  decodeTunnelFrame,
  encodeTunnelFrame,
  TUNNEL_FRAME,
  TUNNEL_LIMITS,
  type TunnelFrame,
  type TunnelOpen,
} from './tunnel-protocol'

export interface TunnelMuxOptions {
  /** Sends one binary frame on the WebSocket. */
  readonly send: (frame: Buffer) => void
  /** The other side opened a stream (only a Mac's mux gets these). */
  readonly onOpen?: (stream: TunnelStream, open: TunnelOpen) => void
  /** The other side broke the protocol: the caller drops the WebSocket. */
  readonly onViolation?: (why: string) => void
  /** Bytes each side may send before it hears credit. TUNNEL_LIMITS.window unless a test says. */
  readonly window?: number
  /** Streams the other side may have open at once. */
  readonly maxStreams?: number
  /** Whether this side may accept `open` frames. The relay's mux never does. */
  readonly acceptsOpen?: boolean
}

export class TunnelMux {
  private readonly streams = new Map<number, TunnelStream>()
  private nextId = 1
  private closed = false
  readonly window: number

  constructor(private readonly options: TunnelMuxOptions) {
    this.window = options.window ?? TUNNEL_LIMITS.window
  }

  get size(): number {
    return this.streams.size
  }

  /** Opens a stream to the other side (the relay, for an incoming connection). */
  open(open: TunnelOpen): TunnelStream {
    if (this.closed) throw new Error('tunnel closed')
    if (this.nextId > TUNNEL_LIMITS.maxStreamId) throw new Error('out of stream ids')
    const id = this.nextId++
    const stream = new TunnelStream(this, id)
    this.streams.set(id, stream)
    this.sendFrame({ kind: TUNNEL_FRAME.open, stream: id, open })
    return stream
  }

  /** One binary WebSocket message from the other side. */
  receive(bytes: Uint8Array): void {
    if (this.closed) return
    const frame = decodeTunnelFrame(bytes)
    if (frame === null) {
      this.violation('malformed frame')
      return
    }
    const stream = this.streams.get(frame.stream)
    if (frame.kind === TUNNEL_FRAME.open) {
      if (this.options.acceptsOpen !== true) {
        this.violation('unexpected open')
        return
      }
      // Ids only go up, so a stale or repeated id is a broken peer, not a race.
      if (stream !== undefined || frame.stream < this.nextId) {
        this.violation('stream id reused')
        return
      }
      this.nextId = frame.stream + 1
      if (this.streams.size >= (this.options.maxStreams ?? TUNNEL_LIMITS.maxStreamsPerMac)) {
        this.sendFrame({ kind: TUNNEL_FRAME.reset, stream: frame.stream })
        return
      }
      const opened = new TunnelStream(this, frame.stream)
      this.streams.set(frame.stream, opened)
      try {
        this.options.onOpen?.(opened, frame.open)
      } catch {
        opened.destroy()
      }
      return
    }
    // Frames for a stream that's gone race its reset; they're dropped.
    if (stream === undefined) return
    stream.frame(frame)
  }

  /** The WebSocket is gone: every stream ends with an error. */
  close(): void {
    if (this.closed) return
    this.closed = true
    for (const stream of [...this.streams.values()]) stream.destroy(new Error('tunnel closed'))
    this.streams.clear()
  }

  /** @internal */
  sendFrame(frame: TunnelFrame): void {
    if (this.closed) return
    this.options.send(encodeTunnelFrame(frame))
  }

  /** @internal */
  forget(id: number): void {
    this.streams.delete(id)
  }

  /** @internal */
  violation(why: string): void {
    this.options.onViolation?.(why)
  }
}

/** One connection through the relay. Bytes written are sent to the other side; bytes it sends are read. */
export class TunnelStream extends Duplex {
  /** Bytes this side may still send before it needs credit. */
  private sendCredit: number
  /** Bytes received and handed to the reader that the other side hasn't been credited for. */
  private uncredited = 0
  /** Bytes the other side may still send before we've credited more. */
  private receiveAllowance: number
  private pending: { chunk: Buffer; callback: (error?: Error | null) => void } | null = null
  private remoteEnded = false
  private localEnded = false
  private gone = false

  constructor(
    private readonly mux: TunnelMux,
    readonly id: number,
  ) {
    super({ allowHalfOpen: true, highWaterMark: 64 * 1024 })
    this.sendCredit = mux.window
    this.receiveAllowance = mux.window
  }

  /** @internal A frame for this stream from the other side. */
  frame(frame: TunnelFrame): void {
    switch (frame.kind) {
      case TUNNEL_FRAME.data: {
        if (this.remoteEnded) {
          this.broken('data after end')
          return
        }
        if (frame.data.length > this.receiveAllowance) {
          this.broken('sent past its credit')
          return
        }
        this.receiveAllowance -= frame.data.length
        this.uncredited += frame.data.length
        // Credit now while the reader keeps up; otherwise _read does it once the reader drains.
        if (this.push(frame.data)) this.grant(false)
        return
      }
      case TUNNEL_FRAME.end:
        if (this.remoteEnded) return
        this.remoteEnded = true
        this.push(null)
        {
          this.maybeDone()
          return
        }
      case TUNNEL_FRAME.reset:
        this.gone = true
        this.mux.forget(this.id)
        this.destroy(new Error('reset by peer'))
        return
      case TUNNEL_FRAME.credit: {
        if (this.sendCredit + frame.credit > this.mux.window) {
          this.broken('credit past the window')
          return
        }
        this.sendCredit += frame.credit
        this.flush()
        return
      }
    }
  }

  override _read(): void {
    this.grant(true)
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.pending = { chunk, callback }
    this.flush()
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.localEnded = true
    this.mux.sendFrame({ kind: TUNNEL_FRAME.end, stream: this.id })
    callback()
    this.maybeDone()
  }

  override _destroy(error: Error | null, callback: (error: Error | null) => void): void {
    if (!this.gone) {
      this.gone = true
      this.mux.forget(this.id)
      // Both directions finished cleanly needs no reset; anything else tells the other side.
      if (!(this.localEnded && this.remoteEnded))
        this.mux.sendFrame({ kind: TUNNEL_FRAME.reset, stream: this.id })
    }
    const pending = this.pending
    this.pending = null
    pending?.callback(error ?? new Error('stream closed'))
    callback(error)
  }

  private flush(): void {
    while (this.pending !== null && this.sendCredit > 0 && !this.gone) {
      const { chunk, callback } = this.pending
      const size = Math.min(chunk.length, this.sendCredit, TUNNEL_LIMITS.maxDataBytes)
      this.mux.sendFrame({ kind: TUNNEL_FRAME.data, stream: this.id, data: chunk.subarray(0, size) })
      this.sendCredit -= size
      if (size === chunk.length) {
        this.pending = null
        callback()
      } else {
        this.pending = { chunk: chunk.subarray(size), callback }
      }
    }
  }

  /** Tells the other side it may send again what the reader has taken, in batches. */
  private grant(force: boolean): void {
    if (this.gone || this.remoteEnded || this.uncredited === 0) return
    if (!force && this.uncredited < this.mux.window / 4) return
    const credit = this.uncredited
    this.uncredited = 0
    this.receiveAllowance += credit
    this.mux.sendFrame({ kind: TUNNEL_FRAME.credit, stream: this.id, credit })
  }

  private maybeDone(): void {
    if (this.localEnded && this.remoteEnded && !this.gone) {
      this.gone = true
      this.mux.forget(this.id)
    }
  }

  private broken(why: string): void {
    this.mux.violation(why)
    this.destroy(new Error(why))
  }
}
