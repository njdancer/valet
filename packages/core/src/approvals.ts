// Approval requests and signed decisions (docs/agent-run-security.md#approvals).
//
// The Mac builds every request: its kind, its tier and its subject come from the Mac's own
// knowledge, never from what an agent asked for. The Mac serialises the request once
// (`requestText`); each device renders its card by parsing that exact text and signs over its
// digest, so what the person saw and what the Mac checks are the same bytes.
//
// An approval counts only if a paired, unrevoked device's approval key (Secure Enclave, unlocked
// by Face ID or Touch ID) signed it, for this Mac, for this pending request, before it expired.
// A decline needs no signature: any authenticated surface may decline.

import { z } from 'zod'
import { type DeviceLookup, type DeviceRole, keyIdSchema } from './devices'
import { displayText } from './display-text'
import { canonicalJson } from './hash'
import { manifestPermissionChangeSchema } from './permission-change'
import { domainDigest, SIGNING_DOMAINS, type SignedText, signedTextSchema, verifyP256 } from './signing'

const hash = z.string().regex(/^[0-9a-f]{64}$/)
const adapterId = z.string().regex(/^[a-z][a-z0-9-]{1,63}$/)
const name = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)
const origin = z.string().regex(/^https:\/\/[a-z0-9.-]+(?::\d{1,5})?$/)
/** A client's id as its credential names it: `local:<id>` or `remote:<id>`. */

/**
 * The consent code: eight letters from 24 (no I or O), shown only in the browser that started a
 * remote client's flow and typed by the person on the Mac or a paired phone. Letters only, so a
 * phone keyboard needs no switching (A's IA section 10); about 36.7 bits, and three wrong codes
 * cancel every pending consent. Typed input is upper-cased and the hyphen added before checking.
 */
export const CONSENT_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
export const consentCodeSchema = z.string().regex(/^[A-HJ-NP-Z]{4}-[A-HJ-NP-Z]{4}$/)

export const clientIdSchema = z.string().regex(/^(?:local|remote):[A-Za-z0-9_-]{1,64}$/)
/** A tool as `<adapterId>.<tool>`. */
const qualifiedTool = z.string().regex(/^[a-z][a-z0-9-]{1,63}\.[a-z][a-z0-9_]{0,63}$/)
/** An IPv4 or IPv6 address as the relay or tunnel reported it. */
const address = z.string().regex(/^[0-9A-Fa-f:.]{2,45}$/)
/** A random 128-bit id, base64url. */
export const requestIdSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/)

/**
 * The four tiers (D74). Only the last two ever produce an ApprovalRequest; `none` and `notify`
 * are listed so every action has a tier in one table (admin-actions.ts).
 */
export const APPROVAL_TIERS = ['none', 'notify', 'approve', 'approve-each-use'] as const
export type ApprovalTier = (typeof APPROVAL_TIERS)[number]

