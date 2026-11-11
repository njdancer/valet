// RFC 6238 one-time codes (SHA-1, 6 digits, 30 s), as 1Password generates them for a Login's
// one-time password field. The secret is base32, as an otpauth:// URI carries it.

import { createHmac } from 'node:crypto'

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** The bytes of a base32 secret (spaces, padding and case ignored), or null for anything else. */
export function decodeBase32(secret: string): Buffer | null {
  const clean = secret.replace(/[\s=]/g, '').toUpperCase()
  if (clean.length === 0) return null
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const char of clean) {
    const index = BASE32.indexOf(char)
    if (index < 0) return null
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

/** The code for `secret` at `now` (ms since the epoch). */
export function totp(secret: string, now: number, { digits = 6, period = 30 } = {}): string {
  const key = decodeBase32(secret)
  if (key === null) throw new Error('not a base32 secret')
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / period)))
  const mac = createHmac('sha1', key).update(counter).digest()
  const offset = (mac[mac.length - 1] as number) & 0x0f
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits
  return String(code).padStart(digits, '0')
}
