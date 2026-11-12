// The in-app OAuth 2.1 authorisation server for remote clients (relay.md, "The authorisation
// server"; MCP authorisation, protocol revision 2025-11-25). It answers on the remote listener, in
// front of the MCP path, through http.ts's `before` hook, after the same Host and Origin guards the
// MCP path has. It speaks:
//
// - Protected resource metadata (RFC 9728) and authorisation server metadata (RFC 8414).
// - Dynamic Client Registration (RFC 7591), rate-limited and capped (oauth-clients.ts). Client ID
//   Metadata Documents are not supported yet, and the metadata says so; that needs the SSRF-safe
//   fetcher relay.md describes.
// - The authorisation code flow with PKCE S256 only, and resource indicators (RFC 8707): every
//   token is minted for one MCP URL. `/authorize` never decides: it opens a consent request
//   (oauth-consent.ts) that only the person at the Mac can approve, by typing the code the browser
//   shows.
// - The token endpoint: codes are single use and live a minute; refresh tokens rotate, and reuse
//   revokes the grant. Access tokens go into RemoteAccessTokens, which the MCP path checks.
//
// Every endpoint here is reachable by anyone who knows the public URL, so each answers in fixed
// words, puts nothing a client sent into HTML, and does as little as it can before its limit check.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isIP } from 'node:net'
import {
  digest,
  hostOf,
  parseClientMetadata,
  type Registration,
  RegistrationRefused,
  type RemoteClients,
} from './oauth-clients'
import { type ConsentRequest, type ConsentRequests, displayCode } from './oauth-consent'
import { type PageProblem, problemPage, sendPage, waitingPage } from './oauth-pages'
import { SourceLimits as Limits, type SourceLimits, type WindowLimit } from './rate-limit'
import {
  ACCESS_TOKEN_TTL_MS,
  REMOTE_SCOPE,
  type RemoteAccessTokens,
  remoteRequestHost,
  remoteResource,
} from './remote-auth'

/** Authorisation codes live a minute and are good once. */
export const AUTH_CODE_TTL_MS = 60_000
const MAX_BODY_BYTES = 16 * 1024
const MAX_STATE_LENGTH = 512
const HOUR_MS = 60 * 60_000
const DAY_MS = 24 * HOUR_MS
const MAX_PENDING_CODES = 64

/** relay.md's starting numbers for one person. Settings later, not constants. */
export const DEFAULT_OAUTH_LIMITS: OAuthLimits = {
  registerPerSource: { limit: 5, windowMs: HOUR_MS },
  registerGlobal: { limit: 20, windowMs: DAY_MS },
  authorizePerSource: { limit: 10, windowMs: HOUR_MS },
  authorizeGlobal: { limit: 30, windowMs: HOUR_MS },
  // relay.md sets none for the token endpoint; its secrets are 256-bit, so this only stops a loop.
  tokenPerSource: { limit: 120, windowMs: HOUR_MS },
  tokenGlobal: { limit: 600, windowMs: HOUR_MS },
}

export interface OAuthLimits {
  readonly registerPerSource: WindowLimit
  readonly registerGlobal: WindowLimit
  readonly authorizePerSource: WindowLimit
  readonly authorizeGlobal: WindowLimit
  readonly tokenPerSource: WindowLimit
  readonly tokenGlobal: WindowLimit
}

/** What the authorisation server reports for the audit log. */
export type OAuthAuditEvent = {
  readonly type: 'remote-token-reuse'
  readonly clientId: string
  readonly token: 'refresh' | 'code'
}

export interface RemoteAuthorizationOptions {
  readonly tokens: RemoteAccessTokens
  readonly clients: RemoteClients
  readonly consents: ConsentRequests
  readonly now?: () => number
  /** The address a request came from, as the tunnel reports it; null when unknown. */
  readonly source?: (req: IncomingMessage) => string | null
  readonly limits?: OAuthLimits
  readonly newCode?: () => string
  /** A consent request opened: the Mac shows its window. Must not throw. */
  readonly consentRequested?: (request: ConsentRequest) => void
  /** Must not throw; awaited by nothing. */
  readonly audit?: (event: OAuthAuditEvent) => void
}

interface IssuedCode {
  readonly clientId: string
  readonly redirectUri: string
  readonly codeChallenge: string
  readonly resource: string
  readonly tools: readonly string[]
  readonly expiresAt: number
  used: boolean
}

