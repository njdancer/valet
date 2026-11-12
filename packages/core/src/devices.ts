// Paired devices (docs/agent-run-security.md#devices-and-keys). The Mac is a device too: its
// approval key is the root every other record is signed by.
//
// Each device holds three P-256 keys:
// - approval key: in the Secure Enclave, usable only after Face ID or Touch ID (or the device
//   passcode). It signs approval decisions, and on the Mac, device records. Nothing else.
// - transport key: in the Secure Enclave without a user-presence requirement. It signs the relay's
//   connection challenge, so the device can reconnect unattended. It can never approve anything.
// - agreement key: for the end-to-end channel between the Mac and its phones (HPKE, auth mode).

import { z } from 'zod'
import { displayText } from './display-text'
import { keyId, p256PublicKeySchema, SIGNING_DOMAINS, type SignedText, verifyP256 } from './signing'

export const KEY_ID = /^[0-9a-f]{32}$/
export const keyIdSchema = z.string().regex(KEY_ID)

export const DEVICE_ROLES = ['mac', 'phone'] as const
export type DeviceRole = (typeof DEVICE_ROLES)[number]

export const deviceRecordSchema = z
  .object({
    v: z.literal(1),
    /** keyId(approvalKey). */
    deviceId: keyIdSchema,
    /** The deviceId of the Mac this record belongs to. A Mac's own record names itself. */
    macId: keyIdSchema,
    role: z.enum(DEVICE_ROLES),
    platform: z.enum(['macos', 'ios']),
    /** The name the person gave the device, shown on cards ("Nick's iPhone"). */
    name: displayText(60),
    approvalKey: p256PublicKeySchema,
    transportKey: p256PublicKeySchema,
    agreementKey: p256PublicKeySchema,
    pairedAt: z.iso.datetime(),
  })
  .strict()
  .refine((r) => keyId(r.approvalKey) === r.deviceId, 'deviceId must be keyId(approvalKey)')
  .refine((r) => (r.role === 'mac') === (r.deviceId === r.macId), 'only the Mac record names itself')
  .refine((r) => r.approvalKey !== r.transportKey && r.approvalKey !== r.agreementKey, 'keys must differ')
export type DeviceRecord = z.infer<typeof deviceRecordSchema>

export type DeviceRecordCheck =
  | { readonly ok: true; readonly record: DeviceRecord }
  | { readonly ok: false; readonly reason: 'malformed' | 'bad-signature' | 'wrong-mac' }

/**
 * Checks a device record signed by the Mac's approval key: the signature first, then the payload's
 * shape, then that it names this Mac. A Mac's own record is self-signed with the same key.
 */
export function verifyDeviceRecord(signed: SignedText, macApprovalKey: string): DeviceRecordCheck {
  if (!verifyP256(macApprovalKey, SIGNING_DOMAINS.deviceRecord, signed.payload, signed.signature)) {
    return { ok: false, reason: 'bad-signature' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(signed.payload)
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  const result = deviceRecordSchema.safeParse(parsed)
  if (!result.success) return { ok: false, reason: 'malformed' }
  if (result.data.macId !== keyId(macApprovalKey)) return { ok: false, reason: 'wrong-mac' }
  return { ok: true, record: result.data }
}

/** A device the person revoked. Revoking only tightens, so it needs no signature. */
export const deviceRevocationSchema = z
  .object({
    deviceId: keyIdSchema,
    revokedAt: z.iso.datetime(),
    /** Which device the person revoked it from, or 'mac-ui' for the Mac's own window. */
    by: z.union([keyIdSchema, z.literal('mac-ui')]),
  })
  .strict()
export type DeviceRevocation = z.infer<typeof deviceRevocationSchema>

/** What approval and evidence checks need from the device store. */
export interface DeviceLookup {
  /** The verified record, or null if no such device was ever paired with this Mac. */
  device(deviceId: string): DeviceRecord | null
  /** When the device was revoked, or null if it is still paired. */
  revokedAt(deviceId: string): string | null
}

/** The QR code the Mac shows to pair a phone. Lives at most PAIRING_QR_TTL_MS and is single use. */
export const pairingOfferSchema = z
  .object({
    v: z.literal(1),
    macId: keyIdSchema,
    /** The Mac's approval key, so the phone can verify every record and request it is sent. */
    macApprovalKey: p256PublicKeySchema,
    macAgreementKey: p256PublicKeySchema,
    /** The relay origin the Mac is connected to, e.g. https://relay.example. */
    relay: z.url({ protocol: /^https$/ }),
    /** 32 random bytes, base64url. Seals the phone's reply so the relay can't read or alter it. */
    secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    expiresAt: z.iso.datetime(),
  })
  .strict()
export type PairingOffer = z.infer<typeof pairingOfferSchema>

export const PAIRING_QR_TTL_MS = 5 * 60_000
/** Wrong confirmations before the Mac abandons the offer and needs a new QR code. */
export const PAIRING_MAX_ATTEMPTS = 3
