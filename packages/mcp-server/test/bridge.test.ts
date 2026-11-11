import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { PassThrough } from 'node:stream'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  LATEST_PROTOCOL_VERSION,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { type BridgeTarget, type RunningBridge, runBridge, type Schedule } from '../src/bridge'
import { type RunningHttpServer, startHttpServer } from '../src/http'
import type { ListedTool } from '../src/tool-caller'
import { FakeCaller } from './fake-caller'
import { tokenAuth } from './token-auth'

const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ'

const searchProducts: ListedTool = {
  adapterId: 'woolworths',
  adapterName: 'Woolworths',
  declaration: {
    name: 'search_products',
    title: 'Search products',
    description: 'Searches the Woolworths catalogue.',
    sideEffect: 'read',
  },
  input: z.object({ query: z.string() }),
  output: z.object({ query: z.string() }),
}

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

async function startServer(caller: FakeCaller): Promise<RunningHttpServer> {
  const running = await startHttpServer({ caller, authenticate: tokenAuth(TOKEN) })
  cleanup.push(() => running.close())
  return running
}

interface Wired {
  readonly bridge: RunningBridge
  readonly toBridge: PassThrough
  readonly fromBridge: PassThrough
  /** A stdio-side transport for an SDK client: it reads what the bridge writes and vice versa. */
  readonly clientTransport: StdioServerTransport
}

async function wireBridge(url: string, token = TOKEN, fetch?: FetchLike): Promise<Wired> {
  const toBridge = new PassThrough()
  const fromBridge = new PassThrough()
  const bridge = await runBridge({
    url,
    token,
    input: toBridge,
    output: fromBridge,
    ...(fetch === undefined ? {} : { fetch }),
  })
  cleanup.push(() => bridge.close())
  return { bridge, toBridge, fromBridge, clientTransport: new StdioServerTransport(fromBridge, toBridge) }
}

async function connectThroughBridge(url: string, name = 'stdio-client'): Promise<Client> {
  const { clientTransport } = await wireBridge(url)
  const client = new Client({ name, version: '1.0.0' })
  await client.connect(clientTransport)
  cleanup.push(() => client.close())
  return client
}

/** Reads newline-delimited JSON the bridge writes. */
function nextLine(stream: PassThrough): Promise<any> {
  return new Promise((resolve) => {
    let buffered = ''
    const onData = (chunk: Buffer) => {
      buffered += chunk.toString('utf8')
      const newline = buffered.indexOf('\n')
      if (newline === -1) return
      stream.off('data', onData)
      resolve(JSON.parse(buffered.slice(0, newline)))
    }
    stream.on('data', onData)
  })
}

interface Timer {
  readonly run: () => void
  readonly ms: number
  cancelled: boolean
}

/** A schedule the test drives: nothing runs until the test calls a timer's run(). */
function manualSchedule() {
  const timers: Timer[] = []
  let notify: (timer: Timer) => void = () => {}
  const schedule: Schedule = (run, ms) => {
    const timer: Timer = { run, ms, cancelled: false }
    timers.push(timer)
    notify(timer)
    return () => {
      timer.cancelled = true
    }
  }
  /** Resolves with the next timer the bridge sets. */
  const nextTimer = () =>
    new Promise<Timer>((resolve) => {
      notify = resolve
    })
  return { timers, schedule, nextTimer }
}

/** One turn of the event loop, after which Node has reported any unhandled rejection. */
const turn = () => new Promise((resolve) => setImmediate(resolve))

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } },
}

const SESSION_ENDED = 'the Valet session ended before this request was answered'

/** A caller whose view_cart never answers, and a promise that resolves once each call reaches it. */
function stuckCaller(): { caller: FakeCaller; reached: (count: number) => Promise<void> } {
  const caller = new FakeCaller([viewCart])
  let waiters: Array<() => void> = []
  caller.answer = () => {
    for (const wake of waiters) wake()
    return new Promise(() => {})
  }
  const reached = async (count: number): Promise<void> => {
    while (caller.calls.length < count) {
      await new Promise<void>((resolve) => {
        waiters = [...waiters, resolve]
      })
    }
  }
  return { caller, reached }
}

