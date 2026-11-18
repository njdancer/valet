// The hub's Durable Object (relay-hub.md): the account, its passkeys and authenticator app, sign-in
// sessions, and the nodes (Macs) that joined it. One object for now (H5, a single account); every
// row carries its account id, so accounts can move to an object each when sharing arrives.
//
// What it keeps: the account's email, public keys of its passkeys, a password hash and the
// authenticator secret if the backup is set up, hashes of session tokens, and for each node its id,
// name, slug and when it was last seen. Never a tool call, a result or anything a site sent.

import { DurableObject } from 'cloudflare:workers'
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server'
import { KEY_ID } from '@valet/core/devices'
import { hubConsentIdSchema, signedHubGrantSchema, verifyHubGrant } from '@valet/core/hub-grant'
import { HUB_PHONE_CHALLENGE_MS, type HubPhoneAccount, hubPhoneRequestSchema } from '@valet/core/hub-phone'
import {
  HUB_MAX_GRANTS,
  HUB_MAX_OPEN_CONSENTS,
  type HubStatus,
  hubNodeNameSchema,
  hubNodeSlugSchema,
  relayAuthPayload,
} from '@valet/core/relay-protocol'
import {
  coseP256Spki,
  joinRecordDevice,
  nextRosterChange,
  PASSKEY_SIGNER,
  passkeyChallenge,
  ROSTER_MAX_PASSKEYS,
  type Roster,
  type RosterPasskey,
  rawFromDerSignature,
  rosterChangeSchema,
  rosterDeviceSchema,
  rosterWebAuthnSchema,
  type SignedRosterChange,
  signedJoinRecordSchema,
  signedRosterChangeSchema,
  verifyRoster,
} from '@valet/core/roster'
import { keyId, p256PublicKey } from '@valet/core/signing'
import { z } from 'zod'
import type { HubAnswer } from '../core'
import { fromBase64url, toBase64url } from '../encoding'
import type { Env } from '../env'
import { logFailure } from '../log'
import {
  verifyDeviceRecordSignature,
  verifyHubGrantSignature,
  verifyPasskeySignature,
  verifyRelayAuth,
  verifyRosterSignature,
} from '../verify'
import { WindowCounter } from '../window'
import { macStub } from './link'
import { HubMcp, type HubNode } from './mcp'
import { HubOAuth } from './oauth'
import { type HubPageName, hubPage } from './pages'
import {
  checkPassword,
  checkTotp,
  constantTimeEqual,
  hashPassword,
  linkCode,
  newTotpSecret,
  normaliseLinkCode,
  PASSWORD_MIN_LENGTH,
  sha256Hex,
  slugFromName,
  token,
  totpUri,
} from './secrets'

export const HUB_TIMINGS = {
  sessionMs: 30 * 24 * 60 * 60_000,
  /** Adding a node, a passkey or the authenticator app, and removing anything, need a sign-in this recent. */
  recentMs: 10 * 60_000,
  challengeMs: 5 * 60_000,
  linkCodeMs: 10 * 60_000,
} as const

export const HUB_CAPS = {
  /** Open link codes across every Mac; a Mac's new code replaces its old one. */
  openLinks: 20,
  /** Wrong link codes per account, and authenticator sign-ins per email, per 10 minutes. */
  wrongCodes: 10,
  appSignIns: 10,
  /** Passkeys and nodes per account. */
  passkeys: 20,
  nodes: 20,
  /** Phones' challenges open at once, and wrong answers to them per 10 minutes. */
  phoneChallenges: 64,
  phoneWrong: 20,
} as const

export const SESSION_COOKIE = '__Host-valet-hub'
const ISSUER = 'Valet'

interface AccountRow {
  readonly id: string
  readonly email: string
  readonly password_hash: string | null
  readonly totp_secret: string | null
  readonly totp_last_step: number | null
}

interface PasskeyRow {
  readonly id: string
  readonly account_id: string
  readonly public_key: string
  readonly counter: number
  readonly transports: string
  readonly name: string
  readonly created_at: number
  readonly last_used_at: number | null
}

interface NodeRow {
  readonly mac_id: string
  readonly account_id: string
  readonly slug: string
  readonly name: string
  readonly linked_at: number
  readonly online: number
  readonly last_seen_at: number
}

interface ChallengeRow {
  readonly id: string
  readonly kind: 'sign-up' | 'sign-in' | 'passkey' | 'app' | 'phone'
  readonly challenge: string
  readonly account_id: string | null
  readonly data: string
  readonly expires_at: number
}

interface Session {
  readonly hash: string
  readonly account: AccountRow
  readonly authedAt: number
}

class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)
const json = z.record(z.string(), z.unknown())

const BODIES = {
  signUpOptions: z.object({ setup: z.string().max(512), email: emailSchema }).strict(),
  verify: z
    .object({ challengeId: z.string().max(64), response: json, name: z.string().max(64).optional() })
    .strict(),
  appSignIn: z
    .object({ email: emailSchema, password: z.string().max(1024), code: z.string().max(16) })
    .strict(),
  appStart: z.object({ password: z.string().min(PASSWORD_MIN_LENGTH).max(1024) }).strict(),
  appConfirm: z.object({ challengeId: z.string().max(64), code: z.string().max(16) }).strict(),
  id: z.object({ id: z.string().max(1024) }).strict(),
  code: z.object({ code: z.string().max(32) }).strict(),
  link: z.object({ code: z.string().max(32), slug: hubNodeSlugSchema }).strict(),
  macId: z.object({ macId: z.string().regex(KEY_ID) }).strict(),
  internalPresence: z.object({ macId: z.string().regex(KEY_ID), online: z.boolean() }).strict(),
  internalLink: z.object({ macId: z.string().regex(KEY_ID), name: hubNodeNameSchema }).strict(),
  internalMac: z.object({ macId: z.string().regex(KEY_ID) }).strict(),
  internalRoster: z
    .object({ macId: z.string().regex(KEY_ID), changes: z.array(signedRosterChangeSchema).min(1).max(8) })
    .strict(),
  internalGrant: z.object({ macId: z.string().regex(KEY_ID), grant: signedHubGrantSchema }).strict(),
  internalDecline: z.object({ macId: z.string().regex(KEY_ID), consentId: hubConsentIdSchema }).strict(),
  internalRevoke: z
    .object({ macId: z.string().regex(KEY_ID), grantId: z.string().regex(/^[0-9a-f]{64}$/) })
    .strict(),
  internalJoin: z.object({ macId: z.string().regex(KEY_ID), record: signedJoinRecordSchema }).strict(),
  phonePrepare: z.object({ device: rosterDeviceSchema }).strict(),
  phoneFinish: z
    .object({
      payload: z.string().min(2).max(4096),
      credentialId: rosterWebAuthnSchema.shape.credentialId,
      authenticatorData: rosterWebAuthnSchema.shape.authenticatorData,
      clientDataJSON: rosterWebAuthnSchema.shape.clientDataJSON,
      /** The assertion's signature as WebAuthn gives it, ASN.1 DER, base64url. */
      signature: z
        .string()
        .min(8)
        .max(200)
        .regex(/^[A-Za-z0-9_-]+$/),
    })
    .strict(),
} as const

