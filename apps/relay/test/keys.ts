// Software P-256 keys standing in for the Secure Enclave in tests: the same formats the Swift
// helper produces (SPKI DER and raw r||s, base64url).

import { generateKeyPairSync, type KeyObject, sign } from 'node:crypto'
import { keyId, SIGNING_DOMAINS } from '@valet/core'

export interface TestKey {
  readonly publicKey: string
  readonly id: string
  sign(payload: string): Promise<string>
  signDomain(domain: string, payload: string): string
}

export function testKey(): TestKey {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const spki = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64url')
  const signDomain = (domain: string, payload: string) => signWith(privateKey, domain, payload)
  return {
    publicKey: spki,
    id: keyId(spki),
    signDomain,
    sign: async (payload) => signDomain(SIGNING_DOMAINS.relayAuth, payload),
  }
}

function signWith(key: KeyObject, domain: string, payload: string): string {
  return sign('sha256', Buffer.from(`${domain}\n${payload}`, 'utf8'), {
    key,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url')
}
