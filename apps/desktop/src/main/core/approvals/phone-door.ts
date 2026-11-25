// Phones reaching this Mac at its own address through the blind relay (docs/blind-relay.md#phones):
// wss://<macId>.<mac domain>/v1/phone/<macId>, with TLS ended here. The Mac plays the part the
// Worker relay plays for phones (docs/relay-worker.md#connections), with the same frames, so the
// iPhone app speaks to either without knowing which: a challenge naming this Mac's origin, a hello
// signed by a phone this Mac trusts, then sealed envelopes; or, before a hello, one sealed pairing
// reply to an offer the Mac opened. The phone channel (phone-channel.ts) sits on top unchanged.
//
// What the Worker relay checks because it is a stranger, this door checks against the Mac's own
// device list: there is no registration step, and a phone the Mac stops trusting is shut out at once.

import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { Duplex } from 'node:stream'
import {
  type MacToRelay,
  phoneToRelaySchema,
  RELAY_LIMITS,
  RELAY_PROTOCOL_VERSION,
  type RelayToPhone,
  relayAuthPayload,
  relayHelloSchema,
  SIGNING_DOMAINS,
  verifyP256,
} from '@valet/core'
import { type WebSocket, WebSocketServer } from 'ws'
import type { DeviceStore } from './devices'
import type { ChannelEvent } from './phone-channel'

/** The same close codes as the Worker relay's (apps/relay/src/core.ts): the phone keys off them. */
export const DOOR_CLOSE = {
  badFrame: 4400,
  authFailed: 4401,
  unregistered: 4403,
  challengeTimeout: 4408,
  replaced: 4409,
  tooMany: 4429,
} as const

/** The Worker relay's caps that apply to phones (RELAY_CAPS there). */
const CAPS = {
  maxFrameBytes: 256 * 1024,
  maxOffers: 3,
  maxOfferMs: 6 * 60_000,
  pairingRepliesPerMinute: 10,
} as const

export interface PhoneDoorOptions {
  readonly devices: DeviceStore
  /** https://<macId>.<mac domain>: named in every challenge, so a phone signs for this Mac only. */
  readonly origin: () => string | null
  /** Envelopes, pairing replies and phones coming and going, for the phone channel. */
  readonly onEvent: (event: ChannelEvent) => void
  /** The APNs token a connected phone sent, for waking it later (apns.ts). */
  readonly onPushToken?: (deviceId: string, token: string) => void
  readonly now?: () => number
  readonly log?: (line: string) => void
}

type DoorState =
  | { readonly phase: 'challenged'; readonly nonce: string; readonly origin: string }
  | { readonly phase: 'ready'; readonly id: string; readonly key: string }
  | { readonly phase: 'pairing'; readonly offerId: string }
  | { readonly phase: 'closed' }

interface Offer {
  readonly offerId: string
  readonly expiresAt: number
  answered: boolean
}

/** Sliding one-minute counts, as the Worker relay's WindowCounter. */
class PerMinute {
  private readonly hits = new Map<string, number[]>()
  constructor(
    private readonly limit: number,
    private readonly now: () => number,
  ) {}
  take(key: string): boolean {
    const now = this.now()
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < 60_000)
    if (recent.length >= this.limit) {
      this.hits.set(key, recent)
      return false
    }
    recent.push(now)
    this.hits.set(key, recent)
    return true
  }
}

const PHONE_PATH = /^\/v1\/phone\/([0-9a-f]{32})$/

export class PhoneDoor {
  private readonly server: Server
  private readonly wss: WebSocketServer
  private readonly sockets = new Map<WebSocket, DoorState>()
  private offers: Offer[] = []
  private readonly now: () => number
  private readonly envelopes: PerMinute
  private readonly pairingReplies: PerMinute
  private stopped = false

