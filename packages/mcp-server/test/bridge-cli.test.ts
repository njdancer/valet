import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { SiteAdapterError } from '@siteadapter/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { main, USAGE } from '../src/bridge-cli'
import { isLoopbackEndpoint, readBridgeConfig, writeBridgeConfig } from '../src/bridge-config'
import { startHttpServer } from '../src/http'
import { writePrivateFile } from '../src/private-file'
import type { ListedTool } from '../src/tool-caller'
import { FakeCaller } from './fake-caller'

const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ'
const URL_ = 'http://127.0.0.1:52011/mcp'

const viewCart: ListedTool = {
  adapterId: 'woolworths',
  adapterName: 'Woolworths',
  declaration: { name: 'view_cart', title: 'View cart', description: 'Reads the cart.', sideEffect: 'read' },
  input: z.object({}),
  output: z.object({ items: z.number() }),
}

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'siteadapter-bridge-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function collect(stream: PassThrough): () => string {
  let text = ''
  stream.on('data', (chunk: Buffer) => {
    text += chunk.toString('utf8')
  })
  return () => text
}

describe('isLoopbackEndpoint', () => {
  it('accepts the loopback /mcp URL the server reports', () => {
    expect(isLoopbackEndpoint('http://127.0.0.1:52011/mcp')).toBe(true)
  })

  it('refuses localhost, which Node resolves to ::1 where the endpoint is not listening', () => {
    expect(isLoopbackEndpoint('http://localhost:52011/mcp')).toBe(false)
    expect(isLoopbackEndpoint('http://LOCALHOST:52011/mcp')).toBe(false)
    expect(isLoopbackEndpoint('http://[::1]:52011/mcp')).toBe(false)
  })

  it('refuses any URL that could send the token off the machine or elsewhere', () => {
    expect(isLoopbackEndpoint('http://attacker.example:52011/mcp')).toBe(false)
    expect(isLoopbackEndpoint('https://127.0.0.1:52011/mcp')).toBe(false)
    expect(isLoopbackEndpoint('http://127.0.0.1.nip.io:52011/mcp')).toBe(false)
    expect(isLoopbackEndpoint('http://user:pass@127.0.0.1:52011/mcp')).toBe(false)
    expect(isLoopbackEndpoint('http://127.0.0.1/mcp')).toBe(false)
    expect(isLoopbackEndpoint('http://127.0.0.1:52011/other')).toBe(false)
    expect(isLoopbackEndpoint('http://127.0.0.1:52011/mcp?x=1')).toBe(false)
    expect(isLoopbackEndpoint('http://127.0.0.1:52011/mcp#x')).toBe(false)
    expect(isLoopbackEndpoint('not a url')).toBe(false)
  })
})

describe('writeBridgeConfig and readBridgeConfig', () => {
  it('round-trips through a 0600 JSON file', async () => {
    const path = join(dir, 'bridge.json')
    await writeBridgeConfig(path, { url: URL_, token: TOKEN })
    expect(await readBridgeConfig(path)).toEqual({ url: URL_, token: TOKEN })
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ url: URL_, token: TOKEN })
  })

  it('refuses to write a non-loopback URL or a malformed token', async () => {
    const path = join(dir, 'bridge.json')
    const invalid = new SiteAdapterError('credential', 'invalid')
    await expect(writeBridgeConfig(path, { url: 'http://example.com:1/mcp', token: TOKEN })).rejects.toEqual(
      invalid,
    )
    await expect(writeBridgeConfig(path, { url: URL_, token: '' })).rejects.toEqual(invalid)
  })

  it('refuses a config someone edited to point the token elsewhere', async () => {
    const path = join(dir, 'bridge.json')
    await writePrivateFile(path, JSON.stringify({ url: 'http://attacker.example:80/mcp', token: TOKEN }))
    await expect(readBridgeConfig(path)).rejects.toEqual(new SiteAdapterError('credential', 'invalid'))
  })

  it('refuses a config whose URL says localhost, which another account could answer on ::1', async () => {
    const path = join(dir, 'bridge.json')
    await writePrivateFile(path, JSON.stringify({ url: 'http://localhost:52011/mcp', token: TOKEN }))
    await expect(readBridgeConfig(path)).rejects.toEqual(new SiteAdapterError('credential', 'invalid'))
    await expect(
      writeBridgeConfig(path, { url: 'http://localhost:52011/mcp', token: TOKEN }),
    ).rejects.toEqual(new SiteAdapterError('credential', 'invalid'))
  })

  it('refuses a config readable by other accounts', async () => {
    const path = join(dir, 'bridge.json')
    await writeBridgeConfig(path, { url: URL_, token: TOKEN })
    await chmod(path, 0o644)
    await expect(readBridgeConfig(path)).rejects.toEqual(new SiteAdapterError('credential', 'invalid'))
  })

  it('refuses a config that is not JSON or has extra keys', async () => {
    const path = join(dir, 'bridge.json')
    await writePrivateFile(path, 'url=x')
    await expect(readBridgeConfig(path)).rejects.toEqual(new SiteAdapterError('credential', 'invalid'))
    await writePrivateFile(path, JSON.stringify({ url: URL_, token: TOKEN, extra: true }))
    await expect(readBridgeConfig(path)).rejects.toEqual(new SiteAdapterError('credential', 'invalid'))
  })
})

