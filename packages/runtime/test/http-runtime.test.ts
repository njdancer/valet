// ctx.http end to end in the runtime: a ToolHost running an `http` adapter through the real egress
// broker to a fake API on loopback. What tool code may send, what it gets back, and what is
// recorded, for the requests an agent-written adapter would try.

import { join } from 'node:path'
import { defineAdapter, parseManifest, type ToolContext, tool } from '@valet/core'
import { EgressBroker } from '@valet/egress'
import { type FakeApi, startFakeApi } from '@valet/fake-http-api'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { NO_HTTP_ACCESS } from '../src/guarded-http'
import { noBrowserDriver } from '../src/no-browser-driver'
import { ToolHost, type ToolIsolation } from '../src/tool-host'
import type { AuthRunner } from '../src/types'
import { FakeClock, FakePrompt, MemoryAudit, MemoryJsonStore, MemoryMarkers } from './fakes'
import { inMemory, scriptFor } from './isolation/processes'

let api: FakeApi
let device: FakeApi
beforeAll(async () => {
  api = await startFakeApi()
  device = await startFakeApi({ plain: true })
})
afterAll(async () => {
  await api.close()
  await device.close()
})

const HASH = 'c'.repeat(64)

const manifest = parseManifest({
  schemaVersion: 1,
  id: 'example-api',
  name: 'Example API',
  version: '0.1.0',
  description: 'An http adapter for runtime tests',
  runtime: 'http',
  egress: ['api.example.test'],
  privateHosts: [{ address: '10.0.0.5', port: 8123, scheme: 'http' }],
  requests: [
    { method: 'GET', host: 'api.example.test', path: '/v1/items', purpose: 'read' },
    { method: 'GET', host: 'api.example.test', path: '/v1/items/:id', purpose: 'read' },
    { method: 'POST', host: 'api.example.test', path: '/v1/echo', purpose: 'write' },
    { method: 'GET', host: 'api.example.test', path: '/v1/echo', purpose: 'read' },
    { method: 'GET', host: 'api.example.test', path: '/v1/redirect', purpose: 'read' },
    { method: 'GET', host: 'api.example.test', path: '/v1/limited', purpose: 'read' },
    { method: 'GET', host: 'api.example.test', path: '/v1/download', purpose: 'read' },
    { method: 'GET', host: 'api.example.test', path: '/feed.xml', purpose: 'read' },
    { method: 'PROPFIND', host: 'api.example.test', path: '/calendars/:user/', purpose: 'read' },
    { method: 'MKCALENDAR', host: 'api.example.test', path: '/calendars/:user/:cal/', purpose: 'write' },
    { method: 'GET', host: 'api.example.test', path: '/ws/echo', purpose: 'read', websocket: true },
    { method: 'GET', host: '10.0.0.5:8123', path: '/v1/items', purpose: 'read' },
  ],
  tools: [
    { name: 'read_it', title: 'Read', description: 'A read', sideEffect: 'read' },
    { name: 'write_it', title: 'Write', description: 'A write', sideEffect: 'write' },
  ],
  limits: { requestsPerRun: 5, minGapMs: 1_000, cooldownSeconds: 60, maxCooldownSeconds: 600 },
})

/** What the next call's tool code does; each test sets it. */
let body: (ctx: ToolContext) => Promise<unknown> = async () => null

const definition = defineAdapter({
  manifest,
  tools: {
    // `do` is for the isolated script's tools (isolation/http-tools.ts).
    read_it: tool({
      input: z.object({ do: z.string().optional() }),
      output: z.unknown(),
      run: (ctx) => body(ctx),
    }),
    write_it: tool({ input: z.object({}), output: z.unknown(), run: (ctx) => body(ctx) }),
  },
})

