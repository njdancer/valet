// What one Mac's Durable Object does (docs/relay-worker.md), written against small interfaces so
// the same code runs in workerd and in Node's tests. mac-relay.ts adapts the Durable Object API to
// these interfaces; this file never imports from `cloudflare:*`.
//
// The relay is never an authority. It routes bytes between a Mac, its phones and remote clients,
// checks only the outer shape of what it routes, and keeps exactly RelayStoredState at rest.

import {
  type Envelope,
  type MacToRelay,
  macToRelaySchema,
  type PhoneToRelay,
  phoneToRelaySchema,
  RELAY_FORWARDED_HEADERS,
  type RELAY_FORWARDED_PATHS,
  RELAY_LIMITS,
  RELAY_RESPONSE_HEADERS,
  type RelayStoredState,
  type RelayToMac,
  type RelayToPhone,
  relayAuthPayload,
  relayHelloSchema,
} from '@valet/core/relay-protocol'
import { randomToken } from './encoding'
import { logFailure } from './log'
import type { PushKind, PushResult } from './push'
import { verifyRelayAuth } from './verify'
import { WindowCounter } from './window'

/** WebSocket close codes the relay uses. Clients key their reconnect behaviour off them. */
export const CLOSE = {
  badFrame: 4400,
  authFailed: 4401,
  unregistered: 4403,
  challengeTimeout: 4408,
  replaced: 4409,
  tooMany: 4429,
} as const

export const RELAY_TIMINGS = {
  /** A forwarded request whose response hasn't started by then is answered 504. */
  responseStartMs: 120_000,
  /** A response stream is ended after this; MCP clients reconnect with Last-Event-ID. */
  maxStreamMs: 10 * 60_000,
  /** The Mac's answer to consent-open. */
  consentMs: 15_000,
} as const

/** Per-Mac and per-device limits the contract leaves to the relay. */
export const RELAY_CAPS = {
  /** Bytes the Mac may stream back for one response. */
  maxResponseBytes: 8 * 1024 * 1024,
  /** Of the 16 concurrent requests, how many may be long-lived GET streams. */
  maxOpenStreams: 4,
  /** Frames from the Mac: a token bucket refilled at 50 a second, holding up to this many. */
  frameBurst: 500,
  /** The largest text frame accepted from any device, in bytes. */
  maxFrameBytes: 2 * 1024 * 1024,
  pushMinGapMs: 10_000,
  pushesPerHour: 60,
} as const

export type Role = 'mac' | 'phone'
type ForwardedPath = (typeof RELAY_FORWARDED_PATHS)[number]

/** What a socket's hibernation attachment holds: who it is, never anything it sent. */
export type SocketState =
  | { readonly phase: 'challenged'; readonly role: Role; readonly nonce: string; readonly at: number; readonly key: string }
  | { readonly phase: 'ready'; readonly role: Role; readonly id: string; readonly key: string }

export interface RelaySocket {
  send(text: string): void
  close(code: number, reason: string): void
  state(): SocketState | null
  setState(state: SocketState): void
}

export interface RelayEnvironment {
  sockets(): readonly RelaySocket[]
  load(): Promise<RelayStoredState | null>
  save(state: RelayStoredState): Promise<void>
  /** Ask to be called back (`alarm`) at or after this time. */
  wakeAt(at: number): void
  push(token: string, kind: PushKind): Promise<PushResult>
}

export interface RelayCoreOptions {
  readonly macId: string
  /** The relay's own origin, e.g. https://relay.example; challenges name it. */
  readonly origin: string
  readonly env: RelayEnvironment
  readonly now?: () => number
  readonly timings?: Partial<typeof RELAY_TIMINGS>
}

/** One forwarded HTTP request, already through the front door's checks. */
export interface ForwardRequest {
  readonly method: 'GET' | 'POST' | 'DELETE'
  readonly path: ForwardedPath
  readonly query: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
  readonly source: string
  /** True for a GET on /mcp: a long-lived event stream. */
  readonly stream: boolean
}

interface Pending {
  readonly id: string
  readonly stream: boolean
  started: boolean
  bytes: number
  start: (response: Response) => void
  controller: ReadableStreamDefaultController<Uint8Array> | null
  timer: ReturnType<typeof setTimeout> | null
  done: boolean
}

export type ConsentAnswer =
  | { readonly state: 'waiting'; readonly code: string }
  | { readonly state: 'approved' | 'declined'; readonly redirect?: string }
  | { readonly state: 'expired' }
  | { readonly state: 'offline' | 'no-answer' }

