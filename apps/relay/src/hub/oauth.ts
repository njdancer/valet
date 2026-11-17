// The hub's OAuth 2.1 authorisation server for MCP clients (relay-hub.md, step 2), in the shape of
// the Mac's own (packages/mcp-server/src/oauth-server.ts) but on WebCrypto and the hub's SQLite:
//
// - Protected resource metadata (RFC 9728) for `<hub>/mcp`, and authorisation server metadata
//   (RFC 8414).
// - Dynamic Client Registration (RFC 7591): public clients only, redirect URIs on https or on
//   loopback, capped in number.
// - The authorisation code flow with PKCE S256 only and resource indicators (RFC 8707). `/authorize`
//   never decides: it opens a consent that shows a code in the browser. Only a signed grant from a
//   device on the account's list approves it (step 3), after the person types that code there.
//   The page polls, and the browser that opened the consent (its cookie) collects the code.
// - The token endpoint: codes are single use and live a minute; access tokens an hour; refresh
//   tokens rotate, and reusing one revokes everything minted from that consent.
//
// Every token is stored as its SHA-256 hash, tied to the grant that approved it: revoking the
// grant ends them all. Every endpoint is reachable by anyone, so each answers in fixed words and
// puts nothing a client sent into HTML.

import { z } from 'zod'
import { linkCode, sha256Hex, token } from './secrets'

export const OAUTH_TIMINGS = {
  consentMs: 10 * 60_000,
  codeMs: 60_000,
  accessMs: 60 * 60_000,
  refreshMs: 30 * 24 * 60 * 60_000,
} as const

export const OAUTH_CAPS = {
  clients: 100,
  openConsents: 20,
  redirectUris: 5,
  /**
   * Anyone can reach /register and /authorize, so one address may register only so many clients an
   * hour and hold only so many sign-ins open, and one client only so many: a flood from one place
   * can neither use up the hub's room for clients nor fill the person's list of waiting sign-ins.
   */
  registrationsPerSourcePerHour: 20,
  openConsentsPerSource: 5,
  openConsentsPerClient: 3,
} as const

/** A client nobody signed in with (no token, no sign-in on record) is forgotten after this. */
export const UNUSED_CLIENT_MS = 60 * 60_000

export const MCP_SCOPE = 'valet'
export const CONSENT_COOKIE = '__Host-valet-consent'

/** The hub's SQL, as the Durable Object runs it. */
export interface Db {
  all<T>(query: string, ...bindings: unknown[]): T[]
  one<T>(query: string, ...bindings: unknown[]): T | null
  run(query: string, ...bindings: unknown[]): void
}

interface ClientRow {
  readonly id: string
  readonly name: string
  readonly redirect_uris: string
  readonly created_at: number
  readonly source: string
}

export interface ConsentRow {
  readonly id: string
  readonly client_id: string
  readonly redirect_uri: string
  readonly challenge: string
  readonly state: string | null
  /** Shown in the browser; typed on the device that approves. */
  readonly code: string
  readonly browser_hash: string
  readonly source: string
  readonly status: 'pending' | 'approved' | 'declined' | 'used'
  readonly grant_id: string | null
  readonly created_at: number
  readonly expires_at: number
}

interface TokenRow {
  readonly hash: string
  readonly kind: 'code' | 'access' | 'refresh'
  readonly client_id: string
  readonly grant_id: string
  readonly consent_id: string
  readonly expires_at: number
  readonly used: number
}

/** Who an access token speaks for. */
export interface McpCaller {
  readonly clientId: string
  readonly grantId: string
}

/** A consent waiting for a device: what the hub hands a node to put in front of the person. */
export interface OpenConsent {
  readonly id: string
  readonly clientId: string
  readonly clientName: string
  readonly host: string
  readonly source: string
  readonly code: string
  readonly expiresAt: number
}

const PATHS = new Set([
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/mcp',
  '/.well-known/oauth-authorization-server',
  '/register',
  '/authorize',
  '/authorize/status',
  '/authorize/done',
  '/token',
])

const registration = z.object({
  redirect_uris: z.array(z.string().max(512)).min(1).max(OAUTH_CAPS.redirectUris),
  client_name: z.string().max(200).optional(),
  token_endpoint_auth_method: z.string().max(64).optional(),
  grant_types: z.array(z.string().max(64)).max(4).optional(),
  response_types: z.array(z.string().max(64)).max(4).optional(),
})