function setup(options: { withBroker?: boolean; isolation?: ToolIsolation } = {}) {
  const audit = new MemoryAudit()
  const clock = new FakeClock()
  const host = new ToolHost({
    approvals: { isApproved: async (id, hash) => id === 'example-api' && hash === HASH },
    audit,
    prompt: new FakePrompt(),
    authRunner: vi.fn<AuthRunner>(async () => ({ status: 'ok' })),
    markers: new MemoryMarkers(() => clock.now()),
    breakerStore: new MemoryJsonStore(),
    clock,
    sleep: clock.sleep,
    pacingSleep: clock.pacingSleep,
  })
  const broker = new EgressBroker(
    { egress: manifest.egress, privateHosts: manifest.privateHosts ?? [] },
    {
      lookup: (_name, cb) => cb(null, [{ address: '127.0.0.1', family: 4 }]),
      testing: {
        allowAddresses: ['127.0.0.1'],
        ca: api.cert as string,
        route: (address) =>
          address === '10.0.0.5'
            ? { address: '127.0.0.1', port: device.port }
            : { address: '127.0.0.1', port: api.port },
      },
    },
  )
  host.register({
    definition,
    bundleHash: HASH,
    driver: noBrowserDriver(),
    ...(options.withBroker === false ? {} : { http: broker }),
    ...(options.isolation === undefined ? {} : { isolation: options.isolation }),
  })
  let n = 0
  const run = (toolName: 'read_it' | 'write_it' = 'read_it', input: unknown = {}) =>
    host.call({
      adapterId: 'example-api',
      tool: toolName,
      input,
      client: 'claude-code',
      callId: `call-${++n}`,
    })
  return { host, audit, run }
}

const blocked = (audit: MemoryAudit) => audit.events.filter((e) => e.type === 'request-blocked')
const connections = (audit: MemoryAudit) => audit.events.filter((e) => e.type === 'egress-connection')

beforeEach(() => {
  body = async () => null
})