const encoder = new TextEncoder()

export function byteLength(text: string): number {
  return encoder.encode(text).length
}

export class RelayCore {
  private readonly now: () => number
  private readonly timings: typeof RELAY_TIMINGS
  private stored: RelayStoredState | null | undefined = undefined
  private readonly pending = new Map<string, Pending>()
  private readonly consents = new Map<string, (answer: ConsentAnswer) => void>()
  /** The Mac's frame bucket, by socket key. */
  private bucket = { tokens: RELAY_CAPS.frameBurst as number, at: 0, key: '' }
  private readonly envelopes: WindowCounter
  private readonly pushGap: WindowCounter
  private readonly pushHour: WindowCounter

  constructor(private readonly options: RelayCoreOptions) {
    this.now = options.now ?? Date.now
    this.timings = { ...RELAY_TIMINGS, ...options.timings }
    this.envelopes = new WindowCounter(RELAY_LIMITS.maxEnvelopesPerMinutePerDevice, 60_000, this.now, 16)
    this.pushGap = new WindowCounter(1, RELAY_CAPS.pushMinGapMs, this.now, 16)
    this.pushHour = new WindowCounter(RELAY_CAPS.pushesPerHour, 60 * 60_000, this.now, 16)
  }

  // ---------- Connections ----------

  /** A device opened a socket. The relay speaks first. */
  connect(socket: RelaySocket, role: Role): void {
    const nonce = randomToken(32)
    const at = this.now()
    socket.setState({ phase: 'challenged', role, nonce, at, key: randomToken(9) })
    this.sendTo(socket, { type: 'challenge', v: 1, nonce, relay: this.options.origin })
    this.options.env.wakeAt(at + RELAY_LIMITS.challengeTimeoutMs)
  }

  /** Closes sockets that never answered their challenge. */
  alarm(): void {
    const now = this.now()
    let next = Number.POSITIVE_INFINITY
    for (const socket of this.options.env.sockets()) {
      const state = socket.state()
      if (state?.phase !== 'challenged') continue
      const due = state.at + RELAY_LIMITS.challengeTimeoutMs
      if (due <= now) socket.close(CLOSE.challengeTimeout, 'challenge not answered')
      else next = Math.min(next, due)
    }
    if (next !== Number.POSITIVE_INFINITY) this.options.env.wakeAt(next)
  }

  async message(socket: RelaySocket, data: string | ArrayBuffer): Promise<void> {
    const state = socket.state()
    if (state === null) return socket.close(CLOSE.badFrame, 'unknown socket')
    if (typeof data !== 'string') return socket.close(CLOSE.badFrame, 'text frames only')
    if (data === 'ping') return socket.send('pong')
    if (data.length > RELAY_CAPS.maxFrameBytes || byteLength(data) > RELAY_CAPS.maxFrameBytes)
      return socket.close(CLOSE.badFrame, 'frame too large')
    let raw: unknown
    try {
      raw = JSON.parse(data)
    } catch {
      return socket.close(CLOSE.badFrame, 'not JSON')
    }
    if (state.phase === 'challenged') return this.hello(socket, state, raw)
    if (state.role === 'mac') {
      if (!this.takeFrame(state.key)) return socket.close(CLOSE.tooMany, 'too many frames')
      const parsed = macToRelaySchema.safeParse(raw)
      if (!parsed.success || parsed.data.type === 'hello') return socket.close(CLOSE.badFrame, 'bad frame')
      return this.fromMac(socket, parsed.data, data)
    }
    const parsed = phoneToRelaySchema.safeParse(raw)
    if (!parsed.success || parsed.data.type === 'hello') return socket.close(CLOSE.badFrame, 'bad frame')
    return this.fromPhone(socket, state.id, parsed.data, data)
  }

  /** A socket closed, whatever the reason. */
  closed(socket: RelaySocket): void {
    const state = socket.state()
    if (state?.phase !== 'ready' || state.key === 'replaced') return
    if (state.role === 'mac') {
      // Only if it was the live Mac socket: a replaced one closing changes nothing.
      if (this.macSocket(socket) !== null) return
      this.failAll()
      for (const phone of this.readySockets('phone')) this.sendTo(phone, { type: 'mac-online', online: false })
      return
    }
    if (this.readySockets('phone').some((s) => s !== socket && idOf(s) === state.id)) return
    const mac = this.macSocket()
    if (mac !== null) this.sendTo(mac, { type: 'device-online', deviceId: state.id, online: false })
  }

