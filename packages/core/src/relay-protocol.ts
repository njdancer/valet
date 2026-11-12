// The relay protocol (D76, workstream G; docs/agent-run-security.md#the-relay-protocol).
//
// The relay is a Cloudflare Worker with a Durable Object per Mac. The Mac and each paired phone
// dial out to it over WebSockets; nothing connects in to the Mac. The relay carries two kinds of
// traffic and can read only the first:
//
// - MCP and OAuth requests from remote clients, which arrive as plain HTTPS (there is no way for a
//   standard MCP client to encrypt for the Mac). Forwarded, never stored, never logged by body.
// - The Mac-to-phone channel: HPKE-sealed envelopes the relay routes by device id but can't open,
//   alter or forge. Approvals inside are signed as well, so even a broken seal can't approve.
//
// The relay is never an authority: it holds no tokens, no grants and no approvals.

import { z } from 'zod'
import type { AdminAction } from './admin-actions'
import { clientIdSchema, consentCodeSchema, DECISION_REFUSALS, requestIdSchema } from './approvals'
import { canRevokeDevice, keyIdSchema } from './devices'
import { displayText } from './display-text'
import { sha256Hex } from './hash'
import { sealedSchema } from './pairing'
import {
  keyId,
  p256PublicKeySchema,
  p256SignatureSchema,
  SIGNING_DOMAINS,
  signedTextSchema,
  verifyP256,
} from './signing'

export const RELAY_PROTOCOL_VERSION = 1

export const RELAY_LIMITS = {
  /** The same cap as the local endpoint. */
  maxRequestBodyBytes: 1024 * 1024,
  maxResponseChunkBytes: 256 * 1024,
  maxEnvelopeBytes: 128 * 1024,
  maxConcurrentRequestsPerMac: 16,
  maxFramesPerSecondPerMac: 50,
  /** Envelopes a device may send per minute; a phone sends a handful. */
  maxEnvelopesPerMinutePerDevice: 60,
  /** A connection must answer its challenge within this, or is closed. */
  challengeTimeoutMs: 10_000,
  /** At most this many phones per Mac. */
  maxDevicesPerMac: 5,
} as const

/** The only HTTP paths the relay forwards to a Mac. Everything else is answered by the relay. */
export const RELAY_FORWARDED_PATHS = [
  '/mcp',
  '/register',
  '/token',
  '/.well-known/oauth-authorization-server',
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/mcp',
] as const

/** `/authorize` is a fixed relay template filled from the Mac's structured answer (no HTML). */
export const RELAY_CONSENT_PATH = '/authorize'

/** Request headers forwarded to the Mac. All others are dropped at the relay. */
export const RELAY_FORWARDED_HEADERS = [
  'accept',
  'authorization',
  'content-type',
  'last-event-id',
  'mcp-protocol-version',
  'mcp-session-id',
] as const

/** Response headers the Mac may set. All others are dropped at the relay. */
export const RELAY_RESPONSE_HEADERS = [
  'cache-control',
  'content-type',
  'mcp-session-id',
  'retry-after',
  'www-authenticate',
] as const

const requestId = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/)
const headers = (allowed: readonly string[]) =>
  z
    .record(z.string(), z.string().max(8192))
    .refine((h) => Object.keys(h).every((k) => allowed.includes(k)), 'header not allowed')
const nonce = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
const macNonceSchema = nonce

/** First frame on every connection, from the relay: sign this to prove you hold the key. */
export const relayChallengeSchema = z
  .object({
    type: z.literal('challenge'),
    v: z.literal(RELAY_PROTOCOL_VERSION),
    nonce,
    relay: z.url({ protocol: /^https$/ }),
  })
  .strict()

/**
 * The text a hello's signature covers: `JSON.stringify` of exactly these keys in exactly this
 * order, so Swift, the Mac and the relay sign and check the same bytes (G's request).
 */
