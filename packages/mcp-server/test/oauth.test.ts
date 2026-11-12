// The remote listener's authorisation server, attacked from the outside the way the public URL
// would be: registration, /authorize, consent on the Mac by typed code, the token endpoint, and
// what a token then lets a client do on the MCP path.

import { createHash } from 'node:crypto'
import { request } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { ToolDeclaration } from '@valet/core'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  isHttpsRedirect,
  MAX_REGISTRATIONS,
  newRegistrationId,
  parseClientMetadata,
  REFRESH_TOKEN_TTL_MS,
  RemoteClients,
  UNCONSENTED_TTL_MS,
} from '../src/oauth-clients'
import {
  CONSENT_TTL_MS,
  ConsentRequests,
  generateCode,
  MAX_PENDING_CONSENTS,
  normaliseCode,
} from '../src/oauth-consent'
import {
  AUTH_CODE_TTL_MS,
  cloudflaredSource,
  type OAuthAuditEvent,
  type OAuthLimits,
  pkceMatches,
  RemoteAuthorization,
} from '../src/oauth-server'
import { startRemoteListener } from '../src/remote'
import { RemoteAccessTokens } from '../src/remote-auth'
import type { RemotePolicy } from '../src/remote-policy'
import type { ListedTool } from '../src/tool-caller'
import { FakeCaller } from './fake-caller'
import { tunnelFetch } from './tunnel-fetch'

const HOST = 'valet.dncr.example'
const OTHER_HOST = 'second.dncr.example'
const RESOURCE = `https://${HOST}/mcp`
const REDIRECT = 'https://claude.example/api/mcp/auth_callback'
const VERIFIER = 'v'.repeat(43) + '-._~0123456789'
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url')

const tool = (name: string, sideEffect: ToolDeclaration['sideEffect']): ListedTool => ({
  adapterId: 'woolworths',
  adapterName: 'Woolworths',
  declaration: { name, title: name, description: `${name}.`, sideEffect },
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
})

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step()
})

interface Raw {
  readonly status: number
  readonly headers: Record<string, string | string[] | undefined>
  readonly body: string
}

function send(
  port: number,
  method: string,
  path: string,
  options: { headers?: Record<string, string>; body?: string; host?: string } = {},
): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: { host: options.host ?? HOST, ...options.headers },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        )
      },
    )
    req.on('error', reject)
    req.end(options.body)
  })
}

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
})

const form = (fields: Record<string, string>, headers: Record<string, string> = {}) => ({
  headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
  body: new URLSearchParams(fields).toString(),
})

/** Grants per client, the way the app's policy keeps them: `<adapter>.<tool>`. */
class GrantPolicy implements RemotePolicy {
  constructor(private readonly clients: RemoteClients) {}
  allows(adapterId: string, declaration: ToolDeclaration, clientId: string | null): boolean {
    if (clientId === null) return true
    return this.clients.get(clientId)?.grant?.tools.includes(`${adapterId}.${declaration.name}`) ?? false
  }
}

interface Setup {
  readonly port: number
  readonly clients: RemoteClients
  readonly consents: ConsentRequests
  readonly tokens: RemoteAccessTokens
  readonly authorization: RemoteAuthorization
  readonly asked: string[]
  readonly audits: OAuthAuditEvent[]
  readonly clock: { now: number }
  close(): Promise<void>
}

async function setup(options: { limits?: Partial<OAuthLimits> } = {}): Promise<Setup> {
  const clock = { now: Date.UTC(2026, 10, 10, 12) }
  const now = () => clock.now
  const caller = new FakeCaller([tool('view_cart', 'read'), tool('set_cart_quantity', 'write')])
  caller.answer = async () => ({ status: 'ok', output: { ok: true } })
  const clients = new RemoteClients({ now })
  const consents = new ConsentRequests({ now })
  const tokens = new RemoteAccessTokens({ now })
  const asked: string[] = []
  const audits: OAuthAuditEvent[] = []
  const big = { limit: 1000, windowMs: 60_000 }
  const authorization = new RemoteAuthorization({
    tokens,
    clients,
    consents,
    now,
    limits: {
      registerPerSource: big,
      registerGlobal: big,
      authorizePerSource: big,
      authorizeGlobal: big,
      tokenPerSource: big,
      tokenGlobal: big,
      ...options.limits,
    },
    consentRequested: (request) => asked.push(request.id),
    audit: (event) => audits.push(event),
  })
  const listener = await startRemoteListener({
    caller,
    policy: new GrantPolicy(clients),
    tokens,
    authorization,
    hosts: () => new Set([HOST, OTHER_HOST]),
  })
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await listener.close()
  }
  cleanup.push(close)
  return { port: listener.port, clients, consents, tokens, authorization, asked, audits, clock, close }
}

