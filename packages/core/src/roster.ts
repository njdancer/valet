// The account's devices (docs/relay-hub.md, step 4): a hash-chained list of signed changes. Each
// change is signed by the approval key of a device already on the list, so the hub stores and
// hands it out but can't add a device by itself. The first change is the first device adding itself.
//
// A node (Mac) pins the hash of that first change when it joins the account and from then on
// trusts exactly the devices the chain lists. A hub that forks the chain, drops a change or
// reorders it fails `verifyRoster` on every node that saw the real one.
//
// Passkeys (step 4d): a device can put one of the account's passkeys on the list. A phone then
// signs in to the account with that passkey: the passkey signs the change adding the phone (a
// WebAuthn assertion whose challenge is the change), and every node checks that assertion against
// the passkey's key on the list. A passkey can only add a phone; everything else needs a device.

import { createHash, verify as verifySignature } from 'node:crypto'
import { z } from 'zod'
import { DEVICE_ROLES, deviceRecordSchema, keyIdSchema } from './devices'
import { displayText } from './display-text'
import { sha256Hex } from './hash'
import {
  keyId,
  p256PublicKey,
  p256PublicKeySchema,
  p256SignatureSchema,
  SIGNING_DOMAINS,
  type SignedText,
  signedTextSchema,
  signingInput,
  verifyP256,
} from './signing'

/** Devices an account may have at once. */
export const ROSTER_MAX_DEVICES = 32
/** What `by` says when a passkey signed the change. */
export const PASSKEY_SIGNER = 'passkey'
/** Passkeys an account's list may hold at once. */
export const ROSTER_MAX_PASSKEYS = 8
/** Changes a chain may hold; well beyond any real account, so a hub can't make nodes do unbounded work. */
export const ROSTER_MAX_CHANGES = 512

export const rosterDeviceSchema = z
  .object({
    /** keyId(approvalKey). */
    deviceId: keyIdSchema,
    role: z.enum(DEVICE_ROLES),
    platform: z.enum(['macos', 'ios']),
    name: displayText(60),
    approvalKey: p256PublicKeySchema,
    transportKey: p256PublicKeySchema,
    agreementKey: p256PublicKeySchema,
  })
  .strict()
  .refine((d) => keyId(d.approvalKey) === d.deviceId, 'deviceId must be keyId(approvalKey)')
  .refine((d) => d.approvalKey !== d.transportKey && d.approvalKey !== d.agreementKey, 'keys must differ')
export type RosterDevice = z.infer<typeof rosterDeviceSchema>

/** A host name a passkey belongs to (its WebAuthn relying party id), such as valet.dncr.me. */
const RP_ID = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/

/** One of the account's passkeys, as a device put it on the list. Only ES256 (P-256) passkeys. */
export const rosterPasskeySchema = z
  .object({
    /** keyId(publicKey): what `by` names when this passkey signs. */
    passkeyId: keyIdSchema,
    /** The WebAuthn credential id, base64url, so a sign-in page can ask for exactly this one. */
    credentialId: z
      .string()
      .min(16)
      .max(512)
      .regex(/^[A-Za-z0-9_-]+$/),
    publicKey: p256PublicKeySchema,
    rpId: z.string().regex(RP_ID),
    name: displayText(60),
  })
  .strict()
  .refine((p) => keyId(p.publicKey) === p.passkeyId, 'passkeyId must be keyId(publicKey)')
export type RosterPasskey = z.infer<typeof rosterPasskeySchema>

export const rosterChangeSchema = z
  .object({
    v: z.literal(1),
    /** The account at the hub, so a change can't be replayed into another account's chain. */
    account: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
    /** 0 for the first change, then one more each time. */
    seq: z.number().int().min(0).max(ROSTER_MAX_CHANGES),
    /** rosterChangeHash of the change before; null only for the first. */
    prev: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    at: z.iso.datetime(),
    /**
     * The device whose approval key signed this change, or `passkey` for a phone signing in with
     * one of the account's passkeys on the list (the assertion names which, by credential id).
     */
    by: z.union([keyIdSchema, z.literal(PASSKEY_SIGNER)]),
    change: z.discriminatedUnion('op', [
      z.object({ op: z.literal('add'), device: rosterDeviceSchema }).strict(),
      z.object({ op: z.literal('remove'), deviceId: keyIdSchema }).strict(),
      z.object({ op: z.literal('add-passkey'), passkey: rosterPasskeySchema }).strict(),
      z.object({ op: z.literal('remove-passkey'), passkeyId: keyIdSchema }).strict(),
    ]),
  })
  .strict()
