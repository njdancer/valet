import { PassThrough } from 'node:stream'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  LATEST_PROTOCOL_VERSION,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { type RunningBridge, runBridge } from '../src/bridge'
import { type RunningHttpServer, startHttpServer } from '../src/http'
import type { ListedTool } from '../src/tool-caller'
import { FakeCaller } from './fake-caller'

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
  const running = await startHttpServer({ caller, token: TOKEN })
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

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } },
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
    expect(result.content).toEqual([{ type: 'text', text: 'the person declined this action' }])
  })

  it('relays list_changed notifications from the endpoint', async () => {
    const caller = new FakeCaller([searchProducts])
    const server = await startServer(caller)
    const client = await connectThroughBridge(server.url)
    const heard = new Promise<void>((resolve) => {
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => resolve())
    })
    await new Promise((resolve) => setTimeout(resolve, 50))

    caller.tools = [searchProducts, viewCart]
    server.refresh()
    await heard

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
      error: { code: -32000, message: 'siteadapter refused the bridge token; check the bridge config' },
    })
  })

  it('answers a request with a fixed error when the endpoint is down', async () => {
    const server = await startHttpServer({ caller: new FakeCaller([]), token: TOKEN })
    await server.close()
    const { toBridge, fromBridge } = await wireBridge(server.url)

    const reply = nextLine(fromBridge)
    toBridge.write(`${JSON.stringify(INITIALIZE)}\n`)

    expect((await reply).error).toEqual({
      code: -32000,
      message: 'siteadapter is not reachable; make sure the app is running',
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

    expect((await reply).error.message).toBe('the siteadapter session has ended; restart this MCP server')
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

    expect((await reply).error.message).toBe('siteadapter refused the request')
  })

  it('writes nothing for a failed notification', async () => {
    const server = await startHttpServer({ caller: new FakeCaller([]), token: TOKEN })
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

    expect((await reply).result.serverInfo.name).toBe('siteadapter')
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

  it('can be closed more than once', async () => {
    const server = await startServer(new FakeCaller([searchProducts]))
    const { bridge } = await wireBridge(server.url)
    await Promise.all([bridge.close(), bridge.close()])
    await bridge.done
  })
})
