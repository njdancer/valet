// Remote client registrations, their grants and their refresh tokens (relay.md, "The authorisation
// server"). This is the part of the authorisation server that outlives a restart: the app keeps the
// state() it exports in a private file, and only ever hashes of secrets are in it.
//
// - A registration comes from Dynamic Client Registration (RFC 7591). Its id is ours, made here, and
//   is both the OAuth client_id and the `remote:<id>` the audit log records. The client's own
//   client_name is kept but never trusted, and never shown as a headline.
// - A registration with no grant expires an hour after it was made. At most 50 are kept; at the cap
//   new ones are refused, and one with a grant is never evicted to make room.
// - A grant is what the person approved on the Mac: the tools ticked then, and the resource (this
//   server's MCP URL on one public name). Refresh tokens are rotated on every use. Presenting one
//   that was already rotated away is reuse: the whole grant is revoked, because either the client
//   or a thief holds a token the other has used.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { ValetError } from '@valet/core'
import { z } from 'zod'
import { isClientId } from './auth'
import { generateToken } from './token'

export const MAX_REGISTRATIONS = 50
/** A registration nobody consented to is gone after an hour (relay.md). */
export const UNCONSENTED_TTL_MS = 60 * 60_000
/**
 * Refresh tokens live 30 days from their last use. relay.md doesn't fix a number; a connector the
 * person hasn't used in a month asks for consent on the Mac again. Recorded as an assumption in
 * plan.md (D14).
 */
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60_000
/** Rotated-away refresh tokens remembered per grant, to spot reuse. */
const RETIRED_KEPT = 16
const MAX_REDIRECT_URIS = 5
const MAX_URI_LENGTH = 512
const MAX_NAME_LENGTH = 100
const MAX_TOOLS = 200

export type TokenAuthMethod = 'none' | 'client_secret_post' | 'client_secret_basic'

const sha256 = z.string().regex(/^[0-9a-f]{64}$/)
const toolRef = z.string().regex(/^[a-z][a-z0-9-]{1,63}\.[a-z][a-z0-9_]{0,63}$/)

const grantSchema = z
  .object({
    tools: z.array(toolRef).max(MAX_TOOLS),
    resource: z.string().max(MAX_URI_LENGTH),
    grantedAt: z.number().int(),
    refreshHash: sha256,
    refreshExpiresAt: z.number().int(),
    retired: z.array(sha256).max(RETIRED_KEPT),
  })
  .strict()

const registrationSchema = z
  .object({
    id: z.string().refine(isClientId),
    redirectUris: z.array(z.string().max(MAX_URI_LENGTH)).min(1).max(MAX_REDIRECT_URIS),
    clientName: z.string().max(MAX_NAME_LENGTH).nullable(),
    authMethod: z.enum(['none', 'client_secret_post', 'client_secret_basic']),
    secretHash: sha256.nullable(),
    registeredAt: z.number().int(),
    source: z.string().max(64).nullable(),
    grant: grantSchema.nullable(),
  })
  .strict()

export const remoteClientsStateSchema = z
  .object({ version: z.literal(1), registrations: z.array(registrationSchema).max(MAX_REGISTRATIONS) })
  .strict()

export type RemoteClientsState = z.infer<typeof remoteClientsStateSchema>
export type Registration = z.infer<typeof registrationSchema>
export type Grant = z.infer<typeof grantSchema>

export const EMPTY_REMOTE_CLIENTS: RemoteClientsState = { version: 1, registrations: [] }

/** What a registration looks like to the app's list: never a hash. */
export interface RemoteClientInfo {
  readonly id: string
  /** The host of the client's first redirect URI: its claimed identity, as the Mac shows it. */
  readonly host: string
  /** The client's self-chosen name. A claim; shown small, never as the headline. */
  readonly clientName: string | null
  readonly registeredAt: number
  readonly grant: { readonly tools: readonly string[]; readonly grantedAt: number } | null
}

export class RegistrationRefused extends Error {
  constructor(readonly reason: 'invalid' | 'full') {
    super(`registration refused: ${reason}`)
    this.name = 'RegistrationRefused'
  }
}

export interface RemoteClientsOptions {
  readonly state?: RemoteClientsState
  readonly now?: () => number
  readonly newId?: () => string
  readonly newSecret?: () => string
  /** The state changed and should be saved. Must not throw. */
  readonly changed?: (state: RemoteClientsState) => void
}

/** The client metadata a DCR request may carry, as accepted. Anything else in it is ignored. */
export interface ClientMetadata {
  readonly redirectUris: readonly string[]
  readonly clientName: string | null
  readonly authMethod: TokenAuthMethod
}