export type RosterChange = z.infer<typeof rosterChangeSchema>

/**
 * What a passkey's signature covers besides the change: the authenticator's data and the client
 * data the browser made, both base64url, exactly as WebAuthn returned them.
 */
export const rosterWebAuthnSchema = z
  .object({
    /** The passkey's WebAuthn credential id, base64url: which passkey on the list signed. */
    credentialId: z
      .string()
      .min(16)
      .max(512)
      .regex(/^[A-Za-z0-9_-]+$/),
    authenticatorData: z
      .string()
      .min(50)
      .max(1024)
      .regex(/^[A-Za-z0-9_-]+$/),
    clientDataJSON: z
      .string()
      .min(16)
      .max(2048)
      .regex(/^[A-Za-z0-9_-]+$/),
  })
  .strict()
export type RosterWebAuthn = z.infer<typeof rosterWebAuthnSchema>

/**
 * One signed change as it travels: small, so a whole chain fits in one relay frame. A change a
 * passkey signed carries `webauthn`, and `signature` is the assertion's, as raw r||s.
 */
export const signedRosterChangeSchema = z
  .object({
    payload: z.string().min(2).max(4096),
    signature: p256SignatureSchema,
    webauthn: rosterWebAuthnSchema.optional(),
  })
  .strict()
export type SignedRosterChange = z.infer<typeof signedRosterChangeSchema>

/** The WebAuthn challenge for a passkey to sign a change: SHA-256 of the change under its domain. */
export function passkeyChallenge(payload: string): Buffer {
  return createHash('sha256').update(signingInput(SIGNING_DOMAINS.rosterChange, payload)).digest()
}

/** The parts of WebAuthn's client data that matter here; browsers add others. */
const clientDataSchema = z.object({
  type: z.string(),
  challenge: z.string(),
  origin: z.string(),
  crossOrigin: z.boolean().optional(),
})

/**
 * The bytes a passkey's ES256 signature must cover for this change (authenticatorData then the
 * SHA-256 of clientDataJSON, as WebAuthn signs), or null when the assertion isn't for this change:
 * a `webauthn.get` at https://<rpId> whose challenge is this change, with the user present and
 * verified (Face ID, Touch ID or the passcode).
 */
export function passkeySignedData(
  passkey: RosterPasskey,
  payload: string,
  webauthn: RosterWebAuthn,
): Buffer | null {
  const authenticatorData = Buffer.from(webauthn.authenticatorData, 'base64url')
  const clientDataJSON = Buffer.from(webauthn.clientDataJSON, 'base64url')
  let client: unknown
  try {
    client = JSON.parse(clientDataJSON.toString('utf8'))
  } catch {
    return null
  }
  const c = clientDataSchema.safeParse(client)
  if (!c.success) return null
  if (c.data.type !== 'webauthn.get') return null
  if (c.data.challenge !== passkeyChallenge(payload).toString('base64url')) return null
  if (!passkeyOrigin(passkey.rpId, c.data.origin)) return null
  if (c.data.crossOrigin === true) return null
  if (authenticatorData.length < 37) return null
  const rpIdHash = createHash('sha256').update(passkey.rpId, 'utf8').digest()
  if (!authenticatorData.subarray(0, 32).equals(rpIdHash)) return null
  const flags = authenticatorData[32] ?? 0
  // User present (0x01) and user verified (0x04).
  if ((flags & 0x05) !== 0x05) return null
  return Buffer.concat([authenticatorData, createHash('sha256').update(clientDataJSON).digest()])
}

/** The page a passkey may sign on: https://<rpId>, or for a local test hub, http://localhost:<port>. */
function passkeyOrigin(rpId: string, origin: string): boolean {
  if (origin === `https://${rpId}`) return true
  return rpId === 'localhost' && /^http:\/\/localhost(:\d{1,5})?$/.test(origin)
}

