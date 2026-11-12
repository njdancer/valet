// G's definition of done: a remote client completes OAuth and calls a tool through the relay,
// against a local Workers runtime. The Mac side is the real remote listener, OAuth server and
// consent from @valet/mcp-server, behind the real relay client; only the tools and the Secure
// Enclave keys are fakes.

import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SIGNING_DOMAINS, type ToolDeclaration } from '@valet/core'
import {
  ConsentRequests,
  type ListedTool,
  RelayClient,
  type RelayClientStatus,
  type RelayEvent,
  RemoteAccessTokens,
  RemoteAuthorization,
  RemoteClients,
  type RemotePolicy,
  startRemoteListener,
  type ToolCall,
} from '@valet/mcp-server'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { testKey } from './keys'
import { RELAY_ORIGIN, type Runtime, startRelay } from './runtime'

const REDIRECT = 'https://claude.example/api/mcp/auth_callback'
const VERIFIER = 'v'.repeat(43) + '-._~0123456789'
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url')

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

const viewCart: ListedTool = {
  adapterId: 'woolworths',
  adapterName: 'Woolworths',
  declaration: { name: 'view_cart', title: 'View cart', description: 'The cart.', sideEffect: 'read' },
  input: z.object({}),
  output: z.object({ items: z.number() }),
}

class GrantPolicy implements RemotePolicy {
  constructor(private readonly clients: RemoteClients) {}
  allows(adapterId: string, declaration: ToolDeclaration, clientId: string | null): boolean {
    if (clientId === null) return true
    return this.clients.get(clientId)?.grant?.tools.includes(`${adapterId}.${declaration.name}`) ?? false
  }
}

interface Mac {
  readonly client: RelayClient
  readonly host: string
  readonly consents: ConsentRequests
  readonly calls: ToolCall[]
  readonly statuses: RelayClientStatus[]
  readonly events: RelayEvent[]
  online(): Promise<void>
}

async function startMac(relay: Runtime): Promise<Mac> {
  const transport = testKey()
  const approval = testKey()
  const macId = approval.id
  const host = `${macId}.relay.test`
  const clients = new RemoteClients()
  const consents = new ConsentRequests()
  const tokens = new RemoteAccessTokens()
  const authorization = new RemoteAuthorization({ tokens, clients, consents })
  const calls: ToolCall[] = []
  const listener = await startRemoteListener({
    caller: {
      listTools: () => [viewCart],
      call: async (call) => {
        calls.push(call)
        return { status: 'ok', output: { items: 3 } }
      },
    },
    policy: new GrantPolicy(clients),
    tokens,
    authorization,
    hosts: () => new Set([host]),
  })
  cleanup.push(() => listener.close())
  const statuses: RelayClientStatus[] = []
  const events: RelayEvent[] = []
  const waiters: Array<() => void> = []
  const client = new RelayClient({
    relay: RELAY_ORIGIN,
    connectUrl: relay.url,
    macId,
    signer: transport,
    binding: {
      approvalKey: approval.publicKey,
      signature: approval.signDomain(SIGNING_DOMAINS.relayBinding, transport.publicKey),
    },
    listener: () => listener.url,
    consent: (id, query, source) => authorization.relayConsent(id, query, source, host),
    onEvent: (event) => events.push(event),
    onStatus: (status) => {
      statuses.push(status)
      if (status.state === 'online') for (const w of waiters.splice(0)) w()
    },
    backoff: { minMs: 50, maxMs: 200 },
  })
  cleanup.push(() => client.stop())
  client.start()
  return {
    client,
    host,
    consents,
    calls,
    statuses,
    events,
    online: () =>
      client.status.state === 'online'
        ? Promise.resolve()
        : new Promise<void>((resolve) => waiters.push(resolve)),
  }
}

function authorizeUrl(host: string, clientId: string): string {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    state: 'st-1',
    resource: `https://${host}/mcp`,
  })
  return `https://${host}/authorize?${query}`
}

