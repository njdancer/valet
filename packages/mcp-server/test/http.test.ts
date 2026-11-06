import { request } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { SiteAdapterError } from '@siteadapter/core'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { type RunningHttpServer, startHttpServer } from '../src/http'
import { bearerAuthorized, hostAllowed, originAllowed } from '../src/http-guards'
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
  output: z.object({ count: z.number() }),
}

const viewCart: ListedTool = {
  adapterId: 'woolworths',
  adapterName: 'Woolworths',
  declaration: { name: 'view_cart', title: 'View cart', description: 'Reads the cart.', sideEffect: 'read' },
  input: z.object({}),
  output: z.object({ items: z.number() }),
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } },
}

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

async function start(
  caller: FakeCaller,
  extra: { maxSessions?: number; port?: number } = {},
): Promise<RunningHttpServer> {
  const running = await startHttpServer({ caller, token: TOKEN, ...extra })
  cleanup.push(() => running.close())
  return running
}

async function connectClient(url: string, name = 'http-client', token = TOKEN): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  })
  const client = new Client({ name, version: '1.0.0' })
  await client.connect(transport)
  cleanup.push(() => client.close())
  return client
}

interface RawResponse {
  readonly status: number
  readonly headers: Record<string, string | string[] | undefined>
  readonly body: string
}

/** A POST with full control over the headers, which fetch() would not allow for Host. */
function rawPost(
  port: number,
  headers: Record<string, string>,
  body: unknown = INITIALIZE,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/mcp',
        headers: {
          host: `127.0.0.1:${port}`,
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...headers,
        },
      },
      (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          text += chunk
        })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }))
      },
    )
    req.on('error', reject)
    req.end(JSON.stringify(body))
  })
}

