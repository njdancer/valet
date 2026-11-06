// The signed feed envelope: the only thing that authenticates a channel file's version. Squirrel.Mac
// checks that an update is signed by us, never which version it is, and the channel file (version
// and SHA-512) comes unsigned from the same place as the zip. So anyone who controls the feed, or a
// hop on its path, could serve an old, genuinely signed build as "99.0.0", or keep serving
// yesterday's file forever. The envelope is signed with an offline Ed25519 key (not the Developer ID
// key) and pins the exact channel-file bytes, the channel, and a validity window.
//
//   <channel>-mac.envelope.json      canonical JSON, ASCII, keys in ENVELOPE_KEYS order
//   <channel>-mac.envelope.json.sig  base64 Ed25519 signature over the envelope's exact bytes
//
// verifyFeed is pure apart from node:crypto, and never puts feed text into what it returns.

import { createHash, createPublicKey, type KeyObject, verify } from 'node:crypto'
import { compareVersions, formatVersion, parseVersion, type Version } from './version'

/** The envelope's keys, in the only order accepted. */
export const ENVELOPE_KEYS = [
  'channel',
  'version',
  'ymlSha256',
  'minimumVersion',
  'issuedAt',
  'expiresAt',
] as const

/** An envelope is valid for at most this long, so a leaked old one can't be replayed for ever. */
export const MAX_ENVELOPE_VALIDITY_MS = 62 * 24 * 60 * 60 * 1000
/** How far ahead of this machine's clock issuedAt may be. */
export const MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000
/** Larger than any envelope or signature we write; anything bigger isn't parsed. */
export const MAX_ENVELOPE_BYTES = 1024
/** Larger than any channel file we write. */
export const MAX_YML_BYTES = 64 * 1024

export type FeedChannel = 'latest' | 'beta'

export interface FeedEnvelope {
  readonly channel: FeedChannel
  readonly version: string
  readonly ymlSha256: string
  readonly minimumVersion: string
  readonly issuedAt: string
  readonly expiresAt: string
}

export type FeedRefusal =
  /** The signature is missing, malformed or not by the feed key. */
  | 'signature-invalid'
  /** The envelope is not exactly the canonical form, or a field is malformed. */
  | 'envelope-invalid'
  /** The envelope is for the other channel. */
  | 'channel-mismatch'
  /** The validity window has passed, or hasn't started, or is longer than allowed. */
  | 'expired'
  /** The channel file is not the one the envelope signs, or names a different version. */
  | 'yml-mismatch'

export type FeedVerdict =
  | { readonly ok: true; readonly envelope: FeedEnvelope; readonly version: Version }
  | { readonly ok: false; readonly reason: FeedRefusal }

export interface VerifyFeedInput {
  readonly yml: string | null
  readonly envelope: string | null
  readonly signature: string | null
}

export interface VerifyFeedOptions {
  readonly publicKey: KeyObject
  readonly channel: FeedChannel
  /** ms since the epoch. */
  readonly now: number
  /**
   * Reads the version out of the channel file. Called only once the file's bytes match the
   * envelope, so unauthenticated YAML is never parsed. May throw.
   */
  readonly readYmlVersion: (yml: string) => unknown
}

const SHA256_HEX = /^[0-9a-f]{64}$/
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/
const SIGNATURE_BASE64 = /^[A-Za-z0-9+/]{86}==$/
/** Printable ASCII, space to tilde. */
const PRINTABLE_ASCII = /^[ -~]*$/

/** Loads the feed's public key (SPKI PEM). Throws if it isn't an Ed25519 public key. */
export function loadFeedPublicKey(pem: string): KeyObject {
  // createPublicKey would also derive one from a private key, which must never be in the app.
  if (
    typeof pem !== 'string' ||
    !/^-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=\n]+-----END PUBLIC KEY-----\n?$/.test(pem)
  ) {
    throw new TypeError('not a PEM public key')
  }
  const key = createPublicKey({ key: pem, format: 'pem' })
  if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') throw new TypeError('not an Ed25519 key')
  return key
}