  private async hello(socket: RelaySocket, state: SocketState & { phase: 'challenged' }, raw: unknown) {
    const parsed = relayHelloSchema.safeParse(raw)
    if (!parsed.success) return socket.close(CLOSE.authFailed, 'expected hello')
    const hello = parsed.data
    if (this.now() - state.at > RELAY_LIMITS.challengeTimeoutMs)
      return socket.close(CLOSE.challengeTimeout, 'challenge not answered')
    if (hello.role !== state.role) return socket.close(CLOSE.authFailed, 'wrong role')
    const stored = await this.state()
    const payload = relayAuthPayload({ nonce: state.nonce, relay: this.options.origin, role: hello.role, id: hello.id })

    let key: string
    if (hello.role === 'mac') {
      if (hello.id !== this.options.macId) return socket.close(CLOSE.authFailed, 'wrong id')
      if (stored === null) {
        if (hello.transportKey === undefined) return socket.close(CLOSE.authFailed, 'unknown Mac')
        key = hello.transportKey
      } else {
        if (hello.transportKey !== undefined && hello.transportKey !== stored.macTransportKey)
          return socket.close(CLOSE.authFailed, 'wrong key')
        key = stored.macTransportKey
      }
    } else {
      if (hello.transportKey !== undefined) return socket.close(CLOSE.authFailed, 'phones are registered by their Mac')
      const device = stored?.devices.find((d) => d.deviceId === hello.id)
      if (device === undefined) return socket.close(CLOSE.unregistered, 'not registered')
      key = device.transportKey
    }
    if (!(await verifyRelayAuth(key, payload, hello.signature))) return socket.close(CLOSE.authFailed, 'bad signature')
    // The socket may have closed, or been replaced by its own challenge timeout, while verifying.
    if (socket.state()?.phase !== 'challenged') return

    if (hello.role === 'mac' && stored === null) {
      await this.save({ macId: this.options.macId, macTransportKey: key, devices: [], createdAt: new Date(this.now()).toISOString() })
    }
    // A device that phones home twice replaces its older socket, so a reconnect never locks it out.
    for (const other of this.readySockets(hello.role)) {
      if (idOf(other) === hello.id) {
        other.setState({ phase: 'ready', role: hello.role, id: '', key: 'replaced' })
        other.close(CLOSE.replaced, 'replaced by a newer connection')
      }
    }
    socket.setState({ phase: 'ready', role: hello.role, id: hello.id, key: state.key })
    const current = await this.state()
    if (hello.role === 'mac') {
      this.failAll()
      this.bucket = { tokens: RELAY_CAPS.frameBurst, at: this.now(), key: state.key }
      this.sendTo(socket, { type: 'ready', devices: (current?.devices ?? []).map((d) => d.deviceId) })
      for (const phone of this.readySockets('phone')) {
        this.sendTo(phone, { type: 'mac-online', online: true })
        this.sendTo(socket, { type: 'device-online', deviceId: idOf(phone), online: true })
      }
    } else {
      this.sendTo(socket, { type: 'ready', macOnline: this.macSocket() !== null })
      const mac = this.macSocket()
      if (mac !== null) this.sendTo(mac, { type: 'device-online', deviceId: hello.id, online: true })
    }
  }

  // ---------- Frames from the Mac ----------

  private async fromMac(socket: RelaySocket, frame: Exclude<MacToRelay, { type: 'hello' }>, text: string) {
    switch (frame.type) {
      case 'http-response-start':
        return this.responseStart(frame.id, frame.status, frame.headers)
      case 'http-response-chunk':
        return this.responseChunk(frame.id, frame.data)
      case 'http-response-end':
        return this.finish(frame.id)
      case 'consent-view': {
        const resolve = this.consents.get(frame.id)
        if (resolve === undefined) return
        this.consents.delete(frame.id)
        if (frame.state === 'waiting') {
          if (frame.code === undefined) return resolve({ state: 'no-answer' })
          return resolve({ state: 'waiting', code: frame.code })
        }
        if (frame.state === 'expired') return resolve({ state: 'expired' })
        return resolve(frame.redirect === undefined ? { state: frame.state } : { state: frame.state, redirect: frame.redirect })
      }
      case 'device-register':
        return this.register(frame.deviceId, frame.transportKey)
      case 'device-unregister':
        return this.unregister(frame.deviceId)
      case 'envelope': {
        const envelope = frame.envelope
        if (byteLength(text) > RELAY_LIMITS.maxEnvelopeBytes) return
        const stored = await this.state()
        if (envelope.from !== this.options.macId) return socket.close(CLOSE.badFrame, 'envelope not from this Mac')
        if (!stored?.devices.some((d) => d.deviceId === envelope.to)) return
        return this.deliverToPhone(envelope)
      }
      case 'push':
        return this.pushTo(frame.deviceId, frame.kind)
    }
  }

