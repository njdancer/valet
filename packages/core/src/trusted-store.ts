// Stores the Mac can trust (docs/agent-run-security.md#trusted-stores): approvals, grants, remote
// tool policy, devices. Two independent checks guard each one.
//
// 1. Evidence. Every record that widens anything carries the signed approval that allowed it: the
//    request text and the device's signature. A record without valid evidence is ignored, so a
//    process that can write the file still can't add an approval without a device's Secure
//    Enclave key and the person's face or finger.
// 2. An anchor. The SHA-256 of the store file, and a generation number, live in a Keychain item
//    only this app can read. Rolling the file back (to bring a revoked grant back), or deleting
//    records, makes the hash disagree, and the store fails closed. A write is two-phase, so a
//    crash between writing the file and moving the anchor recovers instead of locking up.

import { z } from 'zod'
import {
  type ApprovalKind,
  type ApprovalRequest,
  type DecisionCheck,
  type DecisionContext,
  parseRequestText,
  verifyDecision,
} from './approvals'
import { sha256Hex } from './hash'
import { signedTextSchema } from './signing'

export const evidenceSchema = z
  .object({
    /** The request exactly as the Mac serialised it. */
    requestText: z
      .string()
      .min(2)
      .max(64 * 1024),
    decision: signedTextSchema,
  })
  .strict()
export type Evidence = z.infer<typeof evidenceSchema>

export type EvidenceCheck =
  | DecisionCheck
  | { readonly ok: false; readonly reason: 'wrong-kind' | 'subject-mismatch' }

/**
 * Checks a stored record's evidence: the decision is valid for its request (stored mode), the
 * request is of the expected kind, and its subject is the record's. `matches` compares the
 * record's own fields to the subject; a record is honoured only if this returns ok.
 */
export function verifyEvidence<K extends ApprovalKind>(
  evidence: Evidence,
  kind: K,
  matches: (request: Extract<ApprovalRequest, { kind: K }>) => boolean,
  context: Omit<DecisionContext, 'mode' | 'isPending'>,
): EvidenceCheck {
  const request = parseRequestText(evidence.requestText)
  if (request === null) return { ok: false, reason: 'malformed' }
  if (request.request.kind !== kind) return { ok: false, reason: 'wrong-kind' }
  const check = verifyDecision(evidence.decision, request, { ...context, mode: 'stored' })
  if (!check.ok) return check
  if (!matches(request.request as Extract<ApprovalRequest, { kind: K }>))
    return { ok: false, reason: 'subject-mismatch' }
  return check
}

/** The Keychain-held state for one store. */
export const anchorStateSchema = z
  .object({
    generation: z.number().int().min(0),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    /** Set between the two phases of a write: the hash of the file about to be written. */
    next: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
  })
  .strict()
export type AnchorState = z.infer<typeof anchorStateSchema>

/** Where anchors live: the Keychain, under the app's designated requirement. Fakes in tests. */
export interface StoreAnchor {
  read(store: string): Promise<AnchorState | null>
  write(store: string, state: AnchorState): Promise<void>
}

/**
 * - ok: the file is the one the anchor names.
 * - advance: the file is the one a write was about to commit; call commitWrite and carry on.
 * - fresh: no file and no anchor, a first run.
 * - mismatch: anything else. Treat the store as empty (fail closed), tell the person, and audit.
 */
export type AnchorCheck = 'ok' | 'advance' | 'fresh' | 'mismatch'

/** The anchor hash of a store that has never been written. */
export const EMPTY_STORE_SHA256 = sha256Hex('')

export function checkAnchor(file: Uint8Array | string | null, state: AnchorState | null): AnchorCheck {
  // No file is a fresh store only if no write ever committed: a crash during the first write.
  if (file === null)
    return state === null || (state.generation === 0 && state.sha256 === EMPTY_STORE_SHA256)
      ? 'fresh'
      : 'mismatch'
  if (state === null) return 'mismatch'
  const digest = sha256Hex(file)
  if (digest === state.sha256) return 'ok'
  if (state.next !== null && digest === state.next) return 'advance'
  return 'mismatch'
}

/** Phase one: record the hash of the file about to be written, before writing it. */
export function beginWrite(state: AnchorState | null, nextFile: Uint8Array | string): AnchorState {
  const next = sha256Hex(nextFile)
  return { ...(state ?? { generation: 0, sha256: EMPTY_STORE_SHA256 }), next }
}

/** Phase two, after the file is written and synced: the new file becomes the current one. */
export function commitWrite(state: AnchorState): AnchorState {
  if (state.next === null) return state
  return { generation: state.generation + 1, sha256: state.next, next: null }
}