async function register(
  s: Setup,
  metadata: Record<string, unknown> = { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' },
  headers: Record<string, string> = {},
): Promise<Raw> {
  return send(s.port, 'POST', '/register', json(metadata, headers))
}

function authorizePath(clientId: string, extra: Record<string, string | null> = {}): string {
  const params: Record<string, string | null> = {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    state: 'st-123',
    resource: RESOURCE,
    ...extra,
  }
  const search = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== null) search.set(k, v)
  return `/authorize?${search}`
}

function waitPath(body: string): string {
  const match = /url=([^"]+)"/.exec(body)
  if (match === null) throw new Error('no refresh')
  return (match[1] as string).replace(/&amp;/g, '&')
}

/** Registers a public client, runs /authorize, approves with the code, and returns the code. */
async function authorise(
  s: Setup,
  tools: readonly string[] = ['woolworths.view_cart'],
): Promise<{ clientId: string; code: string }> {
  const reg = JSON.parse((await register(s)).body) as { client_id: string }
  const page = await send(s.port, 'GET', authorizePath(reg.client_id))
  expect(page.status).toBe(200)
  const pending = s.consents.byHandle(
    new URL(waitPath(page.body), 'https://x').searchParams.get('h') as string,
  )
  expect(s.consents.approve(pending?.code as string, tools).ok).toBe(true)
  const done = await send(s.port, 'GET', waitPath(page.body))
  expect(done.status).toBe(302)
  const location = new URL(done.headers['location'] as string)
  return { clientId: reg.client_id, code: location.searchParams.get('code') as string }
}

async function exchange(
  s: Setup,
  clientId: string,
  code: string,
  extra: Record<string, string> = {},
): Promise<Raw> {
  return send(
    s.port,
    'POST',
    '/token',
    form({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      code_verifier: VERIFIER,
      redirect_uri: REDIRECT,
      ...extra,
    }),
  )
}

async function connect(port: number, token: string, host = HOST): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`http://${host}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: tunnelFetch(port, host),
  })
  const client = new Client({ name: 'claude.ai', version: '1.0.0' })
  await client.connect(transport)
  cleanup.push(() => client.close())
  return client
}

describe('metadata', () => {
  it('serves protected resource and authorisation server metadata for the name it was reached on', async () => {
    const s = await setup()
    const resource = JSON.parse((await send(s.port, 'GET', '/.well-known/oauth-protected-resource/mcp')).body)
    expect(resource).toMatchObject({ resource: RESOURCE, authorization_servers: [`https://${HOST}`] })
    const server = JSON.parse((await send(s.port, 'GET', '/.well-known/oauth-authorization-server')).body)
    expect(server).toMatchObject({
      issuer: `https://${HOST}`,
      authorization_endpoint: `https://${HOST}/authorize`,
      token_endpoint: `https://${HOST}/token`,
      registration_endpoint: `https://${HOST}/register`,
      code_challenge_methods_supported: ['S256'],
      client_id_metadata_document_supported: false,
    })
    const other = JSON.parse(
      (await send(s.port, 'GET', '/.well-known/oauth-protected-resource', { host: OTHER_HOST })).body,
    )
    expect(other.resource).toBe(`https://${OTHER_HOST}/mcp`)
  })

  it('points a 401 at the resource metadata', async () => {
    const s = await setup()
    const res = await send(s.port, 'POST', '/mcp', json({ jsonrpc: '2.0', id: 1, method: 'ping' }))
    expect(res.status).toBe(401)
    expect(res.headers['www-authenticate']).toBe(
      `Bearer resource_metadata="https://${HOST}/.well-known/oauth-protected-resource/mcp", scope="tools"`,
    )
  })

  it('applies the Host and Origin guards to every OAuth path', async () => {
    const s = await setup()
    for (const path of ['/.well-known/oauth-authorization-server', '/authorize', '/register', '/token']) {
      expect((await send(s.port, 'GET', path, { host: `127.0.0.1:${s.port}` })).status).toBe(403)
      expect((await send(s.port, 'GET', path, { headers: { origin: `https://${HOST}` } })).status).toBe(403)
      expect((await send(s.port, 'GET', path, { host: 'attacker.example' })).status).toBe(403)
    }
  })

  it('answers wrong methods with 405 and leaves unknown paths to the MCP guard', async () => {
    const s = await setup()
    expect((await send(s.port, 'POST', '/.well-known/oauth-authorization-server')).status).toBe(405)
    expect((await send(s.port, 'GET', '/token')).status).toBe(405)
    expect((await send(s.port, 'GET', '/register')).status).toBe(405)
    expect((await send(s.port, 'POST', '/authorize')).status).toBe(405)
    expect((await send(s.port, 'GET', '/favicon.ico')).status).toBe(401)
  })
})

