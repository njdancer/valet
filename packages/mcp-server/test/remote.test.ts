import { request } from 'node:http'
import { Readable } from 'node:stream'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { ToolDeclaration } from '@valet/core'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { startHttpServer } from '../src/http'
import { type RunningRemoteListener, startRemoteListener } from '../src/remote'
import { normaliseRemoteHost, RemoteAccessTokens, remoteHostAllowed } from '../src/remote-auth'
import { type RemotePolicy, RemotePolicyCaller, type RemoteRefusal } from '../src/remote-policy'
import type { CallOutcome, ListedTool, ToolCall } from '../src/tool-caller'
import { FakeCaller } from './fake-caller'
import { tokenAuth } from './token-auth'

const HOST = 'mac.example-tailnet.ts.net'
const LOCAL_TOKEN = 'llllllllllllllllllllllllllllllllllllllllllll'.slice(0, 43)

const tool = (name: string, sideEffect: ToolDeclaration['sideEffect']): ListedTool => ({
  adapterId: 'woolworths',
  adapterName: 'Woolworths',
  declaration: { name, title: name, description: `${name}.`, sideEffect },
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
})

const viewCart = tool('view_cart', 'read')
const setQuantity = tool('set_cart_quantity', 'write')

/** A policy over a set of enabled tool names, as the app's store would answer. */
class SetPolicy implements RemotePolicy {
  readonly enabled = new Set<string>()
  allows(_adapterId: string, declaration: ToolDeclaration): boolean {
    return this.enabled.has(declaration.name)
  }
}

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

/**
 * fetch over node:http, so the Host header is the tunnel's public name while the connection goes to
 * 127.0.0.1. Node's own fetch always sends the URL's host.
 */
function tunnelFetch(port: number, host = HOST): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    const headers = new Headers(init?.headers)
    headers.set('host', host)
    const body = init?.body === undefined || init.body === null ? undefined : String(init.body)
    return new Promise<Response>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          method: init?.method ?? 'GET',
          path: url.pathname + url.search,
          headers: Object.fromEntries(headers),
        },
        (res) => {
          const out = new Headers()
          for (const [key, value] of Object.entries(res.headers)) {
            if (typeof value === 'string') out.set(key, value)
            else if (Array.isArray(value)) for (const v of value) out.append(key, v)
          }
          const status = res.statusCode ?? 0
          const stream = status === 202 || status === 204 ? null : (Readable.toWeb(res) as ReadableStream)
          resolve(new Response(stream, { status, headers: out }))
        },
      )
      init?.signal?.addEventListener('abort', () => req.destroy(new Error('aborted')))
      req.on('error', reject)
      req.end(body)
    })
  }) as typeof fetch
}

interface Setup {
  readonly caller: FakeCaller
  readonly policy: SetPolicy
  readonly tokens: RemoteAccessTokens
  readonly listener: RunningRemoteListener
  readonly refusals: Array<{ call: ToolCall; reason: RemoteRefusal }>
}

async function setup(options: { callsPerHour?: number; now?: () => number } = {}): Promise<Setup> {
  const caller = new FakeCaller([viewCart, setQuantity])
  caller.answer = async () => ({ status: 'ok', output: { ok: true } })
  const policy = new SetPolicy()
  // Tokens keep real time: the tests' clock is the call cap's.
  const tokens = new RemoteAccessTokens()
  const refusals: Array<{ call: ToolCall; reason: RemoteRefusal }> = []
  const listener = await startRemoteListener({
    caller,
    policy,
    tokens,
    hosts: () => new Set([HOST]),
    refused: async (call, reason) => {
      refusals.push({ call, reason })
    },
    ...options,
  })
  cleanup.push(() => listener.close())
  return { caller, policy, tokens, listener, refusals }
}

