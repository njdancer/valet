import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SiteAdapterError } from '@siteadapter/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { readBridgeConfig, writeBridgeConfig } from '../src/bridge-config'
import { type RunningEndpoint, startEndpoint } from '../src/endpoint'
import { type HttpServerOptions, type RunningHttpServer, startHttpServer } from '../src/http'
import { writePrivateFile } from '../src/private-file'
import type { ListedTool } from '../src/tool-caller'
import { FakeCaller } from './fake-caller'

const TOKEN_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const TOKEN_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const TOKEN_C = 'ccccccccccccccccccccccccccccccccccccccccccc'

const viewCart: ListedTool = {
  adapterId: 'woolworths',
  adapterName: 'Woolworths',
  declaration: { name: 'view_cart', title: 'View cart', description: 'Reads the cart.', sideEffect: 'read' },
  input: z.object({}),
  output: z.object({ items: z.number() }),
}

let dir: string
let configPath: string
const cleanup: Array<() => Promise<void>> = []

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'siteadapter-endpoint-'))
  configPath = join(dir, 'bridge.json')
})

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
  await chmod(dir, 0o700)
  await rm(dir, { recursive: true, force: true })
})

/** Hands out the given tokens in order, so each test knows which one a launch should use. */
function tokens(...values: string[]): () => string {
  return () => {
    const next = values.shift()
    if (next === undefined) throw new Error('no more tokens')
    return next
  }
}

async function launch(
  options: Partial<Parameters<typeof startEndpoint>[0]> & { generateToken: () => string },
): Promise<RunningEndpoint> {
  const endpoint = await startEndpoint({ caller: new FakeCaller([viewCart]), configPath, ...options })
  cleanup.push(() => endpoint.close())
  return endpoint
}

/** Records the port each start asks for and starts a real server. */
function recordingStart(): {
  start: (options: HttpServerOptions) => Promise<RunningHttpServer>
  ports: (number | undefined)[]
} {
  const ports: (number | undefined)[] = []
  return {
    ports,
    start: async (options) => {
      ports.push(options.port)
      return startHttpServer(options)
    },
  }
}

/** The HTTP status of an initialize request presenting `token`. */
async function statusWith(url: string, token: string): Promise<number> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } },
    }),
  })
  await response.body?.cancel()
  return response.status
}

async function occupy(port: number): Promise<Server> {
  const squatter = createServer()
  await new Promise<void>((resolve) => squatter.listen({ port, host: '127.0.0.1' }, resolve))
  cleanup.push(() => new Promise((resolve) => squatter.close(() => resolve())))
  return squatter
}

