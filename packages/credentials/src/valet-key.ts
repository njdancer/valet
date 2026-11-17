// SSH keys Valet makes for an adapter's credential (docs/adapter-kinds.md#f2-secrets-version-2).
// The private half is written straight into Valet's Keychain items and is only ever read back by
// the protocol host that signs in with it; the person is shown the public half to add to the
// server. Nothing about the key has to leave the Mac.
//
// A key is an Ed25519 key in OpenSSH's own private-key format, which every SSH library reads. Its
// grant's itemRef is `valet-key:<uuid>`; the Keychain item is service KEY_SERVICE, account <uuid>,
// and its comment (not secret) holds the public half and when it was made.

import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'
import { CredentialError, type CredentialProvider, type ItemField, type SecretValue } from '@valet/core'
import type { KeychainStore } from './keychain-helper'

/** The Keychain service generated keys live under. The desktop app's dev build uses its own. */
export const KEY_SERVICE = 'valet.key'

const REF = /^valet-key:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/
const LABEL = /^[a-z0-9][a-z0-9._-]{0,99}$/
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/
const PUBLIC_KEY = /^ssh-ed25519 [A-Za-z0-9+/]{68} [a-z0-9][a-z0-9._-]{0,99}$/

export function isValetKeyRef(value: string): boolean {
  return REF.test(value)
}

/** What anyone may know about a generated key: never its private half. */
export interface ValetKeyInfo {
  readonly itemRef: string
  /** One line for an authorized_keys file: `ssh-ed25519 <base64> <label>`. */
  readonly publicKey: string
  /** SHA256:<base64>, as `ssh-keygen -l` prints it, for checking what the server has. */
  readonly fingerprint: string
  readonly createdAt: string
}

export interface ValetKeysOptions {
  readonly keychain: KeychainStore
  readonly service?: string
  readonly now?: () => Date
}

/** Makes, reads and forgets generated keys, and resolves `valet-key` grants. */
export class ValetKeys implements CredentialProvider {
  readonly kind = 'valet-key' as const
  readonly #keychain: KeychainStore
  readonly #service: string
  readonly #now: () => Date

  constructor(options: ValetKeysOptions) {
    this.#keychain = options.keychain
    this.#service = options.service ?? KEY_SERVICE
    this.#now = options.now ?? (() => new Date())
  }

  /**
   * Makes a key and stores its private half. `label` ends the public line, so the person can tell
   * Valet's keys apart in authorized_keys: letters, digits, ".", "_" and "-" only.
   */
  async generate(label: string): Promise<ValetKeyInfo> {
    if (!LABEL.test(label)) throw new CredentialError('unavailable')
    const id = randomUUID()
    const itemRef = `valet-key:${id}`
    const { publicKey: publicBytes, privateKey } = ed25519Pair()
    const publicKey = `ssh-ed25519 ${sshPublicBlob(publicBytes).toString('base64')} ${label}`
    const createdAt = this.#now().toISOString()
    const pem = openSshPrivateKey(privateKey, publicBytes, label)
    privateKey.fill(0)
    // write() takes ownership of the buffer and zeroes it.
    await this.#keychain.write(this.#service, id, pem, JSON.stringify({ v: 1, publicKey, createdAt }))
    return { itemRef, publicKey, fingerprint: fingerprintOf(publicKey), createdAt }
  }

  /** The public half and when it was made, or null for no such key (or a damaged comment). */
  async info(itemRef: string): Promise<ValetKeyInfo | null> {
    const id = REF.exec(itemRef)?.[1]
    if (id === undefined) return null
    const comment = await this.#keychain.info(this.#service, id)
    if (comment === null) return null
    const parsed = parseComment(comment)
    return parsed === null ? null : { itemRef, ...parsed, fingerprint: fingerprintOf(parsed.publicKey) }
  }