async function connect(port: number, token: string, name = 'claude.ai'): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`http://${HOST}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: tunnelFetch(port),
  })
  const client = new Client({ name, version: '1.0.0' })
  await client.connect(transport)
  cleanup.push(() => client.close())
  return client
}

function rawStatus(port: number, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/mcp',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...headers,
        },
      },
      (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode ?? 0))
      },
    )
    req.on('error', reject)
    req.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'raw', version: '1' },
        },
      }),
    )
  })
}

describe('remote host names', () => {
  it('accepts a DNS name with at least two labels, lowercased and without a trailing dot', () => {
    expect(normaliseRemoteHost(' Mac.Example-Tailnet.ts.net. ')).toBe(HOST)
  })

  it.each([
    '',
    'localhost',
    '127.0.0.1',
    '10.0.0.1',
    '[::1]',
    'mac.ts.net:443',
    'https://mac.ts.net',
    'user@mac.ts.net',
    'mac..ts.net',
    '-mac.ts.net',
    'mac_1.ts.net',
    `${'a'.repeat(64)}.ts.net`,
  ])('refuses %j', (input) => {
    expect(normaliseRemoteHost(input)).toBeNull()
  })

  it('matches the Host header exactly, with no port or :443 only', () => {
    const hosts = new Set([HOST])
    expect(remoteHostAllowed(HOST, hosts)).toBe(true)
    expect(remoteHostAllowed(`${HOST}:443`, hosts)).toBe(true)
    expect(remoteHostAllowed(HOST.toUpperCase(), hosts)).toBe(true)
    expect(remoteHostAllowed(`${HOST}:8443`, hosts)).toBe(false)
    expect(remoteHostAllowed(`evil.${HOST}`, hosts)).toBe(false)
    expect(remoteHostAllowed('127.0.0.1:443', hosts)).toBe(false)
    expect(remoteHostAllowed(undefined, hosts)).toBe(false)
    expect(remoteHostAllowed(HOST, new Set())).toBe(false)
  })
})

describe('RemoteAccessTokens', () => {
  it('names the client a token was issued to until it expires', () => {
    let now = 1_000
    const tokens = new RemoteAccessTokens({ now: () => now, ttlMs: 60_000 })
    const token = tokens.issue('phone')
    expect(tokens.identify(token)).toBe('phone')
    now += 59_999
    expect(tokens.identify(token)).toBe('phone')
    now += 1
    expect(tokens.identify(token)).toBeNull()
    expect(tokens.size).toBe(0)
  })

  it('revokes one client’s tokens, or all of them', () => {
    const tokens = new RemoteAccessTokens()
    const phone = tokens.issue('phone')
    const laptop = tokens.issue('laptop')
    expect(tokens.revokeClient('phone')).toBe(1)
    expect(tokens.identify(phone)).toBeNull()
    expect(tokens.identify(laptop)).toBe('laptop')
    expect(tokens.revokeAll()).toBe(1)
    expect(tokens.identify(laptop)).toBeNull()
  })

  it('refuses a malformed client id', () => {
    expect(() => new RemoteAccessTokens().issue('Not An Id')).toThrow()
  })
})

describe('the remote listener’s guards', () => {
  it('binds 127.0.0.1 only', async () => {
    const { listener } = await setup()
    expect(listener.url).toBe(`http://127.0.0.1:${listener.port}/mcp`)
  })

  it('refuses its own loopback name, so a local client can’t use it as a second local port', async () => {
    const { listener, tokens } = await setup()
    const token = tokens.issue('phone')
    expect(
      await rawStatus(listener.port, {
        host: `127.0.0.1:${listener.port}`,
        authorization: `Bearer ${token}`,
      }),
    ).toBe(403)
  })

  it('refuses a name it wasn’t given, as a DNS-rebinding page would send', async () => {
    const { listener, tokens } = await setup()
    const token = tokens.issue('phone')
    expect(
      await rawStatus(listener.port, { host: 'attacker.example', authorization: `Bearer ${token}` }),
    ).toBe(403)
  })

  it('refuses any Origin, even with a good token', async () => {
    const { listener, tokens } = await setup()
    const token = tokens.issue('phone')
    for (const origin of [`https://${HOST}`, 'https://claude.ai', 'null']) {
      expect(await rawStatus(listener.port, { host: HOST, origin, authorization: `Bearer ${token}` })).toBe(
        403,
      )
    }
  })

  it('answers 401 with a Bearer challenge for no token, a wrong one, or a local client’s', async () => {
    const { listener } = await setup()
    expect(await rawStatus(listener.port, { host: HOST })).toBe(401)
    expect(await rawStatus(listener.port, { host: HOST, authorization: `Bearer ${'x'.repeat(43)}` })).toBe(
      401,
    )
    expect(await rawStatus(listener.port, { host: HOST, authorization: `Bearer ${LOCAL_TOKEN}` })).toBe(401)
  })

  it('is not reachable with a remote token on the local listener', async () => {
    const { tokens } = await setup()
    const token = tokens.issue('phone')
    const local = await startHttpServer({
      caller: new FakeCaller([viewCart]),
      authenticate: tokenAuth(LOCAL_TOKEN),
    })
    cleanup.push(() => local.close())
    expect(
      await rawStatus(local.port, { host: `127.0.0.1:${local.port}`, authorization: `Bearer ${token}` }),
    ).toBe(401)
  })
})

