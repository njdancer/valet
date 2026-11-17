// GuardedHttp on its own, with a broker that records what reached it: what tool code may pass,
// how a kept credential is added and taken back out of answers, and the socket handle's checks.

import { parseManifest, SecretValue, ValetError } from '@valet/core'
import { RunMeter } from '@valet/egress'
import { describe, expect, it } from 'vitest'
import { CallState } from '../src/call-state'
import { type EgressSocket, GuardedHttp, type HttpEgress } from '../src/guarded-http'
import { NO_PAGE, noBrowserDriver } from '../src/no-browser-driver'
import { SecretRedactionSet } from '../src/redaction'
import type { SiteGuards } from '../src/site-protection'

const manifest = parseManifest({
  schemaVersion: 1,
  id: 'unit-api',
  name: 'Unit API',
  version: '0.1.0',
  description: 'For GuardedHttp unit tests',
  runtime: 'http',
  egress: ['api.example.test'],
  privateHosts: [{ address: '10.0.0.5', port: 8123, scheme: 'http' }],
  requests: [
    { method: 'POST', host: 'api.example.test', path: '/v1/echo', purpose: 'read' },
    { method: 'GET', host: 'api.example.test', path: '/v1/me', purpose: 'read' },
    { method: 'GET', host: '10.0.0.5:8123', path: '/v1/me', purpose: 'read' },
    { method: 'GET', host: 'api.example.test', path: '/ws', purpose: 'read', websocket: true },
    { method: 'MOVE', host: 'api.example.test', path: '/dav/:item', purpose: 'write' },
  ],
  tools: [{ name: 'read_it', title: 'Read', description: 'A read', sideEffect: 'read' }],
})

const OPEN: SiteGuards = {
  budget: { acquire: async () => {} },
  breaker: { isOpen: () => false, admit: () => 0, recordSuccess: () => {}, trip: () => {} },
} as unknown as SiteGuards

const TOKEN = 'tok_9f8e7d6c5b4a'

function setup(
  options: {
    answer?: string
    answerHeaders?: Record<string, string>
    socket?: EgressSocket
    credentials?: boolean
    sideEffect?: 'read' | 'write'
  } = {},
) {
  const sent: { url: string; headers: Readonly<Record<string, string>>; body: Buffer | null }[] = []
  const broker: HttpEgress = {
    fetch: async (url, request) => {
      sent.push({ url: url.href, headers: request.headers, body: request.body })
      return {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-echo': request.headers['authorization'] ?? '',
          ...options.answerHeaders,
        },
        body: Buffer.from(
          options.answer ?? JSON.stringify({ seen: request.headers['authorization'] ?? null }),
        ),
      }
    },
    websocket: async () => {
      if (options.socket === undefined) throw new ValetError('egress', 'unavailable')
      return options.socket
    },
  }
  const controller = new AbortController()
  const state = new CallState('call-1', controller.signal, () => new SecretRedactionSet())
  const audits: unknown[] = []
  const http = new GuardedHttp({
    adapterId: manifest.id,
    manifest,
    sideEffect: options.sideEffect ?? 'read',
    site: OPEN,
    state,
    audit: async (e) => void audits.push(e),
    broker,
    run: { meter: new RunMeter(64 * 1024), signal: controller.signal, record: () => {} },
    credentialHeaders: ['x-api-key'],
    ...(options.credentials === true
      ? {
          credentials: {
            headerFor: async (name: string, host: string) => {
              if (name !== 'token' || host !== 'api.example.test') throw new Error('no such credential')
              return { name: 'Authorization', value: SecretValue.fromString(`Bearer ${TOKEN}`) }
            },
          },
        }
      : {}),
  })
  return { http, sent, state, controller, audits }
}

