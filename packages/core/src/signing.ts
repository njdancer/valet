// Device keys and signatures for agent-run Valet (docs/agent-run-security.md).
//
// Every key is ECDSA P-256, because that is the one curve the Secure Enclave holds on both the
// Mac and the iPhone. Public keys travel as base64url SubjectPublicKeyInfo DER (CryptoKit's
// `derRepresentation`), signatures as base64url raw r||s, 64 bytes (CryptoKit's
// `rawRepresentation`, IEEE P1363).
//
// "Sign the bytes, send the bytes": whoever signs sends the exact text it signed, and the verifier
// parses that text after checking the signature. Nobody re-serialises JSON to check a signature,
// so Swift and TypeScript never have to agree on a canonical form.

import { createPublicKey, type KeyObject, verify } from 'node:crypto'
import { z } from 'zod'
import { sha256Hex } from './hash'

/** Each signed thing has its own domain, so a signature over one can never pass as another. */
export const SIGNING_DOMAINS = {
  approvalRequest: 'valet/approval-request/v1',
  approvalDecision: 'valet/approval-decision/v1',
  deviceRecord: 'valet/device-record/v1',
  relayAuth: 'valet/relay-auth/v1',
  /** The Mac's approval key vouching for its relay transport key, once (no trust on first use). */
  relayBinding: 'valet/relay-binding/v1',
  pairing: 'valet/pairing/v1',
  /** The Mac vouching for the nonce it sent and the reply it accepted (H's CR-11). */
  pairingChallenge: 'valet/pairing/v1 challenge',
} as const
export type SigningDomain = (typeof SIGNING_DOMAINS)[keyof typeof SIGNING_DOMAINS]

const BASE64URL = /^[A-Za-z0-9_-]+$/
/** SPKI DER for a P-256 key is 91 bytes, 122 characters of base64url. */
const SPKI_P256_LENGTH = 91
const SIGNATURE_LENGTH = 64

/** A P-256 public key, base64url SPKI DER. */
export const p256PublicKeySchema = z
  .string()
  .max(200)
  .regex(BASE64URL)
  .refine((value) => p256PublicKey(value) !== null, 'must be a P-256 public key in SPKI DER, base64url')

/** A raw P-256 ECDSA signature, base64url. */
export const p256SignatureSchema = z
  .string()
  .max(100)
  .regex(BASE64URL)
  .refine((value) => Buffer.from(value, 'base64url').length === SIGNATURE_LENGTH, 'must be 64 bytes')

/** Text someone signed, with the signature over `<domain>\n<payload>`. */
export const signedTextSchema = z
  .object({
    payload: z
      .string()
      .min(2)
      .max(64 * 1024),
    signature: p256SignatureSchema,
  })
  .strict()
export type SignedText = z.infer<typeof signedTextSchema>

/** Parses a P-256 SPKI key; null for anything else, including other curves and key types. */
export function p256PublicKey(spki: string): KeyObject | null {
  if (!BASE64URL.test(spki)) return null
  const der = Buffer.from(spki, 'base64url')
  if (der.length !== SPKI_P256_LENGTH) return null
  try {
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' })
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return null
    return key
  } catch {
    return null
  }
}

/** A short, stable id for a public key: the first 128 bits of the SHA-256 of its DER, in hex. */
export function keyId(spki: string): string {
  return sha256Hex(Buffer.from(spki, 'base64url')).slice(0, 32)
}

/** The bytes a signature covers: the domain, a newline, then the payload text as UTF-8. */
export function signingInput(domain: SigningDomain, payload: string): Buffer {
  return Buffer.from(`${domain}\n${payload}`, 'utf8')
}

/** SHA-256 hex of a payload under its domain; what an approval decision names its request by. */
export function domainDigest(domain: SigningDomain, payload: string): string {
  return sha256Hex(signingInput(domain, payload))
}

/** True only for a valid signature by this key over this domain and payload. Never throws. */
export function verifyP256(
  publicKey: string,
  domain: SigningDomain,
  payload: string,
  signature: string,
): boolean {
  const key = p256PublicKey(publicKey)
  if (key === null || !BASE64URL.test(signature)) return false
  const raw = Buffer.from(signature, 'base64url')
  if (raw.length !== SIGNATURE_LENGTH) return false
  try {
    return verify('sha256', signingInput(domain, payload), { key, dsaEncoding: 'ieee-p1363' }, raw)
  } catch {
    return false
  }
}