  private async register(deviceId: string, transportKey: string): Promise<void> {
    if (deviceId === this.options.macId) return
    const stored = await this.state()
    if (stored === null) return
    const existing = stored.devices.find((d) => d.deviceId === deviceId)
    if (existing === undefined && stored.devices.length >= RELAY_LIMITS.maxDevicesPerMac) return
    if (existing?.transportKey === transportKey) return
    const devices = stored.devices.filter((d) => d.deviceId !== deviceId)
    devices.push({ deviceId, transportKey, pushToken: null })
    await this.save({ ...stored, devices })
    // A new key for a known phone: its old socket proved the old key, so it goes.
    if (existing !== undefined) this.closeDevice(deviceId, CLOSE.unregistered, 'key changed')
  }

  private async unregister(deviceId: string): Promise<void> {
    const stored = await this.state()
    if (stored === null || !stored.devices.some((d) => d.deviceId === deviceId)) return
    await this.save({ ...stored, devices: stored.devices.filter((d) => d.deviceId !== deviceId) })
    this.closeDevice(deviceId, CLOSE.unregistered, 'unregistered')
  }

  private closeDevice(deviceId: string, code: number, reason: string): void {
    for (const phone of this.readySockets('phone')) if (idOf(phone) === deviceId) phone.close(code, reason)
  }

  private deliverToPhone(envelope: Envelope): void {
    // Not connected: dropped. The Mac sees device-online and the inner acks; nothing is queued.
    for (const phone of this.readySockets('phone'))
      if (idOf(phone) === envelope.to) this.sendTo(phone, { type: 'envelope', envelope })
  }

  private async pushTo(deviceId: string, kind: PushKind): Promise<void> {
    const stored = await this.state()
    const device = stored?.devices.find((d) => d.deviceId === deviceId)
    if (device?.pushToken == null) return
    if (!this.pushGap.take(deviceId) || !this.pushHour.take(deviceId)) return
    const token = device.pushToken
    let result: PushResult
    try {
      result = await this.options.env.push(token, kind)
    } catch (error) {
      logFailure('push', error)
      return
    }
    if (result !== 'gone') return
    const latest = await this.state()
    if (latest === null) return
    await this.save({
      ...latest,
      devices: latest.devices.map((d) => (d.deviceId === deviceId && d.pushToken === token ? { ...d, pushToken: null } : d)),
    })
  }

  // ---------- Frames from a phone ----------

  private async fromPhone(socket: RelaySocket, deviceId: string, frame: Exclude<PhoneToRelay, { type: 'hello' }>, text: string) {
    if (frame.type === 'push-token') {
      const stored = await this.state()
      if (stored === null) return
      if (stored.devices.find((d) => d.deviceId === deviceId)?.pushToken === frame.token) return
      return this.save({
        ...stored,
        devices: stored.devices.map((d) => (d.deviceId === deviceId ? { ...d, pushToken: frame.token } : d)),
      })
    }
    const envelope = frame.envelope
    if (envelope.from !== deviceId || envelope.to !== this.options.macId)
      return socket.close(CLOSE.badFrame, 'envelopes go from this phone to its Mac')
    if (byteLength(text) > RELAY_LIMITS.maxEnvelopeBytes) return socket.close(CLOSE.badFrame, 'envelope too large')
    if (!this.envelopes.take(deviceId)) return socket.close(CLOSE.tooMany, 'too many envelopes')
    // Mac offline: refused, not queued; the phone retries (agent-run-security.md).
    const mac = this.macSocket()
    if (mac !== null) this.sendTo(mac, { type: 'envelope', envelope })
  }

  // ---------- Forwarded HTTP ----------

  macOnline(): boolean {
    return this.macSocket() !== null
  }