  /** The private half, in OpenSSH format. Only the `ssh-key` field exists. */
  async resolve(itemRef: string, field: ItemField): Promise<SecretValue> {
    const id = REF.exec(itemRef)?.[1]
    if (id === undefined) throw new CredentialError('not-found')
    if (field !== 'ssh-key') throw new CredentialError('field-missing')
    return this.#keychain.read(this.#service, id)
  }

  async forget(itemRef: string): Promise<void> {
    const id = REF.exec(itemRef)?.[1]
    if (id !== undefined) await this.#keychain.delete(this.#service, id)
  }

  /** Every key this build ever made: an uninstall or a reset. */
  async forgetAll(): Promise<void> {
    await this.#keychain.purge(this.#service)
  }
}

function parseComment(comment: string): { publicKey: string; createdAt: string } | null {
  let value: unknown
  try {
    value = JSON.parse(comment)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const { v, publicKey, createdAt } = value as Record<string, unknown>
  if (v !== 1 || Object.keys(value).length !== 3) return null
  if (typeof publicKey !== 'string' || !PUBLIC_KEY.test(publicKey)) return null
  if (typeof createdAt !== 'string' || !ISO_INSTANT.test(createdAt)) return null
  return { publicKey, createdAt }
}

/**
 * The raw 32-byte public key and 32-byte seed, from DER buffers (RFC 8410: each ends with its
 * 32 key bytes), so the seed is never a JS string. The caller zeroes the seed (red team B12).
 */
function ed25519Pair(): { publicKey: Buffer; privateKey: Buffer } {
  const pair = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  })
  const der = pair.privateKey
  if (der.length !== 48 || pair.publicKey.length !== 44) {
    der.fill(0)
    throw new CredentialError('unavailable')
  }
  const privateKey = Buffer.from(der.subarray(16))
  der.fill(0)
  return { publicKey: Buffer.from(pair.publicKey.subarray(12)), privateKey }
}

function sshString(value: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(value.length)
  return Buffer.concat([length, value])
}

function uint32(value: number): Buffer {
  const out = Buffer.alloc(4)
  out.writeUInt32BE(value)
  return out
}

function sshPublicBlob(publicKey: Buffer): Buffer {
  return Buffer.concat([sshString(Buffer.from('ssh-ed25519')), sshString(publicKey)])
}

/**
 * The key in OpenSSH's "openssh-key-v1" format, unencrypted (PROTOCOL.key in OpenSSH's sources):
 * the Keychain item is the protection, as it is for a password. Returns a buffer the caller hands
 * on; the intermediate buffers holding the seed are zeroed.
 */
function openSshPrivateKey(seed: Buffer, publicKey: Buffer, comment: string): Buffer {
  const check = randomBytes(4)
  const secret = Buffer.concat([seed, publicKey])
  const parts = [
    check,
    check,
    sshString(Buffer.from('ssh-ed25519')),
    sshString(publicKey),
    sshString(secret),
    sshString(Buffer.from(comment)),
  ]
  let body = Buffer.concat(parts)
  secret.fill(0)
  for (const part of parts) part.fill(0)
  const padding = (8 - (body.length % 8)) % 8
  if (padding > 0) {
    const padded = Buffer.concat([body, Buffer.from(Array.from({ length: padding }, (_, i) => i + 1))])
    body.fill(0)
    body = padded
  }
  const none = sshString(Buffer.from('none'))
  const whole = Buffer.concat([
    Buffer.from('openssh-key-v1\0'),
    none,
    none,
    sshString(Buffer.alloc(0)),
    uint32(1),
    sshString(sshPublicBlob(publicKey)),
    sshString(body),
  ])
  body.fill(0)
  const base64 = whole.toString('base64')
  whole.fill(0)
  const lines = base64.match(/.{1,70}/g) ?? []
  return Buffer.from(
    `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines.join('\n')}\n-----END OPENSSH PRIVATE KEY-----\n`,
  )
}

function fingerprintOf(publicKey: string): string {
  const blob = Buffer.from(publicKey.split(' ')[1] ?? '', 'base64')
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`
}