describe('the remote policy over the listener', () => {
  it('lists nothing until the person enables a tool, then only that tool', async () => {
    const { listener, policy, tokens } = await setup()
    const client = await connect(listener.port, tokens.issue('phone'))
    expect((await client.listTools()).tools).toEqual([])

    policy.enabled.add('view_cart')
    listener.refresh()
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['woolworths_view_cart'])
  })

  it('passes an enabled tool’s call to the same caller, marked remote with the client’s id', async () => {
    const { listener, policy, tokens, caller } = await setup()
    policy.enabled.add('view_cart')
    const client = await connect(listener.port, tokens.issue('phone'), 'Claude')
    listener.refresh()

    const result = await client.callTool({ name: 'woolworths_view_cart', arguments: {} })

    expect(result.structuredContent).toEqual({ ok: true })
    expect(caller.calls).toHaveLength(1)
    expect(caller.calls[0]?.identity).toEqual({ origin: 'remote', clientId: 'phone' })
    expect(caller.calls[0]?.client).toBe('Claude')
    expect(listener.sessions().sessions[0]?.identity).toEqual({ origin: 'remote', clientId: 'phone' })
  })

  it('refuses a tool turned off after the client listed it, as not-found, and reports the refusal', async () => {
    const { listener, policy, tokens, caller, refusals } = await setup()
    policy.enabled.add('set_cart_quantity')
    const client = await connect(listener.port, tokens.issue('phone'))
    listener.refresh()
    await client.listTools()
    policy.enabled.clear()

    const result = await client.callTool({ name: 'woolworths_set_cart_quantity', arguments: {} })

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('config: not-found')
    expect(caller.calls).toHaveLength(0)
    expect(refusals.map((r) => [r.reason, r.call.tool, r.call.identity?.origin])).toEqual([
      ['not-enabled', 'set_cart_quantity', 'remote'],
    ])
  })

  it('caps each client’s calls per hour, apart from other clients', async () => {
    let now = 0
    const { listener, policy, tokens, caller, refusals } = await setup({ callsPerHour: 2, now: () => now })
    policy.enabled.add('view_cart')
    const phone = await connect(listener.port, tokens.issue('phone'))
    const laptop = await connect(listener.port, tokens.issue('laptop'))
    listener.refresh()
    const call = (client: Client) => client.callTool({ name: 'woolworths_view_cart', arguments: {} })

    await call(phone)
    now = 1_000
    await call(phone)
    const third = await call(phone)
    expect(third.isError).toBe(true)
    expect(JSON.stringify(third.content)).toContain('Valet is limiting calls from this client')
    expect(JSON.stringify(third.content)).toContain('3599 seconds')
    expect((await call(laptop)).isError).toBeUndefined()

    now = 60 * 60_000
    expect((await call(phone)).isError).toBeUndefined()
    expect(caller.calls.map((c) => c.identity?.clientId)).toEqual(['phone', 'phone', 'laptop', 'phone'])
    expect(refusals.map((r) => r.reason)).toEqual(['over-cap'])
  })

  it('ends one client’s access and sessions without touching another', async () => {
    const { listener, policy, tokens } = await setup()
    policy.enabled.add('view_cart')
    const phoneToken = tokens.issue('phone')
    await connect(listener.port, phoneToken)
    await connect(listener.port, tokens.issue('laptop'))
    expect(listener.sessions().total).toBe(2)

    await listener.endClient('phone')

    expect(listener.sessions().sessions.map((s) => s.identity.clientId)).toEqual(['laptop'])
    expect(tokens.identify(phoneToken)).toBeNull()
  })
})