  /** Sends one request to the Mac and resolves with its response, streamed as it arrives. */
  forward(request: ForwardRequest, signal?: AbortSignal): Promise<Response> {
    const mac = this.macSocket()
    if (mac === null) return Promise.resolve(offline(request))
    if (this.pending.size >= RELAY_LIMITS.maxConcurrentRequestsPerMac)
      return Promise.resolve(tooBusy())
    if (request.stream && [...this.pending.values()].filter((p) => p.stream).length >= RELAY_CAPS.maxOpenStreams)
      return Promise.resolve(tooBusy())
    const id = randomToken(15)
    const headers: Record<string, string> = {}
    for (const name of RELAY_FORWARDED_HEADERS) {
      const value = request.headers[name]
      if (value !== undefined) headers[name] = value
    }
    return new Promise<Response>((resolve) => {
      const entry: Pending = {
        id,
        stream: request.stream,
        started: false,
        bytes: 0,
        start: resolve,
        controller: null,
        timer: null,
        done: false,
      }
      entry.timer = setTimeout(() => this.timeout(entry), this.timings.responseStartMs)
      this.pending.set(id, entry)
      signal?.addEventListener('abort', () => this.cancel(id), { once: true })
      this.sendTo(mac, {
        type: 'http-request',
        id,
        method: request.method,
        path: request.path,
        query: request.query,
        headers,
        body: request.body,
        source: request.source.slice(0, 64),
      })
    })
  }

  private responseStart(id: string, status: number, macHeaders: Readonly<Record<string, string>>): void {
    const entry = this.pending.get(id)
    if (entry === undefined || entry.started) return
    entry.started = true
    if (entry.timer !== null) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => this.finish(id), this.timings.maxStreamMs)
    const headers = responseHeaders(macHeaders)
    if (status < 200 || headers === null) {
      this.cancel(id)
      entry.start(new Response('Bad gateway', { status: 502, headers: { 'content-type': 'text/plain' } }))
      return
    }
    const body = status === 204 || status === 304 ? null : new ReadableStream<Uint8Array>({
      start: (controller) => {
        entry.controller = controller
      },
      cancel: () => this.cancel(id),
    })
    entry.start(new Response(body, { status, headers }))
    if (body === null) this.finish(id)
  }

  private responseChunk(id: string, data: string): void {
    const entry = this.pending.get(id)
    if (entry === undefined || !entry.started || entry.controller === null) return
    const bytes = encoder.encode(data)
    entry.bytes += bytes.length
    if (entry.bytes > RELAY_CAPS.maxResponseBytes) {
      entry.controller.error(new Error('response too large'))
      return this.cancel(id)
    }
    entry.controller.enqueue(bytes)
  }

  private finish(id: string): void {
    const entry = this.pending.get(id)
    if (entry === undefined) return
    this.pending.delete(id)
    if (entry.timer !== null) clearTimeout(entry.timer)
    entry.done = true
    if (!entry.started) entry.start(new Response('Bad gateway', { status: 502 }))
    else
      try {
        entry.controller?.close()
      } catch {
        // Already closed by the client.
      }
  }

  /** The client went away, or the relay gave up: tell the Mac, forget the request. */
  private cancel(id: string): void {
    const entry = this.pending.get(id)
    if (entry === undefined) return
    this.pending.delete(id)
    if (entry.timer !== null) clearTimeout(entry.timer)
    const mac = this.macSocket()
    if (mac !== null) this.sendTo(mac, { type: 'http-cancel', id })
    if (!entry.started) entry.start(new Response('Gateway timeout', { status: 504 }))
  }

  private timeout(entry: Pending): void {
    if (entry.started) return
    this.cancel(entry.id)
  }

  /** The Mac went away: every request in flight fails now. Nothing is retried. */
  private failAll(): void {
    for (const entry of [...this.pending.values()]) {
      this.pending.delete(entry.id)
      if (entry.timer !== null) clearTimeout(entry.timer)
      if (!entry.started) entry.start(new Response('Bad gateway', { status: 502 }))
      else
        try {
          entry.controller?.error(new Error('Mac disconnected'))
        } catch {
          // Already closed.
        }
    }
    for (const resolve of this.consents.values()) resolve({ state: 'offline' })
    this.consents.clear()
  }

  // ---------- Consent ----------

  /** Asks the Mac about `/authorize`: a new sign-in (a query) or a poll (`id` again, no query). */
  consent(id: string, query: string, source: string): Promise<ConsentAnswer> {
    const mac = this.macSocket()
    if (mac === null) return Promise.resolve({ state: 'offline' })
    if (this.consents.has(id)) return Promise.resolve({ state: 'no-answer' })
    if (this.consents.size >= RELAY_LIMITS.maxConcurrentRequestsPerMac) return Promise.resolve({ state: 'no-answer' })
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.consents.get(id) === finish) {
          this.consents.delete(id)
          resolve({ state: 'no-answer' })
        }
      }, this.timings.consentMs)
      const finish = (answer: ConsentAnswer) => {
        clearTimeout(timer)
        resolve(answer)
      }
      this.consents.set(id, finish)
      this.sendTo(mac, { type: 'consent-open', id, query, source: source.slice(0, 64) })
    })
  }

  // ---------- Helpers ----------

  private takeFrame(key: string): boolean {
    const now = this.now()
    if (this.bucket.key !== key) this.bucket = { tokens: RELAY_CAPS.frameBurst, at: now, key }
    const refill = ((now - this.bucket.at) / 1000) * RELAY_LIMITS.maxFramesPerSecondPerMac
    this.bucket.tokens = Math.min(RELAY_CAPS.frameBurst, this.bucket.tokens + refill)
    this.bucket.at = now
    if (this.bucket.tokens < 1) return false
    this.bucket.tokens -= 1
    return true
  }

  private readySockets(role: Role): RelaySocket[] {
    return this.options.env.sockets().filter((s) => {
      const state = s.state()
      return state?.phase === 'ready' && state.role === role && state.key !== 'replaced'
    })
  }

  /** The live Mac socket, if any; `except` leaves one out (one that is closing). */
  private macSocket(except?: RelaySocket): RelaySocket | null {
    return this.readySockets('mac').find((s) => s !== except && idOf(s) === this.options.macId) ?? null
  }

  private sendTo(socket: RelaySocket, frame: RelayToMac | RelayToPhone): void {
    try {
      socket.send(JSON.stringify(frame))
    } catch (error) {
      logFailure('send', error)
    }
  }

  private async state(): Promise<RelayStoredState | null> {
    if (this.stored === undefined) this.stored = await this.options.env.load()
    return this.stored
  }

  private async save(state: RelayStoredState): Promise<void> {
    this.stored = state
    await this.options.env.save(state)
  }
}

