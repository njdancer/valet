// A phone on the account, talking to the hub (docs/relay-hub.md, step 4c). The phone has no
// session cookie: it proves it is a device on the account's list with its transport key, the way
// it signs in to a Mac's relay object, over the same relay-auth payload with the hub's origin in
// it. The hub lets it in only if the account's verified list has that device with that key.
//
// What it gets: the account's device list, the Macs waiting to join it (each with the record it
// signed), and the account's Macs at the hub. What it may send: changes to the list it signed
// with its approval key, which the hub keeps only if the whole chain still checks.

import { z } from 'zod'
import { keyIdSchema } from './devices'
import { hubNodeNameSchema, hubNodeSlugSchema } from './relay-protocol'
import { ROSTER_MAX_CHANGES, signedJoinRecordSchema, signedRosterChangeSchema } from './roster'
import { p256SignatureSchema } from './signing'

/** How long a phone's challenge nonce is good for. */
export const HUB_PHONE_CHALLENGE_MS = 60_000

/** POST /phone/challenge answers with this. */
export const hubPhoneChallengeSchema = z
  .object({ nonce: z.string().regex(/^[A-Za-z0-9_-]{22,64}$/), expiresAt: z.iso.datetime() })
  .strict()

/**
 * POST /phone/account: the phone's signed answer to a challenge (the transport key over
 * relayAuthPayload with `relay` the hub's origin, role `phone`, id its deviceId) and, optionally,
 * changes to append. Each nonce works once.
 */
export const hubPhoneRequestSchema = z
  .object({
    deviceId: keyIdSchema,
    nonce: z.string().regex(/^[A-Za-z0-9_-]{22,64}$/),
    signature: p256SignatureSchema,
    append: z.array(signedRosterChangeSchema).min(1).max(8).optional(),
  })
  .strict()
export type HubPhoneRequest = z.infer<typeof hubPhoneRequestSchema>

export const hubPhoneAccountSchema = z
  .object({
    account: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
    /** The relay every Mac on the account dials: the phone reaches each at /v1/phone/<macId> there. */
    relay: z.url({ protocol: /^https$/ }).max(200),
    /** The whole chain, as the hub holds it after any append. The phone checks it itself. */
    changes: z.array(signedRosterChangeSchema).max(ROSTER_MAX_CHANGES),
    /** Set when `append` wasn't kept, and why; `changes` is then the chain without it. */
    refused: z.enum(['conflict', 'invalid']).optional(),
    /** Macs on the account at the hub that asked to join the list and aren't on it yet. */
    joining: z
      .array(z.object({ macId: keyIdSchema, record: signedJoinRecordSchema, at: z.iso.datetime() }).strict())
      .max(16),
    /** The account's Macs at the hub, for the phone to name and to tell which are still linked. */
    nodes: z
      .array(
        z
          .object({
            macId: keyIdSchema,
            slug: hubNodeSlugSchema,
            name: hubNodeNameSchema,
            online: z.boolean(),
          })
          .strict(),
      )
      .max(64),
  })
  .strict()
export type HubPhoneAccount = z.infer<typeof hubPhoneAccountSchema>