export class HubOAuth {
  constructor(
    private readonly db: Db,
    private readonly origin: () => string,
    private readonly now: () => number = Date.now,
  ) {}

  migrate(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS oauth_clients (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, redirect_uris TEXT NOT NULL, created_at INTEGER NOT NULL,
        source TEXT NOT NULL DEFAULT ''
      )`)
    // Hubs made before registrations recorded where they came from.
    try {
      this.db.one('SELECT source FROM oauth_clients LIMIT 1')
    } catch {
      this.db.run("ALTER TABLE oauth_clients ADD COLUMN source TEXT NOT NULL DEFAULT ''")
    }
    this.db.run(`
      CREATE TABLE IF NOT EXISTS oauth_consents (
        id TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, challenge TEXT NOT NULL,
        state TEXT, code TEXT NOT NULL, browser_hash TEXT NOT NULL, source TEXT NOT NULL,
        status TEXT NOT NULL, grant_id TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
      )`)
    this.db.run(`
      CREATE TABLE IF NOT EXISTS oauth_tokens (
        hash TEXT PRIMARY KEY, kind TEXT NOT NULL, client_id TEXT NOT NULL, grant_id TEXT NOT NULL,
        consent_id TEXT NOT NULL, expires_at INTEGER NOT NULL, used INTEGER NOT NULL
      )`)
  }

  handles(path: string): boolean {
    return PATHS.has(path)
  }

  get resource(): string {
    return `${this.origin()}/mcp`
  }

  /** The 401 an MCP request without a good token gets, pointing at the metadata. */
  unauthorized(): Response {
    return Response.json(
      { error: 'invalid_token', error_description: 'Sign in to Valet first.' },
      {
        status: 401,
        headers: {
          'www-authenticate': `Bearer resource_metadata="${this.origin()}/.well-known/oauth-protected-resource/mcp", scope="${MCP_SCOPE}"`,
          'cache-control': 'no-store',
        },
      },
    )
  }

  /** The caller an MCP request's bearer token speaks for, or null. */
  async authenticate(request: Request): Promise<McpCaller | null> {
    const header = request.headers.get('authorization') ?? ''
    const match = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(header)
    if (match === null) return null
    const row = this.db.one<TokenRow>(
      "SELECT * FROM oauth_tokens WHERE hash = ? AND kind = 'access'",
      await sha256Hex(match[1] as string),
    )
    if (row === null || row.expires_at <= this.now()) return null
    return { clientId: row.client_id, grantId: row.grant_id }
  }

  async fetch(request: Request, url: URL, source: string): Promise<Response> {
    this.sweep()
    const path = url.pathname
    if (request.method === 'GET') {
      if (path.startsWith('/.well-known/oauth-protected-resource')) return this.resourceMetadata()
      if (path === '/.well-known/oauth-authorization-server') return this.serverMetadata()
      if (path === '/authorize') return this.authorize(url, source)
      if (path === '/authorize/status') return this.status(request, url)
      if (path === '/authorize/done') return this.done(request, url)
    }
    if (request.method === 'POST') {
      if (path === '/register') return this.register(request, source)
      if (path === '/token') return this.token(request)
    }
    return Response.json({ error: 'not_found' }, { status: 404 })
  }

  // ---------- For the grant step ----------

  /** Consents still waiting for a device, newest first. */
  openConsents(): OpenConsent[] {
    const rows = this.db.all<ConsentRow & { client_name: string }>(
      `SELECT c.*, k.name AS client_name FROM oauth_consents c JOIN oauth_clients k ON k.id = c.client_id
       WHERE c.status = 'pending' AND c.expires_at > ? ORDER BY c.created_at DESC`,
      this.now(),
    )
    return rows.map((r) => ({
      id: r.id,
      clientId: r.client_id,
      clientName: r.client_name,
      host: new URL(r.redirect_uri).hostname,
      source: r.source,
      code: r.code,
      expiresAt: r.expires_at,
    }))
  }

  consent(id: string): OpenConsent | null {
    return this.openConsents().find((c) => c.id === id) ?? null
  }

  /** A device approved the consent with a grant the hub checked: the browser may collect its code. */
  approve(consentId: string, grantId: string): boolean {
    const row = this.db.one<ConsentRow>(
      "SELECT * FROM oauth_consents WHERE id = ? AND status = 'pending' AND expires_at > ?",
      consentId,
      this.now(),
    )
    if (row === null) return false
    this.db.run(
      "UPDATE oauth_consents SET status = 'approved', grant_id = ? WHERE id = ?",
      grantId,
      consentId,
    )
    return true
  }

  decline(consentId: string): void {
    this.db.run(
      "UPDATE oauth_consents SET status = 'declined' WHERE id = ? AND status = 'pending'",
      consentId,
    )
  }

  /** Ends every token minted under a grant. The hub may always do this: it only takes access away. */
  revokeGrant(grantId: string): void {
    this.db.run('DELETE FROM oauth_tokens WHERE grant_id = ?', grantId)
  }

  // ---------- Metadata ----------

  private resourceMetadata(): Response {
    return json({
      resource: this.resource,
      authorization_servers: [this.origin()],
      scopes_supported: [MCP_SCOPE],
      bearer_methods_supported: ['header'],
      resource_name: 'Valet',
    })
  }

  private serverMetadata(): Response {
    const origin = this.origin()
    return json({
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      registration_endpoint: `${origin}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: [MCP_SCOPE],
      authorization_response_iss_parameter_supported: true,
      client_id_metadata_document_supported: false,
    })
  }

  // ---------- Registration ----------

  private async register(request: Request, source: string): Promise<Response> {
    const parsed = registration.safeParse(await readJson(request))
    if (!parsed.success)
      return oauthError(400, 'invalid_client_metadata', 'That registration isn’t one Valet takes.')
    const meta = parsed.data
    if (meta.token_endpoint_auth_method !== undefined && meta.token_endpoint_auth_method !== 'none')
      return oauthError(400, 'invalid_client_metadata', 'Only public clients (PKCE, no secret).')
    if (!meta.redirect_uris.every(goodRedirect))
      return oauthError(400, 'invalid_redirect_uri', 'Redirects must be https, or http on this computer.')
    const now = this.now()
    const from = source.slice(0, 64)
    const recent =
      this.db.one<{ n: number }>(
        'SELECT COUNT(*) AS n FROM oauth_clients WHERE source = ? AND created_at > ?',
        from,
        now - 60 * 60_000,
      )?.n ?? 0
    if (recent >= OAUTH_CAPS.registrationsPerSourcePerHour)
      return oauthError(429, 'invalid_client_metadata', 'Too many registrations. Try again later.')
    const count = this.db.one<{ n: number }>('SELECT COUNT(*) AS n FROM oauth_clients')?.n ?? 0
    if (count >= OAUTH_CAPS.clients) return oauthError(400, 'invalid_client_metadata', 'Too many clients.')
    const id = `hc${token(16)}`
    const name = cleanName(meta.client_name) ?? new URL(meta.redirect_uris[0] as string).hostname
    this.db.run(
      'INSERT INTO oauth_clients (id, name, redirect_uris, created_at, source) VALUES (?, ?, ?, ?, ?)',
      id,
      name,
      JSON.stringify(meta.redirect_uris),
      now,
      from,
    )
    return json(
      {
        client_id: id,
        client_id_issued_at: Math.floor(now / 1000),
        client_name: name,
        redirect_uris: meta.redirect_uris,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      },
      201,
    )
  }

  // ---------- Authorisation ----------

  private async authorize(url: URL, source: string): Promise<Response> {
    const q = url.searchParams
    const client = this.client(q.get('client_id'))
    const redirect = q.get('redirect_uri')
    // Until the client and its redirect check out, nothing goes back to the redirect.
    if (client === null) return consentPage('problem', 'That app isn’t registered with Valet.', 400)
    const redirects = JSON.parse(client.redirect_uris) as string[]
    const redirectUri = redirect ?? (redirects.length === 1 ? redirects[0] : undefined)
    if (redirectUri === undefined || !redirects.includes(redirectUri))
      return consentPage('problem', 'That app asked to go back somewhere it didn’t register.', 400)
    const state = q.get('state')
    const back = (error: string) =>
      redirectTo(redirectUri, { error, ...(state === null ? {} : { state }), iss: this.origin() })
    if (q.get('response_type') !== 'code') return back('unsupported_response_type')
    const challenge = q.get('code_challenge') ?? ''
    if (q.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(challenge))
      return back('invalid_request')
    const resource = q.get('resource')
    if (resource !== null && resource !== this.resource) return back('invalid_target')
    if (state !== null && state.length > 512) return back('invalid_request')
    const now = this.now()
    const open =
      this.db.one<{ n: number }>(
        "SELECT COUNT(*) AS n FROM oauth_consents WHERE status = 'pending' AND expires_at > ?",
        now,
      )?.n ?? 0
    if (open >= OAUTH_CAPS.openConsents)
      return consentPage('problem', 'Too many sign-ins are waiting. Try again in a few minutes.', 429)
    const from = source.slice(0, 64)
    const openHere =
      this.db.one<{ n: number }>(
        "SELECT COUNT(*) AS n FROM oauth_consents WHERE status = 'pending' AND expires_at > ? AND source = ?",
        now,
        from,
      )?.n ?? 0
    const openForClient =
      this.db.one<{ n: number }>(
        "SELECT COUNT(*) AS n FROM oauth_consents WHERE status = 'pending' AND expires_at > ? AND client_id = ?",
        now,
        client.id,
      )?.n ?? 0
    if (openHere >= OAUTH_CAPS.openConsentsPerSource || openForClient >= OAUTH_CAPS.openConsentsPerClient)
      return consentPage('problem', 'Too many sign-ins are waiting. Try again in a few minutes.', 429)

    const id = token(16)
    const browser = token(32)
    const code = linkCode()
    this.db.run(
      `INSERT INTO oauth_consents (id, client_id, redirect_uri, challenge, state, code, browser_hash, source,
         status, grant_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?)`,
      id,
      client.id,
      redirectUri,
      challenge,
      state,
      code,
      await sha256Hex(browser),
      from,
      now,
      now + OAUTH_TIMINGS.consentMs,
    )
    const page = consentPage('waiting', code, 200, { id, client: client.name })
    // A __Host- cookie must say Path=/ and Secure and name no Domain, or browsers drop it.
    page.headers.append(
      'set-cookie',
      `${CONSENT_COOKIE}=${browser}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${OAUTH_TIMINGS.consentMs / 1000}`,
    )
    return page
  }

  /** What the waiting page polls: pending, approved (go to /authorize/done), declined or gone. */
  private async status(request: Request, url: URL): Promise<Response> {
    const row = await this.ownConsent(request, url.searchParams.get('id'))
    if (row === null) return json({ state: 'gone' })
    if (row.expires_at <= this.now() && row.status === 'pending') return json({ state: 'gone' })
    return json({ state: row.status === 'used' ? 'gone' : row.status })
  }

  /** The browser that opened an approved consent collects its code, once. */
  private async done(request: Request, url: URL): Promise<Response> {
    const row = await this.ownConsent(request, url.searchParams.get('id'))
    if (row === null)
      return consentPage('problem', 'That sign-in has expired. Start again from your app.', 400)
    const back = (params: Record<string, string>) =>
      redirectTo(row.redirect_uri, {
        ...params,
        ...(row.state === null ? {} : { state: row.state }),
        iss: this.origin(),
      })
    if (row.status === 'declined') {
      this.db.run("UPDATE oauth_consents SET status = 'used' WHERE id = ?", row.id)
      return back({ error: 'access_denied' })
    }
    if (row.status !== 'approved' || row.grant_id === null)
      return consentPage('problem', 'That sign-in hasn’t been approved.', 400)
    this.db.run("UPDATE oauth_consents SET status = 'used' WHERE id = ?", row.id)
    const code = token(32)
    await this.mint(code, 'code', row.client_id, row.grant_id, row.id, OAUTH_TIMINGS.codeMs)
    return back({ code })
  }

  private async ownConsent(request: Request, id: string | null): Promise<ConsentRow | null> {
    if (id === null || !/^[A-Za-z0-9_-]{10,40}$/.test(id)) return null
    const browser = cookie(request, CONSENT_COOKIE)
    if (browser === null) return null
    const row = this.db.one<ConsentRow>('SELECT * FROM oauth_consents WHERE id = ?', id)
    if (row === null || row.browser_hash !== (await sha256Hex(browser))) return null
    return row
  }

  // ---------- Tokens ----------

  private async token(request: Request): Promise<Response> {
    if (!request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded'))
      return oauthError(400, 'invalid_request', 'Send a form.')
    const text = await request.text()
    if (text.length > 16 * 1024) return oauthError(400, 'invalid_request', 'Too large.')
    const form = new URLSearchParams(text)
    const clientId = form.get('client_id')
    const client = this.client(clientId)
    if (client === null) return oauthError(401, 'invalid_client', 'Unknown client.')
    const resource = form.get('resource')
    if (resource !== null && resource !== this.resource)
      return oauthError(400, 'invalid_target', 'Wrong resource.')
    const grantType = form.get('grant_type')
    if (grantType === 'authorization_code') return this.redeemCode(client, form)
    if (grantType === 'refresh_token') return this.refresh(client, form)
    return oauthError(400, 'unsupported_grant_type', 'Unsupported grant type.')
  }

  private async redeemCode(client: ClientRow, form: URLSearchParams): Promise<Response> {
    const code = form.get('code') ?? ''
    const row = this.db.one<TokenRow>(
      "SELECT * FROM oauth_tokens WHERE hash = ? AND kind = 'code'",
      await sha256Hex(code),
    )
    if (row === null || row.client_id !== client.id || row.expires_at <= this.now())
      return oauthError(400, 'invalid_grant', 'That code isn’t good.')
    if (row.used !== 0) {
      // A code used twice: someone else has it. End everything from that consent.
      this.db.run('DELETE FROM oauth_tokens WHERE consent_id = ?', row.consent_id)
      return oauthError(400, 'invalid_grant', 'That code isn’t good.')
    }
    const consent = this.db.one<ConsentRow>('SELECT * FROM oauth_consents WHERE id = ?', row.consent_id)
    if (consent === null || form.get('redirect_uri') !== consent.redirect_uri)
      return oauthError(400, 'invalid_grant', 'That code isn’t good.')
    const verifier = form.get('code_verifier') ?? ''
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || (await s256(verifier)) !== consent.challenge)
      return oauthError(400, 'invalid_grant', 'That code isn’t good.')
    this.db.run('UPDATE oauth_tokens SET used = 1 WHERE hash = ?', row.hash)
    return this.issue(client.id, row.grant_id, row.consent_id)
  }

  private async refresh(client: ClientRow, form: URLSearchParams): Promise<Response> {
    const presented = form.get('refresh_token') ?? ''
    const row = this.db.one<TokenRow>(
      "SELECT * FROM oauth_tokens WHERE hash = ? AND kind = 'refresh'",
      await sha256Hex(presented),
    )
    if (row === null || row.client_id !== client.id || row.expires_at <= this.now())
      return oauthError(400, 'invalid_grant', 'Sign in again.')
    if (row.used !== 0) {
      // Rotation means each refresh token works once; a second use is a stolen copy.
      this.db.run('DELETE FROM oauth_tokens WHERE consent_id = ?', row.consent_id)
      return oauthError(400, 'invalid_grant', 'Sign in again.')
    }
    this.db.run('UPDATE oauth_tokens SET used = 1 WHERE hash = ?', row.hash)
    return this.issue(client.id, row.grant_id, row.consent_id)
  }

  private async issue(clientId: string, grantId: string, consentId: string): Promise<Response> {
    const access = token(32)
    const refresh = token(32)
    await this.mint(access, 'access', clientId, grantId, consentId, OAUTH_TIMINGS.accessMs)
    await this.mint(refresh, 'refresh', clientId, grantId, consentId, OAUTH_TIMINGS.refreshMs)
    return json({
      access_token: access,
      token_type: 'Bearer',
      expires_in: OAUTH_TIMINGS.accessMs / 1000,
      refresh_token: refresh,
      scope: MCP_SCOPE,
    })
  }

  private async mint(
    secret: string,
    kind: TokenRow['kind'],
    clientId: string,
    grantId: string,
    consentId: string,
    ttl: number,
  ): Promise<void> {
    this.db.run(
      'INSERT INTO oauth_tokens (hash, kind, client_id, grant_id, consent_id, expires_at, used) VALUES (?, ?, ?, ?, ?, ?, 0)',
      await sha256Hex(secret),
      kind,
      clientId,
      grantId,
      consentId,
      this.now() + ttl,
    )
  }

  private client(id: string | null): ClientRow | null {
    if (id === null || !/^hc[A-Za-z0-9_-]{10,40}$/.test(id)) return null
    return this.db.one<ClientRow>('SELECT * FROM oauth_clients WHERE id = ?', id)
  }

  private sweep(): void {
    const now = this.now()
    this.db.run('DELETE FROM oauth_tokens WHERE expires_at <= ?', now)
    this.db.run('DELETE FROM oauth_consents WHERE expires_at <= ?', now - OAUTH_TIMINGS.consentMs)
    // A registration nobody signed in with, or whose tokens have all ended, gives nothing; without
    // this, registrations alone would fill the cap for good and no agent could sign in again.
    this.db.run(
      `DELETE FROM oauth_clients WHERE created_at <= ?
         AND NOT EXISTS (SELECT 1 FROM oauth_tokens t WHERE t.client_id = oauth_clients.id)
         AND NOT EXISTS (SELECT 1 FROM oauth_consents c WHERE c.client_id = oauth_clients.id)`,
      now - UNUSED_CLIENT_MS,
    )
  }
}