describe('the kill switch', () => {
  it('revokes every access token, aborts calls in flight and stops listening', async () => {
    const { listener, policy, tokens, caller } = await setup()
    policy.enabled.add('view_cart')
    const token = tokens.issue('phone')
    const client = await connect(listener.port, token)
    listener.refresh()
    let aborted = false
    let started: () => void = () => {}
    const running = new Promise<void>((resolve) => {
      started = resolve
    })
    caller.answer = (call) =>
      new Promise<CallOutcome>((resolve) => {
        started()
        call.signal?.addEventListener('abort', () => {
          aborted = true
          resolve({ status: 'failed', stage: 'tool-run', errorClass: 'aborted' })
        })
      })
    const pending = client.callTool({ name: 'woolworths_view_cart', arguments: {} }).catch(() => null)
    await running

    await listener.close()
    // The client hears nothing more on the closed connection; closing it (cleanup) ends the wait.
    void pending

    expect(aborted).toBe(true)
    expect(tokens.size).toBe(0)
    expect(tokens.identify(token)).toBeNull()
    await expect(rawStatus(listener.port, { host: HOST, authorization: `Bearer ${token}` })).rejects.toThrow()
  })
})

describe('RemotePolicyCaller', () => {
  it('refuses a call that carries a local identity, as miswiring', async () => {
    const inner = new FakeCaller([viewCart])
    const policy = new SetPolicy()
    policy.enabled.add('view_cart')
    const refused: RemoteRefusal[] = []
    const caller = new RemotePolicyCaller(inner, policy, {
      refused: async (_call, reason) => {
        refused.push(reason)
      },
    })
    const base = { adapterId: 'woolworths', tool: 'view_cart', input: {}, client: 'x', callId: 'c1' }

    expect(await caller.call({ ...base, identity: { origin: 'local', clientId: 'cli' } })).toEqual({
      status: 'failed',
      stage: 'config',
      errorClass: 'not-found',
    })
    expect(await caller.call(base)).toMatchObject({ status: 'failed' })
    expect(inner.calls).toHaveLength(0)
    expect(refused).toEqual(['not-remote', 'not-remote'])
  })

  it('refuses a tool the inner caller no longer lists, even if the policy would allow its name', async () => {
    const inner = new FakeCaller([])
    const policy: RemotePolicy = { allows: () => true }
    const caller = new RemotePolicyCaller(inner, policy)
    const outcome = await caller.call({
      adapterId: 'woolworths',
      tool: 'view_cart',
      input: {},
      client: 'x',
      callId: 'c1',
      identity: { origin: 'remote', clientId: 'phone' },
    })
    expect(outcome).toMatchObject({ status: 'failed', errorClass: 'not-found' })
  })

  it('asks the policy with the tool’s current declaration', () => {
    const inner = new FakeCaller([viewCart, setQuantity])
    const seen: string[] = []
    const caller = new RemotePolicyCaller(inner, {
      allows: (_a, declaration) => {
        seen.push(`${declaration.name}:${declaration.sideEffect}`)
        return declaration.sideEffect === 'read'
      },
    })
    expect(caller.listTools().map((t) => t.declaration.name)).toEqual(['view_cart'])
    expect(seen).toEqual(['view_cart:read', 'set_cart_quantity:write'])
  })
})