/** The exact bytes an envelope is signed as: JSON, keys in ENVELOPE_KEYS order, no whitespace. */
export function canonicalEnvelope(envelope: FeedEnvelope): string {
  const ordered: Record<string, string> = {}
  for (const key of ENVELOPE_KEYS) ordered[key] = envelope[key]
  return JSON.stringify(ordered)
}

function time(text: unknown): number | null {
  if (typeof text !== 'string' || !ISO_TIME.test(text)) return null
  const value = Date.parse(text)
  return Number.isFinite(value) ? value : null
}

function canonicalVersion(text: unknown): Version | null {
  const version = parseVersion(text)
  return version !== null && formatVersion(version) === text ? version : null
}

function parseEnvelope(text: string): FeedEnvelope | null {
  if (text.length > MAX_ENVELOPE_BYTES || !PRINTABLE_ASCII.test(text)) return null
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (ENVELOPE_KEYS.some((key) => typeof record[key] !== 'string')) return null
  const envelope = record as unknown as FeedEnvelope
  // Byte-for-byte canonical: no extra or duplicate keys (JSON.parse keeps the last of a duplicate),
  // no reordering, no whitespace, no escapes, so what was signed is what is read.
  if (canonicalEnvelope(envelope) !== text) return null
  if (envelope.channel !== 'latest' && envelope.channel !== 'beta') return null
  if (!SHA256_HEX.test(envelope.ymlSha256)) return null
  const version = canonicalVersion(envelope.version)
  const minimum = canonicalVersion(envelope.minimumVersion)
  if (version === null || minimum === null || compareVersions(minimum, version) > 0) return null
  if (time(envelope.issuedAt) === null || time(envelope.expiresAt) === null) return null
  return envelope
}

function signatureBytes(text: string): Buffer | null {
  // One trailing newline is tolerated: the file is often written with one.
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text
  if (!SIGNATURE_BASE64.test(trimmed)) return null
  const bytes = Buffer.from(trimmed, 'base64')
  return bytes.length === 64 ? bytes : null
}

/** Checks a channel file against its signed envelope. */
export function verifyFeed(input: VerifyFeedInput, options: VerifyFeedOptions): FeedVerdict {
  const refuse = (reason: FeedRefusal): FeedVerdict => ({ ok: false, reason })
  const { envelope: envelopeText, signature: signatureText, yml } = input
  // ASCII only, so the bytes signed and the string electron-updater decoded can't differ.
  if (
    typeof envelopeText !== 'string' ||
    envelopeText.length > MAX_ENVELOPE_BYTES ||
    !PRINTABLE_ASCII.test(envelopeText)
  ) {
    return refuse('envelope-invalid')
  }
  if (typeof signatureText !== 'string' || signatureText.length > MAX_ENVELOPE_BYTES) {
    return refuse('signature-invalid')
  }
  const signature = signatureBytes(signatureText)
  if (signature === null) return refuse('signature-invalid')
  let valid = false
  try {
    valid = verify(null, Buffer.from(envelopeText, 'latin1'), options.publicKey, signature)
  } catch {
    valid = false
  }
  if (!valid) return refuse('signature-invalid')

  // Signed by the feed key from here on, but still checked: a signing mistake shouldn't install.
  const envelope = parseEnvelope(envelopeText)
  if (envelope === null) return refuse('envelope-invalid')
  if (envelope.channel !== options.channel) return refuse('channel-mismatch')
  const issuedAt = time(envelope.issuedAt) as number
  const expiresAt = time(envelope.expiresAt) as number
  if (
    !Number.isFinite(options.now) ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > MAX_ENVELOPE_VALIDITY_MS ||
    options.now >= expiresAt ||
    issuedAt > options.now + MAX_CLOCK_SKEW_MS
  ) {
    return refuse('expired')
  }

  if (typeof yml !== 'string' || yml.length > MAX_YML_BYTES) return refuse('yml-mismatch')
  const digest = createHash('sha256').update(yml, 'utf8').digest('hex')
  if (digest !== envelope.ymlSha256) return refuse('yml-mismatch')
  let ymlVersion: unknown
  try {
    ymlVersion = options.readYmlVersion(yml)
  } catch {
    return refuse('yml-mismatch')
  }
  if (ymlVersion !== envelope.version) return refuse('yml-mismatch')
  return { ok: true, envelope, version: canonicalVersion(envelope.version) as Version }
}
