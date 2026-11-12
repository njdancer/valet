// Checks a transport key's signature with WebCrypto. The format is core's (signing.ts): the key is
// base64url SPKI DER for P-256, the signature base64url raw r||s, which is WebCrypto's own ECDSA
// format, over `<domain>\n<payload>` with SHA-256.

import { SIGNING_DOMAINS } from '@valet/core/signing'
import { fromBase64url } from './encoding'

const ECDSA_P256 = { name: 'ECDSA', namedCurve: 'P-256' } as const

/** True only for a valid signature by this key over the relay-auth domain and payload. Never throws. */
export async function verifyRelayAuth(publicKey: string, payload: string, signature: string): Promise<boolean> {
  const der = fromBase64url(publicKey)
  const raw = fromBase64url(signature)
  if (der === null || raw === null || raw.length !== 64) return false
  try {
    const key = await crypto.subtle.importKey('spki', der, ECDSA_P256, false, ['verify'])
    const data = new TextEncoder().encode(`${SIGNING_DOMAINS.relayAuth}\n${payload}`)
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, raw, data)
  } catch {
    return false
  }
}