const subjects = {
  /**
   * Install a new adapter, update one, or roll one back. Shows the diff against what is active.
   * `adapterName`, every exception `purpose` and the unsandboxed reason come from the adapter's
   * manifest, which the agent wrote: cards show them as "the adapter says", never as a headline.
   */
  'adapter-install': z
    .object({
      adapterId,
      adapterName: displayText(80),
      version: z.string().regex(/^\d+\.\d+\.\d+$/),
      adapterHash: hash,
      packageHash: hash,
      /** The approved hash this replaces; null for a first install. */
      previousHash: hash.nullable(),
      /** `builtin`: a built-in adapter's new version, shipped with a new app version (D's ask). */
      source: z.enum(['draft', 'local-folder', 'rollback', 'builtin']),
      /** True if this replaces an adapter that has a signed-in session or grants (it inherits it). */
      inheritsSession: z.boolean(),
      /** Reference adapters the agent says it read. A claim, shown as one. */
      references: z.array(z.url({ protocol: /^https$/ }).max(500)).max(10),
      /** Computed by the Mac from the two manifests, never written by the agent. */
      changes: z.array(manifestPermissionChangeSchema).max(200),
      /** True if the code runs without the sandbox (D73); shown as critical, Mac only. */
      unsandboxed: z.boolean(),
    })
    .strict()
    .refine(
      // One direction only: an adapter that was already unsandboxed has no sandbox-mode line on
      // its update, and is still unsandboxed. The Mac sets `unsandboxed` from the new manifest,
      // and before the sandbox ships, for every adapter that isn't built in.
      (s) => s.unsandboxed || !s.changes.some((c) => c.area === 'sandbox-mode' && c.risk === 'critical'),
      'a critical sandbox-mode line means unsandboxed',
    ),
  /** Let an adapter's login use a secret, typed only into these origins. */
  'secret-grant': z
    .object({
      adapterId,
      adapterHash: hash,
      secret: name,
      fields: z
        .array(z.enum(['username', 'password', 'otp']))
        .min(1)
        .max(3),
      provider: z.enum(['keychain-copy', 'onepassword-service-account', 'onepassword-desktop', 'messages']),
      /** The item's title as the provider shows it; never its reference or contents. */
      itemTitle: displayText(120),
      /** First 16 hex of SHA-256 of the item reference: tells two items with one title apart. */
      itemFingerprint: z.string().regex(/^[0-9a-f]{16}$/),
      origins: z.array(origin).min(1).max(10),
    })
    .strict(),
  /**
   * Turn a tool on: locally (after someone turned it off), or for remote clients, all of them or
   * one (`clientId`).
   */
  'tool-enable': z
    .object({
      adapterId,
      /** The version enabled. An update starts with the tool off again for remote clients. */
      adapterHash: hash,
      tool: name,
      scope: z.enum(['local', 'remote']),
      clientId: clientIdSchema.nullable(),
      sideEffect: z.enum(['read', 'write', 'irreversible']),
    })
    .strict(),
  /** A remote MCP client asking to connect (D80): the host, the address, the tools it will see. */
  'remote-client': z
    .object({
      clientId: clientIdSchema,
      /** The redirect URI's host: a claim by the client. */
      host: z.string().regex(/^[a-z0-9.-]{1,253}$/),
      /** As the relay or tunnel reported it: a claim, shown as one. */
      sourceAddress: address.nullable(),
      // No code here: the request is what the device renders, and the person must type the code
      // from the browser that started the flow, never compare it (relay.md, "Consent happens on
      // the Mac or a paired phone"). The Mac keeps the code beside the pending request.
      tools: z.array(qualifiedTool).max(200),
      /**
       * What else this remote agent may do beyond Use tools (A's capabilities), each unticked by
       * default and granted only by this signature. Kept in the trusted ledger (F's design).
       */
      capabilities: z
        .array(z.enum(['see-valet', 'ask-for-changes']))
        .max(2)
        .refine((c) => new Set(c).size === c.length, 'each at most once')
        .optional(),
    })
    .strict(),
  /** A setting that loosens something. Values are shown, never secrets (settings hold none). */
  setting: z
    .object({
      scope: z.enum(['valet', 'adapter']),
      adapterId: adapterId.nullable(),
      setting: name,
      label: displayText(80),
      from: displayText(120),
      to: displayText(120),
      /**
       * When the person picks the value on the card (a store, J8b): the values offered. The
       * signed decision then names the one picked (`choice`), and `to` is ignored.
       */
      choices: z
        .array(z.object({ value: z.string().min(1).max(200), label: displayText(120) }).strict())
        .min(2)
        .max(50)
        .optional(),
    })
    .strict(),
  /** An agent driving a signed-in session for authoring or repair (D81), for at most this long. */
  'authoring-session': z
    .object({
      adapterId,
      draftId: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
      origins: z.array(origin).min(1).max(10),
      minutes: z.number().int().min(1).max(60),
    })
    .strict(),
  /**
   * A draft's scratch browser or live trial reaching one private address (A's Private network
   * card, R21). Without it both refuse every private, loopback, link-local and tailnet address,
   * by relay.md's fetch rules. Lasts for one authoring session's length at most.
   */
  'private-network': z
    .object({
      adapterId,
      draftId: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
      address,
      port: z.number().int().min(1).max(65535).nullable(),
      minutes: z.number().int().min(1).max(60),
    })
    .strict(),
  /** One run of an irreversible tool, such as placing an order (D46). Never cached. */
  'irreversible-call': z
    .object({
      adapterId,
      adapterHash: hash,
      tool: name,
      callId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
      /**
       * Which `ctx.confirm` question in the call this is (D's review): two questions in one call
       * must never share a request, or approving one could answer the other.
       */
      confirmationId: z.string().regex(/^cf_[A-Za-z0-9_-]{1,60}$/),
      /** The input as the runtime rendered it, one line per part. */
      preview: z.array(displayText(200)).max(20),
    })
    .strict(),
  /** Take Valet out of pause or lockdown. */
  resume: z.object({ from: z.enum(['paused', 'lockdown']) }).strict(),
  /** Pair a new phone. Mac only: a phone can never add a device. */
  'device-pair': z
    .object({
      deviceId: keyIdSchema,
      deviceName: displayText(60),
      platform: z.enum(['ios', 'macos']),
      /** Six digits both screens show, from the pairing transcript. */
      confirmation: z.string().regex(/^\d{6}$/),
    })
    .strict(),
} as const