describe('ctx.http.fetch', () => {
  it('reaches a declared endpoint and records the connection', async () => {
    const { run, audit } = setup()
    body = async (ctx) => {
      const r = await ctx.http!.fetch('https://api.example.test/v1/items')
      return {
        status: r.status,
        items: JSON.parse(r.body).items.length,
        cookie: r.headers['set-cookie'] ?? null,
      }
    }
    expect(await run()).toEqual({ status: 'ok', output: { status: 200, items: 2, cookie: null } })
    expect(connections(audit)).toEqual([
      expect.objectContaining({
        endpoint: 'api.example.test:443',
        kind: 'https',
        errorClass: null,
        callId: 'call-1',
      }),
    ])
  })

  it('resolves a relative URL against the first endpoint, and reaches a private host over http', async () => {
    const { run } = setup()
    body = async (ctx) => {
      const a = await ctx.http!.fetch('/v1/items/1')
      const b = await ctx.http!.fetch('http://10.0.0.5:8123/v1/items')
      return [a.status, b.status]
    }
    expect(await run()).toEqual({ status: 'ok', output: [200, 200] })
    expect(device.seen.at(-1)?.url).toBe('/v1/items')
  })

  it('speaks WebDAV verbs the manifest declares', async () => {
    const { run } = setup()
    body = async (ctx) => {
      const r = await ctx.http!.fetch('/calendars/alex/', { method: 'PROPFIND', headers: { depth: '1' } })
      return { status: r.status, dav: r.body.includes('<d:displayname>Home</d:displayname>') }
    }
    expect(await run()).toEqual({ status: 'ok', output: { status: 207, dav: true } })
    expect(api.seen.at(-1)).toMatchObject({
      method: 'PROPFIND',
      headers: expect.objectContaining({ depth: '1' }),
    })
  })

  it('refuses a WebDAV write from a read tool', async () => {
    const { run, audit } = setup()
    body = (ctx) => ctx.http!.fetch('/calendars/alex/home/', { method: 'MKCALENDAR' })
    expect(await run()).toEqual({ status: 'failed', stage: 'request-surface', errorClass: 'denied-path' })
    expect(blocked(audit)).toEqual([expect.objectContaining({ method: 'MKCALENDAR', reason: 'denied-path' })])
  })

  it('lets a write tool post JSON, and sends what was there when it looked', async () => {
    const { run } = setup()
    body = async (ctx) => {
      const payload = { a: 1 }
      const sent = ctx.http!.fetch('/v1/echo', { method: 'POST', json: payload })
      payload.a = 2
      return JSON.parse((await sent).body)
    }
    const result = await run('write_it')
    expect(result).toMatchObject({ status: 'ok', output: { method: 'POST', body: '{"a":1}' } })
    expect((result as { output: { headers: Record<string, string> } }).output.headers['content-type']).toBe(
      'application/json',
    )
  })

  it.each([
    ['an undeclared host', 'https://evil.example.test/v1/items'],
    ['a declared host on another port', 'https://api.example.test:8443/v1/items'],
    ['plain http to a public host', 'http://api.example.test/v1/items'],
    ['a private host not declared', 'http://10.0.0.6:8123/v1/items'],
    ['a private host on another port', 'http://10.0.0.5:8124/v1/items'],
    ['https to a private http host', 'https://10.0.0.5:8123/v1/items'],
    ['userinfo', 'https://user:pw@api.example.test/v1/items'],
    ['loopback', 'http://127.0.0.1:8123/v1/items'],
    ['a file URL', 'file:///etc/passwd'],
  ])('refuses %s, sending nothing', async (_why, url) => {
    const { run, audit } = setup()
    const before = api.seen.length + device.seen.length
    body = (ctx) => ctx.http!.fetch(url)
    const result = await run()
    expect(result).toMatchObject({ status: 'failed' })
    expect(api.seen.length + device.seen.length).toBe(before)
    expect(connections(audit)).toEqual([])
  })

  it.each([
    ['host', { host: 'evil.example.test' }],
    ['Host in another case', { HoSt: 'evil.example.test' }],
    ['cookie', { cookie: 'a=b' }],
    ['authorization', { authorization: 'Bearer stolen' }],
    ['a method override', { 'x-http-method-override': 'DELETE' }],
    ['transfer-encoding', { 'transfer-encoding': 'chunked' }],
    ['content-length', { 'content-length': '0' }],
    ['a proxy header', { 'proxy-authorization': 'x' }],
    ['a sec- header', { 'sec-websocket-key': 'x' }],
    ['a CRLF in a value', { 'x-a': 'b\r\nHost: evil.example.test' }],
    ['a bad name', { 'x a': 'b' }],
    ['a name twice', { 'X-A': '1', 'x-a': '2' }],
  ])('refuses a %s header, sending nothing', async (_why, headers) => {
    const { run } = setup()
    const before = api.seen.length
    body = async (ctx) => {
      // Caught: the refusal still fails the call, and nothing more goes.
      await ctx.http!.fetch('/v1/items', { headers }).catch(() => null)
      return ctx.http!.fetch('/v1/items')
    }
    expect(await run()).toEqual({
      status: 'failed',
      stage: 'request-surface',
      errorClass: 'undeclared-request',
    })
    expect(api.seen.length).toBe(before)
  })

  it('hands back a redirect, never following it', async () => {
    const { run } = setup()
    body = async (ctx) => {
      const r = await ctx.http!.fetch('/v1/redirect')
      return [r.status, r.headers['location']]
    }
    expect(await run()).toEqual({ status: 'ok', output: [302, 'https://evil.example.test/steal'] })
  })

  it('opens the site breaker on a 429, and refuses the next call', async () => {
    const { run } = setup()
    body = (ctx) => ctx.http!.fetch('/v1/limited')
    expect(await run()).toMatchObject({ status: 'blocked' })
    body = (ctx) => ctx.http!.fetch('/v1/items')
    const before = api.seen.length
    expect(await run()).toMatchObject({ status: 'blocked' })
    expect(api.seen.length).toBe(before)
  })

  it('counts requests against the run’s ceiling', async () => {
    const { run } = setup()
    body = async (ctx) => {
      for (let i = 0; i < 6; i++) await ctx.http!.fetch('/v1/items')
      return null
    }
    expect(await run()).toEqual({ status: 'failed', stage: 'request-surface', errorClass: 'request-ceiling' })
  })

  it('holds a read to its upload budget, sending nothing past it', async () => {
    const { run, audit } = setup()
    const before = api.seen.length
    // A read trying to carry 92 KB out in its URLs and headers, past its 64 KB.
    body = async (ctx) => {
      for (let i = 0; i < 4; i++) {
        await ctx.http!.fetch(`/v1/items?q=${'x'.repeat(7000)}`, {
          headers: Object.fromEntries(Array.from({ length: 2 }, (_, k) => [`x-pad-${k}`, 'y'.repeat(8000)])),
        })
      }
      return null
    }
    const result = await run()
    expect(result).toEqual({ status: 'failed', stage: 'egress', errorClass: 'upload-budget' })
    expect(api.seen.length - before).toBeLessThan(4)
    expect(blocked(audit)).toEqual([expect.objectContaining({ reason: 'upload-budget' })])
  })

  it('returns bytes as base64 when asked', async () => {
    const { run } = setup()
    body = async (ctx) => (await ctx.http!.fetch('/v1/download?bytes=3', { responseEncoding: 'base64' })).body
    expect(await run()).toEqual({ status: 'ok', output: Buffer.from('bbb').toString('base64') })
  })

  it('refuses a credential while none is kept', async () => {
    const { run } = setup()
    const before = api.seen.length
    body = (ctx) => ctx.http!.fetch('/v1/items', { credential: 'token' })
    expect(await run()).toEqual({ status: 'failed', stage: 'tool-run', errorClass: 'not-granted' })
    expect(api.seen.length).toBe(before)
  })

  it('is not granted without a broker', async () => {
    const { run } = setup({ withBroker: false })
    body = (ctx) => ctx.http!.fetch('/v1/items')
    expect(await run()).toEqual({ status: 'failed', stage: 'tool-run', errorClass: 'not-granted' })
  })

  it('has no page', async () => {
    const { run } = setup()
    body = (ctx) => ctx.page.fetch('/v1/items')
    expect(await run()).toEqual({ status: 'failed', stage: 'tool-run', errorClass: 'not-granted' })
  })
})