export function relayAuthPayload(fields: {
  readonly nonce: string
  readonly relay: string
  readonly role: 'mac' | 'phone'
  readonly id: string
}): string {
  return JSON.stringify({ nonce: fields.nonce, relay: fields.relay, role: fields.role, id: fields.id })
}

/**
 * The answer, signed by the transport key over `valet/relay-auth/v1\n` + relayAuthPayload. A
 * Mac's id is its macId; a phone's is its deviceId, and the Mac must have registered it
 * (`device-register`) first.
 */
export const relayHelloSchema = z
  .object({
    type: z.literal('hello'),
    role: z.enum(['mac', 'phone']),
    id: keyIdSchema,
    /**
     * Only on a Mac's first connection, when the relay has no key for this id yet, and always with
     * `binding`: the Mac's approval key (whose keyId is the macId) signing this transport key once,
     * with Touch ID. Without it, anyone who knew a macId (it's in the host name) could register
     * first after the relay lost its storage (G's finding). The same binding lets a Mac rotate its
     * transport key: a hello with a new key and a valid binding replaces the stored one.
     */
    transportKey: p256PublicKeySchema.optional(),
    binding: z
      .object({ approvalKey: p256PublicKeySchema, signature: p256SignatureSchema })
      .strict()
      .optional(),
    signature: p256SignatureSchema,
  })
  .strict()
  .refine(
    (h) => (h.transportKey === undefined) === (h.binding === undefined),
    'transportKey and binding go together',
  )
  .refine((h) => h.transportKey === undefined || h.role === 'mac', 'only a Mac registers itself')

/** The relay's check of a first hello's binding: the macId is the approval key's, and it signed. */
export function verifyRelayBinding(hello: z.infer<typeof relayHelloSchema>): boolean {
  if (hello.transportKey === undefined || hello.binding === undefined) return false
  if (keyId(hello.binding.approvalKey) !== hello.id) return false
  return verifyP256(
    hello.binding.approvalKey,
    SIGNING_DOMAINS.relayBinding,
    hello.transportKey,
    hello.binding.signature,
  )
}

/** A sealed Mac-to-phone or phone-to-Mac message. See macToPhoneMessageSchema and phoneToMacMessageSchema for what's inside. */
export const envelopeSchema = z
  .object({
    v: z.literal(1),
    /** RFC 9180: DHKEM(P-256, HKDF-SHA256), HKDF-SHA256, AES-256-GCM, auth mode. */
    suite: z.literal('hpke-auth-p256-sha256-aes256gcm'),
    from: keyIdSchema,
    to: keyIdSchema,
    /** The encapsulated key and the ciphertext, base64url. The `info` is envelopeInfo(from, to). The whole frame is also held to maxEnvelopeBytes. */
    enc: z.string().regex(/^[A-Za-z0-9_-]{87}$/),
    ct: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/)
      .max(174_000),
  })
  .strict()
export type Envelope = z.infer<typeof envelopeSchema>

/**
 * The HPKE `info` for an envelope: the sender's then the recipient's key id, each as its 16
 * bytes (hex-decoded). Pinned so the Mac, the phone and tests agree.
 */
export function envelopeInfo(from: string, to: string): Buffer {
  return Buffer.concat([Buffer.from(from, 'hex'), Buffer.from(to, 'hex')])
}

/**
 * Sequence numbers, per sender. A receiver accepts only the next one. A duplicate (at or below
 * the last) is acked again but not acted on. A gap is held, not skipped: with "drop anything not
 * above the last", a relay could hold back a lockdown, deliver the message after it, and every
 * resend of the lockdown would then look old (H's review). Acks carry a seq but are never acked.
 */
export function seqVerdict(lastAccepted: number, seq: number): 'accept' | 'duplicate' | 'gap' {
  if (seq === lastAccepted + 1) return 'accept'
  return seq <= lastAccepted ? 'duplicate' : 'gap'
}