describe('registration', () => {
  it('registers a public client under an id of its own', async () => {
    const s = await setup()
    const res = await register(s, {
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
      client_name: 'Claude\u0000 <b>evil</b>',
    })
    expect(res.status).toBe(201)
    const body = JSON.parse(res.body)
    expect(body.client_id).toMatch(/^rc[a-z2-7]{20}$/)
    expect(body.client_secret).toBeUndefined()
    expect(body.token_endpoint_auth_method).toBe('none')
    expect(s.clients.get(body.client_id)?.clientName).toBe('Claude <b>evil</b>')
  })

  it('gives a confidential client a secret, kept only as a hash', async () => {
    const s = await setup()
    const body = JSON.parse((await register(s, { redirect_uris: [REDIRECT] })).body)
    expect(body.token_endpoint_auth_method).toBe('client_secret_basic')
    expect(body.client_secret).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(JSON.stringify(s.clients.state())).not.toContain(body.client_secret)
  })

  it.each([
    ['http redirect', { redirect_uris: ['http://claude.example/cb'] }],
    ['IP literal', { redirect_uris: ['https://127.0.0.1/cb'] }],
    ['decimal IP', { redirect_uris: ['https://2130706433/cb'] }],
    ['IPv6 literal', { redirect_uris: ['https://[::1]/cb'] }],
    ['userinfo', { redirect_uris: ['https://user@claude.example/cb'] }],
    ['fragment', { redirect_uris: ['https://claude.example/cb#x'] }],
    ['other port', { redirect_uris: ['https://claude.example:8443/cb'] }],
    ['single-label host', { redirect_uris: ['https://localhost/cb'] }],
    ['no redirect', {}],
    [
      'too many redirects',
      { redirect_uris: Array.from({ length: 6 }, (_, i) => `https://c${i}.example/cb`) },
    ],
    ['implicit flow', { redirect_uris: [REDIRECT], response_types: ['token'] }],
    ['client credentials', { redirect_uris: [REDIRECT], grant_types: ['client_credentials'] }],
    ['private_key_jwt', { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'private_key_jwt' }],
  ])('refuses %s', async (_name, metadata) => {
    const s = await setup()
    const res = await register(s, metadata)
    expect(res.status).toBe(400)
    expect(JSON.parse(res.body)).toEqual({ error: 'invalid_client_metadata' })
    expect(s.clients.list()).toHaveLength(0)
  })

  it('refuses a body that is not JSON, or too big', async () => {
    const s = await setup()
    expect(
      (await send(s.port, 'POST', '/register', { headers: { 'content-type': 'text/plain' }, body: '{}' }))
        .status,
    ).toBe(400)
    expect(
      (
        await send(s.port, 'POST', '/register', {
          headers: { 'content-type': 'application/json' },
          body: '{',
        })
      ).status,
    ).toBe(400)
    const huge = json({ redirect_uris: [REDIRECT], client_name: 'x'.repeat(20_000) })
    expect((await send(s.port, 'POST', '/register', huge)).status).toBe(413)
  })

  it('limits registrations per source address (from cloudflared) and globally', async () => {
    const s = await setup({
      limits: {
        registerPerSource: { limit: 2, windowMs: 60_000 },
        registerGlobal: { limit: 3, windowMs: 60_000 },
      },
    })
    const from = (ip: string) => ({ 'cf-connecting-ip': ip })
    expect((await register(s, undefined, from('203.0.113.5'))).status).toBe(201)
    expect((await register(s, undefined, from('203.0.113.5'))).status).toBe(201)
    expect((await register(s, undefined, from('203.0.113.5'))).status).toBe(429)
    expect((await register(s, undefined, from('198.51.100.7'))).status).toBe(201)
    // The global limit holds for a new source, and for one that sends no address.
    expect((await register(s, undefined, from('192.0.2.1'))).status).toBe(429)
    expect((await register(s)).status).toBe(429)
    s.clock.now += 60_000
    expect((await register(s)).status).toBe(201)
  })

  it('stops at the cap, and lets an unconsented registration expire after an hour', async () => {
    const s = await setup()
    for (let i = 0; i < MAX_REGISTRATIONS; i++) expect((await register(s)).status).toBe(201)
    expect((await register(s)).status).toBe(503)
    s.clock.now += UNCONSENTED_TTL_MS
    expect((await register(s)).status).toBe(201)
    expect(s.clients.list()).toHaveLength(1)
  })

  it('never evicts a consented registration to make room', async () => {
    const s = await setup()
    const { clientId, code } = await authorise(s)
    expect((await exchange(s, clientId, code)).status).toBe(200)
    s.clock.now += UNCONSENTED_TTL_MS
    for (let i = 0; i < MAX_REGISTRATIONS - 1; i++) expect((await register(s)).status).toBe(201)
    expect((await register(s)).status).toBe(503)
    expect(s.clients.get(clientId)?.grant).not.toBeNull()
  })
})