const OAUTH_PATHS = new Set([
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/mcp',
  '/.well-known/oauth-authorization-server',
  '/register',
  '/authorize',
  '/authorize/wait',
  '/token',
])

/**
 * The address cloudflared reports in `Cf-Connecting-Ip` (D14: Cloudflare Tunnel). The remote
 * listener binds 127.0.0.1, so only something on this Mac can set the header; a local process that
 * lies in it only escapes the per-source limits, and the global ones still hold.
 */
export function cloudflaredSource(req: IncomingMessage): string | null {
  const value = req.headers['cf-connecting-ip']
  if (typeof value !== 'string' || value.length > 64) return null
  const address = value.trim().toLowerCase()
  return isIP(address) === 0 ? null : address
}

export class RemoteAuthorization {
  private readonly now: () => number
  private readonly source: (req: IncomingMessage) => string | null
  private readonly newCode: () => string
  private readonly register: SourceLimits
  private readonly authorize: SourceLimits
  private readonly token: SourceLimits
  private readonly codes = new Map<string, IssuedCode>()
  /** The relay's consent ids, each standing for one waiting page's handle. */
  private readonly relayHandles = new Map<string, string>()

  constructor(private readonly options: RemoteAuthorizationOptions) {
    this.now = options.now ?? Date.now
    this.source = options.source ?? cloudflaredSource
    this.newCode = options.newCode ?? (() => randomBytes(32).toString('base64url'))
    const limits = options.limits ?? DEFAULT_OAUTH_LIMITS
    this.register = new Limits(limits.registerPerSource, limits.registerGlobal, this.now)
    this.authorize = new Limits(limits.authorizePerSource, limits.authorizeGlobal, this.now)
    this.token = new Limits(limits.tokenPerSource, limits.tokenGlobal, this.now)
  }

  /** True when the path is one of the authorisation server's. */
  static owns(url: string | undefined): boolean {
    return OAUTH_PATHS.has(pathOf(url))
  }

