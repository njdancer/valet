// The Mac-to-phone channel's seal (docs/agent-run-security.md#the-relay-protocol): RFC 9180 HPKE,
// DHKEM(P-256, HKDF-SHA256), HKDF-SHA256, AES-256-GCM, auth mode, one single-shot seal per
// envelope, with `info` = envelopeInfo(from, to) and no AAD. This is the same seal the phone makes
// with CryptoKit's `HPKE.Sender(…, authenticatedBy:)` (ios/ValetPhoneKit ValetCrypto/Seal.swift).
//
// Node has no HPKE, so the scheme is written out here from the RFC. The static key's half of each
// Diffie-Hellman is a callback, so the agreement key can live in the Secure Enclave helper: only
// the ephemeral key is ever made in this process.
//
// Also here: the pairing result's seal, AES-256-GCM under pairingSealKey (pairing.ts opens).

import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  createHmac,
  createPublicKey,
  type KeyObject,
  randomBytes,
} from 'node:crypto'
import type { Sealed } from './pairing'
import { type Envelope, envelopeInfo } from './relay-protocol'
import { p256PublicKey } from './signing'

const KEM_ID = 0x0010
const KDF_ID = 0x0001
const AEAD_ID = 0x0002
const MODE_AUTH = 0x02
const N_SECRET = 32
const N_K = 32
const N_N = 12
const N_ENC = 65
const SUITE = 'hpke-auth-p256-sha256-aes256gcm' as const

const i2osp = (value: number, length: number): Buffer => {
  const out = Buffer.alloc(length)
  out.writeUIntBE(value, 0, length)
  return out
}
const KEM_SUITE = Buffer.concat([Buffer.from('KEM'), i2osp(KEM_ID, 2)])
const HPKE_SUITE = Buffer.concat([Buffer.from('HPKE'), i2osp(KEM_ID, 2), i2osp(KDF_ID, 2), i2osp(AEAD_ID, 2)])
const V1 = Buffer.from('HPKE-v1')

function extract(salt: Buffer, ikm: Buffer): Buffer {
  return createHmac('sha256', salt).update(ikm).digest()
}

function expand(prk: Buffer, info: Buffer, length: number): Buffer {
  const out: Buffer[] = []
  let previous = Buffer.alloc(0)
  for (let i = 1; out.length * 32 < length; i++) {
    previous = createHmac('sha256', prk)
      .update(Buffer.concat([previous, info, Buffer.from([i])]))
      .digest()
    out.push(previous)
  }
  return Buffer.concat(out).subarray(0, length)
}

const labeledExtract = (suite: Buffer, salt: Buffer, label: string, ikm: Buffer) =>
  extract(salt, Buffer.concat([V1, suite, Buffer.from(label), ikm]))
const labeledExpand = (suite: Buffer, prk: Buffer, label: string, info: Buffer, length: number) =>
  expand(prk, Buffer.concat([i2osp(length, 2), V1, suite, Buffer.from(label), info]), length)

/** The uncompressed point (65 bytes) of a P-256 public key: what HPKE serialises. */
export function rawPoint(key: KeyObject): Buffer {
  const jwk = key.export({ format: 'jwk' })
  if (jwk.x === undefined || jwk.y === undefined) throw new Error('not an EC public key')
  return Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')])
}

function pointKey(point: Buffer): KeyObject | null {
  if (point.length !== N_ENC || point[0] !== 4) return null
  try {
    return createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: point.subarray(1, 33).toString('base64url'),
        y: point.subarray(33).toString('base64url'),
      },
      format: 'jwk',
    })
  } catch {
    return null
  }
}

/**
 * The static agreement key's half of a Diffie-Hellman: the 32-byte x coordinate of the shared
 * point with `peer` (a P-256 public key). The Mac's comes from the helper or the software keys.
 */
export type Agree = (peer: KeyObject) => Promise<Buffer>

