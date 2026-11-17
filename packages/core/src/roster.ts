// The account's devices (docs/relay-hub.md, step 4): a hash-chained list of signed changes. Each
// change is signed by the approval key of a device already on the list, so the hub stores and
// hands it out but can't add a device by itself. The first change is the first device adding itself.
//
// A node (Mac) pins the hash of that first change when it joins the account and from then on
// trusts exactly the devices the chain lists. A hub that forks the chain, drops a change or
// reorders it fails `verifyRoster` on every node that saw the real one.

import { z } from 'zod'
import { DEVICE_ROLES, keyIdSchema } from './devices'
import { displayText } from './display-text'
import { sha256Hex } from './hash'
import {
  keyId,
  p256PublicKeySchema,
  p256SignatureSchema,
  SIGNING_DOMAINS,
  type SignedText,
  signedTextSchema,
  verifyP256,
} from './signing'

/** Devices an account may have at once. */
export const ROSTER_MAX_DEVICES = 32
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
    /** The device whose approval key signed this change. */
    by: keyIdSchema,
    change: z.discriminatedUnion('op', [
      z.object({ op: z.literal('add'), device: rosterDeviceSchema }).strict(),
      z.object({ op: z.literal('remove'), deviceId: keyIdSchema }).strict(),
    ]),
  })
  .strict()
export type RosterChange = z.infer<typeof rosterChangeSchema>

/** One signed change as it travels: small, so a whole chain fits in one relay frame. */
export const signedRosterChangeSchema = z
  .object({ payload: z.string().min(2).max(4096), signature: p256SignatureSchema })
  .strict()

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
        | 'stale'
    }

/**
 * Checks a whole chain from its first change. `pinned` is the genesis hash a node pinned, if it
 * has one; `known` is a head the caller saw before, which must still be in the chain (a hub can't
 * roll a node back to an older list).
 */
export function verifyRoster(
  chain: readonly SignedText[],
  options: {
    readonly pinned?: string
    readonly known?: { readonly seq: number; readonly head: string }
    /**
     * Checks one signature by an approval key over the roster-change domain; core's verifyP256 by
     * default. The relay passes one that only collects them, to check with WebCrypto afterwards.
     */
    readonly verify?: (approvalKey: string, payload: string, signature: string) => boolean
  } = {},
): RosterCheck {
  const verify =
    options.verify ??
    ((key: string, payload: string, signature: string) =>
      verifyP256(key, SIGNING_DOMAINS.rosterChange, payload, signature))
  if (chain.length === 0) return { ok: false, at: -1, reason: 'empty' }
  if (chain.length > ROSTER_MAX_CHANGES) return { ok: false, at: -1, reason: 'too-long' }
  const devices = new Map<string, RosterDevice>()
  let account = ''
  let genesis = ''
  let head = ''
  for (const [index, signed] of chain.entries()) {
    const fail = (reason: Extract<RosterCheck, { ok: false }>['reason']): RosterCheck => ({
      ok: false,
      at: index,
      reason,
    })
    if (!signedTextSchema.safeParse(signed).success) return fail('malformed')
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
    if (signer === undefined) return fail('not-a-member')
    if (!verify(signer.approvalKey, signed.payload, signed.signature)) return fail('bad-signature')
    if (change.change.op === 'add') {
      const device = change.change.device
      if (devices.has(device.deviceId)) return fail('duplicate')
      if (devices.size >= ROSTER_MAX_DEVICES) return fail('too-many-devices')
      devices.set(device.deviceId, device)
    } else {
      if (!devices.has(change.change.deviceId)) return fail('unknown-device')
      // Never the last one: an account with no devices could only be refilled by the hub.
      if (devices.size === 1) return fail('last-device')
      devices.delete(change.change.deviceId)
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
  return { ok: true, roster: { account, genesis, head, seq: chain.length - 1, devices } }
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
