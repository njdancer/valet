// The Mac's relay client against a scripted relay (a fake WebSocket) and a real loopback listener:
// the challenge, forwarding as a byte pipe, streaming, cancelling, consent, and reconnecting.
// The whole path through a real Workers runtime is in apps/relay/test/end-to-end.test.ts.

import { generateKeyPairSync, sign } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { keyId, relayAuthPayload, SIGNING_DOMAINS, verifyP256 } from '@valet/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteClients } from '../src/oauth-clients'
import { ConsentRequests } from '../src/oauth-consent'
import { RemoteAuthorization } from '../src/oauth-server'
import {
  RelayClient,
  type RelayClientOptions,
  type RelayClientStatus,
  type RelayEvent,
} from '../src/relay-client'
import { RemoteAccessTokens } from '../src/remote-auth'

const RELAY = 'https://relay.test'
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const SPKI = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64url')
const MAC_ID = keyId(SPKI)
const signer = {
  publicKey: SPKI,
  sign: async (payload: string) =>
    sign('sha256', Buffer.from(`${SIGNING_DOMAINS.relayAuth}\n${payload}`), {
      key: privateKey,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url'),
}
// The Mac id is the approval key's id; here the one key plays both parts.
const binding = {
  approvalKey: SPKI,
  signature: sign('sha256', Buffer.from(`${SIGNING_DOMAINS.relayBinding}\n${SPKI}`), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url'),
}

class FakeSocket extends EventTarget {
  static last: FakeSocket | null = null
  static all: FakeSocket[] = []
  readonly OPEN = 1
  readyState = 1
  readonly sent: string[] = []
  closed: { code?: number; reason?: string } | null = null
  constructor(readonly url: string) {
    super()
    FakeSocket.last = this
    FakeSocket.all.push(this)
  }
  send(data: string) {
    this.sent.push(data)
  }
  close(code?: number, reason?: string) {
    this.closed = { code, reason }
    this.readyState = 3
  }
  /** The relay says something. */
  deliver(frame: unknown) {
    this.dispatchEvent(
      Object.assign(new Event('message'), {
        data: typeof frame === 'string' ? frame : JSON.stringify(frame),
      }),
    )
  }
  /** The relay hangs up. */
  hangUp(code: number) {
    this.readyState = 3
    this.dispatchEvent(Object.assign(new Event('close'), { code }))
  }
  frames(): Record<string, unknown>[] {
    return this.sent.filter((s) => s !== 'ping').map((s) => JSON.parse(s))
  }
}

const cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
  FakeSocket.all = []
  vi.useRealTimers()
})

function client(options: Partial<RelayClientOptions> = {}) {
  const statuses: RelayClientStatus[] = []
  const events: RelayEvent[] = []
  const relay = new RelayClient({
    relay: RELAY,
    macId: MAC_ID,
    signer,
    binding,
    listener: () => null,
    consent: () => ({ state: 'expired' }),
    WebSocket: FakeSocket as unknown as typeof WebSocket,
    onStatus: (s) => statuses.push(s),
    onEvent: (e) => events.push(e),
    backoff: { minMs: 100, maxMs: 1000 },
    random: () => 1,
    ...options,
  })
  cleanup.push(() => relay.stop())
  return { relay, statuses, events }
}

async function online(socket: FakeSocket, devices: string[] = []): Promise<void> {
  socket.deliver({ type: 'challenge', v: 1, nonce: 'n'.repeat(43), relay: RELAY })
  await vi.waitFor(() => expect(socket.frames()).toHaveLength(1))
  socket.deliver({ type: 'ready', devices })
}

async function listener(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server: Server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise((resolve) => server.close(resolve)))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

const request = (id: string, extra: Record<string, unknown> = {}) => ({
  type: 'http-request',
  id,
  method: 'POST',
  path: '/mcp',
  query: 'a=1',
  headers: { 'content-type': 'application/json', authorization: 'Bearer t' },
  body: '{"jsonrpc":"2.0","id":1,"method":"ping"}',
  source: '203.0.113.4',
  ...extra,
})

describe('connecting', () => {
  it('answers the challenge with the transport key over this relay, this Mac and its nonce', async () => {
    const { relay, statuses, events } = client()
    relay.start()
    relay.start()
    const socket = FakeSocket.last as FakeSocket
    expect(socket.url).toBe(`wss://relay.test/v1/mac/${MAC_ID}`)
    expect(relay.publicHost).toBe(`${MAC_ID}.relay.test`)
    await online(socket, ['b'.repeat(32)])
    const hello = socket.frames()[0] as { signature: string; transportKey: string; id: string; role: string }
    expect(hello).toMatchObject({ type: 'hello', role: 'mac', id: MAC_ID, transportKey: SPKI })
    const payload = relayAuthPayload({ nonce: 'n'.repeat(43), relay: RELAY, role: 'mac', id: MAC_ID })
    expect(verifyP256(SPKI, SIGNING_DOMAINS.relayAuth, payload, hello.signature)).toBe(true)
    expect(statuses.map((s) => s.state)).toEqual(['connecting', 'online'])
    expect(relay.status).toEqual({ state: 'online', devices: ['b'.repeat(32)] })
    expect(events).toEqual([{ type: 'ready', devices: ['b'.repeat(32)] }])
    socket.deliver({ type: 'device-online', deviceId: 'b'.repeat(32), online: false })
    expect(events).toHaveLength(2)
    socket.deliver('pong')
  })

  it('refuses a challenge naming another relay, junk, and binary frames', async () => {
    for (const frame of [
      { type: 'challenge', v: 1, nonce: 'n'.repeat(43), relay: 'https://evil.test' },
      'not json',
      { type: 'nope' },
    ]) {
      const { relay } = client()
      relay.start()
      const socket = FakeSocket.last as FakeSocket
      socket.deliver(frame)
      expect(socket.closed).not.toBeNull()
      expect(socket.frames()).toEqual([])
      relay.stop()
    }
    const { relay } = client()
    relay.start()
    const socket = FakeSocket.last as FakeSocket
    socket.dispatchEvent(Object.assign(new Event('message'), { data: new ArrayBuffer(1) }))
    expect(socket.closed?.code).toBe(1003)
  })

  it('closes when the key can’t sign', async () => {
    const { relay } = client({
      signer: { publicKey: SPKI, sign: async () => Promise.reject(new Error('locked')) },
    })
    relay.start()
    const socket = FakeSocket.last as FakeSocket
    socket.deliver({ type: 'challenge', v: 1, nonce: 'n'.repeat(43), relay: RELAY })
    await vi.waitFor(() => expect(socket.closed?.code).toBe(1011))
  })

  it('reconnects with backoff, slowly after a refusal, and not at all once replaced', async () => {
    vi.useFakeTimers()
    const { relay, statuses } = client()
    relay.start()
    ;(FakeSocket.last as FakeSocket).hangUp(1006)
    expect(relay.status).toEqual({ state: 'offline', retryInMs: 100 })
    vi.advanceTimersByTime(100)
    expect(FakeSocket.all).toHaveLength(2)
    ;(FakeSocket.last as FakeSocket).hangUp(1006)
    expect(relay.status).toEqual({ state: 'offline', retryInMs: 200 })
    vi.advanceTimersByTime(200)
    ;(FakeSocket.last as FakeSocket).hangUp(4401)
    expect(relay.status).toEqual({ state: 'refused', retryInMs: 1000 })
    vi.advanceTimersByTime(1000)
    ;(FakeSocket.last as FakeSocket).hangUp(4409)
    expect(relay.status).toEqual({ state: 'replaced' })
    vi.advanceTimersByTime(10_000)
    expect(FakeSocket.all).toHaveLength(4)
    expect(statuses.at(-1)).toEqual({ state: 'replaced' })
  })

  it('pings while online, sends frames only while online, and stops cleanly', async () => {
    vi.useFakeTimers()
    const { relay } = client({ pingMs: 1000 })
    expect(relay.send({ type: 'push', deviceId: 'b'.repeat(32), kind: 'alert' })).toBe(false)
    relay.start()
    const socket = FakeSocket.last as FakeSocket
    socket.deliver({ type: 'challenge', v: 1, nonce: 'n'.repeat(43), relay: RELAY })
    await vi.waitFor(() => expect(socket.frames()).toHaveLength(1))
    socket.deliver({ type: 'ready', devices: [] })
    vi.advanceTimersByTime(1000)
    expect(socket.sent.at(-1)).toBe('ping')
    expect(relay.send({ type: 'push', deviceId: 'b'.repeat(32), kind: 'alert' })).toBe(true)
    relay.stop()
    expect(socket.closed?.code).toBe(1000)
    expect(relay.status).toEqual({ state: 'stopped' })
    socket.hangUp(1000)
    expect(FakeSocket.all).toHaveLength(1)
  })

  it('treats a socket that can’t be made as a dropped connection', () => {
    const Throwing = (() => {
      throw new Error('no network')
    }) as unknown as typeof WebSocket
    const { relay } = client({ WebSocket: Throwing })
    relay.start()
    expect(relay.status.state).toBe('offline')
  })
})

describe('forwarding', () => {
  it('sends each request to the listener as the tunnel did, and streams the answer back in order', async () => {
    const seen: { host?: string; source?: string; url?: string; body: string; method?: string }[] = []
    const url = await listener((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        seen.push({
          host: req.headers.host,
          source: req.headers['cf-connecting-ip'] as string,
          url: req.url,
          body,
          method: req.method,
        })
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'mcp-session-id': 's1',
          'set-cookie': 'a=b',
          server: 'x',
        })
        // A multi-byte character split across writes must arrive whole.
        const euro = Buffer.from('€')
        res.write(Buffer.concat([Buffer.from('data: '), euro.subarray(0, 1)]))
        setTimeout(() => {
          res.write(Buffer.concat([euro.subarray(1), Buffer.from(`${'x'.repeat(70_000)}\n\n`)]))
          res.end()
        }, 5)
      })
    })
    const { relay } = client({ listener: () => url, coalesceMs: 1 })
    relay.start()
    const socket = FakeSocket.last as FakeSocket
    await online(socket)
    socket.deliver(request('r1'))
    await vi.waitFor(() => expect(socket.frames().at(-1)).toEqual({ type: 'http-response-end', id: 'r1' }))
    expect(seen).toEqual([
      {
        host: `${MAC_ID}.relay.test`,
        source: '203.0.113.4',
        url: '/mcp?a=1',
        body: request('r1').body,
        method: 'POST',
      },
    ])
    const frames = socket.frames().slice(1)
    expect(frames[0]).toEqual({
      type: 'http-response-start',
      id: 'r1',
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'mcp-session-id': 's1' },
    })
    const chunks = frames.filter((f) => f['type'] === 'http-response-chunk').map((f) => f['data'] as string)
    expect(chunks.every((c) => c.length <= 64 * 1024)).toBe(true)
    expect(chunks.join('')).toBe(`data: €${'x'.repeat(70_000)}\n\n`)
  })

  it('stops a request the relay cancels', async () => {
    let closed = false
    const url = await listener((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: 1\n\n')
      req.on('close', () => {
        closed = true
      })
    })
    const { relay } = client({ listener: () => url, coalesceMs: 1 })
    relay.start()
    const socket = FakeSocket.last as FakeSocket
    await online(socket)
    socket.deliver(request('r2', { method: 'GET', body: '', query: '' }))
    await vi.waitFor(() =>
      expect(socket.frames().some((f) => f['type'] === 'http-response-chunk')).toBe(true),
    )
    socket.deliver({ type: 'http-cancel', id: 'r2' })
    await vi.waitFor(() => expect(closed).toBe(true))
    expect(socket.frames().some((f) => f['type'] === 'http-response-end')).toBe(false)
  })

  it('answers 503 while remote access is paused, and 502 when the listener is gone', async () => {
    let live: string | null = null
    const { relay } = client({ listener: () => live })
    relay.start()
    const socket = FakeSocket.last as FakeSocket
    await online(socket)
    socket.deliver(request('p1'))
    expect(socket.frames().slice(-2)).toEqual([
      { type: 'http-response-start', id: 'p1', status: 503, headers: { 'retry-after': '60' } },
      { type: 'http-response-end', id: 'p1' },
    ])
    live = 'http://127.0.0.1:1'
    socket.deliver(request('p2'))
    await vi.waitFor(() =>
      expect(socket.frames().slice(-2)).toEqual([
        { type: 'http-response-start', id: 'p2', status: 502, headers: {} },
        { type: 'http-response-end', id: 'p2' },
      ]),
    )
  })

  it('ends what is in flight when the connection drops', async () => {
    let closed = false
    const url = await listener((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: 1\n\n')
      req.on('close', () => {
        closed = true
      })
    })
    const { relay } = client({ listener: () => url, coalesceMs: 1 })
    relay.start()
    const socket = FakeSocket.last as FakeSocket
    await online(socket)
    socket.deliver(request('d1', { method: 'GET', body: '' }))
    await vi.waitFor(() =>
      expect(socket.frames().some((f) => f['type'] === 'http-response-chunk')).toBe(true),
    )
    socket.hangUp(1006)
    await vi.waitFor(() => expect(closed).toBe(true))
  })
})

