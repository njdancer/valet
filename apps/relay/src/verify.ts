// Checks a transport key's signature with WebCrypto. The format is core's (signing.ts): the key is
// base64url SPKI DER for P-256, the signature base64url raw r||s, which is WebCrypto's own ECDSA
// format, over `<domain>\n<payload>` with SHA-256.

import { SIGNING_DOMAINS } from '@valet/core/signing'
import { fromBase64url } from './encoding'

const ECDSA_P256 = { name: 'ECDSA', namedCurve: 'P-256' } as const

/** True only for a valid signature by this key over the relay-auth domain and payload. Never throws. */
export function verifyRelayAuth(publicKey: string, payload: string, signature: string): Promise<boolean> {
  return verifyDomain(publicKey, SIGNING_DOMAINS.relayAuth, payload, signature)
}

/**
 * core's verifyRelayBinding, in WebCrypto (core's uses node:crypto, which the Workers runtime
 * doesn't fully have): the approval key's id is the Mac's id, and it signed this transport key.
 */
export async function verifyBinding(
  macId: string,
  transportKey: string,
  binding: { readonly approvalKey: string; readonly signature: string },
): Promise<boolean> {
  if ((await keyIdOf(binding.approvalKey)) !== macId) return false
  return verifyDomain(binding.approvalKey, SIGNING_DOMAINS.relayBinding, transportKey, binding.signature)
}

/** core's keyId: the first 128 bits of the SHA-256 of the DER, in hex. Null for bad base64url. */
export async function keyIdOf(spki: string): Promise<string | null> {
  const der = fromBase64url(spki)
  if (der === null) return null
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', der))
  return [...digest.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function verifyDomain(
  publicKey: string,
  domain: string,
  payload: string,
  signature: string,
): Promise<boolean> {
  const der = fromBase64url(publicKey)
  const raw = fromBase64url(signature)
  if (der === null || raw === null || raw.length !== 64) return false
  try {
    const key = await crypto.subtle.importKey('spki', der, ECDSA_P256, false, ['verify'])
    const data = new TextEncoder().encode(`${domain}\n${payload}`)
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, raw, data)
  } catch {
    return false
  }
}