  constructor(private readonly options: PhoneDoorOptions) {
    this.now = options.now ?? Date.now
    this.envelopes = new PerMinute(RELAY_LIMITS.maxEnvelopesPerMinutePerDevice, this.now)
    this.pairingReplies = new PerMinute(CAPS.pairingRepliesPerMinute, this.now)
    this.wss = new WebSocketServer({ noServer: true, maxPayload: CAPS.maxFrameBytes })
    this.server = createServer((_req, res) => {
      // Only the WebSocket upgrade is served here.
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
    })
    this.server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head))
    this.server.on('clientError', (_error, socket) => socket.destroy())
  }

  get macId(): string {
    return this.options.devices.macId
  }

  /** A decrypted connection whose first request is for /v1/phone/ (see isPhoneRequest). */
  accept(socket: Duplex): void {
    if (this.stopped) {
      socket.destroy()
      return
    }
    this.server.emit('connection', socket)
  }

  /** Whether a phone is connected here now, ready. */
  online(deviceId: string): boolean {
    return this.readySocket(deviceId) !== null
  }

  /** Whether a pairing reply to this offer came in here, so its answer goes back here. */
  pairingHere(offerId: string): boolean {
    for (const state of this.sockets.values())
      if (state.phase === 'pairing' && state.offerId === offerId) return true
    return false
  }

  /**
   * A frame the phone channel would send the Worker relay. True when it was meant for this door
   * and done here; false when it wasn't (another phone, a push) or couldn't be.
   */
  send(frame: Exclude<MacToRelay, { type: 'hello' }>): boolean {
    if (this.stopped) return false
    switch (frame.type) {
      case 'envelope': {
        const socket = this.readySocket(frame.envelope.to)
        if (socket === null || frame.envelope.from !== this.macId) return false
        return this.sendTo(socket, { type: 'envelope', envelope: frame.envelope })
      }
      case 'pairing-open': {
        const now = this.now()
        const at = Math.min(Date.parse(frame.expiresAt), now + CAPS.maxOfferMs)
        if (!(at > now)) return false
        this.offers = this.offers.filter((o) => o.expiresAt > now)
        const kept = this.offers.find((o) => o.offerId === frame.offerId)
        // Opening an offer again keeps it answered if it was.
        if (kept !== undefined) return true
        if (this.offers.length >= CAPS.maxOffers) this.offers.shift()
        this.offers.push({ offerId: frame.offerId, expiresAt: at, answered: false })
        return true
      }
      case 'pairing-challenge': {
        const socket = this.pairingSocket(frame.offerId)
        if (socket === null) return false
        return this.sendTo(socket, {
          type: 'pairing-challenge',
          offerId: frame.offerId,
          macNonce: frame.macNonce,
          signature: frame.signature,
        })
      }
      case 'pairing-result': {
        const socket = this.pairingSocket(frame.offerId)
        if (socket === null) return false
        this.sendTo(socket, { type: 'pairing-result', offerId: frame.offerId, sealed: frame.sealed })
        // Paired or not, this connection's job is done; a paired phone connects again and says hello.
        this.close(socket, 1000, 'pairing finished')
        return true
      }
      case 'device-register': {
        // Nothing to register: the door asks the device list. A new key for a connected phone
        // means its socket proved the old one, so it goes.
        for (const [socket, state] of this.sockets)
          if (state.phase === 'ready' && state.id === frame.deviceId && state.key !== frame.transportKey)
            this.close(socket, DOOR_CLOSE.unregistered, 'key changed')
        return true
      }
      case 'device-unregister':
        this.shut(frame.deviceId)
        return true
      default:
        return false
    }
  }

  /**
   * The device list changed (a phone removed here, or gone from the account's list): any phone
   * connected here that the Mac no longer trusts, or whose key changed, is shut out.
   */
  devicesChanged(): void {
    for (const [socket, state] of this.sockets) {
      if (state.phase !== 'ready') continue
      const record = this.options.devices.isActivePhone(state.id)
        ? this.options.devices.device(state.id)
        : null
      if (record === null || record.transportKey !== state.key)
        this.close(socket, DOOR_CLOSE.unregistered, 'unregistered')
    }
  }

  /** Closes every connection; the door takes no more. */
  stop(): void {
    this.stopped = true
    for (const socket of [...this.sockets.keys()]) this.close(socket, 1001, 'going away')
    this.wss.close()
    this.server.close()
  }

  // MARK: Connections

  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const path = PHONE_PATH.exec((req.url ?? '').split('?')[0] ?? '')
    const origin = this.options.origin()
    if (path?.[1] !== this.macId || origin === null || req.method !== 'GET') {
      socket.end('HTTP/1.1 404 Not Found\r\nconnection: close\r\ncontent-length: 0\r\n\r\n')
      return
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.opened(ws, origin))
  }

  private opened(socket: WebSocket, origin: string): void {
    const nonce = randomBytes(32).toString('base64url')
    this.sockets.set(socket, { phase: 'challenged', nonce, origin })
    const timer = setTimeout(() => {
      if (this.sockets.get(socket)?.phase === 'challenged')
        this.close(socket, DOOR_CLOSE.challengeTimeout, 'no hello')
    }, RELAY_LIMITS.challengeTimeoutMs)
    timer.unref?.()
    socket.on('message', (data, binary) => {
      if (binary) return this.close(socket, DOOR_CLOSE.badFrame, 'text frames only')
      this.message(socket, data.toString('utf8'))
    })
    socket.on('close', () => {
      clearTimeout(timer)
      this.closed(socket)
    })
    socket.on('error', () => socket.terminate())
    this.sendTo(socket, { type: 'challenge', v: RELAY_PROTOCOL_VERSION, nonce, relay: origin })
  }

  private message(socket: WebSocket, data: string) {
    const state = this.sockets.get(socket)
    if (state === undefined || state.phase === 'closed') return
    if (data === 'ping') {
      socket.send('pong')
      return
    }
    let raw: unknown
    try {
      raw = JSON.parse(data)
    } catch {
      return this.close(socket, DOOR_CLOSE.badFrame, 'not JSON')
    }
    if (state.phase === 'pairing') return this.close(socket, DOOR_CLOSE.badFrame, 'waiting for the Mac')
    if (state.phase === 'challenged') {
      if ((raw as { type?: unknown } | null)?.type === 'pairing-reply') return this.pairingReply(socket, raw)
      return this.hello(socket, state, raw)
    }
    const parsed = phoneToRelaySchema.safeParse(raw)
    if (!parsed.success || parsed.data.type === 'hello' || parsed.data.type === 'pairing-reply')
      return this.close(socket, DOOR_CLOSE.badFrame, 'bad frame')
    if (!this.envelopes.take(state.id)) return this.close(socket, DOOR_CLOSE.tooMany, 'too many frames')
    const frame = parsed.data
    // Locking the relay asks a stranger to stop passing traffic while the Mac is away. Here the
    // Mac itself is answering, and nothing reaches it while it is away; the phone's Pause and
    // Lock down commands, sealed, are the way to stop it. A push token is kept here, at the Mac,
    // which sends its own wakes (apns.ts).
    if (frame.type === 'push-token') {
      this.options.onPushToken?.(state.id, frame.token)
      return
    }
    if (frame.type === 'relay-lock') return
    const envelope = frame.envelope
    if (envelope.from !== state.id || envelope.to !== this.macId)
      return this.close(socket, DOOR_CLOSE.badFrame, 'envelopes go from this phone to its Mac')
    if (Buffer.byteLength(data) > RELAY_LIMITS.maxEnvelopeBytes)
      return this.close(socket, DOOR_CLOSE.badFrame, 'envelope too large')
    this.options.onEvent({ type: 'envelope', envelope })
  }

  private hello(socket: WebSocket, state: DoorState & { phase: 'challenged' }, raw: unknown) {
    const parsed = relayHelloSchema.safeParse(raw)
    if (!parsed.success || parsed.data.role !== 'phone' || parsed.data.transportKey !== undefined)
      return this.close(socket, DOOR_CLOSE.authFailed, 'refused')
    const hello = parsed.data
    // A phone the Mac doesn't trust, or a wrong signature: the same answer, so a stranger can't
    // tell which phone ids exist.
    const record = this.options.devices.isActivePhone(hello.id) ? this.options.devices.device(hello.id) : null
    const payload = relayAuthPayload({ nonce: state.nonce, relay: state.origin, role: 'phone', id: hello.id })
    if (
      record === null ||
      !verifyP256(record.transportKey, SIGNING_DOMAINS.relayAuth, payload, hello.signature)
    )
      return this.close(socket, DOOR_CLOSE.authFailed, 'refused')
    // A phone that dials twice replaces its older connection, so a reconnect never locks it out.
    for (const [other, s] of this.sockets)
      if (other !== socket && s.phase === 'ready' && s.id === hello.id) {
        this.sockets.set(other, { phase: 'closed' })
        other.close(DOOR_CLOSE.replaced, 'replaced')
      }
    this.sockets.set(socket, { phase: 'ready', id: hello.id, key: record.transportKey })
    this.sendTo(socket, { type: 'ready', macOnline: true })
    this.options.log?.(`[phone door] ${hello.id.slice(0, 8)} connected`)
    this.options.onEvent({ type: 'device-online', deviceId: hello.id, online: true })
  }

  private pairingReply(socket: WebSocket, raw: unknown) {
    const parsed = phoneToRelaySchema.safeParse(raw)
    if (!parsed.success || parsed.data.type !== 'pairing-reply')
      return this.close(socket, DOOR_CLOSE.badFrame, 'bad frame')
    const reply = parsed.data
    const now = this.now()
    const offer = this.offers.find((o) => o.offerId === reply.offerId && o.expiresAt > now)
    if (reply.macId !== this.macId || offer === undefined || offer.answered)
      return this.close(socket, DOOR_CLOSE.authFailed, 'refused')
    // Counted only for a real open offer, so junk can't use the budget up and block the person.
    if (!this.pairingReplies.take('all')) return this.close(socket, DOOR_CLOSE.tooMany, 'too many')
    offer.answered = true
    this.sockets.set(socket, { phase: 'pairing', offerId: offer.offerId })
    const timer = setTimeout(
      () => {
        if (this.sockets.get(socket)?.phase === 'pairing') this.close(socket, 1000, 'offer expired')
      },
      Math.max(0, offer.expiresAt - now),
    )
    timer.unref?.()
    socket.once('close', () => clearTimeout(timer))
    this.options.onEvent({ type: 'pairing-reply', offerId: offer.offerId, sealed: reply.sealed })
  }

  private closed(socket: WebSocket): void {
    const state = this.sockets.get(socket)
    this.sockets.delete(socket)
    if (state?.phase !== 'ready') return
    if (this.readySocket(state.id) !== null) return
    this.options.onEvent({ type: 'device-online', deviceId: state.id, online: false })
  }

  private shut(deviceId: string): void {
    for (const [socket, state] of this.sockets)
      if (state.phase === 'ready' && state.id === deviceId)
        this.close(socket, DOOR_CLOSE.unregistered, 'unregistered')
  }

  private close(socket: WebSocket, code: number, reason: string): void {
    const state = this.sockets.get(socket)
    if (state?.phase === 'ready') {
      // Told now, not when the close handshake ends, so nothing more is sent its way.
      this.sockets.set(socket, { phase: 'closed' })
      if (this.readySocket(state.id) === null)
        this.options.onEvent({ type: 'device-online', deviceId: state.id, online: false })
    } else this.sockets.set(socket, { phase: 'closed' })
    socket.close(code, reason)
    // A peer that never answers the close handshake doesn't hold the socket.
    setTimeout(() => socket.terminate(), 5_000).unref?.()
  }

  private readySocket(deviceId: string): WebSocket | null {
    for (const [socket, state] of this.sockets)
      if (state.phase === 'ready' && state.id === deviceId) return socket
    return null
  }

  private pairingSocket(offerId: string): WebSocket | null {
    for (const [socket, state] of this.sockets)
      if (state.phase === 'pairing' && state.offerId === offerId) return socket
    return null
  }

  private sendTo(socket: WebSocket, frame: RelayToPhone): boolean {
    if (socket.readyState !== socket.OPEN) return false
    socket.send(JSON.stringify(frame))
    return true
  }
}