function idOf(socket: RelaySocket): string {
  const state = socket.state()
  return state?.phase === 'ready' ? state.id : ''
}

/**
 * The Mac may set only RELAY_RESPONSE_HEADERS, and only JSON or an event stream: a "Mac" is any
 * program that speaks the protocol, and must not be able to serve pages or files from the relay's
 * domain. Null for any other content type.
 */
export function responseHeaders(mac: Readonly<Record<string, string>>): Headers | null {
  const headers = new Headers()
  for (const name of RELAY_RESPONSE_HEADERS) {
    const value = mac[name]
    if (value !== undefined) headers.set(name, value)
  }
  const type = headers.get('content-type')
  if (type !== null) {
    const base = type.split(';')[0]?.trim().toLowerCase()
    if (base !== 'application/json' && base !== 'text/event-stream') return null
  }
  if (!headers.has('cache-control')) headers.set('cache-control', 'no-store')
  headers.set('x-content-type-options', 'nosniff')
  headers.set('content-security-policy', "sandbox; default-src 'none'; frame-ancestors 'none'")
  headers.set('referrer-policy', 'no-referrer')
  return headers
}

/** The Mac isn't connected: a tool call gets a tool error, anything else a 503. Nothing queued. */
export function offline(request: Pick<ForwardRequest, 'path' | 'method' | 'body'>): Response {
  const id = request.path === '/mcp' && request.method === 'POST' ? toolCallId(request.body) : undefined
  if (id !== undefined) {
    return Response.json(
      {
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            {
              type: 'text',
              text: "The Mac running Valet isn't connected to its relay, so nothing was sent. Ask the person to wake their Mac or check its internet, then try again.",
            },
          ],
          isError: true,
        },
      },
      { headers: { 'cache-control': 'no-store' } },
    )
  }
  return Response.json(
    { error: 'mac_offline' },
    { status: 503, headers: { 'retry-after': '30', 'cache-control': 'no-store' } },
  )
}

function tooBusy(): Response {
  return Response.json({ error: 'too_many_requests' }, { status: 429, headers: { 'retry-after': '1' } })
}

function toolCallId(body: string): string | number | undefined {
  try {
    const message = JSON.parse(body) as { method?: unknown; id?: unknown }
    if (message.method !== 'tools/call') return undefined
    return typeof message.id === 'string' || typeof message.id === 'number' ? message.id : undefined
  } catch {
    return undefined
  }
}