function keySchedule(sharedSecret: Buffer, info: Buffer): { key: Buffer; nonce: Buffer } {
  const empty = Buffer.alloc(0)
  const pskIdHash = labeledExtract(HPKE_SUITE, empty, 'psk_id_hash', empty)
  const infoHash = labeledExtract(HPKE_SUITE, empty, 'info_hash', info)
  const context = Buffer.concat([Buffer.from([MODE_AUTH]), pskIdHash, infoHash])
  const secret = labeledExtract(HPKE_SUITE, sharedSecret, 'secret', empty)
  return {
    key: labeledExpand(HPKE_SUITE, secret, 'key', context, N_K),
    nonce: labeledExpand(HPKE_SUITE, secret, 'base_nonce', context, N_N),
  }
}

function kemSharedSecret(dh: Buffer, enc: Buffer, recipient: Buffer, sender: Buffer): Buffer {
  const prk = labeledExtract(KEM_SUITE, Buffer.alloc(0), 'eae_prk', dh)
  return labeledExpand(KEM_SUITE, prk, 'shared_secret', Buffer.concat([enc, recipient, sender]), N_SECRET)
}

export interface SealParties {
  readonly from: string
  readonly to: string
  /** The sender's agreement public key, SPKI base64url (it goes into the KEM context). */
  readonly senderKey: string
  /** The recipient's agreement public key, SPKI base64url. */
  readonly recipientKey: string
}

/**
 * Seals one message from `from` to `to`. `agree` is the sender's static key; `ephemeral` is for
 * tests only (a fixed ephemeral private key, 32 bytes).
 */
export async function sealEnvelope(
  plaintext: string,
  parties: SealParties,
  agree: Agree,
  ephemeral?: Buffer,
): Promise<Envelope> {
  const recipient = p256PublicKey(parties.recipientKey)
  const sender = p256PublicKey(parties.senderKey)
  if (recipient === null || sender === null) throw new Error('not a P-256 agreement key')
  const ecdh = createECDH('prime256v1')
  if (ephemeral === undefined) ecdh.generateKeys()
  else ecdh.setPrivateKey(ephemeral)
  const enc = ecdh.getPublicKey()
  const recipientPoint = rawPoint(recipient)
  const dh = Buffer.concat([ecdh.computeSecret(recipientPoint), await agree(recipient)])
  const shared = kemSharedSecret(dh, enc, recipientPoint, rawPoint(sender))
  const { key, nonce } = keySchedule(shared, envelopeInfo(parties.from, parties.to))
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()])
  return {
    v: 1,
    suite: SUITE,
    from: parties.from,
    to: parties.to,
    enc: enc.toString('base64url'),
    ct: ct.toString('base64url'),
  }
}

/**
 * Opens an envelope addressed to `parties.to` from `parties.from`, sealed by that sender's pinned
 * key. Null if anything is wrong: the parties, the encoding, the key, the bytes.
 */
export async function openEnvelope(
  envelope: Envelope,
  parties: SealParties,
  agree: Agree,
): Promise<string | null> {
  if (envelope.from !== parties.from || envelope.to !== parties.to || envelope.suite !== SUITE) return null
  const sender = p256PublicKey(parties.senderKey)
  const me = p256PublicKey(parties.recipientKey)
  const enc = Buffer.from(envelope.enc, 'base64url')
  const ct = Buffer.from(envelope.ct, 'base64url')
  const ephemeral = pointKey(enc)
  if (sender === null || me === null || ephemeral === null || ct.length < 17) return null
  try {
    const dh = Buffer.concat([await agree(ephemeral), await agree(sender)])
    const shared = kemSharedSecret(dh, enc, rawPoint(me), rawPoint(sender))
    const { key, nonce } = keySchedule(shared, envelopeInfo(envelope.from, envelope.to))
    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAuthTag(ct.subarray(ct.length - 16))
    return Buffer.concat([decipher.update(ct.subarray(0, ct.length - 16)), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}

/** Seals a pairing message (AES-256-GCM, 12-byte random IV, tag appended). `openSealed` opens it. */
export function sealPairing(key: Buffer, plaintext: string, aad: string): Sealed {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(aad))
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()])
  return { iv: iv.toString('base64url'), ct: ct.toString('base64url') }
}