describe('startHttpServer', () => {
  it('listens on 127.0.0.1 at a random port and returns the /mcp URL', async () => {
    const running = await start(new FakeCaller([searchProducts]))
    expect(running.port).toBeGreaterThan(0)
    expect(running.url).toBe(`http://127.0.0.1:${running.port}/mcp`)
  })

  it('refuses to start with a blank or malformed token', async () => {
    for (const token of ['', 'short', `${TOKEN} `]) {
      await expect(startHttpServer({ caller: new FakeCaller([]), token })).rejects.toEqual(
        new SiteAdapterError('config', 'invalid'),
      )
    }
  })

  it('serves tools to an SDK client over Streamable HTTP', async () => {
    const caller = new FakeCaller([searchProducts])
    caller.answer = async () => ({ status: 'ok', output: { count: 3 } })
    const running = await start(caller)
    const client = await connectClient(running.url, 'Claude Desktop')

    const { tools } = await client.listTools()
    const result = await client.callTool({ name: 'woolworths_search_products', arguments: { query: 'milk' } })

    expect(tools.map((t) => t.name)).toEqual(['woolworths_search_products'])
    expect(result.structuredContent).toEqual({ count: 3 })
    expect(caller.calls[0]?.client).toBe('Claude Desktop')
  })

  it('keeps each client session separate, with its own client name', async () => {
    const caller = new FakeCaller([searchProducts])
    caller.answer = async () => ({ status: 'ok', output: { count: 0 } })
    const running = await start(caller)
    const first = await connectClient(running.url, 'first')
    const second = await connectClient(running.url, 'second')

    await second.callTool({ name: 'woolworths_search_products', arguments: { query: 'a' } })
    await first.callTool({ name: 'woolworths_search_products', arguments: { query: 'b' } })

    expect(caller.calls.map((c) => c.client)).toEqual(['second', 'first'])
  })

  it('tells every connected session when the tools change', async () => {
    const caller = new FakeCaller([searchProducts])
    const running = await start(caller)
    const clients = [await connectClient(running.url, 'a'), await connectClient(running.url, 'b')]
    const heard = clients.map(
      (client) =>
        new Promise<void>((resolve) => {
          client.setNotificationHandler(ToolListChangedNotificationSchema, () => resolve())
        }),
    )
    caller.tools = [searchProducts, viewCart]
    // A notification only reaches a client once its standalone SSE stream is open, which happens
    // in the background after connect; refreshing again is harmless, so repeat until both hear.
    const retry = setInterval(() => running.refresh(), 20)
    await Promise.all(heard).finally(() => clearInterval(retry))

    const { tools } = await clients[0]!.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(['woolworths_search_products', 'woolworths_view_cart'])
  })

  it('lists the tools once for every session it refreshes', async () => {
    const caller = new FakeCaller([searchProducts])
    const running = await start(caller)
    await connectClient(running.url, 'a')
    await connectClient(running.url, 'b')
    let listings = 0
    caller.listTools = () => {
      listings++
      return [searchProducts, viewCart]
    }

    running.refresh()

    expect(listings).toBe(1)
  })

  it('returns the tools a refresh withheld', async () => {
    const caller = new FakeCaller([searchProducts])
    const running = await start(caller)
    caller.tools = [searchProducts, { ...viewCart, input: z.string() }]
    expect(running.refresh()).toEqual([
      { adapterId: 'woolworths', tool: 'view_cart', reason: 'input-not-object' },
    ])
  })

  it('leaves every session on its old tools when the runtime throws during a refresh', async () => {
    const caller = new FakeCaller([searchProducts])
    const running = await start(caller)
    const clients = [await connectClient(running.url, 'a'), await connectClient(running.url, 'b')]
    caller.listTools = () => {
      throw new Error('store unavailable: /Users/nick/secret path')
    }

    let thrown: unknown
    try {
      running.refresh()
    } catch (error) {
      thrown = error
    }

    expect(thrown).toEqual(new SiteAdapterError('tool-run', 'internal'))
    expect((thrown as Error).message).not.toContain('secret')
    for (const client of clients) {
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['woolworths_search_products'])
    }
  })

  it('reports a SiteAdapterError from the runtime by its own stage and class', async () => {
    const caller = new FakeCaller([searchProducts])
    const running = await start(caller)
    caller.listTools = () => {
      throw new SiteAdapterError('grant', 'locked')
    }
    expect(() => running.refresh()).toThrow(new SiteAdapterError('grant', 'locked'))
  })

  it('closes the least recently used session beyond the limit', async () => {
    const running = await start(new FakeCaller([searchProducts]), { maxSessions: 2 })
    const oldest = await connectClient(running.url, 'oldest')
    const middle = await connectClient(running.url, 'middle')
    await oldest.listTools()
    await connectClient(running.url, 'newest')

    await expect(middle.listTools()).rejects.toThrow()
    await expect(oldest.listTools()).resolves.toBeDefined()
  })

  it('listens on the port it was given', async () => {
    const first = await start(new FakeCaller([searchProducts]))
    const { port } = first
    await first.close()
    const second = await start(new FakeCaller([searchProducts]), { port })
    expect(second.port).toBe(port)
  })

  it('fails with a fixed error, rather than moving, when the port it was given is taken', async () => {
    const holder = await start(new FakeCaller([searchProducts]))
    await expect(
      startHttpServer({ caller: new FakeCaller([searchProducts]), token: TOKEN, port: holder.port }),
    ).rejects.toEqual(new SiteAdapterError('config', 'unavailable'))
  })

  it('stops accepting connections once closed', async () => {
    const running = await startHttpServer({ caller: new FakeCaller([searchProducts]), token: TOKEN })
    await connectClient(running.url)
    await running.close()
    await expect(rawPost(running.port, {})).rejects.toThrow()
  })
})

describe('bearer token', () => {
  it('rejects a client with no token', async () => {
    const running = await start(new FakeCaller([searchProducts]))
    const response = await rawPost(running.port, { authorization: '' })
    expect(response.status).toBe(401)
    expect(response.headers['www-authenticate']).toBe('Bearer')
  })

  it('rejects a client with the wrong token', async () => {
    const running = await start(new FakeCaller([searchProducts]))
    await expect(connectClient(running.url, 'c', `${TOKEN.slice(0, -1)}R`)).rejects.toThrow(
      /401|Unauthorized/,
    )
  })

  it('rejects the token sent with another scheme', async () => {
    const running = await start(new FakeCaller([searchProducts]))
    const response = await rawPost(running.port, { authorization: `Basic ${TOKEN}` })
    expect(response.status).toBe(401)
  })

  it('rejects the token with trailing material', async () => {
    const running = await start(new FakeCaller([searchProducts]))
    const response = await rawPost(running.port, { authorization: `Bearer ${TOKEN} ${TOKEN}` })
    expect(response.status).toBe(401)
  })

  it('rejects the token in the query string', async () => {
    const running = await start(new FakeCaller([searchProducts]))
    const response = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: running.port,
          method: 'POST',
          path: `/mcp?token=${TOKEN}`,
          headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        },
        (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        },
      )
      req.on('error', reject)
      req.end(JSON.stringify(INITIALIZE))
    })
    expect(response).toBe(401)
  })

  it('checks the token on every request, not only on initialize', async () => {
    const caller = new FakeCaller([searchProducts])
    const running = await start(caller)
    const init = await rawPost(running.port, {})
    const sessionId = init.headers['mcp-session-id'] as string

    const response = await rawPost(
      running.port,
      { 'mcp-session-id': sessionId, authorization: 'Bearer nope' },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'woolworths_search_products', arguments: { query: 'x' } },
      },
    )

    expect(response.status).toBe(401)
    expect(caller.calls).toEqual([])
  })

  it('accepts the scheme in any case', async () => {
    const running = await start(new FakeCaller([searchProducts]))
    const response = await rawPost(running.port, { authorization: `bearer ${TOKEN}` })
    expect(response.status).toBe(200)
  })
})