const seq = z.number().int().min(1)
/** A receiver's acknowledgement of a sender's message by its seq, so a dropped one shows. */
const ackMessage = z.object({ type: z.literal('ack'), seq, ackSeq: z.number().int().min(1) }).strict()

/**
 * What an envelope from the Mac holds once opened. `seq` rises by one per message from each
 * sender, so the relay can't replay or reorder; a receiver drops anything not above the last it
 * accepted. Requests aren't signed (that would need Touch ID each time); they are authenticated
 * by the HPKE auth-mode seal from the Mac's agreement key, pinned at pairing.
 */
export const macToPhoneMessageSchema = z.discriminatedUnion('type', [
  /** The request exactly as serialised; the phone renders from and signs this. */
  z.object({ type: z.literal('approval-request'), seq, requestText: z.string().max(64 * 1024) }).strict(),
  /** Answered elsewhere, expired or withdrawn; take the card down. */
  z
    .object({
      type: z.literal('approval-closed'),
      seq,
      requestId: requestIdSchema,
      outcome: z.enum(['approved', 'declined', 'expired', 'withdrawn', 'refused']),
      /** For `refused`: why the Mac didn't accept a signature. */
      reason: z.enum(DECISION_REFUSALS).optional(),
      /** The device that answered, if one did. */
      deviceId: keyIdSchema.nullable().optional(),
    })
    .strict(),
  /** What the phone's tabs show (H's CR-3). Replaces the last one; the Mac's own wording. */
  z
    .object({
      type: z.literal('status'),
      seq,
      at: z.iso.datetime(),
      safety: z.enum(['running', 'paused', 'remote-paused', 'lockdown']),
      sites: z
        .array(
          z
            .object({
              adapterId: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
              name: displayText(80),
              health: z.enum(['ok', 'needs-you', 'paused', 'blocked', 'repair', 'off']),
              note: displayText(200).optional(),
            })
            .strict(),
        )
        .max(50),
      agents: z
        .array(
          z
            .object({
              clientId: clientIdSchema,
              label: displayText(100),
              transport: z.enum(['local', 'remote']),
              lastCallAt: z.iso.datetime().nullable(),
            })
            .strict(),
        )
        .max(50),
      devices: z
        .array(
          z
            .object({
              deviceId: keyIdSchema,
              name: displayText(60),
              platform: z.enum(['macos', 'ios']),
              lastSeenAt: z.iso.datetime().nullable(),
            })
            .strict(),
        )
        .max(10),
      recent: z
        .array(
          z
            .object({ at: z.iso.datetime(), kind: z.enum(['call', 'change']), text: displayText(200) })
            .strict(),
        )
        .max(50),
    })
    .strict(),
  /**
   * The Mac revoked this phone. The relay refuses a revoked phone's hello without saying why, so
   * this sealed notice is how the phone learns to delete its keys and unpair.
   */
  z.object({ type: z.literal('unpaired'), seq, at: z.iso.datetime() }).strict(),
  /** A login needs the person (J6; H's CR-10). `code` means the phone may send a one-time code. */
  z
    .object({
      type: z.literal('handoff'),
      seq,
      handoffId: z.string().regex(/^[A-Za-z0-9_-]{8,40}$/),
      adapterId: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
      domain: z.string().regex(/^[a-z0-9.-]{1,253}$/),
      kind: z.enum(['code', 'captcha', 'other']),
      expiresAt: z.iso.datetime(),
    })
    .strict(),
  /** Something the person should know. Fixed kinds; text in the app's words. */
  z
    .object({
      type: z.literal('alert'),
      seq,
      kind: z.enum(['needs-you', 'login-handed-over', 'breaker-opened', 'repair', 'notify', 'store-refused']),
      title: displayText(80),
      body: displayText(300),
      at: z.iso.datetime(),
    })
    .strict(),
  ackMessage,
])
export type MacToPhoneMessage = z.infer<typeof macToPhoneMessageSchema>

/**
 * What an envelope from a phone holds once opened. Commands only tighten, and the phone shows each
 * as "not confirmed" until the Mac's ack arrives, so a relay that drops one can't hide it.
 */