describe('GuardedHttp', () => {
  it('sends a base64 body as bytes, and keeps the content type tool code gave a JSON body', async () => {
    const { http, sent } = setup()
    await http.fetch('/v1/echo', {
      method: 'POST',
      body: Buffer.from([0, 1, 2]).toString('base64'),
      bodyEncoding: 'base64',
    })
    expect(sent[0]?.body).toEqual(Buffer.from([0, 1, 2]))
    await http.fetch('/v1/echo', {
      method: 'POST',
      json: { a: 1 },
      headers: { 'Content-Type': 'application/vnd.x+json' },
    })
    expect(sent[1]?.headers).toEqual({ 'content-type': 'application/vnd.x+json' })
  })

  it.each([
    ['bad base64', { method: 'POST', body: 'not base64!', bodyEncoding: 'base64' }],
    ['a body and json', { method: 'POST', body: 'x', json: {} }],
    ['an unknown encoding', { method: 'POST', body: 'x', bodyEncoding: 'latin1' }],
    ['a numeric method', { method: 1 }],
    ['a header that isn’t a string', { headers: { 'x-a': 1 } }],
    ['a credential name that isn’t a string', { credential: 7 }],
  ])('refuses %s, sending nothing', async (_why, init) => {
    const { http, sent } = setup()
    await expect(http.fetch('/v1/echo', init as never)).rejects.toBeInstanceOf(ValetError)
    expect(sent).toEqual([])
  })

  it('refuses a credential’s own header from tool code', async () => {
    const { http, sent } = setup({ credentials: true })
    await expect(http.fetch('/v1/me', { headers: { 'X-Api-Key': 'guess' } })).rejects.toMatchObject({
      errorClass: 'undeclared-request',
    })
    expect(sent).toEqual([])
  })

  it('adds a kept credential as its header, and takes its value out of the answer', async () => {
    const { http, sent } = setup({ credentials: true })
    const r = await http.fetch('/v1/me', { credential: 'token' })
    expect(sent[0]?.headers['authorization']).toBe(`Bearer ${TOKEN}`)
    expect(r.body).not.toContain(TOKEN)
    expect(r.headers['x-echo']).not.toContain(TOKEN)
  })

  it('refuses an answer as bytes that holds the credential', async () => {
    const { http } = setup({ credentials: true })
    await expect(
      http.fetch('/v1/me', { credential: 'token', responseEncoding: 'base64' }),
    ).rejects.toMatchObject({
      errorClass: 'unexpected-shape',
    })
  })

  it('never sends a credential over plain http, or one it doesn’t keep', async () => {
    const { http, sent } = setup({ credentials: true })
    await expect(http.fetch('http://10.0.0.5:8123/v1/me', { credential: 'token' })).rejects.toMatchObject({
      errorClass: 'not-granted',
    })
    expect(sent).toEqual([])
    const other = setup({ credentials: true })
    await expect(other.http.fetch('/v1/me', { credential: 'other' })).rejects.toMatchObject({
      errorClass: 'not-granted',
    })
    expect(other.sent).toEqual([])
  })

  it('checks a socket’s protocols, and what tool code passes to send and receive', async () => {
    const messages: Buffer[] = []
    const socket: EgressSocket = {
      send: async (data) => void messages.push(data),
      receive: async () => ({ kind: 'message', data: Buffer.from([255, 0]), binary: true }),
      close: () => {},
    }
    const { http } = setup({ socket })
    await expect(http.websocket('/ws', { protocols: ['ok', 'bad protocol'] })).rejects.toBeInstanceOf(
      ValetError,
    )
    const fresh = setup({ socket })
    const handle = await fresh.http.websocket('/ws', { protocols: ['v1.chat'] })
    await handle.send(Buffer.from('hi').toString('base64'), { binary: true })
    expect(messages[0]?.toString()).toBe('hi')
    expect(await handle.receive({ waitMs: 10 })).toEqual({ kind: 'message', data: '/wA=', binary: true })
    await expect(handle.send('x', { binary: 'yes' as never })).rejects.toMatchObject({
      errorClass: 'invalid',
    })
    await expect(handle.send('%%%', { binary: true })).rejects.toMatchObject({ errorClass: 'invalid' })
    await expect(handle.receive({ waitMs: -1 })).rejects.toMatchObject({ errorClass: 'invalid' })
    await handle.close()
    await expect(handle.send('x')).rejects.toMatchObject({ errorClass: 'unavailable' })
  })

  it('closes its sockets when the call ends', async () => {
    let closed = 0
    const socket: EgressSocket = {
      send: async () => {},
      receive: async () => null,
      close: () => void closed++,
    }
    const { http, controller } = setup({ socket })
    await http.websocket('/ws')
    controller.abort()
    expect(closed).toBe(1)
  })
})