export class Hub extends DurableObject<Env> {
  private readonly sql: SqlStorage
  private readonly wrongCodes = new WindowCounter(HUB_CAPS.wrongCodes, 10 * 60_000, Date.now, 64)
  private readonly appSignIns = new WindowCounter(HUB_CAPS.appSignIns, 10 * 60_000, Date.now, 256)
  private readonly phoneWrong = new WindowCounter(HUB_CAPS.phoneWrong, 10 * 60_000, Date.now, 256)
  private readonly oauth: HubOAuth
  private readonly mcp: HubMcp

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    this.oauth = new HubOAuth(
      {
        all: (q, ...b) => this.all(q, ...b),
        one: (q, ...b) => this.one(q, ...b),
        run: (q, ...b) => this.run(q, ...b),
      },
      () => this.origin,
    )
    this.mcp = new HubMcp({
      forward: (macId, grantId, body, headers, signal) =>
        macStub(this.env, macId).forward(
          {
            method: 'POST',
            path: '/mcp',
            query: '',
            headers,
            body,
            source: '',
            stream: false,
            hub: { grantId },
          },
          signal,
        ),
    })
    this.migrate()
    this.oauth.migrate()
  }

  private migrate(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL,
        password_hash TEXT, totp_secret TEXT, totp_last_step INTEGER
      );
      CREATE TABLE IF NOT EXISTS passkeys (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL, public_key TEXT NOT NULL,
        counter INTEGER NOT NULL, transports TEXT NOT NULL, name TEXT NOT NULL,
        created_at INTEGER NOT NULL, last_used_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS sessions (
        hash TEXT PRIMARY KEY, account_id TEXT NOT NULL, created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL, authed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS challenges (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, challenge TEXT NOT NULL, account_id TEXT,
        data TEXT NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS nodes (
        mac_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, slug TEXT NOT NULL, name TEXT NOT NULL,
        linked_at INTEGER NOT NULL, online INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
        UNIQUE (account_id, slug)
      );
      CREATE TABLE IF NOT EXISTS link_requests (
        code TEXT PRIMARY KEY, mac_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS grants (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL, client_id TEXT NOT NULL, payload TEXT NOT NULL,
        signature TEXT NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS roster (
        account_id TEXT NOT NULL, seq INTEGER NOT NULL, payload TEXT NOT NULL, signature TEXT NOT NULL,
        PRIMARY KEY (account_id, seq)
      );
      CREATE TABLE IF NOT EXISTS roster_joins (
        mac_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, payload TEXT NOT NULL, signature TEXT NOT NULL,
        at INTEGER NOT NULL
      );
    `)
    // Step 4d: a change a passkey signed keeps its WebAuthn assertion, as JSON.
    const columns = this.all<{ name: string }>("SELECT name FROM pragma_table_info('roster')")
    if (!columns.some((c) => c.name === 'webauthn'))
      this.sql.exec('ALTER TABLE roster ADD COLUMN webauthn TEXT')
  }

  // ---------- SQL ----------

  private all<T>(query: string, ...bindings: unknown[]): T[] {
    return this.sql.exec(query, ...bindings).toArray() as T[]
  }

  private one<T>(query: string, ...bindings: unknown[]): T | null {
    return (this.all<T>(query, ...bindings)[0] as T | undefined) ?? null
  }

  private run(query: string, ...bindings: unknown[]): void {
    this.sql.exec(query, ...bindings)
  }

  private get host(): string {
    return this.env.HUB_HOST ?? ''
  }

  private get origin(): string {
    const local = this.env.HUB_ORIGIN
    return local !== undefined && /^http:\/\/localhost:\d+$/.test(local) ? local : `https://${this.host}`
  }

  private get offlineAfterMs(): number {
    const seconds = Number(this.env.HUB_OFFLINE_AFTER_S ?? '90')
    return (Number.isFinite(seconds) && seconds > 0 ? seconds : 90) * 1000
  }

  /** How long an offline node's tools stay listed, failing fast. */
  private get graceMs(): number {
    const seconds = Number(this.env.HUB_GRACE_S ?? '120')
    return (Number.isFinite(seconds) && seconds >= 0 ? seconds : 120) * 1000
  }

  // ---------- Entry ----------

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    try {
      if (url.origin === 'https://hub.internal')
        return Response.json(await this.internal(url.pathname, request))
      if (url.pathname === '/mcp') return await this.agentMcp(request)
      if (url.pathname.startsWith('/phone/')) return await this.phone(request, url.pathname)
      if (this.oauth.handles(url.pathname)) return await this.agentSignIn(request, url)
      return await this.public(request, url)
    } catch (error) {
      if (error instanceof z.ZodError)
        return Response.json(
          { error: 'bad_request', message: 'That request isn’t one the hub takes.' },
          { status: 400, headers: { 'cache-control': 'no-store' } },
        )
      if (error instanceof Refusal)
        return Response.json(
          { error: error.code, message: error.message },
          { status: error.status, headers: { 'cache-control': 'no-store' } },
        )
      logFailure('hub', error)
      return Response.json({ error: 'hub_error', message: 'Something went wrong.' }, { status: 500 })
    }
  }

  // ---------- From Macs' objects ----------

  private async internal(path: string, request: Request): Promise<HubAnswer> {
    const body = await request.json()
    const now = Date.now()
    this.sweep(now)
    switch (path) {
      case '/node/presence': {
        const { macId, online } = BODIES.internalPresence.parse(body)
        this.run('UPDATE nodes SET online = ?, last_seen_at = ? WHERE mac_id = ?', online ? 1 : 0, now, macId)
        return this.answer(macId, true)
      }
      case '/node/link-start': {
        const { macId, name } = BODIES.internalLink.parse(body)
        if (this.node(macId) !== null) return this.answer(macId, false)
        if (this.one('SELECT 1 FROM accounts LIMIT 1') === null)
          return { status: { state: 'unlinked', url: this.origin, problem: 'unavailable' } }
        this.run('DELETE FROM link_requests WHERE mac_id = ?', macId)
        const open = this.one<{ n: number }>('SELECT COUNT(*) AS n FROM link_requests')?.n ?? 0
        if (open >= HUB_CAPS.openLinks)
          return { status: { state: 'unlinked', url: this.origin, problem: 'too-many' } }
        const code = linkCode()
        this.run(
          'INSERT INTO link_requests (code, mac_id, name, expires_at) VALUES (?, ?, ?, ?)',
          code,
          macId,
          name,
          now + HUB_TIMINGS.linkCodeMs,
        )
        return this.answer(macId, false)
      }
      case '/node/unlink': {
        const { macId } = BODIES.internalMac.parse(body)
        this.run('DELETE FROM nodes WHERE mac_id = ?', macId)
        this.run('DELETE FROM link_requests WHERE mac_id = ?', macId)
        this.run('DELETE FROM roster_joins WHERE mac_id = ?', macId)
        return this.answer(macId, false)
      }
      case '/node/roster-append': {
        const { macId, changes } = BODIES.internalRoster.parse(body)
        const node = this.node(macId)
        if (node === null)
          return { ...this.answer(macId, false), roster: { changes: [], refused: 'not-linked' } }
        const refused = await this.appendRoster(node.account_id, changes)
        if (refused !== null)
          return {
            ...this.answer(macId, true),
            roster: {
              changes: this.chain(node.account_id),
              passkeys: this.rosterPasskeys(node.account_id),
              refused,
            },
          }
        await this.rosterChanged(node.account_id)
        await this.tellNodes(node.account_id, macId)
        return this.answer(macId, true)
      }
      case '/node/roster-join': {
        const { macId, record } = BODIES.internalJoin.parse(body)
        const node = this.node(macId)
        if (node === null) return this.answer(macId, false)
        await this.keepJoin(node.account_id, macId, record, now)
        return this.answer(macId, true)
      }
      case '/node/grant': {
        const { macId, grant } = BODIES.internalGrant.parse(body)
        const node = this.node(macId)
        if (node === null) return this.answer(macId, false)
        if (await this.keepGrant(node.account_id, grant, now)) await this.tellNodes(node.account_id, macId)
        return this.answer(macId, true)
      }
      case '/node/consent-decline': {
        const { macId, consentId } = BODIES.internalDecline.parse(body)
        const node = this.node(macId)
        if (node === null) return this.answer(macId, false)
        this.oauth.decline(consentId)
        await this.tellNodes(node.account_id, macId)
        return this.answer(macId, true)
      }
      case '/node/grant-revoke': {
        const { macId, grantId } = BODIES.internalRevoke.parse(body)
        const node = this.node(macId)
        if (node === null) return this.answer(macId, false)
        const held = this.one<{ id: string }>(
          'SELECT id FROM grants WHERE id = ? AND account_id = ?',
          grantId,
          node.account_id,
        )
        if (held !== null) {
          this.oauth.revokeGrant(grantId)
          this.run('DELETE FROM grants WHERE id = ?', grantId)
          await this.tellNodes(node.account_id, macId)
        }
        return this.answer(macId, true)
      }
      default:
        throw new Refusal(404, 'not_found', 'Nothing here.')
    }
  }

  // ---------- Agents signing in (oauth.ts) and their grants (hub-grant.ts) ----------

  private async agentSignIn(request: Request, url: URL): Promise<Response> {
    const source = request.headers.get('cf-connecting-ip') ?? ''
    const response = await this.oauth.fetch(request, url, source)
    // A new sign-in waits for the person: every node of the account shows it.
    if (url.pathname === '/authorize' && response.status === 200) {
      const account = this.one<{ id: string }>('SELECT id FROM accounts LIMIT 1')
      if (account !== null) await this.tellNodes(account.id, '')
    }
    return response
  }

  /** The one MCP address (mcp.ts), for an agent whose token's grant the hub still holds. */
  private async agentMcp(request: Request): Promise<Response> {
    const agent = await this.oauth.authenticate(request)
    if (agent === null) return this.oauth.unauthorized()
    const grant = this.one<{ account_id: string; client_id: string; payload: string }>(
      'SELECT account_id, client_id, payload FROM grants WHERE id = ? AND expires_at > ?',
      agent.grantId,
      Date.now(),
    )
    if (grant === null || grant.client_id !== agent.clientId) return this.oauth.unauthorized()
    let clientName = 'An agent'
    try {
      const parsed = JSON.parse(grant.payload) as { clientName?: unknown }
      if (typeof parsed.clientName === 'string') clientName = parsed.clientName
    } catch {
      // The grant was checked when kept; its name is only for the Mac's list of sessions.
    }
    const nodes = await this.nodes(grant.account_id)
    const now = Date.now()
    const listed: HubNode[] = nodes.map((n) => ({
      macId: n.macId,
      slug: n.slug,
      name: n.name,
      online: n.online,
      listed: !n.online && now < n.offlineAt + this.graceMs,
    }))
    return this.mcp.handle(request, { grantId: agent.grantId, clientName }, listed)
  }

  /**
   * Keeps a grant if a device on the account's list signed it, for a sign-in still waiting, and
   * lets that sign-in's browser collect its code. False if anything doesn't check.
   */
  private async keepGrant(
    accountId: string,
    signed: { payload: string; signature: string },
    now: number,
  ): Promise<boolean> {
    const roster = await this.verifiedRoster(accountId)
    if (roster === null) return false
    const signatures: { key: string; payload: string; signature: string }[] = []
    const check = verifyHubGrant(signed, roster, now, (key, payload, signature) => {
      signatures.push({ key, payload, signature })
      return true
    })
    if (!check.ok) return false
    for (const s of signatures)
      if (!(await verifyHubGrantSignature(s.key, s.payload, s.signature))) return false
    const consent = this.oauth.consent(check.grant.consentId)
    if (consent === null || consent.clientId !== check.grant.clientId) return false
    const count =
      this.one<{ n: number }>('SELECT COUNT(*) AS n FROM grants WHERE account_id = ?', accountId)?.n ?? 0
    if (count >= HUB_MAX_GRANTS) return false
    this.run(
      'INSERT OR REPLACE INTO grants (id, account_id, client_id, payload, signature, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      check.id,
      accountId,
      check.grant.clientId,
      signed.payload,
      signed.signature,
      Date.parse(check.grant.expiresAt),
    )
    return this.oauth.approve(check.grant.consentId, check.id)
  }

  /** The account's device list, checked here with WebCrypto; null if it doesn't check or is empty. */
  private async verifiedRoster(accountId: string): Promise<Roster | null> {
    const chain = this.chain(accountId)
    if (chain.length === 0) return null
    const check = await this.checkChain(chain)
    if (!check.ok || check.roster.account !== accountId) return null
    return check.roster
  }

  private grantsOf(accountId: string): { payload: string; signature: string }[] {
    return this.all<{ payload: string; signature: string }>(
      'SELECT payload, signature FROM grants WHERE account_id = ? AND expires_at > ? ORDER BY expires_at LIMIT ?',
      accountId,
      Date.now(),
      HUB_MAX_GRANTS,
    )
  }

  /** A Mac's status, with the account's device list if it is linked and `roster` is asked for. */
  private answer(macId: string, roster: boolean): HubAnswer {
    const status = this.statusOf(macId)
    const node = status.state === 'linked' ? this.node(macId) : null
    if (!roster || node === null) return { status }
    const consents = this.oauth.openConsents().map((c) => ({
      id: c.id,
      clientId: c.clientId,
      clientName: c.clientName,
      host: c.host,
      source: c.source,
      code: c.code,
      expiresAt: new Date(c.expiresAt).toISOString(),
    }))
    return {
      status,
      roster: { changes: this.chain(node.account_id), passkeys: this.rosterPasskeys(node.account_id) },
      consents: consents.slice(0, HUB_MAX_OPEN_CONSENTS),
      grants: this.grantsOf(node.account_id).map((g) => ({ payload: g.payload, signature: g.signature })),
    }
  }

  private statusOf(macId: string): HubStatus {
    const node = this.node(macId)
    if (node !== null) {
      const account = this.one<AccountRow>('SELECT * FROM accounts WHERE id = ?', node.account_id)
      if (account !== null)
        return {
          state: 'linked',
          url: this.origin,
          accountId: account.id,
          account: account.email,
          slug: node.slug,
          name: node.name,
        }
    }
    const request = this.one<{ code: string; expires_at: number }>(
      'SELECT code, expires_at FROM link_requests WHERE mac_id = ? AND expires_at > ?',
      macId,
      Date.now(),
    )
    if (request !== null)
      return {
        state: 'linking',
        url: this.origin,
        code: request.code,
        expiresAt: new Date(request.expires_at).toISOString(),
      }
    return { state: 'unlinked', url: this.origin }
  }

  private node(macId: string): NodeRow | null {
    return this.one<NodeRow>('SELECT * FROM nodes WHERE mac_id = ?', macId)
  }

  private sweep(now: number): void {
    this.run('DELETE FROM challenges WHERE expires_at <= ?', now)
    this.run('DELETE FROM link_requests WHERE expires_at <= ?', now)
    this.run('DELETE FROM sessions WHERE expires_at <= ?', now)
  }

  // ---------- Pages and the API ----------

  private async public(request: Request, url: URL): Promise<Response> {
    const now = Date.now()
    this.sweep(now)
    const path = url.pathname
    const session = await this.session(request, now)
    if (request.method === 'GET' && !path.startsWith('/api/')) return this.page(path, session, url)
    if (!path.startsWith('/api/')) throw new Refusal(405, 'method_not_allowed', 'Not allowed.')

    if (request.method === 'GET') {
      // Answered by this object, so a deploy can tell when the Hub itself runs the new code: the
      // Worker in front can be new while this object is still the old one.
      if (path === '/api/version')
        return Response.json({ sha: this.env.GIT_SHA ?? null }, { headers: { 'cache-control': 'no-store' } })
      if (path === '/api/me') return this.me(this.need(session), now)
      if (path === '/api/nodes')
        return Response.json({
          nodes: (await this.nodes(this.need(session).account.id)).map(({ offlineAt: _, ...n }) => n),
        })
      throw new Refusal(404, 'not_found', 'Nothing here.')
    }
    if (request.method !== 'POST') throw new Refusal(405, 'method_not_allowed', 'Not allowed.')
    // Every change comes from the hub's own pages: same origin, and JSON, which a form elsewhere can't send.
    if (request.headers.get('origin') !== this.origin)
      throw new Refusal(403, 'forbidden', 'Not from this page.')
    if (!request.headers.get('content-type')?.startsWith('application/json'))
      throw new Refusal(415, 'unsupported', 'Send JSON.')
    const body = await readJson(request)

    switch (path) {
      case '/api/sign-up/options':
        return this.signUpOptions(BODIES.signUpOptions.parse(body), now)
      case '/api/sign-up/verify':
        return this.signUpVerify(BODIES.verify.parse(body), now)
      case '/api/sign-in/options':
        return this.signInOptions(now)
      case '/api/sign-in/verify':
        return this.signInVerify(BODIES.verify.parse(body), session, now)
      case '/api/sign-in/app':
        return this.appSignIn(BODIES.appSignIn.parse(body), session, now)
      case '/api/sign-out': {
        if (session !== null) this.run('DELETE FROM sessions WHERE hash = ?', session.hash)
        return Response.json({ ok: true }, { headers: { 'set-cookie': clearCookie() } })
      }
      case '/api/passkeys/options':
        return this.passkeyOptions(this.recent(session, now), now)
      case '/api/passkeys/verify':
        return this.passkeyVerify(this.recent(session, now), BODIES.verify.parse(body), now)
      case '/api/passkeys/remove':
        return this.passkeyRemove(this.recent(session, now), BODIES.id.parse(body).id)
      case '/api/app/start':
        return this.appStart(this.recent(session, now), BODIES.appStart.parse(body), now)
      case '/api/app/confirm':
        return this.appConfirm(this.recent(session, now), BODIES.appConfirm.parse(body), now)
      case '/api/app/remove':
        return this.appRemove(this.recent(session, now))
      case '/api/nodes/preview':
        return this.linkPreview(this.need(session), BODIES.code.parse(body).code, now)
      case '/api/nodes/link':
        return this.link(this.recent(session, now), BODIES.link.parse(body), now)
      case '/api/nodes/remove':
        return this.removeNode(this.recent(session, now), BODIES.macId.parse(body).macId)
      // An iPhone signing in to the account with a passkey on its list (step 4d). No session: the
      // passkey's signature over the change adding the phone is the sign-in.
      case '/api/phone/prepare':
        return this.phonePrepare(BODIES.phonePrepare.parse(body).device, now)
      case '/api/phone/finish':
        return this.phoneFinish(BODIES.phoneFinish.parse(body))
      default:
        throw new Refusal(404, 'not_found', 'Nothing here.')
    }
  }

  private page(path: string, session: Session | null, url: URL): Response {
    const pages: Record<string, HubPageName> = {
      '/': 'home',
      '/sign-in': 'sign-in',
      '/sign-up': 'sign-up',
      '/link': 'link',
      '/security': 'security',
      '/phone': 'phone',
    }
    const name = pages[path]
    if (name === undefined) return hubPage('not-found', 404)
    const open = name === 'sign-in' || name === 'sign-up' || name === 'phone'
    if (!open && session === null) {
      const next = path === '/' ? '' : `?next=${encodeURIComponent(path)}`
      return redirect(`/sign-in${next}`)
    }
    if (name === 'sign-up' && this.one('SELECT 1 FROM accounts LIMIT 1') !== null) return redirect('/sign-in')
    if (name === 'sign-in' && session !== null) return redirect(safeNext(url.searchParams.get('next')))
    return hubPage(name, 200)
  }

  // ---------- Sessions ----------

  private async session(request: Request, now: number): Promise<Session | null> {
    const raw = readCookie(request.headers.get('cookie') ?? '', SESSION_COOKIE)
    if (raw === null || raw.length > 64) return null
    const hash = await sha256Hex(raw)
    const row = this.one<{ account_id: string; expires_at: number; authed_at: number }>(
      'SELECT account_id, expires_at, authed_at FROM sessions WHERE hash = ?',
      hash,
    )
    if (row === null || row.expires_at <= now) return null
    const account = this.one<AccountRow>('SELECT * FROM accounts WHERE id = ?', row.account_id)
    return account === null ? null : { hash, account, authedAt: row.authed_at }
  }

  private need(session: Session | null): Session {
    if (session === null) throw new Refusal(401, 'signed_out', 'Sign in first.')
    return session
  }

  /** A session whose sign-in is recent enough for changes that add or remove access. */
  private recent(session: Session | null, now: number): Session {
    const signedIn = this.need(session)
    if (now - signedIn.authedAt > HUB_TIMINGS.recentMs)
      throw new Refusal(403, 'reauth', 'Confirm it’s you: sign in again to go on.')
    return signedIn
  }

  /** Signs in: a new session, or a fresher sign-in time for the one this browser has. */
  private async startSession(accountId: string, current: Session | null, now: number): Promise<Response> {
    if (current !== null && current.account.id === accountId) {
      this.run('UPDATE sessions SET authed_at = ? WHERE hash = ?', now, current.hash)
      return Response.json({ ok: true })
    }
    if (current !== null) this.run('DELETE FROM sessions WHERE hash = ?', current.hash)
    const raw = token(32)
    this.run(
      'INSERT INTO sessions (hash, account_id, created_at, expires_at, authed_at) VALUES (?, ?, ?, ?, ?)',
      await sha256Hex(raw),
      accountId,
      now,
      now + HUB_TIMINGS.sessionMs,
      now,
    )
    return Response.json(
      { ok: true },
      {
        headers: {
          'set-cookie': `${SESSION_COOKIE}=${raw}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${HUB_TIMINGS.sessionMs / 1000}`,
        },
      },
    )
  }

  private me(session: Session, now: number): Response {
    const passkeys = this.all<PasskeyRow>(
      'SELECT * FROM passkeys WHERE account_id = ? ORDER BY created_at',
      session.account.id,
    ).map((p) => {
      const usable = rosterPasskeyKey(p)
      return {
        id: p.id,
        name: p.name,
        // Whether it can sign this account's iPhones in (step 4d), and if not, why.
        forPhones: 'publicKey' in usable ? true : usable.why,
        createdAt: iso(p.created_at),
        lastUsedAt: isoOrNull(p.last_used_at),
      }
    })
    return Response.json(
      {
        email: session.account.email,
        passkeys,
        app: session.account.totp_secret !== null,
        recent: now - session.authedAt <= HUB_TIMINGS.recentMs,
      },
      { headers: { 'cache-control': 'no-store' } },
    )
  }

  // ---------- Challenges ----------

  private saveChallenge(
    kind: ChallengeRow['kind'],
    challenge: string,
    accountId: string | null,
    data: unknown,
    now: number,
  ): string {
    const id = token(18)
    this.run(
      'INSERT INTO challenges (id, kind, challenge, account_id, data, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      id,
      kind,
      challenge,
      accountId,
      JSON.stringify(data),
      now + HUB_TIMINGS.challengeMs,
    )
    return id
  }

  /** Takes a challenge once: it is gone whether or not what answers it checks out. */
  private takeChallenge(id: string, kind: ChallengeRow['kind'], accountId: string | null, now: number) {
    const row = this.one<ChallengeRow>('SELECT * FROM challenges WHERE id = ?', id)
    if (row !== null) this.run('DELETE FROM challenges WHERE id = ?', id)
    if (row === null || row.kind !== kind || row.expires_at <= now || row.account_id !== accountId)
      throw new Refusal(400, 'expired', 'That took too long. Try again.')
    return { challenge: row.challenge, data: JSON.parse(row.data) as Record<string, unknown> }
  }

  // ---------- Sign-up: the one account (H5) ----------

  private async signUpOptions(body: z.infer<typeof BODIES.signUpOptions>, now: number): Promise<Response> {
    const secret = this.env.HUB_SETUP_SECRET ?? ''
    if (this.one('SELECT 1 FROM accounts LIMIT 1') !== null)
      throw new Refusal(403, 'closed', 'This hub already has its account. Sign in instead.')
    if (secret === '' || !constantTimeEqual(await sha256Hex(body.setup), await sha256Hex(secret)))
      throw new Refusal(403, 'wrong_setup', 'That setup code isn’t right.')
    const accountId = toBase64url(crypto.getRandomValues(new Uint8Array(16)))
    const options = await generateRegistrationOptions({
      rpName: ISSUER,
      rpID: this.host,
      userName: body.email,
      userID: fromBase64url(accountId) as Uint8Array<ArrayBuffer>,
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      supportedAlgorithmIDs: [-7, -257],
    })
    const challengeId = this.saveChallenge(
      'sign-up',
      options.challenge,
      null,
      { email: body.email, accountId },
      now,
    )
    return Response.json({ challengeId, options })
  }

  private async signUpVerify(body: z.infer<typeof BODIES.verify>, now: number): Promise<Response> {
    const { challenge, data } = this.takeChallenge(body.challengeId, 'sign-up', null, now)
    if (this.one('SELECT 1 FROM accounts LIMIT 1') !== null)
      throw new Refusal(403, 'closed', 'This hub already has its account. Sign in instead.')
    const credential = await this.verifyNewPasskey(body.response, challenge)
    const accountId = String(data['accountId'])
    this.run(
      'INSERT INTO accounts (id, email, created_at) VALUES (?, ?, ?)',
      accountId,
      String(data['email']),
      now,
    )
    this.savePasskey(accountId, credential, body.name ?? 'Passkey', now)
    return this.startSession(accountId, null, now)
  }

  private async verifyNewPasskey(response: Record<string, unknown>, challenge: string) {
    let verified: Awaited<ReturnType<typeof verifyRegistrationResponse>>
    try {
      verified = await verifyRegistrationResponse({
        response: response as never,
        expectedChallenge: challenge,
        expectedOrigin: this.origin,
        expectedRPID: this.host,
        requireUserVerification: true,
      })
    } catch {
      throw new Refusal(400, 'passkey_refused', 'That passkey couldn’t be checked. Try again.')
    }
    if (!verified.verified) throw new Refusal(400, 'passkey_refused', 'That passkey couldn’t be checked.')
    return verified.registrationInfo.credential
  }

  private savePasskey(
    accountId: string,
    credential: { id: string; publicKey: Uint8Array; counter: number; transports?: readonly string[] },
    name: string,
    now: number,
  ): void {
    if (this.one('SELECT 1 FROM passkeys WHERE id = ?', credential.id) !== null)
      throw new Refusal(409, 'passkey_exists', 'That passkey is already on this account.')
    this.run(
      'INSERT INTO passkeys (id, account_id, public_key, counter, transports, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      credential.id,
      accountId,
      toBase64url(credential.publicKey),
      credential.counter,
      JSON.stringify(credential.transports ?? []),
      name.trim() === '' ? 'Passkey' : name.trim().slice(0, 64),
      now,
    )
  }

  // ---------- Sign-in ----------

  private async signInOptions(now: number): Promise<Response> {
    // Discoverable: the browser offers this site's passkeys, so nobody learns which emails exist.
    const options = await generateAuthenticationOptions({ rpID: this.host, userVerification: 'required' })
    return Response.json({
      challengeId: this.saveChallenge('sign-in', options.challenge, null, {}, now),
      options,
    })
  }

  private async signInVerify(
    body: z.infer<typeof BODIES.verify>,
    current: Session | null,
    now: number,
  ): Promise<Response> {
    const { challenge } = this.takeChallenge(body.challengeId, 'sign-in', null, now)
    const id = typeof body.response['id'] === 'string' ? body.response['id'] : ''
    const passkey = this.one<PasskeyRow>('SELECT * FROM passkeys WHERE id = ?', id)
    if (passkey === null)
      throw new Refusal(401, 'unknown_passkey', 'That passkey isn’t on this hub’s account.')
    const publicKey = fromBase64url(passkey.public_key)
    if (publicKey === null) throw new Refusal(500, 'hub_error', 'Something went wrong.')
    let verified: Awaited<ReturnType<typeof verifyAuthenticationResponse>>
    try {
      verified = await verifyAuthenticationResponse({
        response: body.response as never,
        expectedChallenge: challenge,
        expectedOrigin: this.origin,
        expectedRPID: this.host,
        credential: {
          id: passkey.id,
          publicKey,
          counter: passkey.counter,
          transports: JSON.parse(passkey.transports),
        },
        requireUserVerification: true,
      })
    } catch {
      throw new Refusal(401, 'passkey_refused', 'That passkey couldn’t be checked. Try again.')
    }
    if (!verified.verified) throw new Refusal(401, 'passkey_refused', 'That passkey couldn’t be checked.')
    this.run(
      'UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?',
      verified.authenticationInfo.newCounter,
      now,
      passkey.id,
    )
    return this.startSession(passkey.account_id, current, now)
  }

  /** The backup: email, password and a code from the authenticator app, all three. */
  private async appSignIn(
    body: z.infer<typeof BODIES.appSignIn>,
    current: Session | null,
    now: number,
  ): Promise<Response> {
    const wrong = new Refusal(401, 'wrong', 'That email, password or code isn’t right.')
    if (!this.appSignIns.take(body.email))
      throw new Refusal(429, 'too_many', 'Too many tries. Wait 10 minutes.')
    const account = this.one<AccountRow>('SELECT * FROM accounts WHERE email = ?', body.email)
    if (account?.password_hash == null || account.totp_secret === null) {
      // The same work either way, so timing doesn't say which emails have the backup.
      await hashPassword(body.password)
      throw wrong
    }
    if (!(await checkPassword(body.password, account.password_hash))) throw wrong
    const step = await checkTotp(account.totp_secret, body.code, now, account.totp_last_step)
    if (step === null) throw wrong
    this.run('UPDATE accounts SET totp_last_step = ? WHERE id = ?', step, account.id)
    this.appSignIns.forget(body.email)
    return this.startSession(account.id, current, now)
  }

  // ---------- Passkeys ----------

  private async passkeyOptions(session: Session, now: number): Promise<Response> {
    const existing = this.all<PasskeyRow>('SELECT * FROM passkeys WHERE account_id = ?', session.account.id)
    if (existing.length >= HUB_CAPS.passkeys)
      throw new Refusal(409, 'too_many', 'This account has enough passkeys.')
    const options = await generateRegistrationOptions({
      rpName: ISSUER,
      rpID: this.host,
      userName: session.account.email,
      userID: fromBase64url(session.account.id) as Uint8Array<ArrayBuffer>,
      attestationType: 'none',
      excludeCredentials: existing.map((p) => ({ id: p.id })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      supportedAlgorithmIDs: [-7, -257],
    })
    return Response.json({
      challengeId: this.saveChallenge('passkey', options.challenge, session.account.id, {}, now),
      options,
    })
  }

  private async passkeyVerify(session: Session, body: z.infer<typeof BODIES.verify>, now: number) {
    const { challenge } = this.takeChallenge(body.challengeId, 'passkey', session.account.id, now)
    const credential = await this.verifyNewPasskey(body.response, challenge)
    this.savePasskey(session.account.id, credential, body.name ?? 'Passkey', now)
    // Its Macs put it on the account's list, so it can sign iPhones in.
    await this.tellNodes(session.account.id, '')
    return Response.json({ ok: true })
  }

  private async passkeyRemove(session: Session, id: string): Promise<Response> {
    const passkeys = this.all<PasskeyRow>('SELECT * FROM passkeys WHERE account_id = ?', session.account.id)
    if (!passkeys.some((p) => p.id === id)) throw new Refusal(404, 'not_found', 'No such passkey.')
    if (passkeys.length === 1 && session.account.totp_secret === null)
      throw new Refusal(409, 'last_way_in', 'This is your only way to sign in. Add another first.')
    this.run('DELETE FROM passkeys WHERE id = ? AND account_id = ?', id, session.account.id)
    // Its Macs take it off the account's list.
    await this.tellNodes(session.account.id, '')
    return Response.json({ ok: true })
  }

  // ---------- The authenticator-app backup ----------

  private async appStart(session: Session, body: z.infer<typeof BODIES.appStart>, now: number) {
    const secret = newTotpSecret()
    const passwordHash = await hashPassword(body.password)
    const challengeId = this.saveChallenge('app', secret, session.account.id, { passwordHash }, now)
    return Response.json({ challengeId, secret, uri: totpUri(secret, session.account.email, ISSUER) })
  }

  private async appConfirm(session: Session, body: z.infer<typeof BODIES.appConfirm>, now: number) {
    const { challenge: secret, data } = this.takeChallenge(body.challengeId, 'app', session.account.id, now)
    const step = await checkTotp(secret, body.code, now, null)
    if (step === null) throw new Refusal(400, 'wrong', 'That code isn’t right. Start again.')
    this.run(
      'UPDATE accounts SET password_hash = ?, totp_secret = ?, totp_last_step = ? WHERE id = ?',
      String(data['passwordHash']),
      secret,
      step,
      session.account.id,
    )
    return Response.json({ ok: true })
  }

  private appRemove(session: Session): Response {
    const passkeys = this.one<{ n: number }>(
      'SELECT COUNT(*) AS n FROM passkeys WHERE account_id = ?',
      session.account.id,
    )
    if ((passkeys?.n ?? 0) === 0)
      throw new Refusal(409, 'last_way_in', 'This is your only way to sign in. Add a passkey first.')
    this.run(
      'UPDATE accounts SET password_hash = NULL, totp_secret = NULL, totp_last_step = NULL WHERE id = ?',
      session.account.id,
    )
    return Response.json({ ok: true })
  }

  // ---------- Nodes ----------

  /**
   * The account's nodes, each online if its object heard from it within HUB_OFFLINE_AFTER_S, and
   * when it went (or goes) offline: a socket that closed counts from its close, one that went
   * quiet from its last frame plus that time.
   */
  private async nodes(accountId: string) {
    const rows = this.all<NodeRow>('SELECT * FROM nodes WHERE account_id = ? ORDER BY linked_at', accountId)
    const now = Date.now()
    return Promise.all(
      rows.map(async (node) => {
        let online = false
        let lastSeenAt = node.last_seen_at
        let offlineAt = node.last_seen_at
        try {
          // The Mac's object knows when it last heard a ping, even after the hub missed a close.
          const presence = await macStub(this.env, node.mac_id).presence()
          if (presence.connected && presence.lastFrameAt !== undefined) {
            lastSeenAt = Math.max(lastSeenAt, presence.lastFrameAt)
            online = now - presence.lastFrameAt < this.offlineAfterMs
            offlineAt = presence.lastFrameAt + this.offlineAfterMs
          }
        } catch (error) {
          logFailure('hub presence', error)
        }
        return {
          macId: node.mac_id,
          name: node.name,
          slug: node.slug,
          linkedAt: iso(node.linked_at),
          online,
          lastSeenAt: iso(lastSeenAt),
          offlineAt,
        }
      }),
    )
  }

  private openLink(account: AccountRow, typed: string, now: number) {
    if (!this.wrongCodes.take(account.id))
      throw new Refusal(429, 'too_many', 'Too many wrong codes. Wait 10 minutes.')
    const code = normaliseLinkCode(typed)
    const request =
      code === null
        ? null
        : this.one<{ code: string; mac_id: string; name: string; expires_at: number }>(
            'SELECT * FROM link_requests WHERE code = ? AND expires_at > ?',
            code,
            now,
          )
    if (request === null)
      throw new Refusal(
        404,
        'wrong_code',
        'That code isn’t open. Check it in Valet on your Mac, or start again there.',
      )
    this.wrongCodes.forget(account.id)
    return request
  }

  private linkPreview(session: Session, typed: string, now: number): Response {
    const request = this.openLink(session.account, typed, now)
    return Response.json({
      name: request.name,
      slug: this.freeSlug(session.account.id, slugFromName(request.name)),
    })
  }

  private async link(session: Session, body: z.infer<typeof BODIES.link>, now: number): Promise<Response> {
    const request = this.openLink(session.account, body.code, now)
    const count = this.one<{ n: number }>(
      'SELECT COUNT(*) AS n FROM nodes WHERE account_id = ?',
      session.account.id,
    )
    if ((count?.n ?? 0) >= HUB_CAPS.nodes)
      throw new Refusal(409, 'too_many', 'This account has enough nodes.')
    if (
      this.one('SELECT 1 FROM nodes WHERE account_id = ? AND slug = ?', session.account.id, body.slug) !==
      null
    )
      throw new Refusal(409, 'slug_taken', 'Another node has that short name. Pick another.')
    this.run('DELETE FROM link_requests WHERE code = ?', request.code)
    this.run(
      'INSERT INTO nodes (mac_id, account_id, slug, name, linked_at, online, last_seen_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
      request.mac_id,
      session.account.id,
      body.slug,
      request.name,
      now,
      now,
    )
    await this.tell(request.mac_id)
    return Response.json({ ok: true, macId: request.mac_id })
  }

  private async removeNode(session: Session, macId: string): Promise<Response> {
    const node = this.node(macId)
    if (node === null || node.account_id !== session.account.id)
      throw new Refusal(404, 'not_found', 'No such node.')
    this.run('DELETE FROM nodes WHERE mac_id = ?', macId)
    this.run('DELETE FROM roster_joins WHERE mac_id = ?', macId)
    await this.tell(macId)
    // The Mac that started the account's device list is its root. With that Mac gone (a Mac that
    // lost its keys comes back as a new one) and no phone on the list to carry it on, nobody left
    // could sign a change: the list and the grants signed under it go, and the next Mac starts a
    // new list. With a phone on it, the list stays, and the phone adds the next Mac (step 4c).
    // Taking things away needs no signature; adding still does.
    if (this.startedBy(node.account_id) === macId && !(await this.hasPhone(node.account_id))) {
      for (const grant of this.all<{ id: string }>(
        'SELECT id FROM grants WHERE account_id = ?',
        node.account_id,
      ))
        this.oauth.revokeGrant(grant.id)
      this.run('DELETE FROM grants WHERE account_id = ?', node.account_id)
      this.run('DELETE FROM roster WHERE account_id = ?', node.account_id)
      this.run('DELETE FROM roster_joins WHERE account_id = ?', node.account_id)
      await this.tellNodes(node.account_id, macId)
    }
    return Response.json({ ok: true })
  }

  /** The device that made the first change on the account's list, from a list the hub checked. */
  private startedBy(accountId: string): string | null {
    const first = this.one<{ payload: string }>(
      'SELECT payload FROM roster WHERE account_id = ? AND seq = 0',
      accountId,
    )
    if (first === null) return null
    try {
      const by = (JSON.parse(first.payload) as { by?: unknown }).by
      return typeof by === 'string' ? by : null
    } catch {
      return null
    }
  }

  /** Tells a Mac its new status, if it is connected; it hears it again on its next hello anyway. */
  private async tell(macId: string): Promise<void> {
    try {
      await macStub(this.env, macId).tell(this.answer(macId, true))
    } catch (error) {
      logFailure('hub tell', error)
    }
  }

  // ---------- The account's device list (roster.ts) ----------

  private chain(accountId: string): SignedRosterChange[] {
    return this.all<{ payload: string; signature: string; webauthn: string | null }>(
      'SELECT payload, signature, webauthn FROM roster WHERE account_id = ? ORDER BY seq',
      accountId,
    ).map((r) => ({
      payload: r.payload,
      signature: r.signature,
      ...(r.webauthn === null ? {} : { webauthn: JSON.parse(r.webauthn) }),
    }))
  }

  /**
   * Checks a chain's shape with core and collects its signatures, then checks each with
   * WebCrypto (core's checks use node:crypto, which the Workers runtime doesn't fully have).
   */
  private async checkChain(chain: readonly SignedRosterChange[]): Promise<ReturnType<typeof verifyRoster>> {
    const signatures: { key: string; payload: string; signature: string }[] = []
    const passkeySignatures: { key: string; data: Uint8Array; signature: string }[] = []
    const check = verifyRoster(chain, {
      verify: (key, payload, signature) => {
        signatures.push({ key, payload, signature })
        return true
      },
      verifyPasskey: (key, data, signature) => {
        passkeySignatures.push({ key, data, signature })
        return true
      },
    })
    if (!check.ok) return check
    for (const s of signatures)
      if (!(await verifyRosterSignature(s.key, s.payload, s.signature)))
        return { ok: false, at: -1, reason: 'bad-signature' }
    for (const s of passkeySignatures)
      if (!(await verifyPasskeySignature(s.key, s.data, s.signature)))
        return { ok: false, at: -1, reason: 'bad-signature' }
    return check
  }

  /**
   * The account's passkeys that can sign changes (P-256 ones), as a device puts them on the list
   * (step 4d). A Mac adds these, and removes from the list any passkey no longer here.
   */
  private rosterPasskeys(accountId: string): RosterPasskey[] {
    const out: RosterPasskey[] = []
    for (const row of this.all<PasskeyRow>(
      'SELECT * FROM passkeys WHERE account_id = ? ORDER BY created_at',
      accountId,
    )) {
      const usable = rosterPasskeyKey(row)
      // /api/me says why, on the passkeys page.
      if (!('publicKey' in usable)) continue
      const publicKey = usable.publicKey
      out.push({
        passkeyId: keyId(publicKey),
        credentialId: row.id,
        publicKey,
        rpId: this.host,
        name: (row.name.trim() || 'Passkey').slice(0, 60),
      })
    }
    return out.slice(0, ROSTER_MAX_PASSKEYS)
  }

  /**
   * Keeps the changes, all or none, if the whole chain still checks with them: each signed by a
   * device on the list (or, first, by the device adding itself), naming this account and the head
   * before it. The hub checks so it never hands out a broken chain; nodes check again, and trust
   * only their own check.
   */
  private async appendRoster(
    accountId: string,
    changes: readonly SignedRosterChange[],
  ): Promise<'conflict' | 'invalid' | null> {
    const kept = this.chain(accountId)
    const chain = [...kept, ...changes]
    const check = await this.checkChain(chain)
    if (!check.ok) return check.reason === 'broken-chain' && check.at === kept.length ? 'conflict' : 'invalid'
    if (check.roster.account !== accountId) return 'invalid'
    // Another change may have landed while the signatures were checked.
    if (
      (this.one<{ n: number }>('SELECT COUNT(*) AS n FROM roster WHERE account_id = ?', accountId)?.n ??
        0) !== kept.length
    )
      return 'conflict'
    // One synchronous run of inserts: nothing else runs in the object between them.
    for (const [i, change] of changes.entries())
      this.run(
        'INSERT INTO roster (account_id, seq, payload, signature, webauthn) VALUES (?, ?, ?, ?, ?)',
        accountId,
        kept.length + i,
        change.payload,
        change.signature,
        change.webauthn === undefined ? null : JSON.stringify(change.webauthn),
      )
    return null
  }

  /** Every node of the account hears the new list; the one that sent it hears it in its answer. */
  private async tellNodes(accountId: string, except: string): Promise<void> {
    const nodes = this.all<{ mac_id: string }>('SELECT mac_id FROM nodes WHERE account_id = ?', accountId)
    await Promise.all(nodes.filter((n) => n.mac_id !== except).map((n) => this.tell(n.mac_id)))
  }

  /** True if the account's verified list has a phone on it, which can keep it going. */
  private async hasPhone(accountId: string): Promise<boolean> {
    const roster = await this.verifiedRoster(accountId)
    return roster !== null && [...roster.devices.values()].some((d) => d.role === 'phone')
  }

  /**
   * Keeps a Mac's request to join the account's list, for its phones to read: only the Mac's own
   * record, signed by its own key, from a Mac on the account that isn't on the list yet.
   */
  private async keepJoin(
    accountId: string,
    macId: string,
    record: { payload: string; signature: string },
    now: number,
  ): Promise<boolean> {
    const roster = await this.verifiedRoster(accountId)
    if (roster === null || roster.devices.has(macId)) return false
    let signed: { key: string; payload: string; signature: string } | null = null
    const device = joinRecordDevice(record, {
      macId,
      verify: (key, payload, signature) => {
        signed = { key, payload, signature }
        return true
      },
    })
    const check = signed as { key: string; payload: string; signature: string } | null
    if (device === null || check === null) return false
    if (!(await verifyDeviceRecordSignature(check.key, check.payload, check.signature))) return false
    this.run(
      'INSERT OR REPLACE INTO roster_joins (mac_id, account_id, payload, signature, at) VALUES (?, ?, ?, ?, ?)',
      macId,
      accountId,
      record.payload,
      record.signature,
      now,
    )
    return true
  }

  /** Requests to join that are still open: from Macs still on the account and not yet on the list. */
  private joins(accountId: string, roster: Roster | null): HubPhoneAccount['joining'] {
    const rows = this.all<{ mac_id: string; payload: string; signature: string; at: number }>(
      `SELECT j.mac_id, j.payload, j.signature, j.at FROM roster_joins j
         JOIN nodes n ON n.mac_id = j.mac_id AND n.account_id = j.account_id
         WHERE j.account_id = ? ORDER BY j.at LIMIT 16`,
      accountId,
    )
    return rows
      .filter((r) => roster === null || !roster.devices.has(r.mac_id))
      .map((r) => ({
        macId: r.mac_id,
        record: { payload: r.payload, signature: r.signature },
        at: iso(r.at),
      }))
  }

  // ---------- Phones on the account (hub-phone.ts) ----------

  private async phone(request: Request, path: string): Promise<Response> {
    if (request.method !== 'POST') throw new Refusal(405, 'method_not_allowed', 'Not allowed.')
    if (!request.headers.get('content-type')?.startsWith('application/json'))
      throw new Refusal(415, 'unsupported', 'Send JSON.')
    const now = Date.now()
    this.sweep(now)
    const body = await readJson(request)
    const headers = { 'cache-control': 'no-store' }
    if (path === '/phone/challenge') {
      const open =
        this.one<{ n: number }>("SELECT COUNT(*) AS n FROM challenges WHERE kind = 'phone'")?.n ?? 0
      if (open >= HUB_CAPS.phoneChallenges)
        throw new Refusal(429, 'too_many', 'Too many requests. Wait a minute.')
      const nonce = token()
      this.run(
        "INSERT INTO challenges (id, kind, challenge, account_id, data, expires_at) VALUES (?, 'phone', ?, NULL, '', ?)",
        nonce,
        nonce,
        now + HUB_PHONE_CHALLENGE_MS,
      )
      return Response.json({ nonce, expiresAt: iso(now + HUB_PHONE_CHALLENGE_MS) }, { headers })
    }
    if (path !== '/phone/account') throw new Refusal(404, 'not_found', 'Nothing here.')
    const ask = hubPhoneRequestSchema.parse(body)
    // Counted until one checks: a device id that keeps failing is held off for a while.
    if (!this.phoneWrong.take(ask.deviceId))
      throw new Refusal(429, 'too_many', 'Too many requests. Wait a minute.')
    // Each nonce works once, whatever the answer.
    const challenge = this.one<{ id: string }>(
      "SELECT id FROM challenges WHERE id = ? AND kind = 'phone' AND expires_at > ?",
      ask.nonce,
      now,
    )
    this.run("DELETE FROM challenges WHERE id = ? AND kind = 'phone'", ask.nonce)
    const found = challenge === null ? null : await this.phoneOnList(ask.deviceId)
    const payload = relayAuthPayload({
      nonce: ask.nonce,
      relay: this.origin,
      role: 'phone',
      id: ask.deviceId,
    })
    if (found === null || !(await verifyRelayAuth(found.transportKey, payload, ask.signature)))
      throw new Refusal(401, 'not_on_account', 'This device isn’t on a Valet account here.')
    this.phoneWrong.forget(ask.deviceId)
    const accountId = found.accountId
    let refused: 'conflict' | 'invalid' | undefined
    if (ask.append !== undefined) {
      const result = await this.appendRoster(accountId, ask.append)
      if (result === null) {
        await this.rosterChanged(accountId)
        await this.tellNodes(accountId, '')
      } else refused = result
    }
    const roster = await this.verifiedRoster(accountId)
    const answer: HubPhoneAccount = {
      account: accountId,
      relay: `https://${this.env.RELAY_HOST}`,
      changes: this.chain(accountId),
      ...(refused === undefined ? {} : { refused }),
      joining: this.joins(accountId, roster),
      nodes: this.all<NodeRow>('SELECT * FROM nodes WHERE account_id = ? ORDER BY linked_at', accountId).map(
        (n) => ({ macId: n.mac_id, slug: n.slug, name: n.name, online: n.online === 1 }),
      ),
    }
    return Response.json(answer, { headers })
  }

  /**
   * The change adding this iPhone to the account's list, for one of the list's passkeys to sign.
   * This hub holds one account (H5), so the phone needn't say which.
   */
  private async phonePrepare(device: z.infer<typeof rosterDeviceSchema>, now: number): Promise<Response> {
    if (device.role !== 'phone' || device.platform !== 'ios')
      throw new Refusal(400, 'not_a_phone', 'Only an iPhone signs in here.')
    const account = this.one<{ id: string }>('SELECT id FROM accounts ORDER BY created_at LIMIT 1')
    if (account === null) throw new Refusal(404, 'no_account', 'This hub has no Valet account yet.')
    const roster = await this.verifiedRoster(account.id)
    if (roster === null)
      throw new Refusal(
        409,
        'no_list',
        'Your account has no devices yet. In Valet on your Mac, open Settings, Devices, and connect to your Valet account first.',
      )
    if (roster.devices.has(device.deviceId)) return Response.json({ already: true })
    if (roster.passkeys.size === 0)
      throw new Refusal(
        409,
        'no_passkey',
        'Valet on your Mac hasn’t put your passkey on your account yet. Open Valet on your Mac, then try again.',
      )
    const payload = nextRosterChange(roster, account.id, PASSKEY_SIGNER, { op: 'add', device }, iso(now))
    return Response.json(
      {
        payload,
        options: {
          challenge: passkeyChallenge(payload).toString('base64url'),
          rpId: this.host,
          allowCredentials: [...roster.passkeys.values()].map((p) => ({
            type: 'public-key',
            id: p.credentialId,
          })),
          userVerification: 'required',
          timeout: 120_000,
        },
      },
      { headers: { 'cache-control': 'no-store' } },
    )
  }

  /** Keeps the change if the whole list still checks with it: the passkey's signature included. */
  private async phoneFinish(body: z.infer<typeof BODIES.phoneFinish>): Promise<Response> {
    const der = fromBase64url(body.signature)
    const signature = der === null ? null : rawFromDerSignature(der)
    let parsed: unknown = null
    try {
      parsed = JSON.parse(body.payload)
    } catch {}
    const change = rosterChangeSchema.safeParse(parsed)
    if (signature === null || !change.success)
      throw new Refusal(400, 'passkey_refused', 'That passkey couldn’t be checked. Try again.')
    const accountId = change.data.account
    if (this.one('SELECT 1 FROM accounts WHERE id = ?', accountId) === null)
      throw new Refusal(400, 'passkey_refused', 'That passkey couldn’t be checked. Try again.')
    const result = await this.appendRoster(accountId, [
      {
        payload: body.payload,
        signature,
        webauthn: {
          credentialId: body.credentialId,
          authenticatorData: body.authenticatorData,
          clientDataJSON: body.clientDataJSON,
        },
      },
    ])
    if (result === 'conflict')
      throw new Refusal(409, 'conflict', 'Your account changed while you were signing in. Try again.')
    if (result === 'invalid')
      throw new Refusal(
        400,
        'passkey_refused',
        'That passkey couldn’t add this iPhone. Use the passkey you set up for your Valet account.',
      )
    this.run('UPDATE passkeys SET last_used_at = ? WHERE id = ?', Date.now(), body.credentialId)
    await this.rosterChanged(accountId)
    await this.tellNodes(accountId, '')
    return Response.json({ ok: true })
  }

  /** The account whose verified list has this phone, and the transport key it lists for it. */
  private async phoneOnList(deviceId: string): Promise<{ accountId: string; transportKey: string } | null> {
    for (const { account_id } of this.all<{ account_id: string }>('SELECT DISTINCT account_id FROM roster')) {
      const device = (await this.verifiedRoster(account_id))?.devices.get(deviceId)
      if (device !== undefined && device.role === 'phone')
        return { accountId: account_id, transportKey: device.transportKey }
    }
    return null
  }

  /** After a change to the list: requests to join from Macs now on it are done. */
  private async rosterChanged(accountId: string): Promise<void> {
    const roster = await this.verifiedRoster(accountId)
    for (const { mac_id } of this.all<{ mac_id: string }>(
      'SELECT mac_id FROM roster_joins WHERE account_id = ?',
      accountId,
    ))
      if (roster === null || roster.devices.has(mac_id))
        this.run('DELETE FROM roster_joins WHERE mac_id = ?', mac_id)
  }

  private freeSlug(accountId: string, base: string): string {
    const taken = new Set(
      this.all<{ slug: string }>('SELECT slug FROM nodes WHERE account_id = ?', accountId).map((r) => r.slug),
    )
    if (!taken.has(base)) return base
    for (let n = 2; ; n++) {
      const suffix = `-${n}`
      const slug = `${base.slice(0, 16 - suffix.length).replace(/-+$/, '')}${suffix}`
      if (!taken.has(slug)) return slug
    }
  }
}

// ---------- Helpers ----------

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text()
  if (text.length > 64 * 1024) throw new Refusal(413, 'too_large', 'Too large.')
  try {
    return JSON.parse(text)
  } catch {
    throw new Refusal(400, 'bad_json', 'Send JSON.')
  }
}

export function readCookie(header: string, name: string): string | null {
  for (const part of header.split(';')) {
    const [key, ...value] = part.trim().split('=')
    if (key === name) return value.join('=')
  }
  return null
}

function clearCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`
}

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store' } })
}

/** Only a path on this hub, never another site. */
export function safeNext(next: string | null): string {
  if (next === null || !/^\/[a-z-]*$/.test(next)) return '/'
  return next
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}

function isoOrNull(ms: number | null): string | null {
  return ms === null ? null : iso(ms)
}

/** A passkey's key as the device list takes it (P-256, base64url SPKI), or why it can't be. */
function rosterPasskeyKey(row: PasskeyRow): { readonly publicKey: string } | { readonly why: string } {
  if (row.id.length < 16 || row.id.length > 512)
    return { why: `credential id is ${row.id.length} characters` }
  const cose = fromBase64url(row.public_key)
  if (cose === null) return { why: 'stored key isn’t base64url' }
  const found = coseP256Spki(cose)
  if (!('spki' in found)) return found
  if (p256PublicKey(found.spki) === null) return { why: 'not a point on P-256' }
  return { publicKey: found.spki }
}