// ---------- Helpers ----------

function goodRedirect(uri: string): boolean {
  let url: URL
  try {
    url = new URL(uri)
  } catch {
    return false
  }
  if (url.hash !== '' || url.username !== '' || url.password !== '') return false
  if (url.protocol === 'https:') return true
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
}

/** A client's name as shown on a consent: printable, short, or none. */
function cleanName(name: string | undefined): string | null {
  if (name === undefined) return null
  const clean = name
    .replace(/[\p{C}<>]/gu, '')
    .trim()
    .slice(0, 60)
  return clean === '' ? null : clean
}

async function s256(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
  let binary = ''
  for (const b of digest) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function cookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [key, value] = part.trim().split('=')
    if (key === name && value !== undefined && /^[A-Za-z0-9_-]{20,100}$/.test(value)) return value
  }
  return null
}

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text()
  if (text.length > 16 * 1024) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
}

function oauthError(status: number, error: string, description: string): Response {
  return json({ error, error_description: description }, status)
}

function redirectTo(uri: string, params: Record<string, string>): Response {
  const url = new URL(uri)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return new Response(null, {
    status: 302,
    headers: { location: url.toString(), 'cache-control': 'no-store' },
  })
}

/**
 * The consent page. `waiting` shows the code to type on a device and polls until a device decides;
 * `problem` shows one fixed sentence. The client's name is the only thing a client sent, and the
 * script sets it with textContent.
 */