/** core's check of a passkey's raw r||s signature over `data`; the relay passes its own. */
function verifyPasskeyData(publicKey: string, data: Uint8Array, signature: string): boolean {
  const key = p256PublicKey(publicKey)
  if (key === null) return false
  const raw = Buffer.from(signature, 'base64url')
  if (raw.length !== 64) return false
  try {
    return verifySignature('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, raw)
  } catch {
    return false
  }
}

/** A WebAuthn ES256 signature (ASN.1 DER) as raw r||s, base64url; null if it isn't one. */
export function rawFromDerSignature(der: Uint8Array): string | null {
  const bytes = Buffer.from(der)
  if (bytes.length < 8 || bytes[0] !== 0x30 || bytes[1] !== bytes.length - 2) return null
  let at = 2
  const parts: Buffer[] = []
  for (let i = 0; i < 2; i++) {
    if (bytes[at] !== 0x02) return null
    const length = bytes[at + 1] ?? 0
    let value = bytes.subarray(at + 2, at + 2 + length)
    if (value.length !== length || length === 0 || length > 33) return null
    at += 2 + length
    while (value.length > 32 && value[0] === 0) value = value.subarray(1)
    if (value.length > 32) return null
    parts.push(Buffer.concat([Buffer.alloc(32 - value.length), value]))
  }
  if (at !== bytes.length) return null
  return Buffer.concat(parts).toString('base64url')
}

/**
 * A P-256 COSE key (what WebAuthn stores for a passkey) as base64url SPKI DER, or why it isn't
 * one. Only EC2 keys on P-256 for ES256 qualify. Shape only, with no crypto library: the hub runs
 * this in a Worker, and every device that takes the key checks it with its own (rosterPasskeySchema).
 */
export function coseP256Spki(cose: Uint8Array): { readonly spki: string } | { readonly why: string } {
  const map = readCoseMap(cose)
  if (map === null)
    return { why: `not a COSE map this reads (${cose.length} bytes, first 0x${(cose[0] ?? 0).toString(16)})` }
  // 1 kty: 2 (EC2); 3 alg: -7 (ES256); -1 crv: 1 (P-256); -2 x; -3 y.
  if (map.get(1) !== 2 || map.get(3) !== -7 || map.get(-1) !== 1)
    return { why: `kty ${String(map.get(1))}, alg ${String(map.get(3))}, crv ${String(map.get(-1))}` }
  const x = map.get(-2)
  const y = map.get(-3)
  if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array) || x.length !== 32 || y.length !== 32)
    return { why: 'x or y isn’t 32 bytes' }
  const prefix = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex')
  return {
    spki: Buffer.concat([prefix, Buffer.from([4]), Buffer.from(x), Buffer.from(y)]).toString('base64url'),
  }
}

/** coseP256Spki, also checked as a point on P-256; null for anything else. */
export function spkiFromCoseP256(cose: Uint8Array): string | null {
  const found = coseP256Spki(cose)
  if (!('spki' in found)) return null
  return p256PublicKey(found.spki) === null ? null : found.spki
}

/** Just enough CBOR for a COSE key: one map of small integer keys to integers or byte strings. */
function readCoseMap(bytes: Uint8Array): Map<number, number | Uint8Array> | null {
  let at = 0
  const head = (): { major: number; value: number } | null => {
    const byte = bytes[at++]
    if (byte === undefined) return null
    const major = byte >> 5
    const info = byte & 0x1f
    if (info < 24) return { major, value: info }
    if (info === 24) {
      const v = bytes[at++]
      return v === undefined ? null : { major, value: v }
    }
    if (info === 25) {
      const a = bytes[at++]
      const b = bytes[at++]
      return a === undefined || b === undefined ? null : { major, value: (a << 8) | b }
    }
    return null
  }
  const item = (): number | Uint8Array | null => {
    const h = head()
    if (h === null) return null
    if (h.major === 0) return h.value
    if (h.major === 1) return -1 - h.value
    if (h.major === 2) {
      if (at + h.value > bytes.length) return null
      const out = bytes.slice(at, at + h.value)
      at += h.value
      return out
    }
    return null
  }
  const top = head()
  if (top === null || top.major !== 5 || top.value > 16) return null
  const map = new Map<number, number | Uint8Array>()
  for (let i = 0; i < top.value; i++) {
    const key = item()
    const value = item()
    if (typeof key !== 'number' || value === null) return null
    map.set(key, value)
  }
  return at === bytes.length ? map : null
}

/** What a node pins and what each next change names: SHA-256 hex of the signed payload text. */
export function rosterChangeHash(signed: SignedText): string {
  return sha256Hex(signed.payload)
}