describe('setToken', () => {
  const OTHER = 'zyxwvutsrqponmlkjihgfedcbaZYXWVUTSRQPONMLKJ'

  it('accepts only the new token from then on', async () => {
    const running = await start(new FakeCaller([searchProducts]))
    await running.setToken(OTHER)
    expect((await rawPost(running.port, {})).status).toBe(401)
    expect((await rawPost(running.port, { authorization: `Bearer ${OTHER}` })).status).toBe(200)
  })

  it('closes every session, so none opened with the old token carries on', async () => {
    const caller = new FakeCaller([searchProducts])
    const running = await start(caller)
    const init = await rawPost(running.port, {})
    const sessionId = init.headers['mcp-session-id'] as string

    await running.setToken(OTHER)
    const response = await rawPost(
      running.port,
      { 'mcp-session-id': sessionId, authorization: `Bearer ${OTHER}` },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'woolworths_search_products', arguments: { query: 'x' } },
      },
    )

    expect(response.status).toBe(404)
    expect(caller.calls).toEqual([])
  })

  it('refuses a malformed token and keeps the old one', async () => {
    const running = await start(new FakeCaller([searchProducts]))
    for (const token of ['', 'short', `${OTHER} `]) {
      await expect(running.setToken(token)).rejects.toEqual(new SiteAdapterError('config', 'invalid'))
    }
    expect((await rawPost(running.port, {})).status).toBe(200)
  })
})

describe('DNS rebinding protection', () => {
  it('accepts Host 127.0.0.1:<port>', async () => {
    const running = await start(new FakeCaller([searchProducts]))
    expect((await rawPost(running.port, { host: `127.0.0.1:${running.port}` })).status).toBe(200)
  })

  it('refuses Host localhost:<port>, so a client is never left registered with that URL', async () => {
    const running = await start(new FakeCaller([searchProducts]))
    expect((await rawPost(running.port, { host: `localhost:${running.port}` })).status).toBe(403)
  })

  it('rejects a rebound hostname even with the right token', async () => {
    const running = await start(new FakeCaller([searchProducts]))
    const response = await rawPost(running.port, { host: `attacker.example:${running.port}` })
    expect(response.status).toBe(403)
  })

  it('rejects a loopback Host on another port', async () => {
    const running = await start(new FakeCaller([searchProducts]))
    const response = await rawPost(running.port, { host: `127.0.0.1:${running.port + 1}` })
    expect(response.status).toBe(403)
  })

  it('rejects a cross-site Origin even with the right token and Host', async () => {
    const running = await start(new FakeCaller([searchProducts]))
    const response = await rawPost(running.port, { origin: 'https://attacker.example' })
    expect(response.status).toBe(403)
  })

  it('rejects the opaque "null" Origin of sandboxed frames', async () => {
    const running = await start(new FakeCaller([searchProducts]))
    const response = await rawPost(running.port, { origin: 'null' })
    expect(response.status).toBe(403)
  })

  it('accepts a localhost Origin', async () => {
    const running = await start(new FakeCaller([searchProducts]))
    const response = await rawPost(running.port, { origin: 'http://localhost:5173' })
    expect(response.status).toBe(200)
  })

  it('checks Host and Origin before the token, so a page learns nothing from the status', async () => {
    const running = await start(new FakeCaller([searchProducts]))
    const response = await rawPost(running.port, { origin: 'https://attacker.example', authorization: '' })
    expect(response.status).toBe(403)
  })
})

