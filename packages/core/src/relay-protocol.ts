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
import { clientIdSchema, requestIdSchema } from './approvals'
import { keyIdSchema } from './devices'
import { displayText } from './display-text'
import { p256PublicKeySchema, p256SignatureSchema, signedTextSchema } from './signing'

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
  '/revoke',
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
 * The answer, signed by the transport key over `valet/relay-auth/v1\n` + canonical JSON of
 * `{ nonce, relay, role, id }`. A Mac's id is its macId; a phone's is its deviceId, and the Mac
 * must have registered it (`device-register`) first.
 */
export const relayHelloSchema = z
  .object({
    type: z.literal('hello'),
    role: z.enum(['mac', 'phone']),
    id: keyIdSchema,
    /** Only on a Mac's first connection, when the relay has no key for this id yet. */
    transportKey: p256PublicKeySchema.optional(),
    signature: p256SignatureSchema,
  })
  .strict()

/** A sealed Mac-to-phone or phone-to-Mac message. See channelMessageSchema for what's inside. */
export const envelopeSchema = z
  .object({
    v: z.literal(1),
    /** RFC 9180: DHKEM(P-256, HKDF-SHA256), HKDF-SHA256, AES-256-GCM, auth mode. */
    suite: z.literal('hpke-auth-p256-sha256-aes256gcm'),
    from: keyIdSchema,
    to: keyIdSchema,
    /** The encapsulated key and the ciphertext, base64url. The `info` is from || to. */
    enc: z.string().regex(/^[A-Za-z0-9_-]{87}$/),
    ct: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/)
      .max(180_000),
  })
  .strict()
export type Envelope = z.infer<typeof envelopeSchema>

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
      outcome: z.enum(['approved', 'declined', 'expired', 'withdrawn']),
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
export const phoneToMacMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('approval-decision'), seq, decision: signedTextSchema }).strict(),
  /** No. Needs no signature. */
  z.object({ type: z.literal('approval-decline'), seq, requestId: requestIdSchema }).strict(),
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

/** Either direction; a receiver parses with its own direction's schema. */
export const channelMessageSchema = z.union([macToPhoneMessageSchema, phoneToMacMessageSchema])
export type ChannelMessage = z.infer<typeof channelMessageSchema>

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
      state: z.enum(['waiting', 'approved', 'declined', 'expired']),
      code: z
        .string()
        .regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/)
        .optional(),
      redirect: z.url({ protocol: /^https$/ }).optional(),
    })
    .strict(),
  /** Let this phone connect for this Mac (after pairing), or stop letting it. */
  z
    .object({ type: z.literal('device-register'), deviceId: keyIdSchema, transportKey: p256PublicKeySchema })
    .strict(),
  z.object({ type: z.literal('device-unregister'), deviceId: keyIdSchema }).strict(),
  z.object({ type: z.literal('envelope'), envelope: envelopeSchema }).strict(),
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
])
export type RelayToMac = z.infer<typeof relayToMacSchema>

export const phoneToRelaySchema = z.discriminatedUnion('type', [
  relayHelloSchema,
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
  readonly createdAt: string
}