/**
 * Hands a decrypted connection on by its first request line: one for /v1/phone/ to the door, any
 * other to `other`. The bytes read are put back, so whoever takes it reads the request whole.
 */
export function routeByRequest(
  socket: Duplex,
  phone: ((socket: Duplex) => void) | null,
  other: ((socket: Duplex) => void) | null,
  waitMs = 10_000,
): void {
  if (phone === null) {
    if (other === null) socket.destroy()
    else other(socket)
    return
  }
  const chunks: Buffer[] = []
  let size = 0
  let handed = false
  // A phone sends its request line at once. Anything slower, such as a client that opens a
  // connection early and sends its first request later, is not a phone: it goes to `other`
  // as it is, which keeps its own idle limits. Never close it here.
  const handOn = (target: ((socket: Duplex) => void) | null) => {
    if (handed) return
    handed = true
    clearTimeout(timer)
    socket.off('data', onData)
    socket.pause()
    if (target === null) return socket.destroy()
    if (chunks.length > 0) socket.unshift(Buffer.concat(chunks))
    // Whoever takes it attaches its readers now; then the bytes flow again.
    target(socket)
    socket.resume()
  }
  const timer = setTimeout(() => handOn(other), waitMs)
  let decided = false
  const onData = (chunk: Buffer) => {
    chunks.push(chunk)
    size += chunk.length
    if (decided) return
    const head = Buffer.concat(chunks)
    const line = head.indexOf('\r\n')
    if (line === -1 && size < 8192) return
    const first = head.subarray(0, line === -1 ? head.length : line).toString('latin1')
    // Handed on once this read is done, not now. Node's HTTP server reads a TLS socket's decrypted
    // bytes straight from its handle, so a record that came in the same read as the head (a client
    // that writes its headers and then its body, as Python's httpx does) would reach the parser
    // ahead of the head put back, and it answered 400 Bad Request: Claude's connector check was
    // that client. Every record of this read lands in `chunks` first.
    decided = true
    setImmediate(() => handOn(isPhoneRequest(first) ? phone : other))
  }
  socket.on('data', onData)
  socket.once('close', () => clearTimeout(timer))
}

/** `GET /v1/phone/<anything> HTTP/1.1`: what a phone sends first. */
export function isPhoneRequest(requestLine: string): boolean {
  return /^GET \/v1\/phone\/[^\s]* HTTP\/1\.1$/.test(requestLine)
}