/** What a phone may ask the Mac to start. Pairing and resume are never asked from a phone. */
export const PHONE_ASKS = [
  'tool.enable',
  'tool.remote-enable',
  'setting.adapter-choice',
  'setting.loosen',
  'adapter.rollback',
] as const satisfies readonly AdminAction[]

export const phoneToMacMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('approval-decision'), seq, decision: signedTextSchema }).strict(),
  /** No. Needs no signature. The note goes to the agent; stopAsking refuses its requests for a while. */
  z
    .object({
      type: z.literal('approval-decline'),
      seq,
      requestId: requestIdSchema,
      note: displayText(280).optional(),
      stopAsking: z.boolean().optional(),
    })
    .strict(),
  /**
   * Ask the Mac to start something that needs approval (H's CR-9). The Mac looks the tier up in
   * ADMIN_ACTION_TIERS and builds the request itself, exactly as for an agent; an ask approves
   * nothing.
   */
  z
    .object({
      type: z.literal('ask'),
      seq,
      action: z.enum(PHONE_ASKS),
      adapterId: z
        .string()
        .regex(/^[a-z][a-z0-9-]{1,63}$/)
        .optional(),
      tool: z
        .string()
        .regex(/^[a-z][a-z0-9_]{0,63}$/)
        .optional(),
      setting: z
        .string()
        .regex(/^[a-z][a-z0-9_]{0,63}$/)
        .optional(),
      value: z.string().min(1).max(200).optional(),
    })
    .strict(),
  /**
   * A one-time code the person typed on the phone for a login hand-off (J6). The Mac holds it as a
   * secret: only for that hand-off's OTP step, never logged, audited as a secret use.
   */
  z
    .object({
      type: z.literal('login-code'),
      seq,
      handoffId: z.string().regex(/^[A-Za-z0-9_-]{8,40}$/),
      code: z.string().regex(/^[A-Za-z0-9-]{4,12}$/),
    })
    .strict(),
  /** A tightening command. Undoing any of them is a `resume` approval. The Mac's own id can't be revoked. */
  z
    .object({
      type: z.literal('command'),
      seq,
      command: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('pause-remote') }).strict(),
        z.object({ kind: z.literal('lockdown') }).strict(),
        z.object({ kind: z.literal('revoke-client'), clientId: clientIdSchema }).strict(),
        z.object({ kind: z.literal('revoke-device'), deviceId: keyIdSchema }).strict(),
      ]),
    })
    .strict(),
  ackMessage,
])
export type PhoneToMacMessage = z.infer<typeof phoneToMacMessageSchema>

/**
 * How the Mac reads a phone's message: its own direction's schema, and never a command to revoke
 * the Mac itself. Null for anything else.
 */
export function parsePhoneToMac(raw: unknown, macId: string): PhoneToMacMessage | null {
  const result = phoneToMacMessageSchema.safeParse(raw)
  if (!result.success) return null
  const message = result.data
  if (
    message.type === 'command' &&
    message.command.kind === 'revoke-device' &&
    !canRevokeDevice(message.command.deviceId, macId)
  ) {
    return null
  }
  return message
}