  /**
   * http.ts's `before` hook for the remote listener. Answers the OAuth paths (after the Host and
   * Origin guards) and returns true; leaves everything else to the MCP path's own hook.
   */
  handler(hosts: () => ReadonlySet<string>): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
    return async (req, res) => {
      if (!RemoteAuthorization.owns(req.url)) return false
      const host = remoteRequestHost(req.headers, hosts())
      if (host === null) {
        sendJson(res, 403, { error: 'forbidden' })
        return true
      }
      await this.route(req, res, host)
      return true
    }
  }

  /** Revokes everything one client holds here: its grant's refresh tokens and its access tokens. */
  revokeClient(clientId: string): void {
    this.options.clients.remove(clientId)
    this.options.tokens.revokeClient(clientId)
    for (const [hash, code] of this.codes) if (code.clientId === clientId) this.codes.delete(hash)
  }

  /** Revokes every client: registrations, grants and tokens. Returns how many clients there were. */
  revokeAll(): number {
    const count = this.options.clients.removeAll()
    this.options.tokens.revokeAll()
    this.codes.clear()
    return count
  }

  private async route(req: IncomingMessage, res: ServerResponse, host: string): Promise<void> {
    const path = pathOf(req.url)
    const method = req.method ?? 'GET'
    switch (path) {
      case '/.well-known/oauth-protected-resource':
      case '/.well-known/oauth-protected-resource/mcp':
        if (method !== 'GET') return methodNotAllowed(res, 'GET')
        return sendJson(res, 200, {
          resource: remoteResource(host),
          authorization_servers: [issuer(host)],
          bearer_methods_supported: ['header'],
          scopes_supported: [REMOTE_SCOPE],
          resource_name: 'Valet',
        })
      case '/.well-known/oauth-authorization-server':
        if (method !== 'GET') return methodNotAllowed(res, 'GET')
        return sendJson(res, 200, authorizationServerMetadata(host))
      case '/register':
        if (method !== 'POST') return methodNotAllowed(res, 'POST')
        return this.registerClient(req, res)
      case '/authorize':
        if (method !== 'GET') return methodNotAllowed(res, 'GET')
        return this.startAuthorization(req, res, host)
      case '/authorize/wait':
        if (method !== 'GET') return methodNotAllowed(res, 'GET')
        return this.wait(req, res, host)
      default:
        if (method !== 'POST') return methodNotAllowed(res, 'POST')
        return this.exchange(req, res, host)
    }
  }

  // ---------- Registration ----------

  private async registerClient(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const source = this.source(req)
    if (!this.register.take(source)) return sendJson(res, 429, { error: 'too_many_requests' })
    if (!isJson(req)) return sendJson(res, 400, { error: 'invalid_client_metadata' })
    const body = await readBody(req)
    if (body === null) return sendJson(res, 413, { error: 'invalid_client_metadata' })
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      return sendJson(res, 400, { error: 'invalid_client_metadata' })
    }
    try {
      const metadata = parseClientMetadata(parsed)
      const { registration, secret } = this.options.clients.register(metadata, source)
      return sendJson(res, 201, {
        client_id: registration.id,
        client_id_issued_at: Math.floor(registration.registeredAt / 1000),
        ...(secret === null ? {} : { client_secret: secret, client_secret_expires_at: 0 }),
        redirect_uris: registration.redirectUris,
        token_endpoint_auth_method: registration.authMethod,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        scope: REMOTE_SCOPE,
        ...(registration.clientName === null ? {} : { client_name: registration.clientName }),
      })
    } catch (error) {
      if (error instanceof RegistrationRefused && error.reason === 'full')
        return sendJson(res, 503, { error: 'temporarily_unavailable' })
      return sendJson(res, 400, { error: 'invalid_client_metadata' })
    }
  }

  // ---------- Authorisation ----------

  private async startAuthorization(req: IncomingMessage, res: ServerResponse, host: string): Promise<void> {
    const params = new URL(req.url ?? '/', 'https://valet.invalid').searchParams
    return sendOutcome(res, this.authorizeOutcome(params, host, this.source(req)))
  }

  /** The browser's waiting page asks again. Pending: the same page. Answered: on to the client. */
  private async wait(req: IncomingMessage, res: ServerResponse, host: string): Promise<void> {
    const handle = new URL(req.url ?? '/', 'https://valet.invalid').searchParams.get('h')
    return sendOutcome(res, this.waitOutcome(handle, host))
  }

  /**
   * The relay's `/authorize` (docs/relay-worker.md, "Consent"). The relay renders a fixed page from
   * the answer, so the same checks run as for the Mac's own `/authorize`, and only the shape of the
   * answer differs. The relay's id stands in for the waiting page's handle: a known id with an
   * empty query is the relay's page asking again; an unknown one with an empty query has ended.
   * Ids are the relay's random 128-bit request ids, so another browser can't poll one.
   */
  relayConsent(relayId: string, query: string, source: string | null, host: string): RelayConsentView {
    this.sweepRelayHandles()
    let outcome: AuthorizeOutcome
    if (query === '') {
      const handle = this.relayHandles.get(relayId) ?? null
      outcome =
        handle === null ? { kind: 'page', status: 404, problem: 'ended' } : this.waitOutcome(handle, host)
      if (outcome.kind !== 'waiting') this.relayHandles.delete(relayId)
    } else {
      outcome = this.authorizeOutcome(new URLSearchParams(query), host, source)
      if (outcome.kind === 'waiting') {
        if (this.relayHandles.size >= MAX_PENDING_CODES)
          this.relayHandles.delete(this.relayHandles.keys().next().value as string)
        this.relayHandles.set(relayId, outcome.handle)
      }
    }
    switch (outcome.kind) {
      case 'waiting':
        return {
          state: 'waiting',
          code: displayCode(outcome.code),
          expiresAt: new Date(outcome.expiresAt).toISOString(),
        }
      case 'redirect':
        return { state: outcome.approved ? 'approved' : 'declined', redirect: outcome.location }
      case 'page':
        switch (outcome.problem) {
          case 'ended':
            return { state: 'expired' }
          // Five already waiting: "try later", and nobody is notified (relay.md).
          case 'busy':
            return { state: query === '' ? 'busy' : 'too-many' }
          case 'too-many':
            return { state: 'too-many' }
          default:
            return { state: 'declined' }
        }
    }
  }

  private sweepRelayHandles(): void {
    for (const [id, handle] of this.relayHandles)
      if (this.options.consents.byHandle(handle) === null) this.relayHandles.delete(id)
  }

  private authorizeOutcome(params: URLSearchParams, host: string, source: string | null): AuthorizeOutcome {
    // The limit comes before anything else: no lookup, no prompt, for a flood.
    if (!this.authorize.take(source)) return { kind: 'page', status: 429, problem: 'too-many' }
    const single = (name: string): string | null => {
      const all = params.getAll(name)
      return all.length === 1 ? (all[0] as string) : null
    }
    // Until the client and its redirect URI check out, errors stay on this page (RFC 6749 4.1.2.1).
    const clientId = single('client_id')
    const registration = clientId === null ? null : this.options.clients.get(clientId)
    if (registration === null) return { kind: 'page', status: 400, problem: 'unknown-client' }
    const asked = params.getAll('redirect_uri')
    let redirectUri: string | null = null
    if (asked.length === 0 && registration.redirectUris.length === 1)
      redirectUri = registration.redirectUris[0] as string
    if (asked.length === 1 && registration.redirectUris.includes(asked[0] as string))
      redirectUri = asked[0] as string
    if (redirectUri === null) return { kind: 'page', status: 400, problem: 'bad-redirect' }

    const state = single('state')
    if (params.getAll('state').length > 1 || (state !== null && state.length > MAX_STATE_LENGTH))
      return redirectTo(redirectUri, host, { error: 'invalid_request' }, null)
    if (single('response_type') !== 'code')
      return redirectTo(redirectUri, host, { error: 'unsupported_response_type' }, state)
    const challenge = single('code_challenge')
    if (
      single('code_challenge_method') !== 'S256' ||
      challenge === null ||
      !/^[A-Za-z0-9_-]{43}$/.test(challenge)
    )
      return redirectTo(redirectUri, host, { error: 'invalid_request' }, state)
    const resources = params.getAll('resource')
    const resource = remoteResource(host)
    if (resources.length > 1 || (resources.length === 1 && resources[0] !== resource))
      return redirectTo(redirectUri, host, { error: 'invalid_target' }, state)

    const request = this.options.consents.open(
      { clientId: registration.id, redirectUri, state, codeChallenge: challenge, resource },
      { clientHost: hostOf(redirectUri), clientName: registration.clientName, source },
    )
    // Five already waiting: try later, without bothering the Mac.
    if (request === null) return { kind: 'page', status: 429, problem: 'busy' }
    try {
      this.options.consentRequested?.(request)
    } catch {
      // The app's window is not ours to fail.
    }
    return { kind: 'waiting', code: request.code, handle: request.handle, expiresAt: request.expiresAt }
  }

  private waitOutcome(handle: string | null, host: string): AuthorizeOutcome {
    const request = handle === null ? null : this.options.consents.byHandle(handle)
    if (request === null) return { kind: 'page', status: 404, problem: 'ended' }
    if (request.status === 'pending')
      return { kind: 'waiting', code: request.code, handle: request.handle, expiresAt: request.expiresAt }
    this.options.consents.finish(request.handle)
    if (request.status !== 'approved')
      return redirectTo(request.redirectUri, host, { error: 'access_denied' }, request.state)
    // The registration may have been revoked while the browser waited.
    if (this.options.clients.get(request.clientId) === null)
      return redirectTo(request.redirectUri, host, { error: 'access_denied' }, request.state)
    const code = this.newCode()
    this.sweepCodes()
    if (this.codes.size >= MAX_PENDING_CODES) return { kind: 'page', status: 429, problem: 'busy' }
    this.codes.set(digest(code), {
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge,
      resource: request.resource,
      tools: request.tools,
      expiresAt: this.now() + AUTH_CODE_TTL_MS,
      used: false,
    })
    return redirectTo(request.redirectUri, host, { code }, request.state)
  }

  // ---------- Tokens ----------

  private async exchange(req: IncomingMessage, res: ServerResponse, host: string): Promise<void> {
    if (!this.token.take(this.source(req))) return tokenError(res, 429, 'too_many_requests')
    if (!isForm(req)) return tokenError(res, 400, 'invalid_request')
    const body = await readBody(req)
    if (body === null) return tokenError(res, 413, 'invalid_request')
    const form = new URLSearchParams(body)
    for (const key of new Set(form.keys()))
      if (form.getAll(key).length > 1) return tokenError(res, 400, 'invalid_request')

    const registration = this.authenticateClient(req, form)
    if (registration === null) {
      return tokenError(res, 401, 'invalid_client', { 'www-authenticate': 'Basic realm="valet"' })
    }
    // Checked after the code is spent: a code is good once, whatever went wrong with it.
    const resource = form.get('resource')
    const wrongTarget = resource !== null && resource !== remoteResource(host)

    switch (form.get('grant_type')) {
      case 'authorization_code':
        return this.redeemCode(res, registration, form, host, wrongTarget)
      case 'refresh_token':
        if (wrongTarget) return tokenError(res, 400, 'invalid_target')
        return this.rotate(res, registration, form, host)
      default:
        return tokenError(res, 400, 'unsupported_grant_type')
    }
  }

  private async redeemCode(
    res: ServerResponse,
    registration: Registration,
    form: URLSearchParams,
    host: string,
    wrongTarget: boolean,
  ): Promise<void> {
    const code = form.get('code')
    const verifier = form.get('code_verifier')
    if (code === null || verifier === null) return tokenError(res, 400, 'invalid_request')
    this.sweepCodes()
    const issued = this.codes.get(digest(code))
    if (issued === undefined || issued.clientId !== registration.id)
      return tokenError(res, 400, 'invalid_grant')
    if (issued.used) {
      // A code presented twice: whoever has it, the grant it led to is no longer safe (RFC 6749 4.1.2).
      this.codes.delete(digest(code))
      this.options.clients.revokeGrant(registration.id)
      this.options.tokens.revokeClient(registration.id)
      this.report({ type: 'remote-token-reuse', clientId: registration.id, token: 'code' })
      return tokenError(res, 400, 'invalid_grant')
    }
    issued.used = true
    if (wrongTarget) return tokenError(res, 400, 'invalid_target')
    const redirectUri = form.get('redirect_uri')
    if (
      (redirectUri !== null && redirectUri !== issued.redirectUri) ||
      issued.resource !== remoteResource(host) ||
      !pkceMatches(verifier, issued.codeChallenge)
    )
      return tokenError(res, 400, 'invalid_grant')
    const refreshToken = this.options.clients.grant(registration.id, issued.tools, issued.resource)
    // A new grant replaces the old one; access tokens minted under it go too.
    this.options.tokens.revokeClient(registration.id)
    const accessToken = this.options.tokens.issue(registration.id, issued.resource)
    return tokenResponse(res, accessToken, refreshToken)
  }

  private async rotate(
    res: ServerResponse,
    registration: Registration,
    form: URLSearchParams,
    host: string,
  ): Promise<void> {
    const presented = form.get('refresh_token')
    if (presented === null) return tokenError(res, 400, 'invalid_request')
    if (registration.grant !== null && registration.grant.resource !== remoteResource(host))
      return tokenError(res, 400, 'invalid_grant')
    const result = this.options.clients.refresh(registration.id, presented)
    if (!result.ok) {
      if (result.reuse) {
        this.options.tokens.revokeClient(registration.id)
        this.report({ type: 'remote-token-reuse', clientId: registration.id, token: 'refresh' })
      }
      return tokenError(res, 400, 'invalid_grant')
    }
    const grant = result.registration.grant
    /* v8 ignore next -- a successful refresh always leaves a grant */
    if (grant === null) return tokenError(res, 400, 'invalid_grant')
    const accessToken = this.options.tokens.issue(registration.id, grant.resource)
    return tokenResponse(res, accessToken, result.refreshToken)
  }

  /**
   * The registration the request authenticates as: by HTTP Basic or by client_id (and secret) in
   * the body, never both. A confidential client must present its secret; a public one has none.
   */
  private authenticateClient(req: IncomingMessage, form: URLSearchParams): Registration | null {
    const basic = parseBasic(req.headers.authorization)
    const bodyId = form.get('client_id')
    const bodySecret = form.get('client_secret')
    if (req.headers.authorization !== undefined && basic === null) return null
    if (basic !== null && bodySecret !== null) return null
    if (basic !== null && bodyId !== null && bodyId !== basic.id) return null
    const id = basic?.id ?? bodyId
    if (id === null) return null
    const registration = this.options.clients.get(id)
    if (registration === null) return null
    const secret = basic?.secret ?? bodySecret
    if (registration.secretHash === null) return secret === null ? registration : null
    if (secret === null) return null
    return this.options.clients.secretMatches(registration, secret) ? registration : null
  }

  private sweepCodes(): void {
    const now = this.now()
    for (const [hash, code] of this.codes) if (now >= code.expiresAt) this.codes.delete(hash)
  }

  private report(event: OAuthAuditEvent): void {
    try {
      this.options.audit?.(event)
    } catch {
      // The app's audit is not ours to fail.
    }
  }
}

