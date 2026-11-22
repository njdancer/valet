// The blind relay's definition of done for the agent path: a real MCP client completes OAuth with
// the Mac and calls a tool, over HTTPS that ends on the Mac, through the relay. The Mac side is the
// real remote listener, OAuth server and consent from @valet/mcp-server behind the real tunnel
// client; only the tools and the keys are fakes.

import { createHash } from 'node:crypto'
import { request as httpsRequest } from 'node:https'
import { Readable } from 'node:stream'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { ToolDeclaration } from '@valet/core'
import {
  ConsentRequests,
  DEFAULT_OAUTH_LIMITS,
  type ListedTool,
  RemoteAccessTokens,
  RemoteAuthorization,
  RemoteClients,
  type RemotePolicy,
  startRemoteListener,
  type ToolCall,
} from '@valet/mcp-server'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { lookup, MAC_DOMAIN, macKeys, type Rig, startMac, startRig, type TestMac, waitFor } from './helpers'

const REDIRECT = 'https://claude.example/api/mcp/auth_callback'
const VERIFIER = `${'v'.repeat(43)}-._~0123456789`
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
  output: z.object({ items: z.number(), note: z.string() }),
}

class GrantPolicy implements RemotePolicy {
  constructor(private readonly clients: RemoteClients) {}
  allows(adapterId: string, declaration: ToolDeclaration, clientId: string | null): boolean {
    if (clientId === null) return true
    return this.clients.get(clientId)?.grant?.tools.includes(`${adapterId}.${declaration.name}`) ?? false
  }
}

/** fetch over HTTPS to the relay's port, trusting only the Mac's certificate. */
function fetchVia(rig: Rig, ca: string): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    const headers = new Headers(input instanceof Request ? input.headers : undefined)
    for (const [key, value] of new Headers(init?.headers)) headers.set(key, value)
    const body = init?.body == null ? undefined : Buffer.from(await new Response(init.body).arrayBuffer())
    return new Promise<Response>((resolve, reject) => {
      const req = httpsRequest(
        {
          host: url.hostname,
          port: rig.port,
          path: `${url.pathname}${url.search}`,
          method: init?.method ?? 'GET',
          // As on port 443: the name alone, no port.
          headers: { ...Object.fromEntries(headers), host: url.hostname },
          ca,
          lookup,
          agent: false,
        },
        (res) => {
          const out = new Headers()
          for (const [key, value] of Object.entries(res.headers))
            if (value !== undefined) out.set(key, Array.isArray(value) ? value.join(', ') : value)
          const status = res.statusCode ?? 0
          const nobody = status === 204 || status === 304 || init?.method === 'HEAD'
          resolve(
            new Response(nobody ? null : (Readable.toWeb(res) as ReadableStream), { status, headers: out }),
          )
        },
      )
      init?.signal?.addEventListener('abort', () => req.destroy(new Error('aborted')))
      req.on('error', reject)
      req.end(body)
    })
  }) as typeof fetch
}

interface Mac extends TestMac {
  readonly consents: ConsentRequests
  readonly calls: ToolCall[]
}

async function macWithListener(rig: Rig): Promise<Mac & { reconnect(): TestMac }> {
  const keys = macKeys()
  const host = `${keys.macId}.${MAC_DOMAIN}`
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
        return { status: 'ok', output: { items: 3, note: 'result-marker-7f3a' } }
      },
    },
    policy: new GrantPolicy(clients),
    tokens,
    authorization,
    hosts: () => new Set([host]),
  })
  cleanup.push(() => listener.close())
  const mac = startMac(rig, (socket, meta) => listener.accept(socket, meta), { keys })
  cleanup.push(() => mac.client.stop())
  /** The same Mac on a new link, as after its network dropped: same keys, certificate and listener. */
  const reconnect = () => {
    const next = startMac(rig, (socket, meta) => listener.accept(socket, meta), {
      keys,
      certificate: () => mac.cert.context,
    })
    cleanup.push(() => next.client.stop())
    return next
  }
  return { ...mac, consents, calls, reconnect }
}