describe('startEndpoint', () => {
  it('on first launch picks a free port and a new token, and writes them to the config file', async () => {
    const endpoint = await launch({ generateToken: tokens(TOKEN_A) })
    expect(endpoint.port).toBeGreaterThan(0)
    expect(endpoint.token).toBe(TOKEN_A)
    expect(await readBridgeConfig(configPath)).toEqual({ url: endpoint.url, token: TOKEN_A })
    expect((await stat(configPath)).mode & 0o777).toBe(0o600)
    expect(await statusWith(endpoint.url, TOKEN_A)).toBe(200)
  })

  it('by default keeps the port from the last launch and makes a new token', async () => {
    const first = await launch({ generateToken: tokens(TOKEN_A) })
    const { port, url } = first
    await first.close()
    const { start, ports } = recordingStart()

    const second = await launch({ generateToken: tokens(TOKEN_B), start })

    expect(ports).toEqual([port])
    expect(second.port).toBe(port)
    expect(second.url).toBe(url)
    expect(second.token).toBe(TOKEN_B)
    expect(await statusWith(url, TOKEN_B)).toBe(200)
    expect(await readBridgeConfig(configPath)).toEqual({ url, token: TOKEN_B })
  })

  it('by default, a token a squatter collected while the app was down is dead after the next launch', async () => {
    const first = await launch({ generateToken: tokens(TOKEN_A) })
    const { port } = first
    await first.close()
    // Another local account listens on the saved port while the app is down, and a client (the
    // bridge, reconnecting) hands it TOKEN_A. Then it lets the port go, so the app gets it back.
    const squatter = await occupy(port)
    await new Promise<void>((resolve) => squatter.close(() => resolve()))

    const second = await launch({ generateToken: tokens(TOKEN_B) })

    expect(second.port).toBe(port)
    expect(await statusWith(second.url, TOKEN_A)).toBe(401)
    expect(await statusWith(second.url, TOKEN_B)).toBe(200)
  })

  it("keeps the last launch's token when asked to, on the same port", async () => {
    const first = await launch({ tokenRotation: 'on-reset', generateToken: tokens(TOKEN_A) })
    const { port, url } = first
    await first.close()

    const second = await launch({ tokenRotation: 'on-reset', generateToken: tokens(TOKEN_B) })

    expect(second.port).toBe(port)
    expect(second.url).toBe(url)
    expect(second.token).toBe(TOKEN_A)
    expect(await statusWith(url, TOKEN_A)).toBe(200)
  })

  it('asks for any free port when the port is not to be kept', async () => {
    const first = await launch({ generateToken: tokens(TOKEN_A) })
    await first.close()
    const { start, ports } = recordingStart()

    const endpoint = await launch({
      stablePort: false,
      tokenRotation: 'on-reset',
      generateToken: tokens(TOKEN_B),
      start,
    })

    expect(ports).toEqual([0])
    expect(endpoint.token).toBe(TOKEN_A)
  })

  it('moves to a free port with a new token when something else holds the saved one', async () => {
    // Even when tokens are kept until reset: the kept one may already be in the squatter's hands.
    const first = await launch({ tokenRotation: 'on-reset', generateToken: tokens(TOKEN_A) })
    const { port } = first
    await first.close()
    await occupy(port)

    const second = await launch({ tokenRotation: 'on-reset', generateToken: tokens(TOKEN_B) })

    expect(second.port).not.toBe(port)
    // Clients still pointed at the old port hand the squatter TOKEN_A; it must not open the endpoint.
    expect(second.token).toBe(TOKEN_B)
    expect(await statusWith(second.url, TOKEN_A)).toBe(401)
    expect(await readBridgeConfig(configPath)).toEqual({ url: second.url, token: TOKEN_B })
  })

  it('does not reuse a token from a config file others could read', async () => {
    await writeBridgeConfig(configPath, { url: 'http://127.0.0.1:52011/mcp', token: TOKEN_A })
    await chmod(configPath, 0o644)

    const endpoint = await launch({ tokenRotation: 'on-reset', generateToken: tokens(TOKEN_B) })

    expect(endpoint.token).toBe(TOKEN_B)
    expect(await statusWith(endpoint.url, TOKEN_A)).toBe(401)
    expect((await stat(configPath)).mode & 0o777).toBe(0o600)
    expect(await readBridgeConfig(configPath)).toEqual({ url: endpoint.url, token: TOKEN_B })
  })

  it('does not reuse a token or port from a config file edited to point elsewhere', async () => {
    await writePrivateFile(
      configPath,
      JSON.stringify({ url: 'http://attacker.example:80/mcp', token: TOKEN_A }),
    )
    const { start, ports } = recordingStart()

    const endpoint = await launch({ tokenRotation: 'on-reset', generateToken: tokens(TOKEN_B), start })

    expect(ports).toEqual([0])
    expect(endpoint.token).toBe(TOKEN_B)
    expect(await readBridgeConfig(configPath)).toEqual({ url: endpoint.url, token: TOKEN_B })
  })

  it('fails, leaving nothing listening, when the config file cannot be written', async () => {
    await chmod(dir, 0o500)
    let started: RunningHttpServer | undefined
    const start = async (options: HttpServerOptions): Promise<RunningHttpServer> => {
      started = await startHttpServer(options)
      return started
    }

    await expect(
      startEndpoint({ caller: new FakeCaller([]), configPath, generateToken: tokens(TOKEN_A), start }),
    ).rejects.toEqual(new SiteAdapterError('config', 'unavailable'))

    expect(started).toBeDefined()
    await expect(fetch(started?.url ?? '')).rejects.toThrow()
  })

  it('passes on a failure to start on a free port', async () => {
    const start = async (): Promise<RunningHttpServer> => {
      throw new SiteAdapterError('config', 'unavailable')
    }
    await expect(
      startEndpoint({ caller: new FakeCaller([]), configPath, generateToken: tokens(TOKEN_A), start }),
    ).rejects.toEqual(new SiteAdapterError('config', 'unavailable'))
  })

  it('refreshes the tools of its server', async () => {
    const caller = new FakeCaller([viewCart])
    const endpoint = await startEndpoint({ caller, configPath, generateToken: tokens(TOKEN_A) })
    cleanup.push(() => endpoint.close())
    caller.tools = [{ ...viewCart, input: z.string() as never }]
    expect(endpoint.refresh()).toEqual([
      { adapterId: 'woolworths', tool: 'view_cart', reason: 'input-not-object' },
    ])
  })
})