export interface Roster {
  readonly account: string
  /** rosterChangeHash of the first change: what a node pins when it joins. */
  readonly genesis: string
  /** rosterChangeHash of the last change: what the next change names as `prev`. */
  readonly head: string
  readonly seq: number
  readonly devices: ReadonlyMap<string, RosterDevice>
  /** Passkeys on the list, by passkeyId: each may sign a phone in. */
  readonly passkeys: ReadonlyMap<string, RosterPasskey>
}

export type RosterCheck =
  | { readonly ok: true; readonly roster: Roster }
  | {
      readonly ok: false
      /** Index of the first change that failed, or -1 for the chain as a whole. */
      readonly at: number
      readonly reason:
        | 'empty'
        | 'too-long'
        | 'malformed'
        | 'bad-signature'
        | 'not-a-member'
        | 'broken-chain'
        | 'wrong-genesis'
        | 'wrong-account'
        | 'duplicate'
        | 'unknown-device'
        | 'last-device'
        | 'too-many-devices'
        | 'not-allowed'
        | 'stale'
    }

/**
 * Checks a whole chain from its first change. `pinned` is the genesis hash a node pinned, if it
 * has one; `known` is a head the caller saw before, which must still be in the chain (a hub can't
 * roll a node back to an older list).
 */
export function verifyRoster(
  chain: readonly SignedRosterChange[],
  options: {
    readonly pinned?: string
    readonly known?: { readonly seq: number; readonly head: string }
    /**
     * Checks one signature by an approval key over the roster-change domain; core's verifyP256 by
     * default. The relay passes one that only collects them, to check with WebCrypto afterwards.
     */
    readonly verify?: (approvalKey: string, payload: string, signature: string) => boolean
    /**
     * Checks a passkey's raw r||s signature over `data` (what passkeySignedData gives); node's by
     * default. The relay passes one that only collects them, as for `verify`.
     */
    readonly verifyPasskey?: (publicKey: string, data: Uint8Array, signature: string) => boolean
  } = {},
): RosterCheck {
  const verify =
    options.verify ??
    ((key: string, payload: string, signature: string) =>
      verifyP256(key, SIGNING_DOMAINS.rosterChange, payload, signature))
  const verifyPasskey = options.verifyPasskey ?? verifyPasskeyData
  if (chain.length === 0) return { ok: false, at: -1, reason: 'empty' }
  if (chain.length > ROSTER_MAX_CHANGES) return { ok: false, at: -1, reason: 'too-long' }
  const devices = new Map<string, RosterDevice>()
  const passkeys = new Map<string, RosterPasskey>()
  let account = ''
  let genesis = ''
  let head = ''
  for (const [index, signed] of chain.entries()) {
    const fail = (reason: Extract<RosterCheck, { ok: false }>['reason']): RosterCheck => ({
      ok: false,
      at: index,
      reason,
    })
    const wire = signedRosterChangeSchema.safeParse(signed)
    if (
      !wire.success ||
      !signedTextSchema.safeParse({ payload: signed.payload, signature: signed.signature }).success
    )
      return fail('malformed')
    const webauthn = wire.data.webauthn
    let parsed: unknown
    try {
      parsed = JSON.parse(signed.payload)
    } catch {
      return fail('malformed')
    }
    const result = rosterChangeSchema.safeParse(parsed)
    if (!result.success) return fail('malformed')
    const change = result.data
    if (change.seq !== index) return fail('broken-chain')
    if (index === 0) {
      // The first device adds itself: that is the account's root.
      if (change.prev !== null || change.change.op !== 'add' || change.change.device.deviceId !== change.by)
        return fail('broken-chain')
      account = change.account
    } else {
      if (change.prev !== head) return fail('broken-chain')
      if (change.account !== account) return fail('wrong-account')
    }
    const signer = index === 0 && change.change.op === 'add' ? change.change.device : devices.get(change.by)
    const passkey =
      signer === undefined && change.by === PASSKEY_SIGNER && webauthn !== undefined
        ? [...passkeys.values()].find((p) => p.credentialId === webauthn.credentialId)
        : undefined
    if (signer !== undefined) {
      if (webauthn !== undefined) return fail('malformed')
      if (!verify(signer.approvalKey, signed.payload, signed.signature)) return fail('bad-signature')
    } else if (passkey !== undefined && webauthn !== undefined) {
      // A passkey only ever signs a phone in.
      if (
        change.change.op !== 'add' ||
        change.change.device.role !== 'phone' ||
        change.change.device.platform !== 'ios'
      )
        return fail('not-allowed')
      const data = passkeySignedData(passkey, signed.payload, webauthn)
      if (data === null || !verifyPasskey(passkey.publicKey, data, signed.signature))
        return fail('bad-signature')
    } else if (change.by === PASSKEY_SIGNER && webauthn === undefined) return fail('malformed')
    else return fail('not-a-member')
    switch (change.change.op) {
      case 'add': {
        const device = change.change.device
        if (devices.has(device.deviceId) || passkeys.has(device.deviceId)) return fail('duplicate')
        if (devices.size >= ROSTER_MAX_DEVICES) return fail('too-many-devices')
        devices.set(device.deviceId, device)
        break
      }
      case 'remove':
        if (!devices.has(change.change.deviceId)) return fail('unknown-device')
        // Never the last one: an account with no devices could only be refilled by the hub.
        if (devices.size === 1) return fail('last-device')
        devices.delete(change.change.deviceId)
        break
      case 'add-passkey': {
        const added = change.change.passkey
        if (passkeys.has(added.passkeyId) || devices.has(added.passkeyId)) return fail('duplicate')
        if (passkeys.size >= ROSTER_MAX_PASSKEYS) return fail('too-many-devices')
        passkeys.set(added.passkeyId, added)
        break
      }
      case 'remove-passkey':
        if (!passkeys.has(change.change.passkeyId)) return fail('unknown-device')
        passkeys.delete(change.change.passkeyId)
        break
    }
    head = rosterChangeHash(signed)
    if (index === 0) genesis = head
    if (options.known !== undefined && index === options.known.seq && head !== options.known.head)
      return fail('broken-chain')
  }
  if (options.pinned !== undefined && options.pinned !== genesis)
    return { ok: false, at: 0, reason: 'wrong-genesis' }
  if (options.known !== undefined && chain.length - 1 < options.known.seq)
    return { ok: false, at: -1, reason: 'stale' }
  return { ok: true, roster: { account, genesis, head, seq: chain.length - 1, devices, passkeys } }
}