export function issuer(host: string): string {
  return `https://${host}`
}

export function authorizationServerMetadata(host: string): Record<string, unknown> {
  const base = issuer(host)
  return {
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    scopes_supported: [REMOTE_SCOPE],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: false,
  }
}

/** RFC 7636 S256: BASE64URL(SHA256(verifier)) equals the challenge. Plain is never accepted. */
export function pkceMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false
  const computed = Buffer.from(createHash('sha256').update(verifier, 'ascii').digest('base64url'))
  const expected = Buffer.from(challenge)
  return computed.length === expected.length && timingSafeEqual(computed, expected)
}

function pathOf(url: string | undefined): string {
  return (url ?? '').split('?')[0] as string
}

function parseBasic(header: string | undefined): { id: string; secret: string } | null {
  const match = /^Basic ([A-Za-z0-9+/=]+)$/i.exec(header ?? '')
  if (match === null) return null
  const decoded = Buffer.from(match[1] as string, 'base64').toString('utf8')
  const colon = decoded.indexOf(':')
  if (colon < 0) return null
  try {
    // RFC 6749 2.3.1: both parts are form-urlencoded before encoding.
    const id = decodeURIComponent(decoded.slice(0, colon).replace(/\+/g, ' '))
    const secret = decodeURIComponent(decoded.slice(colon + 1).replace(/\+/g, ' '))
    return { id, secret }
  } catch {
    return null
  }
}