export const APPROVAL_KINDS = Object.keys(subjects) as readonly (keyof typeof subjects)[]
export type ApprovalKind = keyof typeof subjects
export type ApprovalSubject<K extends ApprovalKind = ApprovalKind> = z.infer<(typeof subjects)[K]>

/**
 * Where each kind may be approved. The phone can approve everything except adding a device and
 * running unsandboxed code, which defeats every other guarantee; those need the person at the Mac.
 */
export function approvableOn(kind: ApprovalKind, subject: ApprovalSubject): readonly DeviceRole[] {
  // Pairing, and lifting a pause or lockdown: a stolen phone must not undo the person's own stop.
  if (kind === 'device-pair' || kind === 'resume') return ['mac']
  if (kind === 'adapter-install') {
    const install = subject as ApprovalSubject<'adapter-install'>
    // Anything critical (unsandboxed, a command exception) is as good as unsandboxed: Mac only.
    if (install.unsandboxed || install.changes.some((c) => c.risk === 'critical')) return ['mac']
  }
  return ['mac', 'phone']
}

/** Kinds that are never remembered, so never valid as stored evidence. */
export const NEVER_STORED: readonly ApprovalKind[] = ['irreversible-call', 'device-pair']

/** The tier each kind is approved at. */
export const KIND_TIER: Readonly<Record<ApprovalKind, 'approve' | 'approve-each-use'>> = {
  'adapter-install': 'approve',
  'secret-grant': 'approve',
  'tool-enable': 'approve',
  'remote-client': 'approve',
  setting: 'approve',
  'authoring-session': 'approve',
  'private-network': 'approve',
  'irreversible-call': 'approve-each-use',
  resume: 'approve',
  'device-pair': 'approve',
}

/** How long a request stays answerable. An irreversible call keeps the confirmation's own limit. */
export const APPROVAL_TTL_MS: Readonly<Record<ApprovalKind, number>> = {
  'adapter-install': 24 * 3600_000,
  'secret-grant': 24 * 3600_000,
  'tool-enable': 24 * 3600_000,
  'remote-client': 10 * 60_000,
  setting: 24 * 3600_000,
  'authoring-session': 30 * 60_000,
  'private-network': 30 * 60_000,
  'irreversible-call': 2 * 60_000,
  resume: 10 * 60_000,
  'device-pair': 5 * 60_000,
}

/** Limits against approval fatigue (docs/agent-run-security.md#approval-tiers). */
export const APPROVAL_LIMITS = {
  pendingPerClient: 3,
  /** Across all agents (A's card spec). Remote-client consents don't count here. */
  pendingTotal: 5,
  /** Remote-client consents waiting at once, in their own bucket (relay.md, D's ask 7). */
  consentPending: 5,
  /** `/authorize` opens from one source address in an hour, before any card is made. */
  consentPerSourcePerHour: 10,
  /** Requests one client may make in a day, answered or not. */
  perClientPerDay: 20,
  /** Declines from one client, within the window, after which its requests are refused. */
  declinesBeforeCooldown: 3,
  declineWindowMs: 3600_000,
  cooldownMs: 3600_000,
} as const

/** Who asked. An agent is named by its credential; its self-reported name is only a label. */
export const requesterSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('agent'), clientId: clientIdSchema, clientName: displayText(100) }).strict(),
  z.object({ kind: z.literal('person') }).strict(),
  z.object({ kind: z.literal('app') }).strict(),
])
export type Requester = z.infer<typeof requesterSchema>