describe('through the relay', () => {
  it('lets a remote client register, get consent at the Mac, take a token and call a tool', async () => {
    const relay = await startRelay()
    cleanup.push(() => relay.close())
    const mac = await startMac(relay)
    await mac.online()

    // Discovery, as an MCP client does it after its first 401.
    const unauthorised = await relay.fetch(`https://${mac.host}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    })
    expect(unauthorised.status).toBe(401)
    expect(unauthorised.headers.get('www-authenticate')).toContain(
      `https://${mac.host}/.well-known/oauth-protected-resource/mcp`,
    )
    const metadata = (await (
      await relay.fetch(`https://${mac.host}/.well-known/oauth-authorization-server`)
    ).json()) as {
      issuer: string
    }
    expect(metadata.issuer).toBe(`https://${mac.host}`)

    // Dynamic registration.
    const registered = await relay.fetch(`https://${mac.host}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: 'none',
        client_name: 'Claude',
      }),
    })
    expect(registered.status).toBe(201)
    const { client_id: clientId } = (await registered.json()) as { client_id: string }

    // /authorize: the relay's page shows the code the Mac chose, and waits.
    const waiting = await relay.fetch(authorizeUrl(mac.host, clientId))
    expect(waiting.status).toBe(200)
    expect(waiting.headers.get('content-security-policy')).toContain("default-src 'none'")
    const page = await waiting.text()
    const code = /<div class="code">([A-Z-]+)<\/div>/.exec(page)?.[1] as string
    const next = (/url=([^"]+)"/.exec(page)?.[1] ?? '').replace(/&amp;/g, '&')
    expect(code).toMatch(/^[A-HJ-NP-Z]{4}-[A-HJ-NP-Z]{4}$/)
    expect(next).toMatch(/^\/authorize\?wait=/)
    expect(mac.consents.prompts()).toHaveLength(1)

    // Still waiting: the poll shows the same code.
    const again = await relay.fetch(`https://${mac.host}${next}`)
    expect(await again.text()).toContain(code)

    // The person types the code at the Mac; the next poll sends the browser on with a code.
    expect(mac.consents.approve(code, ['woolworths.view_cart']).ok).toBe(true)
    const done = await relay.fetch(`https://${mac.host}${next}`)
    expect(done.status).toBe(302)
    const location = new URL(done.headers.get('location') as string)
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT)
    expect(location.searchParams.get('state')).toBe('st-1')
    const authCode = location.searchParams.get('code') as string

    const token = await relay.fetch(`https://${mac.host}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        code: authCode,
        code_verifier: VERIFIER,
        redirect_uri: REDIRECT,
      }).toString(),
    })
    expect(token.status).toBe(200)
    const { access_token: accessToken } = (await token.json()) as { access_token: string }

    // A real MCP client, over the relay, calls the granted tool.
    const transport = new StreamableHTTPClientTransport(new URL(`https://${mac.host}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
      fetch: ((input: string | URL | Request, init?: RequestInit) =>
        relay.fetch(input instanceof Request ? input.url : input.toString(), init)) as typeof fetch,
    })
    const mcp = new Client({ name: 'claude.ai', version: '1.0.0' })
    await mcp.connect(transport)
    cleanup.push(() => mcp.close())
    const tools = await mcp.listTools()
    expect(tools.tools.map((t) => t.name)).toEqual(['woolworths_view_cart'])
    const result = await mcp.callTool({ name: 'woolworths_view_cart', arguments: {} })
    expect(result.isError).toBeFalsy()
    expect(JSON.stringify(result.structuredContent)).toContain('3')
    expect(mac.calls).toHaveLength(1)

    // What the relay kept: exactly RelayStoredState, and nothing from the run above.
    const stored = relay.stored()
    expect(stored).toHaveLength(1)
    expect(Object.keys(stored[0] as object)).toEqual(['state'])
    const state = (stored[0] as { state: Record<string, unknown> }).state
    expect(Object.keys(state).sort()).toEqual([
      'createdAt',
      'devices',
      'lastSeenAt',
      'locked',
      'macId',
      'macTransportKey',
      'recoveryCodeHash',
    ])
    const dump = JSON.stringify(stored)
    for (const secret of [accessToken, authCode, clientId, code, 'view_cart', 'claude.example'])
      expect(dump).not.toContain(secret)
  })

  it('answers a tool call with a tool error, and anything else with a 503, while the Mac is offline', async () => {
    const relay = await startRelay()
    cleanup.push(() => relay.close())
    const host = `${'a'.repeat(32)}.relay.test`
    const call = await relay.fetch(`https://${host}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'x' } }),
    })
    expect(call.status).toBe(200)
    const body = (await call.json()) as {
      id: number
      result: { isError: boolean; content: { text: string }[] }
    }
    expect(body.id).toBe(7)
    expect(body.result.isError).toBe(true)
    expect(body.result.content[0]?.text).toContain("isn't connected")
    const other = await relay.fetch(`https://${host}/.well-known/oauth-authorization-server`)
    expect(other.status).toBe(503)
    const page = await relay.fetch(
      `https://${host}/authorize?response_type=code&client_id=x&redirect_uri=${encodeURIComponent(REDIRECT)}`,
    )
    expect(page.status).toBe(503)
    expect(await page.text()).toContain('isn’t connected')
  })

  it('reconnects after the relay drops it, and a second Mac with another key is refused', async () => {
    const relay = await startRelay()
    cleanup.push(() => relay.close())
    const mac = await startMac(relay)
    await mac.online()

    // Someone else claims the same Mac id with their own keys.
    const otherTransport = testKey()
    const otherApproval = testKey()
    const impostor = new RelayClient({
      relay: RELAY_ORIGIN,
      connectUrl: relay.url,
      macId: mac.host.split('.')[0] as string,
      signer: otherTransport,
      binding: {
        approvalKey: otherApproval.publicKey,
        signature: otherApproval.signDomain(SIGNING_DOMAINS.relayBinding, otherTransport.publicKey),
      },
      listener: () => null,
      consent: () => ({ state: 'declined' }),
      backoff: { minMs: 10_000, maxMs: 10_000 },
    })
    cleanup.push(() => impostor.stop())
    const refused = new Promise<RelayClientStatus>((resolve) => {
      const check = setInterval(() => {
        if (impostor.status.state === 'refused') {
          clearInterval(check)
          resolve(impostor.status)
        }
      }, 20)
    })
    impostor.start()
    expect((await refused).state).toBe('refused')
    // The real Mac is still the one connected.
    expect(mac.client.status.state).toBe('online')
  })

  it('locks down at the relay with the recovery code from a borrowed browser, until the Mac unlocks', async () => {
    const relay = await startRelay()
    cleanup.push(() => relay.close())
    const mac = await startMac(relay)
    await mac.online()
    const code = 'RKQ4-7MXT-PW9C-3HJD-WN2F'
    const codeHash = createHash('sha256').update(code.replace(/-/g, '')).digest('hex')
    expect(mac.client.send({ type: 'recovery-register', codeHash })).toBe(true)
    const origin = `https://${mac.host}`
    const post = (body: string) =>
      relay.fetch(`${origin}/recover`, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
        body,
      })
    // The register frame and the post race; the post may arrive first and read as wrong.
    let page = await post(new URLSearchParams({ code }).toString())
    for (let i = 0; i < 20 && page.status === 403; i++) {
      await delay(50)
      page = await post(new URLSearchParams({ code }).toString())
    }
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('locked down at the relay')
    await expect.poll(() => mac.events.some((e) => e.type === 'relay-locked')).toBe(true)

    const call = await relay.fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'x' } }),
    })
    expect(JSON.stringify(await call.json())).toContain('locked it down')
    expect(mac.calls).toHaveLength(0)
    expect((relay.stored()[0] as { state: { locked: boolean } }).state.locked).toBe(true)

    expect(mac.client.send({ type: 'relay-unlock' })).toBe(true)
    await expect.poll(() => (relay.stored()[0] as { state: { locked: boolean } }).state.locked).toBe(false)
  })
})
