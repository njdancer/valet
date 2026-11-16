// An agent's access through the hub (docs/relay-hub.md, step 3): a grant signed by the approval
// key of a device on the account's list (roster.ts), after the person typed the code the agent's
// browser showed. The hub stores and hands out grants but can't make one: every node checks the
// signature against the list it verified itself before serving the agent.
//
// What a grant gives: the agent may call, on each node, the tools that node already lets remote
// agents use, still behind that node's own approvals, pacing and lockdown. Nothing wider.
// Taking access away needs no signature: a hub or a node may always drop a grant.

import { z } from 'zod'
import { keyIdSchema } from './devices'
import { displayText } from './display-text'
import { sha256Hex } from './hash'
import type { Roster } from './roster'
import {
  p256SignatureSchema,
  SIGNING_DOMAINS,
  type SignedText,
  signedTextSchema,
  verifyP256,
} from './signing'

/** How long a grant lasts before the person approves the agent again. */
export const HUB_GRANT_MAX_MS = 90 * 24 * 60 * 60_000

export const hubClientIdSchema = z.string().regex(/^hc[A-Za-z0-9_-]{10,40}$/)
export const hubConsentIdSchema = z.string().regex(/^[A-Za-z0-9_-]{10,40}$/)

export const hubGrantSchema = z
  .object({
    v: z.literal(1),
    /** The account at the hub (roster.ts's `account`). */
    account: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
    /** The sign-in it approves, so one approval opens one browser's sign-in. */
    consentId: hubConsentIdSchema,
    clientId: hubClientIdSchema,
    /** As the agent registered it: a claim, shown as one. */
    clientName: displayText(60),
    /** The host the agent's sign-in goes back to: a claim too. */
    host: z.string().regex(/^[a-z0-9.-]{1,253}$/),
    scope: z.literal('remote-tools'),
    at: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    /** The device whose approval key signed it. */
    by: keyIdSchema,
  })
  .strict()
  .refine((g) => {
    const span = Date.parse(g.expiresAt) - Date.parse(g.at)
    return span > 0 && span <= HUB_GRANT_MAX_MS
  }, 'a grant lasts at most 90 days')
export type HubGrant = z.infer<typeof hubGrantSchema>

export const signedHubGrantSchema = z
  .object({ payload: z.string().min(2).max(2048), signature: p256SignatureSchema })
  .strict()

/** A grant's id: SHA-256 hex of its signed payload. */
export function hubGrantId(signed: SignedText): string {
  return sha256Hex(signed.payload)
}

export type HubGrantCheck =
  | { readonly ok: true; readonly grant: HubGrant; readonly id: string }
  | {
      readonly ok: false
      readonly reason:
        | 'malformed'
        | 'wrong-account'
        | 'not-a-member'
        | 'bad-signature'
        | 'expired'
        | 'not-yet'
    }

/**
 * Checks a grant against a device list the caller verified (verifyRoster). `verify` is core's
 * verifyP256 by default; the hub passes one that collects the signature to check with WebCrypto.
 */
export function verifyHubGrant(
  signed: SignedText,
  roster: Roster,
  now: number,
  verify: (approvalKey: string, payload: string, signature: string) => boolean = (key, payload, signature) =>
    verifyP256(key, SIGNING_DOMAINS.hubGrant, payload, signature),
): HubGrantCheck {
  if (!signedTextSchema.safeParse(signed).success) return { ok: false, reason: 'malformed' }
  let parsed: unknown
  try {
    parsed = JSON.parse(signed.payload)
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  const result = hubGrantSchema.safeParse(parsed)
  if (!result.success) return { ok: false, reason: 'malformed' }
  const grant = result.data
  if (grant.account !== roster.account) return { ok: false, reason: 'wrong-account' }
  const device = roster.devices.get(grant.by)
  if (device === undefined) return { ok: false, reason: 'not-a-member' }
  if (!verify(device.approvalKey, signed.payload, signed.signature))
    return { ok: false, reason: 'bad-signature' }
  // A little slack for clocks that disagree.
  if (Date.parse(grant.at) > now + 5 * 60_000) return { ok: false, reason: 'not-yet' }
  if (Date.parse(grant.expiresAt) <= now) return { ok: false, reason: 'expired' }
  return { ok: true, grant, id: hubGrantId(signed) }
}
