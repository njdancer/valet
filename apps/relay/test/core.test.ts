// RelayCore, the Durable Object's logic, driven with fake sockets: connections and hellos, the
// phone channel's routing rules, device registration, pushes, forwarded HTTP and consent. The
// adversarial cases are here: whoever holds a socket tries to be someone else.

import type { RelayStoredState } from '@valet/core'
import { relayAuthPayload, SIGNING_DOMAINS } from '@valet/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CLOSE,
  type ForwardRequest,
  offline,
  RELAY_CAPS,
  RelayCore,
  type RelaySocket,
  recoveryCodeHash,
  responseHeaders,
  type SocketState,
} from '../src/core'
import type { PushKind, PushResult } from '../src/push'
import { type TestKey, testKey } from './keys'

const ORIGIN = 'https://relay.test'

class FakeSocket implements RelaySocket {
  readonly sent: unknown[] = []
  closedWith: { code: number; reason: string } | null = null
  private current: SocketState | null = null
  constructor(private readonly world: World) {}
  send(text: string): void {
    if (this.closedWith !== null) throw new Error('closed')
    this.sent.push(text === 'pong' ? text : JSON.parse(text))
  }
  close(code: number, reason: string): void {
    if (this.closedWith !== null) return
    this.closedWith = { code, reason }
    this.world.sockets = this.world.sockets.filter((s) => s !== this)
    this.world.core.closed(this)
  }
  state(): SocketState | null {
    return this.current
  }
  setState(state: SocketState): void {
    this.current = state
  }
  last<T = { type: string }>(): T {
    return this.sent.at(-1) as T
  }
  frames(type: string): Record<string, unknown>[] {
    return this.sent.filter((f) => (f as { type?: string }).type === type) as Record<string, unknown>[]
  }
}

class World {
  sockets: FakeSocket[] = []
  stored: RelayStoredState | null = null
  saves = 0
  erased = 0
  alarms: number[] = []
  pushes: { token: string; kind: PushKind }[] = []
  pushResult: PushResult = 'sent'
  clock = { now: Date.UTC(2026, 10, 12, 3) }
  readonly core: RelayCore
  constructor(
    readonly macId: string,
    timings: Partial<{ responseStartMs: number; maxStreamMs: number; consentMs: number }> = {},
  ) {
    this.core = new RelayCore({
      macId,
      origin: ORIGIN,
      now: () => this.clock.now,
      timings,
      env: {
        sockets: () => this.sockets,
        load: async () => this.stored,
        save: async (state) => {
          this.saves++
          this.stored = JSON.parse(JSON.stringify(state))
        },
        erase: async () => {
          this.stored = null
          this.erased++
        },
        wakeAt: (at) => {
          this.alarms.push(at)
        },
        push: async (token, kind) => {
          this.pushes.push({ token, kind })
          return this.pushResult
        },
      },
    })
  }
  open(role: 'mac' | 'phone'): FakeSocket {
    const socket = new FakeSocket(this)
    this.sockets.push(socket)
    this.core.connect(socket, role)
    return socket
  }
}

function challengeOf(socket: FakeSocket): { nonce: string; relay: string } {
  return socket.frames('challenge')[0] as { nonce: string; relay: string }
}

async function hello(
  world: World,
  socket: FakeSocket,
  key: TestKey,
  fields: {
    role: 'mac' | 'phone'
    id: string
    transportKey?: string | null
    signatureOver?: string
    /** Signs the binding instead of the approval key: a forgery. */
    bindingSigner?: TestKey
    /** The approval key that binds the transport key; a Mac's hello with a key carries this. */
    approval?: TestKey
  },
): Promise<void> {
  const { nonce } = challengeOf(socket)
  const payload =
    fields.signatureOver ?? relayAuthPayload({ nonce, relay: ORIGIN, role: fields.role, id: fields.id })
  const frame: Record<string, unknown> = {
    type: 'hello',
    role: fields.role,
    id: fields.id,
    signature: key.signDomain(SIGNING_DOMAINS.relayAuth, payload),
  }
  if (fields.transportKey !== null) {
    const transportKey = fields.transportKey ?? key.publicKey
    frame['transportKey'] = transportKey
    if (fields.role === 'mac') {
      const approval = fields.approval ?? APPROVAL
      frame['binding'] = {
        approvalKey: approval.publicKey,
        signature: (fields.bindingSigner ?? approval).signDomain(SIGNING_DOMAINS.relayBinding, transportKey),
      }
    }
  }
  await world.core.message(socket, JSON.stringify(frame))
}

async function macOnline(world: World, key: TestKey): Promise<FakeSocket> {
  const socket = world.open('mac')
  await hello(world, socket, key, { role: 'mac', id: world.macId })
  expect(socket.last()).toMatchObject({ type: 'ready' })
  return socket
}

async function send(world: World, socket: FakeSocket, frame: unknown): Promise<void> {
  await world.core.message(socket, JSON.stringify(frame))
}

async function phoneOnline(
  world: World,
  mac: FakeSocket,
  key: TestKey,
  deviceId: string,
): Promise<FakeSocket> {
  await send(world, mac, { type: 'device-register', deviceId, transportKey: key.publicKey })
  const phone = world.open('phone')
  await hello(world, phone, key, { role: 'phone', id: deviceId, transportKey: null })
  expect(phone.last()).toEqual({ type: 'ready', macOnline: true })
  return phone
}