/** Every JSON-RPC line the bridge writes, as it writes them. */
function collectLines(stream: PassThrough): () => any[] {
  let buffered = ''
  stream.on('data', (chunk: Buffer) => {
    buffered += chunk.toString('utf8')
  })
  return () =>
    buffered
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line))
}

describe('runBridge', () => {
  it('lets a stdio client list and call tools on the HTTP endpoint', async () => {
    const caller = new FakeCaller([searchProducts])
    caller.answer = async (call) => ({ status: 'ok', output: { query: (call.input as any).query } })
    const server = await startServer(caller)
    const client = await connectThroughBridge(server.url)

    const { tools } = await client.listTools()
    const result = await client.callTool({ name: 'woolworths_search_products', arguments: { query: 'milk' } })

    expect(tools.map((t) => t.name)).toEqual(['woolworths_search_products'])
    expect(result.structuredContent).toEqual({ query: 'milk' })
  })

  it("passes the stdio client's own name through to the audit record", async () => {
    const caller = new FakeCaller([searchProducts])
    caller.answer = async () => ({ status: 'ok', output: { query: '' } })
    const server = await startServer(caller)
    const client = await connectThroughBridge(server.url, 'Claude Code')

    await client.callTool({ name: 'woolworths_search_products', arguments: { query: 'milk' } })

    expect(caller.calls[0]?.client).toBe('Claude Code')
  })

  it('relays tool errors unchanged', async () => {
    const caller = new FakeCaller([searchProducts])
    caller.answer = async () => ({ status: 'declined' })
    const server = await startServer(caller)
    const client = await connectThroughBridge(server.url)

    const result = await client.callTool({ name: 'woolworths_search_products', arguments: { query: 'milk' } })

    expect(result.isError).toBe(true)
    expect(result.content).toEqual([
      {
        type: 'text',
        text: expect.stringMatching(
          /^The person did not approve this action in the Valet app \(stage confirm: declined\)\. The person can see it in Valet, Activity, call [0-9A-F]{4}\.$/,
        ),
      },
    ])
  })

  it('relays list_changed notifications from the endpoint', async () => {
    const caller = new FakeCaller([searchProducts])
    const server = await startServer(caller)
    const client = await connectThroughBridge(server.url)
    const heard = new Promise<void>((resolve) => {
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => resolve())
    })
    caller.tools = [searchProducts, viewCart]
    // The bridge's SSE stream opens in the background; refreshing again is harmless.
    const retry = setInterval(() => server.refresh(), 20)
    await heard.finally(() => clearInterval(retry))

    expect((await client.listTools()).tools).toHaveLength(2)
  })

  it('sends the negotiated protocol version on every request after initialize', async () => {
    const server = await startServer(new FakeCaller([searchProducts]))
    const versions: Array<string | null> = []
    const recording: FetchLike = (url, init) => {
      versions.push(new Headers(init?.headers).get('mcp-protocol-version'))
      return fetch(url, init)
    }
    const { clientTransport } = await wireBridge(server.url, TOKEN, recording)
    const client = new Client({ name: 'c', version: '1' })
    await client.connect(clientTransport)
    cleanup.push(() => client.close())
    await client.listTools()

    const [initialize, ...later] = versions
    expect(initialize).toBeNull()
    expect(later.length).toBeGreaterThan(0)
    expect(later).toEqual(later.map(() => LATEST_PROTOCOL_VERSION))
  })

  it('does not let a slow call hold up the next one', async () => {
    const caller = new FakeCaller([searchProducts, viewCart])
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    caller.answer = async (call) => {
      if (call.tool === 'search_products') {
        await gate
        return { status: 'ok', output: { query: 'slow' } }
      }
      return { status: 'ok', output: { items: 2 } }
    }
    const server = await startServer(caller)
    const client = await connectThroughBridge(server.url)

    const slow = client.callTool({ name: 'woolworths_search_products', arguments: { query: 'x' } })
    const fast = await client.callTool({ name: 'woolworths_view_cart', arguments: {} })
    release()

    expect(fast.structuredContent).toEqual({ items: 2 })
    expect((await slow).structuredContent).toEqual({ query: 'slow' })
  })

  it('answers a request with a fixed error when the token is wrong', async () => {
    const server = await startServer(new FakeCaller([searchProducts]))
    const { toBridge, fromBridge } = await wireBridge(server.url, `${TOKEN.slice(0, -1)}R`)

    const reply = nextLine(fromBridge)
    toBridge.write(`${JSON.stringify(INITIALIZE)}\n`)

    expect(await reply).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32000, message: 'valet refused the bridge token; check the bridge config' },
    })
  })

  it('answers a request with a fixed error when the endpoint is down', async () => {
    const server = await startHttpServer({ caller: new FakeCaller([]), authenticate: tokenAuth(TOKEN) })
    await server.close()
    const { toBridge, fromBridge } = await wireBridge(server.url)

    const reply = nextLine(fromBridge)
    toBridge.write(`${JSON.stringify(INITIALIZE)}\n`)

    expect((await reply).error).toEqual({
      code: -32000,
      message: 'valet is not reachable; make sure the app is running',
    })
  })

  it('answers with a fixed error when the session is gone', async () => {
    const server = await startServer(new FakeCaller([searchProducts]))
    const forged: FetchLike = (url, init) => {
      const headers = new Headers(init?.headers)
      headers.set('mcp-session-id', 'not-a-session')
      return fetch(url, { ...init, headers })
    }
    const { toBridge, fromBridge } = await wireBridge(server.url, TOKEN, forged)

    const reply = nextLine(fromBridge)
    toBridge.write(`${JSON.stringify(INITIALIZE)}\n`)

    expect((await reply).error.message).toBe('the Valet session has ended; restart this MCP server')
  })

  it('answers with a fixed error when the endpoint refuses the request', async () => {
    const server = await startServer(new FakeCaller([searchProducts]))
    const crossSite: FetchLike = (url, init) => {
      const headers = new Headers(init?.headers)
      headers.set('origin', 'https://attacker.example')
      return fetch(url, { ...init, headers })
    }
    const { toBridge, fromBridge } = await wireBridge(server.url, TOKEN, crossSite)

    const reply = nextLine(fromBridge)
    toBridge.write(`${JSON.stringify(INITIALIZE)}\n`)

    expect((await reply).error.message).toBe('valet refused the request')
  })

  it('writes nothing for a failed notification', async () => {
    const server = await startHttpServer({ caller: new FakeCaller([]), authenticate: tokenAuth(TOKEN) })
    await server.close()
    const { toBridge, fromBridge, bridge } = await wireBridge(server.url)
    const written: string[] = []
    fromBridge.on('data', (chunk: Buffer) => written.push(chunk.toString('utf8')))

    toBridge.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    toBridge.end()
    await bridge.done

    expect(written).toEqual([])
  })

  it('ignores a malformed line and keeps relaying', async () => {
    const caller = new FakeCaller([searchProducts])
    const server = await startServer(caller)
    const { toBridge, fromBridge } = await wireBridge(server.url)

    toBridge.write('this is not json\n')
    const reply = nextLine(fromBridge)
    toBridge.write(`${JSON.stringify(INITIALIZE)}\n`)

    expect((await reply).result.serverInfo.name).toBe('valet')
  })

  it('ends the session upstream when the stdio client goes away', async () => {
    const server = await startServer(new FakeCaller([searchProducts]))
    const methods: string[] = []
    const recording: FetchLike = (url, init) => {
      methods.push(init?.method ?? 'GET')
      return fetch(url, init)
    }
    const { clientTransport, toBridge, bridge } = await wireBridge(server.url, TOKEN, recording)
    const client = new Client({ name: 'c', version: '1' })
    await client.connect(clientTransport)

    toBridge.end()
    await bridge.done

    expect(methods).toContain('DELETE')
  })

  it('answers a call in flight at once when the app quits', async () => {
    const { caller, reached } = stuckCaller()
    const server = await startHttpServer({ caller, authenticate: tokenAuth(TOKEN) })
    const client = await connectThroughBridge(server.url)

    const call = client.callTool({ name: 'woolworths_view_cart', arguments: {} }, undefined, {
      timeout: 3_000,
    })
    await reached(1)
    await server.close()

    await expect(call).rejects.toThrow(SESSION_ENDED)
  })

  it('answers a call in flight at once when its connection is reset', async () => {
    const { caller, reached } = stuckCaller()
    const server = await startServer(caller)
    let arm: (reset: () => void) => void = () => {}
    const armed = new Promise<() => void>((resolve) => {
      arm = resolve
    })
    const resetting: FetchLike = async (url, init) => {
      const response = await fetch(url, init)
      if (!String(init?.body).includes('"tools/call"') || response.body === null) return response
      void response.body.cancel()
      const broken = new ReadableStream<Uint8Array>({
        pull: (controller) =>
          new Promise<void>((resolve) => {
            arm(() => {
              controller.error(new TypeError('terminated: ECONNRESET'))
              resolve()
            })
          }),
      })
      return new Response(broken, { status: response.status, headers: response.headers })
    }
    const { clientTransport } = await wireBridge(server.url, TOKEN, resetting)
    const client = new Client({ name: 'c', version: '1' })
    await client.connect(clientTransport)
    cleanup.push(() => client.close())

    const call = client.callTool({ name: 'woolworths_view_cart', arguments: {} }, undefined, {
      timeout: 3_000,
    })
    await reached(1)
    const reset = await armed
    reset()

    await expect(call).rejects.toThrow(SESSION_ENDED)
  })

  it('answers what is in flight when it closes, except a request the client cancelled', async () => {
    const { caller, reached } = stuckCaller()
    const server = await startServer(caller)
    const { toBridge, fromBridge, bridge } = await wireBridge(server.url)
    const lines = collectLines(fromBridge)
    const initialized = nextLine(fromBridge)
    toBridge.write(`${JSON.stringify(INITIALIZE)}\n`)
    await initialized
    const call = (id: number) => ({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: 'woolworths_view_cart', arguments: {} },
    })
    toBridge.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    toBridge.write(`${JSON.stringify(call(2))}\n`)
    toBridge.write(`${JSON.stringify(call(3))}\n`)
    await reached(2)

    const cancel = { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } }
    toBridge.write(`${JSON.stringify(cancel)}\n`)
    await bridge.close()

    expect(lines().slice(1)).toEqual([
      { jsonrpc: '2.0', id: 3, error: { code: -32000, message: SESSION_ENDED } },
    ])
  })

  it('can be closed more than once', async () => {
    const server = await startServer(new FakeCaller([searchProducts]))
    const { bridge } = await wireBridge(server.url)
    await Promise.all([bridge.close(), bridge.close()])
    await bridge.done
  })
})