describe('resetToken', () => {
  it('switches to a new token, refuses the old one and writes the new one for the bridge', async () => {
    const endpoint = await launch({ generateToken: tokens(TOKEN_A, TOKEN_B) })

    await endpoint.resetToken()

    expect(endpoint.token).toBe(TOKEN_B)
    expect(await statusWith(endpoint.url, TOKEN_A)).toBe(401)
    expect(await statusWith(endpoint.url, TOKEN_B)).toBe(200)
    expect(await readBridgeConfig(configPath)).toEqual({ url: endpoint.url, token: TOKEN_B })
  })

  it('keeps the new token across the next launch when tokens are kept until reset', async () => {
    const first = await launch({ tokenRotation: 'on-reset', generateToken: tokens(TOKEN_A, TOKEN_B) })
    await first.resetToken()
    await first.close()

    const second = await launch({ tokenRotation: 'on-reset', generateToken: tokens(TOKEN_C) })

    expect(second.token).toBe(TOKEN_B)
  })

  it('leaves the file and the endpoint on the same token when resets overlap', async () => {
    const endpoint = await launch({ generateToken: tokens(TOKEN_A, TOKEN_B, TOKEN_C) })

    await Promise.all([endpoint.resetToken(), endpoint.resetToken()])

    expect(endpoint.token).toBe(TOKEN_C)
    expect(await readBridgeConfig(configPath)).toEqual({ url: endpoint.url, token: TOKEN_C })
    expect(await statusWith(endpoint.url, TOKEN_B)).toBe(401)
    expect(await statusWith(endpoint.url, TOKEN_C)).toBe(200)
  })

  it('resets again after a reset that failed', async () => {
    const endpoint = await launch({ generateToken: tokens(TOKEN_A, TOKEN_B, TOKEN_C) })
    await chmod(dir, 0o500)
    await expect(endpoint.resetToken()).rejects.toEqual(new SiteAdapterError('config', 'unavailable'))
    await chmod(dir, 0o700)

    await endpoint.resetToken()

    expect(endpoint.token).toBe(TOKEN_C)
    expect(await readBridgeConfig(configPath)).toEqual({ url: endpoint.url, token: TOKEN_C })
  })

  it('changes nothing when the config file cannot be written', async () => {
    const endpoint = await launch({ generateToken: tokens(TOKEN_A, TOKEN_B) })
    const before = await readFile(configPath, 'utf8')
    await chmod(dir, 0o500)

    await expect(endpoint.resetToken()).rejects.toEqual(new SiteAdapterError('config', 'unavailable'))

    expect(endpoint.token).toBe(TOKEN_A)
    expect(await statusWith(endpoint.url, TOKEN_A)).toBe(200)
    expect(await readFile(configPath, 'utf8')).toBe(before)
  })
})
