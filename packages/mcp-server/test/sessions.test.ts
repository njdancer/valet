// Live sessions, and how each one arrived: through the stdio bridge or plain HTTP. The transport is
// a label: an HTTP client that claims to be the bridge gets nothing the label could grant.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { runBridge } from '../src/bridge'
import { startEndpoint } from '../src/endpoint'
import { type LiveSessions, type RunningHttpServer, startHttpServer } from '../src/http'
import type { ListedTool } from '../src/tool-caller'
import { BRIDGE_TRANSPORT, TRANSPORT_HEADER, transportFrom } from '../src/transport-label'
import { FakeCaller } from './fake-caller'

const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ'

const viewCart: ListedTool = {
  adapterId: 'woolworths',
  adapterName: 'Woolworths',
  declaration: { name: 'view_cart', title: 'View cart', description: 'Reads the cart.', sideEffect: 'read' },
  input: z.object({}),
  output: z.object({ items: z.number() }),
}

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

async function start(
  caller: FakeCaller,
  extra: { maxSessions?: number; onSessionsChanged?: (sessions: LiveSessions) => void } = {},
): Promise<RunningHttpServer> {
  const running = await startHttpServer({ caller, token: TOKEN, ...extra })
  cleanup.push(() => running.close())
  return running
}

async function connectHttp(
  url: string,
  name: string,
  headers: Record<string, string> = {},
  fetch?: FetchLike,
): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { authorization: `Bearer ${TOKEN}`, ...headers } },
    ...(fetch === undefined ? {} : { fetch }),
  })
  const client = new Client({ name, version: '1.0.0' })
  await client.connect(transport)
  cleanup.push(() => client.close())
  return client
}

async function connectBridge(url: string, name: string, token = TOKEN): Promise<Client> {
  const toBridge = new PassThrough()
  const fromBridge = new PassThrough()
  const bridge = await runBridge({ url, token, input: toBridge, output: fromBridge })
  cleanup.push(() => bridge.close())
  const client = new Client({ name, version: '1.0.0' })
  await client.connect(new StdioServerTransport(fromBridge, toBridge))
  cleanup.push(() => client.close())
  return client
}