describe('an MCP client through the blind relay', () => {
  it('registers, gets consent at the Mac, takes a token and calls a tool; the relay sees only ciphertext', async () => {
    const rig = await startRig()
    cleanup.push(() => rig.close())
    const mac = await macWithListener(rig)
    await mac.online()
    const f = fetchVia(rig, mac.cert.pem)
    const base = `https://${mac.host}`

    const unauthorised = await f(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    })
    expect(unauthorised.status).toBe(401)
    expect(unauthorised.headers.get('www-authenticate')).toContain(
      `${base}/.well-known/oauth-protected-resource/mcp`,
    )
    const metadata = (await (await f(`${base}/.well-known/oauth-authorization-server`)).json()) as {
      issuer: string
    }
    expect(metadata.issuer).toBe(base)

    const registered = await f(`${base}/register`, {
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

    // The Mac's own consent page, served by the Mac: the relay renders nothing.
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
      state: 'st-1',
      resource: `${base}/mcp`,
    })
    const page = await (await f(`${base}/authorize?${query}`)).text()
    const code = /<div class="code">([A-Z-]+)<\/div>/.exec(page)?.[1] as string
    const next = (/url=([^"]+)"/.exec(page)?.[1] ?? '').replace(/&amp;/g, '&')
    expect(code).toMatch(/^[A-HJ-NP-Z]{4}-[A-HJ-NP-Z]{4}$/)
    expect(mac.consents.approve(code, ['woolworths.view_cart']).ok).toBe(true)
    const done = await f(`${base}${next}`)
    expect(done.status).toBe(302)
    const location = new URL(done.headers.get('location') as string)
    expect(location.searchParams.get('state')).toBe('st-1')
    const authCode = location.searchParams.get('code') as string

    const token = await f(`${base}/token`, {
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

    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
      fetch: f,
    })
    const mcp = new Client({ name: 'claude.ai', version: '1.0.0' })
    await mcp.connect(transport)
    cleanup.push(() => mcp.close())
    expect((await mcp.listTools()).tools.map((t) => t.name)).toEqual(['woolworths_view_cart'])
    const result = await mcp.callTool({ name: 'woolworths_view_cart', arguments: {} })
    expect(result.isError).toBeFalsy()
    expect(JSON.stringify(result.structuredContent)).toContain('result-marker-7f3a')
    expect(mac.calls).toHaveLength(1)

    // Nothing the relay carried can be read: not the token, the code, the tool or its result.
    const carried = Buffer.concat(mac.received)
    for (const secret of [
      accessToken,
      authCode,
      clientId,
      'view_cart',
      'result-marker-7f3a',
      'claude.example',
    ])
      expect(carried.includes(secret)).toBe(false)
    expect(rig.lines.join('\n')).not.toMatch(/view_cart|claude|Bearer/)
  })

  it('finishes a claude.ai-style sign-in when the Mac drops off the relay between steps', async () => {
    const rig = await startRig({ limits: { macGraceMs: 5000 } })
    cleanup.push(() => rig.close())
    const mac = await macWithListener(rig)
    await mac.online()
    const f = fetchVia(rig, mac.cert.pem)
    const base = `https://${mac.host}`
    // As claude.ai registers: a confidential client that sends its secret in the token request.
    const registered = await f(`${base}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: 'client_secret_post',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        client_name: 'Claude',
      }),
    })
    expect(registered.status).toBe(201)
    const client = (await registered.json()) as { client_id: string; client_secret: string }
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: REDIRECT,
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
      state: 'st-2',
      resource: `${base}/mcp`,
    })
    const page = await (await f(`${base}/authorize?${query}`)).text()
    const code = /<div class="code">([A-Z-]+)<\/div>/.exec(page)?.[1] as string
    const next = (/url=([^"]+)"/.exec(page)?.[1] ?? '').replace(/&amp;/g, '&')
    expect(mac.consents.approve(code, ['woolworths.view_cart']).ok).toBe(true)

    // The link drops just before the browser comes back for its code; it waits, and is served.
    mac.client.stop()
    await waitFor(() => rig.relay.macs().length === 0)
    const back = f(`${base}${next}`)
    await new Promise((resolve) => setTimeout(resolve, 200))
    const second = mac.reconnect()
    const done = await back
    expect(done.status).toBe(302)
    const location = new URL(done.headers.get('location') as string)
    expect(location.searchParams.get('iss')).toBe(base)
    expect(location.searchParams.get('state')).toBe('st-2')

    // And again just before Claude's server redeems it.
    second.client.stop()
    await waitFor(() => rig.relay.macs().length === 0)
    const token = f(`${base}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        client_secret: client.client_secret,
        code: location.searchParams.get('code') as string,
        code_verifier: VERIFIER,
        redirect_uri: REDIRECT,
        resource: `${base}/mcp`,
      }).toString(),
    })
    await new Promise((resolve) => setTimeout(resolve, 200))
    mac.reconnect()
    const issued = await token
    expect(issued.status).toBe(200)
    const { access_token: accessToken } = (await issued.json()) as { access_token: string }
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
      fetch: f,
    })
    const mcp = new Client({ name: 'claude.ai', version: '1.0.0' })
    await mcp.connect(transport)
    cleanup.push(() => mcp.close())
    expect((await mcp.listTools()).tools.map((t) => t.name)).toEqual(['woolworths_view_cart'])
  })

  it("replaces a caller's own Cf-Connecting-Ip with the address the relay saw", async () => {
    const rig = await startRig()
    cleanup.push(() => rig.close())
    const mac = await macWithListener(rig)
    await mac.online()
    const f = fetchVia(rig, mac.cert.pem)
    // Registration allows a few per source an hour: a caller who could pick its source each time
    // would never run out. Through the tunnel, every forged address counts as the relay's one.
    const statuses: number[] = []
    for (let i = 0; i <= DEFAULT_OAUTH_LIMITS.registerPerSource.limit + 1; i++) {
      const res = await f(`https://${mac.host}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': `198.51.100.${i}` },
        body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }),
      })
      statuses.push(res.status)
      await res.arrayBuffer()
    }
    expect(statuses).toContain(429)
  })
})