function isJson(req: IncomingMessage): boolean {
  return /^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')
}

function isForm(req: IncomingMessage): boolean {
  return /^application\/x-www-form-urlencoded\s*(;|$)/i.test(req.headers['content-type'] ?? '')
}

/** The body as text, or null past MAX_BODY_BYTES (the rest is not read). */
async function readBody(req: IncomingMessage): Promise<string | null> {
  const declared = Number(req.headers['content-length'] ?? '0')
  if (declared > MAX_BODY_BYTES) return null
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) return null
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    connection: 'close',
    ...headers,
  })
  res.end(JSON.stringify(body))
}

function methodNotAllowed(res: ServerResponse, allow: string): void {
  sendJson(res, 405, { error: 'method_not_allowed' }, { allow })
}

function tokenError(
  res: ServerResponse,
  status: number,
  error: string,
  headers: Readonly<Record<string, string>> = {},
): void {
  sendJson(res, status, { error }, { pragma: 'no-cache', ...headers })
}

function tokenResponse(res: ServerResponse, accessToken: string, refreshToken: string): void {
  sendJson(
    res,
    200,
    {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      refresh_token: refreshToken,
      scope: REMOTE_SCOPE,
    },
    { pragma: 'no-cache' },
  )
}

/** What `/authorize` and its waiting page answer, before it is rendered for a browser or the relay. */
type AuthorizeOutcome =
  | { readonly kind: 'page'; readonly status: number; readonly problem: PageProblem }
  | { readonly kind: 'waiting'; readonly code: string; readonly handle: string; readonly expiresAt: number }
  | { readonly kind: 'redirect'; readonly location: string; readonly approved: boolean }

/** What the Mac answers the relay's `/authorize` with: the fields of a `consent-view` frame. */
export type RelayConsentView =
  | { readonly state: 'waiting'; readonly code: string; readonly expiresAt: string }
  | { readonly state: 'approved' | 'declined'; readonly redirect: string }
  | { readonly state: 'declined' | 'expired' | 'busy' | 'too-many' }

function redirectTo(
  redirectUri: string,
  host: string,
  params: Readonly<Record<string, string>>,
  state: string | null,
): AuthorizeOutcome {
  const target = new URL(redirectUri)
  for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value)
  if (state !== null) target.searchParams.set('state', state)
  target.searchParams.set('iss', issuer(host))
  return { kind: 'redirect', location: target.toString(), approved: params['code'] !== undefined }
}

function sendOutcome(res: ServerResponse, outcome: AuthorizeOutcome) {
  switch (outcome.kind) {
    case 'page':
      return sendPage(res, outcome.status, problemPage(outcome.problem))
    case 'waiting':
      return sendPage(res, 200, waitingPage(outcome.code, outcome.handle))
    case 'redirect':
      res.writeHead(302, {
        location: outcome.location,
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        connection: 'close',
      })
      res.end()
  }
}

export type { PageProblem }