export const macToRelaySchema = z.discriminatedUnion('type', [
  relayHelloSchema,
  z
    .object({
      type: z.literal('http-response-start'),
      id: requestId,
      status: z.number().int().min(100).max(599),
      headers: headers(RELAY_RESPONSE_HEADERS),
    })
    .strict(),
  z
    .object({
      type: z.literal('http-response-chunk'),
      id: requestId,
      data: z.string().max(RELAY_LIMITS.maxResponseChunkBytes),
    })
    .strict(),
  z.object({ type: z.literal('http-response-end'), id: requestId }).strict(),
  /** The consent page's content, as fields the relay's template renders. Never HTML. */
  z
    .object({
      type: z.literal('consent-view'),
      id: requestId,
      /** `closed`: Valet isn't accepting new agents (A's J2 F5). */
      /** `busy` and `too-many`: the Mac or the relay is refusing for load; try again later. */
      state: z.enum(['waiting', 'approved', 'declined', 'expired', 'closed', 'busy', 'too-many']),
      code: consentCodeSchema.optional(),
      /** While waiting: when the request expires, for the page's "Ends at". */
      expiresAt: z.iso.datetime().optional(),
      redirect: z.url({ protocol: /^https$/ }).optional(),
    })
    .strict(),
  /** Let this phone connect for this Mac (after pairing), or stop letting it. */
  z
    .object({ type: z.literal('device-register'), deviceId: keyIdSchema, transportKey: p256PublicKeySchema })
    .strict(),
  z.object({ type: z.literal('device-unregister'), deviceId: keyIdSchema }).strict(),
  z.object({ type: z.literal('envelope'), envelope: envelopeSchema }).strict(),
  /** Accept pairing replies for this offer until it expires. The relay never sees the secret. */
  z.object({ type: z.literal('pairing-open'), offerId: keyIdSchema, expiresAt: z.iso.datetime() }).strict(),
  /** After the first reply to an offer (later ones are refused): the nonce the code includes. */
  z.object({ type: z.literal('pairing-challenge'), offerId: keyIdSchema, macNonce: macNonceSchema }).strict(),
  z.object({ type: z.literal('pairing-result'), offerId: keyIdSchema, sealed: sealedSchema }).strict(),
  /** Lift a relay-side lock (G's request 4). Only the Mac can. */
  z.object({ type: z.literal('relay-unlock') }).strict(),
  /**
   * Set the recovery code's hash: SHA-256 hex of a 128-bit code shown once at setup. The code's
   * page can only lock the relay and unregister phones, never unlock or reach the Mac.
   */
  z.object({ type: z.literal('recovery-register'), codeHash: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
  /** Wake a phone. The relay sends a push with fixed text and no content; see pushPayloadSchema. */
  z.object({ type: z.literal('push'), deviceId: keyIdSchema, kind: z.enum(['needs-you', 'alert']) }).strict(),
])
export type MacToRelay = z.infer<typeof macToRelaySchema>

export const relayToMacSchema = z.discriminatedUnion('type', [
  relayChallengeSchema,
  z
    .object({ type: z.literal('ready'), devices: z.array(keyIdSchema).max(RELAY_LIMITS.maxDevicesPerMac) })
    .strict(),
  /** One HTTP request on a forwarded path. `source` is the client's address as the relay saw it. */
  z
    .object({
      type: z.literal('http-request'),
      id: requestId,
      method: z.enum(['GET', 'POST', 'DELETE']),
      path: z.enum(RELAY_FORWARDED_PATHS),
      query: z.string().max(2048),
      headers: headers(RELAY_FORWARDED_HEADERS),
      body: z.string().max(RELAY_LIMITS.maxRequestBodyBytes),
      source: z.string().max(64),
    })
    .strict(),
  z.object({ type: z.literal('http-cancel'), id: requestId }).strict(),
  /** Someone opened /authorize: the Mac decides and answers with consent-view. */
  z
    .object({
      type: z.literal('consent-open'),
      id: requestId,
      query: z.string().max(4096),
      source: z.string().max(64),
    })
    .strict(),
  z.object({ type: z.literal('envelope'), envelope: envelopeSchema }).strict(),
  z.object({ type: z.literal('device-online'), deviceId: keyIdSchema, online: z.boolean() }).strict(),
  z.object({ type: z.literal('pairing-reply'), offerId: keyIdSchema, sealed: sealedSchema }).strict(),
  /**
   * The relay stopped forwarding remote traffic to this Mac (a phone asked, or the recovery page
   * was used); envelopes still flow. `phonesUnregistered`: the recovery page also dropped phones.
   */
  z
    .object({
      type: z.literal('relay-locked'),
      locked: z.boolean(),
      by: z.enum(['phone', 'recovery', 'mac']),
      phonesUnregistered: z.boolean(),
    })
    .strict(),
])
export type RelayToMac = z.infer<typeof relayToMacSchema>

export const phoneToRelaySchema = z.discriminatedUnion('type', [
  relayHelloSchema,
  /**
   * The only frame a phone may send without a hello: its sealed reply to an open offer. Refused
   * unless the Mac opened that offer; one per offer.
   */
  z
    .object({
      type: z.literal('pairing-reply'),
      macId: keyIdSchema,
      offerId: keyIdSchema,
      sealed: sealedSchema,
    })
    .strict(),
  /** Stop forwarding remote traffic to my Mac (J7). Only the Mac lifts it. */
  z.object({ type: z.literal('relay-lock') }).strict(),
  z.object({ type: z.literal('envelope'), envelope: envelopeSchema }).strict(),
  /** The APNs token. The only thing the relay stores about a phone besides its key. */
  z.object({ type: z.literal('push-token'), token: z.string().regex(/^[0-9a-f]{64,200}$/) }).strict(),
])
export type PhoneToRelay = z.infer<typeof phoneToRelaySchema>

export const relayToPhoneSchema = z.discriminatedUnion('type', [
  relayChallengeSchema,
  z.object({ type: z.literal('ready'), macOnline: z.boolean() }).strict(),
  z.object({ type: z.literal('envelope'), envelope: envelopeSchema }).strict(),
  z.object({ type: z.literal('mac-online'), online: z.boolean() }).strict(),
  z.object({ type: z.literal('pairing-challenge'), offerId: keyIdSchema, macNonce: macNonceSchema }).strict(),
  z.object({ type: z.literal('pairing-result'), offerId: keyIdSchema, sealed: sealedSchema }).strict(),
  z
    .object({
      type: z.literal('relay-locked'),
      locked: z.boolean(),
      by: z.enum(['phone', 'recovery', 'mac']),
    })
    .strict(),
])
export type RelayToPhone = z.infer<typeof relayToPhoneSchema>

/** What APNs carries. Apple sees push payloads, so there is nothing in one but a wake-up. */
export const pushPayloadSchema = z
  .object({
    aps: z
      .object({
        alert: z
          .object({
            title: z.literal('Valet'),
            body: z.enum(['Valet needs you', 'Something changed in Valet']),
          })
          .strict(),
      })
      .strict(),
  })
  .strict()

/** What the relay keeps at rest, all of it. Nothing about calls, tools, results or approvals. */
export interface RelayStoredState {
  readonly macId: string
  readonly macTransportKey: string
  readonly devices: readonly {
    readonly deviceId: string
    readonly transportKey: string
    readonly pushToken: string | null
  }[]
  /** SHA-256 of the recovery code, if one was set (`recoveryCodeHash`). */
  readonly recoveryCodeHash: string | null
  readonly locked: boolean
  /** Who set the lock, so `relay-locked` on reconnect names them (G's request). Null when unlocked. */
  readonly lockedBy: 'phone' | 'recovery' | 'mac' | null
  readonly createdAt: string
  /** For deleting Macs not seen in a long while; safe because re-registering needs the binding. */
  readonly lastSeenAt: string
}

/**
 * The recovery code as typed: upper-cased, spaces and dashes removed, then 16 to 64 of A-Z and 0-9
 * (G's request, pinned so the Mac and the relay agree). Null for anything else.
 */
export function normaliseRecoveryCode(typed: string): string | null {
  const code = typed.toUpperCase().replace(/[\s-]/g, '')
  return /^[A-Z0-9]{16,64}$/.test(code) ? code : null
}

/** What `recovery-register` sends and the relay compares: SHA-256 hex of the normalised code. */
export function recoveryCodeHash(typed: string): string | null {
  const code = normaliseRecoveryCode(typed)
  return code === null ? null : sha256Hex(code)
}