/** What the card shows besides the subject (see `display` below). Every key here must also parse on the phone. */
export const requestDisplaySchema = z
  .object({
    because: displayText(200).optional(),
    client: z
      .object({ label: displayText(100), badge: z.enum(['local', 'remote', 'app', 'person']) })
      .strict()
      .optional(),
    /** The site's registrable domain, from the manifest's origins by the Mac. */
    domain: z
      .string()
      .regex(/^[a-z0-9.-]{1,253}$/)
      .optional(),
    followOns: z.array(displayText(120)).max(10).optional(),
    checks: z.array(displayText(200)).max(20).optional(),
    /**
     * The tests the agent wrote, as Valet ran them (F's ask): counted apart from `checks`,
     * which are Valet's own, so the card can't let an agent's tests pass for Valet's checks.
     */
    agentTests: z
      .object({ passed: z.number().int().min(0).max(10_000), failed: z.number().int().min(0).max(10_000) })
      .strict()
      .optional(),
    fromAdapter: z
      .object({
        siteName: displayText(80).optional(),
        toolTitles: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), displayText(80)).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()

const requestBase = {
  v: z.literal(1),
  id: requestIdSchema,
  macId: keyIdSchema,
  requester: requesterSchema,
  /**
   * The agent's own words about why, if it gave any: shown under "The agent says", never as the
   * card's headline, and never trusted.
   */
  agentNote: displayText(280).nullable(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  /** Why this request exists, in the Mac's terms: the card's "Because" row (D). */
  context: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('repair'), repairId: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/) }).strict(),
      z.object({ kind: z.literal('draft'), draftId: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/) }).strict(),
      /** A follow-on (A section 8): its own request, signed on its own, after this one. */
      z.object({ kind: z.literal('follows'), requestId: requestIdSchema }).strict(),
      z.object({ kind: z.literal('replaces'), requestId: requestIdSchema }).strict(),
    ])
    .optional(),
  /**
   * What the card shows besides the subject, written by the Mac (H's CR-4). Part of the request
   * text, so the signature covers it. `fromAdapter` is text the adapter's author wrote: cards show
   * it as "the adapter says", never as a headline.
   */
  display: requestDisplaySchema.optional(),
}

const requestOf = <K extends ApprovalKind>(kind: K) =>
  z
    .object({
      ...requestBase,
      kind: z.literal(kind),
      tier: z.literal(KIND_TIER[kind]),
      subject: subjects[kind],
    })
    .strict()

export const approvalRequestSchema = z
  .discriminatedUnion('kind', [
    requestOf('adapter-install'),
    requestOf('secret-grant'),
    requestOf('tool-enable'),
    requestOf('remote-client'),
    requestOf('setting'),
    requestOf('authoring-session'),
    requestOf('private-network'),
    requestOf('irreversible-call'),
    requestOf('resume'),
    requestOf('device-pair'),
  ])
  .refine((r) => Date.parse(r.expiresAt) > Date.parse(r.createdAt), 'expires before created')
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>

/** The request as the Mac sends and stores it: its exact text, and that text's digest. */
export interface SerializedRequest {
  readonly request: ApprovalRequest
  readonly text: string
  readonly digest: string
}

/** Validates and serialises a request the Mac built. Throws if the request is malformed. */
export function serializeRequest(request: ApprovalRequest): SerializedRequest {
  const parsed = approvalRequestSchema.parse(request)
  const text = canonicalJson(parsed)
  return { request: parsed, text, digest: domainDigest(SIGNING_DOMAINS.approvalRequest, text) }
}

/** Parses request text received from the Mac, as a device does before rendering a card. */
export function parseRequestText(text: string): SerializedRequest | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  const result = approvalRequestSchema.safeParse(raw)
  if (!result.success) return null
  return { request: result.data, text, digest: domainDigest(SIGNING_DOMAINS.approvalRequest, text) }
}

/** What a device signs to approve. Only approvals are signed; see the file comment. */
export const approvalDecisionSchema = z
  .object({
    v: z.literal(1),
    decision: z.literal('approve'),
    macId: keyIdSchema,
    requestId: requestIdSchema,
    requestDigest: hash,
    deviceId: keyIdSchema,
    decidedAt: z.iso.datetime(),
    /** The value picked on a card that offers `choices` (H's CR-7). Signed with the rest. */
    choice: z.string().min(1).max(200).optional(),
    /** A remote client's consent only: the code the person typed from their browser. */
    typedCode: consentCodeSchema.optional(),
  })
  .strict()
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>
export { signedTextSchema as signedDecisionSchema }

export const DECISION_REFUSALS = [
  'malformed',
  'unknown-device',
  'device-revoked',
  'bad-signature',
  'wrong-mac',
  'wrong-request',
  'not-pending',
  'expired',
  'not-allowed-on-device',
  'bad-choice',
  'wrong-code',
] as const
export type DecisionRefusal = (typeof DECISION_REFUSALS)[number]

export type DecisionCheck =
  | { readonly ok: true; readonly decision: ApprovalDecision; readonly role: DeviceRole }
  | { readonly ok: false; readonly reason: DecisionRefusal }

