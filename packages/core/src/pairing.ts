// Pairing a phone (docs/agent-run-security.md#pairing; H's CR-2). The QR code carries a one-time
// 32-byte secret the relay never sees. Everything the phone sends before it is registered is
// sealed with a key derived from that secret, and both screens show a code derived from the whole
// transcript, so neither the relay nor someone who photographed the QR can pair a phone.
//
// Wire: the Mac opens the offer at the relay (`pairing-open`, by offer id only). The phone, with no
// registration yet, sends `pairing-reply` addressed by mac id and offer id; the relay passes it
// to the Mac. The Mac answers with `pairing-result`, which the relay passes back.

import { createDecipheriv, hkdfSync } from 'node:crypto'
import { z } from 'zod'
import { keyIdSchema } from './devices'
import { displayText } from './display-text'
import { sha256Hex } from './hash'
import { p256PublicKeySchema, SIGNING_DOMAINS, signedTextSchema, verifyP256 } from './signing'

const INFO = {
  id: 'valet/pairing/v1 id',
  seal: 'valet/pairing/v1 seal',
  code: 'valet/pairing/v1 sas',
} as const

function secretBytes(secret: string): Buffer {
  const bytes = Buffer.from(secret, 'base64url')
  if (bytes.length !== 32) throw new Error('a pairing secret is 32 bytes')
  return bytes
}

/** The offer's public name: lets the relay route a reply without learning the secret. */
export function pairingOfferId(secret: string): string {
  return sha256Hex(Buffer.concat([Buffer.from(`${INFO.id}\n`), secretBytes(secret)])).slice(0, 32)
}

/** The AES-256-GCM key both sealed pairing messages use. HKDF-SHA256, salt the Mac's id. */
export function pairingSealKey(secret: string, macId: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secretBytes(secret), Buffer.from(macId), INFO.seal, 32))
}

/**
 * The six digits both screens show. HKDF-SHA256 over the secret, salted with the Mac's id, with
 * the offer text, the reply's plaintext and the Mac's fresh nonce in the info (each length-
 * prefixed in bytes). The first four bytes, big-endian, mod 1,000,000, zero-padded.
 *
 * The nonce is why the digits can't be forced: someone who saw the QR and controls the relay can
 * open the reply and could grind substitute replies until one gives the same digits. The Mac
 * accepts only the first reply to an offer, and only then sends a random 32-byte nonce
 * (`pairing-challenge`), so nothing can be computed ahead (H's review).
 */
export function pairingCode(
  secret: string,
  macId: string,
  offerText: string,
  replyPlaintext: string,
  macNonce: string,
): string {
  const nonce = Buffer.from(macNonce, 'base64url')
  if (nonce.length !== 32) throw new Error('the Mac nonce is 32 bytes')
  const info = Buffer.concat([
    Buffer.from(`${INFO.code}\n`),
    Buffer.from(`${Buffer.byteLength(offerText)}:`),
    Buffer.from(offerText),
    Buffer.from(`${Buffer.byteLength(replyPlaintext)}:`),
    Buffer.from(replyPlaintext),
    nonce,
  ])
  const okm = Buffer.from(hkdfSync('sha256', secretBytes(secret), Buffer.from(macId), info, 4))
  return String(okm.readUInt32BE(0) % 1_000_000).padStart(6, '0')
}

/** AES-256-GCM: a 12-byte IV and the ciphertext with its 16-byte tag appended, both base64url. */
export const sealedSchema = z
  .object({
    iv: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
    ct: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/)
      .max(16_000),
  })
  .strict()
export type Sealed = z.infer<typeof sealedSchema>

/** Opens a sealed pairing message, or null if the key or the bytes are wrong. */
export function openSealed(key: Buffer, sealed: Sealed, aad: string): string | null {
  try {
    const iv = Buffer.from(sealed.iv, 'base64url')
    const data = Buffer.from(sealed.ct, 'base64url')
    if (data.length < 17) return null
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAAD(Buffer.from(aad))
    decipher.setAuthTag(data.subarray(data.length - 16))
    return Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]).toString(
      'utf8',
    )
  } catch {
    return null
  }
}

/** The AAD for each sealed message: what it is, and which offer it belongs to. */
export const pairingAad = (kind: 'reply' | 'result', offerId: string) => `valet/pairing/v1 ${kind} ${offerId}`

/** What the phone sends, sealed. */
export const pairingReplySchema = z
  .object({
    v: z.literal(1),
    deviceName: displayText(60),
    platform: z.literal('ios'),
    approvalKey: p256PublicKeySchema,
    transportKey: p256PublicKeySchema,
    agreementKey: p256PublicKeySchema,
  })
  .strict()
export type PairingReply = z.infer<typeof pairingReplySchema>

/** What the Mac sends back, sealed, once the person approved at the Mac (or not). */
export const pairingResultSchema = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('paired'),
      /** The phone's record and the Mac's own, each signed by the Mac's approval key. */
      deviceRecord: signedTextSchema,
      macRecord: signedTextSchema,
    })
    .strict(),
  z.object({ outcome: z.enum(['declined', 'expired', 'too-many-attempts']) }).strict(),
])
export type PairingResult = z.infer<typeof pairingResultSchema>

export const pairingOfferIdSchema = keyIdSchema

/**
 * What the Mac signs, with the approval key the QR pins, when it sends `pairing-challenge`
 * (H's CR-11): the offer, its nonce, and the SHA-256 hex of the reply plaintext it accepted, as
 * JSON with keys in that order. Without the signature, a relay that saw the QR could answer
 * first itself, then grind a nonce for the phone until the phone's digits matched the Mac's. The
 * phone checks the signature and that `reply` is the hash of its own reply; if not, the Mac took
 * someone else's reply, and the phone stops ("Nothing was paired").
 */
export function pairingChallengePayload(offerId: string, macNonce: string, replyPlaintext: string): string {
  return JSON.stringify({ offerId, macNonce, reply: sha256Hex(replyPlaintext) })
}

/** True only if the Mac's approval key signed this challenge over this phone's own reply. */
export function verifyPairingChallenge(
  macApprovalKey: string,
  offerId: string,
  macNonce: string,
  replyPlaintext: string,
  signature: string,
): boolean {
  return verifyP256(
    macApprovalKey,
    SIGNING_DOMAINS.pairingChallenge,
    pairingChallengePayload(offerId, macNonce, replyPlaintext),
    signature,
  )
}