describe('consent', () => {
  it('answers consent-open with the OAuth server’s structured view, and declines if it throws', async () => {
    const asked: unknown[] = []
    const { relay } = client({
      consent: (id, query, source) => {
        asked.push({ id, query, source })
        if (query === 'boom') throw new Error('x')
        return { state: 'waiting', code: 'ABCD-1234' }
      },
    })
    relay.start()
    const socket = FakeSocket.last as FakeSocket
    await online(socket)
    socket.deliver({ type: 'consent-open', id: 'c1', query: 'client_id=x', source: '' })
    socket.deliver({ type: 'consent-open', id: 'c2', query: 'boom', source: '198.51.100.2' })
    expect(asked).toEqual([
      { id: 'c1', query: 'client_id=x', source: null },
      { id: 'c2', query: 'boom', source: '198.51.100.2' },
    ])
    expect(socket.frames().slice(-2)).toEqual([
      { type: 'consent-view', id: 'c1', state: 'waiting', code: 'ABCD-1234' },
      { type: 'consent-view', id: 'c2', state: 'declined' },
    ])
  })

  it('maps the Mac’s own /authorize checks onto consent views, and polls by the relay’s id', () => {
    const clients = new RemoteClients()
    const consents = new ConsentRequests()
    const authorization = new RemoteAuthorization({ tokens: new RemoteAccessTokens(), clients, consents })
    const host = `${MAC_ID}.relay.test`
    const redirect = 'https://claude.example/cb'
    const { registration } = clients.register(
      { redirectUris: [redirect], authMethod: 'none', clientName: null },
      null,
    )
    const query = (extra: Record<string, string> = {}) =>
      new URLSearchParams({
        response_type: 'code',
        client_id: registration.id,
        redirect_uri: redirect,
        code_challenge: 'c'.repeat(43),
        code_challenge_method: 'S256',
        state: 's',
        ...extra,
      }).toString()

    expect(authorization.relayConsent('u1', 'client_id=nobody', null, host)).toEqual({ state: 'declined' })
    const badMethod = authorization.relayConsent('u2', query({ code_challenge_method: 'plain' }), null, host)
    expect(badMethod.state).toBe('declined')
    expect('redirect' in badMethod && new URL(badMethod.redirect).searchParams.get('error')).toBe(
      'invalid_request',
    )
    expect(authorization.relayConsent('unknown', '', null, host)).toEqual({ state: 'expired' })

    const waiting = authorization.relayConsent('w1', query(), '203.0.113.1', host)
    expect(waiting.state).toBe('waiting')
    expect(consents.prompts()[0]?.source).toBe('203.0.113.1')
    expect(authorization.relayConsent('w1', '', null, host)).toEqual(waiting)
    const code = ('code' in waiting ? waiting.code : '').replace('-', '')
    expect(consents.approve(code, []).ok).toBe(true)
    const approved = authorization.relayConsent('w1', '', null, host)
    expect(approved.state).toBe('approved')
    const location = new URL('redirect' in approved ? approved.redirect : '')
    expect(location.searchParams.get('code')).toMatch(/.+/)
    expect(location.searchParams.get('iss')).toBe(`https://${host}`)
    // Answered once; the id is spent.
    expect(authorization.relayConsent('w1', '', null, host)).toEqual({ state: 'expired' })

    authorization.relayConsent('w2', query(), null, host)
    consents.declineAll()
    const declined = authorization.relayConsent('w2', '', null, host)
    expect(declined.state).toBe('declined')
  })
})