describe('/authorize', () => {
  it('shows the browser a code, and the Mac a request without it', async () => {
    const s = await setup()
    const reg = JSON.parse((await register(s)).body) as { client_id: string }
    const page = await send(s.port, 'GET', authorizePath(reg.client_id), {
      headers: { 'cf-connecting-ip': '203.0.113.9' },
    })
    expect(page.status).toBe(200)
    expect(page.headers['content-security-policy']).toContain("default-src 'none'")
    expect(page.headers['x-frame-options']).toBe('DENY')
    expect(page.body).not.toContain('<script')
    expect(page.body).toContain('Type this code into Valet on your Mac')
    const [prompt] = s.consents.prompts()
    expect(prompt).toMatchObject({
      clientId: reg.client_id,
      clientHost: 'claude.example',
      source: '203.0.113.9',
    })
    expect(JSON.stringify(prompt)).not.toMatch(/code|handle/i)
    expect(s.asked).toEqual([prompt?.id])
    const pending = s.consents.byHandle(
      new URL(waitPath(page.body), 'https://x').searchParams.get('h') as string,
    )
    expect(page.body).toContain(`${pending?.code.slice(0, 4)}-${pending?.code.slice(4)}`)
  })

  it('never puts what the client sent into the page', async () => {
    const s = await setup()
    const reg = JSON.parse(
      (
        await register(s, {
          redirect_uris: [REDIRECT],
          token_endpoint_auth_method: 'none',
          client_name: '<img src=x>',
        })
      ).body,
    ) as { client_id: string }
    const page = await send(
      s.port,
      'GET',
      authorizePath(reg.client_id, { state: '<script>alert(1)</script>' }),
    )
    expect(page.body).not.toContain('<img')
    expect(page.body).not.toContain('alert')
    expect(page.body).not.toContain(REDIRECT)
  })

  it('keeps errors on its own page until the client and redirect URI check out', async () => {
    const s = await setup()
    expect((await send(s.port, 'GET', authorizePath('rcnobodynobodynobody'))).status).toBe(400)
    const reg = JSON.parse((await register(s)).body) as { client_id: string }
    const wrong = await send(
      s.port,
      'GET',
      authorizePath(reg.client_id, { redirect_uri: 'https://attacker.example/cb' }),
    )
    expect(wrong.status).toBe(400)
    expect(wrong.headers['location']).toBeUndefined()
    expect(s.consents.prompts()).toHaveLength(0)
  })

  it.each([
    ['plain PKCE', { code_challenge_method: 'plain' }, 'invalid_request'],
    ['no PKCE', { code_challenge: null, code_challenge_method: null }, 'invalid_request'],
    ['a malformed challenge', { code_challenge: 'short' }, 'invalid_request'],
    ['another resource', { resource: 'https://elsewhere.example/mcp' }, 'invalid_target'],
    ['the other name’s resource', { resource: `https://${OTHER_HOST}/mcp` }, 'invalid_target'],
    ['the token flow', { response_type: 'token' }, 'unsupported_response_type'],
  ])('sends %s back to the client as an error, opening nothing', async (_name, extra, error) => {
    const s = await setup()
    const reg = JSON.parse((await register(s)).body) as { client_id: string }
    const res = await send(s.port, 'GET', authorizePath(reg.client_id, extra))
    expect(res.status).toBe(302)
    const location = new URL(res.headers['location'] as string)
    expect(location.origin + location.pathname).toBe(REDIRECT)
    expect(location.searchParams.get('error')).toBe(error)
    expect(location.searchParams.get('state')).toBe('st-123')
    expect(s.consents.prompts()).toHaveLength(0)
  })

  it('defaults the resource and the only redirect URI', async () => {
    const s = await setup()
    const reg = JSON.parse((await register(s)).body) as { client_id: string }
    const res = await send(
      s.port,
      'GET',
      authorizePath(reg.client_id, { resource: null, redirect_uri: null }),
    )
    expect(res.status).toBe(200)
  })

  it('holds at most five pending requests, telling the sixth browser to try later without asking the Mac', async () => {
    const s = await setup()
    const reg = JSON.parse((await register(s)).body) as { client_id: string }
    for (let i = 0; i < MAX_PENDING_CONSENTS; i++)
      expect((await send(s.port, 'GET', authorizePath(reg.client_id))).status).toBe(200)
    expect((await send(s.port, 'GET', authorizePath(reg.client_id))).status).toBe(429)
    expect(s.asked).toHaveLength(MAX_PENDING_CONSENTS)
  })

  it('is rate-limited before it looks anything up', async () => {
    const s = await setup({
      limits: {
        authorizePerSource: { limit: 1, windowMs: 60_000 },
        authorizeGlobal: { limit: 2, windowMs: 60_000 },
      },
    })
    const ip = { headers: { 'cf-connecting-ip': '203.0.113.1' } }
    expect((await send(s.port, 'GET', authorizePath('rcnobodynobodynobody'), ip)).status).toBe(400)
    expect((await send(s.port, 'GET', authorizePath('rcnobodynobodynobody'), ip)).status).toBe(429)
    expect((await send(s.port, 'GET', authorizePath('rcnobodynobodynobody'))).status).toBe(400)
    expect((await send(s.port, 'GET', authorizePath('rcnobodynobodynobody'))).status).toBe(429)
  })
})

