// What every stdio bridge must do, run against a real bridge process: the TypeScript one
// (bridge-cli.ts under tsx) and the Swift one the app bundles (D60). Each test starts a real endpoint
// with one client, launches the bridge on that client's config file, and speaks MCP to it over
// stdio as a client would.

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { readBridgeConfig, writeBridgeConfig } from '../src/bridge-config'
import { type SessionReportingEndpoint, startEndpoint } from '../src/endpoint'
import { writePrivateFile } from '../src/private-file'
import type { ListedTool } from '../src/tool-caller'
import { FakeCaller } from './fake-caller'

/** How to launch a bridge on a config file. */
export type BridgeLauncher = (configPath: string) => { readonly command: string; readonly args: string[] }

const viewCart: ListedTool = {
  adapterId: 'woolworths',
  adapterName: 'Woolworths',
  declaration: { name: 'view_cart', title: 'View cart', description: 'Reads the cart.', sideEffect: 'read' },
  input: z.object({}),
  output: z.object({ items: z.number() }),
}

const CLIENT = 'contract-client'

export function bridgeContract(name: string, launch: BridgeLauncher): void {
  describe(`the ${name} stdio bridge`, () => {
    let dir: string
    let configPath: string
    const cleanup: Array<() => Promise<unknown>> = []

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'valet-contract-'))
      configPath = join(dir, `${CLIENT}.json`)
    })

    afterEach(async () => {
      for (const step of cleanup.splice(0).reverse()) await step().catch(() => undefined)
      await rm(dir, { recursive: true, force: true })
    })

    async function endpoint(caller: FakeCaller, stablePort = true): Promise<SessionReportingEndpoint> {
      const running = await startEndpoint({ caller, clients: [{ id: CLIENT, configPath }], stablePort })
      cleanup.push(() => running.close())
      return running
    }

    async function connect(clientName = 'contract'): Promise<Client> {
      const { command, args } = launch(configPath)
      const transport = new StdioClientTransport({ command, args, stderr: 'pipe' })
      const client = new Client({ name: clientName, version: '1.0.0' })
      await client.connect(transport)
      cleanup.push(() => client.close())
      return client
    }

    /** The bridge as a bare process, for what an MCP client library would hide. */
    function raw(args: string[]): {
      child: ChildProcessWithoutNullStreams
      stdout: () => string
      stderr: () => string
      exit: Promise<number | null>
    } {
      const { command, args: base } = launch(configPath)
      const child = spawn(command, [...base.slice(0, -1), ...args])
      let out = ''
      let err = ''
      child.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString('utf8')
      })
      child.stderr.on('data', (chunk: Buffer) => {
        err += chunk.toString('utf8')
      })
      const exit = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)))
      cleanup.push(async () => {
        child.kill()
        await exit
      })
      return { child, stdout: () => out, stderr: () => err, exit }
    }

    it('relays the client’s initialize, lists and calls tools, and labels its session', async () => {
      const caller = new FakeCaller([viewCart])
      caller.answer = async () => ({ status: 'ok', output: { items: 3 } })
      const running = await endpoint(caller)
      const client = await connect('Claude Code')

      expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['woolworths_view_cart'])
      const result = await client.callTool({ name: 'woolworths_view_cart', arguments: {} })
      expect(result.structuredContent).toEqual({ items: 3 })
      expect(caller.calls[0]).toMatchObject({
        client: 'Claude Code',
        transport: 'stdio-bridge',
        identity: { origin: 'local', clientId: CLIENT },
      })
      expect(running.sessions().sessions).toEqual([
        { identity: { origin: 'local', clientId: CLIENT }, transport: 'stdio-bridge', client: 'Claude Code' },
      ])
    })

    it('passes on the endpoint’s tools/list_changed', async () => {
      const caller = new FakeCaller([viewCart])
      const running = await endpoint(caller)
      const client = await connect()
      const changed = vi.fn()
      client.setNotificationHandler(ToolListChangedNotificationSchema, changed)
      await client.listTools()
      caller.tools = []
      running.refresh()
      await vi.waitFor(() => expect(changed).toHaveBeenCalled(), { timeout: 5000 })
      expect((await client.listTools()).tools).toEqual([])
    })

    it('follows "Reset access": the next call works with the new token, and the tool list is re-read', async () => {
      const caller = new FakeCaller([viewCart])
      caller.answer = async () => ({ status: 'ok', output: { items: 1 } })
      const running = await endpoint(caller)
      const client = await connect()
      const changed = vi.fn()
      client.setNotificationHandler(ToolListChangedNotificationSchema, changed)
      await client.callTool({ name: 'woolworths_view_cart', arguments: {} })

      const before = (await readBridgeConfig(configPath)).token
      await running.resetClient(CLIENT)
      expect((await readBridgeConfig(configPath)).token).not.toBe(before)

      const result = await client.callTool({ name: 'woolworths_view_cart', arguments: {} })
      expect(result.isError).toBeFalsy()
      expect(caller.calls).toHaveLength(2)
      await vi.waitFor(() => expect(changed).toHaveBeenCalled(), { timeout: 5000 })
      // The replayed initialize carried the client's own name.
      expect(running.sessions().sessions.map((s) => s.client)).toEqual(['contract'])
    })

    it('follows the app to a new port after a restart', async () => {
      const caller = new FakeCaller([viewCart])
      caller.answer = async () => ({ status: 'ok', output: { items: 2 } })
      const first = await endpoint(caller, false)
      const client = await connect()
      await client.listTools()
      await first.close()
      const second = await endpoint(caller, false)
      expect(second.port).not.toBe(first.port)

      const result = await client.callTool({ name: 'woolworths_view_cart', arguments: {} })
      expect(result.structuredContent).toEqual({ items: 2 })
      expect(second.sessions().total).toBe(1)
    })

    it('answers at once, with fixed text, when the app has gone away', async () => {
      const running = await endpoint(new FakeCaller([viewCart]))
      const client = await connect()
      await client.listTools()
      await running.close()

      const started = Date.now()
      await expect(client.callTool({ name: 'woolworths_view_cart', arguments: {} })).rejects.toThrow(
        /valet is not reachable; make sure the app is running/,
      )
      expect(Date.now() - started).toBeLessThan(5000)
    })

    it('answers a call in flight when the app quits under it, instead of leaving the client waiting', async () => {
      const caller = new FakeCaller([viewCart])
      let entered: () => void = () => {}
      const inside = new Promise<void>((resolve) => {
        entered = resolve
      })
      caller.answer = () => {
        entered()
        return new Promise(() => {})
      }
      const running = await endpoint(caller)
      const client = await connect()
      const call = client.callTool({ name: 'woolworths_view_cart', arguments: {} })
      await inside
      await running.close()
      await expect(call).rejects.toThrow(/the Valet session ended before this request was answered/)
    })

    it('writes nothing but JSON-RPC to stdout', async () => {
      await endpoint(new FakeCaller([viewCart]))
      const bridge = raw([configPath])
      bridge.child.stdin.write('not json\n')
      bridge.child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 7,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'raw', version: '1' },
          },
        })}\n`,
      )
      await vi.waitFor(() => expect(bridge.stdout()).toContain('\n'), { timeout: 5000 })
      bridge.child.stdin.end()
      expect(await bridge.exit).toBe(0)
      const lines = bridge
        .stdout()
        .split('\n')
        .filter((line) => line !== '')
      expect(lines).toHaveLength(1)
      expect(JSON.parse(lines[0] as string)).toMatchObject({ jsonrpc: '2.0', id: 7, result: {} })
    })

    it('refuses a config file others could read, saying so on stderr only', async () => {
      await writeBridgeConfig(configPath, { url: 'http://127.0.0.1:52011/mcp', token: 'a'.repeat(43) })
      await chmod(configPath, 0o644)
      const bridge = raw([configPath])
      expect(await bridge.exit).toBe(1)
      expect(bridge.stdout()).toBe('')
      expect(bridge.stderr()).toContain('the config file must be a regular file owned by you with mode 0600')
    })

    it('refuses a config file that would send the token elsewhere', async () => {
      await writePrivateFile(
        configPath,
        JSON.stringify({ url: 'http://localhost:52011/mcp', token: 'a'.repeat(43) }),
      )
      const bridge = raw([configPath])
      expect(await bridge.exit).toBe(1)
      expect(bridge.stdout()).toBe('')
      expect(bridge.stderr()).toContain('the config file must hold only the endpoint url')
    })

    it('says how to start the app when the config file is missing', async () => {
      const bridge = raw([join(dir, 'missing.json')])
      expect(await bridge.exit).toBe(1)
      expect(bridge.stderr()).toContain('the config file does not exist; start Valet to write it')
    })

    it('prints its usage for anything but one argument', async () => {
      const bridge = raw([])
      expect(await bridge.exit).toBe(2)
      expect(bridge.stderr()).toBe('usage: valet-bridge <config file>\n')
    })
  })
}
