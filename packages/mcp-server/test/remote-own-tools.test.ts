// Valet's own tools for cloud agents (docs/authoring-tools.md, "Who can author"): the remote
// listener gives a cloud agent's session the admin and authoring tools only when the app's
// predicate says the person signed them for that agent, and reopens a session to change it.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { ToolDeclaration } from '@valet/core'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { AdminReader } from '../src/admin-tools'
import type { ClientIdentity } from '../src/auth'
import type { Authoring } from '../src/authoring-tools'
import { startRemoteListener } from '../src/remote'
import { RemoteAccessTokens } from '../src/remote-auth'
import type { RemotePolicy } from '../src/remote-policy'
import type { ListedTool } from '../src/tool-caller'
import { FakeCaller } from './fake-caller'
import { tunnelFetch } from './tunnel-fetch'

const HOST = 'mac.example-tailnet.ts.net'
const RESOURCE = `https://${HOST}/mcp`

const viewCart: ListedTool = {
  adapterId: 'woolworths',
  adapterName: 'Woolworths',
  declaration: { name: 'view_cart', title: 'View cart', description: 'View the cart.', sideEffect: 'read' },
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
}

const allowAll: RemotePolicy = { allows: (_a: string, _d: ToolDeclaration) => true }

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

function reader(viewers: ClientIdentity[]): AdminReader {
  return {
    access: (viewer) => {
      viewers.push(viewer)
      return { seeValet: true, allActivity: false, askForChanges: true, name: 'claude.ai' }
    },
    lockedDown: () => false,
    sensitive: () => false,
    status: async () => {
      throw new Error('unused')
    },
    adapters: async () => ({ adapters: [] }),
    adapter: async () => ({ adapter: null }),
    health: async () => ({ sites: [] }),
    needsYou: async () => ({ items: [] }),
    calls: async () => ({ calls: [] }),
    call: async () => ({ call: null, matches: [] }) as never,
    audit: async () => ({ records: [], total: 0, nextBeforeSeq: null, chain: null }) as never,
  }
}

async function setup(allowed: Set<string>, withPredicate = true) {
  const viewers: ClientIdentity[] = []
  const listed: ClientIdentity[] = []
  const authoring = {
    listDrafts: async (viewer: ClientIdentity) => {
      listed.push(viewer)
      return { drafts: [] }
    },
  } as unknown as Authoring
  const tokens = new RemoteAccessTokens()
  const caller = new FakeCaller([viewCart])
  const listener = await startRemoteListener({
    caller,
    policy: allowAll,
    tokens,
    hosts: () => new Set([HOST]),
    refused: async () => {},
    admin: reader(viewers),
    authoring,
    ...(withPredicate ? { ownTools: (clientId: string) => allowed.has(clientId) } : {}),
  })
  cleanup.push(() => listener.close())
  return { listener, tokens, viewers, listed }
}

async function connect(port: number, token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`http://${HOST}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: tunnelFetch(port, HOST),
  })
  const client = new Client({ name: 'claude.ai', version: '1.0.0' })
  await client.connect(transport)
  cleanup.push(() => client.close())
  return client
}

const names = async (client: Client) => (await client.listTools()).tools.map((t) => t.name)

describe('Valet’s own tools for cloud agents', () => {
  it('gives them only to an agent the predicate allows, beside its site tools', async () => {
    const { listener, tokens } = await setup(new Set(['phone']))
    const phone = await names(await connect(listener.port, tokens.issue('phone', RESOURCE)))
    const laptop = await names(await connect(listener.port, tokens.issue('laptop', RESOURCE)))

    expect(phone).toContain('valet_status')
    expect(phone).toContain('valet_create_draft')
    expect(phone).toContain('woolworths_view_cart')
    expect(laptop).toEqual(['woolworths_view_cart'])
  })

  it('gives them to no cloud agent without the predicate, even with the readers passed', async () => {
    const { listener, tokens } = await setup(new Set(['phone']), false)
    expect(await names(await connect(listener.port, tokens.issue('phone', RESOURCE)))).toEqual([
      'woolworths_view_cart',
    ])
  })

  it('runs an authoring tool as the cloud agent, by its remote identity', async () => {
    const { listener, tokens, viewers, listed } = await setup(new Set(['phone']))
    const client = await connect(listener.port, tokens.issue('phone', RESOURCE))
    const result = await client.callTool({ name: 'valet_list_drafts', arguments: {} })
    expect(result.isError).not.toBe(true)
    expect(viewers).toContainEqual({ origin: 'remote', clientId: 'phone' })
    expect(listed).toEqual([{ origin: 'remote', clientId: 'phone' }])
  })

  it('reopens one agent’s sessions, keeping its token, so its next session has what it may have now', async () => {
    const allowed = new Set<string>()
    const { listener, tokens } = await setup(allowed)
    const token = tokens.issue('phone', RESOURCE)
    expect(await names(await connect(listener.port, token))).toEqual(['woolworths_view_cart'])
    await connect(listener.port, tokens.issue('laptop', RESOURCE))

    allowed.add('phone')
    await listener.reopenClient('phone')

    expect(listener.sessions().sessions.map((s) => s.identity.clientId)).toEqual(['laptop'])
    expect(tokens.identify(token, RESOURCE)).not.toBeNull()
    expect(await names(await connect(listener.port, token))).toContain('valet_create_draft')
  })
})