describe('routing', () => {
  it('answers 404 off the /mcp path', async () => {
    const running = await start(new FakeCaller([searchProducts]))
    const response = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: running.port,
          method: 'GET',
          path: '/',
          headers: { authorization: `Bearer ${TOKEN}` },
        },
        (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        },
      )
      req.on('error', reject)
      req.end()
    })
    expect(response).toBe(404)
  })

  it('answers 404 for an unknown session id', async () => {
    const running = await start(new FakeCaller([searchProducts]))
    const response = await rawPost(running.port, { 'mcp-session-id': 'made-up' })
    expect(response.status).toBe(404)
  })

  it('answers 400 for a GET with no session', async () => {
    const running = await start(new FakeCaller([searchProducts]))
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: running.port,
          method: 'GET',
          path: '/mcp',
          headers: { authorization: `Bearer ${TOKEN}`, accept: 'text/event-stream' },
        },
        (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        },
      )
      req.on('error', reject)
      req.end()
    })
    expect(status).toBe(400)
  })

  it('opens no session for a first request that is not initialize', async () => {
    const caller = new FakeCaller([searchProducts])
    const running = await start(caller)
    const response = await rawPost(
      running.port,
      {},
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'woolworths_search_products', arguments: { query: 'x' } },
      },
    )
    expect(response.status).toBe(400)
    expect(response.headers['mcp-session-id']).toBeUndefined()
    expect(caller.calls).toEqual([])
  })

  it('refuses a body over the size limit', async () => {
    const running = await start(new FakeCaller([searchProducts]))
    const response = await rawPost(running.port, {}, { ...INITIALIZE, padding: 'x'.repeat(2 * 1024 * 1024) })
    expect(response.status).toBe(413)
  })

  it('answers 500 without detail when the runtime throws', async () => {
    const caller = new FakeCaller([searchProducts])
    caller.listTools = () => {
      throw new Error('internal detail: hunter2')
    }
    const running = await start(caller)
    const response = await rawPost(running.port, {})
    expect(response.status).toBe(500)
    expect(response.body).not.toContain('hunter2')
    expect(JSON.parse(response.body).error.message).toBe('Internal error')
  })
})

describe('hostAllowed', () => {
  it('requires 127.0.0.1 and the exact port', () => {
    expect(hostAllowed('127.0.0.1:8080', 8080)).toBe(true)
    expect(hostAllowed('localhost:8080', 8080)).toBe(false)
    expect(hostAllowed('LOCALHOST:8080', 8080)).toBe(false)
    expect(hostAllowed('127.0.0.1', 8080)).toBe(false)
    expect(hostAllowed('127.0.0.1:80800', 8080)).toBe(false)
    expect(hostAllowed('localhost.attacker.example:8080', 8080)).toBe(false)
    expect(hostAllowed('127.0.0.1.nip.io:8080', 8080)).toBe(false)
    expect(hostAllowed('[::1]:8080', 8080)).toBe(false)
    expect(hostAllowed(undefined, 8080)).toBe(false)
  })
})

describe('originAllowed', () => {
  it('allows no Origin, for clients that are not browsers', () => {
    expect(originAllowed(undefined)).toBe(true)
  })

  it('allows localhost origins on any port', () => {
    expect(originAllowed('http://localhost:3000')).toBe(true)
    expect(originAllowed('http://127.0.0.1:9')).toBe(true)
    expect(originAllowed('https://localhost')).toBe(true)
    expect(originAllowed('http://[::1]:3000')).toBe(true)
  })

  it('refuses everything else', () => {
    expect(originAllowed('null')).toBe(false)
    expect(originAllowed('')).toBe(false)
    expect(originAllowed('https://attacker.example')).toBe(false)
    expect(originAllowed('http://localhost.attacker.example')).toBe(false)
    expect(originAllowed('http://127.0.0.1.nip.io')).toBe(false)
    expect(originAllowed('file://')).toBe(false)
    expect(originAllowed('chrome-extension://abcdef')).toBe(false)
    expect(originAllowed('http://localhost:3000/path')).toBe(false)
    expect(originAllowed('http://user@localhost:3000')).toBe(false)
  })
})

describe('bearerAuthorized', () => {
  it('accepts exactly Bearer <token>', () => {
    expect(bearerAuthorized(`Bearer ${TOKEN}`, TOKEN)).toBe(true)
  })

  it('refuses a missing, empty or malformed header', () => {
    expect(bearerAuthorized(undefined, TOKEN)).toBe(false)
    expect(bearerAuthorized('', TOKEN)).toBe(false)
    expect(bearerAuthorized('Bearer', TOKEN)).toBe(false)
    expect(bearerAuthorized('Bearer ', TOKEN)).toBe(false)
    expect(bearerAuthorized(TOKEN, TOKEN)).toBe(false)
    expect(bearerAuthorized(` Bearer ${TOKEN}`, TOKEN)).toBe(false)
  })

  it('never authorises against an empty expected token', () => {
    expect(bearerAuthorized('Bearer ', '')).toBe(false)
    expect(bearerAuthorized('', '')).toBe(false)
  })
})