describe('consent on the Mac', () => {
  it('approves only the request whose code the person typed, and sends that browser on', async () => {
    const s = await setup()
    const reg = JSON.parse((await register(s)).body) as { client_id: string }
    const mine = await send(s.port, 'GET', authorizePath(reg.client_id, { state: 'mine' }))
    const theirs = await send(s.port, 'GET', authorizePath(reg.client_id, { state: 'theirs' }))
    const myHandle = new URL(waitPath(mine.body), 'https://x').searchParams.get('h') as string
    const myCode = s.consents.byHandle(myHandle)?.code as string
    const result = s.consents.approve(myCode.toLowerCase().replace(/^(.{4})/, '$1 '), [
      'woolworths.view_cart',
    ])
    expect(result.ok).toBe(true)
    // The other browser still waits; mine goes on with a code and the issuer.
    expect((await send(s.port, 'GET', waitPath(theirs.body))).status).toBe(200)
    const done = await send(s.port, 'GET', waitPath(mine.body))
    const location = new URL(done.headers['location'] as string)
    expect(location.searchParams.get('state')).toBe('mine')
    expect(location.searchParams.get('iss')).toBe(`https://${HOST}`)
    expect(location.searchParams.get('code')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    // The handle is spent.
    expect((await send(s.port, 'GET', waitPath(mine.body))).status).toBe(404)
  })

  it('cancels every pending request at the third wrong code', async () => {
    const s = await setup()
    const reg = JSON.parse((await register(s)).body) as { client_id: string }
    const page = await send(s.port, 'GET', authorizePath(reg.client_id))
    await send(s.port, 'GET', authorizePath(reg.client_id))
    expect(s.consents.approve('AAAA-AAAA', []).ok).toBe(false)
    expect(s.consents.approve('not a code', [])).toEqual({ ok: false, reason: 'wrong-code' })
    expect(s.consents.approve('BBBB-BBBB', [])).toEqual({ ok: false, reason: 'cancelled' })
    expect(s.consents.prompts()).toHaveLength(0)
    const res = await send(s.port, 'GET', waitPath(page.body))
    expect(new URL(res.headers['location'] as string).searchParams.get('error')).toBe('access_denied')
  })

  it('sends a declined browser back with access_denied', async () => {
    const s = await setup()
    const reg = JSON.parse((await register(s)).body) as { client_id: string }
    const page = await send(s.port, 'GET', authorizePath(reg.client_id))
    expect(s.consents.decline(s.consents.prompts()[0]?.id as string)).toBe(true)
    const res = await send(s.port, 'GET', waitPath(page.body))
    expect(new URL(res.headers['location'] as string).searchParams.get('error')).toBe('access_denied')
  })

  it('lets a request expire after five minutes', async () => {
    const s = await setup()
    const reg = JSON.parse((await register(s)).body) as { client_id: string }
    const page = await send(s.port, 'GET', authorizePath(reg.client_id))
    const code = s.consents.byHandle(
      new URL(waitPath(page.body), 'https://x').searchParams.get('h') as string,
    )?.code
    s.clock.now += CONSENT_TTL_MS
    expect(s.consents.prompts()).toHaveLength(0)
    expect(s.consents.approve(code as string, []).ok).toBe(false)
    expect((await send(s.port, 'GET', waitPath(page.body))).status).toBe(404)
  })

  it('refuses a browser whose client was revoked while it waited', async () => {
    const s = await setup()
    const reg = JSON.parse((await register(s)).body) as { client_id: string }
    const page = await send(s.port, 'GET', authorizePath(reg.client_id))
    const code = s.consents.byHandle(
      new URL(waitPath(page.body), 'https://x').searchParams.get('h') as string,
    )?.code
    s.consents.approve(code as string, [])
    s.authorization.revokeClient(reg.client_id)
    const res = await send(s.port, 'GET', waitPath(page.body))
    expect(new URL(res.headers['location'] as string).searchParams.get('error')).toBe('access_denied')
  })
})

describe('/token', () => {
  it('trades a code and its verifier for tokens bound to this name, narrowed to the ticked tools', async () => {
    const s = await setup()
    const { clientId, code } = await authorise(s, ['woolworths.view_cart'])
    const res = await exchange(s, clientId, code)
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('no-store')
    const body = JSON.parse(res.body)
    expect(body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'tools' })
    const client = await connect(s.port, body.access_token)
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['woolworths_view_cart'])
    const refused = await client.callTool({ name: 'woolworths_set_cart_quantity', arguments: {} })
    expect(refused.isError).toBe(true)
    // The same token on the other public name is for another resource.
    await expect(connect(s.port, body.access_token, OTHER_HOST)).rejects.toThrow()
  })

  it('refuses a wrong verifier, redirect URI or resource, and the code is spent either way', async () => {
    const s = await setup()
    const extras: Record<string, string>[] = [
      { code_verifier: 'w'.repeat(43) },
      { redirect_uri: 'https://claude.example/other' },
      { resource: 'https://elsewhere.example/mcp' },
    ]
    for (const extra of extras) {
      const { clientId, code } = await authorise(s)
      const res = await exchange(s, clientId, code, extra)
      expect(res.status).toBe(400)
      expect((await exchange(s, clientId, code)).status).toBe(400)
    }
  })

  it('refuses a code minted for the other name', async () => {
    const s = await setup()
    const { clientId, code } = await authorise(s)
    const res = await send(s.port, 'POST', '/token', {
      ...form({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: VERIFIER }),
      host: OTHER_HOST,
    })
    expect(JSON.parse(res.body).error).toBe('invalid_grant')
  })

  it('refuses another client’s code, and an expired one', async () => {
    const s = await setup()
    const { code } = await authorise(s)
    const other = JSON.parse((await register(s)).body) as { client_id: string }
    expect(JSON.parse((await exchange(s, other.client_id, code)).body).error).toBe('invalid_grant')
    const late = await authorise(s)
    s.clock.now += AUTH_CODE_TTL_MS
    expect(JSON.parse((await exchange(s, late.clientId, late.code)).body).error).toBe('invalid_grant')
  })

  it('revokes the grant when a code is used twice', async () => {
    const s = await setup()
    const { clientId, code } = await authorise(s)
    const first = JSON.parse((await exchange(s, clientId, code)).body)
    expect(JSON.parse((await exchange(s, clientId, code)).body).error).toBe('invalid_grant')
    expect(s.tokens.identify(first.access_token, RESOURCE)).toBeNull()
    expect(s.clients.get(clientId)?.grant).toBeNull()
    expect(s.audits).toEqual([{ type: 'remote-token-reuse', clientId, token: 'code' }])
  })

  it('rotates refresh tokens, and revokes the grant when a rotated one comes back', async () => {
    const s = await setup()
    const { clientId, code } = await authorise(s)
    const first = JSON.parse((await exchange(s, clientId, code)).body)
    const second = JSON.parse(
      (
        await send(
          s.port,
          'POST',
          '/token',
          form({ grant_type: 'refresh_token', client_id: clientId, refresh_token: first.refresh_token }),
        )
      ).body,
    )
    expect(second.refresh_token).not.toBe(first.refresh_token)
    expect(s.tokens.identify(second.access_token, RESOURCE)).toBe(clientId)
    // The thief (or the client) presents the old one.
    const reuse = await send(
      s.port,
      'POST',
      '/token',
      form({ grant_type: 'refresh_token', client_id: clientId, refresh_token: first.refresh_token }),
    )
    expect(JSON.parse(reuse.body).error).toBe('invalid_grant')
    expect(s.tokens.identify(second.access_token, RESOURCE)).toBeNull()
    expect(s.clients.get(clientId)?.grant).toBeNull()
    expect(s.audits).toEqual([{ type: 'remote-token-reuse', clientId, token: 'refresh' }])
    const after = await send(
      s.port,
      'POST',
      '/token',
      form({ grant_type: 'refresh_token', client_id: clientId, refresh_token: second.refresh_token }),
    )
    expect(JSON.parse(after.body).error).toBe('invalid_grant')
  })

  it('lets a grant lapse thirty days after its last refresh', async () => {
    const s = await setup()
    const { clientId, code } = await authorise(s)
    const first = JSON.parse((await exchange(s, clientId, code)).body)
    s.clock.now += REFRESH_TOKEN_TTL_MS
    const res = await send(
      s.port,
      'POST',
      '/token',
      form({ grant_type: 'refresh_token', client_id: clientId, refresh_token: first.refresh_token }),
    )
    expect(JSON.parse(res.body).error).toBe('invalid_client')
    expect(s.clients.get(clientId)).toBeNull()
  })

  it('authenticates a confidential client by Basic or by body, and refuses a missing or wrong secret', async () => {
    const s = await setup()
    const reg = JSON.parse((await register(s, { redirect_uris: [REDIRECT] })).body) as {
      client_id: string
      client_secret: string
    }
    const go = async (): Promise<string> => {
      const page = await send(s.port, 'GET', authorizePath(reg.client_id))
      const handle = new URL(waitPath(page.body), 'https://x').searchParams.get('h') as string
      s.consents.approve(s.consents.byHandle(handle)?.code as string, [])
      const done = await send(s.port, 'GET', waitPath(page.body))
      return new URL(done.headers['location'] as string).searchParams.get('code') as string
    }
    const fields = (code: string) => ({ grant_type: 'authorization_code', code, code_verifier: VERIFIER })
    const basic = (secret: string) => `Basic ${Buffer.from(`${reg.client_id}:${secret}`).toString('base64')}`

    expect(
      (await send(s.port, 'POST', '/token', form({ ...fields(await go()), client_id: reg.client_id })))
        .status,
    ).toBe(401)
    expect(
      (await send(s.port, 'POST', '/token', form(fields(await go()), { authorization: basic('wrong') })))
        .status,
    ).toBe(401)
    expect(
      (
        await send(
          s.port,
          'POST',
          '/token',
          form(fields(await go()), { authorization: basic(reg.client_secret) }),
        )
      ).status,
    ).toBe(200)
    const post = form({ ...fields(await go()), client_id: reg.client_id, client_secret: reg.client_secret })
    expect((await send(s.port, 'POST', '/token', post)).status).toBe(200)
  })

  it('refuses a public client that sends a secret, an unknown client, and odd requests', async () => {
    const s = await setup()
    const { clientId, code } = await authorise(s)
    expect((await exchange(s, clientId, code, { client_secret: 'x' })).status).toBe(401)
    expect((await exchange(s, 'rcnobodynobodynobody', code)).status).toBe(401)
    const json = await send(s.port, 'POST', '/token', {
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(json.status).toBe(400)
    const twice = await send(s.port, 'POST', '/token', {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `client_id=${clientId}&client_id=${clientId}&grant_type=authorization_code`,
    })
    expect(twice.status).toBe(400)
    const grant = await send(s.port, 'POST', '/token', form({ grant_type: 'password', client_id: clientId }))
    expect(JSON.parse(grant.body).error).toBe('unsupported_grant_type')
  })
})

describe('revocation and the kill switch', () => {
  it('revoking one client ends its tokens and its registration, not another’s', async () => {
    const s = await setup()
    const a = await authorise(s)
    const b = await authorise(s)
    const ta = JSON.parse((await exchange(s, a.clientId, a.code)).body)
    const tb = JSON.parse((await exchange(s, b.clientId, b.code)).body)
    s.authorization.revokeClient(a.clientId)
    expect(s.tokens.identify(ta.access_token, RESOURCE)).toBeNull()
    expect(s.tokens.identify(tb.access_token, RESOURCE)).toBe(b.clientId)
    expect(s.clients.get(a.clientId)).toBeNull()
    expect(s.authorization.revokeAll()).toBe(1)
    expect(s.tokens.identify(tb.access_token, RESOURCE)).toBeNull()
  })

  it('pausing revokes access tokens but keeps the grant, so the client refreshes on resume', async () => {
    const s = await setup()
    const { clientId, code } = await authorise(s)
    const tokens = JSON.parse((await exchange(s, clientId, code)).body)
    await s.close()
    expect(s.tokens.identify(tokens.access_token, RESOURCE)).toBeNull()
    expect(s.clients.get(clientId)?.grant).not.toBeNull()
    expect(s.clients.refresh(clientId, tokens.refresh_token).ok).toBe(true)
  })
})

describe('pieces', () => {
  it('checks PKCE S256 only', () => {
    expect(pkceMatches(VERIFIER, CHALLENGE)).toBe(true)
    expect(pkceMatches(VERIFIER, CHALLENGE.replace(/.$/, 'A'))).toBe(false)
    expect(pkceMatches('short', CHALLENGE)).toBe(false)
    expect(pkceMatches(VERIFIER, VERIFIER)).toBe(false)
  })

  it('reads cloudflared’s address header, and nothing that isn’t an address', () => {
    const req = (value: string | undefined) => ({ headers: { 'cf-connecting-ip': value } }) as never
    expect(cloudflaredSource(req('203.0.113.4'))).toBe('203.0.113.4')
    expect(cloudflaredSource(req('2001:DB8::1'))).toBe('2001:db8::1')
    expect(cloudflaredSource(req('evil'))).toBeNull()
    expect(cloudflaredSource(req(undefined))).toBeNull()
  })

  it('makes codes from the unambiguous alphabet and reads them back forgivingly', () => {
    // 240 and above are drawn again, so every letter is equally likely.
    const draws = [Buffer.from([0, 23, 24, 239, 240, 255, 1, 2]), Buffer.from([3, 4, 5, 6, 7, 8, 9, 10])]
    expect(generateCode(() => draws.shift() as Buffer)).toBe('AZAZBCDE')
    expect(normaliseCode('azaz-bcde')).toBe('AZAZBCDE')
    expect(normaliseCode('ABCD EFGH')).toBe('ABCDEFGH')
    expect(normaliseCode('ABCDEFGO')).toBeNull()
    expect(normaliseCode('ABCDEFG1')).toBeNull()
    expect(normaliseCode('ABC')).toBeNull()
  })

  it('makes registration ids that are valid audit client ids', () => {
    expect(newRegistrationId(() => Buffer.alloc(20, 255))).toBe('rc77777777777777777777')
  })

  it('validates redirect URIs and client metadata', () => {
    expect(isHttpsRedirect('https://claude.ai/api/mcp/auth_callback')).toBe(true)
    expect(isHttpsRedirect('https://claude.ai:443/cb')).toBe(true)
    expect(isHttpsRedirect(`https://claude.ai/${'x'.repeat(600)}`)).toBe(false)
    expect(isHttpsRedirect('not a url')).toBe(false)
    expect(() => parseClientMetadata(null)).toThrow()
    expect(() => parseClientMetadata([])).toThrow()
    expect(() => parseClientMetadata({ redirect_uris: [1] })).toThrow()
    expect(parseClientMetadata({ redirect_uris: [REDIRECT], client_name: '  ' }).clientName).toBeNull()
  })

  it('restores its state, and tells the app on every change', () => {
    const saved: unknown[] = []
    const clients = new RemoteClients({ changed: (state) => saved.push(state) })
    const { registration } = clients.register(
      { redirectUris: [REDIRECT], clientName: null, authMethod: 'none' },
      null,
    )
    clients.grant(registration.id, ['woolworths.view_cart'], RESOURCE)
    const restored = new RemoteClients({ state: clients.state() })
    expect(restored.list()).toEqual(clients.list())
    expect(saved).toHaveLength(2)
    expect(clients.remove('rcnobodynobodynobody')).toBe(false)
  })

  it('adds tools to a grant it already holds, keeping its refresh token, and never makes a grant', () => {
    const clients = new RemoteClients()
    const { registration } = clients.register(
      { redirectUris: [REDIRECT], clientName: null, authMethod: 'none' },
      null,
    )
    expect(clients.addTools(registration.id, ['woolworths.view_cart'])).toBe(false)
    expect(clients.get(registration.id)?.grant).toBeNull()
    const refresh = clients.grant(registration.id, ['woolworths.view_cart'], RESOURCE)
    expect(clients.addTools(registration.id, ['woolworths.search', 'woolworths.view_cart'])).toBe(true)
    expect(clients.get(registration.id)?.grant?.tools).toEqual(['woolworths.search', 'woolworths.view_cart'])
    expect(clients.addTools(registration.id, ['Not A Tool'])).toBe(false)
    expect(clients.refresh(registration.id, refresh)).toMatchObject({ ok: true })
  })

  it('counts wrong codes afresh once nothing is pending', () => {
    let now = 0
    const consents = new ConsentRequests({ now: () => now })
    const about = { clientHost: 'claude.example', clientName: null, source: null }
    const ask = {
      clientId: 'rcx',
      redirectUri: REDIRECT,
      state: null,
      codeChallenge: CHALLENGE,
      resource: RESOURCE,
    }
    const first = consents.open(ask, about)
    consents.approve('AAAA-AAAA', [])
    consents.approve('AAAA-AAAA', [])
    consents.approve(first?.code as string, [])
    const second = consents.open(ask, about)
    consents.approve('AAAA-AAAA', [])
    expect(consents.approve(second?.code as string, []).ok).toBe(true)
    now += CONSENT_TTL_MS
    expect(consents.byHandle(second?.handle as string)).toBeNull()
    expect(consents.declineAll()).toBe(0)
    expect(consents.decline('nope')).toBe(false)
  })
})