export interface Registered {
  readonly registration: Registration
  /** Returned once, for confidential clients; only its hash is kept. */
  readonly secret: string | null
}

export type RefreshResult =
  | { readonly ok: true; readonly registration: Registration; readonly refreshToken: string }
  | { readonly ok: false; readonly reuse: boolean }

export class RemoteClients {
  private registrations: Registration[]
  private readonly now: () => number
  private readonly newId: () => string
  private readonly newSecret: () => string

  constructor(private readonly options: RemoteClientsOptions = {}) {
    this.registrations = [...(options.state?.registrations ?? [])]
    this.now = options.now ?? Date.now
    this.newId = options.newId ?? newRegistrationId
    this.newSecret = options.newSecret ?? generateToken
  }

  /** Replaces everything with a saved state, e.g. once the app has read its file. Not saved again. */
  restore(state: RemoteClientsState): void {
    this.registrations = [...state.registrations]
  }

  state(): RemoteClientsState {
    return { version: 1, registrations: [...this.registrations] }
  }

  get(id: string): Registration | null {
    this.sweep()
    return this.registrations.find((r) => r.id === id) ?? null
  }

  list(): RemoteClientInfo[] {
    this.sweep()
    return this.registrations.map((r) => ({
      id: r.id,
      host: hostOf(r.redirectUris[0] as string),
      clientName: r.clientName,
      registeredAt: r.registeredAt,
      grant: r.grant === null ? null : { tools: r.grant.tools, grantedAt: r.grant.grantedAt },
    }))
  }

  /** Throws RegistrationRefused('full') at the cap. Metadata must already be validated. */
  register(metadata: ClientMetadata, source: string | null): Registered {
    this.sweep()
    if (this.registrations.length >= MAX_REGISTRATIONS) throw new RegistrationRefused('full')
    const id = this.newId()
    if (!isClientId(id) || this.registrations.some((r) => r.id === id))
      throw new ValetError('config', 'invalid')
    const secret = metadata.authMethod === 'none' ? null : this.newSecret()
    const registration: Registration = {
      id,
      redirectUris: [...metadata.redirectUris],
      clientName: metadata.clientName,
      authMethod: metadata.authMethod,
      secretHash: secret === null ? null : digest(secret),
      registeredAt: this.now(),
      source,
      grant: null,
    }
    this.registrations.push(registration)
    this.save()
    return { registration, secret }
  }

  /** True when the presented secret is this confidential client's. Public clients never pass here. */
  secretMatches(registration: Registration, presented: string): boolean {
    if (registration.secretHash === null) return false
    return timingSafeEqual(Buffer.from(digest(presented), 'hex'), Buffer.from(registration.secretHash, 'hex'))
  }

  /**
   * Records the person's grant (replacing any earlier one, whose refresh tokens stop working) and
   * returns the grant's first refresh token.
   */
  grant(id: string, tools: readonly string[], resource: string): string {
    const refreshToken = this.newSecret()
    this.replace(id, (r) => ({
      ...r,
      grant: {
        tools: [...new Set(tools)].sort(),
        resource,
        grantedAt: this.now(),
        refreshHash: digest(refreshToken),
        refreshExpiresAt: this.now() + REFRESH_TOKEN_TTL_MS,
        retired: [],
      },
    }))
    return refreshToken
  }

  /**
   * Rotates a refresh token. A token this grant already rotated away revokes the grant (reuse);
   * an unknown or expired one is refused without touching anything.
   */
  refresh(id: string, presented: string): RefreshResult {
    const registration = this.get(id)
    const grant = registration?.grant
    if (registration === null || grant === null || grant === undefined) return { ok: false, reuse: false }
    const hash = digest(presented)
    if (grant.retired.includes(hash)) {
      this.replace(id, (r) => ({ ...r, grant: null }))
      return { ok: false, reuse: true }
    }
    if (hash !== grant.refreshHash || this.now() >= grant.refreshExpiresAt) return { ok: false, reuse: false }
    const refreshToken = this.newSecret()
    const next = this.replace(id, (r) => ({
      ...r,
      grant: {
        ...grant,
        refreshHash: digest(refreshToken),
        refreshExpiresAt: this.now() + REFRESH_TOKEN_TTL_MS,
        retired: [hash, ...grant.retired].slice(0, RETIRED_KEPT),
      },
    }))
    return { ok: true, registration: next, refreshToken }
  }

  /**
   * Adds tools to a client's existing grant, keeping its tokens. False with no grant, a malformed
   * tool, or more tools than a grant holds.
   */
  addTools(id: string, tools: readonly string[]): boolean {
    const grant = this.get(id)?.grant
    if (grant == null) return false
    const next = [...new Set([...grant.tools, ...tools])].sort()
    if (next.length > MAX_TOOLS || tools.some((t) => !toolRef.safeParse(t).success)) return false
    this.replace(id, (r) => ({ ...r, grant: { ...grant, tools: next } }))
    return true
  }