describe('live sessions', () => {
  it('reports none before any client connects', async () => {
    const running = await start(new FakeCaller([viewCart]))
    expect(running.sessions()).toEqual({ total: 0, bridge: 0, http: 0, sessions: [] })
  })

  it('labels a plain HTTP client http and a bridge client stdio-bridge, with their names', async () => {
    const running = await start(new FakeCaller([viewCart]))
    await connectHttp(running.url, 'cursor')
    await connectBridge(running.url, 'claude-desktop')
    await vi.waitFor(() => expect(running.sessions().total).toBe(2))
    const live = running.sessions()
    expect({ ...live, sessions: [] }).toEqual({ total: 2, bridge: 1, http: 1, sessions: [] })
    // Use order shifts as each client's event stream touches its session, so compare as a set.
    expect([...live.sessions].sort((a, b) => a.client.localeCompare(b.client))).toEqual([
      { transport: 'stdio-bridge', client: 'claude-desktop' },
      { transport: 'http', client: 'cursor' },
    ])
  })

  it('passes each session’s transport to the runtime with its calls', async () => {
    const caller = new FakeCaller([viewCart])
    caller.answer = async () => ({ status: 'ok', output: { items: 1 } })
    const running = await start(caller)
    const http = await connectHttp(running.url, 'cursor')
    const bridged = await connectBridge(running.url, 'claude-desktop')
    await http.callTool({ name: 'woolworths_view_cart', arguments: {} })
    await bridged.callTool({ name: 'woolworths_view_cart', arguments: {} })
    expect(caller.calls.map((c) => [c.client, c.transport])).toEqual([
      ['cursor', 'http'],
      ['claude-desktop', 'stdio-bridge'],
    ])
  })

  it('lets an HTTP client that claims to be the bridge have the label, and nothing else', async () => {
    const caller = new FakeCaller([viewCart])
    caller.answer = async () => ({ status: 'ok', output: { items: 1 } })
    const running = await start(caller)
    const honest = await connectHttp(running.url, 'honest')
    const claiming = await connectHttp(running.url, 'claiming', { [TRANSPORT_HEADER]: BRIDGE_TRANSPORT })
    expect(
      running
        .sessions()
        .sessions.map((s) => [s.client, s.transport])
        .sort(),
    ).toEqual([
      ['claiming', 'stdio-bridge'],
      ['honest', 'http'],
    ])
    // The same tools, described the same way, and the same results.
    expect(await claiming.listTools()).toEqual(await honest.listTools())
    expect(await claiming.callTool({ name: 'woolworths_view_cart', arguments: {} })).toEqual(
      await honest.callTool({ name: 'woolworths_view_cart', arguments: {} }),
    )
  })

  it('still needs the token with the bridge header: no session opens without it', async () => {
    const running = await start(new FakeCaller([viewCart]))
    const response = await fetch(running.url, {
      method: 'POST',
      headers: {
        [TRANSPORT_HEADER]: BRIDGE_TRANSPORT,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } },
      }),
    })
    expect(response.status).toBe(401)
    await response.body?.cancel()
    expect(running.sessions().total).toBe(0)
  })

  it('a bridge with the wrong token opens no session', async () => {
    const running = await start(new FakeCaller([viewCart]))
    await expect(connectBridge(running.url, 'stdio', 'z'.repeat(43))).rejects.toThrow()
    expect(running.sessions().total).toBe(0)
  })

  it('reads the label once, when the session opens: a header on later requests changes nothing', async () => {
    const running = await start(new FakeCaller([viewCart]))
    let opened = false
    // Adds the bridge header to every request after the initialize.
    const lateClaim: FetchLike = (url, init) => {
      const headers = new Headers(init?.headers)
      if (opened) headers.set(TRANSPORT_HEADER, BRIDGE_TRANSPORT)
      opened = true
      return fetch(url, { ...init, headers })
    }
    const client = await connectHttp(running.url, 'late', {}, lateClaim)
    await client.listTools()
    expect(running.sessions().sessions).toEqual([{ transport: 'http', client: 'late' }])
  })

  it('tells the app when sessions open, learn their client’s name, and close', async () => {
    const seen: LiveSessions[] = []
    const running = await start(new FakeCaller([viewCart]), { onSessionsChanged: (s) => seen.push(s) })
    await connectHttp(running.url, 'cursor')
    await vi.waitFor(() => expect(seen.at(-1)?.sessions).toEqual([{ transport: 'http', client: 'cursor' }]))
    await running.setToken('Z'.repeat(43))
    expect(seen.at(-1)).toEqual({ total: 0, bridge: 0, http: 0, sessions: [] })
  })

  it('reports a session evicted beyond the limit as gone', async () => {
    const seen: LiveSessions[] = []
    const running = await start(new FakeCaller([viewCart]), {
      maxSessions: 2,
      onSessionsChanged: (s) => seen.push(s),
    })
    const first = await connectHttp(running.url, 'first')
    await connectHttp(running.url, 'second')
    await first.listTools()
    await connectHttp(running.url, 'third')
    await vi.waitFor(() =>
      expect(
        running
          .sessions()
          .sessions.map((s) => s.client)
          .sort(),
      ).toEqual(['first', 'third']),
    )
    expect(running.sessions()).toMatchObject({ total: 2, bridge: 0, http: 2 })
    expect(seen.some((s) => s.total === 3)).toBe(false)
  })

  it('ignores a listener that throws', async () => {
    const running = await start(new FakeCaller([viewCart]), {
      onSessionsChanged: () => {
        throw new Error('the app’s problem')
      },
    })
    const client = await connectHttp(running.url, 'cursor')
    expect((await client.listTools()).tools).toHaveLength(1)
    expect(running.sessions().total).toBe(1)
  })

  it('never shows a session id', async () => {
    const running = await start(new FakeCaller([viewCart]))
    await connectHttp(running.url, 'cursor')
    expect(Object.keys(running.sessions().sessions[0] ?? {}).sort()).toEqual(['client', 'transport'])
  })

  it('is reported by the endpoint the app starts too', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'siteadapter-sessions-'))
    cleanup.push(() => rm(dir, { recursive: true, force: true }))
    const endpoint = await startEndpoint({
      caller: new FakeCaller([viewCart]),
      configPath: join(dir, 'bridge.json'),
    })
    cleanup.push(() => endpoint.close())
    expect(endpoint.sessions().total).toBe(0)
    const transport = new StreamableHTTPClientTransport(new URL(endpoint.url), {
      requestInit: { headers: { authorization: `Bearer ${endpoint.token}` } },
    })
    const client = new Client({ name: 'cursor', version: '1' })
    await client.connect(transport)
    cleanup.push(() => client.close())
    expect(endpoint.sessions()).toMatchObject({ total: 1, http: 1 })
  })
})

describe('transportFrom', () => {
  it('is the bridge only for the exact value the bridge sends', () => {
    expect(transportFrom(BRIDGE_TRANSPORT)).toBe('stdio-bridge')
    for (const value of [undefined, '', 'Stdio-Bridge', 'stdio-bridge ', 'http', ['stdio-bridge']]) {
      expect([value, transportFrom(value)]).toEqual([value, 'http'])
    }
  })
})
