// The hub's small crypto (relay-hub.md, "Accounts and devices"): authenticator-app codes (RFC 6238),
// password hashes, session tokens and the codes a Mac shows when it joins. WebCrypto only, so the
// same code runs in workerd and in Node's tests.

import { CONSENT_CODE_ALPHABET } from '@valet/core/approvals'
import { fromBase64url, toBase64url } from '../encoding'

const encoder = new TextEncoder()
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export const TOTP = { stepSeconds: 30, digits: 6, window: 1 } as const
/** Workers caps PBKDF2 at 100,000 iterations. */
export const PASSWORD_ITERATIONS = 100_000
export const PASSWORD_MIN_LENGTH = 12

export function base32(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
  return out
}

export function fromBase32(text: string): Uint8Array | null {
  const clean = text.toUpperCase().replace(/[\s=]/g, '')
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const char of clean) {
    const index = BASE32.indexOf(char)
    if (index < 0) return null
    value = ((value << 5) | index) & 0xffff
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return new Uint8Array(out)
}

export function newTotpSecret(): string {
  return base32(crypto.getRandomValues(new Uint8Array(20)))
}

export function totpUri(secret: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`)
  const query = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: '6', period: '30' })
  return `otpauth://totp/${label}?${query}`
}

/** The code for one 30-second step. */
export async function totpAt(secret: string, step: number): Promise<string> {
  const raw = fromBase32(secret)
  if (raw === null) throw new Error('bad secret')
  const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
  const counter = new Uint8Array(8)
  new DataView(counter.buffer).setBigUint64(0, BigInt(step))
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, counter))
  const offset = (mac[19] as number) & 15
  const binary =
    (((mac[offset] as number) & 0x7f) << 24) |
    ((mac[offset + 1] as number) << 16) |
    ((mac[offset + 2] as number) << 8) |
    (mac[offset + 3] as number)
  return String(binary % 10 ** TOTP.digits).padStart(TOTP.digits, '0')
}

/**
 * The step a typed code matches, within one step either side, and only if it is later than
 * `lastStep` (a code is good once). Null otherwise.
 */
export async function checkTotp(
  secret: string,
  typed: string,
  now: number,
  lastStep: number | null,
): Promise<number | null> {
  const code = typed.replace(/\s/g, '')
  if (!/^\d{6}$/.test(code)) return null
  const current = Math.floor(now / 1000 / TOTP.stepSeconds)
  for (let delta = -TOTP.window; delta <= TOTP.window; delta++) {
    const step = current + delta
    if (lastStep !== null && step <= lastStep) continue
    if (constantTimeEqual(await totpAt(secret, step), code)) return step
  }
  return null
}

/** `pbkdf2-sha256$<iterations>$<salt>$<hash>`, base64url parts. */
export async function hashPassword(password: string, salt?: Uint8Array): Promise<string> {
  const bytes = salt ?? crypto.getRandomValues(new Uint8Array(16))
  const hash = await pbkdf2(password, bytes, PASSWORD_ITERATIONS)
  return `pbkdf2-sha256$${PASSWORD_ITERATIONS}$${toBase64url(bytes)}$${toBase64url(hash)}`
}

export async function checkPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iterations, salt, hash] = stored.split('$')
  if (scheme !== 'pbkdf2-sha256' || iterations === undefined || salt === undefined || hash === undefined)
    return false
  const saltBytes = fromBase64url(salt)
  const count = Number(iterations)
  if (saltBytes === null || !Number.isInteger(count) || count < 1 || count > PASSWORD_ITERATIONS) return false
  const actual = await pbkdf2(password, saltBytes, count)
  return constantTimeEqual(toBase64url(actual), hash)
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password.normalize('NFKC')),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256),
  )
}

/** A random token of `bytes` bytes, base64url. */
export function token(bytes = 32): string {
  return toBase64url(crypto.getRandomValues(new Uint8Array(bytes)))
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)))
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** `ABCD-EFGH` from the consent alphabet (no I or O), as the Mac's consent codes are. */
export function linkCode(): string {
  const size = CONSENT_CODE_ALPHABET.length
  // Rejection sampling, so every letter is equally likely.
  const limit = 256 - (256 % size)
  const letters: string[] = []
  while (letters.length < 8) {
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
      if (byte < limit && letters.length < 8) letters.push(CONSENT_CODE_ALPHABET[byte % size] as string)
    }
  }
  return `${letters.slice(0, 4).join('')}-${letters.slice(4).join('')}`
}

/** A typed link code, upper-cased with spaces gone and the dash put back. Null if it can't be one. */
export function normaliseLinkCode(typed: string): string | null {
  const letters = typed.toUpperCase().replace(/[\s-]/g, '')
  if (!/^[A-HJ-NP-Z]{8}$/.test(letters)) return null
  return `${letters.slice(0, 4)}-${letters.slice(4)}`
}

/** A node's default slug from its name: "Nick's MacBook Pro" becomes "nicks-macbook-pro", cut to 16. */
export function slugFromName(name: string): string {
  const slug = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 16)
    .replace(/-+$/g, '')
  return slug === '' ? 'node' : slug
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