/** The Mac's approval key: its id is the Mac's id. */
const APPROVAL = testKey()
const MAC_ID = APPROVAL.id
const PHONE_ID = 'b'.repeat(32)
const OTHER_PHONE = 'c'.repeat(32)

function envelope(from: string, to: string, ct = 'Y2lwaGVy') {
  return { v: 1, suite: 'hpke-auth-p256-sha256-aes256gcm', from, to, enc: 'E'.repeat(87), ct }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('connections', () => {
  it('challenges first, registers a new Mac by its key, and tells it its phones', async () => {
    const world = new World(MAC_ID)
    const key = testKey()
    const socket = world.open('mac')
    expect(challengeOf(socket)).toMatchObject({ type: 'challenge', v: 1, relay: ORIGIN })
    expect(world.alarms).toHaveLength(1)
    await hello(world, socket, key, { role: 'mac', id: MAC_ID })
    expect(socket.last()).toEqual({ type: 'ready', devices: [] })
    expect(world.stored).toEqual({
      macId: MAC_ID,
      macTransportKey: key.publicKey,
      devices: [],
      recoveryCodeHash: null,
      locked: false,
      lockedBy: null,
      createdAt: '2026-11-12T03:00:00.000Z',
      lastSeenAt: '2026-11-12T03:00:00.000Z',
    })
    expect(world.core.macOnline()).toBe(true)
  })

  it('refuses a hello signed over another nonce, relay, role or id', async () => {
    const key = testKey()
    for (const over of [
      relayAuthPayload({ nonce: 'x'.repeat(43), relay: ORIGIN, role: 'mac', id: MAC_ID }),
      relayAuthPayload({ nonce: '', relay: 'https://evil.test', role: 'mac', id: MAC_ID }),
      '{}',
    ]) {
      const world = new World(MAC_ID)
      const socket = world.open('mac')
      const payload = over.includes('"nonce":""')
        ? over.replace('""', `"${challengeOf(socket).nonce}"`)
        : over
      await hello(world, socket, key, { role: 'mac', id: MAC_ID, signatureOver: payload })
      expect(socket.closedWith?.code).toBe(CLOSE.authFailed)
      expect(world.stored).toBeNull()
    }
  })

  it('refuses a key not bound by the Mac’s approval key, a wrong id, a wrong role, and a first hello without a key', async () => {
    const world = new World(MAC_ID)
    const key = testKey()
    await macOnline(world, key)

    // Another approval key: its id isn't this Mac's id.
    const impostor = world.open('mac')
    await hello(world, impostor, testKey(), { role: 'mac', id: MAC_ID, approval: testKey() })
    expect(impostor.closedWith?.code).toBe(CLOSE.authFailed)
    // This Mac's approval key, but a binding someone else signed.
    const forged = world.open('mac')
    await hello(world, forged, testKey(), { role: 'mac', id: MAC_ID, bindingSigner: testKey() })
    expect(forged.closedWith?.code).toBe(CLOSE.authFailed)
    // A real binding replayed by someone without that transport key's private half.
    const replayed = world.open('mac')
    await hello(world, replayed, testKey(), { role: 'mac', id: MAC_ID, transportKey: key.publicKey })
    expect(replayed.closedWith?.code).toBe(CLOSE.authFailed)
    const noKey = world.open('mac')
    await hello(world, noKey, testKey(), { role: 'mac', id: MAC_ID, transportKey: null })
    expect(noKey.closedWith?.code).toBe(CLOSE.authFailed)
    const wrongId = world.open('mac')
    await hello(world, wrongId, key, { role: 'mac', id: 'd'.repeat(32) })
    expect(wrongId.closedWith?.code).toBe(CLOSE.authFailed)
    const wrongRole = world.open('mac')
    await hello(world, wrongRole, key, { role: 'phone', id: MAC_ID, transportKey: null })
    expect(wrongRole.closedWith?.code).toBe(CLOSE.authFailed)

    const fresh = new World(MAC_ID)
    const first = fresh.open('mac')
    await hello(fresh, first, key, { role: 'mac', id: MAC_ID, transportKey: null })
    expect(first.closedWith?.code).toBe(CLOSE.authFailed)
    expect(world.stored?.macTransportKey).toBe(key.publicKey)
  })

  it('takes a new transport key the approval key binds, and then refuses the old one', async () => {
    const world = new World(MAC_ID)
    const old = testKey()
    await macOnline(world, old)
    const rotated = testKey()
    const next = await macOnline(world, rotated)
    expect(world.stored?.macTransportKey).toBe(rotated.publicKey)
    const stale = world.open('mac')
    await hello(world, stale, old, { role: 'mac', id: MAC_ID, transportKey: null })
    expect(stale.closedWith?.code).toBe(CLOSE.authFailed)
    expect(next.closedWith).toBeNull()
  })

  it('lets a known Mac reconnect without sending its key, and replaces the older socket', async () => {
    const world = new World(MAC_ID)
    const key = testKey()
    const old = await macOnline(world, key)
    const again = world.open('mac')
    await hello(world, again, key, { role: 'mac', id: MAC_ID, transportKey: null })
    expect(again.last()).toMatchObject({ type: 'ready' })
    expect(old.closedWith?.code).toBe(CLOSE.replaced)
    expect(world.core.macOnline()).toBe(true)
  })

  it('closes sockets that never answer, and refuses a hello that comes too late', async () => {
    const world = new World(MAC_ID)
    const slow = world.open('mac')
    const late = world.open('mac')
    world.clock.now += 5000
    const fresh = world.open('phone')
    world.clock.now += 6000
    await world.core.alarm()
    expect(slow.closedWith?.code).toBe(CLOSE.challengeTimeout)
    expect(fresh.closedWith).toBeNull()
    expect(world.alarms.at(-1)).toBe(world.clock.now - 6000 + 10_000)
    const key = testKey()
    // `late` was closed by the alarm too; a new one answering after the timeout is refused as well.
    expect(late.closedWith?.code).toBe(CLOSE.challengeTimeout)
    world.clock.now += 20_000
    await hello(world, fresh, key, { role: 'phone', id: PHONE_ID, transportKey: null })
    expect(fresh.closedWith?.code).toBe(CLOSE.challengeTimeout)
  })

  it('closes on binary frames, junk, oversized frames, and a second hello', async () => {
    const world = new World(MAC_ID)
    const key = testKey()
    const mac = await macOnline(world, key)
    await world.core.message(mac, 'ping')
    expect(mac.last()).toBe('pong')
    await send(world, mac, { type: 'hello', role: 'mac', id: MAC_ID, signature: 'A'.repeat(86) })
    expect(mac.closedWith?.code).toBe(CLOSE.badFrame)

    for (const data of [
      new ArrayBuffer(4),
      'not json',
      'x'.repeat(RELAY_CAPS.maxFrameBytes + 1),
      '{"type":"nope"}',
    ]) {
      const w = new World(MAC_ID)
      const s = await macOnline(w, key)
      await w.core.message(s, data)
      expect(s.closedWith?.code).toBe(CLOSE.badFrame)
    }
    const unknown = new FakeSocket(world)
    await world.core.message(unknown, '{}')
    expect(unknown.closedWith?.code).toBe(CLOSE.badFrame)
  })

  it('closes a Mac that floods frames beyond its burst', async () => {
    const world = new World(MAC_ID)
    const mac = await macOnline(world, testKey())
    for (let i = 0; i < RELAY_CAPS.frameBurst; i++)
      await send(world, mac, { type: 'http-response-end', id: 'nope' })
    expect(mac.closedWith).toBeNull()
    await send(world, mac, { type: 'http-response-end', id: 'nope' })
    expect(mac.closedWith?.code).toBe(CLOSE.tooMany)
  })
})

describe('phones', () => {
  it('lets only a registered phone in, with the key its Mac registered', async () => {
    const world = new World(MAC_ID)
    const mac = await macOnline(world, testKey())
    const phoneKey = testKey()
    const early = world.open('phone')
    await hello(world, early, phoneKey, { role: 'phone', id: PHONE_ID, transportKey: null })
    // Refused the same way as a wrong key, so a stranger can't tell which phone ids exist.
    expect(early.closedWith?.code).toBe(CLOSE.authFailed)

    const phone = await phoneOnline(world, mac, phoneKey, PHONE_ID)
    expect(mac.last()).toEqual({ type: 'device-online', deviceId: PHONE_ID, online: true })
    expect(phone.closedWith).toBeNull()

    const selfRegistered = world.open('phone')
    await hello(world, selfRegistered, testKey(), { role: 'phone', id: OTHER_PHONE })
    expect(selfRegistered.closedWith?.code).toBe(CLOSE.authFailed)
    const wrongKey = world.open('phone')
    await hello(world, wrongKey, testKey(), { role: 'phone', id: PHONE_ID, transportKey: null })
    expect(wrongKey.closedWith?.code).toBe(CLOSE.authFailed)
  })

  it('never registers the Mac as a phone, and caps phones per Mac', async () => {
    const world = new World(MAC_ID)
    const mac = await macOnline(world, testKey())
    await send(world, mac, { type: 'device-register', deviceId: MAC_ID, transportKey: testKey().publicKey })
    expect(world.stored?.devices).toEqual([])
    for (let i = 0; i < 6; i++)
      await send(world, mac, {
        type: 'device-register',
        deviceId: String(i).repeat(32),
        transportKey: testKey().publicKey,
      })
    expect(world.stored?.devices.map((d) => d.deviceId)).toEqual(
      ['0', '1', '2', '3', '4'].map((c) => c.repeat(32)),
    )
    const before = world.saves
    await send(world, mac, {
      type: 'device-register',
      deviceId: '0'.repeat(32),
      transportKey: world.stored?.devices[0]?.transportKey,
    })
    expect(world.saves).toBe(before)
  })

  it('routes envelopes only from the Mac to its own phones and from a phone to its Mac', async () => {
    const world = new World(MAC_ID)
    const mac = await macOnline(world, testKey())
    const phone = await phoneOnline(world, mac, testKey(), PHONE_ID)

    await send(world, mac, { type: 'envelope', envelope: envelope(MAC_ID, PHONE_ID) })
    expect(phone.last()).toEqual({ type: 'envelope', envelope: envelope(MAC_ID, PHONE_ID) })
    // To a phone that isn't registered: dropped, and nobody else gets it.
    await send(world, mac, { type: 'envelope', envelope: envelope(MAC_ID, OTHER_PHONE) })
    expect(phone.frames('envelope')).toHaveLength(1)

    await send(world, phone, { type: 'envelope', envelope: envelope(PHONE_ID, MAC_ID) })
    expect(mac.last()).toEqual({ type: 'envelope', envelope: envelope(PHONE_ID, MAC_ID) })

    // A phone pretending to be another phone, or writing to anyone but its Mac, is cut off.
    await send(world, phone, { type: 'envelope', envelope: envelope(OTHER_PHONE, MAC_ID) })
    expect(phone.closedWith?.code).toBe(CLOSE.badFrame)
    expect(mac.frames('envelope')).toHaveLength(1)

    // A Mac can't send as a phone either.
    await send(world, mac, { type: 'envelope', envelope: envelope(PHONE_ID, PHONE_ID) })
    expect(mac.closedWith?.code).toBe(CLOSE.badFrame)
  })

  it('caps envelope size and rate from a phone', async () => {
    const world = new World(MAC_ID)
    const mac = await macOnline(world, testKey())
    const key = testKey()
    const phone = await phoneOnline(world, mac, key, PHONE_ID)
    await send(world, phone, { type: 'envelope', envelope: envelope(PHONE_ID, MAC_ID, 'A'.repeat(140_000)) })
    expect(phone.closedWith?.code).toBe(CLOSE.badFrame)

    const again = await phoneOnline(world, mac, key, PHONE_ID)
    for (let i = 0; i < 60; i++)
      await send(world, again, { type: 'envelope', envelope: envelope(PHONE_ID, MAC_ID) })
    expect(again.closedWith).toBeNull()
    await send(world, again, { type: 'envelope', envelope: envelope(PHONE_ID, MAC_ID) })
    expect(again.closedWith?.code).toBe(CLOSE.tooMany)
  })

  it('drops a phone at once when its Mac unregisters it or gives it a new key', async () => {
    const world = new World(MAC_ID)
    const mac = await macOnline(world, testKey())
    const phone = await phoneOnline(world, mac, testKey(), PHONE_ID)
    await send(world, mac, { type: 'device-register', deviceId: PHONE_ID, transportKey: testKey().publicKey })
    expect(phone.closedWith?.code).toBe(CLOSE.unregistered)

    const key = testKey()
    const next = await phoneOnline(world, mac, key, PHONE_ID)
    await send(world, mac, { type: 'device-unregister', deviceId: PHONE_ID })
    expect(next.closedWith?.code).toBe(CLOSE.unregistered)
    expect(world.stored?.devices).toEqual([])
    expect(mac.last()).toEqual({ type: 'device-online', deviceId: PHONE_ID, online: false })
    await send(world, mac, { type: 'device-unregister', deviceId: PHONE_ID })
  })

  it('tells phones when the Mac comes and goes, and the Mac which phones are online', async () => {
    const world = new World(MAC_ID)
    const key = testKey()
    const mac = await macOnline(world, key)
    const phoneKey = testKey()
    const phone = await phoneOnline(world, mac, phoneKey, PHONE_ID)
    mac.close(1001, 'gone')
    expect(phone.last()).toEqual({ type: 'mac-online', online: false })
    const back = world.open('mac')
    await hello(world, back, key, { role: 'mac', id: MAC_ID, transportKey: null })
    expect(back.frames('ready')[0]).toEqual({ type: 'ready', devices: [PHONE_ID] })
    expect(back.last()).toEqual({ type: 'device-online', deviceId: PHONE_ID, online: true })
    expect(phone.last()).toEqual({ type: 'mac-online', online: true })

    // A phone's second connection replaces its first, without telling the Mac it went offline.
    const second = world.open('phone')
    await hello(world, second, phoneKey, { role: 'phone', id: PHONE_ID, transportKey: null })
    expect(phone.closedWith?.code).toBe(CLOSE.replaced)
    expect(back.frames('device-online').filter((f) => f['online'] === false)).toHaveLength(0)
  })

  it('stores a push token, pushes fixed kinds within limits, and forgets a token Apple calls gone', async () => {
    const world = new World(MAC_ID)
    const mac = await macOnline(world, testKey())
    const phone = await phoneOnline(world, mac, testKey(), PHONE_ID)
    await send(world, mac, { type: 'push', deviceId: PHONE_ID, kind: 'needs-you' })
    expect(world.pushes).toEqual([])
    const token = 'ab'.repeat(32)
    await send(world, phone, { type: 'push-token', token })
    await send(world, phone, { type: 'push-token', token })
    expect(world.stored?.devices[0]?.pushToken).toBe(token)
    await send(world, mac, { type: 'push', deviceId: PHONE_ID, kind: 'needs-you' })
    await send(world, mac, { type: 'push', deviceId: PHONE_ID, kind: 'alert' })
    expect(world.pushes).toEqual([{ token, kind: 'needs-you' }])
    world.clock.now += 10_000
    world.pushResult = 'gone'
    await send(world, mac, { type: 'push', deviceId: PHONE_ID, kind: 'alert' })
    expect(world.stored?.devices[0]?.pushToken).toBeNull()
  })
})

describe('forwarded HTTP', () => {
  const request: ForwardRequest = {
    method: 'POST',
    path: '/mcp',
    query: '',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer t',
      origin: 'https://evil.test',
    } as Record<string, string>,
    body: '{"jsonrpc":"2.0","id":1,"method":"ping"}',
    source: '203.0.113.9',
    stream: false,
  }

  it('sends one frame with only the allowed headers and streams the answer back', async () => {
    const world = new World(MAC_ID)
    const mac = await macOnline(world, testKey())
    const pending = world.core.forward(request)
    const frame = mac.last<{ id: string; headers: Record<string, string>; source: string; type: string }>()
    expect(frame.type).toBe('http-request')
    expect(frame.headers).toEqual({ 'content-type': 'application/json', authorization: 'Bearer t' })
    expect(frame.source).toBe('203.0.113.9')
    await send(world, mac, {
      type: 'http-response-start',
      id: frame.id,
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'mcp-session-id': 's1' },
    })
    const response = await pending
    expect(response.status).toBe(200)
    expect(response.headers.get('mcp-session-id')).toBe('s1')
    expect(response.headers.get('content-security-policy')).toContain('sandbox')
    await send(world, mac, { type: 'http-response-chunk', id: frame.id, data: 'data: é\n\n' })
    await send(world, mac, { type: 'http-response-end', id: frame.id })
    expect(await response.text()).toBe('data: é\n\n')
    // Frames for a request that ended are ignored.
    await send(world, mac, { type: 'http-response-chunk', id: frame.id, data: 'late' })
  })

  it('refuses HTML and other content from a Mac, and a 1xx status', async () => {
    const world = new World(MAC_ID)
    const mac = await macOnline(world, testKey())
    for (const [status, type] of [
      [200, 'text/html'],
      [200, 'application/octet-stream'],
      [101, 'application/json'],
    ] as const) {
      const pending = world.core.forward(request)
      const { id } = mac.last<{ id: string }>()
      await send(world, mac, { type: 'http-response-start', id, status, headers: { 'content-type': type } })
      expect((await pending).status).toBe(502)
      expect(mac.last()).toEqual({ type: 'http-cancel', id })
    }
    expect(responseHeaders({ 'content-type': 'application/json; charset=utf-8' })?.get('cache-control')).toBe(
      'no-store',
    )
  })

  it('caps a response, ends a stream after its lifetime, and times out a Mac that never answers', async () => {
    vi.useFakeTimers()
    const world = new World(MAC_ID, { responseStartMs: 1000, maxStreamMs: 5000 })
    const mac = await macOnline(world, testKey())

    const silent = world.core.forward(request)
    const silentId = mac.last<{ id: string }>().id
    vi.advanceTimersByTime(1000)
    expect((await silent).status).toBe(504)
    expect(mac.last()).toEqual({ type: 'http-cancel', id: silentId })

    const big = world.core.forward(request)
    const bigId = mac.last<{ id: string }>().id
    await send(world, mac, { type: 'http-response-start', id: bigId, status: 200, headers: {} })
    const bigResponse = await big
    const reading = bigResponse.text().catch((e: Error) => e.message)
    const chunk = 'x'.repeat(256 * 1024)
    for (let i = 0; i < 33; i++)
      await send(world, mac, { type: 'http-response-chunk', id: bigId, data: chunk })
    expect(await reading).toBe('response too large')

    const stream = world.core.forward({ ...request, method: 'GET', stream: true, body: '' })
    const streamId = mac.last<{ id: string }>().id
    await send(world, mac, {
      type: 'http-response-start',
      id: streamId,
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
    const streamResponse = await stream
    vi.advanceTimersByTime(5000)
    expect(await streamResponse.text()).toBe('')
  })

  it('answers 204 without a body', async () => {
    const world = new World(MAC_ID)
    const mac = await macOnline(world, testKey())
    const pending = world.core.forward(request)
    await send(world, mac, {
      type: 'http-response-start',
      id: mac.last<{ id: string }>().id,
      status: 204,
      headers: {},
    })
    const response = await pending
    expect(response.status).toBe(204)
    expect(response.body).toBeNull()
  })

  it('tells the Mac when the client goes away, and fails everything in flight when the Mac does', async () => {
    const world = new World(MAC_ID)
    const mac = await macOnline(world, testKey())
    const abort = new AbortController()
    const cancelled = world.core.forward(request, abort.signal)
    const id = mac.last<{ id: string }>().id
    abort.abort()
    expect(mac.last()).toEqual({ type: 'http-cancel', id })
    expect((await cancelled).status).toBe(504)

    const before = world.core.forward(request)
    const streaming = world.core.forward(request)
    const streamingId = mac.last<{ id: string }>().id
    await send(world, mac, { type: 'http-response-start', id: streamingId, status: 200, headers: {} })
    const started = await streaming
    const consent = world.core.consent('c1', 'q', '')
    mac.close(1006, 'gone')
    expect((await before).status).toBe(502)
    await expect(started.text()).rejects.toThrow()
    expect(await consent).toEqual({ state: 'offline' })
  })

  it('limits concurrent requests and open streams per Mac', async () => {
    const world = new World(MAC_ID)
    await macOnline(world, testKey())
    const streams = Array.from({ length: 4 }, () =>
      world.core.forward({ ...request, method: 'GET', stream: true }),
    )
    expect((await world.core.forward({ ...request, method: 'GET', stream: true })).status).toBe(429)
    const rest = Array.from({ length: 12 }, () => world.core.forward(request))
    expect((await world.core.forward(request)).status).toBe(429)
    expect(streams.length + rest.length).toBe(16)
  })

  it('answers for an offline Mac at once and queues nothing', async () => {
    const world = new World(MAC_ID)
    const call = await world.core.forward({
      ...request,
      body: '{"jsonrpc":"2.0","id":"x","method":"tools/call"}',
    })
    expect(((await call.json()) as { id: string; result: { isError: boolean } }).result.isError).toBe(true)
    expect((await world.core.forward(request)).status).toBe(503)
    expect(offline({ path: '/mcp', method: 'POST', body: 'nope' }).status).toBe(503)
    expect(offline({ path: '/mcp', method: 'POST', body: '{"method":"tools/call","id":{}}' }).status).toBe(
      503,
    )
  })
})

describe('consent', () => {
  it('passes the Mac’s structured answer back, one per id, and gives up on a Mac that doesn’t answer', async () => {
    vi.useFakeTimers()
    const world = new World(MAC_ID, { consentMs: 1000 })
    const mac = await macOnline(world, testKey())
    const answer = world.core.consent('id-1', 'client_id=x', '198.51.100.1')
    expect(mac.last()).toEqual({
      type: 'consent-open',
      id: 'id-1',
      query: 'client_id=x',
      source: '198.51.100.1',
    })
    expect(await world.core.consent('id-1', '', '')).toEqual({ state: 'busy' })
    await send(world, mac, { type: 'consent-view', id: 'id-1', state: 'waiting', code: 'ABCD-EFGH' })
    expect(await answer).toEqual({ state: 'waiting', code: 'ABCD-EFGH' })

    const views = [
      [{ state: 'waiting' }, { state: 'no-answer' }],
      [{ state: 'expired' }, { state: 'expired' }],
      [{ state: 'declined' }, { state: 'declined' }],
      [
        { state: 'approved', redirect: 'https://c.test/cb?code=1' },
        { state: 'approved', redirect: 'https://c.test/cb?code=1' },
      ],
    ] as const
    for (const [view, expected] of views) {
      const pending = world.core.consent('id-2', '', '')
      await send(world, mac, { type: 'consent-view', id: 'id-2', ...view })
      expect(await pending).toEqual(expected)
    }
    await send(world, mac, { type: 'consent-view', id: 'unknown', state: 'expired' })

    const slow = world.core.consent('id-3', '', '')
    vi.advanceTimersByTime(1000)
    expect(await slow).toEqual({ state: 'no-answer' })
    expect(await new World(MAC_ID).core.consent('id', 'q', '')).toEqual({ state: 'offline' })
  })
})

describe('pairing', () => {
  const OFFER = 'e'.repeat(32)
  const sealed = { iv: 'I'.repeat(16), ct: 'c2VhbGVk' }
  const reply = (offerId = OFFER, macId = MAC_ID) => ({ type: 'pairing-reply', macId, offerId, sealed })
  const inSixMinutes = (world: World) => new Date(world.clock.now + 6 * 60_000).toISOString()

  it('passes one sealed reply per open offer to the Mac, and the Mac’s answers back to that phone only', async () => {
    const world = new World(MAC_ID)
    const mac = await macOnline(world, testKey())
    // No offer yet: refused.
    const early = world.open('phone')
    await send(world, early, reply())
    expect(early.closedWith?.code).toBe(CLOSE.authFailed)

    await send(world, mac, { type: 'pairing-open', offerId: OFFER, expiresAt: inSixMinutes(world) })
    const phone = world.open('phone')
    await send(world, phone, reply())
    expect(phone.closedWith).toBeNull()
    expect(mac.last()).toEqual({ type: 'pairing-reply', offerId: OFFER, sealed })
    // A second phone answering the same offer is refused: one reply per offer.
    const second = world.open('phone')
    await send(world, second, reply())
    expect(second.closedWith?.code).toBe(CLOSE.authFailed)
    expect(mac.frames('pairing-reply')).toHaveLength(1)
    // The waiting phone may not say anything else.
    const chatty = world.open('phone')
    await send(world, mac, { type: 'pairing-open', offerId: 'f'.repeat(32), expiresAt: inSixMinutes(world) })
    await send(world, chatty, reply('f'.repeat(32)))
    await send(world, chatty, { type: 'relay-lock' })
    expect(chatty.closedWith?.code).toBe(CLOSE.badFrame)

    const macNonce = 'N'.repeat(43)
    const signature = 'S'.repeat(86)
    await send(world, mac, { type: 'pairing-challenge', offerId: OFFER, macNonce, signature })
    expect(phone.last()).toEqual({ type: 'pairing-challenge', offerId: OFFER, macNonce, signature })
    await send(world, mac, { type: 'pairing-result', offerId: OFFER, sealed })
    expect(phone.frames('pairing-result')).toEqual([{ type: 'pairing-result', offerId: OFFER, sealed }])
    expect(phone.closedWith?.code).toBe(1000)
    // Pairing registers nothing at the relay: that's the Mac's device-register.
    expect(world.stored?.devices).toEqual([])
  })

  it('refuses replies to another Mac, an expired offer, a reopened offer and an offline Mac, and ignores junk', async () => {
    const world = new World(MAC_ID)
    const mac = await macOnline(world, testKey())
    await send(world, mac, { type: 'pairing-open', offerId: OFFER, expiresAt: inSixMinutes(world) })
    const other = world.open('phone')
    await send(world, other, reply(OFFER, 'd'.repeat(32)))
    expect(other.closedWith?.code).toBe(CLOSE.authFailed)
    // An offer can't outlive the relay's cap, whatever expiry the Mac asks for.
    await send(world, mac, {
      type: 'pairing-open',
      offerId: 'f'.repeat(32),
      expiresAt: '2099-01-01T00:00:00.000Z',
    })
    world.clock.now += RELAY_CAPS.maxOfferMs + 1
    const late = world.open('phone')
    await send(world, late, reply('f'.repeat(32)))
    expect(late.closedWith?.code).toBe(CLOSE.authFailed)

    // Strangers' junk replies don't use up the Mac's budget: the real phone still gets through.
    const fresh = '1'.repeat(32)
    await send(world, mac, { type: 'pairing-open', offerId: fresh, expiresAt: inSixMinutes(world) })
    for (let i = 0; i < RELAY_CAPS.pairingRepliesPerMinute + 2; i++) {
      const s = world.open('phone')
      await send(world, s, reply('0'.repeat(32)))
      expect(s.closedWith?.code).toBe(CLOSE.authFailed)
    }
    const real = world.open('phone')
    await send(world, real, reply(fresh))
    expect(real.closedWith).toBeNull()
    expect(mac.frames('pairing-reply')).toHaveLength(1)
    // Opening the same offer again doesn't reopen it.
    await send(world, mac, { type: 'pairing-open', offerId: fresh, expiresAt: inSixMinutes(world) })
    const again = world.open('phone')
    await send(world, again, reply(fresh))
    expect(again.closedWith?.code).toBe(CLOSE.authFailed)

    mac.close(1001, 'gone')
    const nobody = world.open('phone')
    await send(world, nobody, reply())
    expect(nobody.closedWith?.code).toBe(CLOSE.authFailed)
  })

  it('times out a phone left waiting past its offer', async () => {
    const world = new World(MAC_ID)
    const mac = await macOnline(world, testKey())
    await send(world, mac, { type: 'pairing-open', offerId: OFFER, expiresAt: inSixMinutes(world) })
    const phone = world.open('phone')
    await send(world, phone, reply())
    world.clock.now += 6 * 60_000
    await world.core.alarm()
    expect(phone.closedWith?.code).toBe(CLOSE.challengeTimeout)
  })
})

describe('lock and recovery', () => {
  const request: ForwardRequest = {
    method: 'POST',
    path: '/mcp',
    query: '',
    headers: {},
    body: '{"jsonrpc":"2.0","id":1,"method":"tools/call"}',
    source: '203.0.113.9',
    stream: false,
  }

  it('locks on a phone’s word, refuses everything while locked, and only the Mac unlocks', async () => {
    const world = new World(MAC_ID)
    const macKey = testKey()
    const mac = await macOnline(world, macKey)
    const phone = await phoneOnline(world, mac, testKey(), PHONE_ID)
    const inFlight = world.core.forward(request)
    await send(world, phone, { type: 'relay-lock' })
    expect(world.stored?.locked).toBe(true)
    expect((await inFlight).status).toBe(502)
    expect(mac.last()).toEqual({ type: 'relay-locked', locked: true, by: 'phone', phonesUnregistered: false })
    expect(phone.last()).toEqual({ type: 'relay-locked', locked: true, by: 'phone' })

    const call = await world.core.forward(request)
    expect(call.status).toBe(200)
    expect(JSON.stringify(await call.json())).toContain('locked it down')
    expect((await world.core.forward({ ...request, body: '{}' })).status).toBe(503)
    expect(await world.core.consent('c', 'q', '')).toEqual({ state: 'locked' })

    // The Mac reconnecting is told at once.
    const back = world.open('mac')
    await hello(world, back, macKey, { role: 'mac', id: MAC_ID, transportKey: null })
    expect(back.frames('relay-locked')).toEqual([
      { type: 'relay-locked', locked: true, by: 'phone', phonesUnregistered: false },
    ])
    expect(world.stored?.lockedBy).toBe('phone')

    await send(world, back, { type: 'relay-unlock' })
    expect(world.stored?.locked).toBe(false)
    expect(phone.last()).toEqual({ type: 'relay-locked', locked: false, by: 'mac' })
    const pending = world.core.forward(request)
    expect(back.last()).toMatchObject({ type: 'http-request' })
    await send(world, back, {
      type: 'http-response-start',
      id: back.last<{ id: string }>().id,
      status: 204,
      headers: {},
    })
    expect((await pending).status).toBe(204)
  })

  it('locks with the recovery code, optionally unregistering every phone, within limits', async () => {
    const world = new World(MAC_ID)
    const mac = await macOnline(world, testKey())
    const phone = await phoneOnline(world, mac, testKey(), PHONE_ID)
    expect(await world.core.recover('ABCD-EFGH-JKLM-NPQR', false)).toBe('unset')
    const code = 'abcd efgh-jkmn pqrs'
    const codeHash = (await recoveryCodeHash(code)) as string
    expect(codeHash).toMatch(/^[0-9a-f]{64}$/)
    expect(await recoveryCodeHash('ABCDEFGHJKMNPQRS')).toBe(codeHash)
    expect(await recoveryCodeHash('short')).toBeNull()
    await send(world, mac, { type: 'recovery-register', codeHash })
    expect(world.stored?.recoveryCodeHash).toBe(codeHash)

    expect(await world.core.recover('ABCD-EFGH-JKMN-PQRT', true)).toBe('wrong')
    expect(world.stored?.locked).toBe(false)
    expect(await world.core.recover(code, true)).toBe('done')
    expect(world.stored?.locked).toBe(true)
    expect(world.stored?.lockedBy).toBe('recovery')
    expect(world.stored?.devices).toEqual([])
    expect(phone.closedWith?.code).toBe(CLOSE.unregistered)
    expect(mac.last()).toEqual({
      type: 'relay-locked',
      locked: true,
      by: 'recovery',
      phonesUnregistered: true,
    })

    for (let i = 1; i < RELAY_CAPS.recoveryPerHour; i++)
      await world.core.recover('nope-nope-nope-nope', false)
    expect(await world.core.recover('nope-nope-nope-nope', false)).toBe('too-many')
  })

  it('forgets a Mac that hasn’t connected in 180 days, and not one that has', async () => {
    const world = new World(MAC_ID)
    const mac = await macOnline(world, testKey())
    expect(world.alarms.at(-1)).toBe(world.clock.now + RELAY_CAPS.forgetAfterMs)
    world.clock.now += RELAY_CAPS.forgetAfterMs
    await world.core.alarm()
    expect(world.erased).toBe(0)
    mac.close(1001, 'gone')
    await world.core.alarm()
    expect(world.erased).toBe(1)
    expect(world.stored).toBeNull()
  })
})

describe('consent states', () => {
  it('passes closed, busy and too-many through from the Mac', async () => {
    const world = new World(MAC_ID)
    const mac = await macOnline(world, testKey())
    for (const state of ['closed', 'busy', 'too-many'] as const) {
      const pending = world.core.consent('id', '', '')
      await send(world, mac, { type: 'consent-view', id: 'id', state })
      expect(await pending).toEqual({ state })
    }
  })
})

describe('red-team regressions', () => {
  it('refuses a phone revoked while its hello was being verified', async () => {
    for (const change of ['unregister', 'new key'] as const) {
      const world = new World(MAC_ID)
      const mac = await macOnline(world, testKey())
      const phoneKey = testKey()
      await send(world, mac, {
        type: 'device-register',
        deviceId: PHONE_ID,
        transportKey: phoneKey.publicKey,
      })
      const phone = world.open('phone')
      const pending = hello(world, phone, phoneKey, { role: 'phone', id: PHONE_ID, transportKey: null })
      await send(
        world,
        mac,
        change === 'unregister'
          ? { type: 'device-unregister', deviceId: PHONE_ID }
          : { type: 'device-register', deviceId: PHONE_ID, transportKey: testKey().publicKey },
      )
      await pending
      expect(phone.closedWith?.code).toBe(CLOSE.authFailed)
      await send(world, phone, { type: 'relay-lock' })
      expect(world.stored?.locked).toBe(false)
    }
  })

  it('labels an untyped answer JSON, so a "Mac" can’t serve a page', async () => {
    const world = new World(MAC_ID)
    const mac = await macOnline(world, testKey())
    const pending = world.core.forward({
      method: 'GET',
      path: '/.well-known/oauth-authorization-server',
      query: '',
      headers: {},
      body: '',
      source: '203.0.113.9',
      stream: false,
    })
    const { id } = mac.last<{ id: string }>()
    await send(world, mac, { type: 'http-response-start', id, status: 200, headers: {} })
    const response = await pending
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('lets the right recovery code through however many wrong ones came first', async () => {
    const world = new World(MAC_ID)
    const mac = await macOnline(world, testKey())
    const code = 'ABCD-EFGH-JKMN-PQRS'
    await send(world, mac, { type: 'recovery-register', codeHash: (await recoveryCodeHash(code)) as string })
    for (let i = 0; i < RELAY_CAPS.recoveryPerHour + 3; i++) await world.core.recover('x', false)
    expect(await world.core.recover('x', false)).toBe('too-many')
    expect(await world.core.recover(code, false)).toBe('done')
    expect(world.stored?.locked).toBe(true)
  })

  it('holds a phone’s other frames to its budget', async () => {
    const world = new World(MAC_ID)
    const mac = await macOnline(world, testKey())
    const phone = await phoneOnline(world, mac, testKey(), PHONE_ID)
    for (let i = 0; i < 60; i++)
      await send(world, phone, { type: 'push-token', token: (i % 2 ? 'ab' : 'cd').repeat(32) })
    expect(phone.closedWith).toBeNull()
    await send(world, phone, { type: 'relay-lock' })
    expect(phone.closedWith?.code).toBe(CLOSE.tooMany)
    expect(world.stored?.locked).toBe(false)
  })
})