describe('main', () => {
  it('prints usage and exits 2 without exactly one argument', async () => {
    for (const args of [[], ['a', 'b']]) {
      const errors = new PassThrough()
      const written = collect(errors)
      const code = await main(args, { input: new PassThrough(), output: new PassThrough(), errors })
      expect(code).toBe(2)
      expect(written()).toBe(USAGE)
    }
  })

  it('exits 1 with a plain explanation when the config is missing', async () => {
    const errors = new PassThrough()
    const output = new PassThrough()
    const written = collect(errors)
    const stdout = collect(output)

    const code = await main([join(dir, 'missing.json')], { input: new PassThrough(), output, errors })

    expect(code).toBe(1)
    expect(written()).toBe('siteadapter-bridge: the config file does not exist or cannot be opened\n')
    expect(stdout()).toBe('')
  })

  it('exits 1 without echoing the file when the config is invalid', async () => {
    const path = join(dir, 'bridge.json')
    await writePrivateFile(path, JSON.stringify({ url: URL_, token: 'secret-looking-value' }))
    const errors = new PassThrough()
    const written = collect(errors)

    const code = await main([path], { input: new PassThrough(), output: new PassThrough(), errors })

    expect(code).toBe(1)
    expect(written()).not.toContain('secret-looking-value')
    expect(written()).toContain('mode 0600')
  })

  it('re-reads the config file when the bridge reconnects', async () => {
    const path = join(dir, 'bridge.json')
    await writeBridgeConfig(path, { url: URL_, token: TOKEN })
    let reconnect: (() => Promise<unknown>) | undefined
    const code = await main([path], {
      input: new PassThrough(),
      output: new PassThrough(),
      errors: new PassThrough(),
      run: async (options) => {
        reconnect = options.reconnect
        return { done: Promise.resolve(), close: async () => {} }
      },
    })
    const restarted = 'http://127.0.0.1:52999/mcp'
    await writeBridgeConfig(path, { url: restarted, token: TOKEN })

    expect(code).toBe(0)
    expect(await reconnect?.()).toEqual({ url: restarted, token: TOKEN })
  })

  it('bridges a stdio client to a running endpoint until the client goes away', async () => {
    const caller = new FakeCaller([viewCart])
    caller.answer = async () => ({ status: 'ok', output: { items: 4 } })
    const server = await startHttpServer({ caller, token: TOKEN })
    try {
      const path = join(dir, 'bridge.json')
      await writeBridgeConfig(path, { url: server.url, token: TOKEN })
      const toBridge = new PassThrough()
      const fromBridge = new PassThrough()
      const errors = new PassThrough()
      const written = collect(errors)

      const exit = main([path], { input: toBridge, output: fromBridge, errors })
      const client = new Client({ name: 'cli-client', version: '1' })
      await client.connect(new StdioServerTransport(fromBridge, toBridge))
      const result = await client.callTool({ name: 'woolworths_view_cart', arguments: {} })
      toBridge.end()

      expect(result.structuredContent).toEqual({ items: 4 })
      expect(caller.calls[0]?.client).toBe('cli-client')
      expect(await exit).toBe(0)
      expect(written()).toBe('')
      await client.close()
    } finally {
      await server.close()
    }
  })
})

describe('the bridge command', () => {
  it('works as a process an MCP client launches, as Claude Code would', async () => {
    const caller = new FakeCaller([viewCart])
    caller.answer = async () => ({ status: 'ok', output: { items: 1 } })
    const server = await startHttpServer({ caller, token: TOKEN })
    const client = new Client({ name: 'spawning-client', version: '1' })
    try {
      const path = join(dir, 'bridge.json')
      await writeBridgeConfig(path, { url: server.url, token: TOKEN })
      const repoRoot = resolve(import.meta.dirname, '../../..')
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: ['--import', 'tsx', resolve(import.meta.dirname, '../src/bridge-cli.ts'), path],
          cwd: repoRoot,
          stderr: 'pipe',
        }),
      )

      const result = await client.callTool({ name: 'woolworths_view_cart', arguments: {} })

      expect(result.structuredContent).toEqual({ items: 1 })
      expect(caller.calls[0]?.client).toBe('spawning-client')
    } finally {
      await client.close()
      await server.close()
    }
  }, 20_000)
})