  /** Drops a grant and its refresh tokens, keeping the registration (it expires if unused). */
  revokeGrant(id: string): void {
    if (this.get(id)?.grant == null) return
    this.replace(id, (r) => ({ ...r, grant: null }))
  }

  /** Deletes one registration with its grant. True when there was one. */
  remove(id: string): boolean {
    const before = this.registrations.length
    this.registrations = this.registrations.filter((r) => r.id !== id)
    if (this.registrations.length === before) return false
    this.save()
    return true
  }

  /** Deletes every registration. Returns how many there were. */
  removeAll(): number {
    const count = this.registrations.length
    this.registrations = []
    if (count > 0) this.save()
    return count
  }

  private replace(id: string, change: (r: Registration) => Registration): Registration {
    const index = this.registrations.findIndex((r) => r.id === id)
    if (index < 0) throw new ValetError('config', 'not-found')
    const next = change(this.registrations[index] as Registration)
    this.registrations[index] = next
    this.save()
    return next
  }

  /** Forgets unconsented registrations past their hour, and ones whose refresh token expired. */
  private sweep(): void {
    const now = this.now()
    let changed = false
    const kept: Registration[] = []
    for (const r of this.registrations) {
      // A lapsed grant takes its registration with it: the client registers and asks again.
      if (r.grant !== null && now >= r.grant.refreshExpiresAt) {
        changed = true
        continue
      }
      if (r.grant === null && now - r.registeredAt >= UNCONSENTED_TTL_MS) {
        changed = true
        continue
      }
      kept.push(r)
    }
    if (changed) {
      this.registrations = kept
      this.save()
    }
  }

  private save(): void {
    try {
      this.options.changed?.(this.state())
    } catch {
      // The app's writer is not ours to fail.
    }
  }
}

/** `rc` and 20 base32 characters: about 100 bits, and a valid client id for the audit log. */
export function newRegistrationId(random: (size: number) => Buffer = randomBytes): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
  const bytes = random(20)
  let out = 'rc'
  for (const byte of bytes) out += alphabet[byte & 31]
  return out
}

export function hostOf(uri: string): string {
  try {
    return new URL(uri).hostname
  } catch {
    return 'unknown'
  }
}

/**
 * Validates DCR metadata (RFC 7591) by relay.md's rules: HTTPS redirect URIs with a DNS name, no
 * userinfo, no fragment, at most 512 characters each and five in all; only the code flow; a name
 * flattened and capped. Throws RegistrationRefused('invalid').
 */
export function parseClientMetadata(body: unknown): ClientMetadata {
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    throw new RegistrationRefused('invalid')
  const input = body as Record<string, unknown>
  const uris = input['redirect_uris']
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS)
    throw new RegistrationRefused('invalid')
  const redirectUris = uris.map((uri) => {
    if (typeof uri !== 'string' || !isHttpsRedirect(uri)) throw new RegistrationRefused('invalid')
    return uri
  })
  const grantTypes = input['grant_types'] ?? ['authorization_code']
  if (
    !Array.isArray(grantTypes) ||
    !grantTypes.includes('authorization_code') ||
    grantTypes.some((g) => g !== 'authorization_code' && g !== 'refresh_token')
  )
    throw new RegistrationRefused('invalid')
  const responseTypes = input['response_types'] ?? ['code']
  if (!Array.isArray(responseTypes) || responseTypes.some((r) => r !== 'code'))
    throw new RegistrationRefused('invalid')
  const method = input['token_endpoint_auth_method'] ?? 'client_secret_basic'
  if (method !== 'none' && method !== 'client_secret_post' && method !== 'client_secret_basic')
    throw new RegistrationRefused('invalid')
  return { redirectUris, clientName: flattenName(input['client_name']), authMethod: method }
}

export function isHttpsRedirect(uri: string): boolean {
  if (uri.length > MAX_URI_LENGTH) return false
  let parsed: URL
  try {
    parsed = new URL(uri)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  if (parsed.username !== '' || parsed.password !== '' || parsed.hash !== '' || uri.includes('#'))
    return false
  const host = parsed.hostname
  // A DNS name with a dot, not an IP literal of any spelling (URL normalises decimal and hex IPv4).
  if (host.startsWith('[') || /^[0-9.]+$/.test(host) || !host.includes('.')) return false
  return parsed.port === '' || parsed.port === '443'
}

function flattenName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const flat = value
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LENGTH)
  return flat.length === 0 ? null : flat
}

export function digest(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex')
}