function consentPage(
  kind: 'waiting' | 'problem',
  text: string,
  status: number,
  waiting?: { readonly id: string; readonly client: string },
): Response {
  const nonce = crypto.randomUUID().replace(/-/g, '')
  const data =
    waiting === undefined
      ? ''
      : escapeAttr(JSON.stringify({ id: waiting.id, client: waiting.client, code: text }))
  const body =
    kind === 'problem'
      ? `<h1>Valet</h1><p>${escapeText(text)}</p>`
      : `<h1>Approve this app</h1>
         <p><strong id="client"></strong> wants to use your Valet tools.</p>
         <p>On your Mac (Valet’s window) or your iPhone, approve it and type this code:</p>
         <p class="code" id="code"></p>
         <p class="muted" id="state">Waiting for you to approve…</p>`
  const script =
    kind === 'problem'
      ? ''
      : `<script nonce="${nonce}">
  const d = JSON.parse(document.body.dataset.consent)
  document.getElementById('client').textContent = d.client
  document.getElementById('code').textContent = d.code
  const state = document.getElementById('state')
  async function poll() {
    try {
      const r = await fetch('/authorize/status?id=' + encodeURIComponent(d.id), { credentials: 'same-origin' })
      const s = (await r.json()).state
      if (s === 'approved' || s === 'declined') { location.assign('/authorize/done?id=' + encodeURIComponent(d.id)); return }
      if (s === 'gone') { state.textContent = 'This sign-in has expired. Start again from your app.'; return }
    } catch {}
    setTimeout(poll, 2000)
  }
  poll()
</script>`
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Valet</title>
<style>:root{color-scheme:light dark}body{font:16px/1.5 -apple-system,system-ui,sans-serif;margin:0;padding:32px 16px}
main{max-width:32rem;margin:0 auto}.code{font:600 28px ui-monospace,Menlo,monospace;letter-spacing:.1em}.muted{opacity:.7}</style>
</head><body data-consent="${data}"><main>${body}</main>${script}</body></html>`
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
      'x-frame-options': 'DENY',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-store',
    },
  })
}

function escapeText(text: string): string {
  return text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string)
}

function escapeAttr(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  )
}