describe('GuardedHttp against the red team’s findings', () => {
  it.each(['x-forwarded-for', 'X-Original-URL', 'forwarded', 'x-real-ip', 'via'])(
    'refuses %s, which a server may route by over the request line',
    async (name) => {
      const { http, sent } = setup()
      await expect(http.fetch('/v1/me', { headers: { [name]: '/admin' } })).rejects.toMatchObject({
        errorClass: 'undeclared-request',
      })
      expect(sent).toEqual([])
    },
  )

  it('checks a MOVE’s Destination like its target, and sends it as checked', async () => {
    const { http, sent } = setup({ sideEffect: 'write' })
    await http.fetch('/dav/a', { method: 'MOVE', headers: { Destination: '/dav/b', overwrite: 'F' } })
    expect(sent[0]?.headers['destination']).toBe('https://api.example.test/dav/b')
    expect(Object.keys(sent[0]?.headers ?? {}).filter((k) => k.toLowerCase() === 'destination')).toHaveLength(
      1,
    )
  })

  it.each([
    ['without a Destination', 'MOVE', undefined],
    ['to another host', 'MOVE', 'https://other.example.test/dav/b'],
    ['to an undeclared path', 'MOVE', '/v1/me'],
    ['to an ambiguous path', 'MOVE', '/dav/..%2Fv1'],
    ['on a method that takes none', 'POST', '/dav/b'],
  ])('refuses a request %s', async (_name, method, destination) => {
    const { http, sent } = setup({ sideEffect: 'write' })
    const path = method === 'POST' ? '/v1/echo' : '/dav/a'
    await expect(
      http.fetch(path, { method, headers: destination === undefined ? {} : { destination } }),
    ).rejects.toBeInstanceOf(ValetError)
    expect(sent).toEqual([])
  })

  it('sends a credential only uncompressed and whole, and refuses Range with it', async () => {
    const { http, sent } = setup({ credentials: true })
    await http.fetch('/v1/me', { credential: 'token' })
    expect(sent[0]?.headers['accept-encoding']).toBe('identity')
    const refused: Record<string, string>[] = [
      { 'accept-encoding': 'gzip' },
      { range: 'bytes=0-9' },
      { 'if-range': 'x' },
    ]
    for (const headers of refused) {
      const again = setup({ credentials: true })
      await expect(again.http.fetch('/v1/me', { credential: 'token', headers })).rejects.toMatchObject({
        errorClass: 'undeclared-request',
      })
      expect(again.sent).toEqual([])
    }
  })

  it('refuses a compressed answer to a request that carried a credential', async () => {
    const { http } = setup({ credentials: true, answerHeaders: { 'content-encoding': 'gzip' } })
    await expect(http.fetch('/v1/me', { credential: 'token' })).rejects.toMatchObject({
      errorClass: 'unexpected-shape',
    })
  })

  it('refuses an answer holding a piece of the credential, and redacts its encoded forms', async () => {
    const piece = setup({ credentials: true, answer: `{"half":"${TOKEN.slice(0, 13)}"}` })
    await expect(piece.http.fetch('/v1/me', { credential: 'token' })).rejects.toMatchObject({
      errorClass: 'unexpected-shape',
    })
    const encoded = Buffer.from(TOKEN).toString('base64')
    const forms = setup({ credentials: true, answer: `{"b64":"${encoded}"}` })
    const response = await forms.http.fetch('/v1/me', { credential: 'token' })
    expect(response.body).not.toContain(encoded)
    // And the call's output and audit targets are redacted for it, whatever tool code does next.
    expect(forms.state.sensitive()(`x ${TOKEN} y`)).toBe(true)
    expect(forms.state.sensitive()(`x ${encoded} y`)).toBe(true)
    forms.state.disposeSent()
  })

  it('never lets concurrent opens pass the socket cap', async () => {
    let opened = 0
    const socket: EgressSocket = { send: async () => {}, receive: async () => null, close: () => {} }
    const { http } = setup({ socket })
    // Five at once: the fifth is refused before any of them is open, and the refusal is sticky.
    const tries = await Promise.allSettled(
      Array.from({ length: 5 }, () => http.websocket('/ws').then(() => opened++)),
    )
    expect(opened).toBe(0)
    expect(tries.map((t) => t.status)).toEqual(Array(5).fill('rejected'))
    expect(tries.at(-1)).toMatchObject({ reason: { errorClass: 'request-ceiling' } })
  })
})

describe('noBrowserDriver', () => {
  it('opens nothing and refuses every page capability', async () => {
    const driver = noBrowserDriver()
    await expect(driver.openAuthPage()).rejects.toMatchObject({ errorClass: 'not-granted' })
    await expect(driver.handoff([], [])).rejects.toMatchObject({ errorClass: 'not-granted' })
    expect(await driver.sessionSecrets([], [])).toEqual([])
    expect(await driver.cookieNames([])).toEqual([])
    driver.beginRun(
      { egress: [], requests: [], maxPurpose: 'read', unlocks: [], ceiling: 1 } as never,
      () => {},
    )
    driver.unlockIrreversible()
    driver.endRun()
    await driver.close()
    expect(await driver.toolPage()).toBe(NO_PAGE)
    expect(NO_PAGE.currentUrl()).toBe('')
    for (const call of [
      () => NO_PAGE.goto('/'),
      () => NO_PAGE.click('a'),
      () => NO_PAGE.fill('a', 'b'),
      () => NO_PAGE.extract('a'),
      () => NO_PAGE.evaluate('1'),
      () => NO_PAGE.fetch('/'),
    ])
      await expect(call()).rejects.toMatchObject({ errorClass: 'not-granted' })
  })
})