/** The payload of the next change after `roster` (or the first, with `roster` null), for a device to sign. */
export function nextRosterChange(
  roster: Roster | null,
  account: string,
  by: string,
  change: RosterChange['change'],
  at: string,
): string {
  const next: RosterChange = {
    v: 1,
    account: roster?.account ?? account,
    seq: roster === null ? 0 : roster.seq + 1,
    prev: roster?.head ?? null,
    at,
    by,
    change,
  }
  return JSON.stringify(next)
}

/**
 * A Mac asking to join a list another device started (relay-hub.md, step 4c): its own device
 * record (devices.ts), signed by its own approval key. That proves the Mac holds the approval key
 * and binds its transport and agreement keys to it, so a phone that adds it adds exactly this
 * Mac's keys, whatever the hub says.
 */
export const signedJoinRecordSchema = z
  .object({ payload: z.string().min(2).max(4096), signature: p256SignatureSchema })
  .strict()

/**
 * The device a join record asks to add, or null if it isn't a Mac's own record signed by its own
 * key. `macId`, when given, is the Mac the hub says asked. `verify` as for verifyRoster, over the
 * device-record domain.
 */
export function joinRecordDevice(
  signed: SignedText,
  options: {
    readonly macId?: string
    readonly verify?: (approvalKey: string, payload: string, signature: string) => boolean
  } = {},
): RosterDevice | null {
  if (!signedJoinRecordSchema.safeParse(signed).success) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(signed.payload)
  } catch {
    return null
  }
  const result = deviceRecordSchema.safeParse(parsed)
  if (!result.success) return null
  const record = result.data
  if (record.role !== 'mac' || record.platform !== 'macos' || record.macId !== record.deviceId) return null
  if (options.macId !== undefined && record.deviceId !== options.macId) return null
  const verify =
    options.verify ??
    ((key: string, payload: string, signature: string) =>
      verifyP256(key, SIGNING_DOMAINS.deviceRecord, payload, signature))
  if (!verify(record.approvalKey, signed.payload, signed.signature)) return null
  return {
    deviceId: record.deviceId,
    role: 'mac',
    platform: 'macos',
    name: record.name,
    approvalKey: record.approvalKey,
    transportKey: record.transportKey,
    agreementKey: record.agreementKey,
  }
}