describe('reconnecting after the app restarts', () => {
  async function bridgeWithReconnect(
    target: { current: BridgeTarget },
    name: string,
    extra: {
      fetch?: FetchLike
      reconnectTimeoutMs?: number
      schedule?: Schedule
      onReconnect?: () => void
    } = {},
  ): Promise<Client> {
    const toBridge = new PassThrough()
    const fromBridge = new PassThrough()
    const bridge = await runBridge({
      ...target.current,
      input: toBridge,
      output: fromBridge,
      reconnect: async () => {
        extra.onReconnect?.()
        return target.current
      },
      ...(extra.fetch === undefined ? {} : { fetch: extra.fetch }),
      ...(extra.reconnectTimeoutMs === undefined ? {} : { reconnectTimeoutMs: extra.reconnectTimeoutMs }),
      ...(extra.schedule === undefined ? {} : { schedule: extra.schedule }),
    })
    cleanup.push(() => bridge.close())
    const client = new Client({ name, version: '1.0.0' })
    await client.connect(new StdioServerTransport(fromBridge, toBridge))
    cleanup.push(() => client.close())
    return client
  }

  /** An endpoint stand-in that answers initialize with a JSON-RPC error, never answers, or hangs up. */
  async function startBrokenEndpoint(
    mode: 'error' | 'silent' | 'hangup',
  ): Promise<{ url: string; server: Server }> {
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
      })
      req.on('end', () => {
        if (req.method !== 'POST') {
          res.writeHead(405).end()
          return
        }
        const { id } = JSON.parse(body)
        if (mode === 'silent') {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 's' })
          res.write(': waiting\n\n')
          return
        }
        if (mode === 'hangup') {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 's' })
          res.end()
          return
        }
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 's' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32600, message: 'no' } }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanup.push(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
          server.closeAllConnections()
        }),
    )
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, server }
  }

  it('replays the client initialize into the new endpoint and retries the call', async () => {
    const before = new FakeCaller([viewCart])
    before.answer = async () => ({ status: 'ok', output: { items: 1 } })
    const first = await startHttpServer({ caller: before, authenticate: tokenAuth(TOKEN) })
    const target = { current: { url: first.url, token: TOKEN } }
    const client = await bridgeWithReconnect(target, 'long-lived-client')
    await client.callTool({ name: 'woolworths_view_cart', arguments: {} })

    await first.close()
    const after = new FakeCaller([viewCart])
    after.answer = async () => ({ status: 'ok', output: { items: 7 } })
    // A restarted app has a new port and a new token.
    const newToken = 'ZYXWVUTSRQPONMLKJIHGFEDCBAzyxwvutsrqponmlkj'
    const second = await startHttpServer({ caller: after, authenticate: tokenAuth(newToken) })
    cleanup.push(() => second.close())
    target.current = { url: second.url, token: newToken }
    const relisted = new Promise<void>((resolve) => {
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => resolve())
    })

    const result = await client.callTool({ name: 'woolworths_view_cart', arguments: {} })

    expect(result.structuredContent).toEqual({ items: 7 })
    expect(after.calls.map((c) => c.client)).toEqual(['long-lived-client'])
    await relisted
  })

  it('rebuilds a session the endpoint evicted', async () => {
    const caller = new FakeCaller([viewCart])
    caller.answer = async () => ({ status: 'ok', output: { items: 2 } })
    const server = await startHttpServer({ caller, authenticate: tokenAuth(TOKEN), maxSessions: 1 })
    cleanup.push(() => server.close())
    let reconnects = 0
    const client = await bridgeWithReconnect({ current: { url: server.url, token: TOKEN } }, 'evicted', {
      onReconnect: () => {
        reconnects++
      },
    })
    await client.listTools()
    const transport = new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
    })
    const other = new Client({ name: 'other', version: '1' })
    await other.connect(transport)
    cleanup.push(() => other.close())

    const result = await client.callTool({ name: 'woolworths_view_cart', arguments: {} })

    expect(result.structuredContent).toEqual({ items: 2 })
    expect(reconnects).toBe(1)
  })

  it('answers with the fixed error when the endpoint is still down', async () => {
    const server = await startHttpServer({
      caller: new FakeCaller([viewCart]),
      authenticate: tokenAuth(TOKEN),
    })
    const client = await bridgeWithReconnect({ current: { url: server.url, token: TOKEN } }, 'c')
    await client.listTools()
    await server.close()

    await expect(client.callTool({ name: 'woolworths_view_cart', arguments: {} })).rejects.toThrow(
      'valet is not reachable; make sure the app is running',
    )
  })

  it('answers with the fixed error when the new endpoint refuses the replayed initialize', async () => {
    const server = await startHttpServer({
      caller: new FakeCaller([viewCart]),
      authenticate: tokenAuth(TOKEN),
    })
    const target = { current: { url: server.url, token: TOKEN } }
    const client = await bridgeWithReconnect(target, 'c')
    await client.listTools()
    await server.close()
    target.current = { url: (await startBrokenEndpoint('error')).url, token: TOKEN }

    await expect(client.callTool({ name: 'woolworths_view_cart', arguments: {} })).rejects.toThrow(
      'valet is not reachable; make sure the app is running',
    )
  })

  it('gives up when the replayed initialize is never answered', async () => {
    const clock = manualSchedule()
    const server = await startHttpServer({
      caller: new FakeCaller([viewCart]),
      authenticate: tokenAuth(TOKEN),
    })
    const target = { current: { url: server.url, token: TOKEN } }
    const client = await bridgeWithReconnect(target, 'c', {
      reconnectTimeoutMs: 50,
      schedule: clock.schedule,
    })
    await client.listTools()
    await server.close()
    target.current = { url: (await startBrokenEndpoint('silent')).url, token: TOKEN }

    const scheduled = clock.nextTimer()
    const call = client.callTool({ name: 'woolworths_view_cart', arguments: {} })
    const timer = await scheduled
    timer.run()

    expect(timer.ms).toBe(50)
    await expect(call).rejects.toThrow('valet is not reachable; make sure the app is running')
  })

  it('gives up at once, without waiting out the timeout, when the new endpoint hangs up', async () => {
    const clock = manualSchedule()
    const server = await startHttpServer({
      caller: new FakeCaller([viewCart]),
      authenticate: tokenAuth(TOKEN),
    })
    const target = { current: { url: server.url, token: TOKEN } }
    const client = await bridgeWithReconnect(target, 'c', { schedule: clock.schedule })
    await client.listTools()
    await server.close()
    target.current = { url: (await startBrokenEndpoint('hangup')).url, token: TOKEN }

    await expect(client.callTool({ name: 'woolworths_view_cart', arguments: {} })).rejects.toThrow(
      'valet is not reachable; make sure the app is running',
    )
    expect(clock.timers).toHaveLength(1)
    expect(clock.timers[0]?.cancelled).toBe(true)
  })

  // Regression: the replayed initialize's timeout used to outlive a send that failed, and its
  // rejection, which nothing awaited, killed the bridge process when it fired.
  it('survives the reconnect timeout after a reconnect that found the app still down', async () => {
    const clock = manualSchedule()
    const server = await startHttpServer({
      caller: new FakeCaller([viewCart]),
      authenticate: tokenAuth(TOKEN),
    })
    const target = { current: { url: server.url, token: TOKEN } }
    const client = await bridgeWithReconnect(target, 'c', {
      reconnectTimeoutMs: 50,
      schedule: clock.schedule,
    })
    await client.listTools()
    await server.close()

    await expect(client.callTool({ name: 'woolworths_view_cart', arguments: {} })).rejects.toThrow(
      'valet is not reachable; make sure the app is running',
    )
    expect(clock.timers).toHaveLength(1)
    expect(clock.timers[0]?.cancelled).toBe(true)
    // Even a timer that fired anyway must find nothing left to reject.
    for (const timer of clock.timers) timer.run()
    await turn()

    const caller = new FakeCaller([viewCart])
    caller.answer = async () => ({ status: 'ok', output: { items: 4 } })
    target.current = { url: (await startServer(caller)).url, token: TOKEN }
    const result = await client.callTool({ name: 'woolworths_view_cart', arguments: {} })
    expect(result.structuredContent).toEqual({ items: 4 })
  })

  it('survives a notification that sets off a reconnect while the app is down', async () => {
    const clock = manualSchedule()
    const server = await startHttpServer({
      caller: new FakeCaller([viewCart]),
      authenticate: tokenAuth(TOKEN),
    })
    const target = { current: { url: server.url, token: TOKEN } }
    const client = await bridgeWithReconnect(target, 'c', {
      reconnectTimeoutMs: 50,
      schedule: clock.schedule,
    })
    await client.listTools()
    await server.close()

    // What a client sends after its own request timeout fires.
    const scheduled = clock.nextTimer()
    await client.notification({ method: 'notifications/cancelled', params: { requestId: 99 } })
    const timer = await scheduled
    await vi.waitFor(() => expect(timer.cancelled).toBe(true))
    timer.run()
    await turn()

    const caller = new FakeCaller([viewCart])
    caller.answer = async () => ({ status: 'ok', output: { items: 5 } })
    target.current = { url: (await startServer(caller)).url, token: TOKEN }
    const result = await client.callTool({ name: 'woolworths_view_cart', arguments: {} })
    expect(result.structuredContent).toEqual({ items: 5 })
  })

  it('answers the calls left on the old session when it reconnects for a new one', async () => {
    const { caller, reached } = stuckCaller()
    const first = await startHttpServer({ caller, authenticate: tokenAuth(TOKEN), maxSessions: 1 })
    cleanup.push(() => first.close())
    const target = { current: { url: first.url, token: TOKEN } }
    const client = await bridgeWithReconnect(target, 'c')
    // Settled into a value at once: the rejection arrives during the listTools() below.
    const stuck = client
      .callTool({ name: 'woolworths_view_cart', arguments: {} }, undefined, { timeout: 3_000 })
      .then(
        () => 'answered',
        (error: Error) => error.message,
      )
    await reached(1)
    // Another client takes the only session slot, so the bridge's next request finds its session gone.
    const other = new Client({ name: 'other', version: '1' })
    await other.connect(
      new StreamableHTTPClientTransport(new URL(first.url), {
        requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
      }),
    )
    cleanup.push(() => other.close())

    await client.listTools()

    expect(await stuck).toContain(SESSION_ENDED)
  })

  it('tries again on the next call after a failed reconnect', async () => {
    const first = await startHttpServer({
      caller: new FakeCaller([viewCart]),
      authenticate: tokenAuth(TOKEN),
    })
    const target = { current: { url: first.url, token: TOKEN } }
    let reconnects = 0
    const client = await bridgeWithReconnect(target, 'patient-client', {
      reconnectTimeoutMs: 50,
      onReconnect: () => {
        reconnects++
      },
    })
    await client.listTools()
    await first.close()
    target.current = { url: (await startBrokenEndpoint('error')).url, token: TOKEN }
    await expect(client.callTool({ name: 'woolworths_view_cart', arguments: {} })).rejects.toThrow()

    const caller = new FakeCaller([viewCart])
    caller.answer = async () => ({ status: 'ok', output: { items: 9 } })
    target.current = { url: (await startServer(caller)).url, token: TOKEN }
    const result = await client.callTool({ name: 'woolworths_view_cart', arguments: {} })

    expect(result.structuredContent).toEqual({ items: 9 })
    expect(caller.calls.map((c) => c.client)).toEqual(['patient-client'])
    expect(reconnects).toBe(2)
  })

  it('does not treat a refusal as a restart', async () => {
    const server = await startServer(new FakeCaller([viewCart]))
    let hostile = false
    let reconnects = 0
    const fetchMaybeCrossSite: FetchLike = (url, init) => {
      const headers = new Headers(init?.headers)
      if (hostile) headers.set('origin', 'https://attacker.example')
      return fetch(url, { ...init, headers })
    }
    const client = await bridgeWithReconnect({ current: { url: server.url, token: TOKEN } }, 'c', {
      fetch: fetchMaybeCrossSite,
      onReconnect: () => {
        reconnects++
      },
    })
    hostile = true

    await expect(client.callTool({ name: 'woolworths_view_cart', arguments: {} })).rejects.toThrow(
      'valet refused the request',
    )
    expect(reconnects).toBe(0)
  })

  it('does not reconnect before the client has initialized', async () => {
    const server = await startHttpServer({ caller: new FakeCaller([]), authenticate: tokenAuth(TOKEN) })
    await server.close()
    let reconnects = 0
    const toBridge = new PassThrough()
    const fromBridge = new PassThrough()
    const bridge = await runBridge({
      url: server.url,
      token: TOKEN,
      input: toBridge,
      output: fromBridge,
      reconnect: async () => {
        reconnects++
        return { url: server.url, token: TOKEN }
      },
    })
    cleanup.push(() => bridge.close())

    const reply = nextLine(fromBridge)
    toBridge.write(`${JSON.stringify(INITIALIZE)}\n`)

    expect((await reply).error.message).toBe('valet is not reachable; make sure the app is running')
    expect(reconnects).toBe(0)
  })
})
