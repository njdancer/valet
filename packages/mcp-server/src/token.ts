// The endpoint's bearer token. It is not a site secret, so it travels as a string: it never reaches
// adapter code, and SecretValue.reveal() is reserved for the privileged filler.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { SiteAdapterError } from '@siteadapter/core'
import { readPrivateFile, writePrivateFile } from './private-file'

const TOKEN_BYTES = 32
/** 32 bytes in unpadded base64url. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

export function generateToken(random: (size: number) => Buffer = randomBytes): string {
  return random(TOKEN_BYTES).toString('base64url')
}

export function isWellFormedToken(token: string): boolean {
  return TOKEN_PATTERN.test(token)
}

/**
 * Compares a presented token with the expected one in time that depends on neither. Hashing first
 * gives both sides the same length, so a length mismatch isn't revealed by an early return either.
 */
export function tokensEqual(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented, 'utf8').digest()
  const b = createHash('sha256').update(expected, 'utf8').digest()
  return timingSafeEqual(a, b)
}

export async function writeTokenFile(path: string, token: string): Promise<void> {
  if (!isWellFormedToken(token)) throw new SiteAdapterError('credential', 'invalid')
  await writePrivateFile(path, `${token}\n`)
}

export async function readTokenFile(path: string): Promise<string> {
  const token = (await readPrivateFile(path)).trim()
  if (!isWellFormedToken(token)) throw new SiteAdapterError('credential', 'invalid')
  return token
}