export interface DecisionContext {
  readonly macId: string
  readonly devices: DeviceLookup
  /**
   * `live`: a decision arriving now, for a request the Mac holds as pending. It must be pending
   * and unexpired, and the device unrevoked.
   * `stored`: evidence kept beside a record in a trusted store, checked again on every load. The
   * request has long expired, so the Mac must have received the decision before it did; a device
   * revoked later doesn't void what it approved while paired (see the lockdown section). Times are
   * the Mac's `receivedAt` receipt, never the signer's `decidedAt`, which the device chooses.
   */
  readonly mode: 'live' | 'stored'
  /** Stored only: when the Mac accepted the decision live, by its own clock (the receipt). */
  readonly receivedAt?: string
  /** Live only: whether the Mac still holds this request id as pending, unanswered. */
  readonly isPending?: (requestId: string) => boolean
  /** Live only, for a remote client's consent: the code the Mac issued for this request. */
  readonly consentCode?: (requestId: string) => string | null
  readonly now?: Date
}

/**
 * Checks a signed approval against the request it names. The order matters: the signature is
 * checked before the payload is trusted for anything but finding the device.
 */
export function verifyDecision(
  signed: SignedText,
  request: SerializedRequest,
  context: DecisionContext,
): DecisionCheck {
  if (!signedTextSchema.safeParse(signed).success) return { ok: false, reason: 'malformed' }
  let raw: unknown
  try {
    raw = JSON.parse(signed.payload)
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  const deviceId = (raw as { deviceId?: unknown } | null)?.deviceId
  if (typeof deviceId !== 'string') return { ok: false, reason: 'malformed' }
  const device = context.devices.device(deviceId)
  if (device === null || device.macId !== context.macId) return { ok: false, reason: 'unknown-device' }
  if (!verifyP256(device.approvalKey, SIGNING_DOMAINS.approvalDecision, signed.payload, signed.signature)) {
    return { ok: false, reason: 'bad-signature' }
  }
  const parsed = approvalDecisionSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, reason: 'malformed' }
  const decision = parsed.data
  if (decision.macId !== context.macId || request.request.macId !== context.macId)
    return { ok: false, reason: 'wrong-mac' }
  if (decision.requestId !== request.request.id || decision.requestDigest !== request.digest) {
    return { ok: false, reason: 'wrong-request' }
  }
  if (!approvableOn(request.request.kind, request.request.subject).includes(device.role)) {
    return { ok: false, reason: 'not-allowed-on-device' }
  }
  const revokedAt = context.devices.revokedAt(deviceId)
  const expiresAt = Date.parse(request.request.expiresAt)
  if (context.mode === 'live') {
    if (revokedAt !== null) return { ok: false, reason: 'device-revoked' }
    if (!(context.isPending?.(request.request.id) ?? false)) return { ok: false, reason: 'not-pending' }
    const now = (context.now ?? new Date()).getTime()
    if (now >= expiresAt) return { ok: false, reason: 'expired' }
  } else {
    const receivedAt = context.receivedAt === undefined ? Number.NaN : Date.parse(context.receivedAt)
    if (Number.isNaN(receivedAt)) return { ok: false, reason: 'malformed' }
    if (receivedAt >= expiresAt || receivedAt < Date.parse(request.request.createdAt)) {
      return { ok: false, reason: 'expired' }
    }
    if (revokedAt !== null && Date.parse(revokedAt) <= receivedAt)
      return { ok: false, reason: 'device-revoked' }
  }
  const choices = request.request.kind === 'setting' ? request.request.subject.choices : undefined
  if (
    choices === undefined ? decision.choice !== undefined : !choices.some((c) => c.value === decision.choice)
  ) {
    return { ok: false, reason: 'bad-choice' }
  }
  if (request.request.kind === 'remote-client') {
    // Stored evidence was matched when it arrived; the receipt says so. Live, it must match now.
    if (decision.typedCode === undefined) return { ok: false, reason: 'wrong-code' }
    if (context.mode === 'live' && decision.typedCode !== context.consentCode?.(request.request.id)) {
      return { ok: false, reason: 'wrong-code' }
    }
  } else if (decision.typedCode !== undefined) {
    return { ok: false, reason: 'wrong-code' }
  }
  return { ok: true, decision, role: device.role }
}

/** The payload text a device signs for an approval: the same canonical form the Mac uses. */
export function decisionPayload(decision: ApprovalDecision): string {
  return canonicalJson(approvalDecisionSchema.parse(decision))
}