describe('ctx.http.websocket', () => {
  it('opens a declared socket, sends and receives', async () => {
    const { run, audit } = setup()
    body = async (ctx) => {
      const socket = await ctx.http!.websocket('https://api.example.test/ws/echo')
      await socket.send('hello')
      const message = await socket.receive({ waitMs: 2000 })
      await socket.close()
      return message
    }
    expect(await run()).toEqual({ status: 'ok', output: { kind: 'message', data: 'hello', binary: false } })
    await new Promise((r) => setTimeout(r, 50))
    expect(connections(audit)).toEqual([expect.objectContaining({ kind: 'websocket', errorClass: null })])
  })

  it('refuses a socket on a fetch declaration, and a fetch on a socket declaration', async () => {
    const { run } = setup()
    body = (ctx) => ctx.http!.websocket('/v1/items')
    expect(await run()).toMatchObject({ status: 'failed', stage: 'request-surface' })
    body = (ctx) => ctx.http!.fetch('/ws/echo')
    expect(await run()).toMatchObject({ status: 'failed', stage: 'request-surface' })
  })

  it('closes a socket that sends past the budget', async () => {
    const { run } = setup()
    body = async (ctx) => {
      const socket = await ctx.http!.websocket('/ws/echo')
      for (let i = 0; i < 100; i++) await socket.send('z'.repeat(1024))
      return null
    }
    expect(await run()).toEqual({ status: 'failed', stage: 'egress', errorClass: 'upload-budget' })
    expect(api.socketMessages.filter((m) => m.startsWith('zzz')).length).toBeLessThan(64)
  })
})

describe('ctx.http in an isolated tool', () => {
  const HTTP_TOOLS = join(import.meta.dirname, 'isolation', 'http-tools.ts')
  const isolated = async () => {
    const processes = inMemory()
    const world = setup({ isolation: { script: await scriptFor(HTTP_TOOLS), start: processes.start } })
    return { ...world, call: (what: string) => world.run('read_it', { do: what }), processes }
  }

  it('fetches across the channel', async () => {
    const w = await isolated()
    expect(await w.call('fetch')).toEqual({ status: 'ok', output: { status: 200, items: 2 } })
  })

  it('uses a socket across the channel', async () => {
    const w = await isolated()
    expect(await w.call('socket')).toEqual({
      status: 'ok',
      output: { kind: 'message', data: 'hi there', binary: false },
    })
  })

  it('reads a feed with the tool library’s parser', async () => {
    const w = await isolated()
    expect(await w.call('feed')).toEqual({ status: 'ok', output: ['First & foremost', 'Second'] })
  })

  it('refuses what in-process tool code is refused', async () => {
    const w = await isolated()
    expect(await w.call('forbidden')).toEqual({
      status: 'failed',
      stage: 'request-surface',
      errorClass: 'host-not-allowed',
    })
  })

  it('opens no more than four sockets in a call', async () => {
    const w = await isolated()
    expect(await w.call('many-sockets')).toEqual({
      status: 'failed',
      stage: 'request-surface',
      errorClass: 'request-ceiling',
    })
  })
})

describe('NO_HTTP_ACCESS', () => {
  it('refuses everything', async () => {
    await expect(NO_HTTP_ACCESS.fetch('https://a.test/')).rejects.toMatchObject({ errorClass: 'not-granted' })
    await expect(NO_HTTP_ACCESS.websocket('https://a.test/')).rejects.toMatchObject({
      errorClass: 'not-granted',
    })
  })
})
